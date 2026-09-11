// TWS Bridge — local HTTP server that translates browser requests into TWS API calls.
// Requires: node >= 18, @stoqey/ib + ws (installed via `npm install`).
// Requires TWS running with API enabled (see README.md for the TWS checklist).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { IBApi, EventName } = require('@stoqey/ib');

let WebSocketServer = null;
try {
    ({ WebSocketServer } = require('ws'));
} catch (_) {
    console.warn('[bridge] ws package not installed — /stream disabled. Run: npm install');
}

// ---------- Config ----------
const TWS_HOST = process.env.TWS_HOST || '127.0.0.1';
const TWS_PORT = parseInt(process.env.TWS_PORT || '7496', 10);
const CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || '7', 10);
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '8787', 10);
const TOKEN_FILE = path.join(__dirname, '.bridge-token');
const ALLOWED_ORIGINS = new Set([
    'https://levifasten.github.io',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost',
    'http://127.0.0.1',
    'null',                    // file:// pages and opaque origins
]);
// Allow any localhost port (dev servers) — checked by pattern, not exact match.
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function isAllowedOrigin(origin) {
    return ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin);
}

// ---------- Bridge token ----------
function loadOrCreateToken() {
    if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN;
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
            if (t) return t;
        }
    } catch (_) {}
    const token = crypto.randomBytes(24).toString('hex');
    try { fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 }); } catch (_) {}
    return token;
}
const BRIDGE_TOKEN = loadOrCreateToken();

// ---------- Market-data tick maps ----------
const TICK_PRICE_MAP = { 1: 'bid', 2: 'ask', 4: 'last', 6: 'high', 7: 'low', 9: 'close' };
const TICK_PRICE_DELAYED = { 66: 'bid', 67: 'ask', 68: 'last', 72: 'high', 73: 'low', 75: 'close' };
// TWS notices that only mean "you're seeing delayed data" — not failures.
const DELAYED_NOTICE_CODES = new Set([10167, 10168, 10169]);
// Codes meaning this symbol can't get data at all.
const SYMBOL_ERROR_CODES = new Set([200, 354]);

function classifyMdError(code) {
    if (DELAYED_NOTICE_CODES.has(code)) return 'delayed';
    if (SYMBOL_ERROR_CODES.has(code)) return 'error';
    return 'other';
}

function isPscOrder(orderRef) {
    return typeof orderRef === 'string' && orderRef.startsWith('PSC-');
}

function shapeOpenOrder(orderId, contract, order, orderState) {
    return {
        orderId,
        permId: order && order.permId,
        symbol: contract && contract.symbol,
        action: order && order.action,
        qty: order && order.totalQuantity,
        type: order && order.orderType,
        lmtPrice: order && order.lmtPrice,
        auxPrice: order && order.auxPrice,
        status: orderState && orderState.status,
        orderRef: order && order.orderRef,
        parentId: order && order.parentId,
        ocaGroup: order && order.ocaGroup,
    };
}

function shapeExecution(contract, exec, commission, realizedPnl) {
    return {
        execId: exec.execId,
        orderId: exec.orderId,
        orderRef: exec.orderRef,
        symbol: contract && contract.symbol,
        side: exec.side,
        shares: exec.shares,
        price: exec.price,
        time: exec.time,
        commission,
        realizedPnl,
    };
}

function shapeQuote(quote, delayed, lastTradeTs) {
    return {
        ok: true,
        c: quote.last != null ? quote.last : quote.close,
        h: quote.high,
        l: quote.low,
        pc: quote.close,
        bid: quote.bid,
        ask: quote.ask,
        delayed: !!delayed,
        t: lastTradeTs || Date.now(),
    };
}

// ---------- TWS state ----------
let ib = null;
let connected = false;
let account = '';
let nextOrderId = 0;
let nextReqId = 1000;                  // data-request ids — separate space from order ids
let lastError = '';
let clientIdConflict = false;
let reconnectTimer = null;

const pending = new Map();             // orderId -> {resolve, reject, timer, order}
const pendingCancel = new Map();       // orderId -> {resolve, reject, timer}
const refDedupe = new Map();           // orderRef -> {result, ts}
const REF_TTL = 60_000;

// data-request bookkeeping
const reqIdToSymbol = new Map();       // md/snapshot reqId -> symbol
const pendingSnapshot = new Map();     // reqId -> {resolve, timer, quote, delayed, lastTradeTs}
const pendingContract = new Map();     // reqId -> {resolve, timer, detail}
const pendingHistory = new Map();      // reqId -> {resolve, timer, bars}
const pendingExec = new Map();         // reqId -> {resolve, timer, execs, commissions}

// cached data
const mktSubs = new Map();             // symbol -> {reqId, refCount, quote, delayed, lastTradeTs}
const openOrdersCache = new Map();     // orderId -> shaped order (incl. manual TWS orders)
const execsCache = new Map();          // execId -> shaped execution
const positionsCache = new Map();      // `${account}:${conId}` -> {symbol, qty, avgCost, mktPrice, mktValue, unrealizedPNL}
const accountValues = {};              // tag -> value (BASE preferred, then USD)
const accountCurrency = {};            // tag -> currency currently stored
let accountAsOf = 0;
const pnlCache = { dailyPnL: undefined, unrealizedPnL: undefined, realizedPnL: undefined };
let pnlReqId = null;
let execPollTimer = null;

