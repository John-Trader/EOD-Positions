/* ============================================================
   Portfolio T Ledger — accounting engine, monthly report & sync.
   Standalone classic script: exposes window.Ledger.
   Top level is DOM-free so the _test_* harnesses can eval it.
   Parity reference: Liberty Signal Member Editor (ledger.py).
   Report P&L is price-only (no commissions) — the journal's own
   stats remain the commission-aware view.
   ============================================================ */
'use strict';
var Ledger = (function () {

    var SLEEVES = ['LS v3 Breakout', 'LS Pullback', 'QLD Trend Following'];
    var CASH = 'Cash income';
    var KINDS = ['Entry', 'Add', 'Partial', 'Exit', 'Income', 'Split'];
    var AUDIT_CAP = 300;

    // ---------- bindings (wired by Ledger.init from index.html) ----------
    var _get = null, _set = null, _remove = null;       // storage get/set/remove
    var _journalGet = function () { return []; };       // () => activeTradesLog
    var _journalSet = null;                             // (arr) => persist
    var _hooks = {
        getPrice: function () { return null; },         // (ticker) => live price|null
        twsPositionFor: function () { return null; },   // (ticker) => {qty,avgCost,mktPrice}|null
        qldPrice: function () { return null; },         // () => live QLD price|null
        nyDate: function () { return '1970-01-01'; },   // () => 'YYYY-MM-DD' (NY)
        isRTH: function () { return false; }            // () => bool
    };
    var _mem = {};                                      // test fallback storage

    function storeGet(key, fallback) {
        var raw = _get ? _get(key) : (_mem[key] !== undefined ? _mem[key] : null);
        if (raw === null || raw === undefined) return fallback;
        try { return JSON.parse(raw); } catch (e) { return fallback; }
    }
    function storeSet(key, obj) {
        var raw = JSON.stringify(obj);
        var ok = _set ? _set(key, raw) !== false : (_mem[key] = raw, true);
        // Debounced cloud push on any ledger change — the sync store itself is
        // excluded or a successful push would schedule another push forever.
        if (ok && key !== KEYS.sync && typeof window !== 'undefined' && typeof window.notifyLedgerDirty === 'function') window.notifyLedgerDirty();
        return ok;
    }
    function journal() { return _journalGet() || []; }
    function saveJournal(arr) {
        if (_journalSet) { _journalSet(arr); return true; }
        return false;
    }

    function init(opts) {
        opts = opts || {};
        if (opts.storage) { _get = opts.storage.get; _set = opts.storage.set; _remove = opts.storage.remove || null; }
        if (opts.journal) { _journalGet = opts.journal.get; _journalSet = opts.journal.set; }
        if (opts.hooks) for (var k in opts.hooks) if (typeof opts.hooks[k] === 'function') _hooks[k] = opts.hooks[k];
    }

    // ---------- small utils ----------
    function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
    function today() { return _hooks.nyDate(); }
    function isIsoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
    function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
    function monthOf(d) { return String(d || '').slice(0, 7); }
    function pad2(n) { return String(n).padStart(2, '0'); }
    function addDays(iso, n) {
        var p = iso.split('-').map(Number);
        var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
        return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    function monthBounds(month) {
        var p = String(month || '').split('-');
        var y = +p[0], m = +p[1];
        if (!y || !m || m < 1 || m > 12) return null;
        var first = y + '-' + pad2(m) + '-01';
        var last = new Date(Date.UTC(y, m, 0));
        return [addDays(first, -1), last.getUTCFullYear() + '-' + pad2(last.getUTCMonth() + 1) + '-' + pad2(last.getUTCDate())];
    }

    // ---------- stores ----------
    var KEYS = {
        config: 'ledgerConfig',
        valuations: 'dailyValuations',
        cash: 'cashRecords',
        qldTxns: 'qldLedgerTxns',
        snapshots: 'reportSnapshots',
        audit: 'journalAudit',
        sync: 'syncConfig'
    };
    function config() {
        return storeGet(KEYS.config, { start: null, openingEquity: null, mode: 'actual', reportNotes: {}, importedHistory: null, qldOpeningShares: null });
    }
    function saveConfig(c) { return storeSet(KEYS.config, c); }
    function valuations() { return storeGet(KEYS.valuations, {}); }
    function saveValuations(v) { return storeSet(KEYS.valuations, v); }
    function cashRecords() { return storeGet(KEYS.cash, { flows: [], income: [] }); }
    function saveCashRecords(c) { return storeSet(KEYS.cash, c); }
    function qldTxns() { return storeGet(KEYS.qldTxns, []); }
    function saveQldTxns(t) { return storeSet(KEYS.qldTxns, t); }
    function snapshots() { return storeGet(KEYS.snapshots, {}); }
    function saveSnapshots(s) { return storeSet(KEYS.snapshots, s); }
    function auditLog() { return storeGet(KEYS.audit, []); }
    function saveAuditLog(a) { return storeSet(KEYS.audit, a.slice(-AUDIT_CAP)); }
    function syncConfig() { return storeGet(KEYS.sync, { provider: 'none', enabled: false, url: '', binId: '', apiKey: '', basket: '', lastPushed: 0, lastPulled: 0, remoteTime: 0, lastError: '' }); }
    function saveSyncConfig(c) { return storeSet(KEYS.sync, c); }

    // ---------- trade mapping ----------
    function sleeveBucket(t) {
        var s = t && t.sleeve;
        if (s === 'QLD' || s === 'QLD Trend Following' || (t && t.strategyId === 'qld')) return SLEEVES[2];
        if (s === 'LS Pullback' || (t && t.holdUnit === 'week' && s !== 'QLD')) return SLEEVES[1];
        return SLEEVES[0];
    }
    function tradeSide(t) { return t && t.side === 'SHORT' ? 'S' : 'L'; }
    function tradeId(t) { return String(t.id); }

    // Stored events win; legacy flat rows synthesize Entry (+Exit) so every
    // trade is event-sourced for the engine without touching journal math.
    function tradeEvents(t, through) {
        var ev = Array.isArray(t.events) && t.events.length ? t.events.slice() : synthEvents(t);
        ev.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.seq || 0) - (b.seq || 0); });
        if (through) ev = ev.filter(function (e) { return e.date <= through; });
        return ev;
    }
    function synthEvents(t) {
        var out = [];
        var qty = num(t.totalQty) || num(t.closedQty) || num(t.shares) || 0;
        if (qty > 0 && isIsoDate(t.entryDate) && num(t.entryPrice) > 0) {
            out.push({ id: 'syn-e-' + tradeId(t), kind: 'Entry', date: t.entryDate, qty: qty, price: num(t.entryPrice), amount: 0, note: '', seq: 1, synth: true });
        }
        if (t.status === 'CLOSED' && isIsoDate(t.exitDate) && num(t.exitPrice) > 0) {
            var q = num(t.closedQty) || qty;
            if (q > 0) out.push({ id: 'syn-x-' + tradeId(t), kind: 'Exit', date: t.exitDate, qty: q, price: num(t.exitPrice), amount: 0, note: '', seq: 2, synth: true });
        }
        return out;
    }
    // Give a trade its first stored Entry event (from flat fields) so later
    // appended events join a real history instead of a bare Partial.
    function ensureEvents(t) {
        if (Array.isArray(t.events) && t.events.length) return t.events;
        var syn = synthEvents(t);
        // Drop a synthesized Exit — a live mutation means the flat state was stale.
        t.events = syn.filter(function (e) { return e.kind !== 'Exit'; });
        return t.events;
    }
    function nextSeq(t) {
        var m = 0;
        (t.events || []).forEach(function (e) { if ((e.seq || 0) > m) m = e.seq; });
        return m + 1;
    }
    // Append a ledger event to a trade. Advisory validation only — never blocks.
    function appendEvent(t, ev) {
        // An incoming Entry IS the genesis — materializing synthesized events
        // first would create a second Entry and double the inventory.
        if (ev.kind === 'Entry') { if (!Array.isArray(t.events)) t.events = []; }
        else ensureEvents(t);
        var e = {
            id: ev.id || uid(), kind: ev.kind, date: ev.date || today(),
            qty: num(ev.qty) || 0, price: num(ev.price) || 0,
            amount: num(ev.amount) || 0, note: String(ev.note || ''),
            seq: nextSeq(t)
        };
        if (ev.execId) e.execId = String(ev.execId);
        t.events.push(e);
        return e;
    }
    function hasExecEvent(t, execId) {
        return (t.events || []).some(function (e) { return e.execId === String(execId); });
    }

    // ---------- event validation (advisory — returns warnings, never throws) ----------
    function validateTradeEvents(t) {
        var warnings = [];
        var ev = tradeEvents(t);
        if (!ev.length || ev[0].kind !== 'Entry') warnings.push('Missing Entry event.');
        if (ev.filter(function (e) { return e.kind === 'Entry'; }).length > 1) warnings.push('More than one Entry event.');
        var qty = 0, seen = {};
        for (var i = 0; i < ev.length; i++) {
            var e = ev[i];
            var key = e.date + '|' + e.seq;
            if (seen[key]) warnings.push('Same-day events need distinct sequence numbers.');
            seen[key] = true;
            if (e.kind === 'Entry' || e.kind === 'Add') {
                if (i && qty <= 1e-8) warnings.push('Trade reopened after full exit — use a new trade record.');
                qty += e.qty;
            } else if (e.kind === 'Partial' || e.kind === 'Exit') {
                if (e.qty > qty + 1e-8) warnings.push(e.kind + ' sells ' + e.qty + ' but only ' + qty + ' held.');
                if (e.kind === 'Exit' && qty > 1e-8 && Math.abs(qty - e.qty) > 1e-8) warnings.push('Exit should close all remaining shares — use Partial for a reduction.');
                qty -= Math.min(e.qty, qty);
            } else if (e.kind === 'Split') {
                qty *= e.qty;
            }
        }
        return warnings;
    }

    // ---------- inventory / P&L ----------
    function inventory(t, through) {
        var qty = 0;
        tradeEvents(t, through).forEach(function (e) {
            if (e.kind === 'Entry' || e.kind === 'Add') qty += e.qty;
            else if (e.kind === 'Partial' || e.kind === 'Exit') qty -= e.qty;
            else if (e.kind === 'Split') qty *= e.qty;
        });
        return Math.max(0, qty);
    }
    function markFor(tid, date) {
        var vals = valuations();
        var day = vals[date];
        if (day && day.marks && num(day.marks[tid]) > 0) return num(day.marks[tid]);
        return null;
    }
    // Nearest mark on or before the date → live quote fallback.
    function markNear(t, date) {
        var vals = valuations(), tid = tradeId(t), best = null;
        for (var d in vals) {
            if (d <= date && vals[d].marks && num(vals[d].marks[tid]) > 0 && (!best || d > best.d)) best = { d: d, v: num(vals[d].marks[tid]) };
        }
        if (best) return { price: best.v, asOf: best.d };
        // Live quotes are honest marks for today only — valuing a historical
        // date at today's price fabricates past P&L. Null → caller flags missing.
        if (date === today()) {
            var live = _hooks.getPrice(t.ticker);
            if (num(live) > 0) return { price: live, asOf: 'live' };
        }
        return null;
    }
    // Cumulative cash P&L through `when`; open remainder valued at its mark.
    // Returns {pnl, missing:boolean} — never throws on missing marks.
    function cumPnl(t, when) {
        var sign = tradeSide(t) === 'L' ? 1 : -1;
        var cash = 0, qty = 0, missing = false, markAsOf = null;
        tradeEvents(t, when).forEach(function (e) {
            if (e.kind === 'Entry' || e.kind === 'Add') { qty += e.qty; cash -= sign * e.qty * e.price; }
            else if (e.kind === 'Partial' || e.kind === 'Exit') { qty -= e.qty; cash += sign * e.qty * e.price; }
            else if (e.kind === 'Income') { cash += sign * e.amount; }
            else if (e.kind === 'Split') { qty *= e.qty; }
        });
        if (qty > 1e-8) {
            var mk = markNear(t, when);
            if (mk) { cash += sign * qty * mk.price; markAsOf = mk.asOf; }
            else { missing = true; cash += sign * qty * (num(t.entryPrice) || 0); }
        }
        return { pnl: cash, missing: missing, markAsOf: markAsOf, openQty: Math.max(0, qty) };
    }

    // Realized P&L bucketed by ISO month. Walks every trade's full event
    // stream with average-cost inventory so Partial/Exit events date their
    // own contribution — a cross-month trade attributes each reduction to
    // the month it filled, not the final close month. Price-only, matching
    // report attribution (commissions stay in the flat journal view).
    function realizedByMonth() {
        var out = {};
        journal().forEach(function (t) {
            var sign = tradeSide(t) === 'L' ? 1 : -1, qty = 0, cost = 0;
            tradeEvents(t).forEach(function (e) {
                if (e.kind === 'Entry' || e.kind === 'Add') { cost += e.qty * e.price; qty += e.qty; }
                else if (e.kind === 'Split') { qty *= e.qty; }
                else if ((e.kind === 'Partial' || e.kind === 'Exit') && qty > 1e-8 && e.qty > 0) {
                    var q = Math.min(e.qty, qty), avg = cost / qty;
                    var mk = monthOf(e.date);
                    if (mk) out[mk] = (out[mk] || 0) + sign * q * (e.price - avg);
                    cost -= avg * q; qty -= q;
                }
            });
        });
        return out;
    }
    function realizedInMonth(monthKey) {
        return realizedByMonth()[monthKey] || 0;
    }

    // ---------- cash records & QLD dollar ledger ----------
    function flowsBetween(start, end) {
        return cashRecords().flows.reduce(function (s, f) { return (f.date > start && f.date <= end) ? s + num(f.amount) || 0 : s; }, 0);
    }
    function incomeBetween(start, end, sleeve) {
        return cashRecords().income.reduce(function (s, a) {
            return (a.date > start && a.date <= end && (!sleeve || a.sleeve === sleeve)) ? s + (num(a.amount) || 0) : s;
        }, 0);
    }
    // QLD share tracking: opening shares + Buy/Sale qty; null when unknown.
    function qldSharesAt(day) {
        var conf = config();
        var qty = num(conf.qldOpeningShares);
        if (qty === null) return null;
        var txns = qldTxns().slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
        for (var i = 0; i < txns.length; i++) {
            var t = txns[i];
            if (t.date > day || t.kind === 'Distribution') continue;
            var q = num(t.qty);
            if (q === null) return null;
            qty += (t.kind === 'Buy' ? q : -q);
        }
        return Math.max(0, qty);
    }
    // QLD sleeve $ value on a date: stored mark → shares×price → TWS (today only).
    function qldValueOn(date, strict) {
        var vals = valuations();
        if (vals[date] && num(vals[date].qldValue) !== null && vals[date].qldValue !== undefined) return { value: num(vals[date].qldValue), asOf: date };
        // nearest stored on or before
        var best = null;
        for (var d in vals) if (d <= date && vals[d].qldValue !== undefined && vals[d].qldValue !== null && (!best || d > best.d)) best = { d: d, v: num(vals[d].qldValue) };
        if (best) return { value: best.v, asOf: best.d };
        if (date === today()) {
            var sh = qldSharesAt(date);
            var px = num(_hooks.qldPrice());
            if (sh !== null && px) return { value: sh * px, asOf: 'live' };
            var pos = _hooks.twsPositionFor('QLD');
            if (pos && num(pos.qty) !== null && px) return { value: Math.abs(pos.qty) * px, asOf: 'live-tws' };
        }
        // No QLD data at all is legitimately zero (sleeve in cash, never touched).
        var any = Object.keys(vals).some(function (dd) { return vals[dd].qldValue !== undefined && vals[dd].qldValue !== null; })
            || qldTxns().length > 0;
        if (!any && !strict) return { value: 0, asOf: 'none' };
        return strict ? { value: 0, asOf: 'none' } : { value: null, asOf: 'missing' };
    }
    function qldPnl(start, end) {
        var txns = qldTxns();
        var sum = { Buy: 0, Sale: 0, Distribution: 0 };
        txns.forEach(function (t) {
            if (t.date > start && t.date <= end && sum[t.kind] !== undefined) sum[t.kind] += num(t.amount) || 0;
        });
        var before = qldValueOn(start), after = qldValueOn(end);
        // A missing mark must not silently substitute 0 — that fabricates P&L.
        // Signal null → caller falls back to QLD journal trades.
        if (before.asOf === 'missing' || after.asOf === 'missing') {
            return { opening: null, current: null, buy: sum.Buy, sale: sum.Sale, distribution: sum.Distribution, pnl: null, valueAsOf: { start: before.asOf, end: after.asOf } };
        }
        var opening = before.value || 0, current = after.value || 0;
        var fromLedger = txns.length > 0 || opening !== 0 || current !== 0
            || Object.keys(valuations()).some(function (d) { return valuations()[d].qldValue != null; });
        var pnl = fromLedger
            ? current - opening + sum.Sale - sum.Buy + sum.Distribution
            : null; // caller falls back to QLD journal trades
        return { opening: opening, current: current, buy: sum.Buy, sale: sum.Sale, distribution: sum.Distribution, pnl: pnl, valueAsOf: { start: before.asOf, end: after.asOf } };
    }
    function recordQldTxn(kind, date, amount, qty, price, note) {
        if (!['Buy', 'Sale', 'Distribution'].includes(kind) || !isIsoDate(date)) return null;
        var txns = qldTxns();
        var t = { id: uid(), date: date, kind: kind, amount: num(amount) || 0, qty: num(qty), price: num(price), note: String(note || '') };
        txns.push(t);
        saveQldTxns(txns);
        return t;
    }

    // ---------- equity ----------
    // {value, asOf} — actual: exact or nearest stored ≤ date; model: computed.
    function equityAt(date) {
        var conf = config();
        if (!conf.start) return { value: null, asOf: 'no-setup' };
        if (date <= conf.start) {
            var cap = num(conf.openingEquity);
            return { value: cap, asOf: conf.start };
        }
        var vals = valuations();
        if (conf.mode === 'model') {
            var c = num(conf.openingEquity);
            if (c === null) return { value: null, asOf: 'no-capital' };
            var comp = pnlComponents(conf.start, date);
            return { value: c + comp.total + flowsBetween(conf.start, date), asOf: 'model' };
        }
        if (vals[date] && num(vals[date].equity) > 0) return { value: num(vals[date].equity), asOf: date };
        var best = null;
        for (var d in vals) if (d <= date && num(vals[d].equity) > 0 && (!best || d > best)) best = d;
        if (best) return { value: num(vals[best].equity), asOf: best };
        return { value: null, asOf: 'missing' };
    }

    // ---------- P&L components ----------
    // tradeId → $, 'cash:<sleeve>' → $, 'qld' → $. QLD trades excluded when the
    // dollar ledger has data (they'd double-count); folded in otherwise.
    function pnlComponents(start, end) {
        var parts = {}, total = 0, missing = [];
        journal().forEach(function (t) {
            if (sleeveBucket(t) === SLEEVES[2]) return;
            var a = cumPnl(t, start), b = cumPnl(t, end);
            if (a.missing || b.missing) missing.push(t.ticker);
            parts[tradeId(t)] = b.pnl - a.pnl;
            total += parts[tradeId(t)];
        });
        SLEEVES.concat([CASH]).forEach(function (s) {
            parts['cash:' + s] = incomeBetween(start, end, s);
            total += parts['cash:' + s];
        });
        var qp = qldPnl(start, end);
        if (qp.pnl !== null) {
            parts['qld'] = qp.pnl;
        } else {
            parts['qld'] = 0;
            journal().forEach(function (t) {
                if (sleeveBucket(t) !== SLEEVES[2]) return;
                parts['qld'] += cumPnl(t, end).pnl - cumPnl(t, start).pnl;
            });
        }
        total += parts['qld'];
        return { parts: parts, total: total, missing: missing, qld: qp };
    }

    // ---------- TWR performance ----------
    // Linked sub-periods cut the day before each flow. Returns nulls (not
    // exceptions) when equity/marks are missing — the UI renders "Pending".
    function performance(start, end) {
        var conf = config();
        if (!conf.start || start >= end) {
            return {
                ok: false, missing: ['Set the ledger opening date first (Report → Setup).'],
                returnPct: null, contributions: {}, pnl: {}, residual: 0, residualMagnitude: 0,
                openingEquity: null, closingEquity: null, equityAsOf: {}, flows: 0
            };
        }
        if (start < conf.start) start = conf.start;
        var boundaries = {}, missing = [];
        boundaries[end] = true;
        cashRecords().flows.forEach(function (f) {
            if (f.date > start && f.date <= end) boundaries[addDays(f.date, -1)] = true;
        });
        var linked = {}, growth = 1, prev = start, residual = 0, residualMag = 0;
        var points = Object.keys(boundaries).filter(function (b) { return b > start; }).sort();
        for (var i = 0; i < points.length; i++) {
            var boundary = points[i];
            var eq0 = equityAt(prev), eq1 = equityAt(boundary);
            if (eq0.value === null || eq1.value === null) {
                missing.push('Account equity missing near ' + (eq0.value === null ? prev : boundary) + '.');
                continue;
            }
            var comp = pnlComponents(prev, boundary);
            missing = missing.concat(comp.missing.map(function (s) { return 'Close price missing for ' + s + '.'; }));
            var flow = flowsBetween(prev, boundary);
            var capital = eq0.value + flow;
            if (capital <= 0) { missing.push('Non-positive capital on ' + prev + '.'); continue; }
            var actualPnl = eq1.value - eq0.value - flow;
            var res = actualPnl - comp.total;
            residual += res;
            residualMag += Math.abs(res);
            for (var k in comp.parts) linked[k] = (linked[k] || 0) + growth * comp.parts[k] / capital;
            linked['unreconciled'] = (linked['unreconciled'] || 0) + growth * res / capital;
            growth *= 1 + actualPnl / capital;
            prev = boundary;
        }
        var raw = pnlComponents(start, end);
        var openEq = equityAt(start), closeEq = equityAt(end);
        return {
            ok: missing.length === 0,
            missing: missing,
            returnPct: growth - 1,
            contributions: linked,
            pnl: raw.parts,
            residual: residual,
            residualMagnitude: residualMag,
            openingEquity: openEq.value,
            closingEquity: closeEq.value,
            equityAsOf: { start: openEq.asOf, end: closeEq.asOf },
            flows: flowsBetween(start, end)
        };
    }

    // ---------- report ----------
    function fmtDate(d) {
        if (!isIsoDate(d)) return String(d || '—');
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        var p = d.split('-');
        return (+p[2]) + ' ' + months[+p[1] - 1] + ' ' + p[0].slice(2);
    }
    function fillStr(e) { return e.qty.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' @ ' + e.price.toFixed(2) + ' (' + e.date + ')'; }
    function publicFills(value) {
        return (value || '').split(';').map(function (f) {
            var t = f.trim();
            if (!t) return '';
            var at = t.indexOf('@');
            return at >= 0 ? t.slice(at + 1).trim() : t;
        }).filter(Boolean).join('; ') || '—';
    }
    // Display fields for one report row (fills stop at `end`).
    function reportTradeDetails(t, month, end) {
        var ev = tradeEvents(t, end);
        var entry = ev.filter(function (e) { return e.kind === 'Entry'; })[0];
        var exits = ev.filter(function (e) { return e.kind === 'Exit'; });
        var partials = ev.filter(function (e) { return e.kind === 'Partial'; });
        var qty = inventory(t, end);
        var closed = exits.length ? exits[exits.length - 1] : null;
        var status = closed ? 'Closed' : (partials.length ? 'Partial' : 'Open');
        var row = {
            id: tradeId(t), symbol: t.ticker, sleeve: sleeveBucket(t), side: tradeSide(t),
            note: t.note || '',
            opened: entry ? entry.date : (t.entryDate || ''),
            entry: entry ? entry.price : num(t.entryPrice),
            quantity: qty,
            partial: partials.map(fillStr).join('; '),
            exit_fill: exits.map(fillStr).join('; '),
            exit: closed ? closed.price : null,
            closed: closed ? closed.date : null,
            status: status,
            continuation: qty > 1e-8 ? 'Check next month report.' : ''
        };
        // Still-open positions opened this month hide their working fills.
        if (qty > 1e-8 && monthOf(row.opened) === month) { row.partial = ''; row.exit = null; row.exit_fill = ''; }
        return row;
    }
    function statusLabel(row, carried) {
        if (row.status === 'Closed' && !row.closed) return { kind: 'Closed', label: 'Closed' };
        if (row.closed) return { kind: 'Closed', label: 'Closed · ' + fmtDate(row.closed) };
        if (row.status === 'Partial') return { kind: 'Partial', label: 'Partial · Still open' };
        return carried ? { kind: 'Carried', label: 'Carried' } : { kind: 'Open', label: 'Open' };
    }
    function buildMonthReport(month, asof) {
        var conf = config();
        var bounds = monthBounds(month);
        if (!bounds) return { ok: false, error: 'Invalid month.' };
        if (!conf.start) return { ok: false, error: 'Set up the ledger first (opening date + equity).' };
        var previous = bounds[0], end = bounds[1];
        var asofD = asof || today();
        if (end > asofD) end = asofD;
        var start = conf.start > previous ? conf.start : previous;
        var perf = performance(start, end);
        var upper = [], carried = [];
        var sleevePp = {};
        SLEEVES.forEach(function (s) { sleevePp[s] = perf.contributions['cash:' + s] ? perf.contributions['cash:' + s] * 100 : 0; });
        sleevePp[SLEEVES[2]] += (perf.contributions['qld'] || 0) * 100;
        journal().forEach(function (t) {
            if (sleeveBucket(t) === SLEEVES[2]) return;   // QLD rolls into its sleeve tile
            var info = reportTradeDetails(t, month, end);
            if (!info.opened || info.opened > end) return;
            var pp = (perf.contributions[info.id] || 0) * 100;
            sleevePp[info.sleeve] += pp;
            var row = Object.assign({}, info, { pp: pp, pnl: perf.pnl[info.id] || 0 });
            if (monthOf(info.opened) === month) upper.push(row);
            else if (inventory(t, start) > 1e-8 || Math.abs(row.pnl) > 1e-8) carried.push(row);
        });
        upper.sort(function (a, b) { return a.opened < b.opened ? -1 : a.opened > b.opened ? 1 : a.symbol.localeCompare(b.symbol); });
        carried.sort(function (a, b) { return a.opened < b.opened ? -1 : a.opened > b.opened ? 1 : a.symbol.localeCompare(b.symbol); });
        var incomplete = [];
        if (!perf.ok) incomplete = incomplete.concat(perf.missing);
        var todayV = valuations()[end];
        if (todayV && todayV.kind === 'intraday') incomplete.push('Intraday values on ' + fmtDate(end) + ' — save a market-close update before finalizing.');
        return {
            ok: true, month: month, start: start, end: end,
            partialMonth: start !== previous || end !== bounds[1],
            mode: conf.mode,
            returnPct: perf.returnPct * 100,
            sleeves: sleevePp,
            cashPp: (perf.contributions['cash:' + CASH] || 0) * 100,
            unreconciledPp: (perf.contributions['unreconciled'] || 0) * 100,
            residual: perf.residual, residualMagnitude: perf.residualMagnitude,
            openingEquity: perf.openingEquity, closingEquity: perf.closingEquity,
            equityAsOf: perf.equityAsOf, flows: perf.flows,
            upper: upper, carried: carried,
            lifecycleAsof: end, reportVersion: 2,
            notes: [conf.reportNotes && conf.reportNotes[month] ? conf.reportNotes[month] : ''].filter(Boolean),
            incompleteReason: incomplete.join(' '),
            qld: perf.pnl !== undefined ? qldPnl(start, end) : null
        };
    }
    // "Since previous valuation" — per-position P&L + pp between two valuation dates.
    function intervalContribution(dateA, dateB) {
        var eq0 = equityAt(dateA), eq1 = equityAt(dateB);
        var rows = [];
        journal().forEach(function (t) {
            var d = cumPnl(t, dateB).pnl - cumPnl(t, dateA).pnl;
            if (Math.abs(d) < 1e-8 && sleeveBucket(t) === SLEEVES[2]) return;
            if (Math.abs(d) < 1e-8 && inventory(t, dateB) < 1e-8 && inventory(t, dateA) < 1e-8) return;
            rows.push({ symbol: t.ticker, sleeve: sleeveBucket(t), pnl: d });
        });
        rows.push({ symbol: 'QLD (ledger)', sleeve: SLEEVES[2], pnl: (qldPnl(dateA, dateB).pnl || 0) });
        var cap = eq0.value;
        rows.forEach(function (r) { r.pp = cap ? r.pnl / cap * 100 : null; });
        return { rows: rows, equity0: eq0, equity1: eq1, delta: (eq0.value !== null && eq1.value !== null) ? eq1.value - eq0.value : null };
    }

    // ---------- report HTML (published format, share quantities hidden) ----------
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function pct(n, suffix) {
        if (n === null || n === undefined || !Number.isFinite(n)) return 'Pending';
        return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + (suffix === undefined ? '%' : suffix);
    }
    function reportHtml(report, opts) {
        opts = opts || {};
        var showQty = opts.showQty === true;   // exported reports stay share-free
        function fills(v) { return showQty ? (v || '—') : publicFills(v); }
        var BADGE = {
            'LS v3 Breakout': 'background:#80621e;color:#fff2c8', 'LS Pullback': 'background:#245880;color:#e1f0ff',
            'QLD Trend Following': 'background:#426c57;color:#e3f4ea', 'Closed': 'background:#50545a;color:#f1f1f1',
            'Open': 'background:#265e8b;color:#e4f1ff', 'Partial': 'background:#645486;color:#f0e9ff', 'Carried': 'background:#80621e;color:#fff2c8'
        };
        function table(rows, carried) {
            var heads = ['Symbol', 'Date', 'Sleeve', 'L/S', 'Entry Price', 'Partial', 'Exit Price', 'Status', 'Month P/L (pp)'];
            var h = '<div style="overflow-x:auto"><table><thead><tr>' + heads.map(function (x) { return '<th>' + esc(x) + '</th>'; }).join('') + '</tr></thead><tbody>';
            if (!rows.length) h += '<tr><td colspan="9" class="lr-empty">No ' + (carried ? 'carried positions' : 'new signals') + ' in this period.</td></tr>';
            rows.forEach(function (r) {
                var st = statusLabel(r, carried);
                var label = esc(st.label);
                if (r.continuation && !report.incompleteReason) label += '<div class="lr-note">' + esc(r.continuation) + '</div>';
                var ppClass = r.pp === null ? '' : (r.pp >= 0 ? 'positive' : 'negative');
                h += '<tr><td><b>' + esc(r.symbol) + '</b></td><td>' + esc(fmtDate(r.opened)) + '</td>'
                    + '<td><span class="lr-badge" style="' + BADGE[r.sleeve] + '">' + esc(r.sleeve) + '</span></td>'
                    + '<td>' + esc(r.side) + '</td><td class="num">' + (r.entry !== null ? r.entry.toFixed(2) : '—') + '</td>'
                    + '<td>' + esc(fills(r.partial)) + '</td><td>' + esc(fills(r.exit_fill)) + '</td>'
                    + '<td><span class="lr-badge" style="' + BADGE[st.kind] + '">' + label + '</span></td>'
                    + '<td class="' + ppClass + '">' + (r.pp === null ? 'Pending' : (r.pp >= 0 ? '+' : '−') + Math.abs(r.pp).toFixed(2)) + '</td></tr>';
            });
            return h + '</tbody></table></div>';
        }
        var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        var title = MONTHS[+report.month.slice(5, 7) - 1] + ' ' + report.month.slice(0, 4);
        var out = '<div class="lr-report"><style>'
            + '.lr-report{background:#202020;color:#f3f3f3;padding:20px 16px;font:13px/1.35 "Helvetica Neue",Arial,sans-serif;max-width:1200px;margin:auto;border-radius:8px}'
            + '.lr-report h1{font:700 25px/1.2 -apple-system,system-ui,sans-serif;margin:0 0 20px}'
            + '.lr-report h2{font-size:13px;font-weight:700;margin:17px 0 0;padding:7px;text-align:center;background:#2c2c2c;color:#e0e0e0}'
            + '.lr-report table{width:100%;min-width:650px;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}'
            + '.lr-report th{background:#2c2c2c;color:#e0e0e0;font-weight:700}.lr-report td{background:#3a3a3a}'
            + '.lr-report th,.lr-report td{border:1px solid #363636;padding:7px 3px;text-align:center;vertical-align:middle;overflow-wrap:anywhere}'
            + '.lr-badge{display:inline-block;padding:3px 6px;border-radius:4px;font-size:11px;font-weight:700}'
            + '.lr-report .positive{color:#52d52a;font-weight:700}.lr-report .negative{color:#fc4b3d;font-weight:700}'
            + '.lr-report td.positive{background:#52d52a;color:#000;font-size:16px}.lr-report td.negative{background:#fc4b3d;color:#000;font-size:16px}'
            + '.lr-total{margin-top:17px;background:#2c2c2c;padding:10px 6px;text-align:center;font:700 20px/1.3 -apple-system,system-ui,sans-serif;color:#e0e0e0}'
            + '.lr-sleeves{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:#363636;margin-top:1px;text-align:center}'
            + '.lr-sleeves>div{background:#2c2c2c;padding:10px 3px}.lr-sleeves span{display:block;color:#dedede;font-size:11px;margin-bottom:4px}.lr-sleeves b{font-size:16px}'
            + '.lr-note{font-size:11px;color:#dedede;margin:3px 0 0}.lr-extra{display:flex;justify-content:space-between;margin-top:10px;font-size:13px;padding:0 4px}'
            + '.lr-empty{color:#dedede;padding:9px;text-align:center;font-size:12px}.lr-meta{color:#dedede;font-size:11px;margin-top:12px;text-align:center}'
            + '@media(max-width:420px){.lr-report{padding:16px 10px}.lr-total{font-size:17px}.lr-sleeves b{font-size:14px}}'
            + '</style><h1>' + esc(title) + '</h1>';
        out += table(report.upper, false) + '<h2>Carried from prior months</h2>' + table(report.carried, true);
        var rc = report.returnPct === null ? '' : (report.returnPct >= 0 ? 'positive' : 'negative');
        out += '<div class="lr-total"><span>Total Return Month: </span><b class="' + rc + '">' + pct(report.returnPct) + '</b></div><div class="lr-sleeves">';
        SLEEVES.forEach(function (s) {
            var v = report.sleeves[s];
            out += '<div><span>' + esc(s) + '</span><b class="' + (v >= 0 ? 'positive' : 'negative') + '">' + pct(v, ' pp') + '</b></div>';
        });
        out += '</div>';
        if (Math.abs(report.cashPp) > 1e-8) out += '<div class="lr-extra"><span>Cash income</span><b>' + pct(report.cashPp, ' pp') + '</b></div>';
        if (Math.abs(report.unreconciledPp) > 1e-8) out += '<div class="lr-extra"><span>Unreconciled</span><b>' + pct(report.unreconciledPp, ' pp') + '</b></div>';
        report.notes.forEach(function (n) { out += '<div class="lr-meta">' + esc(n) + '</div>'; });
        if (report.partialMonth) out += '<div class="lr-meta">Partial period: ' + esc(fmtDate(report.start)) + ' – ' + esc(fmtDate(report.end)) + '</div>';
        if (opts.footer !== false) out += '<div class="lr-meta">Equity ' + (report.openingEquity !== null ? '$' + report.openingEquity.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + ' → ' + (report.closingEquity !== null ? '$' + report.closingEquity.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—') + (report.flows ? ' · net flows ' + (report.flows >= 0 ? '+' : '−') + '$' + Math.abs(report.flows).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '') + '</div>';
        return out + '</div>';
    }
    function reportHtmlDocument(report) {
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Portfolio T — ' + esc(report.month) + '</title></head><body style="margin:0;background:#141414">' + reportHtml(report) + '</body></html>';
    }

    // ---------- snapshots / finalize ----------
    function canFinalize(report) {
        if (!report || !report.ok) return 'Report could not be built.';
        if (report.incompleteReason) return report.incompleteReason;
        var bounds = monthBounds(report.month);
        if (report.end !== bounds[1]) return 'Only a complete calendar month can be frozen — the current view is month-to-date.';
        if (Math.abs(report.residualMagnitude) > 0.01) return 'Reconcile the account difference (unreconciled ' + pct(report.unreconciledPp, ' pp') + ') before freezing.';
        if (report.returnPct === null) return 'Total return is pending — valuations are missing.';
        return null;
    }
    function finalizeMonth(month, report, reason) {
        var err = canFinalize(report);
        if (err) return { ok: false, error: err };
        var snaps = snapshots();
        var list = snaps[month] || [];
        if (list.length && !String(reason || '').trim()) return { ok: false, error: 'Enter a reason to revise an existing month.' };
        list.push({ revision: list.length + 1, time: new Date().toISOString(), reason: String(reason || '').trim() || 'Initial month-end snapshot', report: report, stale: false });
        snaps[month] = list;
        saveSnapshots(snaps);
        auditPush('Finalize report ' + month, reason || 'Initial month-end snapshot', {});
        return { ok: true, revision: list.length };
    }
    function snapshotList(month) { return (snapshots()[month] || []).slice(); }
    function allSnapshots() { return snapshots(); }
    // Any finalized month whose period could include `dateStr` goes stale.
    function flagStaleFrom(dateStr) {
        var month = monthOf(dateStr);
        if (!month) return [];
        var snaps = snapshots(), flagged = [];
        for (var m in snaps) {
            if (m >= month) {
                snaps[m].forEach(function (s) { if (!s.stale) { s.stale = true; flagged.push(m); } });
            }
        }
        if (flagged.length) saveSnapshots(snaps);
        return flagged;
    }
    // A mutation affecting `dateStr` needs a reason when a finalized month covers it.
    function requiresReason(dateStr) {
        var month = monthOf(dateStr);
        var snaps = snapshots();
        return Object.keys(snaps).some(function (m) { return m >= month && snaps[m].length; });
    }

    // ---------- audit + undo ----------
    // undo = {stores:{key:rawJson|null}, trades:[{id, before}]} — captured by caller.
    function auditPush(action, reason, undo) {
        var log = auditLog();
        log.push({ id: uid(), time: new Date().toISOString(), action: String(action || ''), reason: String(reason || ''), undo: undo || {} });
        saveAuditLog(log);
    }
    function captureTradeUndo(ids) {
        var wanted = {};
        ids.forEach(function (i) { wanted[String(i)] = true; });
        return { trades: journal().filter(function (t) { return wanted[tradeId(t)]; }).map(function (t) { return { id: t.id, before: JSON.parse(JSON.stringify(t)) }; }) };
    }
    function captureStoreUndo(keys) {
        var stores = {};
        keys.forEach(function (k) { stores[k] = _get ? _get(k) : (_mem[k] !== undefined ? _mem[k] : null); });
        return { stores: stores };
    }
    // Undo the most recent UNDONE-able audit entry: restores stores + journal
    // trades. Entries already rolled back (undoneBy) and entries with no undo
    // payload (finalize, prior Undo markers) are skipped — repeated Undo walks
    // back through real changes instead of reporting a phantom success.
    function undoLast(reason) {
        var log = auditLog();
        var entry = null;
        for (var i = log.length - 1; i >= 0; i--) {
            var e = log[i];
            if (e.undoneBy) continue;
            var uu = e.undo || {};
            if ((uu.stores && Object.keys(uu.stores).length) || (uu.trades && uu.trades.length)) { entry = e; break; }
        }
        if (!entry) return { ok: false, error: 'There is no saved change to undo.' };
        var u = entry.undo || {};
        if (u.stores) {
            for (var k in u.stores) {
                if (u.stores[k] === null || u.stores[k] === undefined) {
                    // Key did not exist before the change — undo must remove it.
                    if (_remove) _remove(k); else delete _mem[k];
                }
                else if (_set) _set(k, u.stores[k]); else _mem[k] = u.stores[k];
            }
        }
        if (u.trades && u.trades.length) {
            var arr = journal().slice();
            u.trades.forEach(function (r) {
                var i = arr.findIndex(function (t) { return String(t.id) === String(r.id); });
                if (r.before === '__deleted__') { if (i >= 0) arr.splice(i, 1); }
                else if (i >= 0) arr[i] = r.before;
                else arr.push(r.before);
            });
            saveJournal(arr);
        }
        // Mark the entry consumed BEFORE pushing the audit marker (auditPush
        // re-reads the store — the mark must already be persisted).
        entry.undoneBy = true;
        saveAuditLog(log);
        // The undo itself is audited (without an undo payload of its own).
        auditPush('Undo: ' + entry.action, reason || '', {});
        if (typeof window !== 'undefined' && typeof window.notifyLedgerDirty === 'function') window.notifyLedgerDirty();
        return { ok: true, entry: entry };
    }

    // ---------- valuation capture ----------
    // Merge into today's (or a given) daily valuation. Only writes on change.
    function captureValuation(date, patch) {
        var vals = valuations();
        var cur = vals[date] || { marks: {}, kind: 'intraday' };
        var changed = false;
        if (patch.equity !== undefined && patch.equity !== null && cur.equity !== patch.equity) { cur.equity = patch.equity; changed = true; }
        if (patch.qldValue !== undefined && patch.qldValue !== null && cur.qldValue !== patch.qldValue) { cur.qldValue = patch.qldValue; changed = true; }
        if (patch.marks) {
            cur.marks = cur.marks || {};
            for (var tid in patch.marks) {
                if (num(patch.marks[tid]) > 0 && cur.marks[tid] !== patch.marks[tid]) { cur.marks[tid] = patch.marks[tid]; changed = true; }
            }
        }
        if (patch.kind && cur.kind !== patch.kind) { cur.kind = patch.kind; changed = true; }
        if (!changed) return false;
        vals[date] = cur;
        return saveValuations(vals);
    }
    // Auto-capture from live quotes — call after a price refresh. Intraday
    // during RTH, 'close' outside it. Writes only when prices moved.
    function captureMarksFromQuotes() {
        var date = today(), marks = {};
        journal().forEach(function (t) {
            if (t.status !== 'ACTIVE') return;
            var p = _hooks.getPrice(t.ticker);
            if (num(p) > 0) marks[tradeId(t)] = p;
        });
        if (!Object.keys(marks).length) return false;
        return captureValuation(date, { marks: marks, kind: _hooks.isRTH() ? 'intraday' : 'close' });
    }
    function captureEquity(equity, date) {
        var n = num(equity);
        if (!n || n <= 0) return false;
        return captureValuation(date || today(), { equity: n, kind: _hooks.isRTH() ? 'intraday' : 'close' });
    }
    function captureQldValue(date) {
        var px = num(_hooks.qldPrice());
        var pos = _hooks.twsPositionFor('QLD');
        var v = null;
        if (pos && px) v = Math.abs(pos.qty) * px;
        else {
            var sh = qldSharesAt(date || today());
            if (sh !== null && px) v = sh * px;
        }
        if (v === null || !Number.isFinite(v)) return false;
        return captureValuation(date || today(), { qldValue: v });
    }
    // One-click "Save today's close" — marks + equity + QLD in one write.
    function saveTodayClose(equity, marks, qldValue) {
        return captureValuation(today(), {
            equity: num(equity), marks: marks || {}, qldValue: num(qldValue), kind: 'close'
        });
    }

    // ---------- TWS / journal hooks ----------
    // A broker fill becomes a ledger event. `kind` is decided by the caller
    // (which already classified the fill); execId dedupes replays.
    function onTwsFill(t, kind, qty, price, execKey, note) {
        if (!t || !KINDS.includes(kind)) return null;
        if (execKey && hasExecEvent(t, execKey)) return null;
        return appendEvent(t, { kind: kind, qty: qty, price: price, execId: execKey, note: note || 'TWS fill' });
    }
    function onTradeLogged(t) {
        if (!t) return;
        if (!Array.isArray(t.events) || !t.events.length) {
            t.events = [{
                id: uid(), kind: 'Entry', date: t.entryDate || today(),
                qty: num(t.totalQty) || num(t.shares) || 0, price: num(t.entryPrice) || 0,
                amount: 0, note: '', seq: 1
            }];
        }
    }
    function onTradeClosed(t, exitPrice, exitDate) {
        if (!t) return;
        // Exit qty = what events still hold — closedQty/totalQty are lifetime
        // totals (never decremented by partials) and would overstate the exit.
        var held = inventory(t, '9999-12-31');
        // If stored events already sum to flat, the broker path recorded it.
        if (held <= 1e-8 && tradeEvents(t).some(function (e) { return e.kind === 'Exit'; })) return;
        appendEvent(t, { kind: 'Exit', qty: Math.max(0, held), price: num(exitPrice) || 0, date: exitDate || today(), note: 'Manual close' });
    }
    function onImportedPosition(t) {
        if (!t) return;
        if (Array.isArray(t.events) && t.events.length) return;   // never clobber recorded history
        t.events = [{
            id: uid(), kind: 'Entry', date: t.entryDate || today(),
            qty: num(t.shares) || num(t.totalQty) || 0, price: num(t.entryPrice) || 0,
            amount: 0, note: 'Imported from TWS position', seq: 1
        }];
    }
    // Position-delta estimate (fill never seen): record a marked-estimate event.
    function onPositionDelta(t, kind, qty, estPrice, note) {
        if (!t || !qty) return null;
        return appendEvent(t, { kind: kind, qty: qty, price: num(estPrice) || num(t.entryPrice) || 0, note: note || 'TWS position delta (est)' });
    }
    // Convert a banked draft (position-delta estimate) into its confirmed record
    // in place — the event id and inventory deduction survive; only the fields
    // in `patch` are rewritten. Returns the event or null when not found.
    function amendEvent(t, eventId, patch) {
        if (!t || !eventId || !patch) return null;
        var e = (t.events || []).find(function (x) { return x.id === eventId; });
        if (!e) return null;
        if (patch.qty !== undefined) e.qty = num(patch.qty);
        if (patch.price !== undefined) e.price = num(patch.price);
        if (patch.amount !== undefined) e.amount = num(patch.amount);
        if (patch.kind !== undefined && KINDS.includes(patch.kind)) e.kind = patch.kind;
        if (patch.execId !== undefined) e.execId = String(patch.execId);
        if (patch.note !== undefined) e.note = String(patch.note);
        return e;
    }

    // ---------- cloud sync ----------
    var PROVIDERS = {
        none: { name: 'Off', fields: [] },
        appscript: { name: 'Google Apps Script', fields: ['url'], hint: 'Your own Google Drive. Deploy the script from SYNC.md, paste the web-app URL.' },
        jsonbin: { name: 'JSONBin.io', fields: ['binId', 'apiKey'], hint: 'Private bin. Create a bin, copy Bin ID + X-Master-Key.' },
        npoint: { name: 'npoint.io', fields: ['binId'], hint: 'Zero signup — create a bin and paste its ID. Public by URL.' },
        pantry: { name: 'Pantry', fields: ['binId', 'basket'], hint: 'Pantry ID + basket name. Note: deletes data after ~90 days inactive.' },
        custom: { name: 'Custom endpoint', fields: ['url'], hint: 'Any endpoint that accepts GET (read) and PUT (write) of the JSON payload.' }
    };
    function syncEndpoints(conf) {
        var c = conf || syncConfig();
        switch (c.provider) {
            case 'appscript': return { get: c.url, put: c.url, method: 'POST', plain: true };
            case 'jsonbin': return {
                get: 'https://api.jsonbin.io/v3/b/' + encodeURIComponent(c.binId) + '/latest',
                put: 'https://api.jsonbin.io/v3/b/' + encodeURIComponent(c.binId),
                method: 'PUT', headers: { 'X-Master-Key': c.apiKey, 'Content-Type': 'application/json' }, unwrap: 'record'
            };
            case 'npoint': return { get: 'https://api.npoint.io/' + encodeURIComponent(c.binId), put: 'https://api.npoint.io/' + encodeURIComponent(c.binId), method: 'POST', plain: true };
            case 'pantry': return {
                get: 'https://getpantry.cloud/apiv1/pantry/' + encodeURIComponent(c.binId) + '/basket/' + encodeURIComponent(c.basket),
                put: 'https://getpantry.cloud/apiv1/pantry/' + encodeURIComponent(c.binId) + '/basket/' + encodeURIComponent(c.basket),
                method: 'POST', headers: { 'Content-Type': 'application/json' }
            };
            case 'custom': return { get: c.url, put: c.url, method: 'PUT', headers: { 'Content-Type': 'application/json' } };
            default: return null;
        }
    }
    // fetch is injected at call time so this file stays eval-safe in tests.
    async function syncPull(fetchFn) {
        var conf = syncConfig();
        var ep = syncEndpoints(conf);
        if (!conf.enabled || !ep) return { ok: false, error: 'Sync is off.' };
        var res = await fetchFn(ep.get, { method: 'GET', headers: ep.headers || {} });
        if (!res.ok) throw new Error('Sync pull failed: HTTP ' + res.status);
        var data = await res.json();
        if (ep.unwrap && data && data[ep.unwrap] !== undefined) data = data[ep.unwrap];
        conf.lastPulled = Date.now();
        conf.remoteTime = num(data && data.syncedAt) || 0;
        saveSyncConfig(conf);
        return { ok: true, data: data };
    }
    // opts.cas (appscript only): savedAt stamp of the remote envelope this push
    // merged against — the script rejects when it drifted ({ok:false,conflict}).
    async function syncPush(fetchFn, payload, opts) {
        var conf = syncConfig();
        var ep = syncEndpoints(conf);
        if (!conf.enabled || !ep) return { ok: false, error: 'Sync is off.' };
        payload.syncedAt = Date.now();
        var body = (opts && opts.cas !== undefined) ? { cas: opts.cas, state: payload } : payload;
        var init = { method: ep.method || 'PUT', headers: ep.headers || {} };
        if (ep.plain) { init.headers = { 'Content-Type': 'text/plain;charset=utf-8' }; init.body = JSON.stringify(body); }
        else init.body = JSON.stringify(body);
        var res = await fetchFn(ep.put, init);
        if (!res.ok) throw new Error('Sync push failed: HTTP ' + res.status);
        // CAS responders answer with a JSON body — surface conflicts so the
        // caller can re-merge and retry instead of believing the write landed.
        var reply = null;
        if (opts && opts.cas !== undefined) {
            try { reply = await res.json(); } catch (e) { reply = null; }
            if (reply && reply.conflict) {
                conf.lastError = 'conflict — remote changed';
                saveSyncConfig(conf);
                return { ok: false, conflict: true, currentSavedAt: reply.currentSavedAt };
            }
        }
        conf.lastPushed = Date.now();
        conf.remoteTime = payload.syncedAt;
        conf.lastError = '';
        saveSyncConfig(conf);
        return { ok: true, syncedAt: payload.syncedAt };
    }

    // ---------- misc exports ----------
    function exportEventsCsv(csvCell) {
        var header = ['Ticker', 'Sleeve', 'Side', 'Event', 'Date', 'Quantity', 'Price', 'Amount', 'Note'];
        var rows = [header];
        journal().forEach(function (t) {
            tradeEvents(t).forEach(function (e) {
                rows.push([t.ticker, sleeveBucket(t), tradeSide(t), e.kind, e.date, e.qty, e.price, e.amount, e.note || '']);
            });
        });
        var escCell = csvCell || function (v) { var s = String(v == null ? '' : v); return /[,"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        return rows.map(function (r) { return r.map(escCell).join(','); }).join('\r\n');
    }
    function monthsWithData() {
        var set = {};
        journal().forEach(function (t) { if (t.entryDate) set[monthOf(t.entryDate)] = true; if (t.exitDate) set[monthOf(t.exitDate)] = true; });
        Object.keys(valuations()).forEach(function (d) { set[monthOf(d)] = true; });
        cashRecords().flows.concat(cashRecords().income).forEach(function (f) { set[monthOf(f.date)] = true; });
        Object.keys(snapshots()).forEach(function (m) { set[m] = true; });
        var cur = monthOf(today());
        if (cur) set[cur] = true;
        return Object.keys(set).sort().reverse();
    }

    return {
        SLEEVES: SLEEVES, CASH: CASH, KINDS: KINDS, KEYS: KEYS, PROVIDERS: PROVIDERS,
        init: init, uid: uid, today: today, isIsoDate: isIsoDate, num: num, monthOf: monthOf, monthBounds: monthBounds, addDays: addDays,
        config: config, saveConfig: saveConfig,
        valuations: valuations, saveValuations: saveValuations,
        cashRecords: cashRecords, saveCashRecords: saveCashRecords,
        qldTxns: qldTxns, saveQldTxns: saveQldTxns, recordQldTxn: recordQldTxn, qldSharesAt: qldSharesAt, qldValueOn: qldValueOn, qldPnl: qldPnl,
        snapshots: snapshots, saveSnapshots: saveSnapshots, snapshotList: snapshotList, allSnapshots: allSnapshots,
        auditLog: auditLog, saveAuditLog: saveAuditLog, auditPush: auditPush, captureTradeUndo: captureTradeUndo, captureStoreUndo: captureStoreUndo, undoLast: undoLast,
        flagStaleFrom: flagStaleFrom, requiresReason: requiresReason,
        sleeveBucket: sleeveBucket, tradeSide: tradeSide, tradeId: tradeId,
        tradeEvents: tradeEvents, ensureEvents: ensureEvents, appendEvent: appendEvent, hasExecEvent: hasExecEvent,
        validateTradeEvents: validateTradeEvents, inventory: inventory, cumPnl: cumPnl, markFor: markFor, markNear: markNear,
        realizedByMonth: realizedByMonth, realizedInMonth: realizedInMonth,
        flowsBetween: flowsBetween, incomeBetween: incomeBetween, equityAt: equityAt,
        pnlComponents: pnlComponents, performance: performance,
        buildMonthReport: buildMonthReport, reportTradeDetails: reportTradeDetails, statusLabel: statusLabel,
        reportHtml: reportHtml, reportHtmlDocument: reportHtmlDocument, publicFills: publicFills,
        canFinalize: canFinalize, finalizeMonth: finalizeMonth,
        captureValuation: captureValuation, captureMarksFromQuotes: captureMarksFromQuotes, captureEquity: captureEquity,
        captureQldValue: captureQldValue, saveTodayClose: saveTodayClose,
        onTwsFill: onTwsFill, onTradeLogged: onTradeLogged, onTradeClosed: onTradeClosed,
        onImportedPosition: onImportedPosition, onPositionDelta: onPositionDelta, amendEvent: amendEvent,
        intervalContribution: intervalContribution,
        syncConfig: syncConfig, saveSyncConfig: saveSyncConfig, syncEndpoints: syncEndpoints,
        syncPull: syncPull, syncPush: syncPush,
        exportEventsCsv: exportEventsCsv, monthsWithData: monthsWithData,
        fmtDate: fmtDate, pct: pct, esc: esc
    };
})();
if (typeof window !== 'undefined') window.Ledger = Ledger;
