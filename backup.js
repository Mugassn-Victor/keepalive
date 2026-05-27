const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const DIR = path.join(__dirname, 'web');
fs.mkdirSync(DIR, { recursive: true });

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;

function loadConfig() {
    return fs.readFileSync(path.join(__dirname, 'web.txt'), 'utf8').split('\n').map(s => s.replace(/#.*/, '').trim()).filter(s => s).map(s => {
        const p = s.split('|');
        const name = p[0].replace(/\/$/, '');
        return { url: 'http://' + name, host: p[1], user: p[2], pass: p[3], remote: p[4], name };
    });
}

async function visit(page, url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 0 });
    await page.waitForTimeout(3000);
    if ((await page.content()).includes('slowAES')) {
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 0 });
        await page.waitForTimeout(2000);
    }
    const t = await page.evaluate(() => document.body.innerText.trim());
    if (t.includes('404')) throw Error('backup.php not found');
    return t;
}

function runCmd(tag, cmd, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stdout.on('data', d => {
            try { process.stdout.write(d.toString().split('\n').filter(l => l).map(l => `  [${tag}] ${l}`).join('\n') + '\n'); } catch {}
        });
        proc.stderr.on('data', d => {
            try { process.stdout.write(d.toString().split('\n').filter(l => l).map(l => `  [${tag}] ${l}`).join('\n') + '\n'); } catch {}
        });
        proc.stdout.on('error', () => {});
        proc.stderr.on('error', () => {});
        proc.on('close', code => code === 0 ? resolve() : reject(Error(`exit ${code}`)));
        proc.on('error', reject);
    });
}

async function ftpGet(s) {
    const d = path.join(DIR, s.name);
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    await runCmd(s.name, `lftp -c "set ftp:ssl-allow no; set ftp:passive-mode on; open -u ${s.user},${s.pass} ${s.host}; mirror --parallel=6 --no-perms --no-umask --verbose ${s.remote} ${d}; bye"`);
}

async function do7z(s) {
    const d = path.join(DIR, s.name);
    const a = path.join(DIR, `${s.name}.7z`);
    if (!fs.existsSync(d) || fs.readdirSync(d).length === 0) { fs.rmSync(d, { recursive: true, force: true }); return null; }
    await runCmd(s.name, `7z a -t7z -m0=lzma2 -mx=9 -mfb=273 -md=64m -ms=on "${a}" "${d}"/*`);
    if (!fs.existsSync(a) || fs.statSync(a).size <= 1000) { return null; }
    fs.rmSync(d, { recursive: true });
    return a;
}

function uploadAsset(file, tag) {
    if (!TOKEN || !REPO) return;
    const name = path.basename(file);
    const url = `https://uploads.github.com/repos/${REPO}/releases/${tag}/assets?name=${name}`;
    const size = fs.statSync(file).size;
    const req = https.request(url, { method: 'POST', headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/x-7z-compressed', 'Content-Length': size } }, res => {
        res.resume();
        if (res.statusCode >= 400) console.log(`  upload warn: HTTP ${res.statusCode} for ${name}`);
    });
    req.on('error', e => console.log(`  upload error: ${e.message}`));
    req.socket && req.socket.on('error', e => console.log(`  upload socket error: ${e.message}`));
    req.on('socket', sock => sock.on('error', e => console.log(`  upload socket error: ${e.message}`)));
    const stream = fs.createReadStream(file);
    stream.on('error', e => { console.log(`  upload read error: ${e.message}`); req.destroy(); });
    stream.pipe(req);
    stream.on('end', () => fs.unlinkSync(file));
}

function api(url, opts) {
    return new Promise((r, j) => {
        const req = https.request(url, { method: opts.method || 'GET', headers: { 'Authorization': `Bearer ${TOKEN}`, 'User-Agent': 'node', 'Content-Type': 'application/json', ...opts.headers } }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { r(JSON.parse(d)); } catch { r({}); } });
        });
        req.on('error', j);
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

async function ensureRelease(tag) {
    const info = await api(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {});
    if (info.id) return info.id;
    const created = await api(`https://api.github.com/repos/${REPO}/releases`, { method: 'POST', body: JSON.stringify({ tag_name: tag, name: tag }) });
    return created.id;
}

async function main() {
    const sites = loadConfig();
    console.log(`sites: ${sites.length}\n`);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    let ok = 0, done = 0, active = 0, maxMem = 0, maxConc = 8;
    const releaseId = await ensureRelease('backup');

    async function run(s) {
        active++;
        const mb = os.freemem();
        const p = await browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', viewport: { width: 1920, height: 1080 } });
        try {
            console.log(`[${s.name}] (active: ${active})`);
            process.stdout.write('  backup... '); console.log(await visit(p, `${s.url}/backup.php`));
            process.stdout.write('  ftp...\n'); await ftpGet(s); console.log(`  [${s.name}] ftp done`);
            process.stdout.write('  cleanup... '); console.log(await visit(p, `${s.url}/backup.php?d`));
            process.stdout.write('  compress...\n'); const a = await do7z(s);
            if (a) {
                const size = (fs.statSync(a).size / 1048576).toFixed(2);
                console.log(`  [${s.name}] ${size} MB`);
                process.stdout.write('  upload... '); uploadAsset(a, releaseId); console.log('ok');
            } else { console.log('  no files'); }
            ok++;
        } catch (e) { console.log(`  [${s.name}] fail: ${e.message}`); }
        finally { await p.close(); active--; update(mb); }
        done++;
        console.log(`progress: ${done}/${sites.length} (ok: ${ok})\n`);
    }

    function update(mb) {
        const mem = (mb - os.freemem()) / 1073741824;
        if (mem > maxMem) {
            maxMem = mem;
            maxConc = Math.max(1, Math.floor(os.freemem() / 1073741824 / maxMem * 0.7));
            console.log(`  profile: ${maxMem.toFixed(2)}GB/site, max concurrent: ${maxConc}`);
        }
    }

    for (const s of sites) {
        while (active >= maxConc) await new Promise(r => setTimeout(r, 3000));
        run(s);
    }

    while (active) await new Promise(r => setTimeout(r, 1000));
    await browser.close();
    console.log(`done: ${ok}/${sites.length}`);
}

process.stdout.on('error', e => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', e => { if (e.code !== 'EPIPE') throw e; });

main().catch(e => { console.error(e.message); process.exit(1); });
