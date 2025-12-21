const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, nativeImage } = require('electron');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');
const { GoogleGenAI } = require('@google/genai');

// nut.js for cross-platform mouse, keyboard, and screen control
const { mouse, keyboard, Key, Button } = require('@nut-tree-fork/nut-js');

// Configure nut.js for faster response
mouse.config.autoDelayMs = 0;
mouse.config.mouseSpeed = 2000; // pixels per second
keyboard.config.autoDelayMs = 0;

let mainWindow;
let isPassive = false; // Start in active mode
let wss = null;
let httpServer = null;
let httpTunnel = null;
let wsTunnel = null;
let httpTunnelProcess = null;
let wsTunnelProcess = null;
const WS_PORT = 8765;

// --- Remote Control State ---
let remoteControlActive = false;
let electronWasIgnoringMouseEvents = false;
const MOUSE_MOVE_RATE_LIMIT = 16; // ~60fps
let lastMouseMoveTime = 0;
let isDragging = false;

// Platform detection for mouse control
const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// Helper function to execute shell commands
const { execSync, exec } = require('child_process');

// --- Linux Input Tool (dotool only) ---
// dotool is used for input simulation on both Wayland and X11

let dotoolAvailable = false;
let dotooldProcess = null; // Track the dotoold daemon process
let dotoolBinPath = ''; // Path to dotool binary (system or bundled)

// Get the path to bundled binaries (when packaged)
function getDotoolPath() {
    if (app.isPackaged) {
        // When packaged, binaries are in resources/bin/
        return require('path').join(process.resourcesPath, 'bin');
    } else {
        // In development, check project bin/ folder first, then system
        const localBin = require('path').join(__dirname, 'bin');
        if (require('fs').existsSync(require('path').join(localBin, 'dotool'))) {
            return localBin;
        }
        return ''; // Empty means use system PATH
    }
}

// Start the dotoold daemon for faster input
function startDotoold() {
    if (!isLinux || dotooldProcess) return;

    try {
        const dotooldPath = dotoolBinPath ? require('path').join(dotoolBinPath, 'dotoold') : 'dotoold';

        // Start dotoold daemon in background
        dotooldProcess = require('child_process').spawn(dotooldPath, [], {
            detached: true,
            stdio: 'ignore'
        });

        // Don't let dotoold keep the parent process alive
        dotooldProcess.unref();

        console.log('[Remote] Started dotoold daemon');
    } catch (err) {
        console.log('[Remote] dotoold not available, using dotool directly');
    }
}

// Stop the dotoold daemon on app exit
function stopDotoold() {
    if (dotooldProcess) {
        try {
            dotooldProcess.kill();
            console.log('[Remote] Stopped dotoold daemon');
        } catch (err) {
            // Ignore errors when stopping
        }
        dotooldProcess = null;
    }
}

// Check if user has permission to use dotool (uinput access)
// Returns: 'ok' | 'need-setup' | 'need-relogin'
function checkDotoolPermission() {
    if (!isLinux || !dotoolAvailable) return 'ok';

    const udevRulePath = '/etc/udev/rules.d/99-chatoneverything.rules';
    const ruleExists = require('fs').existsSync(udevRulePath);

    // Try a simple dotool command to check if it actually works
    try {
        const dotoolPath = dotoolBinPath ? require('path').join(dotoolBinPath, 'dotool') : 'dotool';
        execSync(`echo "key shift" | ${dotoolPath}`, {
            stdio: 'ignore',
            timeout: 2000,
            env: dotoolBinPath ? { ...process.env, PATH: `${dotoolBinPath}:${process.env.PATH}` } : process.env
        });
        return 'ok';
    } catch (err) {
        // dotool failed - check why
        if (ruleExists) {
            // Rule is installed but not working - user needs to re-login
            return 'need-relogin';
        } else {
            // Rule not installed - need setup
            return 'need-setup';
        }
    }
}

// Show dialog asking user to log out and log back in
function showReloginDialog() {
    const { dialog } = require('electron');

    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Log Out Required',
        message: 'Please log out and log back in to complete setup.',
        detail: `The remote control permissions have been configured, but they require a fresh login to take effect.\n\n` +
            `Please:\n` +
            `1. Close this app\n` +
            `2. Log out of your desktop session\n` +
            `3. Log back in\n` +
            `4. Start the app again\n\n` +
            `Remote control will work after you log back in.`,
        buttons: ['OK']
    });
}

// Install udev rule for uinput access (requires pkexec for GUI sudo)
function installUdevRule() {
    const rulePath = '/etc/udev/rules.d/99-chatoneverything.rules';
    // Use heredoc to avoid quote escaping issues
    const cmd = `pkexec bash -c 'cat > ${rulePath} << EOF
KERNEL=="uinput", MODE="0660", GROUP="input", TAG+="uaccess"
EOF
udevadm control --reload-rules && udevadm trigger'`;

    try {
        // Use pkexec for GUI sudo prompt
        execSync(cmd, {
            stdio: 'inherit',
            timeout: 60000
        });
        console.log('[Remote] Successfully installed udev rule');
        return true;
    } catch (err) {
        console.error('[Remote] Failed to install udev rule:', err.message);
        return false;
    }
}

// Show dialog for permission setup with auto-setup option
function showDotoolPermissionDialog() {
    const { dialog } = require('electron');

    dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Remote Control Setup Required',
        message: 'Remote control needs permission to simulate input.',
        detail: 'Click "Auto Setup" to configure permissions automatically, this will modify input access for the user. After setup completes the app will autorestart.',
        buttons: ['Auto Setup', 'Cancel'],
        defaultId: 0,
        cancelId: 1
    }).then(result => {
        if (result.response === 0) {
            // Auto Setup - install udev rule
            const success = installUdevRule();
            if (success) {
                dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    title: 'Setup Complete',
                    message: 'Permissions configured successfully!',
                    detail: 'The app will now restart to apply the changes.\n\n' +
                        'If remote control still doesn\'t work after restart, you may need to log out and log back in.',
                    buttons: ['OK']
                }).then(() => {
                    // Restart the app after a short delay to let dialog close cleanly
                    setTimeout(() => {
                        app.relaunch();
                        app.exit(0);
                    }, 500);
                });
            } else {
                // Fallback to manual instructions
                dialog.showMessageBox(mainWindow, {
                    type: 'error',
                    title: 'Auto Setup Failed',
                    message: 'Could not configure permissions automatically.',
                    detail: 'Please run in terminal:\nsudo usermod -aG input $USER\n\nThen log out and log back in.',
                    buttons: ['OK']
                });
            }
        }
    });
}

function detectDotool() {
    if (!isLinux) return;

    // Detect if running Wayland or X11 (for logging only)
    const isWayland = process.env.XDG_SESSION_TYPE === 'wayland' ||
        !!process.env.WAYLAND_DISPLAY;

    console.log(`[Remote] Display server: ${isWayland ? 'Wayland' : 'X11'}`);

    // Get path to dotool binaries
    dotoolBinPath = getDotoolPath();
    if (dotoolBinPath) {
        console.log(`[Remote] Using bundled dotool from: ${dotoolBinPath}`);
    }

    // Check if dotool is available
    try {
        const dotoolPath = dotoolBinPath ? require('path').join(dotoolBinPath, 'dotool') : 'dotool';
        if (dotoolBinPath) {
            // Check if bundled binary exists
            if (require('fs').existsSync(dotoolPath)) {
                dotoolAvailable = true;
            }
        } else {
            // Check system PATH
            execSync('which dotool', { stdio: 'ignore' });
            dotoolAvailable = true;
        }
        console.log('[Remote] dotool is available');
    } catch {
        console.error('[Remote] ERROR: dotool not found! Please install dotool for remote control.');
        console.error('[Remote] Install with: git clone https://git.sr.ht/~geb/dotool && cd dotool && ./build.sh && sudo ./build.sh install');
    }

    // Start the dotoold daemon
    if (dotoolAvailable) {
        startDotoold();

        // Check permissions after a short delay (after mainWindow is ready)
        setTimeout(() => {
            const permStatus = checkDotoolPermission();
            if (permStatus === 'need-setup') {
                console.log('[Remote] Permission setup needed - showing setup dialog');
                showDotoolPermissionDialog();
            } else if (permStatus === 'need-relogin') {
                console.log('[Remote] Permissions configured but need re-login');
                showReloginDialog();
            }
        }, 2000);
    }
}

// Get screen dimensions for reference
let screenWidth = 1920;
let screenHeight = 1080;

function getScreenDimensions() {
    try {
        const output = execSync('xdpyinfo 2>/dev/null | grep dimensions', { encoding: 'utf8' });
        const match = output.match(/(\d+)x(\d+)/);
        if (match) {
            screenWidth = parseInt(match[1]);
            screenHeight = parseInt(match[2]);
            console.log(`[Remote] Screen dimensions: ${screenWidth}x${screenHeight}`);
        }
    } catch {
        console.log('[Remote] Using default screen dimensions: 1920x1080');
    }
}

