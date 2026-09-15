// Tests for the LS Pullback path: mixed EOD parsing, category resolution,
// ATR math (daily + resampled weekly), timed-exit dates, sizing, TWS keys.
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
  parseEodSignalText, parseSignalText, parsePbLine, pbCatOf, PB_CATS,
  pineAtr, resampleDailyToWeekly, pullbackAtrs, pbTimedExitDate, isCurrentWeekForming,
  emaLast, weeksElapsedSince, getPbFields, buildExitLegs, twsSendKey,
  setPbSignals, loadPbSignals, mondayOf, lastTradingDayOfWeek, addCalendarDays,
  nyDateStr, addTradingDays,
  set accountValue(v) { accountValue = v; }, get accountValue() { return accountValue; },
  set maxHoldDays(v) { maxHoldDays = v; },
  set signalSyncMode(v) { signalSyncMode = v; },
  volatilityCache,
  set timedExitEnabled(v) { timedExitEnabled = v; }, set timedExitTime(v) { timedExitTime = v; }
};`);
const api = fn(...Object.values(sandbox));
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };

try {
  // ---------- 1. Mixed-section parse (user's exact example) ----------
  const mixed = api.parseEodSignalText(`EOD
LS v3 Breakout
1. $CPAY (Corpay, Inc.)
If closing above $416.30 - LONG

LS Pullbacks
1. $GOOG (Alphabet, Inc.) - Weekly
2. $XLE - Daily
3. $SPY - Weekly
`);
  assert(mixed.signals.length === 1, 'one v3 signal parsed');
  assert(mixed.signals[0].ticker === 'CPAY' && mixed.signals[0].trigger === 416.30, 'CPAY trigger 416.30');
  assert(mixed.signals[0].signalSide === 'LONG', 'CPAY LONG side');
  assert(mixed.pb.length === 3, 'three pullback signals parsed');
  assert(mixed.pb[0].ticker === 'GOOG' && mixed.pb[0].tf === 'weekly', 'GOOG weekly');
  assert(mixed.pb[1].ticker === 'XLE' && mixed.pb[1].tf === 'daily', 'XLE daily');
  assert(mixed.pb[2].ticker === 'SPY' && mixed.pb[2].tf === 'weekly', 'SPY weekly');
  assert(!mixed.warnings.some(w => /No trigger found for (GOOG|XLE|SPY)/.test(w)), 'no false v3 warnings for pb tickers');

  // ---------- 2. Sections in reverse order: v3 header must switch back ----------
  const reversed = api.parseEodSignalText(`LS Pullbacks
1. $GOOG - Weekly
LS v3 Breakout
1. $CPAY
If closing above $416.30 - LONG
`);
  assert(reversed.pb.length === 1 && reversed.pb[0].ticker === 'GOOG', 'reversed: GOOG stays pb');
  assert(reversed.signals.length === 1 && reversed.signals[0].ticker === 'CPAY' && reversed.signals[0].trigger === 416.30, 'reversed: CPAY parsed as v3 after LS v3 header');

  // ---------- 3. Headerless "- Daily"/"- Weekly" fallback ----------
  const headerless = api.parseEodSignalText(`$AMPL
