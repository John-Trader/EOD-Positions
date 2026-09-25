const fs = require('fs');
const h = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');

const start = h.indexOf('<script>');
const end = h.lastIndexOf('</script>');
const code = h.slice(start + 8, end);

const elements = {};
let createdCount = 0;
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
        contains: (c) => elements[id].className.includes(c),
        toggle: () => {}
      },
      style: { display: '' },
      dataset: {},
      children: [],
      checked: false,
      disabled: false,
      querySelectorAll: () => [],
      querySelector: () => null,
      appendChild: (ch) => { if (ch) elements[id].children.push(ch); },
      addEventListener: () => {},
      insertAdjacentHTML: () => {},
      setAttribute: (k, v) => { elements[id][k] = v; },
      getAttribute: (k) => elements[id][k],
      click: () => {},
      closest: () => null,
      focus: () => {},
      remove: () => {}
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
  body: mockElement('body'),
  hidden: false
};
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const window = {
  isSecureContext: false,
  speechSynthesis: { speak: () => {}, cancel: () => {} },
  addEventListener: () => {}
};
const navigator = { serviceWorker: {}, clipboard: { writeText: () => Promise.resolve() } };
const URL = { createObjectURL: (x) => x, revokeObjectURL: () => {} };

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

function approx(a, b, eps = 0.01) {
  return Math.abs(a - b) < eps;
}