if (isLinux) {
    getScreenDimensions();
}

// Execute dotool command
let useDotoolDirect = false; // Flag to skip dotoolc if daemon isn't working

function dotoolExec(command) {
    if (!dotoolAvailable) {
        console.error('[Remote] dotool not available');
        return null;
    }

    const envOverride = dotoolBinPath ? { ...process.env, PATH: `${dotoolBinPath}:${process.env.PATH}` } : process.env;

    // Try dotoolc first (faster, uses daemon) unless we know it's not working
    if (!useDotoolDirect) {
        try {
            const dotoolcPath = dotoolBinPath ? require('path').join(dotoolBinPath, 'dotoolc') : 'dotoolc';
            const result = execSync(`echo "${command.replace(/"/g, '\\"')}" | ${dotoolcPath}`, {
                encoding: 'utf8',
                shell: '/bin/bash',
                timeout: 2000,
                env: envOverride
            });
            return result;
        } catch (err) {
            // If dotoolc fails because daemon isn't running, switch to direct mode
            if (err.message && err.message.includes('no dotoold instance')) {
                console.log('[Remote] dotoold not available, switching to direct dotool');
                useDotoolDirect = true;
            } else {
                console.error('[Remote] dotoolc error:', err.message);
                return null;
            }
        }
    }

    // Fall back to dotool directly (slower but doesn't need daemon)
    try {
        const dotoolPath = dotoolBinPath ? require('path').join(dotoolBinPath, 'dotool') : 'dotool';
        const result = execSync(`echo "${command.replace(/"/g, '\\"')}" | ${dotoolPath}`, {
            encoding: 'utf8',
            shell: '/bin/bash',
            timeout: 2000,
            env: envOverride
        });
        return result;
    } catch (err) {
        console.error('[Remote] dotool error:', err.message);
        return null;
    }
}

// Move mouse relative
function linuxMouseMoveRelative(deltaX, deltaY) {
    if (!dotoolAvailable) return;
    const x = Math.round(deltaX);
    const y = Math.round(deltaY);
    dotoolExec(`mousemove ${x} ${y}`);
}

// Initialize dotool on startup
if (isLinux) {
    detectDotool();
}

// Key mapping for special keys (browser key names to nut.js Key enum)
const KEY_MAP = {
    'Enter': Key.Return,
    'Backspace': Key.Backspace,
    'Tab': Key.Tab,
    'Escape': Key.Escape,
    'Space': Key.Space,
    'ArrowUp': Key.Up,
    'ArrowDown': Key.Down,
    'ArrowLeft': Key.Left,
    'ArrowRight': Key.Right,
    'Delete': Key.Delete,
    'Home': Key.Home,
    'End': Key.End,
    'PageUp': Key.PageUp,
    'PageDown': Key.PageDown,
    'F1': Key.F1, 'F2': Key.F2, 'F3': Key.F3, 'F4': Key.F4,
    'F5': Key.F5, 'F6': Key.F6, 'F7': Key.F7, 'F8': Key.F8,
    'F9': Key.F9, 'F10': Key.F10, 'F11': Key.F11, 'F12': Key.F12,
    'Control': Key.LeftControl,
    'Alt': Key.LeftAlt,
    'Shift': Key.LeftShift,
    'Meta': Key.LeftSuper,
};

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
    try { candidates.push(path.join(process.cwd(), 'chat-logs')); } catch (_) { }
    try { candidates.push(path.join(__dirname, 'chat-logs')); } catch (_) { }
    try { candidates.push(path.join(app.getPath('userData'), 'chat-logs')); } catch (_) { }

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
    // Cloudflare provides real client IP in CF-Connecting-IP header (most reliable)
    // Check both lowercase and original case (headers can vary)
    const cfIp = req?.headers?.['cf-connecting-ip'] || req?.headers?.['CF-Connecting-IP'];
    if (cfIp && typeof cfIp === 'string') {
        const n = normalizeIp(cfIp.trim());
        if (n) {
            return n; // Trust Cloudflare header - it contains the real client IP
        }
    }
    // Fallback to X-Forwarded-For (may contain multiple IPs, take first)
    const xf = req?.headers?.['x-forwarded-for'] || req?.headers?.['X-Forwarded-For'];
    if (xf && typeof xf === 'string') {
        // X-Forwarded-For format: "client, proxy1, proxy2"
        // Real client is usually first, but take first non-private if available
        const ips = xf.split(',').map(ip => ip.trim());
        for (const ip of ips) {
            const n = normalizeIp(ip);
            if (n) {
                // Prefer first IP (real client), but if it's a known proxy IP, try next
                // Cloudflare IPs typically start with 104.x or are in specific ranges
                if (!n.startsWith('104.') && !n.startsWith('172.64.') && !n.startsWith('172.65.')) {
                    return n;
                }
            }
        }
        // If all look like proxies, return first one anyway
        if (ips.length > 0) {
            const n = normalizeIp(ips[0]);
            if (n) return n;
        }
    }
    // Last resort: direct connection IP (will be Cloudflare's IP if behind tunnel)
    const raw = req?.socket?.remoteAddress || null;
    const normalized = normalizeIp(raw);

    // Log warning if we're falling back to proxy IP (indicates headers not being passed)
    if (normalized && (normalized.startsWith('104.') || normalized.startsWith('172.64.') || normalized.startsWith('172.65.'))) {
        console.warn('Warning: Using Cloudflare proxy IP instead of real client IP. Headers not available:', {
            'cf-connecting-ip': req?.headers?.['cf-connecting-ip'] || req?.headers?.['CF-Connecting-IP'] || 'missing',
            'x-forwarded-for': req?.headers?.['x-forwarded-for'] || req?.headers?.['X-Forwarded-For'] || 'missing',
            'all-headers': Object.keys(req?.headers || {}).filter(k => k.toLowerCase().includes('ip') || k.toLowerCase().includes('forward'))
        });
    }
    return normalized;
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
    // Hide IP: when true, use Cloudflare URLs; when false, use local URLs
    hideIp: false,
    // Emoji shortcut shown on mobile + admin pages
    customEmoji: '⭐',
    // When true, emoji buttons send directly; when false, they insert into text box
    emojiDirectSend: true,
    // Slow mode: require gap between messages per user
    slowModeEnabled: false,
    slowModeSeconds: 3,
    // Feedback form control (synced to all mobile clients)
    enableFeedbackForm: false,
    // Incremented each time feedback is enabled to create a new "event"
    feedbackCycleId: 0,
    // @Cee AI Agent settings
    enableCeeAgent: false,
    ceeApiProvider: 'openai',  // 'openai' or 'gemini'
    ceeSystemPrompt: '',  // Custom personality instructions (e.g., "be like Darth Vader")
    // Remote control (phone controls mouse/keyboard/media)
    remoteEnabled: false
};

// @Cee AI Agent state (not persisted, session-only)
let ceeApiKey = '';
const chatHistory = []; // Store recent messages for context (max 50)
const MAX_CHAT_HISTORY = 50;

// Screenshot capture via renderer (to avoid repeated permission dialogs)
let pendingScreenshotResolve = null;

// @Cee System prompt
const CEE_SYSTEM_PROMPT = `You are Cee, a friendly and helpful AI assistant participating in a live chat.

Visual Context Protocol
1. You are provided with a screenshot of the user's screen, but only refer to it if the user's question is specifically about what they are seeing or if the answer cannot be found in the text history.

2. If the conversation is general or text-based, ignore the screenshot entirely in your response.

3. Avoid meta-commentary like "In the screenshot I see..." or "Looking at your screen..." Instead, just answer the question naturally.

Communication Style
1. Concise: Keep responses to 1-3 sentences. Since this is a fast-moving chat, you should be able to answer the question in a few sentences.

2. Tone: Be casual and friendly, like a friend in the chat.

3. Formatting: Use plain text only. Do NOT use markdown (no bold, italics, or bullet points).

4. Context: Use the recent chat history to maintain the flow of conversation.`;

