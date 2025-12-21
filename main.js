const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Internal Modules
const WebServer = require('./lib/web-server');
const CeeAgent = require('./lib/cee-agent');
const RemoteControl = require('./lib/remote-control');

// --- Global State ---
let mainWindow;
let isPassive = false; // Start in active mode
let ceeApiKey = '';

// Tunnels
let httpTunnel = null;
let wsTunnel = null;
let wsTunnelProcess = null;
let httpTunnelProcess = null;

const WS_PORT = 8765;

// Settings (Mutable state shared with modules)
// Settings (Mutable state shared with modules)
const currentSettings = {
    maxMessages: 10,
    fontSize: 16,
    showJoinCode: false,
    showMobileLink: false,
    disableChatHistory: true, // Default to disabled for others per request
    hideIp: false,
    customEmoji: '⭐',
    emojiDirectSend: true,
    slowModeEnabled: false,
    slowModeSeconds: 3,

    enableFeedbackForm: false, // Default disabled per request
    feedbackCycleId: 0,
    enableCeeAgent: false, // Default disabled per request
    ceeApiProvider: 'openai',
    ceeSystemPrompt: '',
    remoteEnabled: false
};

// --- Logging Logic (Preserved from original) ---
let chatLogStream = null;
let chatLogDir = null;
let feedbackLogStream = null;

function safeMkdir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); return true; } catch (_) { return false; }
}

function pickLogDir() {
    const candidates = [];
    try { candidates.push(path.join(process.cwd(), 'chat-logs')); } catch (_) { }
    try { candidates.push(path.join(__dirname, 'chat-logs')); } catch (_) { }
    try { candidates.push(path.join(app.getPath('userData'), 'chat-logs')); } catch (_) { }
    for (const dir of candidates) {
        if (!dir) continue;
        if (safeMkdir(dir)) return dir;
    }
    return path.join(process.cwd(), 'chat-logs');
}

function writeChatLog(obj) {
    try { if (chatLogStream) chatLogStream.write(`${JSON.stringify(obj)}\n`); } catch (e) { console.error(e); }
}

function initChatLogging() {
    chatLogDir = pickLogDir();
    const filename = `chat-session-${webServer.sessionCode}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    chatLogStream = fs.createWriteStream(path.join(chatLogDir, filename), { flags: 'a' });
    writeChatLog({ type: 'session-start', sessionCode: webServer.sessionCode, startedAt: new Date().toISOString() });
    console.log(`Chat logging: ${filename}`);
}

function writeFeedbackLog(obj) {
    try { if (feedbackLogStream) feedbackLogStream.write(`${JSON.stringify(obj)}\n`); } catch (e) { console.error(e); }
}

function initFeedbackLoggingForCycle() {
    if (!chatLogDir) chatLogDir = pickLogDir();
    const filename = `feedback-session-${webServer.sessionCode}-cycle-${currentSettings.feedbackCycleId}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    feedbackLogStream = fs.createWriteStream(path.join(chatLogDir, filename), { flags: 'a' });
    writeFeedbackLog({ type: 'feedback-cycle-start', sessionCode: webServer.sessionCode, cycle: currentSettings.feedbackCycleId });
}

// --- Module Instantiation ---
const remoteControl = new RemoteControl();
const ceeAgent = new CeeAgent(currentSettings, null); // mainWindow set later
const webServer = new WebServer({ port: WS_PORT, rootPath: __dirname }, currentSettings, {
    writeChatLog,
    writeFeedbackLog,
    initFeedbackLoggingForCycle
});

webServer.setModules(ceeAgent, remoteControl);

