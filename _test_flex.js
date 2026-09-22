// Tests for IBKR Flex reconcile: flex.js CSV parsing + trade mapping, ledger.js
// commission metadata + aggregations, and index.html's reconcileFlexFill /
// findFlexEstMatch / flexSyncTick matching rules.
const fs = require('fs');
const path = require('path');
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };
const near = (a, b, m) => assert(Math.abs(a - b) < 1e-6, `${m} (${a} vs ${b})`);

// ---------- layer 1: tws-bridge/flex.js (pure Node module) ----------
const flex = require(path.join(__dirname, 'tws-bridge', 'flex.js'));

// parseFlexDateTime
let dt = flex.parseFlexDateTime('20260904;153002');
assert(dt.day === '20260904' && dt.time === '20260904  15:30:02', 'compact datetime parsed: ' + JSON.stringify(dt));
dt = flex.parseFlexDateTime('2026-09-04, 15:30:02');
assert(dt && dt.day === '20260904', 'iso datetime parsed');
dt = flex.parseFlexDateTime('09/04/2026 15:30:02');
assert(dt && dt.day === '20260904', 'us datetime parsed');
dt = flex.parseFlexDateTime('20260904');
assert(dt && dt.day === '20260904' && dt.time.endsWith('00:00:00'), 'date-only defaults to 00:00:00');
assert(flex.parseFlexDateTime('garbage') === null, 'garbage datetime -> null');

// splitCsvLine / parseFlexCsv — Activity-Flex layout: section,Header|Data,...
const CSV = [
    '"Trades","Header","DataDiscriminator","Asset Category","Currency","Symbol","Date/Time","Quantity","Trade Price","Buy/Sell","IB Commission","IB Exec ID"',
    '"Trades","Data","Order","Stocks","USD","AAPL","20260904;093001","100","150.25","BUY","-1.05","0000e1a7.68b9c6d1.01.01"',
    '"Trades","Data","Order","Stocks","USD","AAPL","20260905;153500","-100","155.00","SELL","-1.10","0000e1a7.68ba1122.01.01"',
    '"Trades","Data","Order","Stocks","USD","TSLA","","","","","',                       // malformed row (no exec) -> skipped
    '"Cash Transactions","Header","Currency","Date/Time","Amount","Type"',
    '"Cash Transactions","Data","USD","20260905;000000","42.00","Dividends"'
].join('\n');
const parsed = flex.parseFlexCsv(CSV);
assert(parsed.sections['Trades'].rows.length === 3, 'trades section rows');
assert(parsed.skippedSections.includes('Cash Transactions'), 'non-trades sections listed as skipped');

// flexTradeToExec
const row0 = flex.mapTradeRow(parsed.sections['Trades'].header, parsed.sections['Trades'].rows[0]);
const ex0 = flex.flexTradeToExec(row0);
assert(ex0 && ex0.symbol === 'AAPL' && ex0.side === 'BOT' && ex0.shares === 100 && ex0.price === 150.25, 'buy maps to BOT');
near(ex0.commission, 1.05, 'commission abs value');
assert(ex0.execId === '0000e1a7.68b9c6d1.01.01', 'execId kept');
assert(ex0.time === '20260904  09:30:01', 'time in TWS layout: ' + ex0.time);
const ex1 = flex.flexTradeToExec(flex.mapTradeRow(parsed.sections['Trades'].header, parsed.sections['Trades'].rows[1]));
assert(ex1 && ex1.side === 'SLD' && ex1.shares === 100, 'sell maps to SLD with abs qty');
assert(flex.flexTradeToExec({ symbol: 'X', execId: 'e', dateTime: 'bad' }) === null, 'bad datetime -> null');
assert(flex.flexTradeToExec({ symbol: 'X' }) === null, 'missing execId -> null');

// flexTradesFromCsv — sorted, malformed skipped
const conv = flex.flexTradesFromCsv(CSV);
assert(conv.trades.length === 2 && conv.trades[0].execId === ex0.execId, 'chronological order kept');
assert(conv.skipped === 1, 'malformed row counted skipped');

// flexRequest — missing creds short-circuit
(async () => {
    const r = await flex.flexRequest('', '');
    assert(r.ok === false && /Missing/.test(r.error), 'missing creds -> ok:false');
})().then(() => {}) .catch(e => { console.error('flexRequest test failed:', e); process.exit(1); });

