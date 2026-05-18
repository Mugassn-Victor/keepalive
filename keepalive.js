const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DOMAINS_FILE = path.join(__dirname, 'domains.txt');
const PAGE_TIMEOUT = 30000;
const MAX_RETRIES = 3;

function loadDomains() {
    return fs.readFileSync(DOMAINS_FILE, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .map(l => l.replace(/#.*$/, '').trim()) // 去掉行内注释
        .filter(l => l)
        .map(l => /^https?:\/\//i.test(l) ? l : `http://${l}`);
}

async function visitSite(browser, url) {
    const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
    });

    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT });
        await page.waitForTimeout(3000);

        const content = await page.content();
        if (content.includes('slowAES') || content.includes('aes.js')) {
            console.log(`  🛡️ JS验证页面，等待跳转...`);
            await page.waitForNavigation({ waitUntil: 'networkidle', timeout: PAGE_TIMEOUT });
            await page.waitForTimeout(2000);
        }

        const title = await page.title().catch(() => '(无标题)');
        console.log(`  ✅ ${url} — ${title}`);
        return true;
    } catch (err) {
        console.log(`  ❌ ${url} — ${err.message}`);
        return false;
    } finally {
        await page.close();
    }
}

async function main() {
    const domains = loadDomains();
    console.log(`📋 共 ${domains.length} 个站点`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    let success = 0;
    for (const url of domains) {
        let ok = false;
        for (let i = 1; i <= MAX_RETRIES && !ok; i++) {
            if (i > 1) await new Promise(r => setTimeout(r, 5000));
            ok = await visitSite(browser, url);
        }
        if (ok) success++;
    }

    await browser.close();
    console.log(`\n🎯 完成: ${success}/${domains.length} 成功`);

    // 有失败则以非零退出码退出，方便 Actions 标记失败
    if (success < domains.length) process.exit(1);
}

main().catch(err => {
    console.error('❌ 运行失败:', err);
    process.exit(1);
});
