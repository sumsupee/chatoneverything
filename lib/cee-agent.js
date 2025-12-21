const { nativeImage, desktopCapturer } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { GoogleGenAI } = require('@google/genai'); // Using new SDK

class CeeAgent {
    constructor(settings, mainWindow) {
        this.settings = settings;
        this.mainWindow = mainWindow;
        this.apiKey = settings.ceeApiKey || '';
        this.provider = settings.ceeApiProvider || 'openai';
        this.systemPrompt = settings.ceeSystemPrompt || '';
        this.pendingScreenshotResolve = null;
    }

    updateSettings(newSettings) {
        if (newSettings.ceeApiKey !== undefined) this.apiKey = newSettings.ceeApiKey;
        if (newSettings.ceeApiProvider !== undefined) this.provider = newSettings.ceeApiProvider;
        if (newSettings.ceeSystemPrompt !== undefined) this.systemPrompt = newSettings.ceeSystemPrompt;

        // Merge into local settings object
        this.settings = { ...this.settings, ...newSettings };
    }

    setMainWindow(window) {
        this.mainWindow = window;
    }

    resolvePendingScreenshot(base64) {
        if (this.pendingScreenshotResolve) {
            this.pendingScreenshotResolve(base64);
            this.pendingScreenshotResolve = null;
        }
    }

    async processRequest(askedBy, question, chatHistory) {
        console.log(`[Cee] === Processing @Cee request ===`);
        console.log(`[Cee] Asked by: ${askedBy}`);
        console.log(`[Cee] Question: ${question}`);

        try {
            // Capture screenshot
            console.log('[Cee] Capturing screenshot...');
            const screenshot = await this._captureScreenshot();
            console.log('[Cee] Screenshot captured:', screenshot ? `${screenshot.length} chars base64` : 'FAILED');

            // Call appropriate API
            console.log('[Cee] Using provider:', this.provider);
            let response;
            if (this.provider === 'gemini') {
                response = await this._callGemini(question, screenshot, chatHistory);
            } else {
                response = await this._callOpenAI(question, screenshot, chatHistory);
            }

            console.log(`Cee responded: ${response}`);
            return response;

        } catch (err) {
            console.error('Cee request failed:', err.message);
            throw err;
        }
    }

    // Capture screenshot via renderer process -> Linux native -> desktopCapturer
    async _captureScreenshot() {
        // 1. Try to get screenshot from renderer's persistent stream
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            try {
                const screenshot = await new Promise((resolve, reject) => {
                    this.pendingScreenshotResolve = resolve;
                    this.mainWindow.webContents.send('capture-screenshot');

                    // Timeout after 5 seconds
                    setTimeout(() => {
                        if (this.pendingScreenshotResolve === resolve) {
                            this.pendingScreenshotResolve = null;
                            reject(new Error('Screenshot capture timeout'));
                        }
                    }, 5000);
                });

                if (screenshot) {
                    console.log('[Cee] Screenshot captured via renderer');
                    return screenshot;
                }
            } catch (err) {
                console.log('[Cee] Renderer screenshot failed:', err.message);
            }
        }

        // 2. Fallback: On Linux, try native screenshot tools
        if (process.platform === 'linux') {
            try {
                const screenshot = await this._captureScreenshotLinux();
                if (screenshot) return screenshot;
            } catch (err) {
                console.log('[Cee] Linux native screenshot failed:', err.message);
            }
        }

