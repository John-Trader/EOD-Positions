const fs = require('fs');
const h = fs.readFileSync('C:/Users/levif/Desktop/End-of-day/index.html', 'utf8');

const start = h.indexOf('<script>');
const end = h.lastIndexOf('</script>');
const code = h.slice(start + 8, end);

let fakeNow = Date.parse('2026-09-01T18:00:00Z'); // 14:00 ET, RTH
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(fakeNow); else super(...a); }
  static now() { return fakeNow; }
}

const storage = {};
const elements = {};
let createdCount = 0;
function mockElement(id) {
  if (!elements[id]) {
    elements[id] = {
      id,
      innerText: '',
      innerHTML: '',
      value: id === 'apiProvider' ? 'finnhub' : (id === 'riskValue' ? '500' : ''),
      checked: false,
      disabled: false,
      className: '',
      classList: {
        add: (...c) => { elements[id].className += ' ' + c.join(' '); },
        remove: (...c) => { c.forEach(cls => elements[id].className = elements[id].className.replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim()); },
        contains: (c) => elements[id].className.includes(c)
      },
      style: {},
      children: [],
      querySelectorAll: () => [],
      querySelector: () => null,
      appendChild: (ch) => { if (ch) elements[id].children.push(ch); },
      removeChild: (ch) => { elements[id].children = elements[id].children.filter(x => x !== ch); },
      remove: () => { delete elements[id]; },
      addEventListener: () => {},
      setAttribute: (k, v) => { elements[id][k] = v; },
      getAttribute: (k) => elements[id][k],
      click: () => {}
    };
  }
  return elements[id];
}

const document = {
  getElementById: (id) => mockElement(id),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: (tag) => mockElement('elem_' + (createdCount++)),
  addEventListener: () => {},
  body: mockElement('body')
};

const localStorage = {
  getItem: (k) => storage[k] ?? null,
  setItem: (k, v) => { storage[k] = v; },
  removeItem: (k) => { delete storage[k]; }
};

const window = { speechSynthesis: { speak: () => {}, cancel: () => {} }, addEventListener: () => {} };
const navigator = { clipboard: { writeText: () => Promise.resolve() } };

const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(url);
  if (url.includes('finnhub.io')) {
    return {
      status: 200,
      ok: true,
      json: async () => ({ c: 10.4, h: 11.2, l: 9, pc: 8, t: fakeNow / 1000, b: 10.3, a: 10.5 })
    };
  }
  if (url.includes('api.tiingo.com')) {
    return {
      status: 200,
      ok: true,
      json: async () => { throw new Error('unexpected tiingo call in test'); }
    };
  }
  return { status: 200, ok: true, json: async () => ({ data: [] }) };
};

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = WebSocket.CONNECTING;
    this.sent = [];
    this.closeCalled = 0;
    this.closed = false;
  }
  send(msg) { this.sent.push(msg); }
  close() {
    this.closeCalled++;
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
  }
}
MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;
globalThis.WebSocket = MockWebSocket;

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT FAIL: ' + msg); };

