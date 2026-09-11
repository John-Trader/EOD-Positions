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

(async () => { try {
  const sandbox = {
    elements, document, localStorage, window, navigator, URL, crypto, fetch, AbortController,
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    parseFloat, parseInt, Number, Array, Math, Date, String, JSON, RegExp, Object, Map, Set, Error, Promise, Blob,
    globalThis: { crypto }
  };
  const fn = new Function(...Object.keys(sandbox), code + '; return { buildEntryOrderPayload, buildExitOrdersPayload, buildExitLegs, getRealtimeFields, currentRiskAndSlippage, twsReady, twsSendKey, setTwsSendState, resetTwsSendState, sendTwsEntry, sendTwsExits, twsSendState, splitSharesByPct, sanitizeTicker, API_CONFIGS, providerUsable, resolveProviders, demoteProvider, demotedProviders, delayedByTicker, applyTwsAccountValue, twsPositionFor, upsertTwsPosition, findDuplicatePscOrders, preflightContract, twsValidatedContracts, twsOpenOrders, handleTwsExecution, twsSeenExecs, activeTradesLog, saveActiveTradesLog, syncJournalToPositions, get accountValue() { return accountValue; }, get twsLastAccountValue() { return twsLastAccountValue; }, set twsEnabled(v) { twsEnabled = v; }, set twsQuotesEnabled(v) { twsQuotesEnabled = v; }, set twsConnected(v) { twsConnected = v; }, set twsBridgeUrl(v) { twsBridgeUrl = v; }, set twsBridgeToken(v) { twsBridgeToken = v; }, set twsPositionsEnabled(v) { twsPositionsEnabled = v; }, set twsOrdersEnabled(v) { twsOrdersEnabled = v; }, set twsFillsJournalEnabled(v) { twsFillsJournalEnabled = v; }, get twsPositions() { return twsPositions; }, set twsLastPositionsAt(v) { twsLastPositionsAt = v; } };');
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
  assertTrue(leg1Stp.transmit === true, 'leg1 STP transmit true');
  assertTrue(leg1Lmt.transmit === true, 'leg1 LMT transmit true');
  assertTrue(leg1Stp.orderRef.startsWith('PSC-AMPL-'), 'STP orderRef');
  assertTrue(leg1Stp.orderRef !== leg1Lmt.orderRef, 'per-order orderRef unique');
  assertEq(leg1Stp.ocaType, 1, 'standard leg ocaType=1');

  // Check second leg has a DIFFERENT OCA group
  const leg2Stp = exitPayload.orders[2];
  const leg2Lmt = exitPayload.orders[3];
  assertTrue(leg2Stp.ocaGroup !== leg1Stp.ocaGroup, 'leg2 OCA differs from leg1');
  assertEq(leg2Stp.ocaGroup, leg2Lmt.ocaGroup, 'leg2 shares own OCA group');
  assertTrue(leg2Stp.transmit === true, 'leg2 STP transmit true');
  assertTrue(leg2Lmt.transmit === true, 'leg2 LMT transmit true');

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

  // ---- TWS provider config ----
  assertTrue(api.API_CONFIGS.tws && api.API_CONFIGS.tws.needsKey === false, 'tws needsKey false');
  assertTrue(api.API_CONFIGS.tws.supportsWs === true, 'tws supportsWs');
  assertTrue(api.API_CONFIGS.tws.storageKey === null, 'tws storageKey null (uses bridge token)');

  // ---- providerUsable / resolution / demotion ----
  assertTrue(!api.providerUsable('tws'), 'tws unusable when bridge off');
  api.twsEnabled = true; api.twsQuotesEnabled = true; api.twsConnected = true;
  api.twsBridgeUrl = 'http://127.0.0.1:8787'; api.twsBridgeToken = 'tok';
  assertTrue(api.providerUsable('tws'), 'tws usable when bridge on + connected');
  api.demoteProvider('tws');
  assertTrue(api.demotedProviders.has('tws'), 'tws demoted');
  assertTrue(!api.resolveProviders() || api.resolveProviders().primary !== 'tws', 'demoted tws is not primary');
  api.demotedProviders.delete('tws');

  // ---- delayed flag lives in the side map, not on the quote ----
  api.delayedByTicker['AMPL'] = true;
  assertEq(api.delayedByTicker['AMPL'], true, 'delayed side-map holds flag');

  // ---- account sync: NetLiquidation → accountValue, ignores junk ----
  api.applyTwsAccountValue('NetLiquidation', '25000.50');
  assertEq(api.accountValue, 25000.50, 'NetLiquidation sets accountValue');
  api.applyTwsAccountValue('NetLiquidation', '0');
  assertEq(api.accountValue, 25000.50, 'zero NetLiquidation ignored (keeps last valid)');
  api.applyTwsAccountValue('AvailableFunds', '999');
  assertEq(api.accountValue, 25000.50, 'non-NetLiq key ignored');

  // ---- positions: upsert + lookup + duplicate-order detection ----
  api.twsPositionsEnabled = true;
  api.upsertTwsPosition('AMPL', 300, 14.52, 15.00);
  const pos = api.twsPositionFor('AMPL');
  assertEq(pos.qty, 300, 'held qty 300');
  assertEq(pos.avgCost, 14.52, 'held avgCost');
  api.upsertTwsPosition('AMPL', 0, 0, 0);
  assertEq(api.twsPositionFor('AMPL'), null, 'flat position removed');

  api.twsOrdersEnabled = true;
  api.twsOpenOrders.length = 0;
  api.twsOpenOrders.push({ orderId: 11, symbol: 'AMPL', action: 'BUY', orderRef: 'PSC-AMPL-abc', status: 'Submitted' });
  api.twsOpenOrders.push({ orderId: 12, symbol: 'AMPL', action: 'SELL', orderRef: 'PSC-AMPL-def', status: 'Submitted' });
  api.twsOpenOrders.push({ orderId: 13, symbol: 'AMPL', action: 'BUY', orderRef: 'manual-1', status: 'Submitted' });
  assertEq(api.findDuplicatePscOrders('AMPL', 'BUY').length, 1, 'duplicate check counts only PSC BUY orders');
  assertEq(api.findDuplicatePscOrders('AMPL', 'SELL').length, 1, 'PSC SELL order found');

  // ---- contract preflight caches per session ----
  api.twsValidatedContracts.clear();
  api.twsValidatedContracts.add('AMPL');
  const pf = await api.preflightContract('AMPL');
  assertEq(pf.ok, true, 'cached contract passes preflight without a request');

  // ---- fill → journal (PSC refs only, dedupe by execId) ----
  api.twsFillsJournalEnabled = true;
  api.twsSeenExecs.clear();
  const beforeLog = api.activeTradesLog.length;
  api.handleTwsExecution({ execId: 'e1', orderRef: 'PSC-AMPL-x', symbol: 'AMPL', side: 'BOT', shares: 100, price: 15.0 });
  assertEq(api.activeTradesLog.length, beforeLog + 1, 'entry fill opens journal row');
  assertEq(api.activeTradesLog[0].entryPrice, 15.0, 'journal entry price from fill');
  assertEq(api.activeTradesLog[0].side, 'LONG', 'BOT → LONG');
  api.handleTwsExecution({ execId: 'e1', orderRef: 'PSC-AMPL-x', symbol: 'AMPL', side: 'BOT', shares: 100, price: 15.0 });
  assertEq(api.activeTradesLog.length, beforeLog + 1, 'duplicate execId deduped');
  api.handleTwsExecution({ execId: 'e2', orderRef: 'OTHER-1', symbol: 'AMPL', side: 'BOT', shares: 50, price: 15.0 });
  assertEq(api.activeTradesLog.length, beforeLog + 1, 'non-PSC ref ignored');
  api.handleTwsExecution({ execId: 'e3', orderRef: 'PSC-AMPL-y', symbol: 'AMPL', side: 'SLD', shares: 100, price: 15.5 });
  assertEq(api.activeTradesLog[0].status, 'CLOSED', 'exit fill closes the journal row');
  assertEq(api.activeTradesLog[0].exitPrice, 15.5, 'journal exit price from fill');
  assertTrue(Math.abs(api.activeTradesLog[0].pnl - 50) < 0.001, 'realized P&L computed (100 sh × $0.50)');

  // Add-on fill merges (weighted-avg entry), partial exit shrinks and banks realized P&L.
  api.activeTradesLog.length = 0;
  api.handleTwsExecution({ execId: 'a1', orderRef: 'PSC-X-1', symbol: 'X', side: 'BOT', shares: 100, price: 10.0, commission: 1 });
  api.handleTwsExecution({ execId: 'a2', orderRef: 'PSC-X-2', symbol: 'X', side: 'BOT', shares: 100, price: 12.0, commission: 1 });
  assertEq(api.activeTradesLog.length, 1, 'add-on fill merges into one row');
  assertEq(api.activeTradesLog[0].shares, 200, 'merged shares = 200');
  assertEq(api.activeTradesLog[0].entryPrice, 11.0, 'weighted-avg entry = 11.00');
  api.handleTwsExecution({ execId: 'a3', orderRef: 'PSC-X-3', symbol: 'X', side: 'SLD', shares: 50, price: 13.0, commission: 1 });
  assertEq(api.activeTradesLog[0].status, 'ACTIVE', 'partial exit stays open');
  assertEq(api.activeTradesLog[0].shares, 150, 'partial exit shrinks to 150');
  // leg: (13-11)*50 - 1(fee) - 2(entry commissions) = 97
  assertTrue(Math.abs(api.activeTradesLog[0].realizedPnl - 97) < 0.001, 'partial leg banks realized P&L');
  api.handleTwsExecution({ execId: 'a4', orderRef: 'PSC-X-4', symbol: 'X', side: 'SLD', shares: 150, price: 14.0, commission: 1 });
  assertEq(api.activeTradesLog[0].status, 'CLOSED', 'final leg closes');
  // final: 97 + (14-11)*150 - 1 = 546
  assertTrue(Math.abs(api.activeTradesLog[0].pnl - 546) < 0.001, 'total P&L accumulates partial legs');

  // Position sync: shares follow held qty; flat position closes the row (estimated exit).
  api.activeTradesLog.length = 0;
  api.handleTwsExecution({ execId: 'b1', orderRef: 'PSC-Z-1', symbol: 'Z', side: 'BOT', shares: 200, price: 20.0 });
  api.upsertTwsPosition('Z', 120, 20.5, 21.0);
  api.twsLastPositionsAt = Date.now();
  api.syncJournalToPositions();
  assertEq(api.activeTradesLog[0].shares, 120, 'journal shares sync to held qty');
  api.upsertTwsPosition('Z', 0, 0, 0); // flat → deleted from map
  api.syncJournalToPositions();
  assertEq(api.activeTradesLog[0].status, 'CLOSED', 'flat position closes the journal row');
  api.activeTradesLog.length = 0;

  console.log('\nAll TWS tests passed');
  process.exit(0);
} catch (e) {
  console.error('Error during TWS tests:', e);
  process.exit(1);
} })();
