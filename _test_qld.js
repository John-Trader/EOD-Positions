// Tests for the QLD Trend tracker: weekly resample, TV-style EMA, the persisted
// pending-action queue (weekly switch + month-end band), broker-verified sleeve
// math (cashValue carry-over), and the chart SVG.
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
  URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} }
};
const fn = new Function(...Object.keys(sandbox), code + `
return {
  emaLast, emaSeries, resampleDailyToWeekly, qldPendingAction, qldEvaluatePending,
  qldPendingSpec, qldReality, qldExecute, qldChartSvg, weeksElapsedSince,
  mondayOf, addCalendarDays, isCurrentWeekForming, isLastTradingDayOfMonth, nyDateStr,
  set qldView(v) { qldView = v; },
  get qldView() { return qldView; },
  set qldSleeve(v) { qldSleeve = v; },
  get qldSleeve() { return qldSleeve; },
  set qldTargetPct(v) { qldTargetPct = v; }, set qldBandPct(v) { qldBandPct = v; },
  set accountValue(v) { accountValue = v; },
  set twsPositionsEnabled(v) { twsPositionsEnabled = v; },
  set twsPositions(v) { twsPositions = v; },
  set twsLastPositionsAt(v) { twsLastPositionsAt = v; },
  set twsSyncAccount(v) { twsSyncAccount = v; },
  set twsLastAccountValue(v) { twsLastAccountValue = v; },
  set twsConnected(v) { twsConnected = v; },
  get activeTradesLog() { return activeTradesLog; },
  set activeTradesLog(v) { activeTradesLog = v; }
};`);
const api = fn(...Object.values(sandbox));
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };

const flatSleeve = (extra = {}) => ({ inPos: false, shares: 0, entryPrice: 0, entryDate: null, cashValue: 0, pending: null, signalWeek: null, ...extra });

