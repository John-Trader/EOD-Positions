// Tests for Portfolio T capacity + monthly-breaker helpers:
// journalBookedNotional (QLD excluded), admissionOrder (v3 first, desc stop %,
// pb ties etf_d→etf_w→nas_w), capProjection (FIT/OVER, advisory only),
// mtdRealizedPnl + circuitBreakerStatus (−9% realized threshold).
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = h.slice(h.indexOf('<script>') + 8, h.lastIndexOf('</script>'));

const elements = {};
function mockElement(id) {
  if (!elements[id]) elements[id] = {
    id, innerText: '', innerHTML: '', value: id === 'apiProvider' ? 'finnhub' : '', className: '', dataset: {}, style: {}, children: [],
    classList: { add: (...c) => { elements[id].className += ' ' + c.join(' '); }, remove: (...c) => { c.forEach(cls => elements[id].className = elements[id].className.replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim()); }, contains: (c) => elements[id].className.includes(c), toggle: () => {} },
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
  alert: () => {}, confirm: () => true, prompt: () => null,
  Blob: class { constructor(p, o) { this.parts = p; this.opts = o || {}; } },
  URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} }
};
const fn = new Function(...Object.keys(sandbox), code + `
return {
  journalBookedNotional, hasActiveJournal, candidateStopPct, admissionOrder,
  capProjection, mtdRealizedPnl, circuitBreakerStatus, currentMonthKey,
  PB_EXPOSURE_CAP, BREAKER_MONTHLY_PCT, selKeyFor,
  set accountValue(v) { accountValue = v; }, get accountValue() { return accountValue; },
  set activeTradesLog(v) { activeTradesLog = v; }, get activeTradesLog() { return activeTradesLog; },
  set lastCapProjection(v) { lastCapProjection = v; },
  capBadgeFor
};`);
const api = fn(...Object.values(sandbox));
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };
const near = (a, b, m) => assert(Math.abs(a - b) < 1e-9, m + ` (${a} vs ${b})`);

