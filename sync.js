// sync.js — record-level merge engine for cloud sync. Pure logic (DOM-free,
// eval-safe like ledger.js): the app injects fetch + the state store. Per-record
// last-change-wins comes from state-schema.js primitives (recordIndex /
// mergeRecords / projectRecords); this module adds orphan cleanup, intent-field
// restoration and the merged envelope the caller pushes back.
(function (root, factory) {
    var S = (typeof module !== 'undefined' && module.exports)
        ? require('./state-schema.js')
        : root.StateSchema;
    var api = factory(S);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.SyncEngine = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function (S) {
    'use strict';

    function clone(v) { return S.clone(v); }

    // Machine-local intent fields must survive a merge: the remote payload was
    // stripped of them, so a remotely-newer record would otherwise blank a
    // pending QLD order or in-flight fill bookkeeping on this device.
    function restoreIntentFields(mergedData, localData) {
        var strip = S.SYNC_STRIP || { qld: ['pending', 'pendingOrder'], trade: ['_entryCredits', '_exitCredits', '_estExitFills', '_posQty', 'fillSource'] };
        if (localData && localData.qldAllocation) {
            var lq = localData.qldAllocation;
            // Remote tombstoned the whole qldAlloc record: merged is null. Intent is
            // machine-local state — preserve it on a fresh object so an in-flight
            // pending order on THIS device is not blanked by the merge. (Pushed
            // envelopes strip intent, so the remote only ever sees an empty record.)
            var hasIntent = strip.qld.some(function (f) { return lq[f] !== undefined && lq[f] !== null; });
            if (mergedData.qldAllocation || hasIntent) {
                if (!mergedData.qldAllocation) mergedData.qldAllocation = {};
                strip.qld.forEach(function (f) {
                    if (lq[f] !== undefined) mergedData.qldAllocation[f] = clone(lq[f]);
                });
            }
        }
        var byId = {};
        ((localData && localData.trades) || []).forEach(function (t) { if (t && t.id !== undefined) byId[String(t.id)] = t; });
        (mergedData.trades || []).forEach(function (t) {
            var lt = byId[String(t && t.id)];
            if (!lt) return;
            strip.trade.forEach(function (f) { if (lt[f] !== undefined) t[f] = clone(lt[f]); });
        });
        return mergedData;
    }

    // A tombstoned trade must take its events with it — otherwise event records
    // resurrect as orphans (and projectRecords silently drops them anyway).
    function tombstoneOrphanEvents(merged) {
        for (var rkey in merged.records) {
            if (rkey.indexOf('event/') !== 0) continue;
            var tid = rkey.split('/')[1];
            var tt = merged.tombstones['trade/' + tid];
            if (tt) {
                delete merged.records[rkey];
                delete merged.versions[rkey];
                if (!merged.tombstones[rkey] || S.compareStamps(merged.tombstones[rkey], tt) < 0) merged.tombstones[rkey] = tt;
            }
        }
        return merged;
    }

    // Merge a decoded remote envelope into the live local state.
    // Returns {ok, data, mergeMeta, changed, remoteBehind, conflicts} — caller
    // applies via StateStore.applySnapshot({data, mergeMeta}) and pushes the
    // merged envelope back when remoteBehind is true (remote still lacks our
    // newer records — pushing converges replace-only providers).
    function mergeEnvelopes(localState, remoteEnv) {
        if (!localState || !S.isObj(localState.data)) return { ok: false, error: 'local state missing' };
        if (!remoteEnv || !S.isObj(remoteEnv.data)) return { ok: false, error: 'remote payload missing data' };
        var localRecs = S.recordIndex(localState);
        var remoteRecs = S.recordIndex(remoteEnv);
        var merged = tombstoneOrphanEvents(S.mergeRecords(localRecs, remoteRecs, remoteEnv.mergeMeta));
        var data = restoreIntentFields(S.projectRecords(merged.records), localState.data);

        // merged clock must sit above every wallMs either side has issued so the
        // next local stamp is strictly newer than anything the remote has seen.
        var lc = (localState.mergeMeta && localState.mergeMeta.clock) || { wallMs: 0, logical: 0 };
        var rc = (remoteEnv.mergeMeta && remoteEnv.mergeMeta.clock) || { wallMs: 0, logical: 0 };
        var wall = Math.max(lc.wallMs || 0, rc.wallMs || 0);
        for (var k in merged.versions) { var s = merged.versions[k]; if (s && (s.wallMs || 0) > wall) wall = s.wallMs; }
        for (var t in merged.tombstones) { var s2 = merged.tombstones[t]; if (s2 && (s2.wallMs || 0) > wall) wall = s2.wallMs; }
        // Clamp the adopted clock: a far-future stamp (peer's skewed clock) must not
        // drag this device's clock forward forever — stamps are validated on inbound
        // decode, but the clock still inherits their max defensively.
        var wallCap = Date.now() + 24 * 3600 * 1000;
        if (wall > wallCap) wall = wallCap;
        var mergeMeta = { clock: { wallMs: wall, logical: 0 }, versions: merged.versions, tombstones: merged.tombstones };

        // changed: merged outcome differs from local anywhere
        var changed = false, remoteBehind = false;
        for (var rk in merged.records) {
            var l = localRecs[rk], m = merged.records[rk];
            if (!l || S.compareStamps(l.stamp, m.stamp) !== 0 || JSON.stringify(l.value) !== JSON.stringify(m.value)) changed = true;
            var r = remoteRecs[rk];
            if (!r || S.compareStamps(r.stamp, m.stamp) !== 0) remoteBehind = true;
        }
        for (var dk in merged.tombstones) {
            if (!localRecs[dk] || !localRecs[dk].deleted) changed = true;
            if (!remoteRecs[dk] || !remoteRecs[dk].deleted) remoteBehind = true;
        }
        return { ok: true, data: data, mergeMeta: mergeMeta, changed: changed, remoteBehind: remoteBehind, conflicts: merged.conflicts };
    }

    return { mergeEnvelopes: mergeEnvelopes, restoreIntentFields: restoreIntentFields };
});
