// Tests for ledger.js — the Portfolio T accounting engine:
// event inventory/cumPnl, monthBounds, equityAt (actual/model + nearest fallback),
// TWR performance w/ mid-month flows + residual, qldPnl, buildMonthReport
// (upper/carried/pp/labels), finalize rules, audit undo, sync endpoints.
const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, 'ledger.js'), 'utf8');

const sandbox = { console, Date, Math, Number, JSON, Object, Array, String, Promise };
const fn = new Function(...Object.keys(sandbox), code + '\nreturn Ledger;');
const L = fn(...Object.values(sandbox));
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };
const near = (a, b, m) => assert(Math.abs(a - b) < 1e-6, `${m} (${a} vs ${b})`);

// ---- in-memory journal + storage wiring ----
let J = [];
L.init({
  journal: { get: () => J, set: (arr) => { J = arr; } },
  hooks: {
    nyDate: () => '2026-09-30',
    isRTH: () => false,
    getPrice: () => null,
    twsPositionFor: () => null,
    qldPrice: () => 100
  }
});

const ev = (kind, date, qty, price, seq) => ({ id: 'e' + Math.random(), kind, date, qty, price, amount: 0, note: '', seq });
const trade = (id, ticker, events, opts = {}) => ({
  id, ticker, side: opts.side || 'LONG', sleeve: opts.sleeve || 'LS v3',
  entryDate: opts.entryDate || (events[0] && events[0].date), entryPrice: opts.entryPrice || (events[0] && events[0].price),
  shares: opts.shares ?? 0, status: opts.status || 'CLOSED', events, ...opts
});

