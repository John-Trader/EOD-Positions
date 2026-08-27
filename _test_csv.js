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
      value: id === 'apiProvider' ? 'finnhub' : '',
      className: id === 'strategyModalOverlay' ? 'fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md hidden flex items-center justify-center px-3 modal-overlay-pad animate-fade-in' : '',
      classList: {
        add: (...c) => { elements[id].className += ' ' + c.join(' '); },
        remove: (...c) => { c.forEach(cls => elements[id].className = elements[id].className.replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim()); },
        contains: (c) => elements[id].className.includes(c)
      },
      style: {},
      children: [],
      querySelectorAll: () => [],
      querySelector: () => null,
      appendChild: (ch) => { if (ch) { elements[id].children.push(ch); } },
      removeChild: (ch) => { elements[id].children = elements[id].children.filter(x => x !== ch); },
      addEventListener: () => {},
      setAttribute: (k, v) => { elements[id][k] = v; },
      getAttribute: (k) => elements[id][k],
      click: () => {}
    };
  }
  return elements[id];
}

let lastCsv = '';
class Blob {
  constructor(parts, opts) { this.parts = parts; this.opts = opts || {}; }
}
const URL = {
  createObjectURL: (blob) => {
    lastCsv = (blob && blob.parts && blob.parts[0]) || '';
    return 'blob:mock';
  },
  revokeObjectURL: () => {}
};

const document = {
  getElementById: (id) => mockElement(id),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: (tag) => mockElement('elem_' + (createdCount++)),
  addEventListener: () => {},
  body: mockElement('body')
};
const localStorage = {
  getItem: (k) => null,
  setItem: () => {}
};
const window = {
  speechSynthesis: { speak: () => {}, cancel: () => {} }
};

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT FAIL: ' + msg); };

try {
  const sandbox = { elements, document, localStorage, window, console, setTimeout, clearTimeout, parseFloat, parseInt, Number, Array, Math, Date, String, Blob, URL };
  const fn = new Function(...Object.keys(sandbox), code + '\nreturn { buildExitLegs, TWS_CSV_HEADERS, downloadTWSBasketCSV, openStrategyModal };');
  const res = fn(...Object.values(sandbox));

  // Test 1: header uses OcaGroup, not OCA_Group
  assert(!res.TWS_CSV_HEADERS.includes('OCA_Group'), 'TWS_CSV_HEADERS should not include OCA_Group');
  assert(res.TWS_CSV_HEADERS.includes('OcaGroup'), 'TWS_CSV_HEADERS should include OcaGroup');

  // Test 2: long trade default CSV row format
  const longBuilt = res.buildExitLegs('PLTR', true, 179.94, 67, 172.54, 'opt1');
  assert(longBuilt.ok, 'Long build failed: ' + longBuilt.error);
  const rows = longBuilt.rows;
  assert(rows.length === 2, 'Expected 2 order rows for single-leg strategy');
  const [stpRow, lmtRow] = rows;
  assert(stpRow[7] === 'STP', 'First row should be STP order');
  assert(stpRow[8] === '', 'STP row LmtPrice should be blank');
  assert(stpRow[9] === '172.54', 'STP row AuxPrice should be stop price');
  assert(stpRow[11].startsWith('PLTR_opt1_L1'), 'STP row OcaGroup should start with PLTR_opt1_L1');
  assert(lmtRow[7] === 'LMT', 'Second row should be LMT order');
  assert(lmtRow[8] === '224.34', 'LMT row LmtPrice should be target price 224.34');
  assert(lmtRow[9] === '', 'LMT row AuxPrice should be blank');

  // Test 3: short trade default CSV
  const shortBuilt = res.buildExitLegs('PLTR', false, 175.89, 174, 178.76, 'opt2');
  assert(shortBuilt.ok, 'Short build failed: ' + shortBuilt.error);
  assert(shortBuilt.rows[0][0] === 'BUY', 'Short exit action should be BUY');
  assert(shortBuilt.rows[1][0] === 'BUY', 'Short exit action should be BUY');
  assert(shortBuilt.rows[0][7] === 'STP', 'Short first row STP');
  assert(shortBuilt.rows[1][7] === 'LMT', 'Short second row LMT');

  // Test 4: custom TP override
  const customBuilt = res.buildExitLegs('PLTR', true, 179.94, 67, 172.54, 'opt1', [250.00]);
  assert(customBuilt.ok, 'Custom TP build failed: ' + customBuilt.error);
  assert(customBuilt.rows[1][8] === '250.00', 'Custom TP should appear in LMT row LmtPrice');

  // Test 5: CSV download uses header and blank fields
  res.openStrategyModal('PLTR', true, 179.94, 67, 172.54, 172.55);
  elements['modalEntryPrice'].value = '179.94';
  elements['modalShares'].value = '67';
  elements['modalStopPrice'].value = '172.54';
  res.downloadTWSBasketCSV();
  const csvLines = lastCsv.split('\n');
  assert(csvLines.length >= 2, 'CSV should have header and at least one data row');
  assert(csvLines[0].includes('OcaGroup'), 'CSV header should include OcaGroup');
  assert(!csvLines[0].includes('OCA_Group'), 'CSV header should not include OCA_Group');
  const dataRow = csvLines[1];
  assert(dataRow.includes(',,') || dataRow.endsWith(','), 'CSV data row should contain blank field(s)');

  console.log('All CSV tests passed!');
  console.log('CSV header:', csvLines[0]);
  console.log('Sample STP row:', csvLines[1]);
  console.log('Sample LMT row:', csvLines[2]);
} catch (e) {
  console.error('CSV test failed:', e);
  process.exit(1);
}
