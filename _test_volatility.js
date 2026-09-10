(async () => {
const fs = require('fs');
const h = fs.readFileSync('C:/Users/levif/Desktop/End-of-day/index.html', 'utf8');

const start = h.indexOf('<script>');
const end = h.lastIndexOf('</script>');
const code = h.slice(start + 8, end);

const elements = {};
function mockElement(id) {
  if (!elements[id]) {
    const isProvider = id === 'apiProvider';
    elements[id] = {
      id, innerText: '', innerHTML: '', value: isProvider ? 'finnhub' : (id === 'riskValue' ? '100' : (id === 'slippageValue' ? '0.01' : '')), checked: false, className: '',
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
let fetchResponse = null;
const fetch = async (url, init) => {
  if (!fetchResponse) throw new Error('No mock fetch response set up for ' + url);
  return fetchResponse(url, init);
};
const AbortController = class { constructor() { this.signal = { aborted: false }; } abort() {} };

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) { console.error('FAIL', label, '\n  actual:', a, '\n  expected:', e); process.exit(1); }
  console.log('PASS', label);
}
function assertTrue(cond, label) { if (!cond) { console.error('FAIL', label); process.exit(1); } console.log('PASS', label); }
function assertApprox(actual, expected, tol, label) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || Math.abs(actual - expected) > tol) { console.error('FAIL', label, actual, '!=~', expected); process.exit(1); }
  console.log('PASS', label);
}

try {
  const sandbox = {
    elements, document, localStorage, window, navigator, URL, crypto, fetch, AbortController,
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    parseFloat, parseInt, Number, Array, Math, Date, String, JSON, RegExp, Object, Map, Set, Error, Promise, Blob,
    globalThis: { crypto }
  };
  const fn = new Function(...Object.keys(sandbox), code + '; return { computeAdrPct, computeAtrPct, stopVolatilityWarning, fetchVolatilityData, sortBars, volatilityCache, safeStorageGet, API_CONFIGS };');
  const api = fn(...Object.values(sandbox));

  // ---- computeAdrPct / computeAtrPct ----
  // 21 days where each day high-low = 2.00, prev close always same as close
  const bars = [];
  for (let i = 0; i < 21; i++) bars.push({ h: 102, l: 100, c: 101 });
  const adr = api.computeAdrPct(bars, 101);
  const atr = api.computeAtrPct(bars, 101);
  assertApprox(adr, 2 / 101 * 100, 0.0001, 'ADR% for 2.00 range');
  assertApprox(atr, 2 / 101 * 100, 0.0001, 'ATR% for 2.00 range and 0 gap');

  // Gap day: prevClose 100, today high 104 low 103 (TR = max(1, 4, 3) = 4)
  const gapBars = [...Array(21).keys()].map(i => ({ h: 102, l: 100, c: 101 }));
  gapBars[20] = { h: 104, l: 103, c: 103.5 };
  const atrGap = api.computeAtrPct(gapBars, 103.5);
  assertApprox(atrGap, (19 * 2 + 3) / 20 / 103.5 * 100, 0.0001, 'ATR% with a gap day');

  // ---- stopVolatilityWarning ----
  localStorage.setItem('stopVolWarnEnabled', 'true');
  const warnCache = { ticker: 'TST', status: 'ok', atrPct: 2.0, adrPct: 1.5, latestClose: 100, refPct: 2.0, checkedAt: Date.now() };
  api.volatilityCache['TST'] = warnCache;
  // long, c=100, stop 5 dollars away -> stopSizePct 5%, refPct 2%, limit 2.5*2 = 5%, exactly at limit -> no warn
  let warn = api.stopVolatilityWarning('TST', 5, 100, true);
  assertEq(warn, null, 'long at 2.5x limit does not warn');
  // long, stop 5.1 dollars away -> 5.1% > 5% -> warn
  warn = api.stopVolatilityWarning('TST', 5.1, 100, true);
  assertTrue(warn && warn.text === 'STOP 2.6×', 'long just over limit warns with 2.6x');
  // short, c=100, stop 3 dollars away -> stopSizePct 3%, refPct 2%, limit 1.5*2=3% -> no warn
  warn = api.stopVolatilityWarning('TST', 3, 100, false);
  assertEq(warn, null, 'short at 1.5x limit does not warn');
  // short, stop 3.1 dollars away -> warn
  warn = api.stopVolatilityWarning('TST', 3.1, 100, false);
  assertTrue(warn && warn.text === 'STOP 1.6×', 'short just over limit warns with 1.6x');

  // ---- live price re-normalization ----
  api.volatilityCache['MOVE'] = { ticker: 'MOVE', status: 'ok', atrPct: 2.0, adrPct: null, latestClose: 100, refPct: 2.0, checkedAt: Date.now() };
  // price moves to 200; cached atrPct was 2% of 100 = $2; live ATR% = $2/200*100 = 1%
  // stop $5 away at $200 -> stopSizePct 2.5%, long limit 2.5*1 = 2.5% -> no warn
  warn = api.stopVolatilityWarning('MOVE', 5, 200, true);
  assertEq(warn, null, 'price re-normalization keeps warning accurate');

  // ---- fetchVolatilityData fallback ----
  // No keys set -> no fetch, returns error status
  let result = await api.fetchVolatilityData('NOKEY');
  assertTrue(result.status === 'error' || (result.atrPct === null && result.adrPct === null), 'no keys returns empty volatility');

  // Twelve Data NATR returns a value and time_series returns ADR
  localStorage.setItem('twelvedata_key', 'td_key');
  fetchResponse = (url) => {
    if (url.includes('/natr')) {
      return { ok: true, json: async () => ({ status: 'ok', values: [{ datetime: '2024-01-22', natr: '2.50' }] }) };
    }
    if (url.includes('/time_series')) {
      const values = [];
      for (let i = 0; i < 25; i++) values.push({ datetime: `2024-01-0${i+1}`.slice(-10), open: '100', high: '102', low: '100', close: '101' });
      return { ok: true, json: async () => ({ status: 'ok', values }) };
    }
    return { ok: false, status: 404 };
  };
  result = await api.fetchVolatilityData('TDTD');
  assertTrue(result.status === 'ok', 'Twelve Data provides OK volatility');
  assertApprox(result.atrPct, 2.5, 0.0001, 'Twelve Data NATR used as ATR%');
  assertApprox(result.adrPct, 2 / 101 * 100, 0.01, 'Twelve Data time_series ADR%');

  // Tiingo fallback when Twelve Data fails
  delete api.volatilityCache['TST'];
  localStorage.removeItem('twelvedata_key');
  localStorage.setItem('tiingo_key', 'ti_key');
  fetchResponse = (url) => {
    if (url.includes('tiingo.com/tiingo/daily')) {
      const prices = [];
      for (let i = 0; i < 25; i++) prices.push({ date: `2024-01-${String(i+1).padStart(2,'0')}`, adjOpen: 100, adjHigh: 102, adjLow: 100, adjClose: 101 });
      return { ok: true, json: async () => prices };
    }
    return { ok: false, status: 404 };
  };
  result = await api.fetchVolatilityData('TITI');
  assertTrue(result.status === 'ok', 'Tiingo fallback provides OK volatility');
  assertTrue(result.atrPct !== null && result.adrPct !== null, 'Tiingo provides both ATR% and ADR%');

  console.log('\nVolatility tests passed');
} catch (e) {
  console.error('Unexpected error:', e);
  process.exit(1);
}
})();
