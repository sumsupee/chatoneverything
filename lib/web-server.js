const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const { EventEmitter } = require('events');
const os = require('os');

class WebServer extends EventEmitter {
    constructor(config, settings, loggers) {
        super();
        this.config = config; // { port, rootPath }
        this.currentSettings = settings;
        this.loggers = loggers; // { writeChatLog, writeFeedbackLog, initFeedbackLoggingForCycle }

        this.port = config.port || 8765;
        this.wsPort = this.port;
        this.httpPort = this.port + 1;

        this.wss = null;
        this.httpServer = null;
        this.wsTunnelUrl = null; // Cloudflare WebSocket tunnel URL
        this.httpTunnelUrl = null; // Cloudflare HTTP tunnel URL

        // Session State
        this.sessionCode = this.generateSessionCode();
        this.adminPassword = this.generateAdminPassword();
        this.adminClients = new Set();
        this.blockedIps = new Set();
        this.deletionsByIp = new Map();
        this.feedbackSubmittedIps = new Set();
        this.feedbackCycleId = 0;

        // Message State
        this.messageIdCounter = 0;
        this.messageIndex = new Map();
        this.chatHistory = [];
        this.MAX_CHAT_HISTORY = 50;

        // Modules (injected via setters)
        this.ceeAgent = null;
        this.remoteControl = null;

        // Rate limiting state
        this.lastMessageTimeByIp = new Map();
    }

    setModules(ceeAgent, remoteControl) {
        this.ceeAgent = ceeAgent;
        this.remoteControl = remoteControl;
    }

    setTunnelUrls(wsUrl, httpUrl) {
        this.wsTunnelUrl = wsUrl;
        this.httpTunnelUrl = httpUrl;
    }

    start() {
        this.createHttpServer();
        this.createWebSocketServer();
    }

    stop() {
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
        if (this.httpServer) {
            this.httpServer.close();
            this.httpServer = null;
        }
    }

    // --- HTTP Server ---

    createHttpServer() {
        this.httpServer = http.createServer((req, res) => {
            const parsedUrl = new URL(req.url, `http://localhost:${this.httpPort}`);
            const pathname = parsedUrl.pathname;
            const providedCode = parsedUrl.searchParams.get('s');

            // Feedback endpoint
            if (pathname === '/feedback') {
                this.handleFeedbackRequest(req, res);
                return;
            }

            // Mobile App
            if (pathname === '/' || pathname === '/index.html') {
                if (!providedCode) {
                    this.serveHtml(res, this.generateJoinPageHtml());
                    return;
                }
                if (providedCode.toUpperCase() !== this.sessionCode) {
                    this.serveHtml(res, this.generateSessionNotFoundHtml(), 403);
                    return;
                }
                this.serveAppFile(req, res, path.join(this.config.rootPath, 'mobile', 'index.html'));
                return;
            }

            // Admin Page
            if (pathname === '/admin' || pathname === '/admin.html') {
                if (!providedCode) {
                    this.serveHtml(res, this.generateJoinPageHtml());
                    return;
                }
                if (providedCode.toUpperCase() !== this.sessionCode) {
                    this.serveHtml(res, this.generateSessionNotFoundHtml(), 403);
                    return;
                }
                this.serveAppFile(req, res, path.join(this.config.rootPath, 'mobile', 'admin.html'));
                return;
            }

            // Static Assets (CSS/JS)
            if (pathname.startsWith('/css/') || pathname.startsWith('/js/')) {
                const dir = pathname.startsWith('/css/') ? 'css' : 'js';
                const safePath = path.join(this.config.rootPath, dir);
                const filePath = path.join(this.config.rootPath, dir, path.basename(pathname));

                // Security check
                if (!filePath.startsWith(safePath)) {
                    res.writeHead(403);
                    res.end('Forbidden');
                    return;
                }

                const contentType = dir === 'css' ? 'text/css' : 'application/javascript';
                this.serveStatic(res, filePath, contentType);
                return;
            }

            res.writeHead(404);
            res.end('Not found');
        });

        this.httpServer.listen(this.httpPort, () => {
            console.log(`Mobile app available at http://localhost:${this.httpPort}`);
        });
    }