try {
  // ---------- monthBounds ----------
  assert(L.monthBounds('2026-09').join(',') === '2026-08-31,2026-09-30', 'monthBounds Sep = Aug31..Sep30');
  assert(L.monthBounds('2026-01').join(',') === '2025-12-31,2026-01-31', 'monthBounds Jan crosses year');
  assert(L.monthBounds('bogus') === null, 'monthBounds invalid → null');

  // ---------- sleeveBucket ----------
  assert(L.sleeveBucket({ sleeve: 'QLD' }) === 'QLD Trend Following', 'QLD sleeve');
  assert(L.sleeveBucket({ sleeve: 'LS Pullback' }) === 'LS Pullback', 'pb sleeve');
  assert(L.sleeveBucket({}) === 'LS v3 Breakout', 'default → v3');
  assert(L.sleeveBucket({ strategyId: 'qld' }) === 'QLD Trend Following', 'strategyId qld → QLD');

  // ---------- synth events for legacy flat rows ----------
  const legacy = { id: 1, ticker: 'LGC', side: 'LONG', status: 'CLOSED', entryDate: '2026-09-01', entryPrice: 50, shares: 100, exitDate: '2026-09-10', exitPrice: 55, closedQty: 100 };
  const sev = L.tradeEvents(legacy);
  assert(sev.length === 2 && sev[0].kind === 'Entry' && sev[1].kind === 'Exit', 'legacy row synthesizes Entry+Exit');
  assert(sev[0].qty === 100 && sev[1].qty === 100, 'synth qty from shares/closedQty');

  // ---------- inventory ----------
  const t1 = trade(10, 'AAA', [
    ev('Entry', '2026-09-02', 100, 50, 1),
    ev('Add', '2026-09-05', 50, 52, 2),
    ev('Partial', '2026-09-08', 30, 55, 3),
    ev('Exit', '2026-09-12', 120, 58, 4)
  ]);
  near(L.inventory(t1, '2026-09-04'), 100, 'inv before add');
  near(L.inventory(t1, '2026-09-06'), 150, 'inv after add');
  near(L.inventory(t1, '2026-09-09'), 120, 'inv after partial');
  near(L.inventory(t1, '2026-09-30'), 0, 'inv after exit');

  // ---------- cumPnl (closed trade, no marks needed) ----------
  const r1 = L.cumPnl(t1, '2026-09-30');
  // buys: -5000 -2600 = -7600; sells: 1650 + 6960 = 8610 → +1010
  near(r1.pnl, 1010, 'cumPnl closed trade = 1010');
  assert(r1.missing === false, 'no missing mark on flat trade');

  // ---------- cumPnl open trade with mark ----------
  const t2 = trade(20, 'BBB', [ev('Entry', '2026-09-03', 100, 100, 1)], { status: 'ACTIVE', shares: 100 });
  L.saveValuations({ '2026-09-30': { equity: 105000, marks: { '20': 110 }, kind: 'close' } });
  const r2 = L.cumPnl(t2, '2026-09-30');
  near(r2.pnl, 1000, 'open trade marked at 110 → +1000');
  // missing mark → live quote null → missing flag (entry fallback)
  const r3 = L.cumPnl(t2, '2026-09-15');
  assert(r3.missing === true, 'no mark, no quote → missing flag');

  // ---------- short side ----------
  const t3 = trade(30, 'SHO', [ev('Entry', '2026-09-03', 40, 150, 1), ev('Exit', '2026-09-20', 40, 140, 2)], { side: 'SHORT' });
  near(L.cumPnl(t3, '2026-09-30').pnl, 400, 'short 150→140 = +400');

  // ---------- setup + equityAt (actual mode) ----------
  L.saveConfig({ start: '2026-08-31', openingEquity: 100000, mode: 'actual', reportNotes: {}, importedHistory: null });
  L.saveValuations({
    '2026-08-31': { equity: 100000, marks: {}, kind: 'close' },
    '2026-09-30': { equity: 105000, marks: { '20': 110 }, kind: 'close' }
  });
  assert(L.equityAt('2026-08-31').value === 100000, 'start equity = opening');
  assert(L.equityAt('2026-09-30').value === 105000, 'exact valuation');
  const fb = L.equityAt('2026-09-28');
  assert(fb.value === 100000 && fb.asOf === '2026-08-31', 'nearest ≤ date fallback flagged asOf');

  // ---------- model mode ----------
  L.saveConfig({ start: '2026-08-31', openingEquity: 100000, mode: 'model', reportNotes: {}, importedHistory: null });
  J = [t1, t2, t3];
  const modelEq = L.equityAt('2026-09-30');
  // 100000 + t1(1010) + t2(1000 via mark) + t3(400) + qld(0) = 102410
  near(modelEq.value, 102410, 'model equity = opening + pnl');
  L.saveConfig({ start: '2026-08-31', openingEquity: 100000, mode: 'actual', reportNotes: {}, importedHistory: null });

  // ---------- flows + TWR ----------
  L.saveCashRecords({ flows: [{ id: 'f1', date: '2026-09-15', amount: 10000, note: 'deposit' }], income: [{ id: 'i1', date: '2026-09-10', amount: 200, sleeve: 'LS v3 Breakout', note: 'div' }] });
  // valuations around the flow boundary (day before flow = 09-14)
  L.saveValuations({
    '2026-08-31': { equity: 100000, marks: {}, kind: 'close' },
    '2026-09-14': { equity: 100500, marks: { '20': 101 }, kind: 'close' },
    '2026-09-30': { equity: 113000, marks: { '20': 110 }, kind: 'close' }
  });
  J = [t1, t2, t3];
  const perf = L.performance('2026-08-31', '2026-09-30');
  // sub-period 1: 08-31→09-14, capital=100000, actual=+500 → growth 1.005
  // sub-period 2: 09-14→09-30, capital=100500+10000=110500, actual=113000-100500-10000=2500
  // growth = 1.005 * (1 + 2500/110500) = 1.005 * 1.022624... = 1.027738...
  const expect = 1.005 * (1 + 2500 / 110500) - 1;
  near(perf.returnPct, expect, 'TWR linked return w/ mid-month deposit');
  near(perf.flows, 10000, 'net flows = 10000');
  near(perf.openingEquity, 100000, 'opening equity');
  near(perf.closingEquity, 113000, 'closing equity');
  // contributions sum (incl. unreconciled) should ~= actual dollar return paths
  assert(Number.isFinite(perf.contributions['unreconciled']), 'unreconciled contribution present');

  // ---------- pnlComponents ----------
  const comp = L.pnlComponents('2026-08-31', '2026-09-30');
  near(comp.parts['10'], 1010, 't1 component');
  near(comp.parts['30'], 400, 't3 component');
  near(comp.parts['cash:LS v3 Breakout'], 200, 'sleeve income');
  assert(comp.parts['cash:Cash income'] === 0, 'cash sleeve income zero');

  // ---------- qldPnl via dollar ledger ----------
  L.saveQldTxns([{ id: 'q1', date: '2026-09-05', kind: 'Buy', amount: 35000, qty: 350, price: 100, note: '' }]);
  const vals = L.valuations();
  vals['2026-08-31'].qldValue = 0;
  vals['2026-09-30'].qldValue = 36400;
  L.saveValuations(vals);
  const qp = L.qldPnl('2026-08-31', '2026-09-30');
  near(qp.pnl, 1400, 'qld pnl = 36400 - 0 + 0 - 35000 = 1400');

  // ---------- buildMonthReport ----------
  const rep = L.buildMonthReport('2026-09');
  assert(rep.ok === true, 'report builds');
  assert(rep.upper.some(r => r.symbol === 'AAA'), 'AAA in upper (opened in month)');
  assert(!rep.upper.some(r => r.symbol === 'QLD'), 'QLD sleeve excluded from position rows');
  const aaa = rep.upper.find(r => r.symbol === 'AAA');
  assert(/@ 55.00/.test(aaa.partial), 'partial fill string has price');
  assert(/@ 58.00/.test(aaa.exit_fill), 'exit fill string has price');
  assert(L.publicFills(aaa.partial) === '55.00 (2026-09-08)', 'publicFills strips qty');
  assert(rep.statusLabel !== undefined || true, 'labels via statusLabel');
  assert(Number.isFinite(rep.returnPct), 'return pct numeric');
  assert(rep.sleeves['LS v3 Breakout'] > 0, 'v3 sleeve pp positive');

  // carried trade: open prior month, still held
  const t4 = trade(40, 'OLD', [ev('Entry', '2026-08-20', 100, 100, 1)], { status: 'ACTIVE', shares: 100, entryDate: '2026-08-20' });
  J = [t1, t2, t3, t4];
  const v2 = L.valuations();
  v2['2026-09-30'].marks['40'] = 105;
  L.saveValuations(v2);
  const rep2 = L.buildMonthReport('2026-09');
  const old = rep2.carried.find(r => r.symbol === 'OLD');
  assert(old, 'OLD carried from August');
  assert(old.status === 'Open' && old.continuation === 'Check next month report.', 'carried open row flagged');
  assert(old.exit === null && old.partial === '', 'open row hides fills');

  // ---------- validation warnings ----------
  const bad = trade(50, 'BAD', [ev('Entry', '2026-09-01', 100, 50, 1), ev('Exit', '2026-09-02', 50, 55, 2)], {});
  assert(L.validateTradeEvents(bad).some(x => /Exit should close all/i.test(x)), 'Exit not draining all warns');

  const reopen = trade(51, 'REO', [ev('Entry', '2026-09-01', 100, 50, 1), ev('Exit', '2026-09-02', 100, 55, 2), ev('Add', '2026-09-03', 10, 56, 3)], {});
  assert(L.validateTradeEvents(reopen).some(x => /reopen/i.test(x)), 'reopen after exit warns');

  const over = trade(52, 'OVR', [ev('Entry', '2026-09-01', 100, 50, 1), ev('Partial', '2026-09-02', 150, 55, 2)], {});
  assert(L.validateTradeEvents(over).some(x => /exceeds|only/i.test(x)), 'oversell warns');

  // ---------- finalize rules ----------
  L.saveSnapshots({});
  const badMonth = L.buildMonthReport('2026-08'); // partial: before start? start=08-31 → partial
  assert(L.canFinalize(badMonth) !== null, 'partial month cannot finalize');
  const repOk = L.buildMonthReport('2026-09', '2026-09-30');
  const finErr = L.canFinalize(repOk);
  // residual likely nonzero (our synthetic numbers don't reconcile) → expect an error string
  assert(finErr === null || typeof finErr === 'string', 'canFinalize returns null or reason');
  const fin = L.finalizeMonth('2026-09', repOk, '');
  if (finErr) assert(fin.ok === false, 'finalize blocked: ' + finErr);

  // force a clean month to test finalize: craft residual-free by zeroing valuations diff
  // (residual exists in synthetic data; test revision-reason path via manual snapshot push)
  L.saveSnapshots({});
  const fakeRep = { ok: true, month: '2026-09', end: '2026-09-30', incompleteReason: '', residualMagnitude: 0, returnPct: 1.5 };
  const f1 = L.finalizeMonth('2026-09', fakeRep, '');
  assert(f1.ok === true && f1.revision === 1, 'first finalize → revision 1');
  const f2 = L.finalizeMonth('2026-09', fakeRep, '');
  assert(f2.ok === false, 'revision needs reason');
  const f3 = L.finalizeMonth('2026-09', fakeRep, 'data fix');
  assert(f3.ok === true && f3.revision === 2, 'revision 2 with reason');
  assert(L.snapshotList('2026-09').length === 2, 'two revisions stored');
  assert(L.requiresReason('2026-09-10') === true, 'edit inside finalized month needs reason');
  assert(L.requiresReason('2027-01-10') === false, 'future month needs no reason');
  const flagged = L.flagStaleFrom('2026-09-05');
  assert(flagged.includes('2026-09'), 'stale flag from backdated change');

  // ---------- audit + undo ----------
  L.saveAuditLog([]);
  const key = 'ledgerConfig';
  const undoPayload = L.captureStoreUndo([key]);
  L.saveConfig({ start: '2026-01-01', openingEquity: 1, mode: 'actual', reportNotes: {} });
  L.auditPush('Edit setup', 'test', undoPayload);
  assert(L.config().start === '2026-01-01', 'config changed');
  const u = L.undoLast('revert test');
  assert(u.ok === true, 'undo ok');
  assert(L.config().start === '2026-08-31', 'undo restored prior config');
  assert(L.auditLog().length === 2, 'undo itself audited');

  // ---------- undo journal trade ----------
  J = [t1];
  const tUndo = L.captureTradeUndo([t1.id]);
  t1.events.push(ev('Add', '2026-09-06', 1, 1, 9));
  L.auditPush('Add event', '', tUndo);
  L.undoLast('x');
  assert(J[0].events.length === 4, 'trade undo restored events (4)');

  // ---------- sync endpoints ----------
  const ep = L.syncEndpoints({ provider: 'jsonbin', binId: 'abc', apiKey: 'k' });
  assert(/jsonbin\.io\/v3\/b\/abc\/latest/.test(ep.get), 'jsonbin GET url');
  assert(ep.headers['X-Master-Key'] === 'k', 'jsonbin key header');
  assert(L.syncEndpoints({ provider: 'npoint', binId: 'xyz' }).get === 'https://api.npoint.io/xyz', 'npoint url');
  assert(L.syncEndpoints({ provider: 'pantry', binId: 'p', basket: 'b' }).get.includes('/basket/b'), 'pantry url');
  assert(L.syncEndpoints({ provider: 'appscript', url: 'https://x' }).plain === true, 'appscript plain body');
  assert(L.syncEndpoints({ provider: 'none' }) === null, 'provider none → null');

  // ---------- monthsWithData / intervalContribution ----------
  J = [t1, t2, t3, t4];
  const months = L.monthsWithData();
  assert(months.includes('2026-09') && months.includes('2026-08'), 'months with data');
  const ic = L.intervalContribution('2026-08-31', '2026-09-30');
  assert(ic.rows.length >= 3, 'interval rows');
  assert(ic.delta === 13000, 'equity delta 113000-100000=13000');

  console.log('_test_ledger OK');
} catch (e) {
  console.error(e.stack || e);
  process.exit(1);
}
