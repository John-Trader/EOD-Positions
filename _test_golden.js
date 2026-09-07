// Golden-master regression test: built-in strategies (opt1 / opt2 / short16) must
// produce byte-identical exit rows, CSV text and sizing fields across refactors.
// Usage:  node _test_golden.js            -> compare against _golden_fixtures.json
//         node _test_golden.js --record   -> (re)record fixtures from current code
const fs = require('fs');
const path = require('path');
const FIX = path.join(__dirname, '_golden_fixtures.json');
const h = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = h.slice(h.indexOf('<script>') + 8, h.lastIndexOf('</script>'));

const elements = {};
let createdCount = 0;
function mockElement(id) {
  if (!elements[id]) {
    elements[id] = {
      id, innerText: '', innerHTML: '', value: id === 'apiProvider' ? 'finnhub' : '', className: '',
      dataset: {}, style: {}, children: [], checked: false, disabled: false,
      classList: {
        add: (...c) => { elements[id].className += ' ' + c.join(' '); },
        remove: (...c) => { c.forEach(cls => elements[id].className = elements[id].className.replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim()); },
        contains: (c) => elements[id].className.includes(c),
        toggle: () => {}
      },
      querySelectorAll: () => [], querySelector: () => null,
      appendChild: (ch) => { if (ch) elements[id].children.push(ch); },
      removeChild: () => {}, insertAdjacentHTML: () => {}, addEventListener: () => {},
      setAttribute: (k, v) => { elements[id][k] = v; }, getAttribute: (k) => elements[id][k],
      click: () => {}, closest: () => null, focus: () => {}, remove: () => {}
    };
  }
  return elements[id];
}
let lastCsv = '';
class Blob { constructor(parts, opts) { this.parts = parts; this.opts = opts || {}; } }
const URL = { createObjectURL: (b) => { lastCsv = (b && b.parts && b.parts[0]) || ''; return 'blob:mock'; }, revokeObjectURL: () => {} };
const document = {
  getElementById: (id) => mockElement(id), querySelectorAll: () => [], querySelector: () => null,
  createElement: () => mockElement('elem_' + (createdCount++)), addEventListener: () => {}, body: mockElement('body'),
  hidden: false
};
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const window = { speechSynthesis: { speak: () => {}, cancel: () => {} }, addEventListener: () => {} };
const navigator = { clipboard: { writeText: () => Promise.resolve() }, serviceWorker: undefined };

const sandbox = { elements, document, localStorage, window, navigator, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval, Blob, URL, alert: () => {}, confirm: () => true, prompt: () => null };
const fn = new Function(...Object.keys(sandbox), code + '\nreturn { buildExitLegs, getRealtimeFields, triggerCsvDownload, splitSharesByPct, TWS_CSV_HEADERS };');
const api = fn(...Object.values(sandbox));

// Normalise the OCA group (date/time suffix is allowed to differ between versions).
const normOca = (s) => String(s).replace(/^([A-Z.\-]+_[a-z0-9]+_L\d+).*$/, '$1');
const normRows = (rows) => rows.map(r => r.map((v, i) => i === 11 ? normOca(v) : v));
const normCsv = (csv) => csv.split('\n').map((line, idx) => {
  if (idx === 0) return line;
  const cells = line.split(',');
  if (cells.length > 11) cells[11] = normOca(cells[11]);
  return cells.join(',');
}).join('\n');

const strategies = ['opt1', 'opt2', 'short16'];
const cases = [
  { entry: 179.94, shares: 67, stop: 172.54 },
  { entry: 13.96, shares: 1000, stop: 13.41 },
  { entry: 42.84, shares: 333, stop: 41.20 },
  { entry: 157.55, shares: 1, stop: 150.00 },
  { entry: 30.02, shares: 7, stop: 29.50 },
  { entry: 33.72, shares: 12500, stop: 33.68 }
];
const quotes = [
  { c: 154.14, h: 154.79, l: 138.09, pc: 150.00, bid: null, ask: null, trigger: 151.08 },
  { c: 41.46, h: 41.47, l: 39.38, pc: 42.00, bid: 41.45, ask: 41.47, trigger: 40.79 },
  { c: 13.96, h: 14.10, l: 13.50, pc: 13.90, bid: null, ask: null, trigger: null },
  { c: 100, h: 100, l: 100, pc: 100, bid: null, ask: null, trigger: 99 }
];

