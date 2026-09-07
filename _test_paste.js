const fs = require('fs');
const h = fs.readFileSync('C:/Users/levif/Desktop/End-of-day/index.html', 'utf8');

const start = h.indexOf('<script>');
const end = h.lastIndexOf('</script>');
const code = h.slice(start + 8, end);

const elements = {};
function mockElement(id) {
  if (!elements[id]) {
    elements[id] = {
      id,
      innerText: '',
      innerHTML: '',
      value: id === 'apiProvider' ? 'finnhub' : '',
      className: '',
      classList: {
        add: (...c) => { elements[id].className += ' ' + c.join(' '); },
        remove: (...c) => { c.forEach(cls => elements[id].className = elements[id].className.replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim()); },
        contains: (c) => elements[id].className.includes(c)
      },
      style: {},
      children: [],
      querySelectorAll: () => [],
      querySelector: () => null,
      appendChild: (ch) => elements[id].children.push(ch),
      addEventListener: () => {}
    };
  }
  return elements[id];
}

const document = {
  getElementById: (id) => mockElement(id),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => mockElement('elem_' + Math.random()),
  addEventListener: () => {}
};
const localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};
const window = {
  isSecureContext: false,
  speechSynthesis: { speak: () => {}, cancel: () => {} },
  addEventListener: () => {}
};
const navigator = { serviceWorker: {}, clipboard: { writeText: () => Promise.resolve() } };
const URL = { createObjectURL: (x) => x, revokeObjectURL: () => {} };

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error('FAIL', label, '\n  actual:', a, '\n  expected:', e);
    process.exit(1);
  }
  console.log('PASS', label);
}

try {
  const sandbox = {
    elements, document, localStorage, window, navigator, URL,
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    parseFloat, parseInt, Number, Array, Math, Date, String, JSON, RegExp, Object, Map, Set, Error, Promise, Blob
  };
  const fn = new Function(...Object.keys(sandbox), code + '; return { parseSignalText };');
  const api = fn(...Object.values(sandbox));

  const discordSample = `**TODAY'S SIGNALS**:

1) $**AMPL** (Amplitude Inc) - If closing above $13.96 LONG

2) $**INTA** (Intapp, Inc) - If closing above $42.84 LONG

3) $**ZETA** (Zeta Global holdings Corp) - If closing above $30.02 LONG

4) $**PTC** (PTC Inc) - If closing above $157.55 LONG

5) $**CHYM** (Chime Financials) - If closing above $33.72 LONG`;

  let out = api.parseSignalText(discordSample);
  assertEq(out.signals.length, 5, 'Discord sample count');
  assertEq(out.signals.map(s => s.ticker), ['AMPL', 'INTA', 'ZETA', 'PTC', 'CHYM'], 'Discord tickers');
  assertEq(out.signals.map(s => s.trigger), [13.96, 42.84, 30.02, 157.55, 33.72], 'Discord triggers');
  assertEq(out.signals.map(s => s.signalSide), ['LONG', 'LONG', 'LONG', 'LONG', 'LONG'], 'Discord sides');

  out = api.parseSignalText('$*AMPL* closing above $13.96 LONG');
  assertEq(out.signals, [{ ticker: 'AMPL', trigger: 13.96, signalSide: 'LONG' }], 'Single stars');

  out = api.parseSignalText('$***AMPL*** closing above $13.96 LONG');
  assertEq(out.signals, [{ ticker: 'AMPL', trigger: 13.96, signalSide: 'LONG' }], 'Triple stars');

  out = api.parseSignalText('**$AMPL** closing above $13.96 LONG');
  assertEq(out.signals, [{ ticker: 'AMPL', trigger: 13.96, signalSide: 'LONG' }], 'Outer bold');

  out = api.parseSignalText('$ **AMPL** closing above $13.96 LONG');
  assertEq(out.signals, [{ ticker: 'AMPL', trigger: 13.96, signalSide: 'LONG' }], 'Dollar space stars');

  out = api.parseSignalText('** $AMPL ** closing above $13.96 LONG');
  assertEq(out.signals, [{ ticker: 'AMPL', trigger: 13.96, signalSide: 'LONG' }], 'Outer spaces');

  out = api.parseSignalText('**AMPL** $13.96 LONG');
  assertEq(out.signals, [{ ticker: 'AMPL', trigger: 13.96, signalSide: 'LONG' }], 'No-dollar fallback');

  out = api.parseSignalText('** AMPL ** 13.96 LONG');
  assertEq(out.signals, [{ ticker: 'AMPL', trigger: 13.96, signalSide: 'LONG' }], 'No-dollar spaces fallback');

  out = api.parseSignalText('$** AMPL ** closing above $13.96 LONG');
  assertEq(out.signals, [{ ticker: 'AMPL', trigger: 13.96, signalSide: 'LONG' }], 'Spaces inside stars');

  out = api.parseSignalText('$AMPL closing above $13.96 LONG');
  assertEq(out.signals, [{ ticker: 'AMPL', trigger: 13.96, signalSide: 'LONG' }], 'Plain dollar format');

  out = api.parseSignalText('AMPL $13.96 LONG');
  assertEq(out.signals, [{ ticker: 'AMPL', trigger: 13.96, signalSide: 'LONG' }], 'Plain fallback format');

  out = api.parseSignalText('$AMPL closing above $13.96 LONG\n$AMPL closing above $14.00 LONG');
  assertEq(out.signals.length, 1, 'Duplicate count');
  assertEq(out.warnings.some(w => /duplicate/i.test(w)), true, 'Duplicate warning');

  const many = Array.from({ length: 10 }, (_, i) => `$**TICK${i}** closing above $${10 + i}.00 LONG`).join('\n');
  out = api.parseSignalText(many);
  assertEq(out.signals.length, 9, 'Ten signals truncated to 9');
  assertEq(out.warnings.some(w => /exceed the grid limit/i.test(w)), true, 'Excess warning');

  console.log('\nAll paste tests passed');
  process.exit(0);
} catch (e) {
  console.error('Error during paste tests:', e);
  process.exit(1);
}