try {
  const sandbox = {
    elements, document, localStorage, window, navigator, URL,
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    parseFloat, parseInt, Number, Array, Math, Date, String, JSON, RegExp, Object, Map, Set, Error, Promise, Blob
  };
  const fn = new Function(...Object.keys(sandbox), code + '; return { parseExitOrderText, buildExitLegs };');
  const api = fn(...Object.values(sandbox));

  // Case 1: basic two-leg sample
  const sample = `Stops, BE alarms, TP orders:\n1) $AMPL - Stop (GTC): $13.15 - (40% Partial) Sell LMT: $15.34 - (1:6 TP) Sell LMT: $20.82`;

  let r = api.parseExitOrderText(sample);
  assert(r.trades.length === 1, 'should parse one trade');
  assert(r.trades[0].ticker === 'AMPL', 'ticker should be AMPL');
  assert(r.trades[0].isLong === true, 'side should be LONG');
  assert(r.trades[0].stop === 13.15, 'stop should be 13.15');
  assert(r.trades[0].legs.length === 2, 'should have two legs');
  assert(r.trades[0].legs[0].pct === 40, 'first leg pct 40');
  assert(r.trades[0].legs[0].tp === 15.34, 'first leg tp 15.34');
  assert(r.trades[0].legs[1].pct === 60, 'second leg pct 60');
  assert(r.trades[0].legs[1].tp === 20.82, 'second leg tp 20.82');
  assert(r.warnings.length === 0, 'no warnings for clean sample');

  // Case 2: starred ticker
  const star = `1) $**HRMY** - Stop (GTC): $39.37 - (40% Partial) Sell LMT: $43.13 - (1:6 TP) Sell LMT: $52.56`;
  r = api.parseExitOrderText(star);
  assert(r.trades[0].ticker === 'HRMY', 'starred ticker HRMY');
  assert(r.trades[0].legs[0].label === '40% Partial', 'preserve label');
  assert(r.trades[0].legs[1].label === '1:6 TP', 'preserve 1:6 TP label');
  assert(r.trades[0].legs[1].pct === 60, '1:6 TP not parsed as 1%');

  // Case 3: two tickers
  const multi = `1) $AMPL - Stop: $13.15 - Sell LMT: $15.34\n2) $INTA - Stop: $40.79 - Buy to Cover LMT: $46.45`;
  r = api.parseExitOrderText(multi);
  assert(r.trades.length === 2, 'two tickers');
  assert(r.trades[1].ticker === 'INTA', 'INTA ticker');
  assert(r.trades[1].isLong === false, 'Buy to Cover is short');

  // Case 4: missing percentage uses remainder
  const missingPct = `1) $AMPL - Stop: $13.15 - (40% Partial) Sell LMT: $15.34 - Sell LMT: $20.82`;
  r = api.parseExitOrderText(missingPct);
  assert(r.trades[0].legs[0].pct === 40, 'explicit 40');
  assert(r.trades[0].legs[1].pct === 60, 'missing leg gets 60');

  // Case 5: all missing pct split equally
  const allMissing = `1) $AMPL - Stop: $13.15 - Sell LMT: $15.34 - Sell LMT: $20.82`;
  r = api.parseExitOrderText(allMissing);
  assert(r.trades[0].legs[0].pct === 50, 'no pct first leg 50');
  assert(r.trades[0].legs[1].pct === 50, 'no pct second leg 50');

  // Case 6: short side from Buy to Cover
  const short = `1) $INTA - Stop (GTC): $40.79 - (40% Partial) Buy to Cover LMT: $46.45 - (1:6 TP) Buy to Cover LMT: $60.72`;
  r = api.parseExitOrderText(short);
  assert(r.trades[0].isLong === false, 'Buy to Cover means SHORT');
  assert(r.trades[0].legs[0].action === 'BUY', 'action BUY for short');

  // Case 7: percentage total over 100
  const over = `1) $AMPL - Stop: $13.15 - (70% Partial) Sell LMT: $15.34 - (50% TP) Sell LMT: $20.82`;
  r = api.parseExitOrderText(over);
  assert(r.trades.length === 0, 'skip pct over 100');
  assert(r.warnings.some(w => w.includes('120%')), 'warn pct over 100');

  // Case 8: duplicate ticker
  const dup = `1) $AMPL - Stop: $13.15 - Sell LMT: $15.34\n2) $AMPL - Stop: $14.00 - Sell LMT: $16.00`;
  r = api.parseExitOrderText(dup);
  assert(r.trades.length === 1, 'keep first duplicate');
  assert(r.warnings.some(w => w.includes('Duplicate AMPL')), 'warn duplicate');

  // Case 9: missing stop
  const noStop = `1) $AMPL - Sell LMT: $15.34`;
  r = api.parseExitOrderText(noStop);
  assert(r.trades.length === 0, 'skip missing stop');
  assert(r.warnings.some(w => w.includes('missing stop')), 'warn missing stop');

  // Case 10: no target legs -> 100% stop-only leg
  const noLegs = `1) $AMPL - Stop: $13.15`;
  r = api.parseExitOrderText(noLegs);
  assert(r.trades.length === 1, 'stop-only should parse');
  assert(r.trades[0].legs.length === 1, 'stop-only has one leg');
  assert(r.trades[0].legs[0].pct === 100, 'stop-only is 100%');
  assert(r.trades[0].legs[0].stopOnly === true, 'stop-only flag');
  assert(r.warnings.length === 0, 'no warnings for stop-only');

  // Case 10a: simple pasted stop order like "1) $BXMT - Stop (GTC): $13.90"
  const simpleStop = `---------------------------------\nStops & TP orders:\n1) $BXMT - Stop (GTC): $13.90`;
  r = api.parseExitOrderText(simpleStop);
  assert(r.trades.length === 1, 'simple pasted stop should parse');
  assert(r.trades[0].ticker === 'BXMT', 'ticker is BXMT');
  assert(r.trades[0].stop === 13.9, 'stop is 13.90');
  assert(r.trades[0].legs.length === 1, 'one stop-only leg');
  assert(r.trades[0].legs[0].pct === 100, '100% stop');
  assert(r.trades[0].legs[0].stopOnly === true, 'stopOnly flag set');

  // Case 11: 1:6 TP not 1% when paired with 40%
  const oneSix = `1) $AMPL - Stop: $13.15 - (40% Partial) Sell LMT: $15.34 - (1:6 TP) Sell LMT: $20.82`;
  r = api.parseExitOrderText(oneSix);
  assert(r.trades[0].legs[0].pct === 40, 'first pct 40');
  assert(r.trades[0].legs[1].pct === 60, 'second pct 60, not 1');

  // Case 12: two explicit 40% leave a 20% stop-only remainder leg
  const twoForty = `1) $AMPL - Stop: $13.15 - (40% Partial) Sell LMT: $15.34 - (40% TP) Sell LMT: $20.82`;
  r = api.parseExitOrderText(twoForty);
  assert(r.trades[0].legs.length === 3, 'three legs incl. remainder');
  assert(r.trades[0].legs[0].pct === 40, 'first 40');
  assert(r.trades[0].legs[1].pct === 40, 'second stays 40');
  assert(r.trades[0].legs[2].pct === 20 && r.trades[0].legs[2].stopOnly === true, 'remainder 20% stop-only');
  assert(r.warnings.some(w => w.includes('remainder')), 'warn remainder stop-only');

  // Case 13: commas in prices
  const comma = `1) $AMPL - Stop (GTC): $1,234.56 - (40% Partial) Sell LMT: $1,234.57`;
  r = api.parseExitOrderText(comma);
  assert(r.trades[0].stop === 1234.56, 'comma stop');
  assert(r.trades[0].legs[0].tp === 1234.57, 'comma target');

  // Case 13a: a lone "(25% Partial)" leg keeps its 25% — the rest rides the stop
  const pbPaste = `Stops & TP orders:**\nPB Pullbacks\n1) $XLF - Stop (GTC): $53.24 - (25% Partial) Sell LMT: $56.41`;
  r = api.parseExitOrderText(pbPaste);
  assert(r.trades.length === 1, 'PB paste yields one trade');
  assert(r.trades[0].ticker === 'XLF', 'ticker XLF');
  assert(r.trades[0].stop === 53.24, 'stop 53.24');
  assert(r.trades[0].legs.length === 2, 'two legs: partial + stop-only remainder');
  assert(r.trades[0].legs[0].pct === 25 && r.trades[0].legs[0].tp === 56.41, '25% leg stays 25%');
  assert(r.trades[0].legs[1].pct === 75 && r.trades[0].legs[1].stopOnly === true, '75% stop-only remainder');
  assert(r.warnings.some(w => w.includes('remainder')), 'warns about stop-only remainder');

  // Integration case: buildExitLegs with explicit legs
  const intLegs = [{ pct: 40, tp: 15.34, label: '40% Partial' }, { pct: 60, tp: 20.82, label: '1:6 TP' }];
  const b2 = api.buildExitLegs('AMPL', true, 13.96, 1000, 13.15, null, null, { explicitLegs: intLegs });
  assert(b2.ok === true, 'buildExitLegs should succeed');
  assert(b2.preview.length === 2, 'two preview legs');
  assert(b2.preview[0].qty === 400, 'first leg 400 shares');
  assert(b2.preview[0].stop === 13.15, 'first stop 13.15');
  assert(b2.preview[0].tp === 15.34, 'first tp 15.34');
  assert(approx(b2.preview[0].trueRr, 1.7, 0.01), 'first rr approx 1.7');
  assert(b2.preview[1].qty === 600, 'second leg 600 shares');
  assert(b2.preview[1].tp === 20.82, 'second tp 20.82');
  assert(approx(b2.preview[1].trueRr, 8.47, 0.01), 'second rr approx 8.47');

  // CSV structure
  const csv = b2.rows;
  assert(csv.length === 4, 'four CSV rows for two legs');
  assert(csv[0][0] === 'SELL' && csv[0][1] === 400 && csv[0][7] === 'STP' && csv[0][9] === '13.15', 'first STP row');
  assert(csv[1][0] === 'SELL' && csv[1][1] === 400 && csv[1][7] === 'LMT' && csv[1][8] === '15.34', 'first LMT row');
  assert(csv[2][0] === 'SELL' && csv[2][1] === 600 && csv[2][7] === 'STP', 'second STP row');
  assert(csv[3][0] === 'SELL' && csv[3][1] === 600 && csv[3][7] === 'LMT' && csv[3][8] === '20.82', 'second LMT row');

  // Optional entry: buildExitLegs with explicit legs and entry=0 still produces CSV rows and shows no R:R.
  const b3 = api.buildExitLegs('AMPL', true, 0, 1000, 13.15, null, null, { explicitLegs: intLegs });
  assert(b3.ok === true, 'buildExitLegs with no entry should succeed for pasted legs');
  assert(b3.preview.length === 2, 'two preview legs without entry');
  assert(b3.preview[0].qty === 400, 'first qty 400 without entry');
  assert(b3.preview[0].tp === 15.34, 'first tp still 15.34 without entry');
  assert(b3.preview[0].trueRr === 0, 'trueRr is 0 without entry');
  assert(b3.rows.length === 4, 'CSV rows still generated without entry');
  assert(b3.rows[0][0] === 'SELL' && b3.rows[0][7] === 'STP' && b3.rows[0][9] === '13.15', 'STP row without entry');
  assert(b3.rows[1][0] === 'SELL' && b3.rows[1][7] === 'LMT' && b3.rows[1][8] === '15.34', 'LMT row without entry');

  // Reported scenario: "(25% Partial)" paste on 400 shares must send
  // STP 100 + LMT 100 for leg 1 and a lone STP 300 for the remainder leg —
  // never LMT 400.
  const pbParsed = api.parseExitOrderText(`Stops & TP orders:**\nPB Pullbacks\n1) $XLF - Stop (GTC): $53.24 - (25% Partial) Sell LMT: $56.41`);
  const b4 = api.buildExitLegs('XLF', true, 0, 400, 53.24, null, null, { explicitLegs: pbParsed.trades[0].legs });
  assert(b4.ok === true, 'XLF buildExitLegs ok');
  assert(b4.preview.length === 2, 'two legs for XLF');
  assert(b4.preview[0].qty === 100 && b4.preview[0].tp === 56.41, 'leg1: 100 shares with LMT 56.41');
  assert(b4.preview[1].qty === 300 && b4.preview[1].stopOnly === true, 'leg2: 300 shares stop-only');
  assert(b4.rows.length === 3, 'three order rows (STP/LMT/STP)');
  assert(b4.rows[0][1] === 100 && b4.rows[0][7] === 'STP' && b4.rows[0][9] === '53.24', 'leg1 STP 100');
  assert(b4.rows[1][1] === 100 && b4.rows[1][7] === 'LMT' && b4.rows[1][8] === '56.41', 'leg1 LMT 100');
  assert(b4.rows[2][1] === 300 && b4.rows[2][7] === 'STP' && b4.rows[2][9] === '53.24', 'leg2 STP 300');
  const oca1 = b4.rows[0][11], oca2 = b4.rows[2][11];
  assert(b4.rows[0][11] === b4.rows[1][11], 'leg1 pair shares one OCA group');
  assert(oca1 !== oca2, 'remainder leg gets its own OCA group');

  console.log('\nAll paste exit tests passed');
  process.exit(0);
} catch (e) {
  console.error('Error during paste exit tests:', e);
  process.exit(1);
}
