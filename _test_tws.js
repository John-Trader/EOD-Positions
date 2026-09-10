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
      checked: false,
      className: '',
      classList: {
        add: (...c) => { elements[id].className += ' ' + c.join(' '); },
        remove: (...c) => { c.forEach(cls => elements[id].className = elements[id].className.replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim()); },
        contains: (c) => elements[id].className.includes(c),
        toggle: (c, on) => { if (on) elements[id].classList.add(c); else elements[id].classList.remove(c); }
      },
      style: {},
      children: [],
      querySelectorAll: () => [],
      querySelector: () => null,
      appendChild: (ch) => elements[id].children.push(ch),
      addEventListener: () => {},
      setAttribute: (k, v) => { elements[id][k] = v; },
      getAttribute: (k) => elements[id][k],
      disabled: false,
      dataset: {},
      title: ''
    };
  }
  return elements[id];
}

const document = {
  getElementById: (id) => mockElement(id),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => mockElement('elem_' + Math.random()),
  addEventListener: () => {},
  hidden: false
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
const crypto = { randomUUID: () => 'test-uuid-1234' };
const fetch = async () => ({ ok: true, json: async () => ({ ok: true, connected: true, account: 'DU123', nextOrderId: 100 }) });
const AbortController = class { constructor() { this.signal = { aborted: false }; } abort() {} };

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error('FAIL', label, '\n  actual:', a, '\n  expected:', e);
    process.exit(1);
  }
  console.log('PASS', label);
}
function assertTrue(cond, label) {
  if (!cond) { console.error('FAIL', label); process.exit(1); }
  console.log('PASS', label);
}

