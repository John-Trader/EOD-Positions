// Export tests: OCA uniqueness, 12-column header for built-ins, adjustable-stop and timed-exit columns
// only when used, % leg validation, Auto batch strategy, share split never exceeds position.
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = h.slice(h.indexOf('<script>') + 8, h.lastIndexOf('</script>'));

const elements = {};
function mockElement(id) {
  if (!elements[id]) elements[id] = {
    id, innerText: '', innerHTML: '', value: id === 'apiProvider' ? 'finnhub' : '', className: '', dataset: {}, style: {}, children: [],
    classList: { add: (...c) => { elements[id].className += ' ' + c.join(' '); }, remove: (...c) => { c.forEach(cls => elements[id].className = elements[id].className.replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim()); }, contains: (c) => elements[id].className.includes(c), toggle: () => {} },
    querySelectorAll: () => [], querySelector: () => null, appendChild: () => {}, removeChild: () => {}, insertAdjacentHTML: () => {}, addEventListener: () => {}, setAttribute: () => {}, click: () => {}, remove: () => {}
  };
  return elements[id];
}
const fakeInputs = { '.batch-entry': { value: '100' }, '.batch-shares': { value: '100' }, '.batch-stop': { value: '95' } };
const rows = [
  { dataset: { ticker: 'LNG', long: 'true' }, querySelector: (s) => fakeInputs[s] || null, querySelectorAll: () => [] },
  { dataset: { ticker: 'SHT', long: 'false' }, querySelector: (s) => ({ '.batch-entry': { value: '95' }, '.batch-shares': { value: '100' }, '.batch-stop': { value: '100' } })[s] || null, querySelectorAll: () => [] }
];
const document = { getElementById: mockElement, querySelectorAll: (sel) => sel === '#batchReviewList .batch-row' ? rows : [], querySelector: () => null, createElement: () => mockElement('e' + Math.random()), addEventListener: () => {}, body: mockElement('body') };
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const window = { speechSynthesis: { speak: () => {}, cancel: () => {} }, addEventListener: () => {} };
const navigator = { clipboard: { writeText: () => Promise.resolve() } };
const sandbox = { elements, document, localStorage, window, navigator, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval, alert: () => {}, confirm: () => true, prompt: () => null };
const fn = new Function(...Object.keys(sandbox), code + `
  return { buildExitLegs, csvTextForRows, csvHeaderForRows, TWS_CSV_HEADERS, TWS_EXTRA_HEADERS, customStrategies, strategyLegsError, splitSharesByPct, collectBatchTradesFromDom, AUTO_STRATEGY, ocaSuffix, addTradingDays, nyDateStr, parseSignalText, journalResult, prepareBackup, setTradesTab, navigateTo, toggleSignalPaste, saveFeatureSettings, csvCell,
           setRegime: (r) => { globalMarketRegime = r; } };`);
const api = fn(...Object.values(sandbox));
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };

