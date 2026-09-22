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
assertTrue(adj.algoStrategy === undefined, 'no adaptive field -> algo opt-in (not attached by default)');

const noAlgo = bridge.buildOrder({ action: 'SELL', quantity: 10, orderType: 'MOC' }, 45);
assertTrue(noAlgo.algoStrategy === undefined, 'MOC without adaptive:true -> no algo attached');
const lower = bridge.buildOrder({ action: 'BUY', quantity: 10, orderType: 'mkt', tif: 'day' }, 46);
assertEq(lower.orderType, 'MKT', 'orderType normalized to uppercase');
assertEq(lower.tif, 'DAY', 'tif normalized to uppercase');

// ---- validateOrderSpec hardening ----
assertEq(bridge.validateOrderSpec({ symbol: 'AAPL', action: 'BUY', quantity: 10.5 }), 'invalid quantity', 'fractional qty rejected');
assertEq(bridge.validateOrderSpec({ symbol: 'AAPL', action: 'BUY', quantity: 100 }), null, 'integer qty ok');
assertEq(bridge.validateOrderSpec({ symbol: 'AAPL', action: 'BUY', quantity: 10, ocaType: 9 }), 'invalid ocaType', 'ocaType out of range rejected');
assertEq(bridge.validateOrderSpec({ symbol: 'AAPL', action: 'BUY', quantity: 10, ocaType: 2 }), null, 'ocaType 2 ok');
assertEq(bridge.validateOrderSpec({ symbol: 'AAPL', action: 'BUY', quantity: 10, orderType: 'mkt' }), null, 'lowercase orderType validates (buildOrder uppercases)');

// ---- orderAckOk: terminal-dead statuses must not report ok ----
// Regression: a leg whose fastest callback was orderStatus('Cancelled') resolved
// {status:'Cancelled'} which passed the old ok-check -> batch counted it sent
// while nothing rested in TWS.
assertTrue(bridge.orderAckOk({ status: 'Submitted' }), 'Submitted ok');
assertTrue(bridge.orderAckOk({ status: 'PreSubmitted' }), 'PreSubmitted ok');
assertTrue(bridge.orderAckOk({ status: 'Filled' }), 'Filled ok');
assertTrue(!bridge.orderAckOk({ status: 'Cancelled' }), 'Cancelled NOT ok — order is dead');
assertTrue(!bridge.orderAckOk({ status: 'ApiCancelled' }), 'ApiCancelled NOT ok');
assertTrue(!bridge.orderAckOk({ status: 'Rejected' }), 'Rejected NOT ok');
assertTrue(!bridge.orderAckOk({ status: 'Timeout', unknown: true }), 'unknown NOT ok');
assertTrue(!bridge.orderAckOk({ status: 'Inactive', unknown: true }), 'Inactive+unknown NOT ok');
assertTrue(!bridge.orderAckOk(null), 'null NOT ok');

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
assertEq(oo.outsideRth, false, 'missing outsideRth -> false');
const ooExt = bridge.shapeOpenOrder(8, { symbol: 'QLD' }, { action: 'BUY', totalQuantity: 10, orderType: 'LMT', lmtPrice: 82, outsideRth: true }, { status: 'PreSubmitted' });
assertEq(ooExt.outsideRth, true, 'outsideRth flag surfaced');

// ---- dedupe ----
assertEq(bridge.checkDedupe('PSC-t1'), null, 'dedupe miss');
bridge.recordDedupe('PSC-t1', { ok: true }, 'sig1');
assertEq(bridge.checkDedupe('PSC-t1').result.ok, true, 'dedupe hit within TTL');
assertEq(bridge.checkDedupe('PSC-t1').sig, 'sig1', 'dedupe hit keeps request signature');

// ---- CORS origin ----
assertTrue(bridge.isAllowedOrigin('https://levifasten.github.io'), 'github pages allowed');
assertTrue(bridge.isAllowedOrigin('http://localhost:8080'), 'localhost allowed');
assertTrue(bridge.isAllowedOrigin('http://127.0.0.1:5500'), 'any 127.0.0.1 port allowed');
assertTrue(bridge.isAllowedOrigin('null'), 'null origin (file://) allowed');
assertTrue(!bridge.isAllowedOrigin('https://evil.example.com'), 'foreign origin rejected');

// ---- pruneToSeen (snapshot reconciliation) ----
const cache = new Map([[1, 'a'], [2, 'b'], [3, 'c']]);
bridge.pruneToSeen(cache, new Set([2, 3]));
assertEq(cache.size, 2, 'pruneToSeen drops unseen');
assertTrue(!cache.has(1) && cache.has(2), 'pruneToSeen keeps seen');
bridge.pruneToSeen(cache, new Set());
assertEq(cache.size, 0, 'pruneToSeen empty snapshot clears all');

