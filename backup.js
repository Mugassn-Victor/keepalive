const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(__dirname, 'web');
fs.mkdirSync(DIR, { recursive: true });

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

function runCmd(tag, cmd) {
    const out = execSync(cmd, { stdio: 'pipe' });
    process.stdout.write(out.toString().split('\n').filter(l => l).map(l => `  [${tag}] ${l}`).join('\n') + '\n');
}

function ftpGet(s) {
    const d = path.join(DIR, s.name);
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    runCmd(s.name, `lftp -c "set ftp:ssl-allow no; set ftp:passive-mode on; open -u ${s.user},${s.pass} ${s.host}; mirror --parallel=6 --no-perms --no-umask --verbose ${s.remote} ${d}; bye" 2>&1`);
}

function do7z(s) {
    const d = path.join(DIR, s.name);
    const a = path.join(DIR, `${s.name}.7z`);
    if (!fs.existsSync(d) || fs.readdirSync(d).length === 0) { fs.rmSync(d, { recursive: true, force: true }); return null; }
    runCmd(s.name, `7z a -t7z -m0=lzma2 -mx=9 -mfb=273 -md=64m -ms=on "${a}" "${d}"/* 2>&1`);
    if (fs.statSync(a).size > 1000) { fs.rmSync(d, { recursive: true }); return a; }
    return null;
}

async function main() {
    const sites = loadConfig();
    console.log(`sites: ${sites.length}\n`);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    let ok = 0, done = 0, active = 0, maxMem = 0, maxConc = 5;

    async function run(s) {
        active++;
        const mb = os.freemem();
        const p = await browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', viewport: { width: 1920, height: 1080 } });
        try {
            console.log(`[${s.name}] (active: ${active})`);
            process.stdout.write('  backup... '); console.log(await visit(p, `${s.url}/backup.php`));
            process.stdout.write('  ftp... '); ftpGet(s); console.log('done');
            process.stdout.write('  cleanup... '); console.log(await visit(p, `${s.url}/backup.php?d`));
            process.stdout.write('  compress... '); const a = do7z(s);
            console.log(a ? `${(fs.statSync(a).size / 1048576).toFixed(2)} MB` : 'no files');
            ok++;
        } catch (e) { console.log(`  fail: ${e.message}`); }
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

main().catch(e => { console.error(e.message); process.exit(1); });
