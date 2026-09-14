// Preload — runs before page scripts. Seeds the portable settings file's
// scalar keys into localStorage synchronously so the app's top-level init
// reads them natively; then exposes the settings-file IPC surface.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

try {
    const settings = ipcRenderer.sendSync('psc:settings-load') || {};
    for (const [k, v] of Object.entries(settings)) {
        if (typeof v === 'string') { try { localStorage.setItem(k, v); } catch (_) {} }
    }
    // API keys live under apiKeys — seed those too.
    if (settings.apiKeys && typeof settings.apiKeys === 'object') {
        for (const [k, v] of Object.entries(settings.apiKeys)) {
            if (typeof v === 'string' && /^[a-z0-9_]+_key$/.test(k)) {
                try { localStorage.setItem(k, v); } catch (_) {}
            }
        }
    }
} catch (_) {}

contextBridge.exposeInMainWorld('pscBridge', {
    loadSettings: () => ipcRenderer.invoke('psc:load-settings-async'),
    saveSettings: (obj) => ipcRenderer.invoke('psc:settings-save', obj),
});
