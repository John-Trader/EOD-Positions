// Regression tests: fabricated TWS h/l must be corrected by true values,
// not ratcheted around forever (min/max can never fix a bad band).
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = h.slice(h.indexOf('<script>') + 8, h.lastIndexOf('</script>'));

let fakeNow = Date.parse('2026-09-01T18:00:00Z'); // 14:00 ET, RTH
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(fakeNow); else super(...a); }
  static now() { return fakeNow; }
}

const elements = {};
function mockElement(id) {
  if (!elements[id]) elements[id] = {
    id, innerText: '', innerHTML: '', value: '', className: '', dataset: {}, style: {}, children: [],
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
    querySelectorAll: () => [], querySelector: () => null, appendChild: () => {}, removeChild: () => {},
    insertAdjacentHTML: () => {}, addEventListener: () => {}, setAttribute: () => {}, getAttribute: () => null,
    click: () => {}, remove: () => {}, closest: () => null, focus: () => {}, select: () => {},
    scrollIntoView: () => {}
  };
  return elements[id];
}
const document = { getElementById: mockElement, getElementsByName: () => [], querySelectorAll: () => [], querySelector: () => null, createElement: () => mockElement('e' + Math.random()), addEventListener: () => {}, body: mockElement('body') };
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const window = { speechSynthesis: { speak: () => {}, cancel: () => {} }, addEventListener: () => {} };
const navigator = { clipboard: { writeText: () => Promise.resolve() } };
const sandbox = {
  elements, document, localStorage, window, navigator, console,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  alert: () => {}, confirm: () => true, prompt: () => null, Date: FakeDate,
  Blob: class { constructor(p, o) { this.parts = p; this.opts = o || {}; } },
  URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} }
};
const fn = new Function(...Object.keys(sandbox), code + `
return { applyLivePrice, mergeRestQuote, realtimeQuotes };`);
const api = fn(...Object.values(sandbox));
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };
const Q = api.realtimeQuotes;
const FAB = { hFab: true, lFab: true };

try {
  // 1. TWS tick carrying true session h/l replaces a fabricated band and clears flags
  Q['AAA'] = { c: 101, h: 101, l: 100, pc: 100, bid: 100, ask: 102, ...FAB };
  assert(api.applyLivePrice('AAA', 101.5, { h: 103, l: 101.2, bid: 101, ask: 102 }) === true, 'tick applied');
  assert(Q['AAA'].h === 103, 'fabricated h replaced by tick h, got ' + Q['AAA'].h);
  assert(Q['AAA'].l === 101.2, 'fabricated l replaced by tick l, got ' + Q['AAA'].l);
  assert(Q['AAA'].hFab === false && Q['AAA'].lFab === false, 'fab flags cleared by tick');
  assert(Q['AAA'].c === 101.5, 'last price still applied');

  // 2. REST resync with true h/l replaces a fabricated band (reviewer scenario:
  //    fabricated l=100 pinned below true low 101.2; old min() kept 100 forever)
  Q['BBB'] = { c: 101, h: 101, l: 100, pc: 100, bid: 100, ask: 102, ...FAB };
  assert(api.mergeRestQuote('BBB', { c: 101.5, h: 103, l: 101.2, pc: 100, bid: 101, ask: 102 }) === true, 'resync reports change');
  assert(Q['BBB'].h === 103, 'fabricated h replaced by resync h, got ' + Q['BBB'].h);
  assert(Q['BBB'].l === 101.2, 'fabricated l replaced by resync l, got ' + Q['BBB'].l);
  assert(Q['BBB'].hFab === false && Q['BBB'].lFab === false, 'fab flags cleared by resync');

  // 3. Ticks without h/l (other providers) keep the old RTH ratchet behavior
  Q['CCC'] = { c: 101, h: 103, l: 99, pc: 100, bid: 100, ask: 102 };
  api.applyLivePrice('CCC', 104, { bid: 103, ask: 105 });
  assert(Q['CCC'].h === 104, 'real h ratchets up on ticks without h/l, got ' + Q['CCC'].h);
  api.applyLivePrice('CCC', 98, {});
  assert(Q['CCC'].l === 98, 'real l ratchets down on ticks without h/l, got ' + Q['CCC'].l);
  assert(Q['CCC'].hFab === false && Q['CCC'].lFab === false, 'no flags appear on non-fabricated quotes');

  // 4. Resync without flags keeps the old ratchet behavior
  Q['DDD'] = { c: 101, h: 103, l: 99, pc: 100, bid: 100, ask: 102 };
  api.mergeRestQuote('DDD', { c: 102, h: 104, l: 98.5, pc: 100, bid: 101, ask: 103 });
  assert(Q['DDD'].h === 104, 'real h ratchets up on resync, got ' + Q['DDD'].h);
  assert(Q['DDD'].l === 98.5, 'real l ratchets down on resync, got ' + Q['DDD'].l);

  // 5. Pre-market: fabricated band is still corrected by tick h/l (flags clear),
  //    even though the price-only ratchet stays frozen outside RTH
  fakeNow = Date.parse('2026-09-01T12:00:00Z'); // 08:00 ET, pre-market
  Q['EEE'] = { c: 101, h: 101, l: 100, pc: 100, bid: 100, ask: 102, ...FAB };
  api.applyLivePrice('EEE', 101.8, { h: 102.5, l: 100.8 });
  assert(Q['EEE'].h === 102.5 && Q['EEE'].l === 100.8, 'pre-market tick h/l corrects fabricated band');
  assert(Q['EEE'].hFab === false && Q['EEE'].lFab === false, 'fab flags cleared pre-market too');

  console.log('All h/l-correction regression tests passed!');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