// ---------- layer 2: ledger.js commission metadata ----------
const lcode = fs.readFileSync(path.join(__dirname, 'ledger.js'), 'utf8');
const L = new Function('console', 'Date', 'Math', 'Number', 'JSON', 'Object', 'Array', 'String', 'Promise', lcode + '\nreturn Ledger;')(console, Date, Math, Number, JSON, Object, Array, String, Promise);
let J = [];
L.init({ journal: { get: () => J, set: (a) => { J = a; } }, hooks: { nyDate: () => '2026-09-30', isRTH: () => false, getPrice: () => null, twsPositionFor: () => null, qldPrice: () => 100 } });

const tr = { id: 1, ticker: 'AAA', side: 'LONG', status: 'ACTIVE', entryDate: '2026-09-04', entryPrice: 150, shares: 100, events: [] };
J.push(tr);
const e0 = L.appendEvent(tr, { kind: 'Entry', qty: 100, price: 150, date: '2026-09-04', execId: '20260904|ex1', commission: -1.05 });
assert(e0.commission === 1.05, 'appendEvent stores abs commission');
assert(!('commission' in L.appendEvent(tr, { kind: 'Add', qty: 10, price: 151, date: '2026-09-04' })), 'no commission -> field absent');
const found = L.findExecEvent('20260904|ex1');
assert(found && found.event === e0 && found.trade === tr, 'findExecEvent locates event');
assert(L.findExecEvent('nope') === null, 'findExecEvent miss -> null');
L.setEventCommissionByExec('20260904|ex1', 1.20);
assert(e0.commission === 1.20, 'setEventCommissionByExec overwrites');
L.amendEvent(tr, e0.id, { commission: 1.30, date: '2026-09-05' });
assert(e0.commission === 1.30 && e0.date === '2026-09-05', 'amendEvent patches commission + date');
near(L.commissionForTrade(tr), 1.30, 'commissionForTrade sums events');
const wk = L.commissionsByWeek();
assert(wk['2026-08-31'] === 1.30, 'week bucket = Monday 2026-08-31: ' + JSON.stringify(wk));
const mo = L.commissionsByMonth();
assert(mo['2026-09'] === 1.30, 'month bucket');
assert(L.exportEventsCsv().indexOf('Commission') >= 0, 'events CSV has commission column');

// ---------- layer 3: index.html reconcile functions ----------
const h = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = h.slice(h.indexOf('<script>') + 8, h.lastIndexOf('</script>'));
const elements = {};
function mockElement(id) {
    if (!elements[id]) elements[id] = {
        id, innerText: '', innerHTML: '', value: '', className: '', dataset: {}, style: {}, children: [],
        classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
        querySelectorAll: () => [], querySelector: () => null, appendChild: () => {}, removeChild: () => {}, insertAdjacentHTML: () => {}, addEventListener: () => {}, setAttribute: () => {}, getAttribute: () => null, click: () => {}, remove: () => {}, closest: () => null, focus: () => {}
    };
    return elements[id];
}
const document = { getElementById: mockElement, getElementsByName: () => [], querySelectorAll: () => [], querySelector: () => null, createElement: () => mockElement('e' + Math.random()), addEventListener: () => {}, body: mockElement('body') };
const store = {};
const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const windowObj = { speechSynthesis: { speak: () => {}, cancel: () => {} }, addEventListener: () => {}, Ledger: L };
const sandbox = {
    elements, document, localStorage, window: windowObj, navigator: { clipboard: { writeText: () => Promise.resolve() } }, console, Ledger: L,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval, AbortController,
    alert: () => {}, confirm: () => true, prompt: () => null,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, trades: [] }) })
};
const fn = new Function(...Object.keys(sandbox), code + `
return {
    reconcileFlexFill, findFlexEstMatch, flexSyncTick, twsExecKey, flexReconcileNow,
    set flexToken(v) { flexToken = v; }, set flexQueryId(v) { flexQueryId = v; },
    set flexAutoSync(v) { flexAutoSync = v; }, set flexSyncTime(v) { flexSyncTime = v; },
    get flexSyncState() { return flexSyncState; }, set flexSyncState(v) { flexSyncState = v; },
    set twsFillsJournalEnabled(v) { twsFillsJournalEnabled = v; },
    get activeTradesLog() { return activeTradesLog; }, set activeTradesLog(v) { activeTradesLog.length = 0; activeTradesLog.push(...v); },
    get twsSeenExecs() { return twsSeenExecs; }, set twsSeenExecs(v) { twsSeenExecs = v; },
    get twsPositionsEnabled() { return twsPositionsEnabled; },
    set twsEnabled(v) { twsEnabled = v; }, set twsBridgeUrl(v) { twsBridgeUrl = v; }, set twsBridgeToken(v) { twsBridgeToken = v; },
    flexFetchReport
};`);
const api = fn(...Object.values(sandbox));