        // 3. Last resort: use desktopCapturer directly
        try {
            console.log('[Cee] Falling back to desktopCapturer...');
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: 1920, height: 1080 }
            });

            if (sources.length === 0) {
                console.error('[Cee] No screen sources available');
                return null;
            }

            let image = sources[0].thumbnail;
            const size = image.getSize();
            if (size.width > 512) {
                const scale = 512 / size.width;
                image = image.resize({
                    width: Math.round(size.width * scale),
                    height: Math.round(size.height * scale),
                    quality: 'good'
                });
            }

            return image.toJPEG(80).toString('base64');
        } catch (err) {
            console.error('[Cee] desktopCapturer fallback failed:', err.message);
            return null;
        }
    }

    async _captureScreenshotLinux() {
        const tmpFile = path.join(os.tmpdir(), `cee-screenshot-${Date.now()}.png`);

        // Try different screenshot tools in order of preference
        const tools = [
            { cmd: 'gnome-screenshot', args: ['-f', tmpFile] },
            { cmd: 'scrot', args: [tmpFile] },
            { cmd: 'import', args: ['-window', 'root', tmpFile] }, // ImageMagick
            { cmd: 'maim', args: [tmpFile] }
        ];

        for (const tool of tools) {
            try {
                await new Promise((resolve, reject) => {
                    const proc = spawn(tool.cmd, tool.args, { stdio: 'ignore' });
                    proc.on('close', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error(`${tool.cmd} exited with code ${code}`));
                    });
                    proc.on('error', reject);
                    // Timeout after 5 seconds
                    setTimeout(() => {
                        try { proc.kill(); } catch (_) { }
                        reject(new Error('Screenshot timeout'));
                    }, 5000);
                });

                // Read and process the screenshot
                if (fs.existsSync(tmpFile)) {
                    const buffer = fs.readFileSync(tmpFile);
                    let image = nativeImage.createFromBuffer(buffer);

                    // Resize to max 512px width
                    const size = image.getSize();
                    if (size.width > 512) {
                        const scale = 512 / size.width;
                        image = image.resize({
                            width: Math.round(size.width * scale),
                            height: Math.round(size.height * scale),
                            quality: 'good'
                        });
                    }

                    // Clean up temp file
                    try { fs.unlinkSync(tmpFile); } catch (_) { }

                    // Convert to base64 JPEG
                    const base64 = image.toJPEG(80).toString('base64');
                    console.log(`[Cee] Screenshot captured using ${tool.cmd}`);
                    return base64;
                }
            } catch (err) {
                // Try next tool
                continue;
            }
        }

        throw new Error('No screenshot tool available');
    }

    async _callOpenAI(question, screenshotBase64, chatHistory) {
        console.log('[Cee] Calling OpenAI API...');
        console.log('[Cee] API key prefix:', this.apiKey?.substring(0, 7) || 'NOT SET');

        return new Promise((resolve, reject) => {
            // Build chat history context
            const recentHistory = chatHistory.slice(-20).map(m => `${m.user}: ${m.text}`).join('\n');

            // Build system prompt
            let systemPrompt = "You are Cee, a helpful AI assistant integrated into a chat application. You can see the user's screen.";
            if (this.systemPrompt) {
                systemPrompt += '\n\nAdditional instructions: ' + this.systemPrompt;
            }

            const messages = [
                { role: 'system', content: systemPrompt },
            ];

            if (recentHistory) {
                messages.push({
                    role: 'user',
                    content: `Here's the recent chat history for context:\n${recentHistory}`
                });
                messages.push({
                    role: 'assistant',
                    content: 'Got it, I have the chat context. What would you like to know?'
                });
            }

            const userContent = [];
            userContent.push({ type: 'text', text: question });

            if (screenshotBase64) {
                userContent.push({
                    type: 'image_url',
                    image_url: {
                        url: `data:image/jpeg;base64,${screenshotBase64}`,
                        detail: 'low'
                    }
                });
            }

            messages.push({ role: 'user', content: userContent });

            const requestBody = JSON.stringify({
                model: 'gpt-4o',
                messages: messages,
                max_tokens: 150,
                temperature: 0.7
            });

            const options = {
                hostname: 'api.openai.com',
                port: 443,
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Length': Buffer.byteLength(requestBody)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.error) {
                            reject(new Error(json.error.message || 'OpenAI API error'));
                            return;
                        }
                        const response = json.choices?.[0]?.message?.content?.trim();
                        if (response) {
                            resolve(response);
                        } else {
                            reject(new Error('No response from OpenAI'));
                        }
                    } catch (e) {
                        reject(new Error('Failed to parse OpenAI response'));
                    }
                });
            });

            req.on('error', (e) => reject(new Error(`OpenAI request failed: ${e.message}`)));
            req.setTimeout(30000, () => {
                req.destroy();
                reject(new Error('OpenAI request timed out'));
            });

            req.write(requestBody);
            req.end();
        });
    }

    async _callGemini(question, screenshotBase64, chatHistory) {
        console.log('[Cee] Calling Gemini API...');

        const recentHistory = chatHistory.slice(-20).map(m => `${m.user}: ${m.text}`).join('\n');

        let systemPrompt = "You are Cee, a helpful AI assistant integrated into a chat application. You can see the user's screen.";
        if (this.systemPrompt) {
            systemPrompt += '\n\nAdditional instructions: ' + this.systemPrompt;
        }

        let fullPrompt = systemPrompt + '\n\n';
        if (recentHistory) {
            fullPrompt += `Recent chat history for context:\n${recentHistory}\n\n`;
        }
        fullPrompt += `User question: ${question}`;

        try {
            const ai = new GoogleGenAI({ apiKey: this.apiKey });
            const contents = [];
            contents.push({ text: fullPrompt });

            if (screenshotBase64) {
                contents.push({
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: screenshotBase64
                    }
                });
            }

            const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
            const result = await model.generateContent({
                contents: [{ role: 'user', parts: contents }],
                generationConfig: {
                    maxOutputTokens: 500,
                    temperature: 0.7
                }
            });

            const responseText = result.response.text();
            if (responseText) {
                return responseText;
            } else {
                throw new Error('No response from Gemini');
            }
        } catch (error) {
            throw new Error(error.message || 'Gemini API error');
        }
    }
}

module.exports = CeeAgent;