(async () => {
  try {
    const sandbox = { elements, document, localStorage, window, navigator, console, setTimeout, clearTimeout, setInterval, clearInterval, parseFloat, parseInt, Number, Array, Math, Date: FakeDate, String, Blob: class { constructor(p, o) { this.parts = p; this.opts = o || {}; } }, URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} } };
    const fn = new Function(...Object.keys(sandbox), code + '\nreturn { saveEnhancedLiveSetting, updateEnhancedUI, updateTopStatus, get enhancedLiveMode() { return enhancedLiveMode; }, set enhancedLiveMode(v) { enhancedLiveMode = v; }, get liveUpdateEnabled() { return liveUpdateEnabled; }, set liveUpdateEnabled(v) { liveUpdateEnabled = v; }, activeSockets, connectionTimeoutByProvider, reconnectTimeoutByProvider, reconnectAttemptsByProvider, disconnectWebSocket, resyncBaselines, realtimeQuotes, get realtimeTasks() { return realtimeTasks; }, set realtimeTasks(v) { realtimeTasks = v; }, get streamGeneration() { return streamGeneration; }, set streamGeneration(v) { streamGeneration = v; }, tradeTimestamps, applyLivePriceIfNewer, parseTiingoWsTimestamp, resolveRealtimeTicker, nyNow };');
    const api = fn(...Object.values(sandbox));
    const container = document.getElementById('resultsContainer');

    // 1. Enhanced Live Mode gating
    assert(!api.enhancedLiveMode, 'enhancedLiveMode starts false');
    const chk = document.getElementById('enhancedLiveModeSetting');
    const err = document.getElementById('enhancedLiveModeError');
    err.className = 'hidden';

    // Try to enable without keys
    chk.checked = true;
    api.saveEnhancedLiveSetting();
    assert(!api.enhancedLiveMode, 'enabling without keys keeps feature off');
    assert(!chk.checked, 'enabling without keys unchecks box');
    assert(err.innerText.toLowerCase().includes('requires') && err.innerText.toLowerCase().includes('both'), 'error message shown');
    assert(!err.className.includes('hidden'), 'error is visible');

    // Save both keys and enable
    localStorage.setItem('finnhub_key', 'finnhub_test_key');
    localStorage.setItem('tiingo_key', 'tiingo_test_key');
    err.className = 'hidden';
    err.innerText = '';
    chk.checked = true;
    api.saveEnhancedLiveSetting();
    assert(api.enhancedLiveMode === true, 'enabling with both keys succeeds');
    assert(err.className.includes('hidden'), 'error hidden after success');
    assert(document.getElementById('apiProvider').value === 'finnhub', 'provider main set to finnhub in test');
    assert(document.getElementById('apiProvider').disabled === false, 'provider dropdown stays enabled in enhanced mode');

    // 2. Dual-socket cleanup
    api.activeSockets.finnhub = new MockWebSocket('wss://ws.finnhub.io');
    api.activeSockets.tiingo = new MockWebSocket('wss://api.tiingo.com/iex');
    api.activeSockets.finnhub.readyState = WebSocket.OPEN;
    api.activeSockets.tiingo.readyState = WebSocket.OPEN;
    api.reconnectTimeoutByProvider.finnhub = setTimeout(() => {}, 999999);
    api.reconnectTimeoutByProvider.tiingo = setTimeout(() => {}, 999999);
    api.connectionTimeoutByProvider.finnhub = setTimeout(() => {}, 999999);
    api.connectionTimeoutByProvider.tiingo = setTimeout(() => {}, 999999);
    api.reconnectAttemptsByProvider.finnhub = 3;
    api.reconnectAttemptsByProvider.tiingo = 2;

    api.disconnectWebSocket();

    assert(api.activeSockets.finnhub === null && api.activeSockets.tiingo === null, 'activeSockets cleared');
    assert(api.reconnectTimeoutByProvider.finnhub === null && api.reconnectTimeoutByProvider.tiingo === null, 'per-provider timers cleared');
    assert(api.connectionTimeoutByProvider.finnhub === null && api.connectionTimeoutByProvider.tiingo === null, 'per-provider connection timeouts cleared');
    assert(api.reconnectAttemptsByProvider.finnhub === 0 && api.reconnectAttemptsByProvider.tiingo === 0, 'per-provider attempts reset');

    // 3. Resync provider policy (Enhanced mode uses Finnhub only, no Tiingo REST)
    fetchCalls.length = 0;
    api.realtimeTasks = [{ ticker: 'GOOD' }];
    api.realtimeQuotes['GOOD'] = { c: 10, h: 11, l: 9, pc: 8, bid: null, ask: null };
    api.streamGeneration = 1;
    await api.resyncBaselines('finnhub', 'finnKey', 1, container, 500, 0, false);
    assert(fetchCalls.some(u => u.includes('finnhub.io')), 'resync calls finnhub');
    assert(!fetchCalls.some(u => u.includes('api.tiingo.com')), 'resync does not call tiingo in enhanced mode');

    // 4. Timestamp helpers
    assert(api.parseTiingoWsTimestamp(1000) === 1000000, 'numeric seconds converted to ms');
    assert(api.parseTiingoWsTimestamp(1000000000000) === 1000000000000, 'numeric ms kept as ms');
    const isoMs = Date.parse('2026-09-01T18:00:00.123Z');
    assert(api.parseTiingoWsTimestamp('2026-09-01T18:00:00.123456789Z') === isoMs, 'tiingo iso with sub-ms digits truncated to ms');

    api.realtimeQuotes['BRK.B'] = { c: 100, h: 101, l: 99, pc: 98, bid: null, ask: null };
    assert(api.resolveRealtimeTicker('BRK-B') === 'BRK.B', 'IEX hyphen share class maps to dot watchlist key');
    assert(api.resolveRealtimeTicker('BRK.B') === 'BRK.B', 'exact match works');
    assert(api.resolveRealtimeTicker('UNKNOWN') === null, 'unknown ticker returns null');

    // 5. Status branch ordering
    api.liveUpdateEnabled = true;
    api.enhancedLiveMode = true;
    document.getElementById('apiProvider').value = 'finnhub';
    const statusEl = document.getElementById('liveStatusText');

    api.activeSockets.finnhub = new MockWebSocket('wss://ws.finnhub.io');
    api.activeSockets.finnhub.readyState = WebSocket.OPEN;
    api.activeSockets.tiingo = new MockWebSocket('wss://api.tiingo.com/iex');
    api.activeSockets.tiingo.readyState = WebSocket.OPEN;
    api.updateTopStatus();
    assert(statusEl.innerText === 'LIVE (FINNHUB + TIINGO)', 'both open shows combined live status');

    api.activeSockets.tiingo.readyState = WebSocket.CONNECTING;
    api.updateTopStatus();
    assert(statusEl.innerText === 'LIVE (FINNHUB) + TIINGO RECONNECTING', 'open + connecting shows the live provider plus the reconnecting one');

    api.activeSockets.finnhub.readyState = WebSocket.CLOSED;
    api.activeSockets.tiingo = null;
    api.updateTopStatus();
    assert(statusEl.innerText === 'STANDBY', 'no open sockets and no activity shows standby');

    api.reconnectTimeoutByProvider.finnhub = setTimeout(() => {}, 999999);
    api.updateTopStatus();
    assert(statusEl.innerText === 'RECONNECTING (FINNHUB)', 'reconnect timer produces named reconnecting status');

    api.activeSockets.finnhub = new MockWebSocket('wss://ws.finnhub.io');
    api.activeSockets.finnhub.readyState = WebSocket.OPEN;
    api.activeSockets.tiingo = null;
    api.reconnectTimeoutByProvider.finnhub = null;
    api.updateTopStatus();
    assert(statusEl.innerText === 'LIVE (FINNHUB ONLY)', 'single open with no activity shows only');

    console.log('Enhanced Live Mode tests passed!');
    process.exit(0);
  } catch (e) {
    console.error('Enhanced test failed:', e);
    process.exit(1);
  }
})();
