const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function has(cmd) { try { execSync(`which ${cmd}`, { stdio: 'pipe' }); return true; } catch { return false; } }
function run(cmd) { execSync(cmd, { stdio: 'inherit' }); }

if (!has('lftp')) { console.log('installing lftp...'); run('apt-get update -qq && apt-get install -y lftp'); }
if (!has('7z')) { console.log('installing p7zip...'); run('apt-get update -qq && apt-get install -y p7zip-full'); }

const pwDir = path.join(__dirname, 'node_modules', 'playwright');
if (!fs.existsSync(pwDir)) { console.log('installing playwright...'); run(`npm install --prefix ${__dirname} playwright`); }
try { execSync(`npx --prefix ${__dirname} playwright install chromium 2>&1 | grep -q "already installed"`, { stdio: 'pipe' }); }
catch { console.log('installing chromium...'); run(`npx --prefix ${__dirname} playwright install chromium`); }

const { chromium } = require('playwright');
const os = require('os');

const CFG = path.join(__dirname, 'web.txt');
const DIR = path.join(__dirname, 'web');
fs.mkdirSync(DIR, { recursive: true });

function loadConfig() {
    return fs.readFileSync(CFG, 'utf8').split('\n').map(s => s.replace(/#.*$/, '').trim()).filter(s => s).map(s => {
        const p = s.split('|');
        const name = p[0].replace(/\/$/, '');
        const url = 'http://' + name;
        return { url, host: p[1], user: p[2], pass: p[3], remote: p[4], name };
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

function execTag(tag, cmd) {
    const out = execSync(cmd, { stdio: 'pipe' });
    process.stdout.write(out.toString().split('\n').filter(l => l).map(l => `  [${tag}] ${l}`).join('\n') + '\n');
}

function ftpGet(s) {
    const d = path.join(DIR, s.name);
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    execTag(s.name, `lftp -c "set ftp:ssl-allow no; set ftp:passive-mode on; open -u ${s.user},${s.pass} ${s.host}; mirror --parallel=6 --no-perms --no-umask --verbose ${s.remote} ${d}; bye" 2>&1`);
}

function zip7z(s) {
    const d = path.join(DIR, s.name);
    const a = path.join(DIR, `${s.name}.7z`);
    if (!fs.existsSync(d) || fs.readdirSync(d).length === 0) {
        fs.rmSync(d, { recursive: true, force: true });
        return null;
    }
    execTag(s.name, `7z a -t7z -m0=lzma2 -mx=9 -mfb=273 -md=64m -ms=on "${a}" "${d}"/* 2>&1`);
    if (fs.statSync(a).size > 1000) { fs.rmSync(d, { recursive: true }); return a; }
    return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const sites = loadConfig();
    console.log(`sites: ${sites.length}\n`);

    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    let ok = 0, done = 0, active = 0, maxMem = 0, maxConcurrent = 999;

    async function run(s) {
        active++;
        const memBefore = os.freemem();
        const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', viewport: { width: 1920, height: 1080 } });
        try {
            console.log(`[${s.name}] (active: ${active})`);
            process.stdout.write('  backup... '); console.log(await visit(page, `${s.url}/backup.php`));
            process.stdout.write('  ftp... '); ftpGet(s); console.log('done');
            process.stdout.write('  cleanup... '); console.log(await visit(page, `${s.url}/backup.php?d`));
            process.stdout.write('  compress... '); const a = zip7z(s);
            console.log(a ? `${(fs.statSync(a).size / 1048576).toFixed(2)} MB` : 'no files');
            ok++;
        } catch (e) { console.log(`  fail: ${e.message}`); }
        finally {
            await page.close();
            const memUsed = (memBefore - os.freemem()) / 1073741824;
            if (memUsed > maxMem) {
                maxMem = memUsed;
                const avail = os.freemem() / 1073741824;
                maxConcurrent = Math.max(1, Math.floor(avail / maxMem * 0.7));
                console.log(`  profile: ${maxMem.toFixed(2)}GB/site, max concurrent: ${maxConcurrent}`);
            }
            active--;
        }
        done++;
        console.log(`progress: ${done}/${sites.length} (ok: ${ok})\n`);
    }

    for (const s of sites) {
        while (active >= maxConcurrent) await sleep(3000);
        run(s);
    }

    while (active > 0) await sleep(1000);
    await browser.close();
    console.log(`done: ${ok}/${sites.length}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
