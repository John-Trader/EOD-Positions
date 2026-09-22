// Tests for scheduled auto-entry: timing gate, candidate evaluation filters,
// task rebuild from scanner stores, and schema registration of the new keys.
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = h.slice(h.indexOf('<script>') + 8, h.lastIndexOf('</script>'));
const S = require('./state-schema.js');

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
const window = { speechSynthesis: { speak: () => {}, cancel: () => {} }, addEventListener: () => {} };
const navigator = { clipboard: { writeText: () => Promise.resolve() } };
const sandbox = {
  elements, document, localStorage, window, navigator, console,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  alert: () => {}, confirm: () => true, prompt: () => null
};
const fn = new Function(...Object.keys(sandbox), code + `
return {
  autoEntryDue, autoEntryEvaluate, parseAutoEntryTime, buildAutoEntryTasks, nyNow, twsSendKey,
  set accountValue(v) { accountValue = v; },
  set signalSyncMode(v) { signalSyncMode = v; },
  set twsSendState(v) { for (const k in v) twsSendState[k] = v[k]; },
  get twsSendState() { return twsSendState; }
};`);
const api = fn(...Object.values(sandbox));
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };

try {
  // ---------- parseAutoEntryTime ----------
  assert(api.parseAutoEntryTime('15:58') === 958, '15:58 -> 958');
  assert(api.parseAutoEntryTime('09:30') === 570, '09:30 -> 570');
  assert(api.parseAutoEntryTime('00:00') === 0, 'midnight -> 0');
  assert(api.parseAutoEntryTime('junk') === null, 'junk rejected');
  assert(api.parseAutoEntryTime('24:00') === null, '24:00 rejected');
  assert(api.parseAutoEntryTime('15:60') === null, '15:60 rejected');
  assert(api.parseAutoEntryTime('') === null, 'empty rejected');

  // ---------- autoEntryDue ----------
  const nyAt = (iso) => api.nyNow(new Date(iso));
  const tue1558 = nyAt('2026-09-01T19:58:00Z');           // Tue 15:58 ET, RTH
  assert(tue1558.isTradingDay && tue1558.isRTH && tue1558.minutesOfDay === 958, 'fixture is Tue 15:58 ET RTH');
  assert(api.autoEntryDue(tue1558, 958, null) === true, 'due at target minute');
  assert(api.autoEntryDue(nyAt('2026-09-01T19:57:00Z'), 958, null) === false, 'not due before target');
  assert(api.autoEntryDue(nyAt('2026-09-01T19:59:30Z'), 958, null) === true, 'catch-up after target within RTH');
  assert(api.autoEntryDue(nyAt('2026-09-01T20:00:00Z'), 958, null) === false, 'not due after close');
  assert(api.autoEntryDue(nyAt('2026-09-05T19:58:00Z'), 958, null) === false, 'not due on Saturday');
  assert(api.autoEntryDue(nyAt('2026-09-07T19:58:00Z'), 958, null) === false, 'not due on Labor Day');
  assert(api.autoEntryDue(nyAt('2026-09-01T13:25:00Z'), 958, null) === false, 'not due pre-market');
  assert(api.autoEntryDue(tue1558, 958, { date: '2026-09-01', done: true }) === false, 'done latches same day');
  assert(api.autoEntryDue(nyAt('2026-09-02T19:58:00Z'), 958, { date: '2026-09-01', done: true }) === true, 'next day fires again');
  assert(api.autoEntryDue(tue1558, null, null) === false, 'invalid time never due');

  // ---------- autoEntryEvaluate ----------
  const deps = (over) => Object.assign({
    risk: 500, slippage: 0.10,
    posFor: () => null,
    dupOrdersFor: () => [],
    sendState: {},
    ordersEnabled: true
  }, over || {});
  const v3 = (ticker, trigger, data, extra) => Object.assign({ ticker, kind: 'v3', trigger, signalSide: null, data, success: true }, extra || {});
  const decide = (items, d) => api.autoEntryEvaluate(items, deps(d));

  // Long: green day, price above trigger -> send
  let r = decide([v3('AAA', 100, { c: 101, h: 102, l: 99, pc: 90 })]);
  assert(r[0].send === true, 'v3 long above trigger sends');
  // Short: red day, price below trigger -> send
  r = decide([v3('BBB', 100, { c: 99, h: 100, l: 98, pc: 110 })]);
  assert(r[0].send === true, 'v3 short below trigger sends');
  // Green day below trigger -> skip
  r = decide([v3('CCC', 100, { c: 99.5, h: 102, l: 99, pc: 90 })]);
  assert(r[0].send === false && r[0].reason === 'trigger not met', 'long below trigger skipped');
  // Red day above trigger -> skip
  r = decide([v3('DDD', 100, { c: 100.5, h: 101, l: 99, pc: 110 })]);
  assert(r[0].send === false && r[0].reason === 'trigger not met', 'short above trigger skipped');
  // Bid/ask gate: one side below trigger disqualifies even with c above
  r = decide([v3('EEE', 100, { c: 101, h: 102, l: 99, pc: 90, bid: 99.5, ask: 101 })]);
  assert(r[0].send === false, 'bid below trigger blocks long');
  // No shares sized (tiny risk) -> skip
  r = decide([v3('FFF', 100, { c: 101, h: 102, l: 99, pc: 90 })], { risk: 1 });
  assert(r[0].send === false && r[0].reason === 'no shares sized', 'zero shares skipped');
  // Quote failure -> skip
  r = decide([{ ticker: 'GGG', kind: 'v3', trigger: 100, success: false, error: 'x' }]);
  assert(r[0].send === false && r[0].reason === 'quote failed', 'failed quote skipped');
  // Held position (either direction) -> skip
  r = decide([v3('HHH', 100, { c: 101, h: 102, l: 99, pc: 90 })], { posFor: () => ({ qty: 12, avgCost: 95 }) });
  assert(r[0].send === false && r[0].reason === 'position held', 'held position skipped');
  r = decide([v3('HHH', 100, { c: 101, h: 102, l: 99, pc: 90 })], { posFor: () => ({ qty: -12, avgCost: 95 }) });
  assert(r[0].send === false, 'held short skipped too');
  // Prior send states -> skip, never auto-retry
  for (const st of ['sending', 'sent', 'unknown']) {
    r = decide([v3('III', 100, { c: 101, h: 102, l: 99, pc: 90 })], { sendState: { 'III:entry': st } });
    assert(r[0].send === false, 'sendState ' + st + ' skipped');
  }
  // Working PSC order on either side -> skip
  r = decide([v3('JJJ', 100, { c: 101, h: 102, l: 99, pc: 90 })], { dupOrdersFor: (t, a) => (a === 'SELL' ? [{ orderId: 1 }] : []) });
  assert(r[0].send === false && r[0].reason === 'working PSC order', 'working SELL PSC order blocks');
  // ordersEnabled off -> dup check bypassed
  r = decide([v3('JJJ', 100, { c: 101, h: 102, l: 99, pc: 90 })], { ordersEnabled: false, dupOrdersFor: () => [{ orderId: 1 }] });
  assert(r[0].send === true, 'orders-disabled skips dup check');

  // Pullback: valid sized signal sends (no trigger gate)
  api.accountValue = 100000;
  const pb = (ticker, extra) => Object.assign({ ticker, kind: 'pb', tf: 'weekly', cat: 'nas_w', atrOverride: 2, signalSide: 'LONG', data: { c: 50, h: 51, l: 49, pc: 48 }, success: true }, extra || {});
  r = decide([pb('PPP')]);
  assert(r[0].send === true, 'pb sized signal sends');
  // Pullback without category resolvable -> skip
  r = decide([pb('QQQ2', { tf: 'daily', cat: 'auto', atrOverride: 2 })].map(o => { o.ticker = 'ZZZ'; return o; }));
  assert(r[0].send === false && r[0].reason === 'no category', 'pb daily non-ETF skipped');
  // Pullback missing ATR entirely -> no shares -> skip
  r = decide([Object.assign(pb('RRR'), { atrOverride: null })]);
  assert(r[0].send === false, 'pb without ATR skipped');

  // ---------- buildAutoEntryTasks (store-driven, per-page union) ----------
  api.signalSyncMode = 'perPage';
  store['ticker_0'] = 'AAA'; store['trigger_0'] = '100'; store['visibleCount'] = '3';
  store['signalSides'] = '{"0":"SHORT"}';
  store['pg_lsv3_ticker_0'] = 'BBB'; store['pg_lsv3_trigger_0'] = '50'; store['pg_lsv3_visibleCount'] = '3';
  store['pbSignals'] = '[{"ticker":"PCC","tf":"weekly","cat":"nas_w","atrOverride":null}]';
  store['pg_pb_pbSignals'] = '[{"ticker":"PDD","tf":"daily","cat":"etf_d","atrOverride":1.5}]';
  const tasks = api.buildAutoEntryTasks();
  const v3t = tasks.filter(t => t.kind === 'v3').map(t => t.ticker);
  const pbt = tasks.filter(t => t.kind === 'pb').map(t => t.ticker);
  assert(v3t.includes('AAA') && v3t.includes('BBB'), 'v3 union across scanner+lsv3 stores: ' + v3t);
  assert(pbt.includes('PCC') && pbt.includes('PDD'), 'pb union across scanner+pullback stores: ' + pbt);
  assert(tasks.find(t => t.ticker === 'AAA').signalSide === 'SHORT', 'signalSide carried from store');
  assert(tasks.find(t => t.ticker === 'AAA').trigger === 100, 'trigger parsed');
  // dedupe: same ticker in scanner + lsv3 collapses
  store['pg_lsv3_ticker_1'] = 'AAA'; store['pg_lsv3_trigger_1'] = '77';
  const tasks2 = api.buildAutoEntryTasks();
  assert(tasks2.filter(t => t.kind === 'v3' && t.ticker === 'AAA').length === 1, 'v3 ticker deduped across pages');
  api.signalSyncMode = 'shared';

  // ---------- schema registration ----------
  ['autoEntryEnabled', 'autoEntryTime', 'autoEntryRun'].forEach(k => {
    assert(S.knownKey(k), 'registry knows ' + k);
  });
  const st = S.createEmpty({ datasetId: 'ds_ae', now: 1 });
  assert(S.setByKey(st, 'autoEntryEnabled', 'true'), 'set autoEntryEnabled');
  assert(S.getString(st, 'autoEntryEnabled') === 'true', 'get autoEntryEnabled');
  assert(st.local.tws.autoEntryEnabled === 'true', 'lands in local.tws');
  assert(S.setByKey(st, 'autoEntryTime', '15:58'), 'set autoEntryTime');
  assert(S.setByKey(st, 'autoEntryRun', '{"date":"2026-09-01","done":true,"results":{"AAA":{"status":"sent","msg":""}}}'), 'set autoEntryRun');
  assert(st.local.autoEntryRun.done === true, 'autoEntryRun typed object');
  const backup = S.encode(st, { purpose: 'backup' });
  assert(JSON.stringify(backup).indexOf('autoEntry') < 0, 'backup excludes auto-entry (machine-local)');
  const portable = S.encode(st, { purpose: 'portable' });
  assert(portable.local.tws.autoEntryEnabled === 'true', 'portable keeps auto-entry settings');
  assert(portable.local.autoEntryRun.done === true, 'portable keeps run record');
  const syncEnc = S.encode(st, { purpose: 'sync' });
  assert(JSON.stringify(syncEnc).indexOf('autoEntry') < 0, 'sync excludes auto-entry');

  console.log('auto-entry tests passed!');
} catch (e) {
  console.error('auto-entry test failed:', e);
  process.exit(1);
}
