// IBKR Flex Web Service client + Activity-Flex CSV parser.
//
// The Flex Web Service is IBKR's read-only reporting API: a query template is
// configured once in Client Portal (Reports -> Flex Queries) and fetched over
// HTTPS in two steps:
//   1) SendRequest?t=TOKEN&q=QUERY_ID&v=3        -> reference code
//   2) GetStatement?t=TOKEN&q=REFCODE&v=3        -> the report (CSV here)
// A User-Agent header is required on every call.
//
// This module is dependency-free so the test harness can require() it directly
// and so it packs into the portable exe without extra node_modules.
'use strict';

const https = require('https');

const SEND_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest';
const STMT_URL = 'https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement';
const USER_AGENT = 'PositionCalc-Flex/1.0 (Node.js)';

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_TRIES = 20;          // ~60s of statement-generation wait
const REQUEST_TIMEOUT_MS = 30000;

// ---------- low-level ----------
function httpsGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.setTimeout(timeoutMs || REQUEST_TIMEOUT_MS, () => req.destroy(new Error('request timed out')));
        req.on('error', reject);
    });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function xmlTag(xml, name) {
    const m = new RegExp('<' + name + '>([^<]*)</' + name + '>').exec(xml || '');
    return m ? m[1].trim() : null;
}

// ---------- step 1+2: fetch the report ----------
// Returns { ok, csv?, error?, errorCode? }. Never throws for IBKR-side errors.
async function flexRequest(token, queryId, opts) {
    opts = opts || {};
    const maxTries = opts.maxTries || POLL_MAX_TRIES;
    const interval = opts.pollIntervalMs || POLL_INTERVAL_MS;
    const t = encodeURIComponent(String(token || ''));
    const q = encodeURIComponent(String(queryId || ''));
    if (!t || !q) return { ok: false, error: 'Missing flex token or query id' };

    let send;
    try {
        send = await httpsGet(`${SEND_URL}?t=${t}&q=${q}&v=3`, opts.timeoutMs);
    } catch (e) {
        return { ok: false, error: 'SendRequest failed: ' + (e && e.message || e) };
    }
    if (send.status !== 200) return { ok: false, error: 'SendRequest HTTP ' + send.status };

    const status = xmlTag(send.body, 'Status');
    if (status !== 'Success') {
        const code = xmlTag(send.body, 'ErrorCode');
        const msg = xmlTag(send.body, 'ErrorMessage') || send.body.slice(0, 200);
        return { ok: false, error: `IBKR ${code || 'error'}: ${msg}`, errorCode: code };
    }
    const ref = xmlTag(send.body, 'ReferenceCode');
    if (!ref) return { ok: false, error: 'SendRequest returned no reference code' };
    const stmtUrl = xmlTag(send.body, 'Url') || STMT_URL;

    for (let i = 0; i < maxTries; i++) {
        if (i) await sleep(interval);
        let res;
        try {
            res = await httpsGet(`${stmtUrl}?t=${t}&q=${encodeURIComponent(ref)}&v=3`, opts.timeoutMs);
        } catch (e) {
            return { ok: false, error: 'GetStatement failed: ' + (e && e.message || e) };
        }
        if (res.status !== 200) return { ok: false, error: 'GetStatement HTTP ' + res.status };
        const code = xmlTag(res.body, 'ErrorCode');
        if (code === null) return { ok: true, csv: res.body };   // no error envelope -> report body
        if (code === '1019' || code === '1021' || code === '1001' || code === '1004') continue; // still generating
        const msg = xmlTag(res.body, 'ErrorMessage') || ('error ' + code);
        if (code === '1018' && i + 1 < maxTries) continue;        // rate-limited: retry within budget
        return { ok: false, error: `IBKR ${code}: ${msg}`, errorCode: code };
    }
    return { ok: false, error: 'Statement still generating after ' + maxTries + ' tries', errorCode: '1019' };
}

