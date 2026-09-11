// Bridge helper tests — exercises the pure exports of tws-bridge/server.js
// (require.main guard keeps it from opening listeners/sockets when required).
const path = require('path');

const bridge = require(path.join(__dirname, 'tws-bridge', 'server.js'));

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) { console.error('FAIL', label, '\n  actual:', a, '\n  expected:', e); process.exit(1); }
  console.log('PASS', label);
}
function assertTrue(cond, label) {
  if (!cond) { console.error('FAIL', label); process.exit(1); }
  console.log('PASS', label);
}

// ---- require.main guard ----
assertTrue(typeof bridge.buildOrder === 'function', 'module exports helpers without starting the server');

// ---- symbol conversion ----
assertEq(bridge.toIbkSymbol('BRK.B'), 'BRK B', 'dot share class -> space');
assertEq(bridge.toIbkSymbol('BRK-B'), 'BRK B', 'hyphen share class -> space');
assertEq(bridge.toIbkSymbol('aapl'), 'AAPL', 'uppercases plain symbols');
assertEq(bridge.toIbkSymbol('BRK.B.A'), 'BRK.B.A', 'multi-suffix left alone');

// ---- tick maps ----
assertEq(bridge.TICK_PRICE_MAP[4], 'last', 'tick 4 = last');
assertEq(bridge.TICK_PRICE_MAP[9], 'close', 'tick 9 = prev close');
assertEq(bridge.TICK_PRICE_DELAYED[66], 'bid', 'delayed 66 = bid');
assertEq(bridge.TICK_PRICE_DELAYED[68], 'last', 'delayed 68 = last');
assertEq(bridge.TICK_PRICE_DELAYED[75], 'close', 'delayed 75 = close');
assertTrue(bridge.TICK_PRICE_DELAYED[70] === undefined, 'tick 70 is a size, not price');

// ---- error classification ----
assertEq(bridge.classifyMdError(200), 'error', 'code 200 = symbol error');
assertEq(bridge.classifyMdError(354), 'error', 'code 354 = no subscription error');
assertEq(bridge.classifyMdError(10167), 'delayed', 'code 10167 = delayed notice');
assertEq(bridge.classifyMdError(10168), 'delayed', 'code 10168 = delayed notice');
assertEq(bridge.classifyMdError(10169), 'delayed', 'code 10169 = delayed notice');
assertEq(bridge.classifyMdError(1100), 'other', 'unrelated code = other');

// ---- isPscOrder ----
assertTrue(bridge.isPscOrder('PSC-AMPL-1'), 'PSC- prefix matches');
assertTrue(!bridge.isPscOrder('manual-1'), 'manual refs excluded');
assertTrue(!bridge.isPscOrder(null), 'null ref excluded');

// ---- buildOrder field contract (mirrors original server) ----
const o = bridge.buildOrder({ action: 'BUY', quantity: 100, orderType: 'MKT', adaptive: true, adaptivePriority: 'Urgent' }, 42);
assertEq(o.orderId, 42, 'orderId assigned');
assertEq(o.action, 'BUY', 'action');
assertEq(o.totalQuantity, 100, 'qty');
assertEq(o.orderType, 'MKT', 'type');
assertEq(o.transmit, true, 'transmit default true');
assertEq(o.algoStrategy, 'Adaptive', 'adaptive algo attached');
assertEq(o.algoParams[0].value, 'Urgent', 'adaptivePriority passed through');

const stp = bridge.buildOrder({ action: 'SELL', quantity: 50, orderType: 'STP', auxPrice: 9.5, ocaGroup: 'G1', ocaType: 1, parentId: 41, orderRef: 'PSC-X', goodAfterTime: '20260911 15:45:00', adaptive: false }, 43);
assertEq(stp.auxPrice, 9.5, 'auxPrice');
assertEq(stp.ocaGroup, 'G1', 'ocaGroup');
assertEq(stp.parentId, 41, 'parentId');
assertEq(stp.goodAfterTime, '20260911 15:45:00', 'goodAfterTime');
assertTrue(stp.algoStrategy === undefined, 'adaptive:false -> no algo');

const adj = bridge.buildOrder({ action: 'SELL', quantity: 10, orderType: 'STP', auxPrice: 9, adjustedOrderType: 'TRAIL', triggerPrice: 9.5, adjustedStopPrice: 8.9 }, 44);
assertEq(adj.adjustedOrderType, 'TRAIL', 'adjustedOrderType');
assertEq(adj.adjustedStopPrice, 8.9, 'adjustedStopPrice');

// ---- shapes ----
const q = bridge.shapeQuote({ last: 10, high: 11, low: 9, close: 9.5, bid: 9.9, ask: 10.1 }, true, 1700000000000);
assertEq(q.c, 10, 'quote c');
assertEq(q.delayed, true, 'quote delayed flag');
assertEq(q.pc, 9.5, 'quote pc = close');

const ex = bridge.shapeExecution({ symbol: 'AMPL' }, { execId: 'e1', orderId: 7, orderRef: 'PSC-1', side: 'BOT', shares: 100, price: 15, time: 'now' }, 1.25);
assertEq(ex.execId, 'e1', 'exec id');
assertEq(ex.commission, 1.25, 'exec commission attached');

const oo = bridge.shapeOpenOrder(7, { symbol: 'AMPL' }, { action: 'SELL', totalQuantity: 50, orderType: 'STP', orderRef: 'PSC-1', parentId: 6 }, { status: 'Submitted' });
assertEq(oo.orderRef, 'PSC-1', 'open order ref kept for PSC filtering');
assertEq(oo.parentId, 6, 'parentId kept');

// ---- dedupe ----
assertEq(bridge.checkDedupe('PSC-t1'), null, 'dedupe miss');
bridge.recordDedupe('PSC-t1', { ok: true });
assertEq(bridge.checkDedupe('PSC-t1').ok, true, 'dedupe hit within TTL');

// ---- CORS origin ----
assertTrue(bridge.isAllowedOrigin('https://levifasten.github.io'), 'github pages allowed');
assertTrue(bridge.isAllowedOrigin('http://localhost:8080'), 'localhost allowed');
assertTrue(bridge.isAllowedOrigin('http://127.0.0.1:5500'), 'any 127.0.0.1 port allowed');
assertTrue(bridge.isAllowedOrigin('null'), 'null origin (file://) allowed');
assertTrue(!bridge.isAllowedOrigin('https://evil.example.com'), 'foreign origin rejected');

console.log('\nAll bridge tests passed');
process.exit(0);