If closing above $100 - LONG
$XLE - Daily
2. $SPY - Weekly`);
  assert(headerless.pb.length === 2 && headerless.pb[0].ticker === 'XLE' && headerless.pb[1].ticker === 'SPY', 'headerless daily/weekly lines route to pb');
  assert(headerless.signals.length === 1 && headerless.signals[0].ticker === 'AMPL', 'headerless: AMPL stays v3');

  // ---------- 4. Category resolution ----------
  assert(api.pbCatOf({ ticker: 'XLE', tf: 'daily', cat: 'auto' }) === 'etf_d', 'XLE daily -> etf_d');
  assert(api.pbCatOf({ ticker: 'SPY', tf: 'weekly', cat: 'auto' }) === 'etf_w', 'SPY weekly -> etf_w');
  assert(api.pbCatOf({ ticker: 'GOOG', tf: 'weekly', cat: 'auto' }) === 'nas_w', 'GOOG weekly -> nas_w');
  assert(api.pbCatOf({ ticker: 'NVDA', tf: 'daily', cat: 'auto' }) === null, 'daily non-ETF -> unclassified (flags)');
  assert(api.pbCatOf({ ticker: 'NVDA', tf: 'daily', cat: 'etf_d' }) === 'etf_d', 'manual cat override respected');
  assert(api.pbCatOf({ ticker: 'XLE', tf: null, cat: 'auto' }) === null, 'no tf -> unclassified');

  // ---------- 5. pineAtr on synthetic bars ----------
  // 6 bars, TR constant = 2 -> ATR(5) = 2
  const flat = [];
  for (let i = 0; i < 6; i++) flat.push({ d: '2026-08-0' + (i + 1), o: 100, h: 101, l: 99, c: 100 });
  const atrFlat = api.pineAtr(flat, 5);
  assert(Math.abs(atrFlat - 2) < 1e-9, 'ATR(5) of constant TR=2 is 2');
  assert(api.pineAtr(flat.slice(0, 4), 5) === null, 'insufficient bars -> null');

  // ---------- 6. Weekly resample over a holiday-shortened week ----------
  // Mon holiday; Tue-Fri only. Weekly H=max, L=min, C=Fri close.
  const daily = [
    { d: '2026-08-31', o: 100, h: 101, l: 99, c: 100 },   // prior week Mon
    { d: '2026-09-01', o: 100, h: 102, l: 100, c: 101 },  // prior week Tue
    { d: '2026-09-08', o: 101, h: 103, l: 100, c: 102 },  // next week Tue (Mon 9/7 Labor Day)
    { d: '2026-09-09', o: 102, h: 104, l: 101, c: 103 },
    { d: '2026-09-10', o: 103, h: 105, l: 102, c: 104 },
    { d: '2026-09-11', o: 104, h: 104.5, l: 103, c: 103.5 }
  ];
  const wk = api.resampleDailyToWeekly(daily);
  assert(wk.length === 2, 'two weekly buckets');
  assert(wk[0].t === '2026-08-31' && wk[0].h === 102 && wk[0].l === 99 && wk[0].c === 101, 'week 1 OHLC aggregated');
  assert(wk[1].t === '2026-09-07' && wk[1].h === 105 && wk[1].l === 100 && wk[1].c === 103.5, 'short week aggregates its 4 sessions');

  // ---------- 7. Timed-exit dates ----------
  // Daily: +5 trading days (day 0 = entry). Fri 2026-09-04 -> Mon 9/7 holiday ->
  // 9/8,9/9,9/10,9/11,9/14 -> day5 = Mon 9/14.
  const dExit = api.pbTimedExitDate('etf_d', '2026-09-04');
  assert(dExit === '2026-09-14', 'daily exit = 5th trading day after entry (' + dExit + ')');
  // Weekly: last trading day of week 5 (entry week = week 0). Entry Fri 2026-09-04 -> week5 Mon = 2026-10-05 -> Fri 10/09.
  const wExit = api.pbTimedExitDate('etf_w', '2026-09-04');
  assert(wExit === '2026-10-09', 'weekly exit = Friday of week 5 (' + wExit + ')');
  assert(api.pbTimedExitDate('bogus', '2026-09-04') === null, 'unknown cat -> null');
  // Early-close landings keep the day — the GAT order schedules at 12:50 downstream.
  // Thu 2026-11-19 entry -> 11/20,11/23,11/24,11/25,(11/26 holiday),11/27 -> day5 = 11/27 (1 PM close).
  assert(api.pbTimedExitDate('etf_d', '2026-11-19') === '2026-11-27', 'daily exit stays on early-close day');
  // Week-5 Friday = 2026-11-27 (early close) -> exit stays on Friday, not pushed to Wed.
  assert(api.pbTimedExitDate('etf_w', '2026-10-19') === '2026-11-27', 'weekly exit stays on early-close Friday');

  // ---------- 8. Sizing: floor(account * riskPct / (ATR + slippage)) ----------
  api.accountValue = 100000;
  // Seed bars: ATR(5) = 2 -> etf_d risk $375 -> floor(375/2) = 187 shares
  api.volatilityCache['XLE'] = { status: 'ok', checkedAt: Date.now(), bars: flat.map(b => ({ ...b })), atrPct: null, adrPct: null, latestClose: 100, avgVol: null };
  const item = { ticker: 'XLE', tf: 'daily', cat: 'auto', data: { c: 100, h: 101, l: 99, pc: 99, bid: 99.5, ask: 100.5 } };
  const f = api.getPbFields(item, 0);
  assert(f.catId === 'etf_d', 'XLE resolves etf_d');
  assert(Math.abs(f.atr - 2) < 1e-6, 'ATR used = 2');
  assert(f.shares === 187, 'etf_d sizing: 100k*0.375%/2 = 187 shares (got ' + f.shares + ')');
  assert(Math.abs(f.stop - 98) < 1e-6, 'stop = entry - 1 ATR');
  assert(Math.abs(f.tp1 - 102) < 1e-6, 'tp1 = entry + 1R');
  assert(f.tp1Shares === Math.floor(187 * 0.25) && f.timedShares === 187 - f.tp1Shares, '25%/75% leg split');

  // Weekly sizing uses weekly ATR — build 7 weeks of weekly-equivalent daily bars.
  const wide = [];
  let px = 100;
  // 36 daily bars, each day TR=5 -> weekly TR >= 5 (weekly bars bigger range)
  for (let i = 0; i < 36; i++) { wide.push({ d: api.addCalendarDays('2026-07-27', i), o: px, h: px + 3, l: px - 2, c: px + 1 }); px += 1; }
  api.volatilityCache['SPY'] = { status: 'ok', checkedAt: Date.now(), bars: wide, atrPct: null, adrPct: null, latestClose: px, avgVol: null };
  const wItem = { ticker: 'SPY', tf: 'weekly', cat: 'auto', data: { c: px, h: px + 1, l: px - 1, pc: px - 1 } };
  const wf = api.getPbFields(wItem, 0);
  assert(wf.catId === 'etf_w', 'SPY weekly -> etf_w');
  assert(wf.atr > 0 && wf.shares > 0, 'weekly ATR sizing produced shares');
  assert(Math.abs(wf.riskDollars - 750) < 1e-6, 'etf_w risks 0.75% = $750 on 100k');
  assert(wf.shares === Math.floor(750 / wf.atr), 'weekly shares = floor(risk/atr)');

  // ---------- 9. lspb bracket legs via buildExitLegs ----------
  api.timedExitEnabled = false; // lspb carries its own timed override; global toggle irrelevant
  const futDate = api.addTradingDays(api.nyDateStr(), 3);
  const built = api.buildExitLegs('XLE', true, 100, 187, 98, 'lspb', [], { timedExit: { enabled: true, date: futDate, time: '15:55' } });
  assert(built.ok, 'lspb legs build: ' + (built.error || ''));
  const rows = built.rows.filter(r => r[7]);
  const types = rows.map(r => r[7]);
  assert(types.includes('STP') && types.includes('LMT') && types.includes('MKT'), 'lspb emits STP + LMT + timed MKT rows (' + types.join(',') + ')');
  const timedRow = rows.find(r => r[7] === 'MKT' && r[12]);
  assert(timedRow && timedRow[12].startsWith(futDate.replace(/-/g, '')), 'timed row carries GoodAfter date ' + futDate);

  // ---------- 10. TWS keys: legacy unchanged, pb namespaced ----------
  assert(api.twsSendKey('AMPL', 'entry') === 'AMPL:entry', 'legacy key AMPL:entry');
  assert(api.twsSendKey('AMPL', 'exits') === 'AMPL:exits', 'legacy key AMPL:exits');
  assert(api.twsSendKey('XLE', 'entry', 'pb') === 'XLE:pb:entry', 'pb key XLE:pb:entry');
  assert(api.twsSendKey('XLE', 'exits', 'pb') === 'XLE:pb:exits', 'pb key XLE:pb:exits');

  // ---------- 11. Signal-store roundtrip (shared mode) ----------
  api.signalSyncMode = 'shared';
  api.setPbSignals([{ ticker: 'xle', tf: 'daily', cat: 'auto' }, { ticker: 'SPY', tf: 'weekly', cat: 'etf_w' }]);
  const reloaded = api.loadPbSignals();
  assert(reloaded.length === 2 && reloaded[0].ticker === 'XLE' && reloaded[0].tf === 'daily', 'pbSignals persist + sanitize');
  assert(reloaded[1].ticker === 'SPY' && reloaded[1].cat === 'etf_w', 'pbSignals keep explicit cat');
  api.setPbSignals([]);
  assert(api.loadPbSignals().length === 0, 'clearing the store empties it');

  // ---------- 12. Duplicate pb tickers deduped with warning ----------
  const dup = api.parseEodSignalText('LS Pullbacks\n1. $XLE - Daily\n2. $XLE - Weekly\n');
  assert(dup.pb.length === 1 && dup.warnings.some(w => /Duplicate XLE/.test(w)), 'duplicate pb ticker deduped + warned');

  console.log('Pullback tests passed!');
} catch (e) {
  console.error('Pullback test failed:', e);
  process.exit(1);
}