// ---------- CSV parsing ----------
// Activity-Flex CSV: every row is "Section","Header|Data",... — a Header row
// declares column names and the following Data rows carry values.
function splitCsvLine(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
            if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
            else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
    }
    out.push(cur);
    return out;
}
function parseFlexCsv(text) {
    const sections = {};      // name -> {header:[...], rows:[[...]]}
    const skipped = [];
    const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
    for (const raw of lines) {
        if (!raw || !raw.trim()) continue;
        const cols = splitCsvLine(raw);
        const section = cols[0], marker = cols[1];
        if (!section || (marker !== 'Header' && marker !== 'Data')) continue;
        if (marker === 'Header') {
            (sections[section] || (sections[section] = { header: null, rows: [] })).header = cols.slice(2);
        } else {
            const s = sections[section] || (sections[section] = { header: null, rows: [] });
            s.rows.push(cols.slice(2));
        }
    }
    for (const name in sections) if (name !== 'Trades') skipped.push(name);
    return { sections, skippedSections: skipped };
}
// Column-name synonyms -> canonical keys on the returned trade row.
const TRADE_COLS = {
    symbol: ['symbol'],
    dateTime: ['date/time', 'datetime', 'trade date', 'tradedate', 'date'],
    quantity: ['quantity', 'qty'],
    price: ['trade price', 'tradeprice', 't. price', 'price'],
    buySell: ['buy/sell', 'buysell', 'side'],
    commission: ['ib commission', 'ibcommission', 'commission', 'comm/fee', 'commissions'],
    execId: ['ib exec id', 'ibexecid', 'execid', 'exec id'],
    currency: ['currency'],
    orderId: ['ib order id', 'orderid', 'order id'],
    permId: ['ib order perm id', 'permid', 'perm id'],
    account: ['clientaccountid', 'accountid', 'account'],
    levelOfDetail: ['levelofdetail', 'data discriminator', 'datadiscriminator']
};
function mapTradeRow(header, row) {
    const idx = {};
    for (const key in TRADE_COLS) {
        for (const syn of TRADE_COLS[key]) {
            const at = header.findIndex(h => String(h).trim().toLowerCase() === syn);
            if (at >= 0) { idx[key] = at; break; }
        }
    }
    const get = k => idx[k] === undefined ? undefined : String(row[idx[k]] || '').trim();
    return {
        symbol: get('symbol'), dateTime: get('dateTime'), quantity: get('quantity'),
        price: get('price'), buySell: get('buySell'), commission: get('commission'),
        execId: get('execId'), currency: get('currency'), orderId: get('orderId'),
        permId: get('permId'), account: get('account'), levelOfDetail: get('levelOfDetail')
    };
}
// 'yyyyMMdd;HHmmss' / 'yyyy-MM-dd,HH:mm:ss' / 'MM/dd/yyyy HH:mm:ss' etc ->
// { day:'yyyymmdd', time:'yyyymmdd  HH:MM:SS' } (TWS execTime layout).
function parseFlexDateTime(s) {
    const str = String(s || '').trim();
    let m = /^(\d{4})(\d{2})(\d{2})[; ,T]?\s*(\d{2})?:?(\d{2})?:?(\d{2})?/.exec(str);
    if (m) return fmt(m[1] + m[2] + m[3], m[4], m[5], m[6]);
    m = /^(\d{4})-(\d{2})-(\d{2})[ ,T]?(\d{2})?:?(\d{2})?:?(\d{2})?/.exec(str);
    if (m) return fmt(m[1] + m[2] + m[3], m[4], m[5], m[6]);
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]?(\d{2})?:?(\d{2})?:?(\d{2})?/.exec(str);
    if (m) return fmt(m[3] + m[1].padStart(2, '0') + m[2].padStart(2, '0'), m[4], m[5], m[6]);
    return null;
    function fmt(yyyymmdd, hh, mm, ss) {
        const t = `${hh || '00'}:${mm || '00'}:${ss || '00'}`;
        return { day: yyyymmdd, time: `${yyyymmdd}  ${t}` };
    }
}
// Normalize a Trades-section row into the app's exec shape (twsExecKey-compatible).
// Returns null for subtotal/total rows or rows missing required fields.
function flexTradeToExec(row) {
    if (!row || !row.execId) return null;
    const dt = parseFlexDateTime(row.dateTime);
    const qty = Math.abs(Number(row.quantity));   // SELL rows carry negative qty
    const price = Math.abs(Number(row.price));
    const side = /^(buy|bot|b)$/i.test(String(row.buySell || '')) ? 'BOT'
        : /^(sell|sld|s)$/i.test(String(row.buySell || '')) ? 'SLD' : null;
    if (!dt || !(qty > 0) || !(price > 0) || !side || !row.symbol) return null;
    return {
        symbol: String(row.symbol).trim(),
        side, shares: qty, price,
        commission: Math.abs(Number(row.commission)) || 0,
        execId: String(row.execId).trim(),
        time: dt.time, day: dt.day,
        currency: row.currency || undefined,
        orderRef: 'FLEX',
        permId: row.permId || undefined,
        orderId: row.orderId || undefined
    };
}
// Full pipeline: csv text -> { trades:[exec-shaped], skipped:[rows], skippedSections }
function flexTradesFromCsv(text) {
    const { sections, skippedSections } = parseFlexCsv(text);
    const sec = sections['Trades'];
    const trades = []; let skipped = 0;
    if (sec && sec.header) {
        for (const row of sec.rows) {
            const mapped = mapTradeRow(sec.header, row);
            if (mapped.levelOfDetail && /total|summary/i.test(mapped.levelOfDetail)) { skipped++; continue; }
            const ex = flexTradeToExec(mapped);
            if (ex) trades.push(ex); else skipped++;
        }
    }
    trades.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
    return { trades, skipped, skippedSections };
}

module.exports = { flexRequest, parseFlexCsv, mapTradeRow, parseFlexDateTime, flexTradeToExec, flexTradesFromCsv, SEND_URL, STMT_URL };
