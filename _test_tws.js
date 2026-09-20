const fs = require('fs');
const h = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');

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
const store = {};
const localStorage = {
  getItem: (k) => (store[k] !== undefined ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};
const window = {
  isSecureContext: false,
  speechSynthesis: { speak: () => {}, cancel: () => {} },
  addEventListener: () => {}
};
const navigator = { serviceWorker: {}, clipboard: { writeText: () => Promise.resolve() } };
const URL = { createObjectURL: (x) => x, revokeObjectURL: () => {} };
const crypto = { randomUUID: () => 'test-uuid-1234' };
const fetchCalls = [];
let cancelResponse = { ok: true, orderId: 0, status: 'Cancelled' };
let ordersResponse = { ok: true, orders: [] };
const fetch = async (url, opts) => {
  const u = String(url);
  fetchCalls.push({ url: u, opts });
  let body = { ok: true, connected: true, account: 'DU123', nextOrderId: 100 };
  if (u.endsWith('/executions')) {
    // Fill matches whatever quantity the /order POST carried.
    const orderPost = fetchCalls.find(c => c.url.endsWith('/order') && c.opts && c.opts.method === 'POST');
    const q = orderPost ? (JSON.parse(orderPost.opts.body).quantity || 0) : 0;
    body = { ok: true, executions: [{ execId: 'e1', orderId: 4242, symbol: 'AMPL', side: 'BOT', shares: q, price: 15, time: 'now' }] };
  } else if (u.endsWith('/order') && opts && opts.method === 'POST') {
    body = { ok: true, orderId: 4242, status: 'Filled', filled: 0, remaining: 0 };
  } else if (u.endsWith('/orders') && opts && opts.method === 'POST') {
    body = { ok: true, results: [{ ok: true, orderId: 4243 }, { ok: true, orderId: 4244 }, { ok: true, orderId: 4245 }, { ok: true, orderId: 4246 }] };
  } else if (u.endsWith('/orders')) {
    body = { ...ordersResponse, orders: (ordersResponse.orders || []).map(o => ({ ...o })) };
  } else if (u.endsWith('/cancel') && opts && opts.method === 'POST') {
    body = typeof cancelResponse === 'function' ? cancelResponse(JSON.parse(opts.body)) : cancelResponse;
  } else if (u.includes('/contract')) {
    body = { ok: true };
  }
  return { ok: true, status: 200, json: async () => body };
};
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
  const fn = new Function(...Object.keys(sandbox), code + '; return { buildEntryOrderPayload, buildExitOrdersPayload, buildExitLegs, getRealtimeFields, currentRiskAndSlippage, twsReady, twsSendKey, setTwsSendState, resetTwsSendState, sendTwsEntry, sendTwsExits, twsSendState, splitSharesByPct, sanitizeTicker, API_CONFIGS, providerUsable, resolveProviders, demoteProvider, demotedProviders, delayedByTicker, applyTwsAccountValue, twsPositionFor, upsertTwsPosition, findDuplicatePscOrders, preflightContract, twsValidatedContracts, get twsOpenOrders() { return twsOpenOrders; }, handleTwsExecution, twsSeenExecs, twsExecKey, activeTradesLog, saveActiveTradesLog, syncJournalToPositions, twsEntryOrderSpec, twsAutoSendStrategyId, AUTO_STRATEGY, defaultStrategyId, setGlobalRegime, get accountValue() { return accountValue; }, get twsLastAccountValue() { return twsLastAccountValue; }, get globalMarketRegime() { return globalMarketRegime; }, set twsEnabled(v) { twsEnabled = v; }, set twsQuotesEnabled(v) { twsQuotesEnabled = v; }, set twsConnected(v) { twsConnected = v; }, set twsBridgeUrl(v) { twsBridgeUrl = v; }, set twsBridgeToken(v) { twsBridgeToken = v; }, set twsPositionsEnabled(v) { twsPositionsEnabled = v; }, set twsOrdersEnabled(v) { twsOrdersEnabled = v; }, set twsFillsJournalEnabled(v) { twsFillsJournalEnabled = v; }, cancelTwsOrder, set twsEntryOutsideRth(v) { twsEntryOutsideRth = v; }, set twsExitStrategy(v) { twsExitStrategy = v; }, get twsExitStrategy() { return twsExitStrategy; }, get twsPositions() { return twsPositions; }, set twsLastPositionsAt(v) { twsLastPositionsAt = v; } };');
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
  assertEq(api.activeTradesLog.length, beforeLog + 1, 'non-PSC same-side fill merges into existing row');
  assertEq(api.activeTradesLog[0].shares, 150, 'manual entry fill merges shares');
  api.handleTwsExecution({ execId: 'e2b', orderRef: 'OTHER-2', symbol: 'NVDA', side: 'BOT', shares: 25, price: 100 });
  assertEq(api.activeTradesLog[0].ticker, 'NVDA', 'non-PSC entry fill with no row creates one at fill price');
  api.handleTwsExecution({ execId: 'e3', orderRef: 'PSC-AMPL-y', symbol: 'AMPL', side: 'SLD', shares: 150, price: 15.5 });
  const amplRow = api.activeTradesLog.find(t => t.ticker === 'AMPL');
  assertEq(amplRow.status, 'CLOSED', 'exit fill closes the journal row');
  assertEq(amplRow.exitPrice, 15.5, 'journal exit price from fill');
  assertTrue(Math.abs(amplRow.pnl - 75) < 0.001, 'realized P&L computed (150 sh × $0.50)');

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

  // ---- Position auto-import: held position with no journal row creates one ----
  api.twsSeenExecs.clear();
  api.upsertTwsPosition('HRMY', 219, 45.0, 50.0);
  api.syncJournalToPositions();
  const hRow = api.activeTradesLog.find(t => t.ticker === 'HRMY');
  assertTrue(hRow && hRow.status === 'ACTIVE', 'held position auto-imports as journal row');
  assertEq(hRow.shares, 219, 'imported shares = position qty');
  assertEq(hRow.entryPrice, 45.0, 'imported entry = avgCost');

  // Manual partial sell with no fill seen → estimated P&L banked
  api.upsertTwsPosition('HRMY', 169, 45.0, 52.0);
  api.syncJournalToPositions();
  assertEq(hRow.shares, 169, 'manual partial sell shrinks row to broker qty');
  assertTrue(Math.abs(hRow.realizedPnl - 350) < 0.001, 'estimate banked for unseen shrink (50 × $7)');

  // Late real fill posts a correction, not a second leg
  api.handleTwsExecution({ execId: 'm1', orderRef: 'manual', symbol: 'HRMY', side: 'SLD', shares: 50, price: 53.0 });
  assertEq(hRow.shares, 169, 'fill already reflected in position — shares unchanged');
  assertTrue(Math.abs(hRow.realizedPnl - 400) < 0.001, 'real fill corrects estimate (+50 × $1)');

  // Full exit fill at real price closes the row
  api.handleTwsExecution({ execId: 'm2', orderRef: 'manual', symbol: 'HRMY', side: 'SLD', shares: 169, price: 55.0 });
  assertEq(hRow.status, 'CLOSED', 'full exit fill closes row');
  assertEq(hRow.exitPrice, 55.0, 'closed at real fill price');
  assertTrue(Math.abs(hRow.pnl - 2090) < 0.001, 'P&L = estimate + correction + final leg');

  // Fresh close + lingering position snapshot must not resurrect the row
  api.upsertTwsPosition('HRMY', 169, 55.0, 55.0);
  api.syncJournalToPositions();
  assertTrue(!api.activeTradesLog.find(t => t.ticker === 'HRMY' && t.status === 'ACTIVE'), 'stale position does not re-import right after close');

  api.activeTradesLog.length = 0;
  api.upsertTwsPosition('HRMY', 0, 0, 0);

  // ---- attachEntry two-phase: entry first, fill-wait, then standalone OCA exits ----
  // (parentId-attached children get resized by TWS to the parent's filled qty —
  // exits must NOT carry parentRef.)
  api.twsEnabled = true; api.twsOrdersEnabled = true; api.twsConnected = true;
  api.twsBridgeUrl = 'http://127.0.0.1:8787'; api.twsBridgeToken = 'tok';
  fetchCalls.length = 0;
  const attachRes = await api.sendTwsExits('AMPL', true, 15.00, 100, 14.50, 'opt2', [], true, longItem, {});
  assertTrue(attachRes && attachRes.ok, 'attachEntry send resolves ok');
  const orderPost = fetchCalls.find(c => c.url.endsWith('/order') && c.opts && c.opts.method === 'POST');
  const ordersPost = fetchCalls.find(c => c.url.endsWith('/orders') && c.opts && c.opts.method === 'POST');
  assertTrue(!!orderPost, 'entry posted to /order first');
  assertTrue(!!ordersPost, 'exits posted to /orders after fill');
  assertTrue(fetchCalls.indexOf(orderPost) < fetchCalls.indexOf(ordersPost), 'entry precedes exits');
  const entryBody = JSON.parse(orderPost.opts.body);
  assertTrue(entryBody.quantity > 0, 'entry carries qty');
  const exitOrders = JSON.parse(ordersPost.opts.body).orders;
  assertEq(exitOrders.length, 4, 'opt2 exits = 4 standalone orders');
  assertTrue(exitOrders.every(o => o.parentRef === undefined && o.parentId === undefined), 'no parentRef/parentId on exits');
  assertTrue(exitOrders.every(o => o.transmit === true), 'all exits transmit individually');
  const stps = exitOrders.filter(o => o.orderType === 'STP').map(o => o.quantity);
  const lmts = exitOrders.filter(o => o.orderType === 'LMT').map(o => o.quantity);
  const want = api.splitSharesByPct(entryBody.quantity, [40, 60]);
  assertEq(stps, want, 'STP legs carry pct split, not parent qty');
  assertEq(lmts, want, 'LMT legs carry pct split, not parent qty');
  assertTrue(stps[0] > 0 && stps[0] < entryBody.quantity, 'leg1 is a partial qty');

  // ---- twsEntryOrderSpec: outside-RTH entries go out as LMT at last price ----
  api.twsEntryOutsideRth = false;
  assertEq(api.twsEntryOrderSpec(15, true).orderType, 'MKT', 'toggle off -> MKT in RTH');
  assertEq(api.twsEntryOrderSpec(15, false).orderType, 'MKT', 'toggle off -> MKT outside RTH');
  assertEq(api.twsEntryOrderSpec(15, false).outsideRth, false, 'toggle off -> outsideRth false');
  api.twsEntryOutsideRth = true;
  let spec = api.twsEntryOrderSpec(15, true);
  assertEq(spec.orderType, 'MKT', 'toggle on, RTH -> stays MKT');
  assertEq(spec.outsideRth, true, 'toggle on, RTH -> outsideRth flag set');
  spec = api.twsEntryOrderSpec(15, false);
  assertEq(spec.orderType, 'LMT', 'toggle on, outside RTH -> LMT');
  assertEq(spec.lmtPrice, 15, 'LMT at last price');
  assertEq(spec.outsideRth, true, 'LMT order carries outsideRth');
  spec = api.twsEntryOrderSpec(0, false);
  assertEq(spec.orderType, 'MKT', 'no price -> stays MKT (cannot price a limit)');
  api.twsEntryOutsideRth = false;

  // ---- twsAutoSendStrategyId: auto follows regime, manual overrides, shorts fixed ----
  api.twsExitStrategy = '__auto';
  assertEq(api.twsAutoSendStrategyId(true), api.defaultStrategyId(true), 'auto -> regime long strategy');
  assertEq(api.twsAutoSendStrategyId(false), 'short16', 'shorts always short16');
  api.twsExitStrategy = 'opt1';
  assertEq(api.twsAutoSendStrategyId(true), 'opt1', 'manual override wins for longs');
  assertEq(api.twsAutoSendStrategyId(false), 'short16', 'override does not touch shorts');
  api.twsExitStrategy = 'doesnotexist';
  assertEq(api.twsAutoSendStrategyId(true), api.defaultStrategyId(true), 'deleted strategy -> falls back to regime');
  api.twsExitStrategy = 'short16';
  assertEq(api.twsAutoSendStrategyId(true), api.defaultStrategyId(true), 'short strategy not selectable for longs');
  api.twsExitStrategy = 'opt1';
  api.setGlobalRegime('declining', false);
  assertEq(api.twsExitStrategy, api.AUTO_STRATEGY, 'regime change resets override to auto');
  api.setGlobalRegime('expanding', false);

  // ---- cancelTwsOrder: three response paths ----
  // 1) Confirmed cancel — row drops immediately.
  fetchCalls.length = 0;
  cancelResponse = { ok: true, orderId: 99, status: 'Cancelled' };
  api.twsOpenOrders.length = 0;
  api.twsOpenOrders.push({ orderId: 99, symbol: 'AMPL', action: 'SELL', qty: 2, type: 'STP', orderRef: 'PSC-AMPL-s1', status: 'Submitted' });
  await api.cancelTwsOrder(99);
  const cancelPost = fetchCalls.find(c => c.url.endsWith('/cancel') && c.opts && c.opts.method === 'POST');
  assertTrue(!!cancelPost, 'cancel posts to /cancel');
  assertEq(JSON.parse(cancelPost.opts.body).orderId, 99, 'cancel sends numeric orderId');
  assertEq(api.twsOpenOrders.some(o => o.orderId === 99), false, 'confirmed cancel drops the row');

  // 2) Rejected — row survives the refresh (snapshot still reports it working).
  cancelResponse = { ok: false, orderId: 97, status: 'CancelRejected', message: 'test rejection' };
  ordersResponse = { ok: true, orders: [{ orderId: 97, symbol: 'AMPL', action: 'SELL', qty: 3, type: 'LMT', orderRef: 'PSC-AMPL-t2', status: 'Submitted' }] };
  api.twsOpenOrders.push({ orderId: 97, symbol: 'AMPL', action: 'SELL', qty: 3, type: 'LMT', orderRef: 'PSC-AMPL-t2', status: 'Submitted' });
  await api.cancelTwsOrder(97);
  assertEq(api.twsOpenOrders.some(o => o.orderId === 97), true, 'rejected cancel keeps the row after refresh');

  // 3) Sent-but-unconfirmed — the /orders snapshot confirms it gone on the first poll.
  cancelResponse = { ok: true, orderId: 98, status: 'CancelSent', pending: true };
  api.twsOpenOrders.push({ orderId: 98, symbol: 'AMPL', action: 'SELL', qty: 3, type: 'LMT', orderRef: 'PSC-AMPL-t1', status: 'Submitted' });
  await api.cancelTwsOrder(98);
  assertEq(api.twsOpenOrders.some(o => o.orderId === 98), false, 'pending cancel confirmed via orders snapshot');
  assertEq(api.twsOpenOrders.some(o => o.orderId === 97), true, 'unrelated orders untouched during pending confirm');
  ordersResponse = { ok: true, orders: [] };

  // ---- exec dedupe persists to storage (a reload must not replay fills) ----
  assertEq(api.twsExecKey({ execId: 'e1', time: '20260914  15:42:01' }), '20260914|e1', 'exec key = day prefix + execId');
  assertEq(api.twsExecKey({ execId: 'e1' }), 'e1', 'exec key falls back to bare execId');
  // Entries may be plain exec keys (legacy) or [key, commission] pairs.
  const storedExecs = JSON.parse(store.twsSeenExecs || '[]');
  assertTrue(storedExecs.length === api.twsSeenExecs.size && storedExecs.every(e => api.twsSeenExecs.has(Array.isArray(e) ? e[0] : e)), 'stored exec ids mirror the in-memory set');

  console.log('\nAll TWS tests passed');
  process.exit(0);
} catch (e) {
  console.error('Error during TWS tests:', e);
  process.exit(1);
} })();
