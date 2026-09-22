// Preload — runs before page scripts. Exposes the state-file IPC surface only;
// hydration itself happens in the page's StateStore.init via bootState(), which
// returns the full decoded snapshot synchronously so the app's top-level init
// already sees file values. No localStorage seeding — one state record, one read.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pscBridge', {
    // { installId, state|null, writable, location, error } — resolved in main
    // before the window was created, so this read is consistent for the session.
    bootState: () => ipcRenderer.sendSync('psc:boot-state'),
    // { installId, state } — validated + written atomically in the main process.
    saveState: (payload) => ipcRenderer.invoke('psc:state-save', payload),
    // Synchronous variant for pagehide teardown where a promise can't be awaited.
    saveStateSync: (payload) => ipcRenderer.sendSync('psc:state-save-sync', payload),
    stateStatus: () => ipcRenderer.invoke('psc:state-status'),
    // { ok } — prints a self-contained HTML document via a hidden window
    // (window.open is denied on the app view, so reports print through here).
    printHtml: (html) => ipcRenderer.invoke('psc:print-html', html),
});
