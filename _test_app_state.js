// Tests for state-schema.js (codec/registry/merge) + state-store.js
// (hydration, atomic commit, portable flush, revision stamps).
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };
const S = require('./state-schema.js');
const Store = require('./state-store.js');
const Sync = require('./sync.js');

function mockStorage(seed) {
    const m = new Map(Object.entries(seed || {}));
    return {
        map: m,
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: k => { m.delete(k); },
        failNext: false
    };
}
function freshStore(storage, extra) {
    // re-init module state: the store is a singleton — tests use init() each time
    return Store.init(Object.assign({
        storage, appVersion: '4.0.0', deviceId: 'dev-test',
        now: () => 1700000000000, locks: null
    }, extra || {}));
}

async function main() {
 try {
    // ---------- 1. Schema: empty state validates ----------
    const empty = S.createEmpty({ datasetId: 'ds_test', appVersion: '4.0.0', now: 1700000000000 });
    const v0 = S.validate(empty);
    assert(v0.ok, 'fresh empty state validates: ' + (v0.errors || [])[0]);

    // ---------- 2. Key registry coverage ----------
    // every literal key the app writes must resolve
    ['riskValue', 'pbEtfUniverse', 'activeTradesLog', 'qldSleeve', 'ledgerConfig',
     'dailyValuations', 'cashRecords', 'qldLedgerTxns', 'reportSnapshots', 'journalAudit',
     'twsEnabled', 'twsBridgeUrl', 'twsBridgeToken', 'finnhub_key', 'twsSeenExecs',
     'syncConfig', 'earningsCalendarCache', 'journalSyncedAt', 'syncPending', 'globalMarketRegime',
     'settingsSectionsCollapsed', 'signalSyncMode', 'pbSignals', 'visibleCount',
     'signalSides', 'ticker_0', 'trigger_8', 'pg_lsv3_ticker_3', 'pg_pb_pbSignals',
     'pg_lsv3_riskValue', 'pg_pb_visibleCount',
     'autoEntryEnabled', 'autoEntryTime', 'autoEntryRun',
     'flexToken', 'flexQueryId', 'flexAutoSync', 'flexSyncTime', 'flexSyncState'].forEach(k => {
        assert(S.knownKey(k), 'registry knows key: ' + k);
    });
    assert(!S.knownKey('ticker_9'), 'ticker_9 out of range rejected');
    assert(!S.knownKey('pg_lsv3_bogus'), 'unknown prefixed key rejected');
    assert(!S.knownKey('evilKey'), 'arbitrary key rejected');
    assert(!S.knownKey('__proto__'), 'proto key rejected');

    // ---------- 3. String adapter round-trips ----------
    const st = S.createEmpty({ datasetId: 'ds_a', now: 1 });
    assert(S.setByKey(st, 'riskValue', '2.5'), 'set riskValue');
    assert(S.getString(st, 'riskValue') === '2.5', 'get riskValue');
    assert(S.setByKey(st, 'pbEtfUniverse', '["SPY","QQQ"]'), 'set json key');
    assert(S.getString(st, 'pbEtfUniverse') === '["SPY","QQQ"]', 'json round-trip');
    assert(S.setByKey(st, 'ticker_2', 'AAPL'), 'scanner ticker');
    assert(st.data.scannerStores.scanner.tickers[2] === 'AAPL', 'ticker lands in scanner store');
    assert(S.setByKey(st, 'pg_lsv3_trigger_4', '55.5'), 'prefixed trigger');
    assert(st.data.scannerStores.lsv3.triggers[4] === '55.5', 'trigger lands in lsv3 store');
    assert(S.setByKey(st, 'pg_pb_pbSignals', '[{"ticker":"X","tf":"weekly","cat":"nas_w","atrOverride":null}]'), 'pb signals');
    assert(S.getString(st, 'pg_pb_pbSignals').includes('"X"'), 'pb read-back');
    // unprefixed riskValue -> settings (shared-mode semantic), prefixed -> page store
    S.setByKey(st, 'riskValue', '1.5');
    S.setByKey(st, 'pg_lsv3_riskValue', '0.75');
    assert(st.data.settings.riskValue === '1.5', 'unprefixed riskValue -> settings');
    assert(st.data.scannerStores.lsv3.riskValue === 0.75, 'pg_lsv3_riskValue -> page store (typed number)');
    // malformed json write rejected without mutation
    assert(!S.setByKey(st, 'pbEtfUniverse', '{not json'), 'bad JSON rejected');
    assert(S.getString(st, 'pbEtfUniverse') === '["SPY","QQQ"]', 'rejected write left prior value');
    // remove restores defaults
    assert(S.removeByKey(st, 'visibleCount'), 'remove visibleCount');
    assert(st.data.scannerStores.scanner.visibleCount === 3, 'visibleCount resets to 3');

    // ---------- 4. Purpose filtering ----------
    S.setByKey(st, 'twsBridgeToken', 'SECRET-TOKEN');
    S.setByKey(st, 'finnhub_key', 'API-SECRET');
    S.setByKey(st, 'twsEnabled', 'true');
    S.setByKey(st, 'activeTradesLog', JSON.stringify([{ id: 't1', ticker: 'AAPL', side: 'LONG', status: 'ACTIVE', shares: 10, entryPrice: 5, entryDate: '2026-01-05', events: [] }]));
    const backup = S.encode(st, { purpose: 'backup' });
    assert(!backup.local, 'backup excludes local section');
    assert(JSON.stringify(backup).indexOf('SECRET-TOKEN') < 0, 'no bridge token in backup');
    assert(JSON.stringify(backup).indexOf('API-SECRET') < 0, 'no api key in backup');
    assert(backup.data.trades.length === 1, 'backup carries trades');
    const portable = S.encode(st, { purpose: 'portable' });
    assert(portable.local && portable.local.tws.twsEnabled === 'true', 'portable keeps tws prefs');
    assert(portable.data.settings.finnhub_key === 'API-SECRET', 'portable keeps api keys (in settings)');
    assert(!portable.local.bridge || !portable.local.bridge.twsBridgeToken, 'portable strips bridge token');
    // api keys are ordinary synced settings: sync payload carries them, backup strips them
    const syncEnv = S.encode(st, { purpose: 'sync' });
    assert(syncEnv.data.settings.finnhub_key === 'API-SECRET', 'sync payload carries api key');
    const stRecs = S.recordIndex(st);
    assert(stRecs['setting/finnhub_key'] && stRecs['setting/finnhub_key'].value === 'API-SECRET', 'api key is a syncable setting record');
    // legacy envelopes holding local.apiKeys migrate into settings on decode
    const legacy = S.encode(st, { purpose: 'local' });
    legacy.local.apiKeys = { twelvedata_key: 'OLD-TD', finnhub_key: 'STALE-LOCAL' };
    const decL = S.decode(JSON.stringify(legacy));
    assert(decL.ok && decL.value.data.settings.twelvedata_key === 'OLD-TD', 'legacy apiKey hoisted to settings');
    assert(decL.value.data.settings.finnhub_key === 'API-SECRET', 'existing setting beats stale local copy');
    assert(decL.value.local.apiKeys && Object.keys(decL.value.local.apiKeys).length === 0, 'local.apiKeys emptied after migration');
    // scheduled auto-entry is machine-local: portable keeps it, backup/sync drop it
    S.setByKey(st, 'autoEntryEnabled', 'true');
    S.setByKey(st, 'autoEntryTime', '15:58');
    S.setByKey(st, 'autoEntryRun', '{"date":"2026-01-05","done":true,"results":{}}');
    const backup2 = S.encode(st, { purpose: 'backup' });
    assert(JSON.stringify(backup2).indexOf('autoEntry') < 0, 'backup excludes auto-entry keys');
    const portable2 = S.encode(st, { purpose: 'portable' });
    assert(portable2.local.tws.autoEntryEnabled === 'true' && portable2.local.tws.autoEntryTime === '15:58', 'portable keeps auto-entry settings');
    assert(portable2.local.autoEntryRun && portable2.local.autoEntryRun.done === true, 'portable keeps run record');
    const local = S.encode(st, { purpose: 'local' });
    assert(local.local.bridge.twsBridgeToken === 'SECRET-TOKEN', 'local keeps bridge token');

    // ---------- 5. Decode strictness ----------
    assert(!S.decode('{"foo":1}').ok, 'unversioned payload rejected');
    assert(!S.decode(JSON.stringify({ format: 'nope' })).ok, 'wrong format rejected');
    const wrongVer = S.encode(st, { purpose: 'backup' }); wrongVer.schemaVersion = 99;
    assert(!S.decode(wrongVer).ok, 'future schema rejected');
    const badTrade = S.encode(st, { purpose: 'backup' });
    badTrade.data.trades[0].events = 'not-an-array';
    assert(!S.decode(badTrade).ok, 'malformed nested events rejected');
    const dupTrade = S.encode(st, { purpose: 'backup' });
    dupTrade.data.trades.push({ id: 't1', ticker: 'MSFT' });
    assert(!S.decode(dupTrade).ok, 'duplicate trade id rejected');
    // ledgerConfig null BEFORE setup must round-trip (baseline bug P01)
    const preSetup = S.createEmpty({ datasetId: 'ds_b' });
    preSetup.data.ledger.config = null;
    preSetup.data.qldAllocation = null;
    const pre = S.encode(preSetup, { purpose: 'backup' });
    const preDec = S.decode(pre);
    assert(preDec.ok, 'pre-setup backup (null ledger config) decodes: ' + preDec.error);

    // ---------- 6. Store: hydrate, commit, flush ----------
    const mem = mockStorage();
    let status = freshStore(mem);
    assert(status.source === 'fresh' && status.writable, 'fresh boot writable');
    assert(mem.map.has(S.STORAGE_KEY), 'initial record persisted to psc:state:v1');
    assert(Store.get('riskValue') === null, 'missing setting reads null');
    assert(Store.set('riskValue', '2'), 'set via store');
    assert(Store.get('riskValue') === '2', 'read back');
    // unknown keys are refused
    assert(Store.set('arbitraryEvil', 'x') === false, 'unknown key set refused');
    // batch commit is atomic
    const r = Store.commit({ type: 'batch', ops: [
        { op: 'set', key: 'riskValue', value: '3' },
        { op: 'set', key: 'slippageValue', value: '0.5' }
    ]});
    assert(r.ok, 'batch commit ok');
    // revision stamps exist for changed records
    const env = Store.snapshot();
    assert(env.mergeMeta.versions['setting/riskValue'], 'setting stamped');
    assert(env.mergeMeta.clock.wallMs >= 1700000000000, 'clock advanced');

    // trades diff → record stamps + tombstones
    Store.set('activeTradesLog', JSON.stringify([
        { id: 'ta', ticker: 'AAPL', side: 'LONG', status: 'ACTIVE', shares: 10, entryPrice: 5, entryDate: '2026-01-05', events: [{ id: 'e1', kind: 'Entry', date: '2026-01-05', qty: 10, price: 5, seq: 1 }] }
    ]));
    let env2 = Store.snapshot();
    assert(env2.mergeMeta.versions['trade/ta'], 'trade record stamped');
    assert(env2.mergeMeta.versions['event/ta/e1'], 'event record stamped');
    Store.set('activeTradesLog', JSON.stringify([]));
    env2 = Store.snapshot();
    assert(env2.mergeMeta.tombstones['trade/ta'], 'removed trade tombstoned');
    assert(env2.mergeMeta.tombstones['event/ta/e1'], 'its events tombstoned');
    // Tombstones must survive LATER commits — retag previously re-stamped the
    // dead record as a version, silently reviving deletes on the next merge.
    Store.set('riskValue', '11');
    env2 = Store.snapshot();
    assert(env2.mergeMeta.tombstones['trade/ta'], 'tombstone survives a later commit');
    assert(env2.mergeMeta.tombstones['event/ta/e1'], 'event tombstone survives a later commit');
    assert(!env2.mergeMeta.versions['trade/ta'], 'no phantom version on tombstoned record');

    // failed storage write rolls state back
    const memFail = mockStorage();
    freshStore(memFail);
    Store.set('riskValue', '9');
    memFail.setItem = () => { throw new Error('quota'); };
    const before = Store.get('riskValue');
    assert(Store.set('riskValue', '7') === false, 'failed set returns false');
    assert(Store.get('riskValue') === before, 'failed commit left prior value');

    // corrupt stored record -> read-only, file protected
    const memCorrupt = mockStorage({ [S.STORAGE_KEY]: '{"format":"positioncalc-state","schemaVersion":1,"data":"bad"}' });
    status = freshStore(memCorrupt);
    assert(status.writable === false, 'corrupt record -> read-only');
    assert(memCorrupt.map.get(S.STORAGE_KEY).includes('"bad"'), 'corrupt record NOT overwritten');

    // old-format keys are never read
    const memOld = mockStorage({ activeTradesLog: '[{"id":1,"ticker":"OLD"}]', riskValue: '99' });
    status = freshStore(memOld);
    assert(status.source === 'fresh', 'old keys ignored -> fresh');
    assert(Store.get('riskValue') === null, 'old riskValue not imported');
    assert(Store.get('activeTradesLog') === null || Store.get('activeTradesLog') === '[]', 'old trades not imported');

    // portable boot envelope path
    const memE = mockStorage();
    const bootPayload = S.encode(st, { purpose: 'portable' });
    status = freshStore(memE, { bootEnvelope: bootPayload });
    assert(status.source === 'portable', 'boot envelope hydrates');
    assert(Store.get('riskValue') === '1.5', 'boot envelope values live');
    assert(Store.get('twsBridgeToken') === null, 'bridge token absent from portable file');

    // portable flush transport
    const memF = mockStorage();
    let flushed = null;
    freshStore(memF, { onFlush: async (p) => { flushed = p; return { ok: true, location: 'portable' }; } });
    Store.set('riskValue', '4');
    const fr = await Store.flushPortable();
    assert(fr.ok && flushed && flushed.purpose === 'portable', 'portable flush emits portable payload');
    assert(flushed.local && !flushed.local.bridge.twsBridgeToken, 'flush strips bridge token');

    // ---------- 7. Record index / merge primitives ----------
    const a = S.createEmpty({ datasetId: 'ds_x', now: 100 });
    S.setByKey(a, 'activeTradesLog', JSON.stringify([{ id: 't9', ticker: 'MSFT', side: 'LONG', status: 'ACTIVE', shares: 5, entryPrice: 10, entryDate: '2026-02-02', events: [{ id: 'ev1', kind: 'Entry', date: '2026-02-02', qty: 5, price: 10, seq: 1 }] }]));
    S.setByKey(a, 'dailyValuations', JSON.stringify({ '2026-02-02': { equity: 100000 } }));
    const recs = S.recordIndex(a);
    assert(recs['trade/t9'] && recs['event/t9/ev1'], 'recordIndex extracts trade+event');
    assert(recs['valuation/2026-02-02'], 'valuation record');
    assert(recs['ledger/config'], 'ledger config record');

    // merge: independent records survive, same-record LWW
    const b = S.createEmpty({ datasetId: 'ds_x', now: 200 });
    S.setByKey(b, 'riskValue', '7');
    b.mergeMeta.versions['setting/riskValue'] = { wallMs: 200, logical: 0, deviceId: 'B' };
    a.mergeMeta.versions['setting/riskValue'] = { wallMs: 100, logical: 0, deviceId: 'A' };
    S.setByKey(b, 'customStrategies', JSON.stringify([{ id: 'cs1', name: 'Mine' }]));
    const merged = S.mergeRecords(S.recordIndex(a), S.recordIndex(b), b.mergeMeta);
    assert(merged.records['strategy/cs1'], 'independent remote record survives');
    assert(merged.records['setting/riskValue'].value === '7', 'newer remote setting wins');
    assert(merged.records['trade/t9'], 'local-only record survives');
    const proj = S.projectRecords(merged.records);
    assert(proj.trades.length === 1 && proj.trades[0].events.length === 1, 'projection rebuilds trade+events');
    assert(proj.settings.riskValue === '7', 'projection carries winning setting');

    // tombstone merge: remote delete wins over older local
    const c = S.createEmpty({ datasetId: 'ds_x', now: 300 });
    S.setByKey(c, 'activeTradesLog', '[]');
    c.mergeMeta.tombstones['trade/t9'] = { wallMs: 300, logical: 0, deviceId: 'C' };
    const merged2 = S.mergeRecords(S.recordIndex(a), S.recordIndex(c), c.mergeMeta);
    assert(!merged2.records['trade/t9'], 'remote tombstone deletes local trade');
    assert(merged2.tombstones['trade/t9'], 'tombstone retained in merged meta');

    // ---------- 8. SyncEngine.mergeEnvelopes ----------
    // Local has a pending QLD order (machine-local intent — never synced) and an
    // in-flight fill bookkeeping field; remote pushed a NEWER qldAlloc without
    // them. The merge must keep remote's data but restore local intent fields.
    const loc = S.createEmpty({ datasetId: 'ds_l', now: 500 });
    S.setByKey(loc, 'qldSleeve', JSON.stringify({
        inPos: true, shares: 10, entryPrice: 100, entryDate: '2026-01-02', cashValue: 500,
        pending: { type: 'EXIT' }, pendingOrder: { key: 'QLD', placedAt: 1 }
    }));
    loc.mergeMeta.versions['qldAlloc'] = { wallMs: 500, logical: 0, deviceId: 'L' };
    const remote = S.createEmpty({ datasetId: 'ds_l', now: 600 });
    remote.data.qldAllocation = { inPos: true, shares: 12, entryPrice: 101, entryDate: '2026-01-02', cashValue: 300 }; // stripForSync'd — no intent
    remote.mergeMeta.versions['qldAlloc'] = { wallMs: 600, logical: 0, deviceId: 'R' };
    const me = Sync.mergeEnvelopes(loc, remote);
    assert(me.ok, 'mergeEnvelopes ok');
    assert(me.data.qldAllocation.shares === 12, 'newer remote qldAlloc wins');
    assert(me.data.qldAllocation.pending && me.data.qldAllocation.pending.type === 'EXIT', 'local pending intent restored');
    assert(me.data.qldAllocation.pendingOrder && me.data.qldAllocation.pendingOrder.key === 'QLD', 'local pendingOrder restored');
    assert(me.mergeMeta.clock.wallMs >= 600, 'merged clock above both sides');
    assert(me.changed === true, 'merge reports change');

    // orphan cleanup: remote tombstoned the trade — its local events must go too
    const local2 = S.createEmpty({ datasetId: 'ds_l2', now: 500 });
    S.setByKey(local2, 'activeTradesLog', JSON.stringify([{ id: 'tx', ticker: 'AAPL', side: 'LONG', status: 'ACTIVE', shares: 1, entryPrice: 1, entryDate: '2026-01-02', events: [{ id: 'e9', kind: 'Entry', date: '2026-01-02', qty: 1, price: 1, seq: 1 }] }]));
    const remote2 = S.createEmpty({ datasetId: 'ds_l2', now: 700 });
    remote2.mergeMeta.tombstones['trade/tx'] = { wallMs: 700, logical: 0, deviceId: 'R' };
    const me2 = Sync.mergeEnvelopes(local2, remote2);
    assert(me2.ok && me2.data.trades.length === 0, 'tombstoned trade projects empty');
    assert(me2.mergeMeta.tombstones['event/tx/e9'], 'orphan event tombstoned with its trade');

    // identical envelopes → unchanged, nothing behind
    const me3 = Sync.mergeEnvelopes(local2, local2);
    assert(me3.ok && me3.changed === false && me3.remoteBehind === false, 'identical states merge clean');

    // remoteBehind: a record the remote lacks or holds older → caller pushes back
    S.setByKey(loc, 'riskValue', '9');
    loc.mergeMeta.versions['setting/riskValue'] = { wallMs: 700, logical: 0, deviceId: 'L' };
    const me4 = Sync.mergeEnvelopes(loc, remote);
    assert(me4.remoteBehind === true, 'remote missing local records → remoteBehind');
    assert(me4.data.settings.riskValue === '9', 'newer local setting wins in merge');

    // end-to-end through the store: apply merged snapshot then validate
    const memM = mockStorage();
    freshStore(memM);
    Store.set('riskValue', '5');
    const remoteEnv = S.encode(remote, { purpose: 'sync' });
    const mE = Sync.mergeEnvelopes(Store.raw(), remoteEnv);
    assert(mE.ok, 'store-level merge ok');
    const ap = Store.applySnapshot({ data: mE.data, mergeMeta: mE.mergeMeta }, { source: 'sync' });
    assert(ap.ok, 'merged snapshot applies: ' + ap.error);
    assert(Store.get('qldSleeve').includes('"shares":12'), 'remote qldAlloc landed in store');
    assert(Store.get('riskValue') === '5', 'local-only record kept');

    // ---------- 9. Commit notifications carry changedKeys ----------
    // The app's dirty-outbox subscriber relies on this contract: syncable-record
    // commits list their rkeys; local/cache-only commits report an empty list.
    let lastInfo = null;
    const unsub = Store.subscribe(i => { lastInfo = i; });
    Store.set('slippageValue', '0.7');
    assert(lastInfo && Array.isArray(lastInfo.changedKeys) && lastInfo.changedKeys.indexOf('setting/slippageValue') >= 0,
        'syncable commit reports its record key');
    Store.set('twsEnabled', 'false');   // local section — never syncable
    assert(lastInfo && lastInfo.changedKeys && lastInfo.changedKeys.length === 0,
        'local-only commit reports empty changedKeys');
    unsub();

    // ---------- 10. Stamp validation / clock clamp / intent-on-tombstone ----------
    // Remote decode rejects far-future stamps; local decode tolerates them (a
    // backward clock correction must not brick boot).
    const poison = S.createEmpty({ datasetId: 'ds_p', now: 100 });
    poison.mergeMeta.versions['setting/riskValue'] = { wallMs: 9e15, logical: 0, deviceId: 'E' };
    const encP = S.encode(poison, { purpose: 'sync' });
    assert(!S.decode(encP, { purpose: 'sync', remote: true }).ok, 'remote decode rejects far-future stamp');
    assert(S.decode(encP, { purpose: 'local' }).ok, 'local decode tolerates skewed stamp (no boot-brick)');
    // malformed stamp shapes rejected everywhere
    const bad = S.createEmpty({ datasetId: 'ds_b2', now: 100 });
    bad.mergeMeta.tombstones['trade/x'] = { wallMs: 'soon' };
    assert(!S.decode(S.encode(bad, { purpose: 'local' }), { purpose: 'local' }).ok, 'non-numeric wallMs rejected even locally');

    // mergeEnvelopes clamps the adopted clock — a skewed remote cannot inflate us
    const locC = S.createEmpty({ datasetId: 'ds_c', now: 500 });
    const remC = S.createEmpty({ datasetId: 'ds_c', now: 800 });
    remC.mergeMeta.clock = { wallMs: 9e15, logical: 0 };
    const meC = Sync.mergeEnvelopes(locC, remC);
    assert(meC.ok && meC.mergeMeta.clock.wallMs <= Date.now() + 24 * 3600 * 1000, 'merged clock clamped near now');
    assert(meC.mergeMeta.clock.wallMs >= Date.now(), 'merged clock not dragged below now');

    // remote tombstone of qldAlloc + local intent → intent preserved on fresh object
    const locT = S.createEmpty({ datasetId: 'ds_t', now: 500 });
    S.setByKey(locT, 'qldSleeve', JSON.stringify({ inPos: true, shares: 10, pending: { type: 'EXIT' }, pendingOrder: { key: 'QLD' } }));
    locT.mergeMeta.versions['qldAlloc'] = { wallMs: 500, logical: 0, deviceId: 'L' };
    const remT = S.createEmpty({ datasetId: 'ds_t', now: 700 });
    remT.mergeMeta.tombstones['qldAlloc'] = { wallMs: 700, logical: 0, deviceId: 'R' };
    const meT = Sync.mergeEnvelopes(locT, remT);
    assert(meT.ok && meT.data.qldAllocation, 'tombstoned qldAlloc + local intent → record survives locally');
    assert(meT.data.qldAllocation.pending && meT.data.qldAllocation.pending.type === 'EXIT', 'pending intent preserved on tombstoned record');
    assert(meT.data.qldAllocation.pendingOrder && meT.data.qldAllocation.pendingOrder.key === 'QLD', 'pendingOrder preserved on tombstoned record');
    // no intent → tombstone stays deleted (no pointless resurrection)
    const locT2 = S.createEmpty({ datasetId: 'ds_t2', now: 500 });
    S.setByKey(locT2, 'qldSleeve', JSON.stringify({ inPos: true, shares: 10 }));
    locT2.mergeMeta.versions['qldAlloc'] = { wallMs: 500, logical: 0, deviceId: 'L' };
    const meT2 = Sync.mergeEnvelopes(locT2, remT);
    assert(meT2.ok && meT2.data.qldAllocation === null, 'no intent → remote tombstone stands');

    // projectRecords accepts unknown scanner pages (forward-compat)
    const proj2 = S.projectRecords({ 'scanner/newpage': { id: 'newpage', kind: 'scanner', value: { tickers: ['X'], custom: 1 }, stamp: null } });
    assert(proj2.scannerStores.newpage && proj2.scannerStores.newpage.custom === 1, 'unknown scanner page survives projection');

    // unversioned records emit no null versions entries (strict validate relies on it)
    const bare = S.createEmpty({ datasetId: 'ds_b', now: 100 });
    S.setByKey(bare, 'riskValue', '3');
    const bareM = S.mergeRecords(S.recordIndex(bare), S.recordIndex(S.createEmpty({ datasetId: 'ds_b' })), {});
    assert(!('setting/riskValue' in bareM.versions), 'unversioned record emits no null versions entry');
    assert(bareM.records['setting/riskValue'], 'unversioned record still merges');

    // Web Lock promotion: denied ifAvailable → read-only; queued grant → promoted
    const lockQ = [];
    const mockLocks = {
        request: (name, optsOrCb, maybeCb) => {
            const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
            const ifAvail = !!(optsOrCb && optsOrCb.ifAvailable);
            if (ifAvail) { cb(null); return Promise.resolve(); }
            lockQ.push(cb); return Promise.resolve();
        }
    };
    const memL = mockStorage();
    freshStore(memL, { locks: mockLocks });
    assert(Store.status().writable === false, 'denied ifAvailable → read-only');
    assert(lockQ.length === 1, 'queued a real lock request for promotion');
    // the "other tab" writes newer state while we sat read-only
    const winner = S.createEmpty({ datasetId: 'ds_l2', now: 900 });
    S.setByKey(winner, 'riskValue', '42');
    memL.setItem(S.STORAGE_KEY, JSON.stringify(S.encode(winner, { purpose: 'local' })));
    lockQ.shift()({ name: 'psc-state-write' });   // holder released → our queued request grants
    assert(Store.isWritable(), 'lock grant promotes read-only tab to writer');
    assert(Store.get('riskValue') === '42', 'promotion re-reads storage (adopts other tab writes)');

    console.log('app-state schema+store tests passed!');
 } catch (e) {
    console.error('app-state test failed:', e);
    process.exit(1);
 }
}
main();