// ---------- WS /stream clients ----------
const streamClients = new Set();
let wss = null;

function streamSend(ws, obj) {
    if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }
}
function streamBroadcast(obj) {
    for (const ws of streamClients) streamSend(ws, obj);
}

// ---------- Market-data subscriptions (refcounted per symbol) ----------
function pushTick(symbol) {
    const sub = mktSubs.get(symbol);
    if (!sub) return;
    const q = sub.quote;
    streamBroadcast({
        type: 'tick', s: symbol,
        c: q.last, bid: q.bid, ask: q.ask, h: q.high, l: q.low,
        t: sub.lastTradeTs || Date.now(), delayed: !!sub.delayed,
    });
}

function subscribeMktData(symbol) {
    let sub = mktSubs.get(symbol);
    if (sub) { sub.refCount++; return; }
    sub = { reqId: null, refCount: 1, quote: {}, delayed: false, lastTradeTs: 0 };
    mktSubs.set(symbol, sub);
    issueMktSub(symbol);
}

function issueMktSub(symbol) {
    const sub = mktSubs.get(symbol);
    if (!sub || !connected || !ib) return;
    if (sub.reqId != null) reqIdToSymbol.delete(sub.reqId);
    const reqId = nextReqId++;
    sub.reqId = reqId;
    reqIdToSymbol.set(reqId, symbol);
    try { ib.reqMktData(reqId, buildContract(symbol), '', false, false); }
    catch (e) { console.error('[bridge] reqMktData failed', symbol, e.message); }
}

function unsubscribeMktData(symbol) {
    const sub = mktSubs.get(symbol);
    if (!sub) return;
    if (--sub.refCount > 0) return;
    mktSubs.delete(symbol);
    if (sub.reqId != null) {
        reqIdToSymbol.delete(sub.reqId);
        try { if (connected && ib) ib.cancelMktData(sub.reqId); } catch (_) {}
    }
}

function killMktSub(symbol) {          // all refs at once (fatal symbol error)
    const sub = mktSubs.get(symbol);
    if (!sub) return;
    mktSubs.delete(symbol);
    if (sub.reqId != null) {
        reqIdToSymbol.delete(sub.reqId);
        try { if (connected && ib) ib.cancelMktData(sub.reqId); } catch (_) {}
    }
}

function startAccountFeeds() {
    if (!connected || !ib || !account) return;
    try { ib.reqAccountUpdates(true, account); } catch (e) { console.error('[bridge] reqAccountUpdates', e.message); }
    try { ib.reqAutoOpenOrders(true); } catch (e) { console.error('[bridge] reqAutoOpenOrders', e.message); }
    try {
        if (pnlReqId != null) { try { ib.cancelPnL(pnlReqId); } catch (_) {} }
        pnlReqId = nextReqId++;
        ib.reqPnL(pnlReqId, account, '');
    } catch (e) { console.error('[bridge] reqPnL', e.message); }
    if (!execPollTimer) {
        execPollTimer = setInterval(() => {
            try { if (connected && ib) ib.reqExecutions(nextReqId++, {}); } catch (_) {}
        }, 60000);
    }
}

