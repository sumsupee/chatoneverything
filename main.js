const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const localtunnel = require('localtunnel');

let mainWindow;
let isPassive = false; // Start in active mode
let wss = null;
let httpServer = null;
let httpTunnel = null;
let wsTunnel = null;
const WS_PORT = 8765;

// Generate random session code
function generateSessionCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Generate random admin password (8 chars, alphanumeric)
function generateAdminPassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < 8; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

let sessionCode = generateSessionCode();
let adminPassword = generateAdminPassword();

// --- Chat logging (per-session) ---
let chatLogStream = null;
let chatLogFilePath = null;
let chatLogDir = null;
const messageIndex = new Map(); // msgId -> { id, user, text, ip, timestamp }

// --- Feedback logging (per "collection cycle") ---
let feedbackLogStream = null;
let feedbackLogFilePath = null;
let feedbackCycleId = 0;
let feedbackSubmittedIps = new Set(); // per-cycle

// --- IP blocking (per-session) ---
const blockedIps = new Set(); // ip -> blocked
const deletionsByIp = new Map(); // ip -> deleteCount (messages deleted by admin)

function safeMkdir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        return true;
    } catch (_) {
        return false;
    }
}

function isWritableDir(dir) {
    try {
        const testPath = path.join(dir, `.write-test-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
        fs.writeFileSync(testPath, 'ok');
        fs.unlinkSync(testPath);
        return true;
    } catch (_) {
        return false;
    }
}

function pickLogDir() {
    // Prefer the folder where the app is run from (dev), otherwise fall back to userData (packaged-safe).
    const candidates = [];
    try { candidates.push(path.join(process.cwd(), 'chat-logs')); } catch (_) {}
    try { candidates.push(path.join(__dirname, 'chat-logs')); } catch (_) {}
    try { candidates.push(path.join(app.getPath('userData'), 'chat-logs')); } catch (_) {}

    for (const dir of candidates) {
        if (!dir) continue;
        if (!safeMkdir(dir)) continue;
        if (!isWritableDir(dir)) continue;
        return dir;
    }
    // Last resort: userData even if not writable test (avoid crashing).
    try { return path.join(app.getPath('userData'), 'chat-logs'); } catch (_) { return path.join(process.cwd(), 'chat-logs'); }
}

function initChatLogging() {
    chatLogDir = pickLogDir();
    safeMkdir(chatLogDir);
    const startedAt = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `chat-session-${sessionCode}-${startedAt}.jsonl`;
    chatLogFilePath = path.join(chatLogDir, filename);
    chatLogStream = fs.createWriteStream(chatLogFilePath, { flags: 'a' });

    writeChatLog({
        type: 'session-start',
        sessionCode,
        startedAt: new Date().toISOString()
    });

    console.log(`Chat logging enabled: ${chatLogFilePath}`);
}

function writeChatLog(obj) {
    try {
        if (!chatLogStream) return;
        chatLogStream.write(`${JSON.stringify(obj)}\n`);
    } catch (e) {
        console.error('Failed to write chat log:', e);
    }
}

function closeChatLogging() {
    try {
        if (chatLogStream) {
            writeChatLog({
                type: 'session-end',
                sessionCode,
                endedAt: new Date().toISOString()
            });
            chatLogStream.end();
        }
    } catch (_) {
        // ignore
    } finally {
        chatLogStream = null;
    }
}

function normalizeIp(ip) {
    if (!ip) return null;
    return String(ip).replace(/^::ffff:/, '');
}

function getClientIpFromReq(req) {
    // Prefer forwarded header when behind localtunnel / reverse proxy
    const xf = req?.headers?.['x-forwarded-for'];
    if (xf && typeof xf === 'string') {
        const first = xf.split(',')[0].trim();
        const n = normalizeIp(first);
        if (n) return n;
    }
    const raw = req?.socket?.remoteAddress || null;
    return normalizeIp(raw);
}

function initFeedbackLoggingForCycle() {
    // Reuse chat log directory selection so we always write somewhere writable.
    if (!chatLogDir) chatLogDir = pickLogDir();
    safeMkdir(chatLogDir);
    const startedAt = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `feedback-session-${sessionCode}-cycle-${feedbackCycleId}-${startedAt}.jsonl`;
    feedbackLogFilePath = path.join(chatLogDir, filename);
    feedbackLogStream = fs.createWriteStream(feedbackLogFilePath, { flags: 'a' });
    writeFeedbackLog({
        type: 'feedback-cycle-start',
        sessionCode,
        feedbackCycleId,
        startedAt: new Date().toISOString()
    });
    console.log(`Feedback logging enabled: ${feedbackLogFilePath}`);
}

function writeFeedbackLog(obj) {
    try {
        if (!feedbackLogStream) return;
        feedbackLogStream.write(`${JSON.stringify(obj)}\n`);
    } catch (e) {
        console.error('Failed to write feedback log:', e);
    }
}

function closeFeedbackLogging() {
    try {
        if (feedbackLogStream) {
            writeFeedbackLog({
                type: 'feedback-cycle-end',
                sessionCode,
                feedbackCycleId,
                endedAt: new Date().toISOString()
            });
            feedbackLogStream.end();
        }
    } catch (_) {
        // ignore
    } finally {
        feedbackLogStream = null;
    }
}

function startNewFeedbackCycle(meta = {}) {
    // Increment cycle and reset per-cycle submission tracking.
    feedbackCycleId = (feedbackCycleId || 0) + 1;
    feedbackSubmittedIps = new Set();
    closeFeedbackLogging();
    initFeedbackLoggingForCycle();
    writeFeedbackLog({
        type: 'feedback-cycle-reset',
        sessionCode,
        feedbackCycleId,
        at: new Date().toISOString(),
        ...meta
    });
}

function setFeedbackEnabled(enabled, meta = {}) {
    const next = !!enabled;
    const prev = !!currentSettings.enableFeedbackForm;
    if (prev === next) return;

    currentSettings.enableFeedbackForm = next;
    if (next) {
        // Turning ON starts a fresh collection cycle.
        startNewFeedbackCycle({
            reason: 'enabled',
            ...meta
        });
        currentSettings.feedbackCycleId = feedbackCycleId;
    }
}

function broadcastBlockedIps() {
    broadcastToAdmins({
        type: 'blocked-ips-update',
        blockedIps: Array.from(blockedIps)
    });
}

function blockIp(ip, meta = {}) {
    const normalized = normalizeIp(ip);
    if (!normalized) return false;
    if (blockedIps.has(normalized)) return false;
    blockedIps.add(normalized);
    writeChatLog({
        type: 'ip-blocked',
        sessionCode,
        ip: normalized,
        at: new Date().toISOString(),
        ...meta
    });
    broadcastBlockedIps();
    return true;
}

function unblockIp(ip, meta = {}) {
    const normalized = normalizeIp(ip);
    if (!normalized) return false;
    if (!blockedIps.has(normalized)) return false;
    blockedIps.delete(normalized);
    deletionsByIp.delete(normalized); // reset counter on manual unblock
    writeChatLog({
        type: 'ip-unblocked',
        sessionCode,
        ip: normalized,
        at: new Date().toISOString(),
        ...meta
    });
    broadcastBlockedIps();
    return true;
}

// Current overlay settings (synced with admin)
let currentSettings = {
    maxMessages: 5,
    fontSize: 13,
    showJoinCode: false,
    showMobileLink: false,
    disableChatHistory: true,
    // Emoji shortcut shown on mobile + admin pages
    customEmoji: '⭐',
    // Feedback form control (synced to all mobile clients)
    enableFeedbackForm: false,
    // Incremented each time feedback is enabled to create a new "event"
    feedbackCycleId: 0
};

// Track admin clients
const adminClients = new Set();

// Linux: Required for transparency
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('disable-gpu');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 450,
        height: 420,
        x: 50,
        y: 300,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        resizable: false,
        focusable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // Start in active mode (interactive)
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.setFocusable(true);
    mainWindow.loadFile('index.html');
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    
    // Open settings on first load
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('mode-change', 'active');
        mainWindow.webContents.send('open-settings');
        mainWindow.focus();
    });
}

function toggleMode() {
    isPassive = !isPassive;
    
    mainWindow.setIgnoreMouseEvents(isPassive, { forward: isPassive });
    mainWindow.setFocusable(!isPassive);
    
    if (!isPassive) mainWindow.focus();
    
    mainWindow.webContents.send('mode-change', isPassive ? 'passive' : 'active');
    console.log(`Mode: ${isPassive ? 'Passive' : 'Active'}`);
}

// Create HTTP server to serve mobile app
function createHttpServer() {
    httpServer = http.createServer((req, res) => {
        // Feedback submission endpoint (same origin as mobile page)
        if (req.url === '/feedback') {
            if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
                return;
            }

            // If feedback is disabled, reject (clients should hide the form anyway)
            if (!currentSettings.enableFeedbackForm) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'feedback_disabled' }));
                return;
            }

            const ip = getClientIpFromReq(req);
            if (!ip) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'ip_unknown' }));
                return;
            }

            // Enforce "one per IP per cycle"
            if (feedbackSubmittedIps.has(ip)) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'already_submitted' }));
                return;
            }

            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString('utf8');
                // prevent abuse
                if (body.length > 20_000) {
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'payload_too_large' }));
                    try { req.destroy(); } catch (_) {}
                }
            });
            req.on('end', () => {
                let payload = null;
                try {
                    payload = JSON.parse(body || '{}');
                } catch (_) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
                    return;
                }

                const rating = parseInt(payload.rating, 10);
                if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'invalid_rating' }));
                    return;
                }

                const comment = truncateToMaxWords(payload.comment || '', 150);

                // Ensure a log stream exists for this cycle
                if (!feedbackLogStream) {
                    // Should not happen if enabled, but keep it safe.
                    feedbackCycleId = currentSettings.feedbackCycleId || feedbackCycleId || 0;
                    initFeedbackLoggingForCycle();
                }

                feedbackSubmittedIps.add(ip);
                writeFeedbackLog({
                    type: 'feedback',
                    sessionCode,
                    feedbackCycleId: currentSettings.feedbackCycleId || feedbackCycleId,
                    at: new Date().toISOString(),
                    ip,
                    rating,
                    comment
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            });
            return;
        }

        // Serve mobile app
        if (req.url === '/' || req.url === '/index.html') {
            const mobilePath = path.join(__dirname, 'mobile', 'index.html');
            fs.readFile(mobilePath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end('Mobile app not found');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            });
        } else if (req.url === '/admin' || req.url === '/admin.html') {
            const adminPath = path.join(__dirname, 'mobile', 'admin.html');
            fs.readFile(adminPath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end('Admin page not found');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            });
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });

    httpServer.listen(WS_PORT + 1, () => {
        console.log(`Mobile app available at http://localhost:${WS_PORT + 1}`);
    });
}

