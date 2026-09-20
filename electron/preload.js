// Preload — runs before page scripts. Seeds the portable settings file's
// scalar keys into localStorage synchronously so the app's top-level init
// reads them natively; then exposes the settings-file IPC surface.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Whitelist only: the settings file is user-editable, so arbitrary keys (and
// the machine-local bridge url/token) must not leak into storage. Everything
// else is applied post-load by the page's hydration via loadSettings().
const SEED_KEYS = new Set([
    'riskValue', 'slippageValue', 'selectedProvider', 'enhancedSecondaryProvider',
    'providerPriorityOrder', 'collapseAfterCalc', 'preferredViewMode',
    'liveUpdateEnabled', 'enhancedLiveMode', 'setting_showFocus',
    'setting_showVoice', 'setting_showAlerts', 'riskMode', 'accountValue',
    'maxHoldDays', 'timedExitEnabled', 'timedExitTime', 'showRangePct',
    'earningsWarnEnabled', 'stopVolWarnEnabled', 'liqWarnEnabled', 'liqVolPct',
    'liqVolPeriod', 'twsEnabled', 'autoSendExitsOnOpen', 'twsQuotesEnabled',
    'twsSyncAccount', 'twsPositionsEnabled', 'twsOrdersEnabled',
    'twsFillsJournalEnabled', 'twsPnlEnabled', 'signalSyncMode', 'pbEtfUniverse',
    'qldTargetPct', 'qldBandPct', 'twsExitStrategy', 'twsEntryOutsideRth',
    'globalMarketRegime', 'settingsSectionsCollapsed',
]);
const API_KEY_SLOTS = new Set(['finnhub_key', 'twelvedata_key', 'stockdata_key', 'tiingo_key']);
try {
    const settings = ipcRenderer.sendSync('psc:settings-load') || {};
    for (const k of SEED_KEYS) {
        const v = settings[k];
        if (typeof v === 'string') { try { localStorage.setItem(k, v); } catch (_) {} }
    }
    // API keys live under apiKeys — seed the known provider slots only.
    if (settings.apiKeys && typeof settings.apiKeys === 'object') {
        for (const k of API_KEY_SLOTS) {
            const v = settings.apiKeys[k];
            if (typeof v === 'string' && v) { try { localStorage.setItem(k, v); } catch (_) {} }
            else if (v === null) { try { localStorage.removeItem(k); } catch (_) {} }
        }
    }
} catch (_) {}

contextBridge.exposeInMainWorld('pscBridge', {
    loadSettings: () => ipcRenderer.invoke('psc:load-settings-async'),
    saveSettings: (obj) => ipcRenderer.invoke('psc:settings-save', obj),
    settingsStatus: () => ipcRenderer.invoke('psc:settings-status'),
});