// --- Window Management ---
// Linux transparency fixes
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('disable-gpu');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 450, height: 420, x: 50, y: 300,
        transparent: true, frame: false, alwaysOnTop: true,
        skipTaskbar: true, hasShadow: false, resizable: false, focusable: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.loadFile('index.html');
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setAlwaysOnTop(true, 'screen-saver');

    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('mode-change', 'active');
        mainWindow.webContents.send('open-settings');
        // Send initial settings
        mainWindow.webContents.send('settings-update', { ...currentSettings, ceeApiKeySet: !!ceeApiKey });
        mainWindow.focus();
    });

    // Provide window to CeeAgent for screenshot IPC
    ceeAgent.setMainWindow(mainWindow);
}

function toggleMode() {
    isPassive = !isPassive;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setIgnoreMouseEvents(isPassive, { forward: isPassive });
        mainWindow.setFocusable(!isPassive);
        if (!isPassive) mainWindow.focus();
        mainWindow.webContents.send('mode-change', isPassive ? 'passive' : 'active');
        webServer.broadcastToAdmins({ type: 'mode-state', mode: isPassive ? 'passive' : 'active' });
    }
}

// Remote Control state management (Window side)
let remoteControlActive = false;
let electronWasIgnoringMouseEvents = false;

function setRemoteControlMode(active) {
    remoteControlActive = active;
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (active) {
            electronWasIgnoringMouseEvents = isPassive;
            mainWindow.setIgnoreMouseEvents(true, { forward: true });
            mainWindow.setFocusable(false);
            mainWindow.blur();
        } else {
            mainWindow.setIgnoreMouseEvents(electronWasIgnoringMouseEvents, { forward: electronWasIgnoringMouseEvents });
            mainWindow.setFocusable(!electronWasIgnoringMouseEvents);
        }
    }
    webServer.broadcastToAdmins({ type: 'remote-control-state', active });
}

// --- Event Wiring ---

webServer.on('new-message', (entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('new-message', entry);
    }
});

webServer.on('delete-message', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('delete-message', data);
    }
});

webServer.on('admin-connected', (ws) => {
    // Sync current mode state
    try {
        ws.send(JSON.stringify({ type: 'mode-state', mode: isPassive ? 'passive' : 'active' }));
        ws.send(JSON.stringify({ type: 'remote-enabled-status', enabled: currentSettings.remoteEnabled }));
    } catch (_) { }
});

webServer.on('settings-update', (msg) => {
    // Apply updates to local settings
    if (msg.maxMessages !== undefined) currentSettings.maxMessages = msg.maxMessages;
    if (msg.fontSize !== undefined) currentSettings.fontSize = msg.fontSize;
    if (msg.showJoinCode !== undefined) currentSettings.showJoinCode = msg.showJoinCode;
    if (msg.showMobileLink !== undefined) currentSettings.showMobileLink = msg.showMobileLink;
    if (msg.disableChatHistory !== undefined) currentSettings.disableChatHistory = msg.disableChatHistory;
    if (msg.hideIp !== undefined) {
        currentSettings.hideIp = !!msg.hideIp;
        if (currentSettings.hideIp && (!httpTunnel || !wsTunnel)) {
            console.log('Hide IP enabled, attempting to create tunnels...');
            createTunnels();
        }
    }
    if (msg.customEmoji !== undefined) currentSettings.customEmoji = msg.customEmoji;
    if (msg.emojiDirectSend !== undefined) currentSettings.emojiDirectSend = !!msg.emojiDirectSend;
    if (msg.slowModeEnabled !== undefined) currentSettings.slowModeEnabled = !!msg.slowModeEnabled;
    if (msg.slowModeSeconds !== undefined) currentSettings.slowModeSeconds = parseInt(msg.slowModeSeconds);

    // Feedback
    if (msg.enableFeedbackForm !== undefined) {
        currentSettings.enableFeedbackForm = !!msg.enableFeedbackForm;
        if (currentSettings.enableFeedbackForm) {
            currentSettings.feedbackCycleId = (currentSettings.feedbackCycleId || 0) + 1;
            initFeedbackLoggingForCycle();
        }
    }

    // Agent Settings
    if (msg.enableCeeAgent !== undefined) currentSettings.enableCeeAgent = !!msg.enableCeeAgent;
    if (msg.ceeApiProvider !== undefined) currentSettings.ceeApiProvider = msg.ceeApiProvider;
    if (msg.ceeSystemPrompt !== undefined) currentSettings.ceeSystemPrompt = msg.ceeSystemPrompt;
    if (msg.ceeApiKey !== undefined) {
        ceeApiKey = msg.ceeApiKey;
        // Update Agent
        ceeAgent.updateSettings({ ceeApiKey, ...currentSettings });
    } else {
        // Update other agent settings
        ceeAgent.updateSettings(currentSettings);
    }

    // Sync to Overlay
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('settings-update', { ...currentSettings, ceeApiKeySet: !!ceeApiKey });
    }

    // Sync to other clients (WebServer handles admin broadcast, but we might need to sync session URLs if hideIp changed)
    const urls = webServer.getUrls(); // Note: WebServer's getUrls might need help if tunnel state changes
    webServer.broadcastToAdmins({
        type: 'settings-sync', settings: { ...currentSettings, ceeApiKeySet: !!ceeApiKey },
        mobileUrl: urls.mobileUrl, wsUrl: urls.wsUrl
    });
});