// Broadcast to all admin clients
function broadcastToAdmins(data) {
    adminClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Message ID counter
let messageIdCounter = 0;

// Per-message limit across all clients
const MAX_WORDS_PER_MESSAGE = 50;

function normalizeWhitespace(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

function truncateToMaxWords(text, maxWords) {
    const normalized = normalizeWhitespace(text);
    if (!normalized) return '';
    const words = normalized.split(' ').filter(Boolean);
    if (words.length <= maxWords) return normalized;
    return words.slice(0, maxWords).join(' ');
}

// Create WebSocket server
function createWebSocketServer() {
    wss = new WebSocket.Server({ port: WS_PORT });
    
    wss.on('connection', (ws, req) => {
        const clientIpRaw = req?.socket?.remoteAddress || null;
        const clientIp = normalizeIp(clientIpRaw);
        console.log('Client connected', clientIp ? `(${clientIp})` : '');
        ws.isAdmin = false;
        ws.clientIp = clientIp;
        
        // Send session code to newly connected client
        ws.send(JSON.stringify({ type: 'session', code: sessionCode }));
        // Send latest settings immediately (so emoji shortcuts / chat history mode are correct on first load)
        try {
            const localIP = getLocalIP();
            ws.send(JSON.stringify({
                type: 'settings-sync',
                settings: currentSettings,
                mobileUrl: `http://${localIP}:${WS_PORT + 1}`
            }));
        } catch (e) {
            // Non-fatal; client will still receive future syncs.
        }
        
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                
                // Regular message
                if (msg.type === 'message' && msg.user && msg.text) {
                    // Blocked IPs cannot send messages
                    if (ws.clientIp && blockedIps.has(ws.clientIp)) {
                        const now = new Date().toISOString();
                        writeChatLog({
                            type: 'message-rejected',
                            sessionCode,
                            timestamp: now,
                            reason: 'ip-blocked',
                            ip: ws.clientIp,
                            user: msg.user,
                            text: msg.text
                        });
                        try {
                            ws.send(JSON.stringify({ type: 'blocked', reason: 'ip-blocked' }));
                        } catch (_) {}
                        return;
                    }

                    // Enforce per-message max words across all users/clients
                    const limitedText = truncateToMaxWords(msg.text, MAX_WORDS_PER_MESSAGE);
                    if (!limitedText) return;
                    msg.text = limitedText;

                    const msgId = ++messageIdCounter;
                    const now = new Date().toISOString();
                    const entry = {
                        id: msgId,
                        user: msg.user,
                        text: msg.text,
                        ip: ws.clientIp || null,
                        timestamp: now
                    };
                    messageIndex.set(msgId, entry);
                    writeChatLog({
                        type: 'message',
                        sessionCode,
                        ...entry
                    });
                    
                    // Forward message to overlay with ID
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('new-message', { id: msgId, user: msg.user, text: msg.text });
                    }
                    
                    // Broadcast to all connected clients (for multi-user support)
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            try {
                                client.send(JSON.stringify({ type: 'message', id: msgId, user: msg.user, text: msg.text }));
                            } catch (err) {
                                console.error('Error sending message to client:', err);
                            }
                        }
                    });
                }
                
                // Admin authentication
                else if (msg.type === 'admin-auth') {
                    const success = msg.password === adminPassword;
                    if (success) {
                        ws.isAdmin = true;
                        adminClients.add(ws);
                        console.log('Admin authenticated');
                    }
                    ws.send(JSON.stringify({ 
                        type: 'admin-auth-result', 
                        success,
                        settings: success ? currentSettings : null,
                        blockedIps: success ? Array.from(blockedIps) : null
                    }));
                }
                
                // Admin: delete message
                else if (msg.type === 'admin-delete-msg' && ws.isAdmin) {
                    const now = new Date().toISOString();
                    const original = messageIndex.get(msg.msgId);
                    writeChatLog({
                        type: 'message-deleted',
                        sessionCode,
                        msgId: msg.msgId,
                        deletedAt: now,
                        deletedByIp: ws.clientIp || null,
                        // If we have the original message, include it and mark deleted.
                        original: original ? { ...original, deleted: true, deletedAt: now } : null
                    });
                    if (original) messageIndex.set(msg.msgId, { ...original, deleted: true, deletedAt: now });

                    // Auto-block: if the sender's IP has had 2 messages deleted this session
                    const senderIp = original?.ip ? normalizeIp(original.ip) : null;
                    if (senderIp) {
                        const next = (deletionsByIp.get(senderIp) || 0) + 1;
                        deletionsByIp.set(senderIp, next);
                        if (next >= 2) {
                            blockIp(senderIp, {
                                reason: 'auto-two-deletions',
                                triggeredByMsgId: msg.msgId,
                                triggeredByAdminIp: ws.clientIp || null
                            });
                        }
                    }

                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('delete-message', { id: msg.msgId });
                    }
                    // Notify ALL connected clients (not just admins)
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            try {
                                client.send(JSON.stringify({ type: 'message-deleted', msgId: msg.msgId }));
                            } catch (err) {
                                console.error('Error sending delete notification:', err);
                            }
                        }
                    });
                }
                
                // Admin: update settings
                else if (msg.type === 'admin-settings' && ws.isAdmin) {
                    // Update tracked settings
                    if (msg.maxMessages !== undefined) currentSettings.maxMessages = msg.maxMessages;
                    if (msg.fontSize !== undefined) currentSettings.fontSize = msg.fontSize;
                    if (msg.showJoinCode !== undefined) currentSettings.showJoinCode = msg.showJoinCode;
                    if (msg.showMobileLink !== undefined) currentSettings.showMobileLink = msg.showMobileLink;
                    if (msg.disableChatHistory !== undefined) currentSettings.disableChatHistory = msg.disableChatHistory;
                    if (msg.customEmoji !== undefined) {
                        const next = String(msg.customEmoji || '').trim().slice(0, 8);
                        currentSettings.customEmoji = next || '⭐';
                    }
                    if (msg.enableFeedbackForm !== undefined) {
                        setFeedbackEnabled(!!msg.enableFeedbackForm, {
                            triggeredByAdminIp: ws.clientIp || null,
                            via: 'mobile-admin'
                        });
                    }
                    
                    // Send to overlay
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('settings-update', currentSettings);
                    }
                    
                    // Broadcast settings to ALL clients (for mobile link display)
                    const localIP = getLocalIP();
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            try {
                                client.send(JSON.stringify({ 
                                    type: 'settings-sync', 
                                    settings: currentSettings,
                                    mobileUrl: `http://${localIP}:${WS_PORT + 1}`
                                }));
                            } catch (err) {
                                console.error('Error sending settings to client:', err);
                            }
                        }
                    });
                    console.log('Settings updated:', currentSettings);
                }

                // Admin: manually block IP
                else if (msg.type === 'admin-block-ip' && ws.isAdmin) {
                    const ok = blockIp(msg.ip, {
                        reason: msg.reason || 'manual',
                        triggeredByAdminIp: ws.clientIp || null
                    });
                    ws.send(JSON.stringify({ type: 'admin-block-ip-result', success: ok, ip: normalizeIp(msg.ip) }));
                }

                // Admin: manually unblock IP
                else if (msg.type === 'admin-unblock-ip' && ws.isAdmin) {
                    const ok = unblockIp(msg.ip, {
                        reason: msg.reason || 'manual',
                        triggeredByAdminIp: ws.clientIp || null
                    });
                    ws.send(JSON.stringify({ type: 'admin-unblock-ip-result', success: ok, ip: normalizeIp(msg.ip) }));
                }
            } catch (e) {
                console.error('Invalid message:', e);
            }
        });
        
        ws.on('close', () => {
            adminClients.delete(ws);
            console.log('Client disconnected');
        });
        
        ws.on('error', (err) => {
            console.error('WebSocket error:', err);
            adminClients.delete(ws);
        });
    });
    
    console.log(`WebSocket server running on port ${WS_PORT}`);
}

