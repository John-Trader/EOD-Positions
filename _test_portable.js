// Tests for the portable/backup state contract: scannerStores collection,
// backup validation of real producer shapes (QLD rows, closed TWS rows,
// pendingOrder), bridge-URL validation, the in-app QLD sleeve editor, and
// confirmed-fill ledger application.
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = h.slice(h.indexOf('<script>') + 8, h.lastIndexOf('</script>'));

const elements = {};
function mockElement(id) {
  if (!elements[id]) elements[id] = {
    id, innerText: '', innerHTML: '', value: '', className: '', dataset: {}, style: {}, children: [],
    classList: { add: (...c) => { elements[id].className += ' ' + c.join(' '); }, remove: (...c) => { c.forEach(cls => elements[id].className = elements[id].className.replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim()); }, contains: (c) => elements[id].className.includes(c), toggle: () => {} },
    querySelectorAll: () => [], querySelector: () => null, appendChild: () => {}, removeChild: () => {}, insertAdjacentHTML: () => {}, addEventListener: () => {}, setAttribute: () => {}, getAttribute: () => null, click: () => {}, remove: () => {}, closest: () => null
  };
  return elements[id];
}
const document = { getElementById: mockElement, getElementsByName: () => [], querySelectorAll: () => [], querySelector: () => null, createElement: () => mockElement('e' + Math.random()), addEventListener: () => {}, body: mockElement('body') };
const store = {};
const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const window = { speechSynthesis: { speak: () => {}, cancel: () => {} }, addEventListener: () => {} };
const navigator = { clipboard: { writeText: () => Promise.resolve() } };
const sandbox = {
  elements, document, localStorage, window, navigator, console,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  alert: () => {}, confirm: () => true, prompt: () => null,
  Blob: class { constructor(p, o) { this.parts = p; this.opts = o || {}; } },
  // Keep the real URL constructor (isValidBridgeUrl parses with it) while
  // stubbing the blob helpers exportSettingsJson needs.
  URL: class extends URL { static createObjectURL() { return 'blob:mock'; } static revokeObjectURL() {} }
};
const fn = new Function(...Object.keys(sandbox), code + `
return {
  isValidBridgeUrl, collectScannerStore, collectScannerStores, prepareBackup,
  collectPortableState, qldParseSleeveInput, qldApplySleeveEdit,
  qldRecordPendingFill, qldApplyPendingFill, findElById, journalResult,
  tradeReportQty, journalFees,
  set signalSyncMode(v) { signalSyncMode = v; },
  set qldSleeve(v) { qldSleeve = v; }, get qldSleeve() { return qldSleeve; },
  set qldView(v) { qldView = v; },
  set activeTradesLog(v) { activeTradesLog = v; }, get activeTradesLog() { return activeTradesLog; },
  set twsSeenExecs(v) { twsSeenExecs = v; },
  set customStrategies(v) { customStrategies = v; },
  set regimeStrategyMap(v) { regimeStrategyMap = v; }
};`);
const api = fn(...Object.values(sandbox));
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };
const assertThrows = (f, m) => { try { f(); } catch (e) { return; } throw new Error('ASSERT FAIL (no throw): ' + m); };

const flatSleeve = (extra = {}) => ({ inPos: false, shares: 0, entryPrice: 0, entryDate: null, cashValue: 0, pending: null, pendingOrder: null, signalWeek: null, ...extra });

