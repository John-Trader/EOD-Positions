const fs = require('fs');
const h = fs.readFileSync('C:/Users/levif/Desktop/End-of-day/index.html', 'utf8');

const start = h.indexOf('<script>');
const end = h.lastIndexOf('</script>');
const code = h.slice(start + 8, end);

const elements = {};
let createdCount = 0;
function mockElement(id) {
  if (!elements[id]) {
    elements[id] = {
      id,
      innerText: '',
      innerHTML: '',
      value: id === 'apiProvider' ? 'stockdata' : '',
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
const localStorage = { getItem: () => null, setItem: () => {} };
const window = { speechSynthesis: { speak: () => {}, cancel: () => {} } };

const Blob = class { constructor(parts, opts) { this.parts = parts; this.opts = opts || {}; } };
const URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} };

// Mock fetch so GOOD ticker succeeds and BAD fails.
const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(url);
  if (url.includes('GOOD')) {
    return {
      status: 200,
      ok: true,
      json: async () => ({
        data: [{
          price: 100,
          day_high: 105,
          day_low: 95,
          previous_close_price: 99,
          bid: 99.5,
          ask: 100.5
        }]
      })
    };
  }
  // Unknown/empty symbol for BAD
  return { status: 200, ok: true, json: async () => ({ data: [] }) };
};

// Mock WebSocket to ensure no real connection.
globalThis.WebSocket = class MockWebSocket {
  constructor(url) { this.url = url; this.sent = []; }
  send(msg) { this.sent.push(msg); }
};

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT FAIL: ' + msg); };

(async () => {
  try {
    const sandbox = { elements, document, localStorage, window, console, setTimeout, clearTimeout, setInterval, clearInterval, parseFloat, parseInt, Number, Array, Math, Date, String, Blob, URL };
    const fn = new Function(...Object.keys(sandbox), code + '\nreturn { startWebSocketStream, renderRealtimeSnapshot, realtimeTasks, realtimeQuotes, realtimeQuoteErrors };');
    const res = fn(...Object.values(sandbox));

    const container = document.getElementById('resultsContainer');
    const tasks = [{ ticker: 'GOOD', trigger: null }, { ticker: 'BAD', trigger: 50 }];
    await res.startWebSocketStream('stockdata', 'testkey', tasks, 500, 0, container);

    // One good baseline stored, one bad error stored.
    assert(res.realtimeQuotes['GOOD'] && res.realtimeQuotes['GOOD'].c === 100, 'GOOD baseline should be stored');
    assert(res.realtimeQuoteErrors['BAD'], 'BAD should have an error entry');
    assert(res.realtimeQuoteErrors['BAD'].includes('BAD'), 'Error message should mention the bad ticker');

    // Container should have one card and one error card.
    const kids = container.children;
    assert(kids.length >= 2, 'Container should render at least two items');
    const html = kids.map(k => k.innerHTML).join(' ');
    assert(html.includes('GOOD'), 'Render should include GOOD ticker');
    assert(html.includes('BAD'), 'Render should include BAD ticker');
    assert(html.includes('Invalid Ticker') || html.includes('Invalid ticker'), 'BAD should be marked with an invalid-ticker error');

    console.log('Baseline per-ticker error test passed!');
    process.exit(0);
  } catch (e) {
    console.error('Baseline test failed:', e);
    process.exit(1);
  }
})();