// Capture screenshot via renderer process (uses persistent stream, avoids repeated permission dialogs)
async function captureScreenshot() {
    // Try to get screenshot from renderer's persistent stream
    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            const screenshot = await new Promise((resolve, reject) => {
                pendingScreenshotResolve = resolve;
                mainWindow.webContents.send('capture-screenshot');

                // Timeout after 5 seconds
                setTimeout(() => {
                    if (pendingScreenshotResolve === resolve) {
                        pendingScreenshotResolve = null;
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

    // Fallback: On Linux, try native screenshot tools
    if (process.platform === 'linux') {
        try {
            const screenshot = await captureScreenshotLinux();
            if (screenshot) return screenshot;
        } catch (err) {
            console.log('[Cee] Linux native screenshot failed:', err.message);
        }
    }

    // Last resort: use desktopCapturer directly (may show permission dialog)
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

// Linux-specific screenshot using native tools (avoids PipeWire permission dialogs)
async function captureScreenshotLinux() {
    const os = require('os');
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

// Call OpenAI API with vision
async function callOpenAI(question, screenshotBase64) {
    console.log('[Cee] Calling OpenAI API...');
    console.log('[Cee] API key prefix:', ceeApiKey?.substring(0, 7) || 'NOT SET');

    return new Promise((resolve, reject) => {
        // Build chat history context (last 20 messages for context)
        const recentHistory = chatHistory.slice(-20).map(m => `${m.user}: ${m.text}`).join('\n');
        console.log('[Cee] Recent history for context:', recentHistory.length, 'chars');

        // Build system prompt with custom instructions if set
        let systemPrompt = CEE_SYSTEM_PROMPT;
        if (currentSettings.ceeSystemPrompt) {
            systemPrompt += '\n\nAdditional instructions: ' + currentSettings.ceeSystemPrompt;
            console.log('[Cee] Using custom instructions:', currentSettings.ceeSystemPrompt);
        }

        // Build messages array
        const messages = [
            { role: 'system', content: systemPrompt },
        ];

        // Add chat history as context
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

        // Build the user message with image
        const userContent = [];
        userContent.push({ type: 'text', text: question });

        if (screenshotBase64) {
            userContent.push({
                type: 'image_url',
                image_url: {
                    url: `data:image/jpeg;base64,${screenshotBase64}`,
                    detail: 'low' // Use low detail to reduce tokens
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
                'Authorization': `Bearer ${ceeApiKey}`,
                'Content-Length': Buffer.byteLength(requestBody)
            }
        };

        const req = https.request(options, (res) => {
            console.log('[Cee] OpenAI response status:', res.statusCode);
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                console.log('[Cee] OpenAI raw response length:', data.length);
                try {
                    const json = JSON.parse(data);
                    if (json.error) {
                        console.error('[Cee] OpenAI API error:', json.error);
                        reject(new Error(json.error.message || 'OpenAI API error'));
                        return;
                    }
                    const response = json.choices?.[0]?.message?.content?.trim();
                    if (response) {
                        console.log('[Cee] OpenAI response:', response);
                        resolve(response);
                    } else {
                        console.error('[Cee] No response content in:', JSON.stringify(json).substring(0, 200));
                        reject(new Error('No response from OpenAI'));
                    }
                } catch (e) {
                    console.error('[Cee] Failed to parse response:', data.substring(0, 500));
                    reject(new Error('Failed to parse OpenAI response'));
                }
            });
        });

        req.on('error', (e) => {
            console.error('[Cee] Request error:', e.message);
            reject(new Error(`OpenAI request failed: ${e.message}`));
        });

        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('OpenAI request timed out'));
        });

        req.write(requestBody);
        req.end();
    });
}

// Call Gemini API with vision using Google GenAI SDK
async function callGemini(question, screenshotBase64) {
    console.log('[Cee] Calling Gemini API...');
    console.log('[Cee] API key prefix:', ceeApiKey?.substring(0, 7) || 'NOT SET');

    // Build chat history context (last 20 messages for context)
    const recentHistory = chatHistory.slice(-20).map(m => `${m.user}: ${m.text}`).join('\n');
    console.log('[Cee] Recent history for context:', recentHistory.length, 'chars');

    // Build system prompt with custom instructions if set
    let systemPrompt = CEE_SYSTEM_PROMPT;
    if (currentSettings.ceeSystemPrompt) {
        systemPrompt += '\n\nAdditional instructions: ' + currentSettings.ceeSystemPrompt;
        console.log('[Cee] Using custom instructions:', currentSettings.ceeSystemPrompt);
    }

    // Build the full prompt text
    let fullPrompt = systemPrompt + '\n\n';
    if (recentHistory) {
        fullPrompt += `Recent chat history for context:\n${recentHistory}\n\n`;
    }
    fullPrompt += `User question: ${question}`;

    try {
        // Initialize the Google GenAI client
        const ai = new GoogleGenAI({ apiKey: ceeApiKey });

        // Build contents array
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

        // Generate content
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: contents,
            config: {
                maxOutputTokens: 500,
                temperature: 0.7
            }
        });

        const responseText = response.text?.trim();
        if (responseText) {
            console.log('[Cee] Gemini response:', responseText);
            return responseText;
        } else {
            console.error('[Cee] No response text from Gemini');
            throw new Error('No response from Gemini');
        }
    } catch (error) {
        console.error('[Cee] Gemini API error:', error.message);
        throw new Error(error.message || 'Gemini API error');
    }
}

// Process @Cee request asynchronously
async function processCeeRequest(askedBy, question) {
    console.log(`[Cee] === Processing @Cee request ===`);
    console.log(`[Cee] Asked by: ${askedBy}`);
    console.log(`[Cee] Question: ${question}`);
    console.log(`[Cee] Chat history length: ${chatHistory.length}`);

    try {
        // Capture screenshot
        console.log('[Cee] Capturing screenshot...');
        const screenshot = await captureScreenshot();
        console.log('[Cee] Screenshot captured:', screenshot ? `${screenshot.length} chars base64` : 'FAILED');

        // Call appropriate API based on provider setting
        const provider = currentSettings.ceeApiProvider || 'openai';
        console.log('[Cee] Using provider:', provider);
        let response;
        if (provider === 'gemini') {
            response = await callGemini(question, screenshot);
        } else {
            response = await callOpenAI(question, screenshot);
        }

        // Broadcast Cee's response as a message
        const msgId = ++messageIdCounter;
        const now = new Date().toISOString();
        const ceeUser = 'Cee';

        const entry = {
            id: msgId,
            user: ceeUser,
            text: response,
            ip: null,
            timestamp: now
        };
        messageIndex.set(msgId, entry);

        // Add to chat history
        chatHistory.push({ user: ceeUser, text: response, timestamp: now });
        while (chatHistory.length > MAX_CHAT_HISTORY) {
            chatHistory.shift();
        }

        writeChatLog({
            type: 'message',
            sessionCode,
            ...entry,
            ceeResponse: true,
            askedBy: askedBy,
            question: question
        });

        // Forward to overlay
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('new-message', { id: msgId, user: ceeUser, text: response });
        }

        // Broadcast to all clients
        if (wss) {
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    try {
                        client.send(JSON.stringify({ type: 'message', id: msgId, user: ceeUser, text: response }));
                    } catch (err) {
                        console.error('Error sending Cee response to client:', err);
                    }
                }
            });
        }

        console.log(`Cee responded: ${response}`);
    } catch (err) {
        console.error('Cee request failed:', err.message);

        // Send error message as Cee
        const msgId = ++messageIdCounter;
        const now = new Date().toISOString();
        const errorText = `Sorry, I couldn't process that request. ${err.message}`;

        const entry = {
            id: msgId,
            user: 'Cee',
            text: errorText,
            ip: null,
            timestamp: now
        };
        messageIndex.set(msgId, entry);

        writeChatLog({
            type: 'message',
            sessionCode,
            ...entry,
            ceeError: true,
            askedBy: askedBy,
            question: question
        });

        // Forward to overlay
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('new-message', { id: msgId, user: 'Cee', text: errorText });
        }

        // Broadcast error to all clients
        if (wss) {
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    try {
                        client.send(JSON.stringify({ type: 'message', id: msgId, user: 'Cee', text: errorText }));
                    } catch (e) {
                        console.error('Error sending Cee error to client:', e);
                    }
                }
            });
        }
    }
}

// Track last message time per user (by IP) for slow mode
const lastMessageTimeByIp = new Map();

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
        focusable: true,
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

    // Broadcast mode state to all admin clients
    broadcastToAdmins({
        type: 'mode-state',
        mode: isPassive ? 'passive' : 'active'
    });
}

// --- Remote Control Functions ---

// Toggle remote control mode (enables mouse passthrough for Electron window)
function setRemoteControlMode(active) {
    remoteControlActive = active;
    console.log(`[Remote] Setting remote control mode: ${active}`);

    if (active) {
        // Save current state
        electronWasIgnoringMouseEvents = isPassive;

        // Enable mouse passthrough so clicks go to underlying windows
        mainWindow.setIgnoreMouseEvents(true, { forward: true });

        // Make window non-focusable and blur it so it doesn't steal focus
        mainWindow.setFocusable(false);
        mainWindow.blur();

        console.log('[Remote] Enabled mouse event passthrough, blurred window');
    } else {
        // Restore previous state
        mainWindow.setIgnoreMouseEvents(electronWasIgnoringMouseEvents, { forward: electronWasIgnoringMouseEvents });
        mainWindow.setFocusable(!electronWasIgnoringMouseEvents);
        isDragging = false; // Reset drag state
        console.log('[Remote] Restored mouse event state');
    }

    // Broadcast state to admins
    broadcastToAdmins({
        type: 'remote-control-state',
        active: remoteControlActive
    });
}

