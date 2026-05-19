const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DOMAINS_FILE = path.join(__dirname, 'domains.txt');
const BACKUP_FILE = path.join(__dirname, 'backup.txt');
const PAGE_TIMEOUT = 30000;
const MAX_RETRIES = 3;

function loadDomains() {
    return fs.readFileSync(DOMAINS_FILE, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .map(l => l.replace(/#.*$/, '').trim()) // 去掉行内注释
        .filter(l => l)
        .map(l => /^https?:\/\//i.test(l) ? l : `http://${l}`)
        .map(l => l.replace(/\/$/, '') + '/bk.php'); // 添加 /bk.php 路径
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

        // 获取页面文本内容（bk.php 返回的链接）
        const bodyText = await page.evaluate(() => document.body.innerText.trim());
        
        const title = await page.title().catch(() => '(无标题)');
        console.log(`  ✅ ${url} — ${title}`);
        
        // 只返回有效的备份链接（必须以 http:// 或 https:// 开头，且不包含错误关键词）
        if (bodyText && 
            (bodyText.startsWith('http://') || bodyText.startsWith('https://')) &&
            !bodyText.includes('404') &&
            !bodyText.includes('Not Found') &&
            !bodyText.includes('blocked')) {
            return { success: true, url: bodyText };
        } else {
            if (bodyText && bodyText.startsWith('ERROR')) {
                console.log(`  ⚠️ 备份失败: ${bodyText}`);
            } else {
                console.log(`  ⚠️ 未配置 bk.php 或返回无效内容`);
            }
            return { success: false };
        }
    } catch (err) {
        console.log(`  ❌ ${url} — ${err.message}`);
        return { success: false };
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

    // 读取现有的备份记录
    let existingBackups = {};
    if (fs.existsSync(BACKUP_FILE)) {
        const lines = fs.readFileSync(BACKUP_FILE, 'utf8').split('\n').filter(l => l.trim());
        lines.forEach(line => {
            const match = line.match(/\| (https?:\/\/[^|]+) \|/);
            if (match) {
                existingBackups[match[1].trim()] = line;
            }
        });
    }

    let success = 0;
    
    for (const url of domains) {
        let result = null;
        for (let i = 1; i <= MAX_RETRIES && !result?.success; i++) {
            if (i > 1) await new Promise(r => setTimeout(r, 5000));
            result = await visitSite(browser, url);
        }
        if (result?.success) {
            success++;
            // 更新该网站的备份记录（覆盖旧的），只保存链接
            existingBackups[url] = result.url;
        }
    }

    await browser.close();
    
    // 保存备份链接到文件（覆盖写入）
    const content = Object.values(existingBackups).join('\n') + '\n';
    fs.writeFileSync(BACKUP_FILE, content);
    console.log(`\n💾 已更新 backup.txt，当前共 ${Object.keys(existingBackups).length} 条记录`);
    
    console.log(`\n🎯 完成: ${success}/${domains.length} 成功`);

    // 不再以非零退出码退出，确保后续步骤能执行
}

main().catch(err => {
    console.error('❌ 运行失败:', err);
    process.exit(1);
});
