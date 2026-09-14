// Electron main process — runs the TWS bridge in-process and opens the app in
// its own window. The bridge serves the UI on loopback and injects its token
// into the page, so first run is zero-config.
'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- paths ----------
const APP_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar')
    : path.join(__dirname, '..');
const USER_DATA = app.getPath('userData');
// Portable target sets PORTABLE_EXECUTABLE_DIR to the folder containing the exe.
const SETTINGS_FILE_PRIMARY = path.join(process.env.PORTABLE_EXECUTABLE_DIR || USER_DATA, 'psc-settings.json');
const SETTINGS_FILE_FALLBACK = path.join(USER_DATA, 'psc-settings.json');
let settingsPath = SETTINGS_FILE_PRIMARY;

// ---------- bridge token (persisted per machine) ----------
function loadOrCreateToken() {
    const f = path.join(USER_DATA, 'bridge-token');
    try {
        const t = fs.readFileSync(f, 'utf8').trim();
        if (t) return t;
    } catch (_) {}
    const t = crypto.randomBytes(24).toString('hex');
    try { fs.writeFileSync(f, t, { mode: 0o600 }); } catch (_) {}
    return t;
}

// ---------- settings file ----------
function readSettingsFile() {
    try {
        const obj = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch (_) {
        return {};
    }
}

function writeSettingsFile(obj) {
    const tmp = settingsPath + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
        fs.renameSync(tmp, settingsPath);
    } catch (e) {
        if (settingsPath !== SETTINGS_FILE_FALLBACK) {
            settingsPath = SETTINGS_FILE_FALLBACK;
            writeSettingsFile(obj);
        } else {
            console.error('[electron] settings write failed:', e && e.message);
        }
    }
}

// ---------- bridge log tee ----------
// Mirror every console.* line from the main process (bridge + electron) into a
// ring buffer and push to the dock panel when it's live.
const LOG_MAX = 2000;
const logBuffer = [];
let logSink = null;
for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
        orig(...args);
        const line = args.map(a => typeof a === 'string' ? a : (a instanceof Error ? (a.stack || a.message) : JSON.stringify(a))).join(' ');
        logBuffer.push(line);
        if (logBuffer.length > LOG_MAX) logBuffer.shift();
        if (logSink) { try { logSink.send('psc:log-line', line); } catch (_) {} }
    };
}

// ---------- single instance ----------
let win = null;
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    });
}

// ---------- settings IPC ----------
ipcMain.on('psc:settings-load', (e) => { e.returnValue = readSettingsFile(); });
ipcMain.handle('psc:load-settings-async', () => readSettingsFile());
ipcMain.handle('psc:settings-save', (e, obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false };
    if (JSON.stringify(obj).length > 5 * 1024 * 1024) return { ok: false, error: 'too large' };
    writeSettingsFile(obj);
    return { ok: true };
});

// ---------- window ----------
// The window hosts two WebContentsViews side by side: a narrow dock strip
// (chrome.html — app-independent Electron UI) and the app itself served by the
// bridge. The dock's >_ button slides out a live bridge-log terminal.
const DOCK_W = 46;
const TERM_W = 420;
let termOpen = false;
let appView = null;
let chromeView = null;

function layoutViews() {
    if (!win || !appView || !chromeView) return;
    const [w, h] = win.getContentSize();
    const dockW = DOCK_W + (termOpen ? TERM_W : 0);
    chromeView.setBounds({ x: 0, y: 0, width: dockW, height: h });
    appView.setBounds({ x: dockW, y: 0, width: Math.max(0, w - dockW), height: h });
}

ipcMain.handle('psc:term-toggle', () => { termOpen = !termOpen; layoutViews(); return termOpen; });
ipcMain.handle('psc:term-buffer', () => logBuffer.join('\n'));

function createWindow(port) {
    const iconPath = path.join(APP_DIR, 'build', 'icon.png');
    win = new BrowserWindow({
        width: 1180,
        height: 900,
        minWidth: 700,
        minHeight: 500,
        autoHideMenuBar: true,
        backgroundColor: '#0b1220',
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
    });
    appView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    chromeView = new WebContentsView({
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, 'chrome-preload.js'),
        },
    });
    win.contentView.addChildView(appView);
    win.contentView.addChildView(chromeView);

    const bridgeOrigin = `http://127.0.0.1:${port}`;
    const isBridgeUrl = (u) => { try { return new URL(u).origin === bridgeOrigin; } catch (_) { return false; } };
    const openExternalSafe = (u) => {
        try {
            const proto = new URL(u).protocol;
            if (proto === 'https:' || proto === 'http:' || proto === 'mailto:') shell.openExternal(u);
        } catch (_) {}
    };
    appView.webContents.setWindowOpenHandler(({ url }) => {
        openExternalSafe(url);
        return { action: 'deny' };
    });
    appView.webContents.on('will-navigate', (e, url) => {
        if (!isBridgeUrl(url)) {
            e.preventDefault();
            openExternalSafe(url);
        }
    });
    // The window no longer loads a document itself — mirror the app title.
    appView.webContents.on('page-title-updated', (e, title) => { if (title) win.setTitle(title); });

    chromeView.webContents.on('did-finish-load', () => { logSink = chromeView.webContents; });
    chromeView.webContents.loadFile(path.join(__dirname, 'chrome.html'));
    appView.webContents.loadURL(`http://127.0.0.1:${port}/`);

    layoutViews();
    win.on('resize', layoutViews);
}

// ---------- boot ----------
let bridge = null;
let quitting = false;

app.whenReady().then(async () => {
    const token = loadOrCreateToken();
    process.env.BRIDGE_TOKEN = token;
    process.env.PSC_TOKEN_FILE = path.join(USER_DATA, 'bridge-token');
    process.env.PSC_WEB_ROOT = APP_DIR;
    // Distinct from the standalone bridge (default 7) so both can coexist.
    if (!process.env.IBKR_CLIENT_ID) process.env.IBKR_CLIENT_ID = '8';

    try {
        bridge = require('../tws-bridge/server.js');
        const { port } = await bridge.start({ port: 8787, webRoot: APP_DIR });
        console.log(`[electron] bridge on 127.0.0.1:${port}`);
        createWindow(port);
    } catch (e) {
        console.error('[electron] bridge failed to start:', e);
        dialog.showErrorBox('Position Size Calculator', `Failed to start the local bridge.\n${e && e.message}`);
        app.quit();
    }
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (e) => {
    if (quitting || !bridge) return;
    quitting = true;
    e.preventDefault();
    bridge.stop().finally(() => app.quit());
});
