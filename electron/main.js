// Electron main process — runs the TWS bridge in-process and opens the app in
// its own window. The bridge serves the UI on loopback and injects its token
// into the page, so first run is zero-config.
'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
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
function createWindow(port) {
    const iconPath = path.join(APP_DIR, 'build', 'icon.png');
    win = new BrowserWindow({
        width: 1180,
        height: 900,
        minWidth: 700,
        minHeight: 500,
        autoHideMenuBar: true,
        backgroundColor: '#0f172a',
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith(`http://127.0.0.1:${port}`)) {
            e.preventDefault();
            shell.openExternal(url);
        }
    });
    win.loadURL(`http://127.0.0.1:${port}/`);
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

    bridge = require('../tws-bridge/server.js');
    const { port } = await bridge.start({ port: 8787, webRoot: APP_DIR });
    console.log(`[electron] bridge on 127.0.0.1:${port}`);
    createWindow(port);
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (e) => {
    if (quitting || !bridge) return;
    quitting = true;
    e.preventDefault();
    bridge.stop().finally(() => app.quit());
});