const MONTH = api.currentMonthKey();
const prevMonth = (() => { const [y, m] = MONTH.split('-').map(Number); const d = new Date(y, m - 2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();

const active = (ticker, shares, entry, opts = {}) => ({ ticker, status: 'ACTIVE', side: opts.side || 'LONG', shares, entryPrice: entry, sleeve: opts.sleeve || 'LS v3', ...opts });
const closed = (ticker, pnl, exitDate, opts = {}) => ({ ticker, status: 'CLOSED', side: 'LONG', shares: 100, entryPrice: 50, exitPrice: 45, exitDate, pnl, fees: 0, entryDate: exitDate, ...opts });

try {
  api.accountValue = 100000;

  // ---------- journalBookedNotional ----------
  api.activeTradesLog = [
    active('AAA', 100, 50),                    // $5,000
    active('BBB', 200, 25),                    // $5,000
    active('QLD', 500, 100, { sleeve: 'QLD' }),// excluded — outside the 210% cap
    closed('OLD', -100, MONTH + '-05'),        // closed → excluded
    { status: 'ACTIVE', shares: 10 },          // missing entryPrice → 0
  ];
  near(api.journalBookedNotional(), 10000, 'booked = 10k, QLD + closed + invalid excluded');
  near(api.PB_EXPOSURE_CAP, 2.10, 'cap constant is 2.10');

  // ---------- hasActiveJournal ----------
  assert(api.hasActiveJournal('AAA', true), 'AAA long is booked');
  assert(api.hasActiveJournal('AAA', false) === false, 'AAA long is not a booked short');
  assert(api.hasActiveJournal('QLD', true), 'QLD sleeve still counts as booked (dedupe is sleeve-agnostic)');
  assert(api.hasActiveJournal('ZZZ', true) === false, 'ZZZ not booked');

  // ---------- admissionOrder ----------
  api.activeTradesLog = [];
  const cands = [
    { key: 'P2', ticker: 'P2', kind: 'pb', pbCat: 'nas_w', entry: 100, stop: 90, notional: 1000 },   // 10%
    { key: 'V2', ticker: 'V2', kind: 'v3', entry: 100, stop: 95, notional: 1000 },                  // 5%
    { key: 'V1', ticker: 'V1', kind: 'v3', entry: 100, stop: 90, notional: 1000 },                  // 10%
    { key: 'P1', ticker: 'P1', kind: 'pb', pbCat: 'etf_d', entry: 100, stop: 90, notional: 1000 },  // 10%
    { key: 'P3', ticker: 'P3', kind: 'pb', pbCat: 'etf_w', entry: 100, stop: 90, notional: 1000 },  // 10%
  ];
  const order = api.admissionOrder(cands).map(c => c.key);
  assert(order.join(',') === 'V1,V2,P1,P3,P2', 'v3 first by desc stop%, pb ties etf_d→etf_w→nas_w — got ' + order.join(','));

  // ---------- capProjection ----------
  // account $100k, cap = $210k. Booked $150k → room $60k.
  api.activeTradesLog = [active('HLD', 1000, 150)];
  const proj = api.capProjection([
    { key: 'V1', ticker: 'V1', kind: 'v3', entry: 100, stop: 90, notional: 40000, isLong: true },  // +40% → 190% FIT
    { key: 'V2', ticker: 'V2', kind: 'v3', entry: 100, stop: 95, notional: 30000, isLong: true },  // +30% → 220% OVER
    { key: 'P1', ticker: 'P1', kind: 'pb', pbCat: 'etf_d', entry: 100, stop: 90, notional: 10000, isLong: true }, // +10% → 230% OVER
  ], 100000);
  near(proj.booked, 150000, 'booked 150k');
  near(proj.bookedPct, 1.5, 'booked 150%');
  near(proj.projectedPct, 2.0, 'model book = 200% (only accepted candidates)');
  near(proj.attemptedPct, 2.3, 'attempted = 230% (all candidates)');
  assert(proj.fitByKey['V1'].accepted === true && proj.fitByKey['V1'].order === 1, 'V1 FIT #1');
  assert(proj.fitByKey['V2'].accepted === false && proj.fitByKey['V2'].order === 2, 'V2 OVER #2');
  assert(proj.fitByKey['P1'].accepted === true && proj.fitByKey['P1'].order === 3, 'P1 FIT #3 — queue continues past V2 rejection');
  assert(proj.overCap.size === 1 && proj.overCap.has('V2'), 'overCap = {V2}');

  // exact-cap fit: booked 150k + 60k = 210k → FIT
  const exact = api.capProjection([{ key: 'X', ticker: 'X', kind: 'v3', entry: 100, stop: 90, notional: 60000, isLong: true }], 100000);
  assert(exact.fitByKey['X'].accepted === true, 'exactly at 210% still FITs');
  near(exact.projectedPct, 2.1, 'exact projection = 210%');

  // skip-ahead: a rejected large candidate doesn't block a smaller later one
  const skip = api.capProjection([
    { key: 'BIG', ticker: 'BIG', kind: 'v3', entry: 100, stop: 90, notional: 70000, isLong: true },   // 220% OVER
    { key: 'SML', ticker: 'SML', kind: 'v3', entry: 100, stop: 95, notional: 50000, isLong: true },   // 200% FIT
  ], 100000);
  assert(skip.fitByKey['BIG'].accepted === false, 'BIG OVER');
  assert(skip.fitByKey['SML'].accepted === true, 'smaller later candidate still FITs (no queue halt)');

  // already-booked ticker is not a new admission
  const dup = api.capProjection([{ key: 'HLD', ticker: 'HLD', kind: 'v3', entry: 150, stop: 140, notional: 100000, isLong: true }], 100000);
  assert(dup.fitByKey['HLD'].booked === true && dup.fitByKey['HLD'].accepted === false, 'booked row flagged booked, not double-counted');
  near(dup.projected, 150000, 'booked row adds no new notional');

  // advisory shape: capProjection returns flags, never throws/blocks
  assert(typeof proj.overCap === 'object' && typeof proj.fitByKey === 'object', 'projection is data-only (advisory)');

  // ---------- capBadgeFor (advisory text) ----------
  api.lastCapProjection = proj;
  const bOver = api.capBadgeFor('v3', 'V2');
  assert(bOver && /OVER/.test(bOver.text) && /still allowed|advisory/i.test(bOver.title), 'OVER badge says advisory');
  const bFit = api.capBadgeFor('v3', 'V1');
  assert(bFit && /FIT/.test(bFit.text), 'FIT badge');
  assert(api.capBadgeFor('v3', 'NOPE') === null, 'no badge for non-candidate');

  // ---------- mtdRealizedPnl ----------
  api.activeTradesLog = [
    closed('A', -1000, MONTH + '-05'),
    closed('B', -2000, MONTH + '-20'),
    closed('C', 500, MONTH + '-10'),
    closed('D', -9000, prevMonth + '-15'),   // last month → excluded
    active('E', 100, 50),                    // open → excluded
    { status: 'CLOSED', exitDate: MONTH + '-01' },  // no pnl/price → recomputes to 0 (invalid → 0)
    { status: 'CLOSED' },                    // no exitDate → skipped
  ];
  near(api.mtdRealizedPnl(MONTH), -2500, 'MTD realized = -1000 -2000 +500');
  near(api.mtdRealizedPnl(prevMonth), -9000, 'prev month isolated');

  // recomputation path when pnl not stored: LONG 100sh 50→45 = -500
  api.activeTradesLog = [{ ticker: 'R', status: 'CLOSED', side: 'LONG', shares: 100, entryPrice: 50, exitPrice: 45, exitDate: MONTH + '-03', entryDate: MONTH + '-01', fees: 0 }];
  near(api.mtdRealizedPnl(MONTH), -500, 'pnl recomputed when not stored');

  // ---------- circuitBreakerStatus ----------
  api.accountValue = 100000;
  api.activeTradesLog = [closed('A', -5000, MONTH + '-05')];
  assert(api.circuitBreakerStatus(MONTH).tripped === false, '-5% < 9% → not tripped');
  api.activeTradesLog = [closed('A', -9000, MONTH + '-05')];
  assert(api.circuitBreakerStatus(MONTH).tripped === true, 'exactly -9% trips');
  api.activeTradesLog = [closed('A', -12000, MONTH + '-05')];
  const s = api.circuitBreakerStatus(MONTH);
  assert(s.tripped === true, 'beyond -9% trips');
  near(s.mtdPct, -0.12, 'mtdPct -12%');
  api.activeTradesLog = [closed('A', -9000, prevMonth + '-28')];
  assert(api.circuitBreakerStatus(MONTH).tripped === false, 'prior-month loss does not trip');
  api.activeTradesLog = [closed('A', 20000, MONTH + '-05')];
  assert(api.circuitBreakerStatus(MONTH).tripped === false, 'gains never trip');
  api.accountValue = 0;
  api.activeTradesLog = [closed('A', -99999, MONTH + '-05')];
  assert(api.circuitBreakerStatus(MONTH).tripped === false, 'no account value → no breaker (cannot compute %)');
  api.accountValue = 100000;

  console.log('_test_portfolio OK');
} catch (e) {
  console.error(e.stack || e);
  process.exit(1);
}
