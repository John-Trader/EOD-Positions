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
// One snapshot is resolved before the window opens; the sync preload read and
// the renderer's async load both serve it, so they can never disagree.
let settingsPath = SETTINGS_FILE_PRIMARY;
let settingsSnapshot = {};
let settingsWritable = true;
let settingsLoadError = null;

// status: 'missing' | 'valid' | 'malformed' | 'error'
function inspectSettingsFile(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { return { status: e && e.code === 'ENOENT' ? 'missing' : 'error', error: (e && e.message) || String(e) }; }
    let obj;
    try { obj = JSON.parse(raw); }
    catch (e) { return { status: 'malformed', error: (e && e.message) || String(e) }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { status: 'malformed', error: 'settings file is not a JSON object' };
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch (_) {}
    return { status: 'valid', data: obj, mtime };
}

function settingsLocation(file) { return file === SETTINGS_FILE_PRIMARY && SETTINGS_FILE_PRIMARY !== SETTINGS_FILE_FALLBACK ? 'portable' : 'userData'; }

// Resolve which file this session reads/writes BEFORE the renderer exists.
// A valid fallback (written when the portable dir was unwritable) must be
// rediscovered here — previously the app restarted on the primary path and the
// userData save was invisible until another write failed.
async function initializeSettingsFile() {
    const primary = inspectSettingsFile(SETTINGS_FILE_PRIMARY);
    const fallback = SETTINGS_FILE_FALLBACK !== SETTINGS_FILE_PRIMARY
        ? inspectSettingsFile(SETTINGS_FILE_FALLBACK) : { status: 'missing' };
    const pick = (insp, file) => { settingsPath = file; settingsSnapshot = insp.data; };

    if (primary.status === 'valid' && fallback.status === 'valid') {
        const same = JSON.stringify(primary.data) === JSON.stringify(fallback.data);
        if (same || fallback.mtime <= primary.mtime) return pick(primary, SETTINGS_FILE_PRIMARY);
        // Fallback is newer — the last session was probably redirected to
        // userData. Ask rather than silently discarding either file.
        const fmt = (t) => new Date(t).toLocaleString();
        const r = await dialog.showMessageBox({
            type: 'question',
            title: 'Position Size Calculator',
            message: 'Two different settings files were found.',
            detail: `Portable: ${SETTINGS_FILE_PRIMARY}\nsaved ${fmt(primary.mtime)}\n\nRecovered: ${SETTINGS_FILE_FALLBACK}\nsaved ${fmt(fallback.mtime)}\n\nThe recovered copy is newer — the previous save may have been redirected because the portable folder was not writable.`,
            buttons: ['Use recovered copy', 'Use portable copy', 'Continue without saving'],
            defaultId: 0, cancelId: 2, noLink: true,
        });
        if (r.response === 0) pick(fallback, SETTINGS_FILE_FALLBACK);
        else if (r.response === 1) pick(primary, SETTINGS_FILE_PRIMARY);
        else settingsWritable = false;
        return;
    }
    if (primary.status === 'valid') return pick(primary, SETTINGS_FILE_PRIMARY);
    if (fallback.status === 'valid') return pick(fallback, SETTINGS_FILE_FALLBACK);

    const bad = [primary, fallback].find(x => x.status === 'malformed' || x.status === 'error');
    if (bad) {
        const file = primary.status !== 'missing' ? SETTINGS_FILE_PRIMARY : SETTINGS_FILE_FALLBACK;
        settingsLoadError = `settings file unreadable: ${file} (${bad.error || 'unknown'})`;
        console.error('[electron]', settingsLoadError);
        const r = await dialog.showMessageBox({
            type: 'warning',
            title: 'Position Size Calculator',
            message: 'The settings file is damaged — it will NOT be overwritten.',
            detail: `${file}\n${bad.error || ''}\n\nMove it aside to start fresh, or continue this session without saving.`,
            buttons: ['Move aside & start fresh', 'Continue without saving', 'Quit'],
            defaultId: 1, cancelId: 2, noLink: true,
        });
        if (r.response === 2) { app.quit(); return false; }
        if (r.response === 0) {
            try { fs.renameSync(file, file + '.corrupt-' + Date.now() + '.json'); }
            catch (e) {
                settingsWritable = false;
                dialog.showErrorBox('Position Size Calculator', `Could not move the damaged file aside.\n${e && e.message}`);
            }
        } else {
            settingsWritable = false;
        }
        return;
    }
    // Both missing: fresh install at the primary path.
}

function writeSettingsFile(obj) {
    if (!settingsWritable) return { ok: false, error: 'settings writes disabled for this session' };
    let data;
    try { data = JSON.stringify(obj, null, 2); }
    catch (_) { return { ok: false, error: 'unserializable settings' }; }
    // Atomic write: temp file + rename, so a crash never leaves a half file.
    const attempt = (file) => {
        const tmp = file + '.tmp';
        try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); return null; }
        catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (_) {} return e; }
    };
    let err = attempt(settingsPath);
    if (err && settingsPath !== SETTINGS_FILE_FALLBACK && ['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR'].includes(err && err.code)) {
        // Location/permission failure — redirect this and future writes.
        try { fs.mkdirSync(USER_DATA, { recursive: true }); } catch (_) {}
        if (!attempt(SETTINGS_FILE_FALLBACK)) { settingsPath = SETTINGS_FILE_FALLBACK; err = null; }
    }
    if (err) {
        console.error('[electron] settings write failed:', err && err.message);
        return { ok: false, error: (err && err.message) || 'write failed' };
    }
    settingsSnapshot = obj;
    return { ok: true, location: settingsLocation(settingsPath) };
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
let bridgeToken = '';
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    });
}