// Handle mouse movement (relative delta)
async function handleRemoteMouseMove(deltaX, deltaY) {
    // Rate limit to prevent overwhelming
    const now = Date.now();
    if (now - lastMouseMoveTime < MOUSE_MOVE_RATE_LIMIT) {
        return;
    }
    lastMouseMoveTime = now;

    try {
        if (isLinux) {
            // Use new unified relative movement function
            linuxMouseMoveRelative(deltaX, deltaY);
        } else {
            // Use nut.js for Windows/Mac
            const currentPos = await mouse.getPosition();
            const newX = Math.round(currentPos.x + deltaX);
            const newY = Math.round(currentPos.y + deltaY);
            await mouse.setPosition({ x: newX, y: newY });
        }
    } catch (err) {
        console.error('[Remote] Mouse move error:', err.message);
    }
}

// Handle mouse click
async function handleRemoteMouseClick(buttonType = 'left') {
    try {
        if (isLinux) {
            // dotool uses button names: left, right, middle
            dotoolExec(`click ${buttonType}`);
        } else {
            const button = buttonType === 'right' ? Button.RIGHT :
                buttonType === 'middle' ? Button.MIDDLE : Button.LEFT;
            await mouse.click(button);
        }
        console.log(`[Remote] Mouse ${buttonType} click`);
    } catch (err) {
        console.error('[Remote] Mouse click error:', err.message);
    }
}

// Handle mouse double click
async function handleRemoteMouseDoubleClick(buttonType = 'left') {
    try {
        if (isLinux) {
            // dotool: two clicks with delay
            dotoolExec(`click ${buttonType}`);
            setTimeout(() => dotoolExec(`click ${buttonType}`), 50);
        } else {
            const button = buttonType === 'right' ? Button.RIGHT : Button.LEFT;
            await mouse.doubleClick(button);
        }
        console.log(`[Remote] Mouse double ${buttonType} click`);
    } catch (err) {
        console.error('[Remote] Mouse double click error:', err.message);
    }
}

// Handle mouse down (for drag start)
async function handleRemoteMouseDown(buttonType = 'left') {
    try {
        if (isLinux) {
            // dotool supports buttondown/buttonup for drag
            dotoolExec(`buttondown ${buttonType}`);
        } else {
            const button = buttonType === 'right' ? Button.RIGHT : Button.LEFT;
            await mouse.pressButton(button);
        }
        isDragging = true;
        console.log(`[Remote] Mouse ${buttonType} button down (drag start)`);
    } catch (err) {
        console.error('[Remote] Mouse down error:', err.message);
    }
}

// Handle mouse up (for drag end)
async function handleRemoteMouseUp(buttonType = 'left') {
    try {
        if (isLinux) {
            dotoolExec(`buttonup ${buttonType}`);
        } else {
            const button = buttonType === 'right' ? Button.RIGHT : Button.LEFT;
            await mouse.releaseButton(button);
        }
        isDragging = false;
        console.log(`[Remote] Mouse ${buttonType} button up (drag end)`);
    } catch (err) {
        console.error('[Remote] Mouse up error:', err.message);
    }
}

// Handle scroll
async function handleRemoteScroll(deltaX, deltaY) {
    try {
        if (isLinux) {
            // dotool: scroll N (positive=down, negative=up)
            const amount = Math.min(Math.ceil(Math.abs(deltaY) / 3), 10);
            if (deltaY > 0) {
                dotoolExec(`scroll ${amount}`);
            } else if (deltaY < 0) {
                dotoolExec(`scroll -${amount}`);
            }
        } else {
            await mouse.scrollDown(Math.round(deltaY));
            if (deltaX !== 0) {
                await mouse.scrollRight(Math.round(deltaX));
            }
        }
    } catch (err) {
        console.error('[Remote] Scroll error:', err.message);
    }
}

// Handle keyboard text input
async function handleRemoteKeyboardType(text) {
    try {
        if (isLinux) {
            // dotool type command handles text directly
            dotoolExec(`type ${text}`);
        } else {
            await keyboard.type(text);
        }
        console.log(`[Remote] Typed: ${text.substring(0, 20)}${text.length > 20 ? '...' : ''}`);
    } catch (err) {
        console.error('[Remote] Keyboard type error:', err.message);
    }
}

// Key mapping for dotool (browser key names to dotool key names)
const DOTOOL_KEY_MAP = {
    'Enter': 'enter', 'Backspace': 'backspace', 'Tab': 'tab',
    'Escape': 'esc', 'Space': 'space', 'Delete': 'delete',
    'ArrowUp': 'up', 'ArrowDown': 'down', 'ArrowLeft': 'left', 'ArrowRight': 'right',
    'Home': 'home', 'End': 'end', 'PageUp': 'pageup', 'PageDown': 'pagedown',
    'F1': 'f1', 'F2': 'f2', 'F3': 'f3', 'F4': 'f4', 'F5': 'f5',
    'F6': 'f6', 'F7': 'f7', 'F8': 'f8', 'F9': 'f9', 'F10': 'f10', 'F11': 'f11', 'F12': 'f12',
    'Control': 'ctrl', 'Shift': 'shift', 'Alt': 'alt'
};

// Handle special key press
async function handleRemoteKeyboardKey(keyName, modifiers = []) {
    try {
        if (isLinux) {
            const dKey = DOTOOL_KEY_MAP[keyName] || keyName.toLowerCase();
            const keyCmd = modifiers.length > 0
                ? modifiers.map(m => (DOTOOL_KEY_MAP[m] || m).toLowerCase()).join('+') + '+' + dKey
                : dKey;
            dotoolExec(`key ${keyCmd}`);
        } else {
            const key = KEY_MAP[keyName];
            if (!key) {
                console.log(`[Remote] Unknown key: ${keyName}`);
                return;
            }
            const modKeys = modifiers.map(m => KEY_MAP[m]).filter(Boolean);
            if (modKeys.length > 0) {
                for (const mod of modKeys) await keyboard.pressKey(mod);
                await keyboard.pressKey(key);
                await keyboard.releaseKey(key);
                for (const mod of modKeys.reverse()) await keyboard.releaseKey(mod);
            } else {
                await keyboard.pressKey(key);
                await keyboard.releaseKey(key);
            }
        }
        console.log(`[Remote] Key: ${keyName}${modifiers.length ? ' with ' + modifiers.join('+') : ''}`);
    } catch (err) {
        console.error('[Remote] Keyboard key error:', err.message);
    }
}

// Handle volume control
async function handleRemoteVolume(action) {
    try {
        if (isLinux) {
            // dotool uses Linux key names: volumeup, volumedown, mute
            const keyMap = { 'up': 'volumeup', 'down': 'volumedown', 'mute': 'mute' };
            const key = keyMap[action];
            if (key) dotoolExec(`key ${key}`);
        } else {
            switch (action) {
                case 'up': await keyboard.pressKey(Key.AudioVolUp); await keyboard.releaseKey(Key.AudioVolUp); break;
                case 'down': await keyboard.pressKey(Key.AudioVolDown); await keyboard.releaseKey(Key.AudioVolDown); break;
                case 'mute': await keyboard.pressKey(Key.AudioVolMute); await keyboard.releaseKey(Key.AudioVolMute); break;
            }
        }
        console.log(`[Remote] Volume: ${action}`);
    } catch (err) {
        console.error('[Remote] Volume error:', err.message);
    }
}

// Handle media control
async function handleRemoteMedia(action) {
    try {
        if (isLinux) {
            // Use simple keys: space=play/pause, right=next, left=prev
            const keyMap = {
                'play': 'space', 'pause': 'space', 'stop': 'space',
                'next': 'right', 'prev': 'left'
            };
            const key = keyMap[action];
            if (key) dotoolExec(`key ${key}`);
        } else {
            switch (action) {
                case 'play': case 'pause': case 'stop':
                    await keyboard.pressKey(Key.Space); await keyboard.releaseKey(Key.Space); break;
                case 'next': await keyboard.pressKey(Key.Right); await keyboard.releaseKey(Key.Right); break;
                case 'prev': await keyboard.pressKey(Key.Left); await keyboard.releaseKey(Key.Left); break;
            }
        }
        console.log(`[Remote] Media: ${action}`);
    } catch (err) {
        console.error('[Remote] Media error:', err.message);
    }
}