// ---------- TWS connection ----------
function connect() {
    if (ib) { try { ib.disconnect(); } catch (_) {} }
    clientIdConflict = false;
    lastError = '';

    ib = new IBApi({ host: TWS_HOST, port: TWS_PORT, clientId: CLIENT_ID });

    ib.on(EventName.connected, () => {
        connected = true;
        console.log(`[bridge] Connected to TWS on ${TWS_HOST}:${TWS_PORT} (clientId=${CLIENT_ID})`);
        ib.reqIds();
        try { ib.reqMarketDataType(1); } catch (_) {}     // ask for real-time; TWS downgrades to delayed if unentitled
        try { ib.reqPositions(); } catch (_) {}
        try { ib.reqAllOpenOrders(); } catch (_) {}
        // Re-issue market-data subscriptions — they died with the socket.
        for (const symbol of mktSubs.keys()) issueMktSub(symbol);
        streamBroadcast({ type: 'status', connected: true });
    });

    ib.on(EventName.nextValidId, (id) => {
        nextOrderId = id;
        console.log(`[bridge] nextValidId = ${id}`);
    });

    ib.on(EventName.managedAccounts, (list) => {
        account = String(list).split(',')[0] || '';
        console.log(`[bridge] account = ${account}`);
        startAccountFeeds();
    });

    ib.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice) => {
        const cached = openOrdersCache.get(orderId);
        if (cached) cached.status = status;
        if (status === 'Filled' || status === 'Cancelled' || status === 'Inactive') openOrdersCache.delete(orderId);
        streamBroadcast({ type: 'order', orderId, status, filled, remaining, avgFillPrice });

        const pc = pendingCancel.get(orderId);
        if (pc && status === 'Cancelled') {
            clearTimeout(pc.timer); pendingCancel.delete(orderId);
            pc.resolve({ orderId, status });
        }

        const p = pending.get(orderId);
        if (p && (status === 'Filled' || status === 'Cancelled' || status === 'Inactive')) {
            clearTimeout(p.timer);
            pending.delete(orderId);
            p.resolve({ orderId, status, filled, remaining, avgFillPrice });
        } else if (p && (status === 'PreSubmitted' || status === 'Submitted' || status === 'PendingSubmit')) {
            // Resolve on first non-terminal status so the caller knows it was accepted.
            clearTimeout(p.timer);
            pending.delete(orderId);
            p.resolve({ orderId, status, filled, remaining });
        }
    });

    ib.on(EventName.openOrder, (orderId, contract, order, orderState) => {
        // Cache BEFORE the pending early-return so manual TWS orders are tracked too.
        const shaped = shapeOpenOrder(orderId, contract, order, orderState);
        openOrdersCache.set(orderId, shaped);

        const p = pending.get(orderId);
        if (!p) return;
        const status = orderState && orderState.status;
        // openOrder is the earliest acknowledgement that TWS has the order.
        // For non-transmitted (pre-staged) orders it may or may not fire; if it does, we can continue immediately.
        const isRejected = status === 'Rejected' || status === 'Cancelled';
        clearTimeout(p.timer);
        pending.delete(orderId);
        if (isRejected) {
            p.resolve({ orderId, status: 'Rejected', message: orderState && orderState.warningText ? String(orderState.warningText) : status });
        } else {
            p.resolve({ orderId, status: status || 'PreSubmitted', filled: 0, remaining: (p.order && p.order.totalQuantity) || 0 });
        }
    });

    ib.on(EventName.error, (err, code, reqId) => {
        const msg = err && err.message ? err.message : String(err);
        // Market-data errors route by reqId -> symbol BEFORE touching order state.
        if (reqIdToSymbol.has(reqId)) {
            const symbol = reqIdToSymbol.get(reqId);
            const cls = classifyMdError(code);
            if (cls === 'delayed') {
                const sub = mktSubs.get(symbol);
                if (sub) sub.delayed = true;
                const snap = pendingSnapshot.get(reqId);
                if (snap) snap.delayed = true;
                streamBroadcast({ type: 'tick_delayed', s: symbol });
            } else if (cls === 'error') {
                streamBroadcast({ type: 'error', s: symbol, error: `TWS error ${code}: ${msg}` });
                killMktSub(symbol);
            }
            return; // 'other' md errors: ignore
        }
        // Data-request errors — resolve the matching pending request fast instead of
        // letting it hit its own timeout (e.g. code 162 history-farm violations).
        if (reqId > 0) {
            const snap = pendingSnapshot.get(reqId);
            if (snap) {
                pendingSnapshot.delete(reqId); reqIdToSymbol.delete(reqId); clearTimeout(snap.timer);
                snap.resolve(snap.quote.last != null ? shapeQuote(snap.quote, snap.delayed, snap.lastTradeTs) : { ok: false, error: `TWS error ${code}: ${msg}` });
                return;
            }
            const pc2 = pendingContract.get(reqId);
            if (pc2) {
                pendingContract.delete(reqId); clearTimeout(pc2.timer);
                pc2.resolve({ ok: false, contractMissing: code === 200, error: `TWS error ${code}: ${msg}` });
                return;
            }
            const ph = pendingHistory.get(reqId);
            if (ph) {
                pendingHistory.delete(reqId); clearTimeout(ph.timer);
                ph.resolve(ph.bars.length ? ph.bars : null);
                return;
            }
            const pe = pendingExec.get(reqId);
            if (pe) {
                pendingExec.delete(reqId); clearTimeout(pe.timer);
                pe.resolve(pe.execs.map(({ contract, exec }) => {
                    const c = pe.commissions.get(exec.execId);
                    return shapeExecution(contract, exec, c && c.commission, c && c.realizedPNL);
                }));
                return;
            }
        }
        if (/already.*connect|clientId.*use|already connected/i.test(msg)) {
            clientIdConflict = true;
            lastError = `clientId ${CLIENT_ID} already in use — set IBKR_CLIENT_ID to a different number`;
            console.error(`[bridge] ${lastError}`);
        }
        // Only fail a pending order if the error's reqId matches it.
        if (reqId > 0 && pending.has(reqId)) {
            const p = pending.get(reqId);
            clearTimeout(p.timer);
            pending.delete(reqId);
            p.resolve({ orderId: reqId, status: 'Rejected', message: msg, code });
        }
        const pc = pendingCancel.get(reqId);
        if (pc) {
            clearTimeout(pc.timer); pendingCancel.delete(reqId);
            pc.resolve({ orderId: reqId, status: 'CancelRejected', message: msg, code });
        }
        if (reqId <= 0) console.warn(`[bridge] info code=${code} reqId=${reqId}: ${msg}`);
    });

    // ---- market data ----
    ib.on(EventName.tickPrice, (reqId, tickType, price) => {
        const symbol = reqIdToSymbol.get(reqId);
        if (!symbol) return;
        if (typeof price !== 'number' || price < 0) return; // -1 = "no value"
        const field = TICK_PRICE_MAP[tickType] || TICK_PRICE_DELAYED[tickType];
        if (!field) return;
        if (TICK_PRICE_DELAYED[tickType]) {
            const sub = mktSubs.get(symbol);
            if (sub) sub.delayed = true;
            const snap = pendingSnapshot.get(reqId);
            if (snap) snap.delayed = true;
        }
        const sub = mktSubs.get(symbol);
        if (sub) { sub.quote[field] = price; pushTick(symbol); }
        const snap = pendingSnapshot.get(reqId);
        if (snap) snap.quote[field] = price;
    });

    ib.on(EventName.tickString, (reqId, tickType, value) => {
        if (tickType !== 45) return; // last-trade timestamp, epoch seconds
        const ts = Math.round(parseFloat(value) * 1000);
        if (!Number.isFinite(ts)) return;
        const symbol = reqIdToSymbol.get(reqId);
        const sub = symbol && mktSubs.get(symbol);
        if (sub) sub.lastTradeTs = ts;
        const snap = pendingSnapshot.get(reqId);
        if (snap) snap.lastTradeTs = ts;
    });

    ib.on(EventName.marketDataType, (reqId, marketDataType) => {
        const delayed = marketDataType === 3 || marketDataType === 4;
        const symbol = reqIdToSymbol.get(reqId);
        const sub = symbol && mktSubs.get(symbol);
        if (sub) sub.delayed = delayed;
        const snap = pendingSnapshot.get(reqId);
        if (snap) snap.delayed = delayed;
    });

    ib.on(EventName.tickSnapshotEnd, (reqId) => {
        const snap = pendingSnapshot.get(reqId);
        if (!snap) return;
        pendingSnapshot.delete(reqId);
        clearTimeout(snap.timer);
        reqIdToSymbol.delete(reqId);
        snap.resolve(shapeQuote(snap.quote, snap.delayed, snap.lastTradeTs));
    });

    // ---- account / positions / pnl ----
    ib.on(EventName.updateAccountValue, (value, key, currency) => {
        const cur = currency || 'BASE';
        const prevCur = accountCurrency[key];
        if (cur === 'BASE' || prevCur === undefined || (prevCur !== 'BASE' && cur === 'USD')) {
            accountValues[key] = value;
            accountCurrency[key] = cur;
        }
        accountAsOf = Date.now();
        streamBroadcast({ type: 'account', key, value, currency: cur });
    });

    ib.on(EventName.updatePortfolio, (contract, position, marketPrice, marketValue, averageCost, unrealizedPNL, realizedPNL, accountName) => {
        const k = `${accountName}:${contract.conId}`;
        positionsCache.set(k, {
            symbol: contract.symbol, qty: position, avgCost: averageCost,
            mktPrice: marketPrice, mktValue: marketValue, unrealizedPNL, realizedPNL,
        });
        streamBroadcast({ type: 'position', symbol: contract.symbol, qty: position, avgCost: averageCost, mktPrice: marketPrice });
    });

    ib.on(EventName.position, (acct, contract, pos, avgCost) => {
        const k = `${acct}:${contract.conId}`;
        const prev = positionsCache.get(k) || {};
        positionsCache.set(k, { ...prev, symbol: contract.symbol, qty: pos, avgCost });
    });

    ib.on(EventName.pnl, (reqId, dailyPnL, unrealizedPnL, realizedPnL) => {
        pnlCache.dailyPnL = dailyPnL; pnlCache.unrealizedPnL = unrealizedPnL; pnlCache.realizedPnL = realizedPnL;
        streamBroadcast({ type: 'pnl', ...pnlCache });
    });

    // ---- executions ----
    ib.on(EventName.execDetails, (reqId, contract, exec) => {
        const pe = pendingExec.get(reqId);
        if (pe) pe.execs.push({ contract, exec });
        const shaped = shapeExecution(contract, exec);
        execsCache.set(exec.execId, shaped);
        if (execsCache.size > 500) {
            // Drop the oldest entries — execIds are unique so FIFO eviction is safe.
            for (const k of execsCache.keys()) { execsCache.delete(k); if (execsCache.size <= 400) break; }
        }
        streamBroadcast({ type: 'exec', ...shaped });
    });
    ib.on(EventName.commissionReport, (report) => {
        for (const pe of pendingExec.values()) pe.commissions.set(report.execId, report);
        const ex = execsCache.get(report.execId);
        if (ex) { ex.commission = report.commission; ex.realizedPnl = report.realizedPNL; }
    });
    ib.on(EventName.execDetailsEnd, (reqId) => {
        const pe = pendingExec.get(reqId);
        if (!pe) return;
        pendingExec.delete(reqId); clearTimeout(pe.timer);
        pe.resolve(pe.execs.map(({ contract, exec }) => {
            const c = pe.commissions.get(exec.execId);
            return shapeExecution(contract, exec, c && c.commission, c && c.realizedPNL);
        }));
    });

    // ---- contract details / history ----
    ib.on(EventName.contractDetails, (reqId, detail) => {
        const p = pendingContract.get(reqId);
        if (p && !p.detail) p.detail = detail;
    });
    ib.on(EventName.contractDetailsEnd, (reqId) => {
        const p = pendingContract.get(reqId);
        if (!p) return;
        pendingContract.delete(reqId); clearTimeout(p.timer);
        const d = p.detail;
        p.resolve(d && d.contract
            ? { ok: true, conId: d.contract.conId, longName: d.longName, symbol: d.contract.symbol }
            : { ok: false, contractMissing: true, error: 'symbol not found' });
    });

    ib.on(EventName.historicalData, (reqId, time, open, high, low, close, volume) => {
        const p = pendingHistory.get(reqId);
        if (!p) return;
        if (high === -1 || String(time).startsWith('finished')) {   // end-of-dataset marker
            pendingHistory.delete(reqId); clearTimeout(p.timer);
            p.resolve(p.bars);
        } else {
            p.bars.push({ h: high, l: low, c: close, v: Number(volume) });
        }
    });

    ib.on(EventName.disconnected, () => {
        if (connected) console.warn('[bridge] Disconnected from TWS');
        connected = false;
        streamBroadcast({ type: 'status', connected: false });
        scheduleReconnect();
    });

    ib.on(EventName.connectionClosed, () => {
        if (connected) console.warn('[bridge] Connection closed');
        connected = false;
        streamBroadcast({ type: 'status', connected: false });
        scheduleReconnect();
    });

    try { ib.connect(); } catch (e) {
        lastError = e.message || String(e);
        connected = false;
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, 5000);
}

