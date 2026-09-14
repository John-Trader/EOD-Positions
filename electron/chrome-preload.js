// Preload for the Electron dock strip (chrome.html) — exposes only the bridge-log
// toggle/buffer surface. Separate from preload.js: the app page keeps pscBridge,
// the dock gets pscTerm. contextIsolation + sandbox stay on.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pscTerm', {
    toggle: () => ipcRenderer.invoke('psc:term-toggle'),
    getBuffer: () => ipcRenderer.invoke('psc:term-buffer'),
    onLog: (cb) => ipcRenderer.on('psc:log-line', (_e, line) => cb(line)),
});