// Handle VLC-specific controls
async function handleRemoteVlc(action, value = null) {
    try {
        if (isLinux) {
            const seconds = parseInt(value) || 5;
            let keyCmd = null;
            switch (action) {
                case 'seek':
                    if (Math.abs(seconds) >= 60) keyCmd = `ctrl+shift+${seconds > 0 ? 'right' : 'left'}`;
                    else if (Math.abs(seconds) >= 10) keyCmd = `ctrl+${seconds > 0 ? 'right' : 'left'}`;
                    else keyCmd = `shift+${seconds > 0 ? 'right' : 'left'}`;
                    break;
                case 'fullscreen': keyCmd = 'f'; break;
                case 'volume-up': keyCmd = 'ctrl+up'; break;
                case 'volume-down': keyCmd = 'ctrl+down'; break;
                case 'mute': keyCmd = 'm'; break;
                case 'playlist-next': keyCmd = 'n'; break;
                case 'playlist-prev': keyCmd = 'p'; break;
                case 'shuffle': keyCmd = 'r'; break;
                case 'loop': keyCmd = 'l'; break;
                case 'stop': keyCmd = 's'; break;
                case 'play': keyCmd = 'space'; break;
            }
            if (keyCmd) dotoolExec(`key ${keyCmd}`);
        } else {
            // nut.js for Windows/Mac
            switch (action) {
                case 'seek':
                    const seconds = parseInt(value) || 5;
                    if (Math.abs(seconds) >= 60) {
                        await keyboard.pressKey(Key.LeftControl);
                        await keyboard.pressKey(Key.LeftShift);
                        await keyboard.pressKey(seconds > 0 ? Key.Right : Key.Left);
                        await keyboard.releaseKey(seconds > 0 ? Key.Right : Key.Left);
                        await keyboard.releaseKey(Key.LeftShift);
                        await keyboard.releaseKey(Key.LeftControl);
                    } else if (Math.abs(seconds) >= 10) {
                        await keyboard.pressKey(Key.LeftControl);
                        await keyboard.pressKey(seconds > 0 ? Key.Right : Key.Left);
                        await keyboard.releaseKey(seconds > 0 ? Key.Right : Key.Left);
                        await keyboard.releaseKey(Key.LeftControl);
                    } else {
                        await keyboard.pressKey(Key.LeftShift);
                        await keyboard.pressKey(seconds > 0 ? Key.Right : Key.Left);
                        await keyboard.releaseKey(seconds > 0 ? Key.Right : Key.Left);
                        await keyboard.releaseKey(Key.LeftShift);
                    }
                    break;
                case 'fullscreen': await keyboard.pressKey(Key.F); await keyboard.releaseKey(Key.F); break;
                case 'volume-up': await keyboard.pressKey(Key.LeftControl); await keyboard.pressKey(Key.Up); await keyboard.releaseKey(Key.Up); await keyboard.releaseKey(Key.LeftControl); break;
                case 'volume-down': await keyboard.pressKey(Key.LeftControl); await keyboard.pressKey(Key.Down); await keyboard.releaseKey(Key.Down); await keyboard.releaseKey(Key.LeftControl); break;
                case 'mute': await keyboard.pressKey(Key.M); await keyboard.releaseKey(Key.M); break;
                case 'playlist-next': await keyboard.pressKey(Key.N); await keyboard.releaseKey(Key.N); break;
                case 'playlist-prev': await keyboard.pressKey(Key.P); await keyboard.releaseKey(Key.P); break;
                case 'shuffle': await keyboard.pressKey(Key.R); await keyboard.releaseKey(Key.R); break;
                case 'loop': await keyboard.pressKey(Key.L); await keyboard.releaseKey(Key.L); break;
                case 'stop': await keyboard.pressKey(Key.S); await keyboard.releaseKey(Key.S); break;
                case 'play': await keyboard.pressKey(Key.Space); await keyboard.releaseKey(Key.Space); break;
            }
        }
        console.log(`[Remote] VLC: ${action}${value ? ' (' + value + ')' : ''}`);
    } catch (err) {
        console.error('[Remote] VLC control error:', err.message);
    }
}

