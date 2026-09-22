// state-schema.js — schema v1: the single clean state format for Position Size
// Calculator. Pure module: no DOM, no storage, no network. Loaded as a classic
// script (window.StateSchema) in the app and via require() in tests/main.
//
// Clean-format contract (user decision): ONE current versioned format. Old
// localStorage keys, old portable files and old backup/sync payloads are NOT
// imported, migrated or deleted — they are simply never read. Unknown or
// unversioned input to decode() is rejected with zero writes.
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.StateSchema = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
    'use strict';

    var FORMAT = 'positioncalc-state';
    var SCHEMA_VERSION = 1;
    var STORAGE_KEY = 'psc:state:v1';
    var INSTALL_KEY = 'psc:installation:v1';
    var PORTABLE_FILE = 'psc-state-v1.json';
    var INSTALL_FILE = 'psc-installation-v1.json';
    var MAX_STATE_BYTES = 5 * 1024 * 1024;   // 5 MiB serialized envelope cap

    // ---------- ids / stamps ----------
    function newId() {
        var c = (typeof crypto !== 'undefined') ? crypto : null;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        if (c && typeof c.getRandomValues === 'function') {
            var b = new Uint8Array(16);
            c.getRandomValues(b);
            b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
            var h = []; for (var i = 0; i < 16; i++) h.push(b[i].toString(16).padStart(2, '0'));
            var s = h.join('');
            return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
        }
        return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    function isId(v) { return typeof v === 'string' && v.length > 0 && v.length <= 80 && /^[A-Za-z0-9_.:-]+$/.test(v); }

    // ---------- small validators ----------
    function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
    function isStr(v, max) { return typeof v === 'string' && v.length <= (max || 4000); }
    function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
    function isIsoDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z')); }

    // ---------- key registry ----------
    // Every logical key the app can read/write maps to a typed path inside the
    // state envelope. section drives purpose filtering:
    //   settings → syncable ordinary preferences (backup+sync+portable)
    //   data     → syncable records (backup+sync+portable)
    //   scanner  → per-page stores inside data.scannerStores (backup+sync+portable)
    //   local    → machine/broker/credential state (portable only, never backup/sync)
    //   cache    → ephemeral (local envelope only — not portable/backup/sync)
    // type: 'str' = stored string, 'json' = typed JSON value.
    var SETTINGS_STR = [
        'riskValue', 'slippageValue', 'selectedProvider', 'enhancedSecondaryProvider',
        'collapseAfterCalc', 'preferredViewMode', 'liveUpdateEnabled', 'enhancedLiveMode',
        'setting_showFocus', 'setting_showVoice', 'setting_showAlerts', 'riskMode',
        'accountValue', 'maxHoldDays', 'timedExitEnabled', 'timedExitTime', 'showRangePct',
        'earningsWarnEnabled', 'stopVolWarnEnabled', 'liqWarnEnabled', 'liqVolPct',
        'liqVolPeriod', 'signalSyncMode', 'qldTargetPct', 'qldBandPct', 'globalMarketRegime'
    ];
    var SETTINGS_JSON = ['providerPriorityOrder', 'pbEtfUniverse', 'settingsSectionsCollapsed'];
    var LOCAL_STR = [
        'twsEnabled', 'autoSendExitsOnOpen', 'twsQuotesEnabled', 'twsSyncAccount',
        'twsPositionsEnabled', 'twsOrdersEnabled', 'twsFillsJournalEnabled', 'twsPnlEnabled',
        'twsExitStrategy', 'twsEntryOutsideRth', 'autoEntryEnabled', 'autoEntryTime',
        'flexToken', 'flexQueryId', 'flexAutoSync', 'flexSyncTime'
    ];
    var LOCAL_ROOT_STR = ['journalSyncedAt', 'syncPending'];
    var BRIDGE_STR = ['twsBridgeUrl', 'twsBridgeToken'];           // derived/local — not portable
    var API_KEYS = ['finnhub_key', 'twelvedata_key', 'stockdata_key', 'tiingo_key'];
    var DATA_KEYS = {
        activeTradesLog: 'trades',
        customStrategies: 'customStrategies',
        regimeStrategyMap: 'regimeStrategyMap',
        qldSleeve: 'qldAllocation'
    };
    var LEDGER_KEYS = {
        ledgerConfig: 'config', dailyValuations: 'valuations', cashRecords: 'cashRecords',
        qldLedgerTxns: 'qldTxns', reportSnapshots: 'snapshots', journalAudit: 'audit'
    };
    var LOCAL_JSON = {
        twsSeenExecs: 'execReceipts',
        syncConfig: 'syncConfig',
        autoEntryRun: 'autoEntryRun',
        flexSyncState: 'flexSyncState'
    };
    var CACHE_JSON = { earningsCalendarCache: 'earnings' };
    var SCANNER_PAGES = { '': 'scanner', 'pg_lsv3_': 'lsv3', 'pg_pb_': 'pullback' };
    var SCANNER_FIELDS = { signalSides: 'sides', pbSignals: 'pb', visibleCount: 'visibleCount' };

    // resolve a logical storage key -> {section, get(env), set(env,v), del(env)} or null
    function scannerInfo(page, rest) {
        var m = /^(ticker|trigger)_(\d{1,2})$/.exec(rest);
        if (m) {
            var idx = +m[2];
            if (idx < 0 || idx > 8) return null;
            return { section: 'scanner', page: page, field: m[1] + 's', index: idx, type: 'str' };
        }
        if (Object.prototype.hasOwnProperty.call(SCANNER_FIELDS, rest)) return { section: 'scanner', page: page, field: SCANNER_FIELDS[rest], type: 'json' };
        if (rest === 'riskValue' && page !== 'scanner') return { section: 'scanner', page: page, field: 'riskValue', type: 'json' };
        return null;
    }
    function keyInfo(key) {
        if (typeof key !== 'string' || !key) return null;
        // scanner per-page keys: real prefixes first, then the unprefixed base page
        var pfxes = ['pg_lsv3_', 'pg_pb_'];
        for (var i = 0; i < pfxes.length; i++) {
            var pfx = pfxes[i];
            if (key.indexOf(pfx) !== 0) continue;
            var info = scannerInfo(SCANNER_PAGES[pfx], key.slice(pfx.length));
            return info;                    // known prefix + unknown field -> null (not ours)
        }
        var base = scannerInfo('scanner', key);
        if (base) return base;
        var has = Object.prototype.hasOwnProperty;
        if (SETTINGS_STR.indexOf(key) >= 0) return { section: 'settings', field: key, type: 'str' };
        if (SETTINGS_JSON.indexOf(key) >= 0) return { section: 'settings', field: key, type: 'json' };
        if (has.call(DATA_KEYS, key)) return { section: 'data', field: DATA_KEYS[key], type: 'json' };
        if (has.call(LEDGER_KEYS, key)) return { section: 'ledger', field: LEDGER_KEYS[key], type: 'json' };
        if (LOCAL_STR.indexOf(key) >= 0) return { section: 'local', field: key, type: 'str', group: 'tws' };
        if (LOCAL_ROOT_STR.indexOf(key) >= 0) return { section: 'local', field: key, type: 'str' };
        if (BRIDGE_STR.indexOf(key) >= 0) return { section: 'local', field: key, type: 'str', group: 'bridge' };
        if (API_KEYS.indexOf(key) >= 0) return { section: 'local', field: key, type: 'str', group: 'apiKeys' };
        if (has.call(LOCAL_JSON, key)) return { section: 'local', field: LOCAL_JSON[key], type: 'json' };
        if (has.call(CACHE_JSON, key)) return { section: 'cache', field: CACHE_JSON[key], type: 'json' };
        return null;
    }
    function knownKey(key) { return keyInfo(key) !== null; }

    // ---------- defaults ----------
    function defaultScannerStore() {
        return { visibleCount: 3, tickers: ['', '', '', '', '', '', '', '', ''], triggers: ['', '', '', '', '', '', '', '', ''], sides: {}, pb: [], riskValue: null };
    }
    function defaultLedger() {
        return {
            config: { start: null, openingEquity: null, mode: 'actual', reportNotes: {}, importedHistory: null, qldOpeningShares: null },
            valuations: {},
            cashRecords: { flows: [], income: [] },
            qldTxns: [],
            snapshots: {},
            audit: []
        };
    }
    function defaultLocal() {
        return {
            apiKeys: {},
            tws: {},
            bridge: {},
            execReceipts: [],
            syncConfig: { provider: 'none', enabled: false, url: '', binId: '', apiKey: '', basket: '', lastPushed: 0, lastPulled: 0, remoteTime: 0, lastError: '' },
            journalSyncedAt: null,
            autoEntryRun: null,
            flexSyncState: null
        };
    }
    function defaultData() {
        return {
            settings: {},
            scannerStores: { scanner: defaultScannerStore(), lsv3: defaultScannerStore(), pullback: defaultScannerStore() },
            customStrategies: [],
            regimeStrategyMap: { expanding: 'opt1', declining: 'opt2' },
            trades: [],
            qldAllocation: null,
            ledger: defaultLedger()
        };
    }

    function createEmpty(opts) {
        opts = opts || {};
        return {
            format: FORMAT,
            schemaVersion: SCHEMA_VERSION,
            appVersion: opts.appVersion || '',
            purpose: 'local',
            datasetId: opts.datasetId || ('ds_' + newId()),
            revision: 0,
            savedAt: opts.now || Date.now(),
            data: defaultData(),
            local: defaultLocal(),
            cache: {},
            mergeMeta: { clock: { wallMs: 0, logical: 0 }, versions: {}, tombstones: {} }
        };
    }

    // ---------- structural validation ----------
    var EVENT_KINDS = { Entry: 1, Add: 1, Partial: 1, Exit: 1, Income: 1, Split: 1 };
    function checkTrade(t, errs, path) {
        if (!isObj(t)) { errs.push(path + ': not an object'); return; }
        if (!isId(t.id)) errs.push(path + '.id: missing/invalid');
        if (!isStr(t.ticker, 16)) errs.push(path + '.ticker: missing/invalid');
        if (t.side !== undefined && t.side !== 'LONG' && t.side !== 'SHORT') errs.push(path + '.side: invalid');
        if (t.status !== undefined && ['ACTIVE', 'CLOSED'].indexOf(t.status) < 0) errs.push(path + '.status: invalid');
        ['entryPrice', 'exitPrice', 'shares', 'stopPrice', 'totalQty', 'closedQty', 'realizedPnl', 'commission', 'exitCommission', 'avgExitPrice'].forEach(function (f) {
            if (t[f] !== undefined && t[f] !== null && !isNum(t[f])) errs.push(path + '.' + f + ': not numeric');
        });
        ['entryDate', 'exitDate'].forEach(function (f) {
            if (t[f] !== undefined && t[f] !== null && !isIsoDate(t[f])) errs.push(path + '.' + f + ': not YYYY-MM-DD');
        });
        if (t.events !== undefined) {
            if (!Array.isArray(t.events)) { errs.push(path + '.events: not array'); return; }
            var seen = {};
            t.events.forEach(function (e, i) {
                var ep = path + '.events[' + i + ']';
                if (!isObj(e)) { errs.push(ep + ': not an object'); return; }
                if (!isId(e.id)) errs.push(ep + '.id: missing/invalid');
                else if (seen[e.id]) errs.push(ep + '.id: duplicate');
                else seen[e.id] = 1;
                if (!EVENT_KINDS[e.kind]) errs.push(ep + '.kind: invalid');
                if (!isIsoDate(e.date)) errs.push(ep + '.date: invalid');
                if (!isNum(e.qty) && e.qty !== null && e.qty !== undefined) errs.push(ep + '.qty: not numeric');
                if (!isNum(e.price) && e.price !== null && e.price !== undefined) errs.push(ep + '.price: not numeric');
                if (e.seq !== undefined && (!isNum(e.seq) || e.seq < 0)) errs.push(ep + '.seq: invalid');
            });
        }
    }
    function checkScannerStore(s, errs, path) {
        if (!isObj(s)) { errs.push(path + ': not an object'); return; }
        if (!Array.isArray(s.tickers) || s.tickers.length !== 9 || !s.tickers.every(function (v) { return isStr(v, 16); })) errs.push(path + '.tickers: need 9 strings');
        if (!Array.isArray(s.triggers) || s.triggers.length !== 9 || !s.triggers.every(function (v) { return isStr(v, 64); })) errs.push(path + '.triggers: need 9 strings');
        if (!isObj(s.sides)) errs.push(path + '.sides: not an object');
        else for (var k in s.sides) if (s.sides[k] !== 'LONG' && s.sides[k] !== 'SHORT') { errs.push(path + '.sides.' + k + ': invalid'); break; }
        if (!Array.isArray(s.pb)) errs.push(path + '.pb: not an array');
        else s.pb.forEach(function (r, i) {
            if (!isObj(r) || !isStr(r.ticker, 16)) errs.push(path + '.pb[' + i + ']: invalid row');
        });
        if (s.riskValue !== null && s.riskValue !== undefined && !isNum(s.riskValue)) errs.push(path + '.riskValue: not numeric/null');
        if (s.visibleCount !== undefined && [3, 6, 9].indexOf(s.visibleCount) < 0) errs.push(path + '.visibleCount: invalid');
    }
    function checkLedger(l, errs, path) {
        if (!isObj(l)) { errs.push(path + ': not an object'); return; }
        // config === null is legal: ledger not yet set up (fresh state pre-setup).
        if (l.config !== null && l.config !== undefined && !isObj(l.config)) errs.push(path + '.config: missing');
        else if (isObj(l.config)) {
            var c = l.config;
            if (c.start !== null && c.start !== undefined && !isIsoDate(c.start)) errs.push(path + '.config.start: invalid date');
            if (c.openingEquity !== null && c.openingEquity !== undefined && !isNum(c.openingEquity)) errs.push(path + '.config.openingEquity: invalid');
            if (c.qldOpeningShares !== null && c.qldOpeningShares !== undefined && !isNum(c.qldOpeningShares)) errs.push(path + '.config.qldOpeningShares: invalid');
        }
        if (!isObj(l.valuations)) errs.push(path + '.valuations: not an object');
        else for (var d in l.valuations) {
            if (!isIsoDate(d)) { errs.push(path + '.valuations key ' + JSON.stringify(d).slice(0, 40) + ': not a date'); break; }
            if (!isObj(l.valuations[d])) { errs.push(path + '.valuations.' + d + ': not an object'); break; }
        }
        if (!isObj(l.cashRecords) || !Array.isArray(l.cashRecords.flows) || !Array.isArray(l.cashRecords.income)) errs.push(path + '.cashRecords: bad shape');
        else l.cashRecords.flows.concat(l.cashRecords.income).forEach(function (r, i) {
            if (!isObj(r) || !isId(r.id) || !isIsoDate(r.date)) errs.push(path + '.cashRecords[' + i + ']: invalid record');
        });
        if (!Array.isArray(l.qldTxns)) errs.push(path + '.qldTxns: not an array');
        else l.qldTxns.forEach(function (r, i) {
            if (!isObj(r) || !isId(r.id) || !isIsoDate(r.date)) errs.push(path + '.qldTxns[' + i + ']: invalid txn');
        });
        if (!isObj(l.snapshots)) errs.push(path + '.snapshots: not an object');
        else for (var m in l.snapshots) {
            if (!/^\d{4}-\d{2}$/.test(m)) { errs.push(path + '.snapshots key ' + m + ': not YYYY-MM'); break; }
            if (!Array.isArray(l.snapshots[m])) { errs.push(path + '.snapshots.' + m + ': not an array'); break; }
        }
        if (!Array.isArray(l.audit)) errs.push(path + '.audit: not an array');
        else l.audit.forEach(function (r, i) {
            if (!isObj(r) || !isId(r.id)) errs.push(path + '.audit[' + i + ']: invalid entry');
        });
    }
    function checkLocal(l, errs, path) {
        if (!isObj(l)) { errs.push(path + ': not an object'); return; }
        if (l.apiKeys !== undefined && !isObj(l.apiKeys)) errs.push(path + '.apiKeys: not an object');
        if (l.tws !== undefined && !isObj(l.tws)) errs.push(path + '.tws: not an object');
        if (l.bridge !== undefined && !isObj(l.bridge)) errs.push(path + '.bridge: not an object');
        if (l.execReceipts !== undefined && !Array.isArray(l.execReceipts)) errs.push(path + '.execReceipts: not an array');
        if (l.syncConfig !== undefined && !isObj(l.syncConfig)) errs.push(path + '.syncConfig: not an object');
        if (l.autoEntryRun !== undefined && l.autoEntryRun !== null && !isObj(l.autoEntryRun)) errs.push(path + '.autoEntryRun: not an object');
    }
    function checkMergeMeta(mm, errs, path, opts) {
        opts = opts || {};
        if (!isObj(mm)) { errs.push(path + ': not an object'); return; }
        // Stamps must be well-formed — a garbage stamp would poison LWW merges.
        // opts.remote only: reject wallMs more than ~1 day ahead of the local clock
        // (never on local hydrate — a backward clock correction must not brick boot).
        var farFuture = (opts.now || Date.now()) + 24 * 3600 * 1000;
        function chk(s, p) {
            if (!isObj(s)) { errs.push(p + ': not an object'); return; }
            if (!isNum(s.wallMs) || s.wallMs < 0 || (opts.remote && s.wallMs > farFuture)) errs.push(p + '.wallMs: invalid');
            if (s.logical !== undefined && (!isNum(s.logical) || s.logical < 0 || Math.floor(s.logical) !== s.logical)) errs.push(p + '.logical: invalid');
            if (s.deviceId !== undefined && !isStr(s.deviceId, 80)) errs.push(p + '.deviceId: invalid');
        }
        if (mm.clock !== undefined) { if (!isObj(mm.clock)) errs.push(path + '.clock: invalid'); else chk(mm.clock, path + '.clock'); }
        if (mm.versions !== undefined) {
            if (!isObj(mm.versions)) errs.push(path + '.versions: not an object');
            else for (var k in mm.versions) chk(mm.versions[k], path + '.versions.' + k);
        }
        if (mm.tombstones !== undefined) {
            if (!isObj(mm.tombstones)) errs.push(path + '.tombstones: not an object');
            else for (var t in mm.tombstones) chk(mm.tombstones[t], path + '.tombstones.' + t);
        }
    }

    // validate a decoded envelope object. Returns {ok, errors[]}.
    function validate(state, opts) {
        opts = opts || {};
        var errs = [];
        if (!isObj(state)) return { ok: false, errors: ['state is not an object'] };
        if (state.format !== FORMAT) errs.push('format: expected ' + FORMAT);
        if (state.schemaVersion !== SCHEMA_VERSION) errs.push('schemaVersion: expected ' + SCHEMA_VERSION + ', got ' + JSON.stringify(state.schemaVersion));
        if (errs.length) return { ok: false, errors: errs };
        if (!isStr(state.datasetId, 80)) errs.push('datasetId: missing');
        if (!isNum(state.revision)) errs.push('revision: not numeric');
        if (!isObj(state.data)) { errs.push('data: missing'); return { ok: false, errors: errs }; }
        var d = state.data;
        if (!isObj(d.settings)) errs.push('data.settings: not an object');
        if (!isObj(d.scannerStores)) errs.push('data.scannerStores: missing');
        else ['scanner', 'lsv3', 'pullback'].forEach(function (p) { checkScannerStore(d.scannerStores[p], errs, 'data.scannerStores.' + p); });
        if (!Array.isArray(d.customStrategies)) errs.push('data.customStrategies: not an array');
        else d.customStrategies.forEach(function (s, i) {
            if (!isObj(s) || !isStr(s.id, 80) || !isStr(s.name, 80)) errs.push('data.customStrategies[' + i + ']: invalid');
        });
        if (!isObj(d.regimeStrategyMap)) errs.push('data.regimeStrategyMap: not an object');
        if (!Array.isArray(d.trades)) errs.push('data.trades: not an array');
        else {
            var ids = {};
            d.trades.forEach(function (t, i) {
                checkTrade(t, errs, 'data.trades[' + i + ']');
                if (t && isId(t.id)) { if (ids[t.id]) errs.push('data.trades[' + i + '].id: duplicate'); ids[t.id] = 1; }
            });
        }
        if (d.qldAllocation !== null && d.qldAllocation !== undefined && !isObj(d.qldAllocation)) errs.push('data.qldAllocation: not object/null');
        checkLedger(d.ledger, errs, 'data.ledger');
        if (state.local !== undefined) checkLocal(state.local, errs, 'local');
        if (state.cache !== undefined && !isObj(state.cache)) errs.push('cache: not an object');
        checkMergeMeta(state.mergeMeta, errs, 'mergeMeta', opts);
        return { ok: errs.length === 0, errors: errs.slice(0, 40) };
    }

    // ---------- encode / decode ----------
    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

    // Strip intent fields that must never leave the machine: QLD pending orders
    // and per-trade in-flight TWS control flags live in data but are not synced.
    var QLD_INTENT_FIELDS = ['pending', 'pendingOrder'];
    var TRADE_LOCAL_FIELDS = ['_entryCredits', '_exitCredits', '_estExitFills', '_posQty', 'fillSource'];
    function stripForSync(data) {
        var d = clone(data);
        if (d.qldAllocation && isObj(d.qldAllocation)) QLD_INTENT_FIELDS.forEach(function (f) { delete d.qldAllocation[f]; });
        (d.trades || []).forEach(function (t) { TRADE_LOCAL_FIELDS.forEach(function (f) { delete t[f]; }); });
        return d;
    }

    // Project a full internal state into the wire object for a purpose.
    // purposes: 'local' (everything), 'portable' (no cache/bridge), 'backup'|'sync' (no local/cache).
    function encode(state, opts) {
        opts = opts || {};
        var purpose = opts.purpose || 'local';
        var out = {
            format: FORMAT,
            schemaVersion: SCHEMA_VERSION,
            appVersion: state.appVersion || '',
            purpose: purpose,
            datasetId: state.datasetId,
            revision: state.revision,
            savedAt: opts.now || Date.now(),
            data: purpose === 'sync' ? stripForSync(state.data) : clone(state.data),
            mergeMeta: clone(state.mergeMeta)
        };
        if (purpose === 'local' || purpose === 'portable') {
            var loc = clone(state.local) || {};
            if (purpose === 'portable' && loc.bridge) loc.bridge = {};   // bridge url/token are meta-derived per machine
            out.local = loc;
        }
        if (purpose === 'local') out.cache = clone(state.cache) || {};
        return out;
    }

    // Parse + validate a serialized/foreign payload. Strict: unknown format,
    // wrong schemaVersion or malformed structure => {ok:false} with zero writes.
    function decode(raw, opts) {
        opts = opts || {};
        var obj = raw;
        if (typeof raw === 'string') {
            if (raw.length > MAX_STATE_BYTES * 2) return { ok: false, error: 'payload too large' };
            try { obj = JSON.parse(raw); } catch (e) { return { ok: false, error: 'invalid JSON: ' + (e && e.message) }; }
        }
        if (!isObj(obj)) return { ok: false, error: 'payload is not an object' };
        if (obj.format !== FORMAT) return { ok: false, error: 'unsupported format (expected ' + FORMAT + ')' };
        if (obj.schemaVersion !== SCHEMA_VERSION) return { ok: false, error: 'unsupported schemaVersion ' + JSON.stringify(obj.schemaVersion) };
        var v = validate(obj, opts);
        if (!v.ok) return { ok: false, error: 'invalid state: ' + v.errors[0], errors: v.errors };
        return { ok: true, value: obj };
    }

    // ---------- key <-> typed-path adapter ----------
    function getByKey(state, key) {
        var info = keyInfo(key);
        if (!info || !state) return undefined;
        var v;
        if (info.section === 'settings') v = state.data && state.data.settings ? state.data.settings[info.field] : undefined;
        else if (info.section === 'data') v = state.data ? state.data[info.field] : undefined;
        else if (info.section === 'ledger') v = state.data && state.data.ledger ? state.data.ledger[info.field] : undefined;
        else if (info.section === 'scanner') {
            var s = state.data && state.data.scannerStores ? state.data.scannerStores[info.page] : null;
            if (!s) return undefined;
            v = info.index !== undefined ? (s[info.field] || [])[info.index] : s[info.field];
        } else if (info.section === 'local') {
            var l = state.local || {};
            if (info.group === 'apiKeys') v = l.apiKeys ? l.apiKeys[info.field] : undefined;
            else if (info.group === 'bridge') v = l.bridge ? l.bridge[info.field] : undefined;
            else if (info.group === 'tws') v = l.tws ? l.tws[info.field] : undefined;
            else v = l[info.field];
        } else if (info.section === 'cache') v = state.cache ? state.cache[info.field] : undefined;
        return v;
    }

    // Serialize a typed value back to the string contract callers expect.
    function toWire(info, v) {
        if (v === undefined || v === null) return null;
        if (info.type === 'json') { try { return JSON.stringify(v); } catch (e) { return null; } }
        return typeof v === 'string' ? v : String(v);
    }
    function getString(state, key) {
        var info = keyInfo(key);
        if (!info) return null;
        return toWire(info, getByKey(state, key));
    }

    function fromWire(info, str) {
        if (info.type === 'json') {
            if (typeof str !== 'string') return str;    // already typed — caller passed an object/number
            try { return JSON.parse(str); } catch (e) { return { __err: true }; }
        }
        return str === undefined || str === null ? '' : String(str);
    }
    // Write a caller-supplied value into the typed envelope. Returns true on success.
    function setByKey(state, key, str) {
        var info = keyInfo(key);
        if (!info || !state) return false;
        var v = fromWire(info, str);
        if (v && v.__err) return false;
        if (info.section === 'settings') { state.data.settings[info.field] = v; return true; }
        if (info.section === 'data') { state.data[info.field] = v; return true; }
        if (info.section === 'ledger') { state.data.ledger[info.field] = v; return true; }
        if (info.section === 'scanner') {
            var s = state.data.scannerStores[info.page];
            if (!s) return false;
            if (info.index !== undefined) { (s[info.field] = s[info.field] || [])[info.index] = v === null ? '' : String(v); return true; }
            s[info.field] = v;
            return true;
        }
        if (info.section === 'local') {
            var l = state.local;
            if (info.group === 'apiKeys') (l.apiKeys = l.apiKeys || {})[info.field] = v;
            else if (info.group === 'bridge') (l.bridge = l.bridge || {})[info.field] = v;
            else if (info.group === 'tws') (l.tws = l.tws || {})[info.field] = v;
            else l[info.field] = v;
            return true;
        }
        if (info.section === 'cache') { (state.cache = state.cache || {})[info.field] = v; return true; }
        return false;
    }
    // Remove = restore the key's default/empty value (preserves shape invariants).
    function removeByKey(state, key) {
        var info = keyInfo(key);
        if (!info || !state) return false;
        if (info.section === 'settings') { delete state.data.settings[info.field]; return true; }
        if (info.section === 'scanner') {
            var s = state.data.scannerStores[info.page];
            if (!s) return false;
            if (info.index !== undefined) { if (s[info.field]) s[info.field][info.index] = ''; return true; }
            var def = defaultScannerStore();
            s[info.field] = clone(def[info.field]);
            return true;
        }
        if (info.section === 'data') { state.data[info.field] = clone(defaultData()[info.field]); return true; }
        if (info.section === 'ledger') { state.data.ledger[info.field] = clone(defaultLedger()[info.field]); return true; }
        if (info.section === 'local') {
            var l = state.local;
            if (info.group === 'apiKeys') { if (l.apiKeys) delete l.apiKeys[info.field]; return true; }
            if (info.group === 'bridge') { if (l.bridge) delete l.bridge[info.field]; return true; }
            if (info.group === 'tws') { if (l.tws) delete l.tws[info.field]; return true; }
            delete l[info.field]; return true;
        }
        if (info.section === 'cache') { if (state.cache) delete state.cache[info.field]; return true; }
        return false;
    }

    // ---------- record projection & merge primitives (consumed by sync.js) ----------
    // recordKey -> stamped record. The versions map is authoritative for LWW.
    function stampOf(mm, rkey) {
        var v = mm && mm.versions ? mm.versions[rkey] : null;
        return v && isObj(v) ? v : null;
    }
    function compareStamps(a, b) {
        // lexicographic (wallMs, logical, deviceId); missing stamp sorts oldest
        if (!a && !b) return 0;
        if (!a) return -1;
        if (!b) return 1;
        var d = (a.wallMs || 0) - (b.wallMs || 0); if (d) return d < 0 ? -1 : 1;
        d = (a.logical || 0) - (b.logical || 0); if (d) return d < 0 ? -1 : 1;
        var x = String(a.deviceId || ''), y = String(b.deviceId || '');
        return x < y ? -1 : x > y ? 1 : 0;
    }
    // Next local revision stamp for this installation.
    function nextStamp(state, deviceId, now) {
        var mm = state.mergeMeta;
        var wall = Math.max(now || Date.now(), mm.clock.wallMs || 0);
        var latest = wall;
        for (var k in mm.versions) { var s = mm.versions[k]; if (s && (s.wallMs || 0) > latest) latest = s.wallMs; }
        for (var t in mm.tombstones) { var s2 = mm.tombstones[t]; if (s2 && (s2.wallMs || 0) > latest) latest = s2.wallMs; }
        wall = Math.max(wall, latest);
        var logical = (wall === mm.clock.wallMs) ? (mm.clock.logical || 0) + 1 : 0;
        mm.clock = { wallMs: wall, logical: logical };
        return { wallMs: wall, logical: logical, deviceId: String(deviceId || '') };
    }

    // Flatten envelope data into merge records: {rkey: {id,kind,value}}.
    function recordIndex(state) {
        var recs = {};
        var d = state.data || {};
        var mm = state.mergeMeta || { versions: {}, tombstones: {} };
        function put(rkey, kind, id, value) {
            recs[rkey] = { id: id, kind: kind, value: clone(value), stamp: stampOf(mm, rkey) };
        }
        var dead = mm.tombstones || {};
        for (var name in (d.settings || {})) put('setting/' + name, 'setting', name, d.settings[name]);
        for (var page in (d.scannerStores || {})) put('scanner/' + page, 'scanner', page, d.scannerStores[page]);
        (d.customStrategies || []).forEach(function (s) { if (s && s.id !== undefined) put('strategy/' + s.id, 'strategy', String(s.id), s); });
        put('regimeMap', 'regimeMap', 'regimeMap', d.regimeStrategyMap || {});
        (d.trades || []).forEach(function (t) {
            if (!t || t.id === undefined) return;
            var core = clone(t); delete core.events;
            put('trade/' + t.id, 'trade', String(t.id), core);
            (t.events || []).forEach(function (e) { if (e && e.id !== undefined) put('event/' + t.id + '/' + e.id, 'event', String(e.id), e); });
        });
        if (d.qldAllocation) put('qldAlloc', 'qldAlloc', 'qldAlloc', d.qldAllocation);
        var l = d.ledger || {};
        put('ledger/config', 'ledgerConfig', 'config', l.config || {});
        for (var date in (l.valuations || {})) put('valuation/' + date, 'valuation', date, l.valuations[date]);
        var cr = l.cashRecords || {};
        (cr.flows || []).forEach(function (r) { if (r && r.id !== undefined) put('cash/' + r.id, 'cashFlow', String(r.id), r); });
        (cr.income || []).forEach(function (r) { if (r && r.id !== undefined) put('income/' + r.id, 'cashIncome', String(r.id), r); });
        (l.qldTxns || []).forEach(function (r) { if (r && r.id !== undefined) put('qldTxn/' + r.id, 'qldTxn', String(r.id), r); });
        for (var month in (l.snapshots || {})) put('report/' + month, 'report', month, l.snapshots[month]);
        (l.audit || []).forEach(function (r) { if (r && r.id !== undefined) put('audit/' + r.id, 'audit', String(r.id), r); });
        // tombstoned keys surface as deleted records
        for (var dk in dead) if (!recs[dk]) recs[dk] = { id: dk, kind: 'deleted', value: null, deleted: true, stamp: dead[dk] };
        return recs;
    }

    // Rebuild envelope data from merged records. Returns a fresh data object.
    function projectRecords(recs) {
        var d = defaultData();
        var tradeIds = [];
        for (var rkey in recs) {
            var r = recs[rkey];
            if (!r || r.deleted) continue;
            var seg = rkey.split('/');
            var v = clone(r.value);
            if (seg[0] === 'setting') d.settings[seg.slice(1).join('/')] = v;
            // scanner/<page>: accept any page id — forward-compat for pages added
            // after this build; validate() only shape-checks the known three and
            // does not reject extras, so unknown pages round-trip intact.
            else if (seg[0] === 'scanner' && seg[1]) { if (isObj(v)) d.scannerStores[seg[1]] = v; }
            else if (seg[0] === 'strategy') { if (isObj(v)) d.customStrategies.push(v); }
            else if (rkey === 'regimeMap') d.regimeStrategyMap = isObj(v) ? v : d.regimeStrategyMap;
            else if (seg[0] === 'trade') { if (isObj(v)) { v.events = v.events || []; d.trades.push(v); tradeIds.push(seg[1]); } }
            else if (seg[0] === 'event' && seg.length === 3) {
                var tr = d.trades.find(function (t) { return String(t.id) === seg[1]; });
                if (tr) tr.events.push(v);
            } else if (rkey === 'qldAlloc') d.qldAllocation = isObj(v) ? v : null;
            else if (rkey === 'ledger/config') d.ledger.config = isObj(v) ? v : d.ledger.config;
            else if (seg[0] === 'valuation' && seg[1]) d.ledger.valuations[seg[1]] = v;
            else if (seg[0] === 'cash') { if (isObj(v)) d.ledger.cashRecords.flows.push(v); }
            else if (seg[0] === 'income') { if (isObj(v)) d.ledger.cashRecords.income.push(v); }
            else if (seg[0] === 'qldTxn') { if (isObj(v)) d.ledger.qldTxns.push(v); }
            else if (seg[0] === 'report' && seg[1]) d.ledger.snapshots[seg[1]] = v;
            else if (seg[0] === 'audit') { if (isObj(v)) d.ledger.audit.push(v); }
        }
        // deterministic ordering for array-embedded records
        d.trades.forEach(function (t) { (t.events || []).sort(function (a, b) { return (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.seq || 0) - (b.seq || 0)); }); });
        d.ledger.qldTxns.sort(function (a, b) { return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0); });
        d.ledger.cashRecords.flows.sort(function (a, b) { return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0); });
        d.ledger.cashRecords.income.sort(function (a, b) { return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0); });
        return d;
    }

    // Merge local+remote record maps with last-change-wins per recordKey.
    // Tombstones participate. Returns {records, versions, tombstones, conflicts}.
    function mergeRecords(localRecs, remoteRecs, remoteMeta) {
        var out = {};
        var versions = {};
        var tombstones = {};
        var conflicts = [];
        var keys = {};
        for (var k in localRecs) keys[k] = 1;
        for (var k2 in remoteRecs) keys[k2] = 1;
        for (var rkey in keys) {
            var L = localRecs[rkey], R = remoteRecs[rkey];
            var ls = L && L.stamp, rs = R && R.stamp;
            var rt = remoteMeta && remoteMeta.tombstones ? remoteMeta.tombstones[rkey] : null;
            if (!R && rt) { R = { id: rkey, kind: 'deleted', value: null, deleted: true, stamp: rt }; rs = rt; }
            if (!L && !R) continue;
            var pick;
            if (L && !R) pick = L;
            else if (!L && R) pick = R;
            else {
                var cmp = compareStamps(ls, rs);
                if (cmp === 0 && JSON.stringify(L.value) !== JSON.stringify(R.value)) {
                    conflicts.push({ key: rkey, reason: 'identical stamp, different value' });
                    pick = L;   // identical stamp+diff content is invalid; keep local, flag it
                } else pick = cmp >= 0 ? L : R;
            }
            // Never emit null stamps: unversioned records get no versions entry at
            // all (absence = unversioned). A tombstone with no stamp keeps a zero
            // stamp so the delete still propagates (it loses to any stamped write).
            if (pick.deleted) tombstones[rkey] = pick.stamp || { wallMs: 0, logical: 0, deviceId: '' };
            else {
                out[rkey] = { id: pick.id, kind: pick.kind, value: clone(pick.value), stamp: pick.stamp };
                if (pick.stamp) versions[rkey] = pick.stamp;
            }
        }
        return { records: out, versions: versions, tombstones: tombstones, conflicts: conflicts };
    }

    return {
        FORMAT: FORMAT, SCHEMA_VERSION: SCHEMA_VERSION,
        STORAGE_KEY: STORAGE_KEY, INSTALL_KEY: INSTALL_KEY,
        PORTABLE_FILE: PORTABLE_FILE, INSTALL_FILE: INSTALL_FILE,
        MAX_STATE_BYTES: MAX_STATE_BYTES,
        SETTINGS_STR: SETTINGS_STR, SETTINGS_JSON: SETTINGS_JSON, LOCAL_STR: LOCAL_STR, LOCAL_ROOT_STR: LOCAL_ROOT_STR,
        BRIDGE_STR: BRIDGE_STR, API_KEYS: API_KEYS, DATA_KEYS: DATA_KEYS,
        LEDGER_KEYS: LEDGER_KEYS, LOCAL_JSON: LOCAL_JSON, CACHE_JSON: CACHE_JSON,
        SCANNER_PAGES: SCANNER_PAGES,
        newId: newId, isId: isId, isIsoDate: isIsoDate, isObj: isObj,
        createEmpty: createEmpty, defaultData: defaultData, defaultLocal: defaultLocal,
        defaultScannerStore: defaultScannerStore, defaultLedger: defaultLedger,
        keyInfo: keyInfo, knownKey: knownKey,
        getByKey: getByKey, getString: getString, setByKey: setByKey, removeByKey: removeByKey,
        validate: validate, encode: encode, decode: decode,
        clone: clone, stripForSync: stripForSync,
        SYNC_STRIP: { qld: QLD_INTENT_FIELDS, trade: TRADE_LOCAL_FIELDS },
        stampOf: stampOf, compareStamps: compareStamps, nextStamp: nextStamp,
        recordIndex: recordIndex, projectRecords: projectRecords, mergeRecords: mergeRecords
    };
});