// Wire the real ledger to the sandbox journal.
L.init({ journal: { get: () => api.activeTradesLog, set: (a) => { api.activeTradesLog = a; } }, hooks: { nyDate: () => '2026-09-30', isRTH: () => true, getPrice: () => null, twsPositionFor: () => null, qldPrice: () => 100 } });
api.twsFillsJournalEnabled = true;
api.flexToken = 'tok'; api.flexQueryId = '12345';

const flexBuy = (over) => Object.assign({ symbol: 'AAA', side: 'BOT', shares: 100, price: 150.5, commission: 1.05, execId: 'f1', time: '20260904  09:30:01', day: '20260904' }, over || {});
const flexSell = (over) => Object.assign({ symbol: 'AAA', side: 'SLD', shares: 100, price: 155, commission: 1.10, execId: 'f2', time: '20260908  15:30:01', day: '20260908' }, over || {});

// seen exec -> 'updated' + event commission stamped
api.activeTradesLog = [{
    id: 't1', ticker: 'AAA', side: 'LONG', status: 'ACTIVE', fillSource: 'tws',
    entryDate: '2026-09-04', entryPrice: 150, shares: 100, totalQty: 100, commission: 1.05,
    events: [{ id: 'ev1', kind: 'Entry', date: '2026-09-04', qty: 100, price: 150, amount: 0, note: 'TWS fill', execId: '20260904|f1', seq: 1 }]
}];
api.twsSeenExecs = new Map([['20260904|f1', 1.05]]);
assert(api.reconcileFlexFill(flexBuy()) === 'updated', 'seen exec -> updated');
assert(api.activeTradesLog[0].events[0].commission === 1.05, 'event commission stamped on seen exec');

// exec recorded but seen-map evicted -> 'updated', no double journal
api.twsSeenExecs = new Map();
assert(api.reconcileFlexFill(flexBuy()) === 'updated', 'evicted seen-map -> updated via findExecEvent');
assert(api.activeTradesLog.length === 1, 'no duplicate row created');

// unseen SELL matching a closed row's est Exit -> 'amended' in place
api.activeTradesLog = [{
    id: 't2', ticker: 'AAA', side: 'LONG', status: 'CLOSED', fillSource: 'tws',
    entryDate: '2026-09-04', entryPrice: 150, shares: 0, totalQty: 100, closedQty: 100,
    exitDate: '2026-09-08', exitPrice: 154.9, realizedPnl: 490, pnl: 490,
    _estExitEventId: 'ev9',
    events: [
        { id: 'ev8', kind: 'Entry', date: '2026-09-04', qty: 100, price: 150, amount: 0, note: 'TWS fill', execId: '20260904|f1', seq: 1 },
        { id: 'ev9', kind: 'Exit', date: '2026-09-08', qty: 100, price: 154.9, amount: 0, note: 'TWS position delta (est)', seq: 2 }
    ]
}];
api.twsSeenExecs = new Map();
assert(api.reconcileFlexFill(flexSell({ price: 155 })) === 'amended', 'closed-row est exit -> amended');
const amended = api.activeTradesLog[0].events[1];
assert(amended.execId === '20260908|f2' && amended.commission === 1.10 && amended.price === 155, 'draft rewritten with real price/execId/comm');
assert(!api.activeTradesLog[0]._estExitEventId, 'stale _estExitEventId cleared');
assert(api.twsSeenExecs.has('20260908|f2'), 'amended fill marked seen');
assert(api.activeTradesLog.length === 1, 'no spurious row for the matched exit');
// dPnl = price correction minus the fill's commission: (155-154.9)*100 - 1.10 = 8.90
near(api.activeTradesLog[0].realizedPnl, 490 + 8.90, 'est-amend books price delta net of fees');
near(api.activeTradesLog[0].pnl, 498.90, 'closed row pnl updated');
near(api.activeTradesLog[0].exitCommission, 1.10, 'exitCommission credited');

// unseen BUY with no journal context -> classify -> new 'entry' row
api.activeTradesLog = [];
api.twsSeenExecs = new Map();
const rc = api.reconcileFlexFill(flexBuy({ execId: 'f9', time: '20260909  09:30:01', day: '20260909' }));
assert(rc === 'entry', 'unseen buy -> entry (got ' + rc + ')');
assert(api.activeTradesLog.length === 1 && api.activeTradesLog[0].ticker === 'AAA', 'journal row created');
const newEv = api.activeTradesLog[0].events[0];
assert(newEv.execId === '20260909|f9' && newEv.commission === 1.05, 'new entry event carries execId + commission');