// Get local IP addresses
function getLocalIP() {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return 'localhost';
}

// Create secure tunnels for internet access
async function createTunnels() {
    try {
        // Create tunnel for HTTP server (mobile/admin pages)
        httpTunnel = await localtunnel({ port: WS_PORT + 1 });
        console.log(`Secure Mobile URL: ${httpTunnel.url}`);
        
        httpTunnel.on('close', () => {
            console.log('HTTP tunnel closed');
            httpTunnel = null;
        });
        
        httpTunnel.on('error', (err) => {
            console.error('HTTP tunnel error:', err);
        });
        
        // Create tunnel for WebSocket server
        wsTunnel = await localtunnel({ port: WS_PORT });
        console.log(`Secure WebSocket: ${wsTunnel.url.replace('https://', 'wss://')}`);
        
        wsTunnel.on('close', () => {
            console.log('WebSocket tunnel closed');
            wsTunnel = null;
        });
        
        wsTunnel.on('error', (err) => {
            console.error('WebSocket tunnel error:', err);
        });
        
    } catch (err) {
        console.error('Failed to create tunnels:', err.message);
        console.log('Falling back to local network only');
    }
}

app.whenReady().then(async () => {
    // Register hotkeys before window creation (important for Linux)
    globalShortcut.register('CommandOrControl+Shift+O', toggleMode);
    globalShortcut.register('F9', toggleMode);

    // Start per-session chat logging
    initChatLogging();

    setTimeout(createWindow, 300);
    
    // Start servers
    createWebSocketServer();
    createHttpServer();
    
    // Create secure tunnels for internet access
    await createTunnels();
    
    const localIP = getLocalIP();
    console.log('Overlay started. Press Ctrl+Shift+O or F9 to toggle mode.');
    console.log(`Session Code: ${sessionCode}`);
    console.log(`Admin Password: ${adminPassword}`);
    console.log('--- Local Network URLs ---');
    console.log(`Mobile app: http://${localIP}:${WS_PORT + 1}`);
    console.log(`Admin page: http://${localIP}:${WS_PORT + 1}/admin`);
    console.log(`WebSocket: ws://${localIP}:${WS_PORT}`);
    if (httpTunnel && wsTunnel) {
        console.log('--- Secure Internet URLs ---');
        console.log(`Mobile app: ${httpTunnel.url}`);
        console.log(`Admin page: ${httpTunnel.url}/admin`);
        console.log(`WebSocket: ${wsTunnel.url.replace('https://', 'wss://')}`);
    }
});