try {
  const sandbox = {
    elements, document, localStorage, window, navigator, URL, crypto, fetch, AbortController,
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    parseFloat, parseInt, Number, Array, Math, Date, String, JSON, RegExp, Object, Map, Set, Error, Promise, Blob,
    globalThis: { crypto }
  };
  const fn = new Function(...Object.keys(sandbox), code + '; return { buildEntryOrderPayload, buildExitOrdersPayload, buildExitLegs, getRealtimeFields, currentRiskAndSlippage, twsReady, twsSendKey, setTwsSendState, resetTwsSendState, sendTwsEntry, sendTwsExits, twsEnabled, twsSendState, splitSharesByPct, sanitizeTicker };');
  const api = fn(...Object.values(sandbox));

  console.log('Script loaded successfully');

  // ---- buildEntryOrderPayload ----
  const longItem = { ticker: 'AMPL', data: { c: 15.00, h: 15.50, l: 14.50, pc: 14.00, bid: 14.99, ask: 15.01 }, trigger: 14.00, success: true };
  const longPayload = api.buildEntryOrderPayload(longItem);
  assertTrue(longPayload.ok, 'entry payload ok');
  assertEq(longPayload.symbol, 'AMPL', 'entry symbol');
  assertEq(longPayload.action, 'BUY', 'entry long = BUY');
  assertEq(longPayload.orderType, 'MKT', 'entry type MKT');
  assertEq(longPayload.adaptive, true, 'entry adaptive');
  assertEq(longPayload.adaptivePriority, 'Normal', 'entry Normal');
  assertEq(longPayload.tif, 'DAY', 'entry DAY');
  assertEq(longPayload.outsideRth, false, 'entry not outsideRth');
  assertTrue(longPayload.orderRef.startsWith('PSC-AMPL-'), 'entry orderRef format');
  assertTrue(longPayload.quantity > 0, 'entry qty > 0');

  const shortItem = { ticker: 'XYZ', data: { c: 10.00, h: 10.50, l: 9.50, pc: 11.00, bid: 9.99, ask: 10.01 }, trigger: 10.50, success: true };
  const shortPayload = api.buildEntryOrderPayload(shortItem);
  assertEq(shortPayload.action, 'SELL', 'entry short = SELL');

  // ---- buildExitOrdersPayload (stop-only short) ----
  const shortBuilt = api.buildExitLegs('XYZ', false, 95, 100, 100, 'short16', []);
  assertTrue(shortBuilt.ok, 'short16 stop-only builds ok');
  assertEq(shortBuilt.preview[0].stopOnly, true, 'short16 preview marks stopOnly');
  const shortExitPayload = api.buildExitOrdersPayload(shortBuilt);
  assertTrue(shortExitPayload.ok, 'short stop-only payload ok');
  assertEq(shortExitPayload.orders.length, 1, 'short stop-only = 1 order (STP only)');
  assertEq(shortExitPayload.orders[0].orderType, 'STP', 'short stop-only is STP');
  assertEq(shortExitPayload.orders[0].action, 'BUY', 'short exit is BUY');
  assertEq(shortExitPayload.orders[0].quantity, 100, 'short stop-only full qty');
  assertEq(shortExitPayload.orders[0].outsideRth, false, 'short STP not outsideRth');

  // ---- buildExitOrdersPayload ----
  // opt2 = 40% @ 1R + 60% @ 6R (two legs)
  const built = api.buildExitLegs('AMPL', true, 15.00, 100, 14.50, 'opt2', []);
  assertTrue(built.ok, 'buildExitLegs ok');
  const exitPayload = api.buildExitOrdersPayload(built);
  assertTrue(exitPayload.ok, 'exit payload ok');
  assertTrue(exitPayload.orders.length >= 4, 'exit orders >= 4 (2 legs x STP+LMT)');

  // Check first leg (STP + LMT, same OCA group)
  const leg1Stp = exitPayload.orders[0];
  const leg1Lmt = exitPayload.orders[1];
  assertEq(leg1Stp.orderType, 'STP', 'leg1 STP');
  assertEq(leg1Lmt.orderType, 'LMT', 'leg1 LMT');
  assertEq(leg1Stp.ocaGroup, leg1Lmt.ocaGroup, 'leg1 shares OCA group');
  assertEq(leg1Stp.action, 'SELL', 'leg1 STP action SELL');
  assertEq(leg1Lmt.action, 'SELL', 'leg1 LMT action SELL');
  assertEq(leg1Stp.outsideRth, false, 'STP not outsideRth');
  assertEq(leg1Lmt.outsideRth, true, 'LMT outsideRth');
  assertEq(leg1Stp.tif, 'GTC', 'STP GTC');
  assertEq(leg1Lmt.tif, 'GTC', 'LMT GTC');
  assertTrue(leg1Stp.transmit === true, 'STP transmit true');
  assertTrue(leg1Stp.orderRef.startsWith('PSC-AMPL-'), 'STP orderRef');
  assertTrue(leg1Stp.orderRef !== leg1Lmt.orderRef, 'per-order orderRef unique');
  assertEq(leg1Stp.ocaType, 1, 'standard leg ocaType=1');

  // Check second leg has a DIFFERENT OCA group
  const leg2Stp = exitPayload.orders[2];
  const leg2Lmt = exitPayload.orders[3];
  assertTrue(leg2Stp.ocaGroup !== leg1Stp.ocaGroup, 'leg2 OCA differs from leg1');
  assertEq(leg2Stp.ocaGroup, leg2Lmt.ocaGroup, 'leg2 shares own OCA group');

  // Qty split: 40% + 60% of 100 = 40 + 60
  assertEq(leg1Stp.quantity + leg2Stp.quantity, 100, 'STP qty split sums to 100');
  assertEq(leg1Lmt.quantity + leg2Lmt.quantity, 100, 'LMT qty split sums to 100');

  // ---- twsReady gating ----
  assertEq(api.twsReady(), false, 'twsReady false when disabled');

  // ---- Send-state machine ----
  const key = api.twsSendKey('AMPL', 'entry');
  assertEq(key, 'AMPL:entry', 'send key format');
  assertEq(api.twsSendState[key], undefined, 'initial state undefined');
  api.setTwsSendState(key, 'sending');
  assertEq(api.twsSendState[key], 'sending', 'state sending');
  api.setTwsSendState(key, 'sent');
  assertEq(api.twsSendState[key], 'sent', 'state sent');
  api.resetTwsSendState(key);
  assertEq(api.twsSendState[key], 'idle', 'state reset to idle');

  // ---- sendTwsEntry blocked when not ready ----
  // twsEnabled is false (localStorage returns null) so sendTwsEntry should early-return.
  api.sendTwsEntry('AMPL');
  assertEq(api.twsSendState['AMPL:entry'], 'idle', 'sendTwsEntry blocked when disabled — stays idle');

  console.log('\nAll TWS tests passed');
  process.exit(0);
} catch (e) {
  console.error('Error during TWS tests:', e);
  process.exit(1);
}
