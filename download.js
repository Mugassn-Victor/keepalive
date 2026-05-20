const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DOMAINS_FILE = path.join(__dirname, 'domains.txt');
const DOWNLOAD_DIR = path.join(__dirname, 'website');
const PAGE_TIMEOUT = 0; // 压缩无限等待，不超时

// 确保下载目录存在
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function loadDomains() {
    return fs.readFileSync(DOMAINS_FILE, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .map(l => l.replace(/#.*$/, '').trim())
        .filter(l => l)
        .map(l => /^https?:\/\//i.test(l) ? l : `http://${l}`)
        .map(l => l.replace(/\/$/, ''));
}

function getDomainName(url) {
    const match = url.match(/^https?:\/\/([^\/]+)/i);
    return match ? match[1] : 'unknown';
}

async function triggerBackupAndWait(page, baseUrl) {
    const backupUrl = `${baseUrl}/backup.php?c`;
    
    await page.goto(backupUrl, { waitUntil: 'networkidle', timeout: 0 });
    await page.waitForTimeout(3000);
    
    // 检查是否有 JS 验证
    const content = await page.content();
    if (content.includes('slowAES') || content.includes('aes.js')) {
        console.log(`  JS验证页面，等待跳转...`);
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 0 });
        await page.waitForTimeout(2000);
    }
    
    // 获取返回内容
    const bodyText = await page.evaluate(() => {
        const body = document.body;
        return body ? body.innerText.trim() : '';
    });
    
    // 检查是否是 404 页面内容
    if (bodyText.includes('404') || bodyText.includes('Not Found')) {
        throw new Error('backup.php 不存在');
    }
    
    if (bodyText === 'success') {
        return true;
    } else {
        const preview = bodyText.length > 100 ? bodyText.substring(0, 100) + '...' : bodyText;
        throw new Error(preview || 'backup failed');
    }
}

async function downloadFile(page, zipUrl, destPath) {
    // 直接 HTTP 下载，不需要 cookie
    return new Promise((resolve, reject) => {
        const protocol = zipUrl.startsWith('https') ? https : http;
        const file = fs.createWriteStream(destPath);
        
        protocol.get(zipUrl, (response) => {
            // 处理重定向
            if (response.statusCode === 302 || response.statusCode === 301) {
                file.close();
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                const redirectUrl = response.headers.location;
                return downloadFile(page, redirectUrl, destPath).then(resolve).catch(reject);
            }
            
            if (response.statusCode !== 200) {
                file.close();
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                return reject(new Error(`HTTP ${response.statusCode}`));
            }
            
            // 流式写入文件
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                resolve();
            });
            
            file.on('error', (err) => {
                file.close();
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                reject(err);
            });
        }).on('error', (err) => {
            file.close();
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            reject(err);
        });
    });
}

async function deleteBackup(page, baseUrl) {
    const deleteUrl = `${baseUrl}/backup.php?d`;
    await page.goto(deleteUrl, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT });
    const bodyText = await page.evaluate(() => document.body.innerText.trim());
    return bodyText === 'success';
}

async function downloadSite(browser, baseUrl) {
    const domain = getDomainName(baseUrl);
    const zipUrl = `${baseUrl}/${domain}.zip`;
    const destPath = path.join(DOWNLOAD_DIR, `${domain}.zip`);
    
    const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
    });
    
    try {
        console.log(`[${domain}]`);
        
        // 检查是否存在旧文件
        if (fs.existsSync(destPath)) {
            console.log(`  覆盖旧文件`);
        }
        
        // 先触发压缩
        console.log(`  压缩中...`);
        await triggerBackupAndWait(page, baseUrl);
        console.log(`  压缩完成`);
        
        // 压缩成功后再下载
        console.log(`  下载中...`);
        await downloadFile(page, zipUrl, destPath);
        
        const stats = fs.statSync(destPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        
        // 检查文件大小，如果太小可能下载失败
        if (stats.size < 1024) {
            // 读取文件内容看看是什么
            const content = fs.readFileSync(destPath, 'utf8').substring(0, 200);
            fs.unlinkSync(destPath);
            throw new Error(`文件太小 (${stats.size} bytes)，内容: ${content}`);
        }
        
        console.log(`  下载完成: ${sizeMB} MB`);
        
        // 下载完成后删除服务器上的压缩包
        if (await deleteBackup(page, baseUrl)) {
            console.log(`  已清理服务器文件`);
        }
        
        return true;
    } catch (err) {
        console.log(`  失败: ${err.message}`);
        return false;
    } finally {
        await page.close();
    }
}

async function main() {
    const domains = loadDomains();
    console.log(`共 ${domains.length} 个站点\n`);
    
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    
    let success = 0;
    for (const url of domains) {
        if (await downloadSite(browser, url)) {
            success++;
        }
    }
    
    await browser.close();
    
    console.log(`\n完成: ${success}/${domains.length} 成功`);
}

main().catch(err => {
    console.error('运行失败:', err);
    process.exit(1);
});
