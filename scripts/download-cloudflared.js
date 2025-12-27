#!/usr/bin/env node
/**
 * Script to download cloudflared binaries for all platforms
 * This script downloads the latest cloudflared release from GitHub
 * 
 * Usage:
 *   node scripts/download-cloudflared.js [version]
 * 
 * Examples:
 *   node scripts/download-cloudflared.js           # Download latest
 *   node scripts/download-cloudflared.js 2024.1.0 # Download specific version
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const GITHUB_REPO = 'cloudflare/cloudflared';
const VERSION = process.argv[2] || 'latest';

// Ensure bin directory exists
if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
}

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;

        const options = {
            headers: {
                'User-Agent': 'node.js', // Github API requires User-Agent
            }
        };

        if (process.env.GH_TOKEN) {
            options.headers['Authorization'] = `token ${process.env.GH_TOKEN}`;
        }

        protocol.get(url, options, (res) => {
            if (res.statusCode === 302 || res.statusCode === 301) {
                // Follow redirect
                return httpsGet(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

async function getLatestVersion() {
    try {
        const data = await httpsGet(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
        const json = JSON.parse(data.toString());
        return json.tag_name;
    } catch (error) {
        console.error('Failed to get latest version:', error.message);
        process.exit(1);
    }
}

async function downloadBinary(platform, arch, extension, outputName, isArchive = false) {
    const version = VERSION === 'latest' ? await getLatestVersion() : VERSION;
    const url = `https://github.com/${GITHUB_REPO}/releases/download/${version}/cloudflared-${platform}-${arch}${extension}`;
    const outputPath = path.join(BIN_DIR, outputName);

    console.log(`Downloading ${platform}-${arch}...`);
    console.log(`  URL: ${url}`);
    console.log(`  Output: ${outputPath}`);

    try {
        const data = await httpsGet(url);

        if (isArchive) {
            // For macOS .tgz files, extract the archive
            const tempArchive = path.join(BIN_DIR, `temp-${platform}-${arch}${extension}`);
            fs.writeFileSync(tempArchive, data);

            // Extract using tar command (available on macOS/Linux)
            const tempExtractDir = path.join(BIN_DIR, `temp-extract-${platform}-${arch}`);
            fs.mkdirSync(tempExtractDir, { recursive: true });

            try {
                execSync(`tar -xzf "${tempArchive}" -C "${tempExtractDir}"`, { stdio: 'ignore' });

                // The extracted file is named "cloudflared"
                const extractedBinary = path.join(tempExtractDir, 'cloudflared');
                if (fs.existsSync(extractedBinary)) {
                    fs.copyFileSync(extractedBinary, outputPath);
                    fs.chmodSync(outputPath, 0o755);
                } else {
                    throw new Error('Binary not found in archive');
                }

                // Cleanup
                fs.unlinkSync(tempArchive);
                fs.rmSync(tempExtractDir, { recursive: true, force: true });
            } catch (extractError) {
                // Cleanup on error
                if (fs.existsSync(tempArchive)) fs.unlinkSync(tempArchive);
                if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true });
                throw extractError;
            }
        } else {
            // Direct binary download
            fs.writeFileSync(outputPath, data);

            // Make executable on Unix-like systems
            if (process.platform !== 'win32') {
                fs.chmodSync(outputPath, 0o755);
            }
        }

        console.log(`  ✓ Successfully downloaded ${outputName}`);
        return true;
    } catch (error) {
        console.error(`  ✗ Failed to download ${platform}-${arch}:`, error.message);
        return false;
    }
}

async function main() {
    console.log('Downloading cloudflared binaries...');
    console.log(`Version: ${VERSION === 'latest' ? 'latest (will fetch)' : VERSION}`);
    console.log('');

    const downloads = [
        ['linux', 'amd64', '', 'cloudflared', false],
        ['windows', 'amd64', '.exe', 'cloudflared.exe', false],
        ['darwin', 'amd64', '.tgz', 'cloudflared-mac-amd64', true],  // macOS uses .tgz archives
        ['darwin', 'arm64', '.tgz', 'cloudflared-mac-arm64', true],  // macOS uses .tgz archives
    ];

    const results = await Promise.all(
        downloads.map(([platform, arch, ext, output, isArchive]) =>
            downloadBinary(platform, arch, ext, output, isArchive)
        )
    );

    const successCount = results.filter(r => r).length;
    console.log('');
    console.log(`Download complete! (${successCount}/${downloads.length} successful)`);
    console.log('');
    console.log('Note: For macOS, the app will automatically detect the correct architecture.');
    console.log('You can also create a symlink or copy the appropriate binary:');
    console.log('  - For Intel Macs: cp bin/cloudflared-mac-amd64 bin/cloudflared');
    console.log('  - For Apple Silicon: cp bin/cloudflared-mac-arm64 bin/cloudflared');
}

main().catch((error) => {
    console.error('Error:', error);
    process.exit(1);
});

