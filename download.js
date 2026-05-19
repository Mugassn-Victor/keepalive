const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DOMAINS_FILE = path.join(__dirname, 'domains.txt');
const DOWNLOAD_DIR = path.join(__dirname, 'website');

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

function triggerBackup(baseUrl) {
    return new Promise((resolve, reject) => {
        const backupUrl = `${baseUrl}/backup.php?c`;
        const protocol = baseUrl.startsWith('https') ? https : http;
        
        protocol.get(backupUrl, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                if (data.trim() === 'success') {
                    resolve();
                } else {
                    reject(new Error(data.trim() || 'backup failed'));
                }
            });
        }).on('error', reject);
    });
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(dest);
        
        protocol.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                file.close();
                fs.unlinkSync(dest);
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }
            
            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(dest);
                return reject(new Error(`HTTP ${response.statusCode}`));
            }
            
            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloadedSize = 0;
            
            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (totalSize) {
                    const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
                    process.stdout.write(`\r  下载中: ${percent}%`);
                }
            });
            
            response.pipe(file);
            
            file.on('finish', () => {
                file.close();
                process.stdout.write('\r');
                resolve();
            });
        }).on('error', (err) => {
            file.close();
            fs.unlinkSync(dest);
            reject(err);
        });
    });
}

async function downloadSite(baseUrl) {
    const domain = getDomainName(baseUrl);
    const zipUrl = `${baseUrl}/${domain}.zip`;
    const destPath = path.join(DOWNLOAD_DIR, `${domain}.zip`);
    
    try {
        console.log(`[${domain}]`);
        
        // 检查是否存在旧文件
        if (fs.existsSync(destPath)) {
            console.log(`  覆盖旧文件`);
        }
        
        // 先触发压缩
        console.log(`  压缩中...`);
        await triggerBackup(baseUrl);
        console.log(`  压缩完成`);
        
        // 压缩成功后再下载
        console.log(`  下载中...`);
        await downloadFile(zipUrl, destPath);
        
        const stats = fs.statSync(destPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`  下载完成: ${sizeMB} MB`);
        
        // 下载完成后删除服务器上的压缩包
        const deleteUrl = `${baseUrl}/backup.php?d`;
        const protocol = baseUrl.startsWith('https') ? https : http;
        
        protocol.get(deleteUrl, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                if (data.trim() === 'success') {
                    console.log(`  已清理服务器文件`);
                }
            });
        }).on('error', () => {});
        
        return true;
    } catch (err) {
        console.log(`  失败: ${err.message}`);
        return false;
    }
}

async function main() {
    const domains = loadDomains();
    console.log(`共 ${domains.length} 个站点\n`);
    
    let success = 0;
    for (const url of domains) {
        if (await downloadSite(url)) {
            success++;
        }
    }
    
    console.log(`\n完成: ${success}/${domains.length} 成功`);
}

main().catch(err => {
    console.error('运行失败:', err);
    process.exit(1);
});