    handleFeedbackRequest(req, res) {
        if (req.method !== 'POST') return this.jsonResponse(res, 405, { ok: false, error: 'method_not_allowed' });
        if (!this.currentSettings.enableFeedbackForm) return this.jsonResponse(res, 403, { ok: false, error: 'feedback_disabled' });

        const ip = this.getClientIpFromReq(req);
        if (!ip) return this.jsonResponse(res, 400, { ok: false, error: 'ip_unknown' });
        if (this.feedbackSubmittedIps.has(ip)) return this.jsonResponse(res, 409, { ok: false, error: 'already_submitted' });

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 20000) {
                this.jsonResponse(res, 413, { ok: false, error: 'payload_too_large' });
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const rating = parseInt(payload.rating, 10);
                if (!Number.isFinite(rating) || rating < 1 || rating > 5) return this.jsonResponse(res, 400, { ok: false, error: 'invalid_rating' });

                const comment = this.truncateToMaxWords(payload.comment || '', 150);

                if (this.loggers.initFeedbackLoggingForCycle) {
                    this.feedbackCycleId = this.currentSettings.feedbackCycleId || this.feedbackCycleId || 0;
                    // We could emit event to request logging init, but assuming existing log stream is fine or main.js sets it up
                }

                this.feedbackSubmittedIps.add(ip);
                this.loggers.writeFeedbackLog({
                    type: 'feedback',
                    sessionCode: this.sessionCode,
                    feedbackCycleId: this.feedbackCycleId,
                    at: new Date().toISOString(),
                    ip, rating, comment
                });

                this.jsonResponse(res, 200, { ok: true });
            } catch (e) {
                this.jsonResponse(res, 400, { ok: false, error: 'invalid_json' });
            }
        });
    }

    serveAppFile(req, res, filePath) {
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            // HTML injection for WebSocket URL
            const isCloudflare = req.headers['cf-connecting-ip'] ||
                (req.headers.host && req.headers.host.includes('trycloudflare.com'));
            const localIP = this.getLocalIP();
            let wsUrlHost = null;
            let forceLocal = false;

            if (isCloudflare && this.wsTunnelUrl) {
                wsUrlHost = this.wsTunnelUrl.replace(/^wss?:\/\//, '').replace(/\/$/, '');
            } else {
                wsUrlHost = `${localIP}:${this.wsPort}`;
                forceLocal = true;
            }

            let html = data;
            if (wsUrlHost) {
                const injectMeta = `<meta name="default-ws-url" content="${wsUrlHost}">`;
                const injectScript = `<script>
                        (function() {
                            const defaultWsUrl = '${wsUrlHost}';
                            const isLocalRequest = ${forceLocal ? 'true' : 'false'};
                            if (defaultWsUrl) {
                                if (isLocalRequest) {
                                    localStorage.setItem('livechat_server', defaultWsUrl);
                                    window.__defaultWsUrl = defaultWsUrl;
                                } else {
                                    const existing = localStorage.getItem('livechat_server') || '';
                                    const shouldUpdate = !existing || 
                                        existing.includes('10.') || 
                                        existing.includes('192.168.') || 
                                        existing.includes('172.') || 
                                        existing === window.location.hostname + ':${this.wsPort}' ||
                                        existing.includes('localhost');
                                    if (shouldUpdate) {
                                        localStorage.setItem('livechat_server', defaultWsUrl);
                                        window.__defaultWsUrl = defaultWsUrl;
                                    }
                                }
                            }
                        })();
                    </script>`;
                html = html.replace('<head>', '<head>' + injectMeta + injectScript);
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        });
    }

    serveStatic(res, filePath, contentType) {
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(404);
                res.end('Not found');
            } else {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content);
            }
        });
    }

    serveHtml(res, html, code = 200) {
        res.writeHead(code, { 'Content-Type': 'text/html' });
        res.end(html);
    }

    jsonResponse(res, code, data) {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    // --- WebSocket Server ---

    createWebSocketServer() {
        this.wss = new WebSocket.Server({ port: this.wsPort });
        this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    }

    handleConnection(ws, req) {
        const clientIp = this.getClientIpFromReq(req);
        ws.isAdmin = false;
        ws.clientIp = clientIp;
        ws.sessionValidated = false;

        const validationTimeout = setTimeout(() => {
            if (!ws.sessionValidated && ws.readyState === WebSocket.OPEN) ws.close(1008, 'Timeout');
        }, 10000);

        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());

                if (msg.type === 'join') {
                    if ((msg.sessionCode || '').toUpperCase().trim() === this.sessionCode) {
                        ws.sessionValidated = true;
                        ws.send(JSON.stringify({ type: 'join-result', success: true, code: this.sessionCode }));
                        this.sendSettingsToClient(ws);
                        clearTimeout(validationTimeout);
                    } else {
                        ws.send(JSON.stringify({ type: 'join-result', success: false, error: 'invalid_session' }));
                        ws.close(1008);
                    }
                    return;
                }

                if (msg.type === 'admin-auth') {
                    if (msg.password === this.adminPassword) {
                        ws.isAdmin = true;
                        ws.sessionValidated = true;
                        this.adminClients.add(ws);
                        clearTimeout(validationTimeout);
                        ws.send(JSON.stringify({
                            type: 'admin-auth-result', success: true,
                            settings: this.currentSettings, blockedIps: Array.from(this.blockedIps)
                        }));
                        // Emit to main.js for mode/remote status sync
                        this.emit('admin-connected', ws);
                    } else {
                        ws.send(JSON.stringify({ type: 'admin-auth-result', success: false }));
                        ws.close(1008);
                    }
                    return;
                }

                if (!ws.sessionValidated) return;

                if (msg.type === 'message') {
                    await this.handleUserMessage(ws, msg);
                } else if (ws.isAdmin) {
                    this.handleAdminMessage(ws, msg);
                }

            } catch (e) {
                console.error(e);
            }
        });

        ws.on('close', () => {
            this.adminClients.delete(ws);
            clearTimeout(validationTimeout);
        });
    }

    async handleUserMessage(ws, msg) {
        if (!msg.user || !msg.text) return;
        if (this.blockedIps.has(ws.clientIp)) {
            ws.send(JSON.stringify({ type: 'blocked' }));
            return;
        }

        // Slow mode
        if (this.currentSettings.slowModeEnabled && !ws.isAdmin) {
            const last = this.lastMessageTimeByIp.get(ws.clientIp) || 0;
            const now = Date.now();
            if (now - last < (this.currentSettings.slowModeSeconds * 1000)) {
                ws.send(JSON.stringify({ type: 'slow-mode', remainingSeconds: 1 }));
                return;
            }
            this.lastMessageTimeByIp.set(ws.clientIp, now);
        }

        msg.text = this.truncateToMaxWords(msg.text, 50);
        const msgId = ++this.messageIdCounter;
        const entry = { id: msgId, user: msg.user, text: msg.text, ip: ws.clientIp, timestamp: new Date().toISOString() };

        this.messageIndex.set(msgId, entry);
        this.chatHistory.push(entry);
        if (this.chatHistory.length > this.MAX_CHAT_HISTORY) this.chatHistory.shift();

        this.loggers.writeChatLog({ type: 'message', sessionCode: this.sessionCode, ...entry });

        this.broadcast({ type: 'message', ...entry });
        this.emit('new-message', entry);

        // CeeAgent processing
        if (msg.text.match(/@cee\s+/i) && this.ceeAgent && this.currentSettings.enableCeeAgent) {
            const question = msg.text.replace(/@cee\s+/i, '').trim();
            if (question) {
                try {
                    const response = await this.ceeAgent.processRequest(msg.user, question, this.chatHistory);
                    const ceeId = ++this.messageIdCounter;
                    const ceeEntry = { id: ceeId, user: 'Cee', text: response, ip: null, timestamp: new Date().toISOString() };
                    this.messageIndex.set(ceeId, ceeEntry);
                    this.chatHistory.push(ceeEntry);

                    this.broadcast({ type: 'message', ...ceeEntry });
                    this.emit('new-message', ceeEntry);
                    this.loggers.writeChatLog({ type: 'message', sessionCode: this.sessionCode, ...ceeEntry, ceeResponse: true });
                } catch (err) {
                    // Error handling for Cee
                    const errId = ++this.messageIdCounter;
                    const errEntry = { id: errId, user: 'Cee', text: 'Sorry, I encountered an error.', ip: null, timestamp: new Date().toISOString() };
                    this.messageIndex.set(errId, errEntry);
                    this.broadcast({ type: 'message', ...errEntry });
                    this.emit('new-message', errEntry);
                }
            }
        }
    }

    handleAdminMessage(ws, msg) {
        if (msg.type === 'admin-settings') {
            this.emit('settings-update', msg);
        } else if (msg.type.startsWith('remote-')) {
            if (this.remoteControl && this.currentSettings.remoteEnabled) {
                if (msg.type === 'remote-mouse-move') this.remoteControl.handleMouseMove(msg.deltaX, msg.deltaY);
                else if (msg.type === 'remote-mouse-click') this.remoteControl.handleClick(msg.button);
                else if (msg.type === 'remote-mouse-dblclick') this.remoteControl.handleDoubleClick(msg.button);
                else if (msg.type === 'remote-mouse-down') this.remoteControl.handleMouseDown(msg.button);
                else if (msg.type === 'remote-mouse-up') this.remoteControl.handleMouseUp(msg.button);
                else if (msg.type === 'remote-scroll') this.remoteControl.handleScroll(msg.deltaX, msg.deltaY);
                else if (msg.type === 'remote-keyboard-type') this.remoteControl.handleKeyboardType(msg.text);
                else if (msg.type === 'remote-keyboard-key') this.remoteControl.handleKeyboardKey(msg.key, msg.modifiers);
                else if (msg.type === 'remote-volume') this.remoteControl.handleVolume(msg.action);
                else if (msg.type === 'remote-media') this.remoteControl.handleMedia(msg.action);
                else if (msg.type === 'remote-vlc') this.remoteControl.handleVlc(msg.action, msg.value);
                else if (msg.type === 'remote-control-start') this.emit('remote-control-start');
                else if (msg.type === 'remote-control-end') this.emit('remote-control-end');
            }
        } else if (msg.type === 'admin-block-ip') {
            this.blockedIps.add(msg.ip);
            // Block logic is usually more complex (log, etc), but for now:
            ws.send(JSON.stringify({ type: 'admin-block-ip-result', success: true, ip: msg.ip }));
        } else if (msg.type === 'admin-unblock-ip') {
            this.blockedIps.delete(msg.ip);
            ws.send(JSON.stringify({ type: 'admin-unblock-ip-result', success: true, ip: msg.ip }));
        } else if (msg.type === 'admin-delete-msg') {
            const entry = this.messageIndex.get(msg.msgId);
            if (entry) {
                entry.deleted = true;
                this.broadcast({ type: 'message-deleted', msgId: msg.msgId });
                this.emit('delete-message', { id: msg.msgId });
                this.loggers.writeChatLog({ type: 'message-deleted', sessionCode: this.sessionCode, msgId: msg.msgId, deletedAt: new Date().toISOString() });
            }
        }
    }

    broadcast(msg) {
        if (!this.wss) return;
        const data = JSON.stringify(msg);
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(data);
        });
    }

    broadcastToAdmins(msg) {
        if (!this.wss) return;
        const data = JSON.stringify(msg);
        this.adminClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(data);
        });
    }

    getUrls() {
        const localIP = this.getLocalIP();
        const useCloudflare = this.config.useCloudflare && this.httpTunnelUrl && this.wsTunnelUrl;

        // If config.useCloudflare is not set (legacy), check config.hideIp compatibility if needed
        // But for now, rely on main.js effectively controlling this via tunnel URLs. 
        // Actually, main.js logic was: useCloudflare = currentSettings.hideIp && httpTunnel && wsTunnel;
        // Since WebServer has currentSettings, we can use that.

        const useTunnels = this.currentSettings.hideIp && this.httpTunnelUrl && this.wsTunnelUrl;

        return {
            mobileUrl: useTunnels ? `${this.httpTunnelUrl}?s=${this.sessionCode}` : `http://${localIP}:${this.httpPort}?s=${this.sessionCode}`,
            adminUrl: useTunnels ? `${this.httpTunnelUrl}/admin?s=${this.sessionCode}` : `http://${localIP}:${this.httpPort}/admin?s=${this.sessionCode}`,
            wsUrl: useTunnels ? this.wsTunnelUrl : `ws://${localIP}:${this.wsPort}`
        };
    }

    sendSettingsToClient(ws) {
        try {
            const urls = this.getUrls();
            ws.send(JSON.stringify({
                type: 'settings-sync',
                settings: { ...this.currentSettings, ceeApiKeySet: !!this.currentSettings.ceeApiKey },
                mobileUrl: urls.mobileUrl,
                wsUrl: urls.wsUrl
            }));
        } catch (e) { }
    }

    getClientIpFromReq(req) {
        const forwarded = req.headers['x-forwarded-for'];
        const ip = forwarded ? forwarded.split(',')[0] : req.connection.remoteAddress;
        return ip ? ip.replace('::ffff:', '') : ip;
    }

    getLocalIP() {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
        return '127.0.0.1';
    }

    truncateToMaxWords(str, max) {
        if (!str) return '';
        const normalized = str.toString().replace(/\s+/g, ' ').trim();
        if (!normalized) return '';
        const words = normalized.split(' ').filter(Boolean);
        if (words.length <= max) return normalized;
        return words.slice(0, max).join(' ');
    }

    generateSessionCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    generateAdminPassword() {
        const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
        let password = '';
        for (let i = 0; i < 8; i++) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return password;
    }

    generateJoinPageHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>Join Chat</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Outfit:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root { --bg: #000; --accent: #8a8a8a; --text: #e8e8e8; --text-dim: #9a9a9a; --border: rgba(255,255,255,0.18); }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); font-family: 'Outfit', sans-serif; color: var(--text); }
    .container { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100%; padding: 24px; text-align: center; }
    h1 { font: 600 24px 'JetBrains Mono', monospace; color: var(--accent); margin: 0 0 12px 0; }
    p { color: var(--text-dim); margin: 0 0 32px 0; font-size: 14px; }
    .form-group { width: 100%; max-width: 280px; margin-bottom: 20px; }
    label { display: block; font: 500 11px 'JetBrains Mono', monospace; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; text-align: left; }
    input { width: 100%; padding: 16px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 10px; color: var(--text); font: 600 20px 'JetBrains Mono', monospace; text-align: center; text-transform: uppercase; letter-spacing: 4px; outline: none; }
    input:focus { border-color: rgba(255,255,255,0.35); background: rgba(255,255,255,0.05); }
    input::placeholder { color: var(--text-dim); letter-spacing: 2px; font-size: 14px; }
    .btn { width: 100%; max-width: 280px; padding: 16px; border: 1px solid var(--border); border-radius: 10px; background: transparent; color: var(--text); font: 600 16px 'Outfit', sans-serif; cursor: pointer; }
    .btn:active { transform: scale(0.98); }
    .error { color: #b24b57; font-size: 13px; margin-top: 16px; display: none; }
    .error.visible { display: block; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Join Chat</h1>
    <p>Enter the session code to join</p>
    <div class="form-group">
      <label>Session Code</label>
      <input type="text" id="code-input" placeholder="ABC123" maxlength="6" autocomplete="off" autocapitalize="characters" autofocus>
    </div>
    <button class="btn" id="join-btn">Join Session</button>
    <div class="error" id="error-msg">Invalid session code</div>
  </div>
  <script>
    const input = document.getElementById('code-input');
    const btn = document.getElementById('join-btn');
    const error = document.getElementById('error-msg');
    input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); error.classList.remove('visible'); });
    function join() {
      const code = input.value.trim();
      if (code.length < 4) { error.textContent = 'Please enter a valid session code'; error.classList.add('visible'); return; }
      window.location.href = '/?s=' + encodeURIComponent(code);
    }
    btn.onclick = join;
    input.onkeypress = (e) => { if (e.key === 'Enter') join(); };
  </script>
</body>
</html>`;
    }

    generateSessionNotFoundHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<title>Session Not Found</title>
<style>
body { background: #000; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif; text-align: center; }
a { color: #fff; border: 1px solid #fff; padding: 10px 20px; text-decoration: none; }
</style>
</head>
<body>
<div>
<h1>Session Not Found</h1>
<p>Invalid code.</p>
<a href="/">Try Again</a>
</div>
</body>
</html>`;
    }
}

module.exports = WebServer;