// Generate join page HTML (shown when no session code provided)
function generateJoinPageHtml() {
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

// Generate session not found page HTML
function generateSessionNotFoundHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <title>Session Not Found</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Outfit:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root { --bg: #000; --accent: #8a8a8a; --text: #e8e8e8; --text-dim: #9a9a9a; --border: rgba(255,255,255,0.18); --warning: #b08a46; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); font-family: 'Outfit', sans-serif; color: var(--text); }
    .container { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100%; padding: 24px; text-align: center; }
    .icon { font-size: 48px; margin-bottom: 20px; }
    h1 { font: 600 20px 'JetBrains Mono', monospace; color: var(--warning); margin: 0 0 12px 0; }
    p { color: var(--text-dim); margin: 0 0 32px 0; font-size: 14px; line-height: 1.6; max-width: 300px; }
    .btn { padding: 14px 28px; border: 1px solid var(--border); border-radius: 10px; background: transparent; color: var(--text); font: 500 14px 'Outfit', sans-serif; cursor: pointer; text-decoration: none; }
    .btn:active { transform: scale(0.98); }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">🔒</div>
    <h1>Session Not Found</h1>
    <p>This session code is invalid or the event has ended. Please check your code or ask the host for a new link.</p>
    <a href="/" class="btn">Enter Different Code</a>
  </div>
</body>
</html>`;
}

// Parse session code from URL query string
function getSessionCodeFromUrl(urlString) {
    try {
        // Handle URLs that might not have a host
        const url = new URL(urlString, 'http://localhost');
        return url.searchParams.get('s') || null;
    } catch (e) {
        return null;
    }
}

// Create HTTP server to serve mobile app
function createHttpServer() {
    httpServer = http.createServer((req, res) => {
        // Parse URL and query params
        const parsedUrl = new URL(req.url, `http://localhost:${WS_PORT + 1}`);
        const pathname = parsedUrl.pathname;
        const providedCode = parsedUrl.searchParams.get('s');

        // Feedback submission endpoint (same origin as mobile page)
        if (pathname === '/feedback') {
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
                    try { req.destroy(); } catch (_) { }
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

        // Serve mobile app (requires valid session code)
        if (pathname === '/' || pathname === '/index.html') {
            // No session code provided - show join page
            if (!providedCode) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(generateJoinPageHtml());
                return;
            }

            // Wrong session code - show error page
            if (providedCode.toUpperCase() !== sessionCode) {
                res.writeHead(403, { 'Content-Type': 'text/html' });
                res.end(generateSessionNotFoundHtml());
                return;
            }

            // Valid session code - serve mobile app with injected WebSocket URL
            const mobilePath = path.join(__dirname, 'mobile', 'index.html');
            fs.readFile(mobilePath, 'utf8', (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end('Mobile app not found');
                    return;
                }
                // Detect if request is coming through Cloudflare tunnel or locally
                const isCloudflareRequest = req.headers['cf-connecting-ip'] ||
                    req.headers['CF-Connecting-IP'] ||
                    (req.headers.host && req.headers.host.includes('trycloudflare.com'));

                // Inject appropriate WebSocket URL based on request source
                let html = data;
                const localIP = getLocalIP();
                let wsUrlHost = null;
                let forceLocal = false;

                if (isCloudflareRequest && wsTunnel) {
                    // Cloudflare request - use Cloudflare WebSocket tunnel
                    wsUrlHost = wsTunnel.url.replace(/^wss?:\/\//, '').replace(/\/$/, '');
                } else {
                    // Local request - ALWAYS use local WebSocket server (force override)
                    wsUrlHost = `${localIP}:${WS_PORT}`;
                    forceLocal = true;
                }

                if (wsUrlHost) {
                    // Inject as meta tag and inline script that runs immediately
                    const injectMeta = `<meta name="default-ws-url" content="${wsUrlHost}">`;
                    const injectScript = `<script>
                        (function() {
                            const defaultWsUrl = '${wsUrlHost}';
                            const isLocalRequest = ${forceLocal ? 'true' : 'false'};
                            if (defaultWsUrl) {
                                // For local requests, ALWAYS override localStorage to ensure local WebSocket is used
                                if (isLocalRequest) {
                                    localStorage.setItem('livechat_server', defaultWsUrl);
                                    window.__defaultWsUrl = defaultWsUrl;
                                } else {
                                    // For Cloudflare requests, only update if needed
                                    const existing = localStorage.getItem('livechat_server') || '';
                                    const shouldUpdate = !existing || 
                                        existing.includes('10.') || 
                                        existing.includes('192.168.') || 
                                        existing.includes('172.') || 
                                        existing === window.location.hostname + ':8765' ||
                                        existing.includes('localhost');
                                    if (shouldUpdate) {
                                        localStorage.setItem('livechat_server', defaultWsUrl);
                                        window.__defaultWsUrl = defaultWsUrl;
                                    }
                                }
                            }
                        })();
                    </script>`;
                    // Inject in head, before any other scripts
                    html = html.replace('<head>', '<head>' + injectMeta + injectScript);
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html);
            });
        } else if (pathname === '/admin' || pathname === '/admin.html') {
            // Admin page also requires valid session code
            if (!providedCode) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(generateJoinPageHtml());
                return;
            }

            // Wrong session code - show error page
            if (providedCode.toUpperCase() !== sessionCode) {
                res.writeHead(403, { 'Content-Type': 'text/html' });
                res.end(generateSessionNotFoundHtml());
                return;
            }

            const adminPath = path.join(__dirname, 'mobile', 'admin.html');
            fs.readFile(adminPath, 'utf8', (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end('Admin page not found');
                    return;
                }
                // Detect if request is coming through Cloudflare tunnel or locally
                const isCloudflareRequest = req.headers['cf-connecting-ip'] ||
                    req.headers['CF-Connecting-IP'] ||
                    (req.headers.host && req.headers.host.includes('trycloudflare.com'));

                // Inject appropriate WebSocket URL based on request source
                let html = data;
                const localIP = getLocalIP();
                let wsUrlHost = null;
                let forceLocal = false;

                if (isCloudflareRequest && wsTunnel) {
                    // Cloudflare request - use Cloudflare WebSocket tunnel
                    wsUrlHost = wsTunnel.url.replace(/^wss?:\/\//, '').replace(/\/$/, '');
                } else {
                    // Local request - ALWAYS use local WebSocket server (force override)
                    wsUrlHost = `${localIP}:${WS_PORT}`;
                    forceLocal = true;
                }

                if (wsUrlHost) {
                    // Inject as meta tag and inline script that runs immediately
                    const injectMeta = `<meta name="default-ws-url" content="${wsUrlHost}">`;
                    const injectScript = `<script>
                        (function() {
                            const defaultWsUrl = '${wsUrlHost}';
                            const isLocalRequest = ${forceLocal ? 'true' : 'false'};
                            if (defaultWsUrl) {
                                // For local requests, ALWAYS override localStorage to ensure local WebSocket is used
                                if (isLocalRequest) {
                                    localStorage.setItem('livechat_server', defaultWsUrl);
                                    window.__defaultWsUrl = defaultWsUrl;
                                } else {
                                    // For Cloudflare requests, only update if needed
                                    const existing = localStorage.getItem('livechat_server') || '';
                                    const shouldUpdate = !existing || 
                                        existing.includes('10.') || 
                                        existing.includes('192.168.') || 
                                        existing.includes('172.') || 
                                        existing === window.location.hostname + ':8765' ||
                                        existing.includes('localhost');
                                    if (shouldUpdate) {
                                        localStorage.setItem('livechat_server', defaultWsUrl);
                                        window.__defaultWsUrl = defaultWsUrl;
                                    }
                                }
                            }
                        })();
                    </script>`;
                    // Inject in head, before any other scripts
                    html = html.replace('<head>', '<head>' + injectMeta + injectScript);
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html);
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
        // Extract real client IP from Cloudflare headers (for tunnel connections)
        const clientIp = getClientIpFromReq(req);
        console.log('Client connected', clientIp ? `(${clientIp})` : '');
        ws.isAdmin = false;
        ws.clientIp = clientIp;
        ws.sessionValidated = false; // Must validate session code before chatting

        // Timeout for unvalidated connections (10 seconds)
        const validationTimeout = setTimeout(() => {
            if (!ws.sessionValidated && ws.readyState === WebSocket.OPEN) {
                console.log('Client disconnected (validation timeout)', clientIp ? `(${clientIp})` : '');
                try {
                    ws.close(1008, 'Session validation timeout');
                } catch (_) { }
            }
        }, 10000);

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());

                // Session join request - must be validated before other actions
                if (msg.type === 'join') {
                    const providedCode = String(msg.sessionCode || '').toUpperCase().trim();
                    if (providedCode === sessionCode) {
                        ws.sessionValidated = true;
                        ws.send(JSON.stringify({ type: 'join-result', success: true, code: sessionCode }));
                        // Send settings after successful join
                        try {
                            const urls = getUrls();
                            ws.send(JSON.stringify({
                                type: 'settings-sync',
                                settings: { ...currentSettings, ceeApiKeySet: !!ceeApiKey },
                                mobileUrl: urls.mobileUrl,
                                wsUrl: urls.wsUrl
                            }));
                        } catch (e) {
                            // Non-fatal
                        }
                        clearTimeout(validationTimeout); // Clear timeout on successful join
                        console.log('Client joined session', clientIp ? `(${clientIp})` : '');
                    } else {
                        ws.send(JSON.stringify({ type: 'join-result', success: false, error: 'invalid_session' }));
                        // Close the connection after failed join
                        clearTimeout(validationTimeout);
                        setTimeout(() => {
                            try { ws.close(1008, 'Invalid session code'); } catch (_) { }
                        }, 100);
                    }
                    return;
                }

                // Admin authentication (doesn't require session validation - uses password)
                if (msg.type === 'admin-auth') {
                    const success = msg.password === adminPassword;
                    if (success) {
                        ws.isAdmin = true;
                        ws.sessionValidated = true; // Admins are auto-validated
                        adminClients.add(ws);
                        clearTimeout(validationTimeout); // Clear timeout on successful auth
                        console.log('Admin authenticated');
                    }
                    ws.send(JSON.stringify({
                        type: 'admin-auth-result',
                        success,
                        settings: success ? currentSettings : null,
                        blockedIps: success ? Array.from(blockedIps) : null
                    }));
                    // Send current mode state to admin client
                    if (success) {
                        ws.send(JSON.stringify({
                            type: 'mode-state',
                            mode: isPassive ? 'passive' : 'active'
                        }));
                        // Also send remote-enabled status
                        ws.send(JSON.stringify({
                            type: 'remote-enabled-status',
                            enabled: currentSettings.remoteEnabled
                        }));
                    }
                    if (!success) {
                        // Close connection after failed admin auth
                        clearTimeout(validationTimeout);
                        setTimeout(() => {
                            try { ws.close(1008, 'Invalid admin password'); } catch (_) { }
                        }, 100);
                    }
                    return;
                }

                // All other message types require session validation
                if (!ws.sessionValidated) {
                    ws.send(JSON.stringify({ type: 'error', error: 'session_not_validated' }));
                    return;
                }

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
                        } catch (_) { }
                        return;
                    }

                    // Slow mode check (per IP, skip for admins)
                    if (currentSettings.slowModeEnabled && ws.clientIp && !ws.isAdmin) {
                        const nowMs = Date.now();
                        const lastTime = lastMessageTimeByIp.get(ws.clientIp) || 0;
                        const cooldownMs = (currentSettings.slowModeSeconds || 3) * 1000;
                        const remaining = Math.ceil((cooldownMs - (nowMs - lastTime)) / 1000);
                        if (nowMs - lastTime < cooldownMs) {
                            try {
                                ws.send(JSON.stringify({
                                    type: 'slow-mode',
                                    remainingSeconds: remaining,
                                    cooldownSeconds: currentSettings.slowModeSeconds || 3
                                }));
                            } catch (_) { }
                            return;
                        }
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

                    // Add to chat history for @Cee context
                    chatHistory.push({ user: msg.user, text: msg.text, timestamp: now });
                    while (chatHistory.length > MAX_CHAT_HISTORY) {
                        chatHistory.shift();
                    }

                    // Update last message time for slow mode
                    if (ws.clientIp) {
                        lastMessageTimeByIp.set(ws.clientIp, Date.now());
                    }
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

                    // Check for @cee mention and process AI request
                    const ceeMatch = msg.text.match(/@cee\s+(.+)/i);
                    if (ceeMatch) {
                        console.log('[Cee] @cee mention detected in message:', msg.text);
                        console.log('[Cee] enableCeeAgent:', currentSettings.enableCeeAgent);
                        console.log('[Cee] ceeApiKey set:', !!ceeApiKey, 'length:', ceeApiKey?.length || 0);

                        if (!currentSettings.enableCeeAgent) {
                            console.log('[Cee] Agent is disabled, ignoring');
                        } else if (!ceeApiKey) {
                            console.log('[Cee] No API key set, ignoring');
                        } else {
                            const question = ceeMatch[1].trim();
                            if (question) {
                                console.log('[Cee] Processing request with question:', question);
                                processCeeRequest(msg.user, question);
                            } else {
                                console.log('[Cee] Empty question, ignoring');
                            }
                        }
                    }
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
                    if (msg.hideIp !== undefined) currentSettings.hideIp = !!msg.hideIp;
                    if (msg.customEmoji !== undefined) {
                        const next = String(msg.customEmoji || '').trim().slice(0, 8);
                        currentSettings.customEmoji = next || '⭐';
                    }
                    if (msg.emojiDirectSend !== undefined) currentSettings.emojiDirectSend = !!msg.emojiDirectSend;
                    if (msg.slowModeEnabled !== undefined) currentSettings.slowModeEnabled = !!msg.slowModeEnabled;
                    if (msg.slowModeSeconds !== undefined) {
                        const secs = parseInt(msg.slowModeSeconds, 10);
                        if (Number.isFinite(secs) && secs >= 1 && secs <= 60) {
                            currentSettings.slowModeSeconds = secs;
                        }
                    }
                    if (msg.enableFeedbackForm !== undefined) {
                        setFeedbackEnabled(!!msg.enableFeedbackForm, {
                            triggeredByAdminIp: ws.clientIp || null,
                            via: 'mobile-admin'
                        });
                    }
                    // @Cee Agent settings
                    if (msg.enableCeeAgent !== undefined) {
                        currentSettings.enableCeeAgent = !!msg.enableCeeAgent;
                        console.log(`[Cee] Agent ${currentSettings.enableCeeAgent ? 'ENABLED' : 'DISABLED'}`);
                    }
                    if (msg.ceeApiProvider !== undefined) {
                        const provider = String(msg.ceeApiProvider || '').toLowerCase();
                        if (provider === 'openai' || provider === 'gemini') {
                            currentSettings.ceeApiProvider = provider;
                            console.log(`[Cee] API provider set to: ${provider}`);
                        }
                    }
                    if (msg.ceeApiKey !== undefined) {
                        ceeApiKey = String(msg.ceeApiKey || '').trim();
                        console.log(`[Cee] API key ${ceeApiKey ? 'SET (length: ' + ceeApiKey.length + ', prefix: ' + ceeApiKey.substring(0, 7) + ')' : 'CLEARED'}`);
                    }
                    if (msg.ceeSystemPrompt !== undefined) {
                        currentSettings.ceeSystemPrompt = String(msg.ceeSystemPrompt || '').trim().substring(0, 300);
                        console.log(`[Cee] Custom prompt ${currentSettings.ceeSystemPrompt ? 'SET: ' + currentSettings.ceeSystemPrompt.substring(0, 50) : 'CLEARED'}`);
                    }

                    // Send to overlay (include API key status)
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('settings-update', {
                            ...currentSettings,
                            ceeApiKeySet: !!ceeApiKey
                        });
                    }

                    // Broadcast settings to ALL clients (for mobile link display)
                    const urls = getUrls();
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            try {
                                client.send(JSON.stringify({
                                    type: 'settings-sync',
                                    settings: { ...currentSettings, ceeApiKeySet: !!ceeApiKey },
                                    mobileUrl: urls.mobileUrl,
                                    wsUrl: urls.wsUrl
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

                // Admin: toggle passive/active mode
                else if (msg.type === 'admin-toggle-mode' && ws.isAdmin) {
                    toggleMode();
                    // Broadcast mode state to all admin clients
                    broadcastToAdmins({
                        type: 'mode-state',
                        mode: isPassive ? 'passive' : 'active'
                    });
                }

                // --- Remote Control Message Handlers (Admin only) ---

                // Start remote control mode
                else if (msg.type === 'remote-control-start' && ws.isAdmin) {
                    console.log('[Remote] *** Remote control START received ***');
                    setRemoteControlMode(true);
                }

                // End remote control mode
                else if (msg.type === 'remote-control-end' && ws.isAdmin) {
                    setRemoteControlMode(false);
                }

                // Mouse movement (relative delta)
                else if (msg.type === 'remote-mouse-move' && ws.isAdmin) {
                    const dx = parseFloat(msg.deltaX) || 0;
                    const dy = parseFloat(msg.deltaY) || 0;
                    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
                        console.log(`[Remote] Mouse move received: dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)}`);
                    }
                    handleRemoteMouseMove(dx, dy);
                }

                // Mouse click
                else if (msg.type === 'remote-mouse-click' && ws.isAdmin) {
                    handleRemoteMouseClick(msg.button || 'left');
                }

                // Mouse double click
                else if (msg.type === 'remote-mouse-dblclick' && ws.isAdmin) {
                    handleRemoteMouseDoubleClick(msg.button || 'left');
                }

                // Mouse button down (drag start)
                else if (msg.type === 'remote-mouse-down' && ws.isAdmin) {
                    handleRemoteMouseDown(msg.button || 'left');
                }

                // Mouse button up (drag end)
                else if (msg.type === 'remote-mouse-up' && ws.isAdmin) {
                    handleRemoteMouseUp(msg.button || 'left');
                }

                // Scroll
                else if (msg.type === 'remote-scroll' && ws.isAdmin) {
                    const dx = parseFloat(msg.deltaX) || 0;
                    const dy = parseFloat(msg.deltaY) || 0;
                    handleRemoteScroll(dx, dy);
                }

                // Keyboard text input
                else if (msg.type === 'remote-keyboard-type' && ws.isAdmin) {
                    if (msg.text) {
                        handleRemoteKeyboardType(msg.text);
                    }
                }

                // Keyboard special key
                else if (msg.type === 'remote-keyboard-key' && ws.isAdmin) {
                    if (msg.key) {
                        handleRemoteKeyboardKey(msg.key, msg.modifiers || []);
                    }
                }

                // Volume control
                else if (msg.type === 'remote-volume' && ws.isAdmin) {
                    if (msg.action) {
                        handleRemoteVolume(msg.action);
                    }
                }

                // Media control
                else if (msg.type === 'remote-media' && ws.isAdmin) {
                    if (msg.action) {
                        handleRemoteMedia(msg.action);
                    }
                }

                // VLC control
                else if (msg.type === 'remote-vlc' && ws.isAdmin) {
                    if (msg.action) {
                        handleRemoteVlc(msg.action, msg.value);
                    }
                }
            } catch (e) {
                console.error('Invalid message:', e);
            }
        });

        ws.on('close', () => {
            clearTimeout(validationTimeout);
            const wasAdmin = adminClients.has(ws);
            adminClients.delete(ws);
            // Only log disconnections for validated clients to reduce noise
            if (ws.sessionValidated) {
                console.log('Client disconnected', clientIp ? `(${clientIp})` : '');
            }
            // If this was an admin and remote control was active, restore normal window state
            // This prevents the window from being stuck in passthrough mode
            if (wasAdmin && remoteControlActive) {
                console.log('[Remote] Admin disconnected while remote control active - restoring window');
                setRemoteControlMode(false);
            }
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

// Get URLs based on hideIp setting
function getUrls() {
    const localIP = getLocalIP();
    const useCloudflare = currentSettings.hideIp && httpTunnel && wsTunnel;

    return {
        mobileUrl: useCloudflare ? `${httpTunnel.url}?s=${sessionCode}` : `http://${localIP}:${WS_PORT + 1}?s=${sessionCode}`,
        adminUrl: useCloudflare ? `${httpTunnel.url}/admin?s=${sessionCode}` : `http://${localIP}:${WS_PORT + 1}/admin?s=${sessionCode}`,
        wsUrl: useCloudflare ? wsTunnel.url : `ws://${localIP}:${WS_PORT}`
    };
}

// Start Cloudflare quick tunnel process and parse URL from output
function startCloudflareTunnel(port, tunnelType) {
    return new Promise((resolve, reject) => {
        const process = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let output = '';
        let errorOutput = '';
        let resolved = false;
        let timeoutId = null;

        const checkForUrl = (text) => {
            // Look for URL in output: "https://random-subdomain.trycloudflare.com"
            const urlMatch = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
            if (urlMatch && urlMatch.length > 0 && !resolved) {
                resolved = true;
                const url = urlMatch[0];
                console.log(`Cloudflare ${tunnelType} tunnel: ${url}`);
                if (timeoutId) clearTimeout(timeoutId);
                resolve({ process, url });
            }
        };

        process.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;
            checkForUrl(text);
        });

        process.stderr.on('data', (data) => {
            const text = data.toString();
            errorOutput += text;
            // Cloudflare often outputs the URL to stderr
            checkForUrl(text);
        });

        process.on('error', (err) => {
            if (resolved) return;
            if (timeoutId) clearTimeout(timeoutId);
            if (err.code === 'ENOENT') {
                reject(new Error('cloudflared not found. Please install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/'));
            } else {
                reject(err);
            }
        });

        process.on('exit', (code) => {
            if (resolved) return;
            if (timeoutId) clearTimeout(timeoutId);
            if (code !== 0 && code !== null) {
                reject(new Error(`cloudflared exited with code ${code}: ${errorOutput || output}`));
            }
        });

        // Timeout after 15 seconds if no URL found
        timeoutId = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                process.kill();
                reject(new Error(`Timeout waiting for ${tunnelType} tunnel URL`));
            }
        }, 15000);
    });
}

