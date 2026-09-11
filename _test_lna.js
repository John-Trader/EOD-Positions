(async () => {
const fs = require('fs');
const h = fs.readFileSync('C:/Users/levif/Desktop/End-of-day/index.html', 'utf8');

const start = h.indexOf('<script>');
const end = h.lastIndexOf('</script>');
const code = h.slice(start + 8, end);

const elements = {};
function mockElement(id) {
  if (!elements[id]) {
    elements[id] = {
      id, innerText: '', innerHTML: '', value: '', checked: false, className: '',
      classList: { add: (...c) => { elements[id].className += ' ' + c.join(' '); }, remove: (...c) => { c.forEach(cls => elements[id].className = elements[id].className.replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim()); }, contains: (c) => elements[id].className.includes(c), toggle: (c, on) => { if (on) elements[id].classList.add(c); else elements[id].classList.remove(c); } },
      style: {}, children: [], querySelectorAll: () => [], querySelector: () => null, appendChild: (ch) => { if (ch) elements[id].children.push(ch); },
      addEventListener: () => {}, setAttribute: (k, v) => { elements[id][k] = v; }, getAttribute: (k) => elements[id][k], disabled: false, dataset: {}, title: ''
    };
  }
  return elements[id];
}

const document = { getElementById: (id) => mockElement(id), querySelectorAll: () => [], querySelector: () => null, createElement: () => mockElement('elem_' + Math.random()), addEventListener: () => {}, hidden: false, body: mockElement('body') };
const localStorageStore = {};
const localStorage = {
  getItem: (k) => localStorageStore[k] || null,
  setItem: (k, v) => { localStorageStore[k] = v; },
  removeItem: (k) => { delete localStorageStore[k]; }
};
const window = { isSecureContext: false, speechSynthesis: { speak: () => {}, cancel: () => {} }, addEventListener: () => {} };
const navigator = { serviceWorker: {}, clipboard: { writeText: () => Promise.resolve() } };
const URL = { createObjectURL: (x) => x, revokeObjectURL: () => {} };
const crypto = { randomUUID: () => 'test-uuid-1234' };
const location = { protocol: 'https:', hostname: 'levifasten.github.io', href: 'https://levifasten.github.io/End-of-day/' };
const fetch = async () => { throw new TypeError('Failed to fetch'); };
const AbortController = class { constructor() { this.signal = { aborted: false }; } abort() {} };

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) { console.error('FAIL', label, '\n  actual:', a, '\n  expected:', e); process.exit(1); }
  console.log('PASS', label);
}
function assertTrue(cond, label) { if (!cond) { console.error('FAIL', label); process.exit(1); } console.log('PASS', label); }

try {
  const sandbox = {
    elements, document, localStorage, window, navigator, URL, crypto, fetch, AbortController, location,
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    parseFloat, parseInt, Number, Array, Math, Date, String, JSON, RegExp, Object, Map, Set, Error, Promise, Blob,
    globalThis: { crypto }
  };
  const fn = new Function(...Object.keys(sandbox), code + '; return { isLocalNetworkHost, isHttpsPageToLocalBridge, bridgeHealth, updateTwsStatusUI, set twsEnabled(v) { twsEnabled = v; }, set twsConnected(v) { twsConnected = v; }, set twsBridgeUrl(v) { twsBridgeUrl = v; }, set twsBridgeToken(v) { twsBridgeToken = v; } };');
  const api = fn(...Object.values(sandbox));

  // ---- isLocalNetworkHost ----
  for (const l of ['127.0.0.1', 'localhost', 'foo.localhost', '::1', '[::1]', '10.0.0.5', '192.168.1.5', '172.16.0.1', '172.31.255.255', '169.254.0.1', '0.0.0.0', 'printer.local', 'router.lan']) {
    assertTrue(api.isLocalNetworkHost(l), 'local: ' + l);
  }
  for (const r of ['api.tiingo.com', 'levifasten.github.io', '172.15.0.1', '172.32.0.1', '8.8.8.8', '127.com', '']) {
    assertTrue(!api.isLocalNetworkHost(r), 'not local: ' + r);
  }

  // ---- isHttpsPageToLocalBridge ----
  api.twsBridgeUrl = 'http://127.0.0.1:8787';
  assertTrue(api.isHttpsPageToLocalBridge(), 'https public page + loopback bridge = gated');

  location.hostname = 'localhost';
  location.href = 'http://localhost:8080/';
  assertTrue(!api.isHttpsPageToLocalBridge(), 'localhost page is not gated');

  location.protocol = 'file:';
  location.hostname = '';
  location.href = 'file:///C:/Users/levif/Desktop/End-of-day/index.html';
  assertTrue(!api.isHttpsPageToLocalBridge(), 'file:// page is not gated');

  location.protocol = 'https:';
  location.hostname = 'levifasten.github.io';
  location.href = 'https://levifasten.github.io/End-of-day/';
  api.twsBridgeUrl = 'http://api.example.com:8787';
  assertTrue(!api.isHttpsPageToLocalBridge(), 'public bridge host is not gated');
  api.twsBridgeUrl = 'http://127.0.0.1:8787';

  // ---- bridgeHealth classification ----
  api.twsEnabled = true;
  api.twsBridgeToken = 'tok';
  let res = await api.bridgeHealth();
  assertEq(res.blocked, 'local-network', 'https+loopback fetch TypeError classified as blocked');
  assertEq(res.connected, false, 'blocked health reports not connected');

  location.hostname = 'localhost';
  res = await api.bridgeHealth();
  assertEq(res.blocked, undefined, 'localhost page fetch failure is not classified as blocked');
  assertTrue(!!res.error, 'plain failure still carries the error message');
  location.hostname = 'levifasten.github.io';

  // ---- updateTwsStatusUI blocked state + hint ----
  api.twsConnected = false;
  api.updateTwsStatusUI();
  assertEq(elements['twsStatus'].innerText || elements['twsStatus'].textContent, 'Blocked? (see below)', 'status shows blocked wording');
  assertTrue(elements['twsLnaHint'].className.includes('hidden') === false, 'LNA hint visible when gated');

  api.twsConnected = true;
  api.updateTwsStatusUI();
  assertTrue(elements['twsLnaHint'].className.includes('hidden'), 'LNA hint hidden when connected');

  api.twsEnabled = false;
  api.twsConnected = false;
  api.updateTwsStatusUI();
  assertTrue(elements['twsLnaHint'].className.includes('hidden'), 'LNA hint hidden when TWS disabled');

  console.log('\nLNA tests passed');
} catch (e) {
  console.error('Unexpected error:', e);
  process.exit(1);
}
})();
