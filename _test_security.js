// Security & sanitisation tests for the standalone HTML app.
// Extracts the inline script and tests helper functions directly.
const fs = require('fs');
const h = fs.readFileSync('C:/Users/levif/Desktop/End-of-day/index.html', 'utf8');

const start = h.indexOf('<script>');
const end = h.lastIndexOf('</script>');
const code = h.slice(start + 8, end);

const elements = {};
let createdCount = 0;
function mockElement(id) {
  if (!elements[id]) {
    elements[id] = {
      id, innerText: '', innerHTML: '', value: id === 'apiProvider' ? 'finnhub' : '', className: '',
      dataset: {}, style: {}, children: [], checked: false, disabled: false,
      classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
      querySelectorAll: () => [], querySelector: () => null,
      appendChild: () => {}, removeChild: () => {}, insertAdjacentHTML: () => {},
      addEventListener: () => {}, setAttribute: () => {}, getAttribute: () => null,
      click: () => {}, closest: () => null, focus: () => {}, remove: () => {}
    };
  }
  return elements[id];
}
const document = {
  getElementById: (id) => mockElement(id),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => mockElement('elem_' + (createdCount++)),
  addEventListener: () => {},
  body: mockElement('body')
};
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const window = { speechSynthesis: { speak: () => {}, cancel: () => {} }, addEventListener: () => {} };
const navigator = { serviceWorker: {}, clipboard: { writeText: () => Promise.resolve() } };
const URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} };

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
}

try {
  const sandbox = {
    document, localStorage, window, navigator, URL,
    console, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    parseFloat, parseInt, Number, Array, Math, Date, String, JSON, RegExp, Object, Map, Set, Error, Promise, Blob, alert: () => {}, confirm: () => true
  };
  const fn = new Function(...Object.keys(sandbox), code + '; return { sanitizeTicker, escapeHtml, parseExitOrderText, buildExitLegs };');
  const api = fn(...Object.values(sandbox));

  assert(api.escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;', 'escapeHtml encodes tags');
  assert(api.escapeHtml('A&B"C\'D') === 'A&amp;B&quot;C&#39;D', 'escapeHtml encodes amp, quote, apos');
  assert(api.sanitizeTicker('A<B&C-D.E') === 'ABC-D.E', 'sanitizeTicker strips illegal chars');
  assert(api.sanitizeTicker('brk.b*test') === 'BRK.BTEST', 'sanitizeTicker uppercases and preserves dot');

  const pasted = api.parseExitOrderText('1) $AMPL - Stop: $13.15 - (40% Partial <b>) Sell LMT: $15.34');
  assert(pasted.trades.length === 1, 'parser keeps one trade');
  assert(pasted.trades[0].legs[0].label === '40% Partial <b>', 'parser preserves raw label');

  const built = api.buildExitLegs('AMPL', true, 0, 1000, 13.15, null, null, {
    explicitLegs: [{ pct: 100, tp: 15.34, label: '40% Partial <b>' }]
  });
  assert(built.ok, 'buildExitLegs succeeds with no entry and explicit legs');
  assert(built.preview[0].label === '40% Partial <b>', 'buildExitLegs preserves raw label for renderer escaping');

  console.log('All security tests passed');
  process.exit(0);
} catch (e) {
  console.error('Error during security tests:', e);
  process.exit(1);
}