webServer.on('mode-toggle', toggleMode);

webServer.on('remote-control-start', () => setRemoteControlMode(true));
webServer.on('remote-control-end', () => setRemoteControlMode(false));

// --- IPC Handlers (Overlay interaction) ---

ipcMain.on('close-app', () => app.quit());

ipcMain.on('enter-passive', () => { if (!isPassive) toggleMode(); });
ipcMain.on('request-focus', () => { if (mainWindow && !isPassive) mainWindow.focus(); });

// Restore missing handler for session info (critical for Overlay UI)
ipcMain.handle('get-session-info', () => {
    // Note: webServer.getUrls() now returns the correct URLs including tunnels if active
    const urls = webServer.getUrls();
    const info = {
        code: webServer.sessionCode,
        adminPassword: webServer.adminPassword,
        wsUrl: urls.wsUrl,
        mobileUrl: urls.mobileUrl,
        adminUrl: urls.adminUrl,
        // Fallback local URLs
        localWsUrl: `ws://${webServer.getLocalIP()}:${webServer.wsPort}`,
        localMobileUrl: `http://${webServer.getLocalIP()}:${webServer.httpPort}?s=${webServer.sessionCode}`,
        localAdminUrl: `http://${webServer.getLocalIP()}:${webServer.httpPort}/admin?s=${webServer.sessionCode}`
    };
    return info;
});

ipcMain.on('settings-changed', (_, settings) => {
    // Similar to settings-update but from Overlay
    Object.assign(currentSettings, settings);

    if (settings.enableFeedbackForm !== undefined) {
        if (settings.enableFeedbackForm) {
            currentSettings.feedbackCycleId = (currentSettings.feedbackCycleId || 0) + 1;
            initFeedbackLoggingForCycle();
        }
    }

    if (settings.enableCeeAgent !== undefined || settings.ceeApiKey !== undefined) {
        if (settings.ceeApiKey) ceeApiKey = settings.ceeApiKey;
        ceeAgent.updateSettings({ ...currentSettings, ceeApiKey });
    }

    // Broadcast to admins
    const urls = webServer.getUrls();
    webServer.broadcastToAdmins({
        type: 'settings-sync', settings: { ...currentSettings, ceeApiKeySet: !!ceeApiKey },
        mobileUrl: urls.mobileUrl, wsUrl: urls.wsUrl
    });
});

ipcMain.on('enable-remote-control', () => {
    currentSettings.remoteEnabled = true;
    if (process.platform === 'linux') remoteControl.detectDotool();

    webServer.broadcastToAdmins({ type: 'remote-enabled-status', enabled: true });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings-update', { remoteEnabled: true });
});

