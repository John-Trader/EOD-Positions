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

// Fake batch row for collectBatchTradesFromDom.
const fakeInputs = {
  '.batch-entry': { value: '179.94' },
  '.batch-shares': { value: '67' },
  '.batch-stop': { value: '172.54' }
};
const fakeRow = {
  dataset: { ticker: 'PLTR', long: 'true' },
  querySelector: (sel) => fakeInputs[sel] || null,
  querySelectorAll: () => []
};

const document = {
  getElementById: (id) => mockElement(id),
  querySelectorAll: (sel) => sel === '#batchReviewList .batch-row' ? [fakeRow] : [],
  querySelector: () => null,
  createElement: (tag) => mockElement('elem_' + (createdCount++)),
  addEventListener: () => {},
  body: mockElement('body')
};
const localStorage = { getItem: () => null, setItem: () => {} };
const window = { speechSynthesis: { speak: () => {}, cancel: () => {} } };

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT FAIL: ' + msg); };

(async () => {
  try {
    const sandbox = { elements, document, localStorage, window, console, setTimeout, clearTimeout, setInterval, clearInterval, parseFloat, parseInt, Number, Array, Math, Date, String };
    const fn = new Function(...Object.keys(sandbox), code + '\nreturn { onBatchPreviewTpInput, renderBatchPreview, collectBatchTradesFromDom, buildExitLegs };');
    const res = fn(...Object.values(sandbox));

    // Set the global batch strategy to opt1 and give it a custom LMT.
    document.getElementById('batchGlobalStrategy').value = 'opt1';

    // Test 1: preview LMT input value should reflect custom TP after onBatchPreviewTpInput.
    res.onBatchPreviewTpInput({ dataset: { ticker: 'PLTR', legIdx: '0' }, value: '250.00' });
    res.renderBatchPreview();
    assert(elements['batchPreviewBody'].innerHTML.includes('250.00'), 'Preview should render the edited LMT');
    assert(elements['batchPreviewBody'].innerHTML.includes('data-ticker="PLTR"'), 'Preview should contain an editable LMT input for PLTR');

    // Test 2: collectBatchTradesFromDom must use the stored custom TP (250) from batchCustomTps.
    const collected = res.collectBatchTradesFromDom();
    assert(collected.trades.length === 1, 'Should have one valid trade');
    const lmtRow = collected.trades[0].built.rows.find(r => r[7] === 'LMT');
    assert(lmtRow, 'Should have a LMT row');
    assert(lmtRow[8] === '250.00', 'Custom TP 250.00 should appear in LMT row, got: ' + lmtRow[8]);

    console.log('Batch TP tests passed!');
    process.exit(0);
  } catch (e) {
    console.error('Batch TP test failed:', e);
    process.exit(1);
  }
})();