// ---------- Symbol normalization ----------
function toIbkSymbol(raw) {
    const upper = String(raw || '').trim().toUpperCase();
    if (/^[A-Z]{1,5}[.\-][A-Z]{1,2}$/.test(upper)) {
        return upper.replace(/[.\-]/, ' ');
    }
    return upper;
}

// ---------- Order building ----------
function buildContract(symbol) {
    return {
        symbol: toIbkSymbol(symbol),
        secType: 'STK',
        exchange: 'SMART',
        currency: 'USD',
    };
}

function buildOrder(spec, id) {
    const order = {
        orderId: id,
        action: spec.action === 'BUY' ? 'BUY' : 'SELL',
        orderType: spec.orderType || 'MKT',
        totalQuantity: spec.quantity,
        tif: spec.tif || 'DAY',
        outsideRth: spec.outsideRth === true,
        transmit: spec.transmit !== false,
    };
    if (spec.lmtPrice != null) order.lmtPrice = Number(spec.lmtPrice);
    if (spec.auxPrice != null) order.auxPrice = Number(spec.auxPrice);
    if (spec.ocaGroup) order.ocaGroup = spec.ocaGroup;
    if (spec.ocaType != null) order.ocaType = spec.ocaType;
    if (spec.parentId != null) order.parentId = spec.parentId;
    if (spec.orderRef) order.orderRef = spec.orderRef;
    if (spec.goodAfterTime) order.goodAfterTime = spec.goodAfterTime;
    if (spec.adjustedOrderType) order.adjustedOrderType = spec.adjustedOrderType;
    if (spec.triggerPrice != null) order.triggerPrice = Number(spec.triggerPrice);
    if (spec.adjustedStopPrice != null) order.adjustedStopPrice = Number(spec.adjustedStopPrice);
    if (spec.adaptive !== false) {
        order.algoStrategy = 'Adaptive';
        order.algoParams = [{ tag: 'adaptivePriority', value: spec.adaptivePriority || 'Normal' }];
    }
    return order;
}