// ---- static file helpers ----
assertTrue(bridge.isAllowedStaticFile('index.html'), 'index.html is a static file');
assertTrue(!bridge.isAllowedStaticFile('server.js'), 'server.js is not served');
assertTrue(bridge.resolveWebFile(__dirname, '/index.html') !== null, 'index.html resolves in repo root');
assertTrue(bridge.resolveWebFile(__dirname, '/') !== null, '/ maps to index.html');
assertEq(bridge.resolveWebFile(__dirname, '/orders'), null, 'API path not a static file');
assertEq(bridge.resolveWebFile(__dirname, '/../secret'), null, 'non-whitelisted path rejected');

// ---- flex module surface (re-exported for tests) ----
assertTrue(typeof bridge.flexRequest === 'function', 'flexRequest exported');
assertTrue(typeof bridge.flexTradesFromCsv === 'function', 'flexTradesFromCsv exported');
const fcsv = '"Trades","Header","Symbol","Date/Time","Quantity","Trade Price","Buy/Sell","IB Commission","IB Exec ID"\n' +
    '"Trades","Data","AAPL","20260904;093001","100","150.25","BUY","-1.05","0000e1a7.x.01.01"';
const ftr = bridge.flexTradesFromCsv(fcsv);
assertEq(ftr.trades.length, 1, 'csv -> one trade');
assertEq(ftr.trades[0].side, 'BOT', 'BUY maps BOT');
assertEq(ftr.trades[0].time, '20260904  09:30:01', 'TWS-layout time for twsExecKey');

// ---- integration: real server on a random port, no TWS ----
const http = require('http');
function req(pathname, { method = 'GET', headers = {}, body } = {}, base) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + pathname, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
(async () => {
  const { port } = await bridge.start({ port: 0, connectTws: false });
  assertTrue(port > 0, 'start() resolves a real port');
  const base = `http://127.0.0.1:${port}`;

  const page = await req('/', {}, base);
  assertEq(page.status, 200, 'GET / serves index.html');
  assertTrue(page.text.includes('name="psc-bridge"'), 'served page carries injected bridge token meta');

  const health = await req('/health', { headers: { Origin: base } }, base);
  const healthJson = JSON.parse(health.text);
  assertTrue(healthJson.twsPort !== undefined, 'GET /health responds with status json');
  assertTrue(healthJson.liveTradingPort !== undefined, 'GET /health exposes liveTradingPort flag');
  assertTrue(healthJson.account === undefined && healthJson.netLiq === undefined && healthJson.dailyPnL === undefined && healthJson.nextOrderId === undefined,
    'unauthed /health hides account/PnL/order-id fields');

  const denied = await req('/orders', { headers: { Origin: base } }, base);
  assertEq(denied.status, 401, 'authed GET requires token');

  // /flex/report: token-authed, NOT gated on TWS connectivity (pure IBKR HTTPS)
  const flexDenied = await req('/flex/report?q=1', { headers: { Origin: base } }, base);
  assertEq(flexDenied.status, 401, 'flex report requires bridge token');
  const token = (page.text.match(/name="psc-bridge" content="([^"]+)"/) || [])[1];
  assertTrue(!!token, 'bridge token extracted from served meta');
  const flexBadReq = await req('/flex/report?q=1', { headers: { Origin: base, 'X-Bridge-Token': token } }, base);
  assertEq(flexBadReq.status, 400, 'flex report without X-Flex-Token -> 400 (not 503 — TWS not required)');

  const healthAuthed = await req('/health', { headers: { Origin: base, 'X-Bridge-Token': token } }, base);
  const healthAuthedJson = JSON.parse(healthAuthed.text);
  assertTrue(healthAuthedJson.account !== undefined && healthAuthedJson.nextOrderId !== undefined,
    'authed /health exposes account fields');

  const deniedPost = await req('/order', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' }, base);
  assertEq(deniedPost.status, 401, 'unauthed POST rejected');

  const badOrigin = await req('/health', { headers: { Origin: 'https://evil.example.com' } }, base);
  assertEq(badOrigin.status, 403, 'foreign origin rejected');

  await bridge.stop();
  console.log('\nAll bridge tests passed');
  // No process.exit — stop() clears all handles; the process exits on its own.
})().catch(e => { console.error('FAIL integration:', e); process.exit(1); });
