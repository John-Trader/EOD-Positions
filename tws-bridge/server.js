// TWS Bridge — local HTTP server that translates browser requests into TWS API calls.
// Requires: node >= 18, @stoqey/ib (installed via `npm install`).
// Requires TWS running with API enabled (see README.md for the TWS checklist).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { IBApi, EventName } = require('@stoqey/ib');

// ---------- Config ----------
const TWS_HOST = process.env.TWS_HOST || '127.0.0.1';
const TWS_PORT = parseInt(process.env.TWS_PORT || '7497', 10);
const CLIENT_ID = parseInt(process.env.IBKR_CLIENT_ID || '7', 10);
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '8787', 10);
const TOKEN_FILE = path.join(__dirname, '.bridge-token');
const ALLOWED_ORIGINS = new Set([
    'https://levifasten.github.io',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost',
    'http://127.0.0.1',
]);
// Allow any localhost port (dev servers) — checked by pattern, not exact match.
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

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

// ---------- TWS state ----------
let ib = null;
let connected = false;
let account = '';
let nextOrderId = 0;
let lastError = '';
let clientIdConflict = false;
let reconnectTimer = null;

const pending = new Map();   // orderId -> {resolve, reject, timer}
const refDedupe = new Map(); // orderRef -> {result, ts}
const REF_TTL = 60_000;

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
    });

    ib.on(EventName.nextValidId, (id) => {
        nextOrderId = id;
        console.log(`[bridge] nextValidId = ${id}`);
    });

    ib.on(EventName.managedAccounts, (list) => {
        account = String(list).split(',')[0] || '';
        console.log(`[bridge] account = ${account}`);
    });

    ib.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice) => {
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

    ib.on(EventName.error, (err, code, reqId) => {
        const msg = err && err.message ? err.message : String(err);
        // Client-id conflict: TWS error 502 (couldn't connect) or a specific "already connected" message.
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
        // Log non-order errors without failing anything.
        if (reqId <= 0) console.warn(`[bridge] info code=${code} reqId=${reqId}: ${msg}`);
    });

    ib.on(EventName.disconnected, () => {
        if (connected) console.warn('[bridge] Disconnected from TWS');
        connected = false;
        scheduleReconnect();
    });

    ib.on(EventName.connectionClosed, () => {
        if (connected) console.warn('[bridge] Connection closed');
        connected = false;
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

connect();

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
        pending.set(orderId, { resolve, reject, timer });
        try {
            ib.placeOrder(orderId, contract, order);
        } catch (e) {
            clearTimeout(timer);
            pending.delete(orderId);
            reject(e);
        }
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

    // CORS preflight
    if (req.method === 'OPTIONS') {
        const allowed = ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin);
        res.writeHead(204, {
            'Access-Control-Allow-Origin': allowed ? origin : 'null',
            'Access-Control-Allow-Private-Network': 'true',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token',
            'Access-Control-Max-Age': '86400',
        });
        return res.end();
    }

    // Enforce Content-Type + Origin on POSTs (CSRF).
    if (req.method === 'POST') {
        const ct = req.headers['content-type'] || '';
        if (!ct.includes('application/json')) {
            res.writeHead(415, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
        }
        const allowed = ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin);
        if (!allowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'Origin not allowed' }));
        }
        // Token check.
        const token = req.headers['x-bridge-token'] || '';
        if (token !== BRIDGE_TOKEN) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: 'Invalid or missing bridge token' }));
        }
    }

    // CORS headers on actual responses.
    const corsOrigin = (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin)) ? origin : 'null';
    const corsHeaders = {
        'Access-Control-Allow-Origin': corsOrigin,
        'Content-Type': 'application/json',
    };

    // GET /health
    if (req.method === 'GET' && url.pathname === '/health') {
        const body = { ok: connected, connected, account, nextOrderId, twsPort: TWS_PORT };
        if (clientIdConflict) body.error = lastError;
        else if (lastError && !connected) body.error = lastError;
        res.writeHead(200, corsHeaders);
        return res.end(JSON.stringify(body));
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
        for (const spec of body.orders) {
            const resolved = { ...spec };
            if (spec.parentRef && refToId[spec.parentRef] != null) resolved.parentId = refToId[spec.parentRef];
            try {
                const result = await placeOrder(resolved);
                if (spec.ref) refToId[spec.ref] = result.orderId;
                results.push({ ok: result.status !== 'Rejected', ...result });
            } catch (e) {
                results.push({ ok: false, error: e.message || String(e) });
            }
        }
        const out = { ok: results.every(r => r.ok), results };
        recordDedupe(body.orderRef, out);
        return sendJson(res, 200, out, corsHeaders);
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

server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`[bridge] HTTP listening on http://127.0.0.1:${BRIDGE_PORT}`);
    console.log(`[bridge] TWS target: ${TWS_HOST}:${TWS_PORT} (clientId=${CLIENT_ID})`);
    console.log(`[bridge] Token: ${BRIDGE_TOKEN}`);
    console.log(`[bridge] Paste this token into the app's Settings → TWS Bridge → Bridge token field.`);
});