// ---------- Place order ----------
function placeOrder(spec) {
    return new Promise((resolve, reject) => {
        if (!connected) return reject(new Error('Not connected to TWS'));
        if (nextOrderId <= 0) return reject(new Error('No valid order id yet'));
        const orderId = nextOrderId++;
        const order = buildOrder(spec, orderId);
        const contract = buildContract(spec.symbol);
        const timer = setTimeout(() => {
            pending.delete(orderId);
            resolve({ orderId, status: 'Timeout', unknown: true, message: 'No confirmation from TWS — check TWS before retrying' });
        }, 5000);
        pending.set(orderId, { resolve, reject, timer, order });
        try {
            ib.placeOrder(orderId, contract, order);
            if (order.transmit === false) {
                // Pre-staged (non-transmitted) orders won't return an orderStatus until a transmitted order releases them.
                // Wait for an openOrder callback, or long enough for TWS to register the order, before the batch continues.
                setTimeout(() => {
                    if (pending.has(orderId)) {
                        clearTimeout(timer);
                        pending.delete(orderId);
                        resolve({ orderId, status: 'PreSubmitted' });
                    }
                }, 2500);
            }
        } catch (e) {
            clearTimeout(timer);
            pending.delete(orderId);
            reject(e);
        }
    });
}

// ---------- Cancel ----------
function cancelOrderById(orderId) {
    return new Promise((resolve) => {
        if (!connected || !ib) return resolve({ ok: false, orderId, error: 'Not connected to TWS' });
        const timer = setTimeout(() => {
            pendingCancel.delete(orderId);
            resolve({ ok: false, orderId, error: 'Cancel timed out — check TWS' });
        }, 8000);
        pendingCancel.set(orderId, { resolve, timer });
        try { ib.cancelOrder(orderId); }
        catch (e) { pendingCancel.delete(orderId); clearTimeout(timer); resolve({ ok: false, orderId, error: e.message }); }
    });
}