// Broadcast tunnel URLs to all connected clients
function broadcastTunnelUrls() {
    if (!wss) return;
    const urls = getUrls();

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.sessionValidated) {
            try {
                client.send(JSON.stringify({
                    type: 'settings-sync',
                    settings: { ...currentSettings, ceeApiKeySet: !!ceeApiKey },
                    mobileUrl: urls.mobileUrl,
                    wsUrl: urls.wsUrl
                }));
            } catch (err) {
                console.error('Error broadcasting tunnel URLs to client:', err);
            }
        }
    });
}

// Create secure tunnels for internet access using Cloudflare quick tunnels
async function createTunnels() {
    try {
        // Create WebSocket tunnel FIRST (needed for HTTP tunnel pages)
        try {
            const wsResult = await startCloudflareTunnel(WS_PORT, 'WebSocket');
            wsTunnelProcess = wsResult.process;
            wsTunnel = { url: wsResult.url.replace('https://', 'wss://') };
            console.log(`Cloudflare WebSocket: ${wsTunnel.url}`);
        } catch (err) {
            console.error('Failed to create WebSocket tunnel:', err.message);
            wsTunnel = null;
        }

        // Create tunnel for HTTP server (mobile/admin pages) AFTER WebSocket tunnel
        try {
            const httpResult = await startCloudflareTunnel(WS_PORT + 1, 'HTTP');
            httpTunnelProcess = httpResult.process;
            httpTunnel = { url: httpResult.url };
            console.log(`Cloudflare Mobile URL: ${httpTunnel.url}?s=${sessionCode}`);
            console.log(`Cloudflare Admin URL: ${httpTunnel.url}/admin?s=${sessionCode}`);
        } catch (err) {
            console.error('Failed to create HTTP tunnel:', err.message);
            httpTunnel = null;
        }

        if (!httpTunnel && !wsTunnel) {
            console.log('Falling back to local network only');
        } else {
            // Broadcast updated tunnel URLs to all connected clients
            broadcastTunnelUrls();
        }
    } catch (err) {
        console.error('Failed to create tunnels:', err.message);
        console.log('Falling back to local network only');
    }
}