try {
  // OCA suffix: unique per minute, present on every leg, base name preserved
  const b1 = api.buildExitLegs('PLTR', true, 179.94, 67, 172.54, 'opt2');
  assert(b1.ok, 'opt2 builds');
  assert(/^PLTR_opt2_L1_[a-z0-9-]+$/.test(b1.rows[0][11]), 'OCA has a unique suffix: ' + b1.rows[0][11]);
  assert(b1.rows[2][11].startsWith('PLTR_opt2_L2_'), 'leg 2 OCA');
  assert(api.ocaSuffix() !== api.ocaSuffix(), 'OCA suffix must differ even within the same minute');

  // Built-in strategies: exactly the classic 12 columns, 2 rows per leg, no extra columns
  for (const s of ['opt1', 'opt2', 'short16']) {
    const b = api.buildExitLegs('TST', s !== 'short16', s !== 'short16' ? 100 : 95, 100, s !== 'short16' ? 95 : 100, s);
    assert(b.ok, s + ' ok');
    assert(b.rows.every(r => r.length === 12), s + ' rows are 12 cols');
    const csv = api.csvTextForRows(b.rows);
    assert(csv.split('\n')[0] === api.TWS_CSV_HEADERS.join(','), s + ' header is the classic 12 columns');
    assert(!b.timedExit && (!b.notes || !b.notes.length), s + ' no timed exit / notes by default');
  }

  // Timed exit (explicit override, as the setting would provide): one MKT GAT row per leg, header gains GoodAfterTime only
  const exitDate = api.addTradingDays(api.nyDateStr(), 5);
  const t = api.buildExitLegs('PLTR', true, 100, 100, 95, 'opt2', undefined, { timedExit: { enabled: true, date: exitDate, time: '15:45' } });
  assert(t.ok && t.rows.length === 6, 'opt2 + timed exit = 6 rows (STP, LMT, MKT per leg), got ' + t.rows.length);
  const mkts = t.rows.filter(r => r[7] === 'MKT');
  assert(mkts.length === 2, 'two MKT rows');
  assert(mkts[0][12] === exitDate.replace(/-/g, '') + ' 15:45:00 US/Eastern', 'GoodAfter format: ' + mkts[0][12]);
  assert(t.rows.every(r => r[16] === 2), 'Advanced orders request proportional OCA reduction with blocking');
  assert(mkts[0][11] === t.rows[0][11] && mkts[1][11] === t.rows[3][11] && mkts[0][11] !== mkts[1][11], 'MKT rows share the OCA group of their leg');
  assert(mkts[0][1] + mkts[1][1] === 100, 'timed exit covers whole position');
  const header = api.csvHeaderForRows(t.rows);
  assert(header.length === 14 && header[12] === 'GoodAfter' && header[13] === 'OcaType', 'scheduled header: ' + header.join(','));
  const csvT = api.csvTextForRows(t.rows);
  assert(csvT.split('\n').every(l => l.split(',').length === 14), 'every scheduled CSV line has 14 cells');
  const moc = api.buildExitLegs('PLTR', true, 100, 100, 95, 'opt1', undefined, { timedExit: { enabled: true, date: exitDate, time: 'MOC' } });
  assert(!moc.ok, 'unverified MOC scheduling is not offered');

  // Custom BE strategy -> adjustable stop columns on leg 2 STP only
  api.customStrategies.push({ id: 'be', name: 'BE test', legs: [{ pct: 50, rr: 1, stopMode: 'fixed' }, { pct: 50, rr: 4, stopMode: 'breakeven' }] });
  const be = api.buildExitLegs('PLTR', true, 100, 100, 95, 'be');
  assert(be.ok, 'BE strategy builds: ' + be.error);
  const stp2 = be.rows[2];
  assert(stp2[7] === 'STP' && stp2[9] === '95.00', 'leg-2 stop still placed at original stop');
  assert(stp2[13] === 'STP' && stp2[14] === '105.00' && stp2[15] === '100.00', 'adjustable: trigger = leg1 TP (105), adjusted stop = BE (100)');
  assert([0, 1, 3].every(i => be.rows[i][13] === undefined) && be.rows.every(r => r[16] === 2), 'adjustment only on the second stop; OCA reduction applies to all advanced rows');
  const hBe = api.csvHeaderForRows(be.rows);
  assert(hBe.join(',') === api.TWS_CSV_HEADERS.concat(['Adj Order Type', 'Trigger Price', 'Adj Stop Price', 'OcaType']).join(','), 'advanced header uses documented display names and OCA type');
  assert(be.preview[1].adjStop === 100 && be.preview[1].adjTrigger === 105, 'preview carries adjustable info');
  // +1R short variant
  api.customStrategies.push({ id: 'p1', name: 'plus1 test', legs: [{ pct: 40, rr: 1, stopMode: 'fixed' }, { pct: 60, rr: 6, stopMode: 'plus1' }] });
  const p1 = api.buildExitLegs('X', false, 95, 100, 100, 'p1');
  assert(p1.ok && p1.rows[2][15] === '90.00' && p1.rows[2][14] === '90.00', 'short +1R: adjusted stop 90, trigger = leg1 TP 90');
  // BE on leg 1 -> fixed with note
  api.customStrategies.push({ id: 'be0', name: 'BE first', legs: [{ pct: 100, rr: 6, stopMode: 'breakeven' }] });
  const be0 = api.buildExitLegs('X', true, 100, 100, 95, 'be0');
  assert(be0.ok && be0.rows[0].length === 12 && be0.notes.length === 1, 'leg-1 BE falls back to fixed with a note');

  // % validation
  api.customStrategies.push({ id: 'bad', name: 'bad', legs: [{ pct: 60, rr: 1, stopMode: 'fixed' }, { pct: 60, rr: 6, stopMode: 'fixed' }] });
  const bad = api.buildExitLegs('X', true, 100, 100, 95, 'bad');
  assert(!bad.ok && /120%/.test(bad.error), '120% strategy rejected: ' + bad.error);
  assert(api.strategyLegsError({ legs: [{ pct: 100, rr: 6 }] }) === null, '100% ok');
  assert(api.strategyLegsError({ legs: [{ pct: 100, rr: 0 }] }) !== null, 'rr 0 rejected');
  assert(api.strategyLegsError({ legs: [{ pct: 33.33, rr: 1 }, { pct: 33.33, rr: 2 }, { pct: 33.34, rr: 3 }] }) === null, '33.33/33.33/33.34 ok');

  // split never exceeds total
  for (const total of [1, 2, 7, 67, 999]) for (const pcts of [[100], [40, 60], [33.33, 33.33, 33.34], [50, 50]]) {
    const q = api.splitSharesByPct(total, pcts);
    assert(q.reduce((a, b) => a + b, 0) === total, `split ${total} ${pcts} sums to total`);
  }

  // Auto batch strategy: per side / regime
  api.setRegime('declining');
  mockElement('batchGlobalStrategy').value = api.AUTO_STRATEGY;
  let col = api.collectBatchTradesFromDom();
  assert(col.trades.length === 2, 'two batch trades');
  assert(col.trades[0].strategyId === 'opt2' && col.trades[1].strategyId === 'short16', 'Auto: long -> opt2 (declining), short -> short16');
  api.setRegime('expanding');
  col = api.collectBatchTradesFromDom();
  assert(col.trades[0].strategyId === 'opt1', 'Auto: long -> opt1 (expanding)');
  mockElement('batchGlobalStrategy').value = 'opt2';
  col = api.collectBatchTradesFromDom();
  assert(col.trades[0].strategyId === 'opt2' && col.trades[1].strategyId === 'opt2', 'explicit global strategy applies to all');

  const pasted = api.parseSignalText('TODAY\u2019S SIGNALS:\n1) $AMPL (Amplitude Inc) - If closing above $13.96 LONG\n2) $INTA (Intapp, Inc) - If closing above $42.84 LONG\n3) $ZETA (Zeta Global holdings Corp) - If closing above $30.02 LONG\n4) $PTC (PTC Inc) - If closing above $157.55 LONG\n5) $CHYM (Chime Financials) - If closing above $33.72 LONG');
  assert(pasted.signals.map(s => s.ticker).join(',') === 'AMPL,INTA,ZETA,PTC,CHYM', 'pasted tickers');
  assert(pasted.signals.map(s => s.trigger).join(',') === '13.96,42.84,30.02,157.55,33.72', 'pasted triggers');
  assert(pasted.signals.every(s => s.signalSide === 'LONG'), 'signal side kept');
  assert(api.parseSignalText('$AMPL above $10 LONG\n$AMPL above $11 LONG').signals.length === 1, 'duplicate paste handled');
  const result = api.journalResult({ side: 'LONG', entryPrice: 100, exitPrice: 110, shares: 10, stopPrice: 95, fees: 2, entryDate: '2026-09-01', exitDate: '2026-09-09' });
  assert(result.pnl === 98 && result.rMultiple === 1.96 && result.holdDays === 5, 'journal net P&L/R/day count');
  assert(api.csvCell('=1+1') === "'=1+1", 'journal formulas escaped');
  const restored = api.prepareBackup({ version: '1.1.0', liveUpdateEnabled: false, showRangePct: true, slippageValue: 0, scanner: { tickers: ['AMPL'], triggers: [13.96], visibleCount: 3, sides: { 0: 'LONG' } } });
  assert(restored.liveUpdateEnabled === 'false' && restored.showRangePct === 'true' && restored.slippageValue === '0' && restored.ticker_0 === 'AMPL', 'backup preserves false, zero, scanner');
  api.navigateTo('settings');
  api.toggleSignalPaste(false);
  api.setTradesTab('history');
  api.saveFeatureSettings();
  assert(elements['activeTradesPageList'].innerHTML.includes('No closed trades'), 'history and Settings handlers run');
  console.log('Export and feature checks passed!');
  process.exit(0);
} catch (e) {
  console.error('Export test failed:', e.message);
  process.exit(1);
}