// ---------- Data fetchers ----------
function fetchQuoteSnapshot(symbol) {
    return new Promise((resolve) => {
        if (!connected || !ib) return resolve({ ok: false, error: 'Not connected to TWS' });
        const reqId = nextReqId++;
        const timer = setTimeout(() => {
            const snap = pendingSnapshot.get(reqId);
            pendingSnapshot.delete(reqId); reqIdToSymbol.delete(reqId);
            if (snap && snap.quote.last != null) resolve(shapeQuote(snap.quote, snap.delayed, snap.lastTradeTs));
            else resolve({ ok: false, error: 'snapshot timeout' });
        }, 8000);
        pendingSnapshot.set(reqId, { resolve, timer, quote: {}, delayed: false, lastTradeTs: 0 });
        reqIdToSymbol.set(reqId, symbol);
        try { ib.reqMktData(reqId, buildContract(symbol), '', true, false); }
        catch (e) {
            pendingSnapshot.delete(reqId); reqIdToSymbol.delete(reqId); clearTimeout(timer);
            resolve({ ok: false, error: e.message });
        }
    });
}

const contractCache = new Map();       // symbol -> {ok, conId, longName}
function fetchContract(symbol) {
    return new Promise((resolve) => {
        const hit = contractCache.get(symbol);
        if (hit) return resolve(hit);
        if (!connected || !ib) return resolve({ ok: false, error: 'Not connected to TWS' });
        const reqId = nextReqId++;
        const timer = setTimeout(() => { pendingContract.delete(reqId); resolve({ ok: false, error: 'contract lookup timeout' }); }, 8000);
        pendingContract.set(reqId, { resolve: (r) => { contractCache.set(symbol, r); resolve(r); }, timer, detail: null });
        try { ib.reqContractDetails(reqId, buildContract(symbol)); }
        catch (e) { pendingContract.delete(reqId); clearTimeout(timer); resolve({ ok: false, error: e.message }); }
    });
}

function fetchHistory(symbol) {
    return new Promise((resolve) => {
        if (!connected || !ib) return resolve(null);
        const reqId = nextReqId++;
        const timer = setTimeout(() => { pendingHistory.delete(reqId); resolve(null); }, 12000);
        pendingHistory.set(reqId, { resolve, timer, bars: [] });
        try {
            ib.reqHistoricalData(reqId, buildContract(symbol), '', '1 M', '1 day', 'TRADES', 1, 1, false);
        } catch (e) { pendingHistory.delete(reqId); clearTimeout(timer); resolve(null); }
    });
}

function fetchExecutions() {
    return new Promise((resolve) => {
        if (!connected || !ib) return resolve(Array.from(execsCache.values()));
        const reqId = nextReqId++;
        const timer = setTimeout(() => { pendingExec.delete(reqId); resolve(Array.from(execsCache.values())); }, 8000);
        pendingExec.set(reqId, { resolve, timer, execs: [], commissions: new Map() });
        try { ib.reqExecutions(reqId, {}); }
        catch (e) { pendingExec.delete(reqId); clearTimeout(timer); resolve(Array.from(execsCache.values())); }
    });
}