try {
  // ---------- 1. EMA: emaLast + emaSeries (first-value seed, k=2/(n+1)) ----------
  const flat = Array(40).fill(50);
  assert(Math.abs(api.emaLast(flat, 12) - 50) < 1e-9, 'EMA of constant series = constant');
  const ramp = Array.from({ length: 60 }, (_, i) => 100 + i);
  const e12 = api.emaLast(ramp, 12), e26 = api.emaLast(ramp, 26);
  assert(e12 > e26, 'ramp: EMA12 > EMA26');
  assert(api.emaLast(ramp.slice(0, 20), 26) === null, 'insufficient bars -> null');
  const k6 = 2 / 7;
  let man = 10;
  [12, 14, 16, 18, 20].forEach(v => { man = v * k6 + man * (1 - k6); });
  assert(Math.abs(api.emaLast([10, 12, 14, 16, 18, 20], 6) - man) < 1e-9, 'EMA matches first-value-seeded iteration');
  // emaSeries: full array, last element equals emaLast, nulls on non-finite input.
  const ser = api.emaSeries(ramp, 12);
  assert(ser.length === ramp.length, 'emaSeries length = input length');
  assert(Math.abs(ser[ser.length - 1] - e12) < 1e-9, 'emaSeries tail == emaLast');
  assert(ser[0] === 100, 'emaSeries[0] seeds from first value');

  // ---------- 2. Weekly pending queue ----------
  api.accountValue = 100000; api.qldTargetPct = 35; api.qldBandPct = 5;
  api.twsPositionsEnabled = false; api.twsSyncAccount = false; api.twsLastAccountValue = 0; api.twsLastPositionsAt = 0;
  api.qldView = { signal: 'LONG', qldPrice: 80, lastWeekT: '2026-09-07', weekly: [] };
  api.qldSleeve = flatSleeve();
  api.qldEvaluatePending();
  assert(api.qldPendingAction() === 'ENTER', 'LONG + flat -> queued ENTER');
  assert(api.qldSleeve.pending.reason === 'WEEKLY', 'ENTER reason = weekly');
  assert(api.qldSleeve.signalWeek === '2026-09-07', 'signalWeek stamped');

  // Same week re-eval is idempotent (no re-queue churn).
  api.qldEvaluatePending();
  assert(api.qldPendingAction() === 'ENTER', 'same-week re-eval keeps ENTER');

  // Next completed week, signal still LONG but still flat -> stays ENTER.
  api.qldView = { ...api.qldView, lastWeekT: '2026-09-14' };
  api.qldEvaluatePending();
  assert(api.qldPendingAction() === 'ENTER', 'unchanged flip keeps ENTER');

  // FLAT signal + in position -> EXIT.
  api.qldView = { ...api.qldView, signal: 'FLAT', lastWeekT: '2026-09-21' };
  api.qldSleeve = flatSleeve({ inPos: true, shares: 400, entryPrice: 78, entryDate: '2026-08-01' });
  api.qldEvaluatePending();
  assert(api.qldPendingAction() === 'EXIT', 'FLAT + in pos -> queued EXIT');

  // Signal reverts back to LONG before execution -> pending cleared.
  api.qldView = { ...api.qldView, signal: 'LONG', lastWeekT: '2026-09-28' };
  api.qldEvaluatePending();
  assert(api.qldPendingAction() === null, 'signal reverted -> weekly pending cleared');

  // ---------- 3. Month-end band gating ----------
  // Mid-month: out-of-band drift queues NOTHING (month-end-only check).
  api.qldView = { signal: 'LONG', qldPrice: 80, lastWeekT: '2026-10-05', weekly: [] };
  api.qldSleeve = flatSleeve({ inPos: true, shares: 100, entryPrice: 80, entryDate: '2026-08-01', signalWeek: '2026-10-05' });
  const todayMonthEnd = api.isLastTradingDayOfMonth(api.nyDateStr());
  api.qldEvaluatePending();
  if (!todayMonthEnd) {
    assert(api.qldPendingAction() === null, 'mid-month drift -> no rebalance queued');
  } else {
    // 100*80=$8k of $100k = 8% << 30% -> ADD queued.
    assert(api.qldPendingAction() === 'ADD', 'month-end + below band -> ADD');
    assert(api.qldSleeve.pending.reason === 'MONTH_END', 'ADD reason = month_end');
  }

  // Stale month-end pending + sleeve back in band -> cleared on next eval.
  api.qldSleeve = flatSleeve({ inPos: true, shares: 437, entryPrice: 80, entryDate: '2026-08-01', signalWeek: '2026-10-12',
    pending: { type: 'TRIM', reason: 'MONTH_END', month: '2020-01', queuedAt: '2020-01-31' } });
  api.qldView = { ...api.qldView, lastWeekT: '2026-10-12' };
  api.qldEvaluatePending();
  if (!todayMonthEnd) assert(api.qldPendingAction() === null, 'stale month-end pending cleared when back in band');

  // ---------- 4. qldPendingSpec sizing (sleeve value incl. cash) ----------
  api.qldSleeve = flatSleeve({ cashValue: 40000 });
  let r = api.qldReality();
  let spec = api.qldPendingSpec({ type: 'ENTER' }, r, 80);
  assert(spec.side === 'BUY' && spec.shares === 500, 'ENTER deploys sleeve cash: 40000/80 = 500 sh');
  api.qldSleeve = flatSleeve({ cashValue: 0 });
  spec = api.qldPendingSpec({ type: 'ENTER' }, api.qldReality(), 80);
  assert(spec.shares === Math.floor(35000 / 80), 'ENTER with no reserve falls back to 35% target');
  api.qldSleeve = flatSleeve({ inPos: true, shares: 400, entryPrice: 78 });
  spec = api.qldPendingSpec({ type: 'EXIT' }, api.qldReality(), 80);
  assert(spec.side === 'SELL' && spec.shares === 400, 'EXIT sells the whole position');
  // ADD/TRIM diff to the 35% target.
  api.qldSleeve = flatSleeve({ inPos: true, shares: 200, entryPrice: 80 }); // $16k vs $35k target -> $19k diff
  spec = api.qldPendingSpec({ type: 'ADD' }, api.qldReality(), 80);
  assert(spec.side === 'BUY' && spec.shares === Math.floor(19000 / 80), 'ADD buys the gap to target');
  api.qldSleeve = flatSleeve({ inPos: true, shares: 600, entryPrice: 80 }); // $48k vs $35k -> $13k trim
  spec = api.qldPendingSpec({ type: 'TRIM' }, api.qldReality(), 80);
  assert(spec.side === 'SELL' && spec.shares === Math.round(13000 / 80), 'TRIM sells the excess');

  // ---------- 5. Broker-verified reality ----------
  api.twsPositionsEnabled = true; api.twsConnected = true; api.twsLastPositionsAt = Date.now();
  api.twsPositions = { QLD: { qty: 437, avgCost: 79, mktPrice: 81 } };
  api.qldSleeve = flatSleeve({ inPos: true, shares: 400, entryPrice: 78 });
  r = api.qldReality();
  assert(r.shares === 437 && r.mismatch === true, 'broker qty wins + mismatch flagged');
  api.twsPositions = {};
  r = api.qldReality();
  assert(r.shares === 0 && r.inPos === false, 'known-flat broker overrides ledger shares');
  // TWS NetLiq wins equity when sync is on.
  api.twsSyncAccount = true; api.twsLastAccountValue = 120000;
  r = api.qldReality();
  assert(r.equity === 120000 && r.equitySrc === 'TWS', 'NetLiq overrides manual account value');
  // Dropped bridge: stale positions must NOT size the sleeve — falls back to ledger.
  api.twsConnected = false;
  api.twsPositions = { QLD: { qty: 999, avgCost: 70, mktPrice: 90 } };
  api.qldSleeve = flatSleeve({ inPos: true, shares: 400, entryPrice: 78 });
  r = api.qldReality();
  assert(r.shares === 400 && r.brokerKnown === false, 'disconnected bridge -> ledger, not stale broker');
  assert(r.equity === 100000 && r.equitySrc === 'manual', 'disconnected bridge -> manual equity');
  api.twsConnected = true;
  api.twsPositionsEnabled = false; api.twsSyncAccount = false; api.twsLastAccountValue = 0; api.twsLastPositionsAt = 0; api.twsPositions = {};

  // ---------- 6. qldExecute cash carry-over ----------
  api.qldSleeve = flatSleeve({ cashValue: 40000 });
  api.activeTradesLog = [];
  api.qldView = { ...api.qldView, qldPrice: 80 };
  api.qldExecute('ENTER', 500, 80, 'app');
  assert(api.qldSleeve.inPos && api.qldSleeve.shares === 500, 'ENTER opens position');
  assert(api.qldSleeve.cashValue === 0, 'ENTER consumes the reserve');
  assert(api.qldSleeve.pending === null, 'execute clears pending');
  const jr = api.activeTradesLog[0];
  assert(jr && jr.sleeve === 'QLD' && jr.strategyId === 'qld' && jr.holdUnit === 'week' && jr.shares === 500, 'journal record carries QLD sleeve shape');
  // TRIM: proceeds leave the sleeve (weight drops).
  api.qldExecute('TRIM', 100, 80, 'app');
  assert(api.qldSleeve.shares === 400 && api.qldSleeve.cashValue === 0, 'TRIM proceeds exit the sleeve');
  assert(api.qldSleeve.inPos === true, 'TRIM keeps position open');
  // EXIT: full proceeds become the cash reserve — ADDED to any leftover reserve.
  api.qldSleeve.cashValue = 1500; // leftover from a share-floored ENTER
  api.qldExecute('EXIT', 0, 82, 'app');
  assert(!api.qldSleeve.inPos && api.qldSleeve.shares === 0, 'EXIT flattens');
  assert(Math.abs(api.qldSleeve.cashValue - (1500 + 400 * 82)) < 1e-9, 'EXIT proceeds add to leftover reserve');
  assert(api.activeTradesLog.filter(t => t.sleeve === 'QLD' && t.status === 'ACTIVE').length === 0, 'flat -> no active QLD journal row');
  // CASH: sets reserve to 35% of equity.
  api.qldExecute('CASH', 0, 0, 'app');
  assert(api.qldSleeve.cashValue === 35000, 'CASH sets reserve to target');
  // ENTER averages against the BROKER position (qty + avgCost) when it's truth.
  api.twsPositionsEnabled = true; api.twsConnected = true; api.twsLastPositionsAt = Date.now();
  api.twsPositions = { QLD: { qty: 100, avgCost: 70, mktPrice: 80 } };
  api.qldSleeve = flatSleeve({ inPos: true, shares: 50, entryPrice: 78 }); // ledger stale
  api.qldExecute('ADD', 50, 80, 'app');
  assert(api.qldSleeve.shares === 150, 'ADD bases on broker count');
  assert(Math.abs(api.qldSleeve.entryPrice - (100 * 70 + 50 * 80) / 150) < 1e-9, 'ADD blends broker avgCost');
  api.twsPositionsEnabled = false; api.twsConnected = false; api.twsLastPositionsAt = 0; api.twsPositions = {};

  // ---------- 6b. Stale-premise pending clears ----------
  api.qldSleeve = flatSleeve({ inPos: true, shares: 400, entryPrice: 78,
    signalWeek: '2026-10-12', pending: { type: 'ENTER', reason: 'WEEKLY', queuedAt: '2026-10-12' } });
  api.qldView = { signal: 'LONG', qldPrice: 80, lastWeekT: '2026-10-12', weekly: [] };
  api.qldEvaluatePending();
  assert(api.qldPendingAction() === null, 'ENTER pending clears once already in position');
  api.qldSleeve = flatSleeve({ signalWeek: '2026-10-12', pending: { type: 'EXIT', reason: 'WEEKLY', queuedAt: '2026-10-12' } });
  api.qldEvaluatePending();
  // On a real month-end the band check queues CASH (0% < 30%) right after — still fine.
  assert(!api.qldSleeve.pending || api.qldSleeve.pending.reason === 'MONTH_END', 'EXIT pending clears once already flat');

  // ---------- 7. Chart SVG ----------
  const weekly = [];
  for (let i = 0; i < 20; i++) weekly.push({ t: api.addCalendarDays('2026-04-06', i * 7), o: 100 + i, h: 103 + i, l: 99 + i, c: 101 + i });
  api.qldView = { ...api.qldView, weekly, liveQqq: null };
  const svg = api.qldChartSvg();
  assert(svg.includes('<svg'), 'chart emits an <svg>');
  assert((svg.match(/<path/g) || []).length === 2, 'two EMA polylines');
  assert(svg.includes('<rect'), 'candles drawn as rects');
  if (api.isCurrentWeekForming(api.nyDateStr())) assert(svg.includes('LIVE WEEK'), 'forming week tagged when mid-week');

  console.log('QLD tracker tests passed!');
} catch (e) {
  console.error('QLD test failed:', e);
  process.exit(1);
}