ipcMain.on('disable-remote-control', () => {
    currentSettings.remoteEnabled = false;
    webServer.broadcastToAdmins({ type: 'remote-enabled-status', enabled: false });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings-update', { remoteEnabled: false });
});

ipcMain.on('window-move', (_, { deltaX, deltaY }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        const [x, y] = mainWindow.getPosition();
        mainWindow.setPosition(x + deltaX, y + deltaY);
    }
});

ipcMain.on('window-resize', (_, { width, height }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setSize(Math.max(200, width), Math.max(150, height));
    }
});

ipcMain.handle('get-window-bounds', () => mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : {});

// Screenshot capture for CeeAgent
ipcMain.on('screenshot-result', (_, base64) => {
    ceeAgent.resolvePendingScreenshot(base64);
});

// Restore missing handler for getting screen sources (critical for Cee to work without repeated prompts)
ipcMain.handle('get-screen-sources', async () => {
    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1, height: 1 }
        });
        return sources.map(s => ({ id: s.id, name: s.name }));
    } catch (err) {
        console.error('[Cee] Failed to get screen sources:', err.message);
        return [];
    }
});

// --- Tunneling ---
async function createTunnels() {
    function startTunnel(port, type) {
        return new Promise((resolve, reject) => {
            const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
            let resolved = false;
            let buffer = '';

            const check = (text) => {
                const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
                if (match && match.length > 0 && !resolved) {
                    resolved = true;
                    resolve({ process: proc, url: match[0] });
                }
            };

            proc.stdout.on('data', d => { buffer += d; check(d.toString()); });
            proc.stderr.on('data', d => { buffer += d; check(d.toString()); });

            setTimeout(() => {
                if (!resolved) {
                    proc.kill();
                    reject(new Error('Timeout'));
                }
            }, 15000);
        });
    }

    try {
        const wsRes = await startTunnel(WS_PORT, 'WebSocket');
        wsTunnel = { url: wsRes.url.replace('https://', 'wss://') };
        wsTunnelProcess = wsRes.process;

        const httpRes = await startTunnel(WS_PORT + 1, 'HTTP');
        httpTunnel = { url: httpRes.url };
        httpTunnelProcess = httpRes.process;

        // Correctly set BOTH tunnel URLs on WebServer
        webServer.setTunnelUrls(wsTunnel.url, httpTunnel.url);

        console.log(`Cloudflare WebSocket: ${wsTunnel.url}`);
        console.log(`Cloudflare Mobile: ${httpTunnel.url}`);

        // Update clients
        const urls = webServer.getUrls();
        webServer.broadcastToAdmins({ type: 'settings-sync', settings: currentSettings, mobileUrl: urls.mobileUrl, wsUrl: urls.wsUrl });

    } catch (e) {
        console.log('Tunnel creation failed or timed out, using local network only.');
    }
}


// --- App Lifecycle ---
app.whenReady().then(async () => {
    globalShortcut.register('CommandOrControl+Alt+K', toggleMode);

    initChatLogging();
    createWindow();
    webServer.start();

    await createTunnels();

    const localIP = webServer.getLocalIP();
    console.log(`Session: ${webServer.sessionCode}`);
    console.log(`AdminPW: ${webServer.adminPassword}`);
    console.log(`Mobile: http://${localIP}:${WS_PORT + 1}?s=${webServer.sessionCode}`);
    console.log(`Socket: ws://${localIP}:${WS_PORT}`);
});

function cleanup() {
    webServer.stop();
    remoteControl.stopDotoold();
    if (wsTunnelProcess) wsTunnelProcess.kill();
    if (httpTunnelProcess) httpTunnelProcess.kill();
    if (chatLogStream) chatLogStream.end();
    if (feedbackLogStream) feedbackLogStream.end();
}

app.on('before-quit', cleanup);
app.on('will-quit', cleanup);
app.on('window-all-closed', () => app.quit());