// IPC handlers
ipcMain.on('close-app', () => app.quit());
ipcMain.on('enter-passive', () => {
    if (!isPassive) toggleMode();
});

ipcMain.handle('get-session-info', () => {
    const localIP = getLocalIP();
    const info = {
        code: sessionCode,
        adminPassword: adminPassword,
        wsUrl: `ws://${localIP}:${WS_PORT}`,
        mobileUrl: `http://${localIP}:${WS_PORT + 1}`,
        adminUrl: `http://${localIP}:${WS_PORT + 1}/admin`
    };
    
    // Add secure tunnel URLs if available
    if (httpTunnel && wsTunnel) {
        info.secureMobileUrl = httpTunnel.url;
        info.secureAdminUrl = `${httpTunnel.url}/admin`;
        info.secureWsUrl = wsTunnel.url.replace('https://', 'wss://');
    }
    
    return info;
});

// Handle settings changes from overlay UI
ipcMain.on('settings-changed', (_, settings) => {
    if (settings.maxMessages !== undefined) currentSettings.maxMessages = settings.maxMessages;
    if (settings.fontSize !== undefined) currentSettings.fontSize = settings.fontSize;
    if (settings.showJoinCode !== undefined) currentSettings.showJoinCode = settings.showJoinCode;
    if (settings.showMobileLink !== undefined) currentSettings.showMobileLink = settings.showMobileLink;
    if (settings.disableChatHistory !== undefined) currentSettings.disableChatHistory = settings.disableChatHistory;
    if (settings.customEmoji !== undefined) {
        const next = String(settings.customEmoji || '').trim().slice(0, 8);
        currentSettings.customEmoji = next || '⭐';
    }
    if (settings.enableFeedbackForm !== undefined) {
        setFeedbackEnabled(!!settings.enableFeedbackForm, {
            via: 'overlay-settings'
        });
    }
    
    // Broadcast settings to ALL clients
    const localIP = getLocalIP();
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify({ 
                    type: 'settings-sync', 
                    settings: currentSettings,
                    mobileUrl: `http://${localIP}:${WS_PORT + 1}`
                }));
            } catch (err) {
                console.error('Error sending settings to client:', err);
            }
        }
    });
});

