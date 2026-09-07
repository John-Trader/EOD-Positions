// Tests for the New York time core: trading-day math, holidays, RTH gate.
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
const document = { getElementById: mockElement, querySelectorAll: () => [], querySelector: () => null, createElement: () => mockElement('e' + Math.random()), addEventListener: () => {}, body: mockElement('body') };
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const window = { speechSynthesis: { speak: () => {}, cancel: () => {} }, addEventListener: () => {} };
const navigator = { clipboard: { writeText: () => Promise.resolve() } };
const sandbox = { elements, document, localStorage, window, navigator, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval, alert: () => {}, confirm: () => true, prompt: () => null };
const fn = new Function(...Object.keys(sandbox), code + '\nreturn { nyNow, isNYSEMarketOpenDay, tradingDaysBetween, addTradingDays, calculateMarketDaysElapsed, updateClock };');
const api = fn(...Object.values(sandbox));
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };

try {
  // Holidays / weekends
  assert(api.isNYSEMarketOpenDay('2026-09-01'), 'Tue Sep 1 2026 is open');
  assert(!api.isNYSEMarketOpenDay('2026-09-07'), 'Labor Day 2026 closed');
  assert(!api.isNYSEMarketOpenDay('2026-09-05'), 'Saturday closed');
  assert(!api.isNYSEMarketOpenDay('2026-07-03'), 'Observed July 4 2026 closed');

  // Day 0 convention
  assert(api.tradingDaysBetween('2026-09-01', '2026-09-01') === 0, 'same day = Day 0');
  assert(api.tradingDaysBetween('2026-09-01', '2026-09-02') === 1, 'next day = Day 1');
  assert(api.tradingDaysBetween('2026-09-03', '2026-09-08') === 2, 'Thu -> Tue over weekend + Labor Day = 2');
  assert(api.tradingDaysBetween('2026-09-01', '2026-08-31') === 0, 'end before start = 0');
  assert(api.addTradingDays('2026-09-01', 5) === '2026-09-09', '5 trading days after Sep 1 (skips Labor Day) = Sep 9');
  assert(api.addTradingDays('2026-09-03', 5) === '2026-09-11', '5 trading days after Sep 3 = Sep 11');

  // nyNow with injected instants (EDT = UTC-4 in September)
  const at = (iso) => api.nyNow(new Date(iso));
  let n = at('2026-09-01T13:29:00Z'); assert(n.h === 9 && n.m === 29 && !n.isRTH, '09:29 ET not RTH');
  n = at('2026-09-01T13:30:00Z'); assert(n.isRTH, '09:30 ET is RTH');
  n = at('2026-09-01T19:59:59Z'); assert(n.isRTH && n.closeMin === 960, '15:59 ET is RTH, normal close');
  n = at('2026-09-01T20:00:00Z'); assert(!n.isRTH, '16:00 ET not RTH');
  n = at('2026-11-27T17:30:00Z'); assert(n.closeMin === 780 && n.minutesOfDay === 750 && n.isRTH && n.date === '2026-11-27', 'Black Friday 12:30 ET is RTH (early close 13:00)');
  n = at('2026-11-27T18:00:00Z'); assert(!n.isRTH, 'Black Friday 13:00 ET closed');
  n = at('2026-09-02T02:30:00Z'); assert(n.date === '2026-09-01' && n.h === 22, '02:30Z is still Sep 1 22:30 ET');
  n = at('2026-09-07T15:00:00Z'); assert(!n.isTradingDay && !n.isRTH, 'Labor Day not trading day');

  // Clock renders without throwing
  api.updateClock();
  assert(typeof elements['countdown'].innerText === 'string' && elements['countdown'].innerText.length > 0, 'clock text set');

  console.log('Time core tests passed!');
} catch (e) {
  console.error('Time test failed:', e.message);
  process.exit(1);
}