const out = { headers: api.TWS_CSV_HEADERS, legs: {}, csv: {}, fields: {}, split: {} };
for (const s of strategies) for (const isLong of [true, false]) for (const [ci, c] of cases.entries()) for (const custom of [null, [c.entry * 1.5]]) {
  const key = `${s}|${isLong ? 'L' : 'S'}|${ci}|${custom ? 'custom' : 'default'}`;
  const e = isLong ? c.entry : c.stop;  // short: entry below stop
  const st = isLong ? c.stop : c.entry;
  const b = api.buildExitLegs('TST', isLong, e, c.shares, st, s, custom || undefined);
  // Preview objects may gain informational keys over time; only the trading fields are golden.
  const previewKeys = ['ticker', 'action', 'qty', 'stop', 'tp', 'rr', 'oca', 'stopMode'];
  const pickPreview = (p) => Object.fromEntries(previewKeys.map(k => [k, k === 'oca' ? normOca(p.oca) : p[k]]));
  out.legs[key] = { ok: b.ok, error: b.error, rows: b.ok ? normRows(b.rows) : [], preview: b.ok ? b.preview.map(pickPreview) : [] };
  if (b.ok) { api.triggerCsvDownload('x.csv', b.rows); out.csv[key] = normCsv(lastCsv); }
}
for (const [qi, q] of quotes.entries()) for (const risk of [500, 850]) for (const slip of [0, 0.02]) {
  const f = api.getRealtimeFields({ ticker: 'TST', trigger: q.trigger, data: q }, risk, slip);
  out.fields[`${qi}|${risk}|${slip}`] = { isGreenDay: f.isGreenDay, stopPrice: f.stopPrice, shares: f.shares, changePct: f.changePct, statusClass: f.statusClass, rowClass: f.rowClass, isActive: f.isActive, bidText: f.bidText, askText: f.askText };
}
for (const total of [1, 7, 67, 333, 1000]) for (const pcts of [[100], [40, 60], [33, 33, 34]]) out.split[`${total}|${pcts.join('-')}`] = api.splitSharesByPct(total, pcts);

if (process.argv.includes('--record')) {
  fs.writeFileSync(FIX, JSON.stringify(out, null, 1));
  console.log(`Recorded ${Object.keys(out.legs).length} leg cases, ${Object.keys(out.fields).length} field cases -> ${FIX}`);
  process.exit(0);
}
const golden = JSON.parse(fs.readFileSync(FIX, 'utf8'));
const diffs = [];
const cmp = (a, b, p) => { if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(p); };
cmp(golden.headers, out.headers, 'headers');
for (const k of Object.keys(golden.legs)) cmp(golden.legs[k], out.legs[k], 'legs:' + k);
for (const k of Object.keys(golden.csv)) cmp(golden.csv[k], out.csv[k], 'csv:' + k);
for (const k of Object.keys(golden.fields)) cmp(golden.fields[k], out.fields[k], 'fields:' + k);
for (const k of Object.keys(golden.split)) cmp(golden.split[k], out.split[k], 'split:' + k);
if (diffs.length) { console.error('GOLDEN MISMATCH:\n  ' + diffs.slice(0, 20).join('\n  ') + (diffs.length > 20 ? `\n  ...and ${diffs.length - 20} more` : '')); process.exit(1); }
console.log(`Golden test passed (${Object.keys(golden.legs).length} leg cases, ${Object.keys(golden.csv).length} CSVs, ${Object.keys(golden.fields).length} field cases).`);