try {
  // ---------- isValidBridgeUrl (B14) ----------
  assert(api.isValidBridgeUrl('http://127.0.0.1:8787'), 'plain loopback URL ok');
  assert(api.isValidBridgeUrl('http://localhost:8787'), 'localhost ok');
  assert(api.isValidBridgeUrl('https://127.0.0.1:8787/'), 'https loopback ok');
  assert(!api.isValidBridgeUrl('http://localhost.evil.com'), 'prefix hostname rejected');
  assert(!api.isValidBridgeUrl('http://127.0.0.1.evil.com'), 'prefix IP rejected');
  assert(!api.isValidBridgeUrl('http://user:pw@127.0.0.1:8787'), 'userinfo rejected');
  assert(!api.isValidBridgeUrl('http://127.0.0.1:8787/?x=1'), 'query rejected');
  assert(!api.isValidBridgeUrl('http://127.0.0.1:8787/extra'), 'path rejected');
  assert(!api.isValidBridgeUrl('ftp://127.0.0.1:8787'), 'non-http scheme rejected');
  assert(!api.isValidBridgeUrl('http://192.168.1.50:8787'), 'LAN IP rejected');
  assert(!api.isValidBridgeUrl('not a url'), 'garbage rejected');
  assert(!api.isValidBridgeUrl(''), 'empty rejected');

  // ---------- collectScannerStore / collectScannerStores (B01) ----------
  // Seed three independent stores; the collection must not depend on the DOM.
  localStorage.setItem('ticker_0', 'SPY');
  localStorage.setItem('trigger_0', '50');
  localStorage.setItem('signalSides', JSON.stringify({ 0: 'LONG' }));
  localStorage.setItem('visibleCount', '6');
  localStorage.setItem('riskValue', '250');
  localStorage.setItem('pg_lsv3_ticker_0', 'QQQ');
  localStorage.setItem('pg_lsv3_riskValue', '100');
  localStorage.setItem('pg_pb_pbSignals', JSON.stringify([{ ticker: 'xle', tf: 'weekly', cat: 'etf_w', atrOverride: null }]));
  localStorage.setItem('pg_pb_visibleCount', '9');

  const shared = api.collectScannerStore('');
  assert(shared.tickers[0] === 'SPY' && shared.triggers[0] === '50', 'shared store reads storage not DOM');
  assert(shared.sides[0] === 'LONG' && shared.visibleCount === 6 && shared.riskValue === 250, 'shared sides/visible/risk');
  const all = api.collectScannerStores();
  assert(all.scanner.tickers[0] === 'SPY', 'scanner store in collection');
  assert(all.lsv3.tickers[0] === 'QQQ' && all.lsv3.riskValue === 100, 'lsv3 store independent');
  assert(all.pullback.pb.length === 1 && all.pullback.pb[0].ticker === 'xle', 'pullback pb list collected');
  assert(all.pullback.visibleCount === 9, 'pullback visibleCount collected');

  // ---------- collectPortableState (B01/B07/B08) ----------
  api.qldSleeve = flatSleeve({ shares: 12, inPos: true, entryPrice: 80 });
  api.twsSeenExecs = new Map([['20260101|ex1', 1.0], ['20260101|ex2', null]]);
  const snap = api.collectPortableState();
  assert(snap.scannerStores && snap.scannerStores.lsv3.tickers[0] === 'QQQ', 'portable state includes scannerStores');
  assert(snap.qldSleeve && snap.qldSleeve.shares === 12, 'portable state includes qldSleeve');
  assert(Array.isArray(snap.twsSeenExecs) && snap.twsSeenExecs.length === 2, 'exec receipts serialized');
  assert(snap.twsSeenExecs[0][0] === '20260101|ex1' && snap.twsSeenExecs[0][1] === 1.0, 'exec fee pairs serialized');
  assert(!('twsBridgeUrl' in snap) || snap.twsBridgeUrl === undefined, 'bridge url excluded');
  assert(!('twsBridgeToken' in snap) || snap.twsBridgeToken === undefined, 'bridge token excluded');
  assert(snap.apiKeys && typeof snap.apiKeys === 'object', 'apiKeys object present');
  assert(snap.version === '3.9.0', 'portable version synced');

  // ---------- prepareBackup: real producer shapes must validate (B02) ----------
  const backup = {
    version: '3.9.0',
    activeTradesLog: [
      // QLD journal row â€” no stop, no targets, null holdLimit.
      { id: 1, ticker: 'QLD', side: 'LONG', sleeve: 'QLD', strategyId: 'qld', regime: 'QLD Trend',
        holdLimit: null, holdUnit: 'week', targets: [], entryDate: '2026-01-05', entryPrice: 80,
        shares: 12, stopPrice: null, tp1: null, tp2: null, status: 'ACTIVE' },
      // Fully closed TWS row â€” shares drained to zero by broker fills.
      { id: 2, ticker: 'AAPL', side: 'LONG', strategyId: 'opt1', regime: 'TWS fill', fillSource: 'tws',
        entryDate: '2026-01-06', entryPrice: 100, shares: 0, stopPrice: 95, status: 'CLOSED',
        exitDate: '2026-01-07', exitPrice: 110, totalQty: 50, closedQty: 50, realizedPnl: 496 }
    ],
    qldSleeve: flatSleeve({
      inPos: true, shares: 12, entryPrice: 80, entryDate: '2026-01-05',
      pendingOrder: {
        orderRef: 'PSC-QLD-abc', orderId: 42, action: 'ADD', side: 'BUY', requestedQty: 10,
        baseline: { shares: 12, entryPrice: 80, entryDate: '2026-01-05', cashValue: 0 },
        execKeys: {}, filledQty: 0, avgFillPrice: 0, status: 'submitted'
      }
    }),
    scannerStores: {
      lsv3: { tickers: ['MSFT'], triggers: [''], visibleCount: 3, sides: {}, pb: [] },
      pullback: { tickers: [], triggers: [], visibleCount: 3, sides: {}, pb: [{ ticker: 'SPY', tf: 'daily', cat: 'auto', atrOverride: 2.5 }] }
    },
    twsBridgeUrl: 'http://attacker.example',   // machine-local: dropped, not fatal
    twsBridgeToken: 'stale-token'
  };
  const prepared = api.prepareBackup(backup);
  assert(prepared.activeTradesLog, 'journal rows accepted');
  const restored = JSON.parse(prepared.activeTradesLog);
  assert(restored.length === 2 && restored[1].shares === 0 && restored[1].fillSource === 'tws', 'closed tws row preserved');
  const rs = JSON.parse(prepared.qldSleeve);
  assert(rs.pendingOrder && rs.pendingOrder.orderRef === 'PSC-QLD-abc' && rs.pendingOrder.status === 'submitted', 'pendingOrder roundtrips');
  assert(rs.pendingOrder.baseline.shares === 12, 'pendingOrder baseline roundtrips');
  assert(prepared['pg_lsv3_ticker_0'] === 'MSFT', 'scannerStores restore into prefixed keys');
  assert(prepared['pg_pb_pbSignals'] && JSON.parse(prepared['pg_pb_pbSignals'])[0].ticker === 'SPY', 'pb store restored');
  assert(!('twsBridgeUrl' in prepared) && !('twsBridgeToken' in prepared), 'bridge fields dropped from restore values');
  assertThrows(() => api.prepareBackup({ version: '3.9.0', scannerStores: { bogus: {} } }), 'unknown scanner store rejected');
  assertThrows(() => api.prepareBackup({ version: '3.9.0', activeTradesLog: [{ id: 1, ticker: 'XX', side: 'LONG', status: 'ACTIVE', shares: 'lots' }] }), 'malformed trade rejected');

  // ---------- qldParseSleeveInput + qldApplySleeveEdit (B16) ----------
  let p = api.qldParseSleeveInput('300 @ 82.50', 0);
  assert(p.kind === 'position' && p.shares === 300 && p.price === 82.5, 'position parse');
  p = api.qldParseSleeveInput('1,000 @ $45.25', 0);
  assert(p.shares === 1000 && Math.abs(p.price - 45.25) < 1e-9, 'comma+$ parse');
  assert(api.qldParseSleeveInput('cash 20000').cash === 20000, 'cash parse');
  assert(api.qldParseSleeveInput('flat').kind === 'flat' && api.qldParseSleeveInput('flat').wipeCash === false, 'flat keeps reserve');
  assert(api.qldParseSleeveInput('flat 0').wipeCash === true && api.qldParseSleeveInput('0').wipeCash === true, 'flat 0 wipes reserve');
  assert(api.qldParseSleeveInput('300', 0).error, 'no price + no fallback â†’ error (never a zero-price row)');
  assert(api.qldParseSleeveInput('300', 90).price === 90, 'fallback price used');
  assert(api.qldParseSleeveInput('300 @ 0').error, 'zero price rejected');
  assert(api.qldParseSleeveInput('garbage').error, 'garbage rejected');
  assert(api.qldParseSleeveInput('').error, 'empty rejected');

  api.qldSleeve = flatSleeve();
  api.qldView = { qldPrice: 80 };
  assert(api.qldApplySleeveEdit(api.qldParseSleeveInput('10 @ 80', 80)), 'position apply');
  assert(api.qldSleeve.inPos && api.qldSleeve.shares === 10 && api.qldSleeve.entryPrice === 80, 'sleeve set');
  assert(api.qldApplySleeveEdit(api.qldParseSleeveInput('flat', 0)), 'flat apply');
  assert(!api.qldSleeve.inPos && api.qldSleeve.shares === 0 && api.qldSleeve.cashValue === 800, 'flat banked reserve at price');

  // ---------- pendingOrder confirmed-fill application (B06) ----------
  api.qldSleeve = flatSleeve({ shares: 100, inPos: true, entryPrice: 50, entryDate: '2026-01-01', cashValue: 2000 });
  api.qldSleeve.pendingOrder = {
    orderRef: 'PSC-QLD-t1', orderId: 9, action: 'EXIT', side: 'SELL', requestedQty: 100,
    baseline: { shares: 100, entryPrice: 50, entryDate: '2026-01-01', cashValue: 2000 },
    execKeys: {}, filledQty: 0, avgFillPrice: 0, status: 'submitted'
  };
  // Partial fill 30 @ 55 â†’ ledger loses 30, gains 30*55 cash; order stays 'partial'.
  assert(api.qldRecordPendingFill('d|e1', 30, 55), 'first fill recorded');
  assert(api.qldSleeve.shares === 70 && api.qldSleeve.inPos, 'partial sell decrements ledger');
  assert(Math.abs(api.qldSleeve.cashValue - (2000 + 1650)) < 1e-9, 'EXIT proceeds into reserve');
  assert(api.qldSleeve.pendingOrder && api.qldSleeve.pendingOrder.status === 'partial', 'partial status');
  // Replay of the same exec key is ignored â€” no double decrement.
  assert(!api.qldRecordPendingFill('d|e1', 30, 55), 'exec key dedupe');
  assert(api.qldSleeve.shares === 70, 'no double apply');
  // Remainder fills â†’ pendingOrder clears, pending action resolves.
  assert(api.qldRecordPendingFill('d|e2', 70, 56), 'second fill recorded');
  assert(api.qldSleeve.shares === 0 && !api.qldSleeve.inPos, 'full exit flattens');
  assert(api.qldSleeve.pendingOrder === null, 'completed order cleared');
  assert(api.qldSleeve.pending === null, 'pending action cleared on completion');

  // ENTER applies baseline + fills, consumes reserve.
  api.qldSleeve = flatSleeve({ cashValue: 5000 });
  api.qldSleeve.pending = { type: 'ENTER', reason: 'WEEKLY', queuedAt: '2026-01-05' };
  api.qldSleeve.pendingOrder = {
    orderRef: 'PSC-QLD-t2', orderId: 10, action: 'ENTER', side: 'BUY', requestedQty: 50,
    baseline: { shares: 0, entryPrice: 0, entryDate: null, cashValue: 5000 },
    execKeys: {}, filledQty: 0, avgFillPrice: 0, status: 'submitted'
  };
  api.qldRecordPendingFill('d|e9', 50, 90);
  assert(api.qldSleeve.shares === 50 && api.qldSleeve.entryPrice === 90, 'enter fill sets position');
  assert(api.qldSleeve.cashValue === 500, 'ENTER consumes reserve');
  assert(api.qldSleeve.pendingOrder === null && api.qldSleeve.pending === null, 'enter completion clears both');

  // ADD (rebalance into sleeve) must NOT consume the reserve.
  api.qldSleeve = flatSleeve({ shares: 40, inPos: true, entryPrice: 80, entryDate: '2026-01-01', cashValue: 1000 });
  api.qldSleeve.pendingOrder = {
    orderRef: 'PSC-QLD-t3', orderId: 11, action: 'ADD', side: 'BUY', requestedQty: 10,
    baseline: { shares: 40, entryPrice: 80, entryDate: '2026-01-01', cashValue: 1000 },
    execKeys: {}, filledQty: 0, avgFillPrice: 0, status: 'submitted'
  };
  api.qldRecordPendingFill('d|e10', 10, 100);
  assert(api.qldSleeve.shares === 50 && Math.abs(api.qldSleeve.entryPrice - 84) < 1e-9, 'ADD VWAP against baseline');
  assert(api.qldSleeve.cashValue === 1000, 'ADD leaves reserve untouched');

  // TRIM proceeds leave the sleeve (not into reserve).
  api.qldSleeve = flatSleeve({ shares: 50, inPos: true, entryPrice: 80, entryDate: '2026-01-01', cashValue: 1000 });
  api.qldSleeve.pendingOrder = {
    orderRef: 'PSC-QLD-t4', orderId: 12, action: 'TRIM', side: 'SELL', requestedQty: 10,
    baseline: { shares: 50, entryPrice: 80, entryDate: '2026-01-01', cashValue: 1000 },
    execKeys: {}, filledQty: 0, avgFillPrice: 0, status: 'submitted'
  };
  api.qldRecordPendingFill('d|e11', 10, 90);
  assert(api.qldSleeve.shares === 40 && api.qldSleeve.cashValue === 1000, 'TRIM proceeds leave sleeve');
  assert(api.qldSleeve.pendingOrder === null, 'TRIM completes');

  // ---------- findElById: literal id lookup, dotted tickers (B12) ----------
  const leaf = { id: 'card-BRK.B', children: [] };
  const mid = { id: 'x', children: [leaf] };
  const rootEl = { id: 'root', children: [{ id: 'other', children: [] }, mid] };
  assert(api.findElById(rootEl, 'card-BRK.B') === leaf, 'dotted id found literally');
  assert(api.findElById(rootEl, 'card-BRK') === null, 'prefix does not match');
  assert(api.findElById(rootEl, 'root') === rootEl, 'root itself matches');
  assert(api.findElById(null, 'x') === null, 'null root safe');

  // ---------- journalResult: stored P&L preferred, report qty (B08) ----------
  const closedTws = { side: 'LONG', entryPrice: 10, exitPrice: 14, shares: 0, totalQty: 250,
    pnl: 546, stopPrice: 9, entryDate: '2026-01-05', exitDate: '2026-01-08', fillSource: 'tws' };
  const jr = api.journalResult(closedTws);
  assert(Math.abs(jr.pnl - 546) < 1e-9, 'stored realized P&L returned, not recomputed on zero shares');
  assert(jr.rMultiple > 0, 'R uses original qty risk');
  // Manual close without stored pnl still recomputes on reporting qty.
  const manual = { side: 'LONG', entryPrice: 10, exitPrice: 12, shares: 0, totalQty: 100,
    stopPrice: 9, entryDate: '2026-01-05', exitDate: '2026-01-06' };
  const jm = api.journalResult(manual);
  assert(Math.abs(jm.pnl - 200) < 1e-9, 'manual close recomputes on totalQty not remaining shares');

  console.log('All portable/backup tests passed');
} catch (e) {
  console.error(e.stack || e);
  process.exit(1);
}