// ---------- settings IPC ----------
// Only the app view may read/write settings — the dock strip gets pscTerm only.
const isAppSender = (wc) => !!(appView && wc === appView.webContents);
const isDockSender = (wc) => !!(chromeView && wc === chromeView.webContents);

ipcMain.on('psc:settings-load', (e) => { e.returnValue = isAppSender(e.sender) ? settingsSnapshot : {}; });
ipcMain.handle('psc:load-settings-async', (e) => isAppSender(e.sender) ? settingsSnapshot : {});
ipcMain.handle('psc:settings-status', (e) => isAppSender(e.sender)
    ? { writable: settingsWritable, location: settingsLocation(settingsPath), error: settingsLoadError }
    : { writable: false, location: null, error: 'unauthorized' });
ipcMain.handle('psc:settings-save', (e, obj) => {
    if (!isAppSender(e.sender)) return { ok: false, error: 'unauthorized' };
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'invalid payload' };
    let size;
    try { size = JSON.stringify(obj).length; } catch (_) { return { ok: false, error: 'unserializable' }; }
    if (size > 5 * 1024 * 1024) return { ok: false, error: 'too large' };
    return writeSettingsFile(obj);
});

// ---------- window ----------
// The window hosts two WebContentsViews side by side: a narrow dock strip
// (chrome.html — app-independent Electron UI) and the app itself served by the
// bridge. The dock's >_ button slides out a live bridge-log terminal.
const DOCK_W = 46;
const TERM_MIN = 160;
const TERM_DEFAULT = 420;
const APP_MIN_W = 300;
const STATE_FILE = path.join(USER_DATA, 'psc-window-state.json');
let termOpen = false;
let termW = TERM_DEFAULT;
let appView = null;
let chromeView = null;

function loadWindowState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (typeof s.termW === 'number') termW = s.termW;
    } catch (_) {}
}
let _stateSaveTimer = null;
function saveWindowState() {
    if (_stateSaveTimer) clearTimeout(_stateSaveTimer);
    _stateSaveTimer = setTimeout(() => {
        _stateSaveTimer = null;
        try { fs.writeFileSync(STATE_FILE, JSON.stringify({ termW })); } catch (_) {}
    }, 400);
}

function termMax() {
    if (!win) return TERM_DEFAULT;
    const [w] = win.getContentSize();
    return Math.max(TERM_MIN, w - DOCK_W - APP_MIN_W);
}

function layoutViews() {
    if (!win || !appView || !chromeView) return;
    const [w, h] = win.getContentSize();
    const dockW = DOCK_W + (termOpen ? Math.min(termW, termMax()) : 0);
    chromeView.setBounds({ x: 0, y: 0, width: dockW, height: h });
    appView.setBounds({ x: dockW, y: 0, width: Math.max(0, w - dockW), height: h });
}

ipcMain.handle('psc:term-toggle', (e) => {
    if (!isDockSender(e.sender)) return termOpen;
    termOpen = !termOpen; layoutViews(); return termOpen;
});
// The token line is pinned at the top of the terminal so it never rotates out
// of the ring buffer — the user compares it with Settings → Bridge token → SHOW.
ipcMain.handle('psc:term-buffer', (e) => isDockSender(e.sender)
    ? `[electron] bridge token: ${bridgeToken || '(starting…)'}\n` + logBuffer.join('\n')
    : '');
ipcMain.on('psc:term-resize', (e, w) => {
    if (!isDockSender(e.sender)) return;
    const n = Math.round(Number(w));
    if (!Number.isFinite(n)) return;
    termW = Math.max(TERM_MIN, Math.min(n, termMax()));
    layoutViews();
    saveWindowState();
});

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
    loadWindowState();
    if (await initializeSettingsFile() === false) return; // user chose Quit during recovery
    const token = loadOrCreateToken();
    bridgeToken = token;
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