app.whenReady().then(async () => {
    // Register hotkeys before window creation (important for Linux)
    globalShortcut.register('CommandOrControl+Alt+K', toggleMode);

    // Start per-session chat logging
    initChatLogging();

    setTimeout(createWindow, 300);

    // Start servers
    createWebSocketServer();
    createHttpServer();

    // Create secure tunnels for internet access
    await createTunnels();

    const localIP = getLocalIP();
    console.log('Overlay started. Press Ctrl+Alt+K to toggle mode.');
    console.log(`Session Code: ${sessionCode}`);
    console.log(`Admin Password: ${adminPassword}`);
    if (httpTunnel && wsTunnel) {
        console.log('--- Cloudflare Tunnel URLs (Primary) ---');
        console.log(`Mobile app: ${httpTunnel.url}?s=${sessionCode}`);
        console.log(`Admin page: ${httpTunnel.url}/admin?s=${sessionCode}`);
        console.log(`WebSocket: ${wsTunnel.url}`);
    }
    console.log('--- Local Network URLs (Fallback) ---');
    console.log(`Mobile app: http://${localIP}:${WS_PORT + 1}?s=${sessionCode}`);
    console.log(`Admin page: http://${localIP}:${WS_PORT + 1}/admin?s=${sessionCode}`);
    console.log(`WebSocket: ws://${localIP}:${WS_PORT}`);
});

// IPC handlers
ipcMain.on('close-app', () => app.quit());

// Enable remote control from overlay settings
ipcMain.on('enable-remote-control', () => {
    console.log('[Remote] Remote control enabled by user');
    currentSettings.remoteEnabled = true;

    // On Linux, check permissions and show setup dialog if needed
    if (isLinux) {
        detectDotool();
        const permStatus = checkDotoolPermission();
        if (permStatus === 'need-setup') {
            showDotoolPermissionDialog();
        } else if (permStatus === 'need-relogin') {
            showReloginDialog();
        }
    }

    // Broadcast to all clients
    broadcastRemoteEnabledStatus();

    // Update overlay UI
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('settings-update', { remoteEnabled: true });
    }
});

// Disable remote control from overlay settings
ipcMain.on('disable-remote-control', () => {
    console.log('[Remote] Remote control disabled by user');
    currentSettings.remoteEnabled = false;

    // Stop dotoold daemon if running
    if (isLinux) {
        stopDotoold();
    }

    // Broadcast to all clients
    broadcastRemoteEnabledStatus();

    // Update overlay UI
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('settings-update', { remoteEnabled: false });
    }
});

// Broadcast remote-enabled status to all WebSocket clients
function broadcastRemoteEnabledStatus() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify({
                    type: 'remote-enabled-status',
                    enabled: currentSettings.remoteEnabled
                }));
            } catch (err) {
                console.error('Error broadcasting remote status:', err);
            }
        }
    });
}

ipcMain.on('enter-passive', () => {
    if (!isPassive) toggleMode();
});
ipcMain.on('request-focus', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !isPassive) {
        mainWindow.focus();
    }
});

// Screen capture IPC handlers
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

ipcMain.on('screenshot-result', (event, screenshot) => {
    if (pendingScreenshotResolve) {
        pendingScreenshotResolve(screenshot);
        pendingScreenshotResolve = null;
    }
});

ipcMain.handle('get-session-info', () => {
    const localIP = getLocalIP();
    const urls = getUrls();

    const info = {
        code: sessionCode,
        adminPassword: adminPassword,
        wsUrl: urls.wsUrl,
        mobileUrl: urls.mobileUrl,
        adminUrl: urls.adminUrl
    };

    // Keep local URLs as fallback
    info.localWsUrl = `ws://${localIP}:${WS_PORT}`;
    info.localMobileUrl = `http://${localIP}:${WS_PORT + 1}?s=${sessionCode}`;
    info.localAdminUrl = `http://${localIP}:${WS_PORT + 1}/admin?s=${sessionCode}`;

    return info;
});

// Handle settings changes from overlay UI
ipcMain.on('settings-changed', (_, settings) => {
    if (settings.maxMessages !== undefined) currentSettings.maxMessages = settings.maxMessages;
    if (settings.fontSize !== undefined) currentSettings.fontSize = settings.fontSize;
    if (settings.showJoinCode !== undefined) currentSettings.showJoinCode = settings.showJoinCode;
    if (settings.showMobileLink !== undefined) currentSettings.showMobileLink = settings.showMobileLink;
    if (settings.disableChatHistory !== undefined) currentSettings.disableChatHistory = settings.disableChatHistory;
    if (settings.hideIp !== undefined) currentSettings.hideIp = !!settings.hideIp;
    if (settings.customEmoji !== undefined) {
        const next = String(settings.customEmoji || '').trim().slice(0, 8);
        currentSettings.customEmoji = next || '⭐';
    }
    if (settings.emojiDirectSend !== undefined) currentSettings.emojiDirectSend = !!settings.emojiDirectSend;
    if (settings.slowModeEnabled !== undefined) currentSettings.slowModeEnabled = !!settings.slowModeEnabled;
    if (settings.slowModeSeconds !== undefined) {
        const secs = parseInt(settings.slowModeSeconds, 10);
        if (Number.isFinite(secs) && secs >= 1 && secs <= 60) {
            currentSettings.slowModeSeconds = secs;
        }
    }
    if (settings.enableFeedbackForm !== undefined) {
        setFeedbackEnabled(!!settings.enableFeedbackForm, {
            via: 'overlay-settings'
        });
    }
    // @Cee Agent settings
    if (settings.enableCeeAgent !== undefined) {
        currentSettings.enableCeeAgent = !!settings.enableCeeAgent;
        console.log(`[Cee] Agent ${currentSettings.enableCeeAgent ? 'ENABLED' : 'DISABLED'} (via IPC)`);
    }
    if (settings.ceeApiProvider !== undefined) {
        const provider = String(settings.ceeApiProvider || '').toLowerCase();
        if (provider === 'openai' || provider === 'gemini') {
            currentSettings.ceeApiProvider = provider;
            console.log(`[Cee] API provider set to: ${provider} (via IPC)`);
        }
    }
    if (settings.ceeApiKey !== undefined) {
        ceeApiKey = String(settings.ceeApiKey || '').trim();
        console.log(`[Cee] API key ${ceeApiKey ? 'SET (length: ' + ceeApiKey.length + ', prefix: ' + ceeApiKey.substring(0, 7) + ')' : 'CLEARED'} (via IPC)`);
    }
    if (settings.ceeSystemPrompt !== undefined) {
        currentSettings.ceeSystemPrompt = String(settings.ceeSystemPrompt || '').trim().substring(0, 300);
        console.log(`[Cee] Custom prompt ${currentSettings.ceeSystemPrompt ? 'SET: ' + currentSettings.ceeSystemPrompt.substring(0, 50) : 'CLEARED'} (via IPC)`);
    }

    // Send API key status back to overlay
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('settings-update', {
            ...currentSettings,
            ceeApiKeySet: !!ceeApiKey
        });
    }

    // Broadcast settings to ALL clients
    const urls = getUrls();
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify({
                    type: 'settings-sync',
                    settings: { ...currentSettings, ceeApiKeySet: !!ceeApiKey },
                    mobileUrl: urls.mobileUrl,
                    wsUrl: urls.wsUrl
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

    // Stop dotoold daemon if we started it
    stopDotoold();

    // Unregister shortcuts
    globalShortcut.unregisterAll();

    // Close all WebSocket connections first
    if (wss) {
        wss.clients.forEach(client => {
            try {
                client.terminate();
            } catch (e) { }
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

    // Close Cloudflare tunnels
    if (httpTunnelProcess) {
        try {
            httpTunnelProcess.kill();
        } catch (e) {
            console.error('Error killing HTTP tunnel process:', e);
        }
        httpTunnelProcess = null;
    }
    if (wsTunnelProcess) {
        try {
            wsTunnelProcess.kill();
        } catch (e) {
            console.error('Error killing WebSocket tunnel process:', e);
        }
        wsTunnelProcess = null;
    }
    httpTunnel = null;
    wsTunnel = null;

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