ipcMain.on('window-move', (_, { deltaX, deltaY }) => {
    const [x, y] = mainWindow.getPosition();
    mainWindow.setPosition(x + deltaX, y + deltaY);
});

ipcMain.on('window-resize', (_, { width, height, x, y }) => {
    const bounds = mainWindow.getBounds();
    mainWindow.setBounds({
        x: x !== undefined ? x : bounds.x,
        y: y !== undefined ? y : bounds.y,
        width: Math.max(200, width),
        height: Math.max(150, height)
    });
});

ipcMain.handle('get-window-bounds', () => mainWindow.getBounds());

// Cleanup function to properly close all servers and connections
function cleanup() {
    console.log('Cleaning up...');
    
    // Unregister shortcuts
    globalShortcut.unregisterAll();
    
    // Close all WebSocket connections first
    if (wss) {
        wss.clients.forEach(client => {
            try {
                client.terminate();
            } catch (e) {}
        });
        wss.close(() => {
            console.log('WebSocket server closed');
        });
        wss = null;
    }
    
    // Close HTTP server
    if (httpServer) {
        httpServer.close(() => {
            console.log('HTTP server closed');
        });
        httpServer = null;
    }
    
    // Close tunnels
    if (httpTunnel) {
        httpTunnel.close();
        httpTunnel = null;
    }
    if (wsTunnel) {
        wsTunnel.close();
        wsTunnel = null;
    }
    
    // Clear admin clients
    adminClients.clear();

    // Close chat log stream
    closeChatLogging();

    // Close feedback log stream
    closeFeedbackLogging();
}

// Handle all quit scenarios
app.on('before-quit', cleanup);
app.on('will-quit', cleanup);
app.on('window-all-closed', () => {
    cleanup();
    app.quit();
});

// Handle unexpected exits
process.on('exit', cleanup);
process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
});
process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    cleanup();
    process.exit(1);
});