// ---------- Dedupe ----------
function checkDedupe(orderRef) {
    if (!orderRef) return null;
    const now = Date.now();
    const hit = refDedupe.get(orderRef);
    if (hit && (now - hit.ts) < REF_TTL) return hit.result;
    return null;
}
function recordDedupe(orderRef, result) {
    if (!orderRef) return;
    refDedupe.set(orderRef, { result, ts: Date.now() });
    // Prune old entries.
    for (const [k, v] of refDedupe) {
        if (Date.now() - v.ts > REF_TTL) refDedupe.delete(k);
    }
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    const url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);

    // CORS headers shared by all responses.
    const corsOrigin = isAllowedOrigin(origin) ? origin : 'null';
    const corsHeaders = {
        'Access-Control-Allow-Origin': corsOrigin,
        'Content-Type': 'application/json',
    };

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            ...corsHeaders,
            'Access-Control-Allow-Private-Network': 'true',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token',
            'Access-Control-Max-Age': '86400',
        });
        return res.end();
    }

    const allowed = isAllowedOrigin(origin);
    if (!allowed) {
        console.warn(`[bridge] Origin not allowed: ${origin} (method=${req.method}, url=${req.url})`);
        res.writeHead(403, corsHeaders);
        return res.end(JSON.stringify({ ok: false, error: 'Origin not allowed: ' + origin }));
    }

    const token = req.headers['x-bridge-token'] || '';
    const authed = token === BRIDGE_TOKEN;

    // Enforce Content-Type + Origin + token on POSTs (CSRF).
    if (req.method === 'POST') {
        const ct = req.headers['content-type'] || '';
        if (!ct.includes('application/json')) {
            res.writeHead(415, corsHeaders);
            return res.end(JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
        }
        if (!authed) {
            res.writeHead(401, corsHeaders);
            return res.end(JSON.stringify({ ok: false, error: 'Invalid or missing bridge token' }));
        }
    }

    // GET /health — token-free status probe
    if (req.method === 'GET' && url.pathname === '/health') {
        const body = {
            ok: connected, connected, account, nextOrderId, twsPort: TWS_PORT,
            netLiq: accountValues['NetLiquidation'] != null ? Number(accountValues['NetLiquidation']) : null,
            dailyPnL: pnlCache.dailyPnL != null ? pnlCache.dailyPnL : null,
        };
        if (clientIdConflict) body.error = lastError;
        else if (lastError && !connected) body.error = lastError;
        res.writeHead(200, corsHeaders);
        return res.end(JSON.stringify(body));
    }

    // New data GETs expose account data → require the token.
    if (req.method === 'GET') {
        if (!authed) {
            res.writeHead(401, corsHeaders);
            return res.end(JSON.stringify({ ok: false, error: 'Invalid or missing bridge token' }));
        }
        if (!connected) {
            res.writeHead(503, corsHeaders);
            return res.end(JSON.stringify({ ok: false, error: 'Not connected to TWS' }));
        }

        if (url.pathname === '/quote') {
            const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
            if (!symbol) { res.writeHead(400, corsHeaders); return res.end(JSON.stringify({ ok: false, error: 'missing symbol' })); }
            const live = mktSubs.get(symbol);
            if (live && live.quote.last != null) {
                res.writeHead(200, corsHeaders);
                return res.end(JSON.stringify(shapeQuote(live.quote, live.delayed, live.lastTradeTs)));
            }
            const q = await fetchQuoteSnapshot(symbol);
            res.writeHead(q.ok ? 200 : 502, corsHeaders);
            return res.end(JSON.stringify(q));
        }

        if (url.pathname === '/account') {
            res.writeHead(200, corsHeaders);
            return res.end(JSON.stringify({ ok: true, account, values: { ...accountValues }, asOf: accountAsOf }));
        }

        if (url.pathname === '/positions') {
            try { ib.reqPositions(); } catch (_) {}
            res.writeHead(200, corsHeaders);
            return res.end(JSON.stringify({ ok: true, positions: Array.from(positionsCache.values()).filter(p => p.qty) }));
        }

        if (url.pathname === '/orders') {
            try { ib.reqAllOpenOrders(); } catch (_) {}
            res.writeHead(200, corsHeaders);
            return res.end(JSON.stringify({ ok: true, orders: Array.from(openOrdersCache.values()) }));
        }

        if (url.pathname === '/executions') {
            const execs = await fetchExecutions();
            res.writeHead(200, corsHeaders);
            return res.end(JSON.stringify({ ok: true, executions: execs }));
        }

        if (url.pathname === '/pnl') {
            res.writeHead(200, corsHeaders);
            return res.end(JSON.stringify({ ok: true, ...pnlCache }));
        }

        if (url.pathname === '/contract') {
            const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
            if (!symbol) { res.writeHead(400, corsHeaders); return res.end(JSON.stringify({ ok: false, error: 'missing symbol' })); }
            const r = await fetchContract(symbol);
            res.writeHead(r.ok ? 200 : 404, corsHeaders);
            return res.end(JSON.stringify(r));
        }

        if (url.pathname === '/history') {
            const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
            if (!symbol) { res.writeHead(400, corsHeaders); return res.end(JSON.stringify({ ok: false, error: 'missing symbol' })); }
            const bars = await fetchHistory(symbol);
            res.writeHead(bars && bars.length ? 200 : 502, corsHeaders);
            return res.end(JSON.stringify(bars && bars.length ? { ok: true, bars } : { ok: false, error: 'no history' }));
        }

        res.writeHead(404, corsHeaders);
        return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    }

    // POST /order — single order
    if (req.method === 'POST' && url.pathname === '/order') {
        const body = await readBody(req);
        if (!body) return sendJson(res, 400, { ok: false, error: 'Invalid JSON body' }, corsHeaders);
        const dup = checkDedupe(body.orderRef);
        if (dup) return sendJson(res, 200, { ...dup, deduped: true }, corsHeaders);
        try {
            const result = await placeOrder(body);
            const out = { ok: result.status !== 'Rejected', ...result };
            recordDedupe(body.orderRef, out);
            return sendJson(res, 200, out, corsHeaders);
        } catch (e) {
            const out = { ok: false, error: e.message || String(e) };
            recordDedupe(body.orderRef, out);
            return sendJson(res, 200, out, corsHeaders);
        }
    }

    // POST /orders — batch of independent orders
    if (req.method === 'POST' && url.pathname === '/orders') {
        const body = await readBody(req);
        if (!body || !Array.isArray(body.orders)) return sendJson(res, 400, { ok: false, error: 'Expected {orders:[]}' }, corsHeaders);
        const dup = checkDedupe(body.orderRef);
        if (dup) return sendJson(res, 200, { ...dup, deduped: true }, corsHeaders);
        const results = [];
        // Resolve parentRef → allocated orderId.
        const refToId = {};
        for (const spec of body.orders) {
            if (spec.ref) refToId[spec.ref] = null; // placeholder
        }
        for (let i = 0; i < body.orders.length; i++) {
            const spec = body.orders[i];
            const resolved = { ...spec };
            if (spec.parentRef && refToId[spec.parentRef] != null) resolved.parentId = refToId[spec.parentRef];
            try {
                const result = await placeOrder(resolved);
                if (spec.ref) refToId[spec.ref] = result.orderId;
                results.push({ ok: result.status !== 'Rejected', ...result });
            } catch (e) {
                results.push({ ok: false, error: e.message || String(e) });
            }
            // Small pause between OCA members so TWS can form the group before the next order arrives.
            if (i < body.orders.length - 1) await new Promise(r => setTimeout(r, 150));
        }
        const firstFail = results.find(r => !r.ok);
        const hasUnknown = results.some(r => r.unknown);
        const out = { ok: results.every(r => r.ok), results };
        if (!out.ok) {
            out.error = firstFail?.error || firstFail?.message || 'One or more orders rejected';
        }
        if (hasUnknown) out.unknown = true;
        recordDedupe(body.orderRef, out);
        return sendJson(res, 200, out, corsHeaders);
    }

    // POST /cancel — {orderId}
    if (req.method === 'POST' && url.pathname === '/cancel') {
        const body = await readBody(req);
        const orderId = body && Number(body.orderId);
        if (!Number.isFinite(orderId)) return sendJson(res, 400, { ok: false, error: 'missing orderId' }, corsHeaders);
        const r = await cancelOrderById(orderId);
        return sendJson(res, r.status === 'Cancelled' ? 200 : 502, r, corsHeaders);
    }

    // POST /cancel-all — {scope:'psc'|'all'} — PSC-scoped by default, never reqGlobalCancel.
    if (req.method === 'POST' && url.pathname === '/cancel-all') {
        const body = await readBody(req);
        const scopeAll = body && body.scope === 'all';
        const targets = Array.from(openOrdersCache.values())
            .filter(o => scopeAll || isPscOrder(o.orderRef))
            .map(o => o.orderId);
        const results = [];
        for (const oid of targets) {
            results.push(await cancelOrderById(oid));
            if (targets.length > 1) await new Promise(r => setTimeout(r, 120));
        }
        return sendJson(res, 200, {
            ok: results.every(r => r.status === 'Cancelled'),
            cancelled: targets.filter((t, i) => results[i].status === 'Cancelled').length,
            attempted: targets.length,
            results,
        }, corsHeaders);
    }

    // 404
    res.writeHead(404, corsHeaders);
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

function sendJson(res, code, obj, extraHeaders = {}) {
    res.writeHead(code, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (_) { resolve(null); }
        });
        req.on('error', () => resolve(null));
    });
}

