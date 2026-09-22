// state-store.js — single-record state coordinator. Owns the one browser
// storage key (psc:state:v1), atomic commit semantics, portable-file flush
// scheduling, hydration gating and the per-record revision stamps that sync.js
// consumes. Pure logic — storage, portable IPC and clock are injected so tests
// can run it without a browser.
(function (root, factory) {
    var S = (typeof module !== 'undefined' && module.exports)
        ? require('./state-schema.js')
        : root.StateSchema;
    var api = factory(S);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.StateStore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function (S) {
    'use strict';

    var _storage = null;          // {getItem,setItem,removeItem}
    var _state = null;            // live envelope (internal full form)
    var _hydrated = false;
    var _writable = 'yes';        // 'yes' | 'readonly' | 'error'  (web-lock / corrupt source)
    var _status = { source: 'none', error: null, location: null, writable: true };
    var _deviceId = '';
    var _now = function () { return Date.now(); };
    var _subs = [];
    var _dirty = false;           // portable flush pending
    var _flushing = false;
    var _flushTimer = null;
    var _onFlush = null;          // async (payload) => {ok, location, error}
    var _onError = null;          // (msg) => void  — surfaced as toast upstream
    var _appVersion = '';
    var FLUSH_DEBOUNCE_MS = 500;

    function clone(v) { return S.clone(v); }
    function logWarn(msg) { try { if (typeof console !== 'undefined') console.warn(msg); } catch (e) {} }
    function emitError(msg) { if (_onError) { try { _onError(msg); } catch (e) {} } else logWarn(msg); }

    // ---------- diff -> record stamps ----------
    // Any committed mutation updates mergeMeta: changed record keys get a fresh
    // stamp, removed keys become tombstones. Derived automatically so every
    // mutation path (UI, fills, import, merge) keeps LWW metadata consistent.
    function retag(beforeData, afterData) {
        var before = S.recordIndex({ data: beforeData, mergeMeta: { versions: {}, tombstones: {} } });
        var after = S.recordIndex(_state);
        var mm = _state.mergeMeta;
        var stamp = null;
        var changed = [];
        function nextStamp() {
            if (!stamp) stamp = S.nextStamp(_state, _deviceId, _now());
            return stamp;
        }
        for (var rkey in after) {
            var a = after[rkey], b = before[rkey];
            if (a.deleted) continue;   // tombstone records already live in mm.tombstones
            if (!b || JSON.stringify(a.value) !== JSON.stringify(b.value)) {
                mm.versions[rkey] = nextStamp();
                delete mm.tombstones[rkey];
                changed.push(rkey);
            }
        }
        for (var rkey2 in before) {
            if (!after[rkey2] && !mm.tombstones[rkey2]) {
                mm.tombstones[rkey2] = nextStamp();
                delete mm.versions[rkey2];
                changed.push(rkey2);
            }
        }
        return changed;
    }

    // ---------- persistence ----------
    function persist() {
        var out = S.encode(_state, { purpose: 'local', now: _now() });
        var raw;
        try { raw = JSON.stringify(out); } catch (e) { return { ok: false, error: 'unserializable: ' + (e && e.message) }; }
        if (raw.length > S.MAX_STATE_BYTES) return { ok: false, error: 'state exceeds ' + S.MAX_STATE_BYTES + ' bytes' };
        try { _storage.setItem(S.STORAGE_KEY, raw); } catch (e) { return { ok: false, error: (e && e.message) || 'storage write failed' }; }
        return { ok: true };
    }
    function scheduleFlush() {
        if (!_onFlush) return;
        _dirty = true;
        if (_flushTimer) return;
        _flushTimer = setTimeout(function () { _flushTimer = null; flushPortable(); }, FLUSH_DEBOUNCE_MS);
    }
    async function flushPortable() {
        if (!_onFlush) return { ok: true, skipped: true };
        if (_flushing) { _dirty = true; return { ok: false, error: 'flush in progress', queued: true }; }
        _flushing = true;
        _dirty = false;          // commits during this flush re-set it
        var rev = _state.revision;
        try {
            var payload = S.encode(_state, { purpose: 'portable', now: _now() });
            var res = await _onFlush(payload);
            _flushing = false;
            if (res && res.ok) {
                _status.location = res.location || _status.location;
                if (_dirty) scheduleFlush();      // changed mid-flight: queue a follow-up
                return { ok: true, revision: rev, location: res.location };
            }
            _dirty = true;                          // stays dirty; next commit retries
            return { ok: false, revision: rev, error: (res && res.error) || 'portable write failed' };
        } catch (e) {
            _flushing = false; _dirty = true;
            return { ok: false, revision: rev, error: (e && e.message) || 'portable write failed' };
        }
    }

    function notify(info) {
        _subs.slice().forEach(function (fn) { try { fn(info); } catch (e) { logWarn('StateStore subscriber threw: ' + (e && e.message)); } });
    }

    // ---------- commit ----------
    // command: {type:'set',key,value} | {type:'remove',key} |
    //          {type:'batch',ops:[{op:'set'|'remove',key,value}]} |
    //          {type:'apply',data,mergeMeta}   (validated import/merge data)
    function commit(command, opts) {
        opts = opts || {};
        if (!_hydrated || !_state) return { ok: false, error: 'state not initialized' };
        if (_writable !== 'yes') return { ok: false, error: 'state is ' + _writable };
        var draft = clone(_state);
        draft.data = draft.data; // alias clarity
        var target = draft;
        var ops = [];
        if (command.type === 'set') ops = [{ op: 'set', key: command.key, value: command.value }];
        else if (command.type === 'remove') ops = [{ op: 'remove', key: command.key }];
        else if (command.type === 'batch') ops = command.ops || [];
        else if (command.type === 'apply') { /* handled below */ }
        else return { ok: false, error: 'unknown command type' };

        var beforeData = clone(_state.data);
        if (command.type === 'apply') {
            target.data = command.data;
            if (command.mergeMeta) target.mergeMeta = command.mergeMeta;
        } else {
            for (var i = 0; i < ops.length; i++) {
                var o = ops[i];
                var ok = o.op === 'set' ? S.setByKey(target, o.key, o.value) : S.removeByKey(target, o.key);
                if (!ok) return { ok: false, error: 'unwritable key: ' + o.key };
            }
        }
        // swap in draft, retag record revisions, bump revision, persist — all or nothing
        var prev = _state;
        _state = draft;
        var changedKeys;
        try { changedKeys = retag(beforeData, draft.data); } catch (e) { _state = prev; return { ok: false, error: 'retag failed: ' + (e && e.message) }; }
        _state.revision = prev.revision + 1;
        _state.savedAt = _now();
        _state.appVersion = _appVersion;
        var w = persist();
        if (!w.ok) { _state = prev; return { ok: false, error: w.error }; }
        scheduleFlush();
        notify({ revision: _state.revision, source: opts.source || 'ui', reason: opts.reason || '', changedKeys: changedKeys });
        return { ok: true, revision: _state.revision };
    }

    // ---------- public key adapter (safeStorage* delegates) ----------
    function get(key) {
        if (!_hydrated || !_state) return null;
        return S.getString(_state, key);
    }
    function set(key, value) {
        return commit({ type: 'set', key: key, value: value }, { source: 'ui' }).ok;
    }
    function remove(key) {
        return commit({ type: 'remove', key: key }, { source: 'ui' }).ok;
    }

    // ---------- hydrate / apply ----------
    // boot: bootEnvelope (Electron file payload, already decoded object) wins;
    // otherwise read the browser record; absent => fresh start (old data untouched).
    function init(opts) {
        opts = opts || {};
        _storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} });
        _now = opts.now || _now;
        _deviceId = opts.deviceId || '';
        _onFlush = opts.onFlush || null;
        _onError = opts.onError || null;
        _appVersion = opts.appVersion || '';
        _subs = [];

        var source = 'fresh', err = null, obj = null;
        if (opts.bootEnvelope && S.isObj(opts.bootEnvelope)) {
            var d = S.decode(opts.bootEnvelope, { purpose: 'portable' });
            if (d.ok) { obj = d.value; source = 'portable'; }
            else { err = 'portable state rejected: ' + d.error; source = 'corrupt-portable'; }
        } else {
            var raw = null;
            try { raw = _storage.getItem(S.STORAGE_KEY); } catch (e) { err = 'storage unreadable: ' + (e && e.message); }
            if (raw !== null && raw !== undefined) {
                var d2 = S.decode(raw, { purpose: 'local' });
                if (d2.ok) { obj = d2.value; source = 'local'; }
                else { err = 'stored state rejected: ' + d2.error; source = 'corrupt-local'; }
            }
        }
        if (obj) {
            _state = obj;
            _state.local = _state.local || S.defaultLocal();
            _state.cache = _state.cache || {};
            _writable = 'yes';
        } else {
            _state = S.createEmpty({ datasetId: opts.datasetId, appVersion: _appVersion, now: _now() });
            if (err) {
                // Corrupt/unsupported existing record: protect it — read-only session.
                _writable = 'error';
            } else {
                var w = persist();   // fresh install — write the initial record
                if (!w.ok) { _writable = 'error'; err = w.error; }
            }
        }
        _hydrated = true;
        _status = { source: source, error: err, writable: _writable === 'yes', location: null };
        if (err) emitError(err);
        // acquire exclusive write ownership when Web Locks exist (async, non-blocking)
        acquireOwnership(opts.locks !== undefined ? opts.locks : (typeof navigator !== 'undefined' ? navigator.locks : null));
        return _status;
    }

    // The previous writer released the lock (its tab closed). Re-read storage —
    // that tab may have committed newer state while this one sat read-only —
    // then promote this tab to writer. A corrupt/absent record keeps the current
    // in-memory state rather than wiping it.
    function promoteToWriter() {
        var raw = null;
        try { raw = _storage.getItem(S.STORAGE_KEY); } catch (e) {}
        if (raw !== null && raw !== undefined) {
            var d = S.decode(raw, { purpose: 'local' });
            if (d.ok) {
                _state = d.value;
                _state.local = _state.local || S.defaultLocal();
                _state.cache = _state.cache || {};
            }
        }
        _writable = 'yes';
        _status.writable = true;
        notify({ revision: _state.revision, source: 'ownership', promoted: true });
    }

    function acquireOwnership(locks) {
        if (!locks || typeof locks.request !== 'function') return;   // single-tab assumption documented
        var name = 'psc-state-write';
        try {
            locks.request(name, { ifAvailable: true }, function (lock) {
                if (lock !== null) return new Promise(function () {});   // held for session
                _writable = 'readonly';
                _status.writable = false;
                emitError('Another tab holds this app\'s data — this window is read-only.');
                notify({ revision: _state.revision, source: 'ownership', readonly: true });
                // Queue for the lock normally: when the holder releases it (tab
                // close), this tab promotes instead of staying read-only forever.
                try {
                    locks.request(name, function (lock2) {
                        if (!lock2) return;
                        promoteToWriter();
                        return new Promise(function () {});
                    }).catch(function () {});
                } catch (e) {}
                return;
            }).catch(function () {});
        } catch (e) {}
    }

    // Apply a decoded foreign snapshot (backup restore / portable hydrate /
    // sync merge). Destination-local sections are preserved; data+mergeMeta
    // are replaced atomically.
    function applySnapshot(decoded, opts) {
        opts = opts || {};
        if (!_hydrated || !_state) return { ok: false, error: 'state not initialized' };
        if (_writable !== 'yes') return { ok: false, error: 'state is ' + _writable };
        if (!decoded || !S.isObj(decoded.data)) return { ok: false, error: 'snapshot missing data' };
        var draft = clone(_state);
        draft.data = decoded.data;
        if (decoded.mergeMeta) draft.mergeMeta = decoded.mergeMeta;
        // adopt remote datasetId only when explicitly told (first sync adoption)
        if (decoded.datasetId && opts.adoptDataset) draft.datasetId = decoded.datasetId;
        if (decoded.local && opts.includeLocal) {
            var keepBridge = draft.local && draft.local.bridge;
            draft.local = decoded.local;
            if (keepBridge) draft.local.bridge = keepBridge;   // serving bridge stays authoritative
        }
        var prev = _state;
        _state = draft;
        var v = S.validate(_state);
        if (!v.ok) { _state = prev; return { ok: false, error: 'post-apply invalid: ' + v.errors[0] }; }
        _state.revision = prev.revision + 1;
        _state.savedAt = _now();
        _state.appVersion = _appVersion;
        var w = persist();
        if (!w.ok) { _state = prev; return { ok: false, error: w.error }; }
        scheduleFlush();
        notify({ revision: _state.revision, source: opts.source || 'apply', changedKeys: null });
        return { ok: true, revision: _state.revision };
    }

    // ---------- accessors ----------
    function snapshot() { return _state ? clone(_state) : null; }
    function raw() { return _state; }
    function revision() { return _state ? _state.revision : 0; }
    function datasetId() { return _state ? _state.datasetId : ''; }
    function status() { return { source: _status.source, error: _status.error, writable: _writable === 'yes', location: _status.location, hydrated: _hydrated, dirty: _dirty }; }
    function isWritable() { return _hydrated && _writable === 'yes'; }
    function subscribe(fn) { _subs.push(fn); return function () { _subs = _subs.filter(function (f) { return f !== fn; }); }; }
    function exportFor(purpose, now) { return S.encode(_state, { purpose: purpose, now: now || _now() }); }

    return {
        init: init,
        get: get, set: set, remove: remove,
        commit: commit, applySnapshot: applySnapshot,
        flushPortable: flushPortable,
        snapshot: snapshot, raw: raw, revision: revision, datasetId: datasetId,
        status: status, isWritable: isWritable,
        subscribe: subscribe, exportFor: exportFor,
        _test: { retag: retag, persist: persist }
    };
});