// ambiguous est match (two identical execId-less events) -> classify, not merge
api.activeTradesLog = [{
    id: 't3', ticker: 'AAA', side: 'LONG', status: 'CLOSED', fillSource: 'tws',
    entryDate: '2026-09-04', entryPrice: 150, shares: 0, totalQty: 200, closedQty: 200,
    exitDate: '2026-09-08', exitPrice: 155, realizedPnl: 1000, pnl: 1000,
    events: [
        { id: 'ea', kind: 'Entry', date: '2026-09-04', qty: 200, price: 150, amount: 0, note: '', execId: '20260904|x1', seq: 1 },
        { id: 'eb', kind: 'Exit', date: '2026-09-08', qty: 100, price: 155, amount: 0, note: '', seq: 2 },
        { id: 'ec', kind: 'Exit', date: '2026-09-08', qty: 100, price: 155, amount: 0, note: '', seq: 3 }
    ]
}];
api.twsSeenExecs = new Map();
const rAmb = api.reconcileFlexFill(flexSell({ execId: 'fAmb' }));
assert(rAmb !== 'amended', 'ambiguous match never merges (got ' + rAmb + ')');
assert(api.activeTradesLog[0].events.filter(e => e.execId === '20260908|fAmb').length <= 1, 'no double-amend');

// findFlexEstMatch — direct checks
const open = { id: 't4', ticker: 'BBB', side: 'LONG', status: 'ACTIVE', events: [
    { id: 'e1', kind: 'Entry', date: '2026-09-01', qty: 50, price: 10, note: 'manual', seq: 1 },
    { id: 'e2', kind: 'Partial', date: '2026-09-09', qty: 20, price: 11, note: 'TWS position delta (est)', seq: 2 }
]};
api.activeTradesLog = [open];
const hit = api.findFlexEstMatch('BBB', 'SLD', 20, '2026-09-08');
assert(hit && hit.e.id === 'e2', 'est note matches across dates');
assert(api.findFlexEstMatch('BBB', 'BOT', 20, '2026-09-09') === null, 'wrong direction no match');
assert(api.findFlexEstMatch('BBB', 'SLD', 21, '2026-09-09') === null, 'qty mismatch no match');
assert(api.findFlexEstMatch('CCC', 'SLD', 20, '2026-09-09') === null, 'wrong ticker no match');

// flexSyncTick gating — unconfigured does nothing; configured stamps lastAttempt
api.flexAutoSync = true; api.flexSyncTime = '00:00';
api.flexSyncState = null;
api.flexToken = ''; api.flexQueryId = '';
api.flexSyncTick({ date: '2026-09-08', minutesOfDay: 900 });
assert(!api.flexSyncState || !api.flexSyncState.lastAttempt, 'unconfigured tick no-ops');
api.flexToken = 'tok'; api.flexQueryId = '123';
api.flexSyncTick({ date: '2026-09-08', minutesOfDay: 900 });
assert(api.flexSyncState && api.flexSyncState.lastAttempt > 0, 'due tick stamps lastAttempt');
const stamp = api.flexSyncState.lastAttempt;
api.flexSyncTick({ date: '2026-09-08', minutesOfDay: 901 });
assert(api.flexSyncState.lastAttempt === stamp, 'retry throttled inside 60s');
// fills->journal off: tick no-ops entirely (no retry churn)
api.twsFillsJournalEnabled = false;
api.flexSyncState = null;
api.flexSyncTick({ date: '2026-09-08', minutesOfDay: 900 });
assert(!api.flexSyncState || !api.flexSyncState.lastAttempt, 'fills->journal off: tick inert');
api.twsFillsJournalEnabled = true;

// flexFetchReport needs bridge config only — NOT twsEnabled (pure IBKR HTTPS)
api.twsEnabled = false; api.twsBridgeUrl = 'http://127.0.0.1:8787'; api.twsBridgeToken = 'btok';
api.flexFetchReport().then(r => {
    assert(r && r.ok === true, 'report fetch succeeds with twsEnabled=false');
    api.twsBridgeUrl = ''; api.twsBridgeToken = '';
    return api.flexFetchReport().then(() => { throw new Error('expected throw'); }, e => {
        assert(/Bridge not configured/.test(e.message), 'unconfigured bridge throws');
        console.log('flex reconcile tests passed!');
    });
}).catch(e => { console.error('flexFetchReport test failed:', e); process.exit(1); });