// ---------- WS /stream ----------
if (WebSocketServer) {
    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket) => {
        let url;
        try { url = new URL(req.url, 'http://localhost'); } catch (_) { socket.destroy(); return; }
        if (url.pathname !== '/stream') { socket.destroy(); return; }
        const origin = req.headers.origin || '';
        if (origin && !isAllowedOrigin(origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
        wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => {
            ws._pscAuthed = false;
            ws._pscSubs = new Set();
            ws._pscAuthTimer = setTimeout(() => { if (!ws._pscAuthed) try { ws.close(4401, 'auth required'); } catch (_) {} }, 3000);
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });
            ws.on('message', (raw) => {
                let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
                if (!ws._pscAuthed) {
                    if (msg.type === 'auth' && msg.token === BRIDGE_TOKEN) {
                        ws._pscAuthed = true; clearTimeout(ws._pscAuthTimer);
                        streamClients.add(ws);
                        streamSend(ws, { type: 'hello', twsConnected: connected, account: account || null });
                    } else {
                        try { ws.close(4401, 'auth required'); } catch (_) {}
                    }
                    return;
                }
                if (msg.type === 'subscribe' && Array.isArray(msg.tickers)) {
                    for (const t of msg.tickers) {
                        const s = String(t).trim().toUpperCase();
                        if (!s) continue;
                        if (!ws._pscSubs.has(s)) { ws._pscSubs.add(s); subscribeMktData(s); }
                    }
                } else if (msg.type === 'unsubscribe' && Array.isArray(msg.tickers)) {
                    for (const t of msg.tickers) {
                        const s = String(t).trim().toUpperCase();
                        if (ws._pscSubs.delete(s)) unsubscribeMktData(s);
                    }
                }
            });
            ws.on('close', () => {
                streamClients.delete(ws);
                clearTimeout(ws._pscAuthTimer);
                for (const s of ws._pscSubs) unsubscribeMktData(s);
                ws._pscSubs.clear();
            });
            ws.on('error', () => { try { ws.terminate(); } catch (_) {} });
        });
    });
}

// ---------- Boot ----------
function main() {
    if (wss) {
        setInterval(() => {
            for (const ws of streamClients) {
                if (!ws.isAlive) { try { ws.terminate(); } catch (_) {} continue; }
                ws.isAlive = false; try { ws.ping(); } catch (_) {}
            }
        }, 15000);
    }
    server.listen(BRIDGE_PORT, '127.0.0.1', () => {
        console.log(`[bridge] HTTP listening on http://127.0.0.1:${BRIDGE_PORT}`);
        console.log(`[bridge] TWS target: ${TWS_HOST}:${TWS_PORT} (clientId=${CLIENT_ID})`);
        console.log(`[bridge] Token: ${BRIDGE_TOKEN}`);
        console.log(`[bridge] Paste this token into the app's Settings → TWS Bridge → Bridge token field.`);
    });
    connect();
}

if (require.main === module) main();

module.exports = {
    toIbkSymbol, buildOrder, buildContract, isAllowedOrigin, isPscOrder, classifyMdError,
    TICK_PRICE_MAP, TICK_PRICE_DELAYED, DELAYED_NOTICE_CODES, SYMBOL_ERROR_CODES,
    shapeOpenOrder, shapeExecution, shapeQuote, loadOrCreateToken, checkDedupe, recordDedupe,
};
