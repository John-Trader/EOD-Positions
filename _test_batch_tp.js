const fs = require('fs');
const h = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');

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

// Fake order-builder row for collectBuilderTrades / renderBuilderOrdersPreview.
const builderInputs = {
  '.b-ticker': { value: 'PLTR' },
  '.b-side': { value: 'long' },
  '.b-entry': { value: '180.00' },
  '.b-shares': { value: '100' },
  '.b-stop': { value: '172.00' },
  '.b-opt': { value: 'opt1' },
  '.b-pb-cat': { value: 'day' },
  '.b-pb-exit-date': { value: '' }
};
const fakeBuilderRow = {
  dataset: { id: '1' },
  querySelector: (sel) => builderInputs[sel] || null,
  querySelectorAll: () => []
};

const document = {
  getElementById: (id) => mockElement(id),
  querySelectorAll: (sel) => sel === '#batchReviewList .batch-row' ? [fakeRow]
    : sel === '#builderRows .builder-row' ? [fakeBuilderRow]
    : sel === '[data-trade-orders]' ? [] : [],
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
    const fn = new Function(...Object.keys(sandbox), code + '\nreturn { onBatchPreviewTpInput, renderBatchPreview, collectBatchTradesFromDom, buildExitLegs, batchVerifySent, collectBuilderTrades, renderBuilderOrdersPreview, sendTwsBuilderAll, brokerExitShares, tradeOrdersHtml, tradeExitStrategyId, tradeGroupKey, tradeGroups };');
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

    // Test 3: batchVerifySent — sent orderIds missing from the fresh orders
    // snapshot are flagged per-ticker (the post-ack-kill regression: an order can
    // be acked then cancelled by IB, leaving nothing resting in TWS).
    const legs = [
      { ticker: 'HQY', key: 'HQY:exits', ids: [101] },
      { ticker: 'VLY', key: 'VLY:exits', ids: [102, 103] },
    ];
    let v = res.batchVerifySent(legs, [{ orderId: 101 }]);
    assert(v.length === 1 && v[0].ticker === 'VLY', 'missing VLY legs flagged');
    assert(v[0].dead.length === 2 && v[0].key === 'VLY:exits', 'both dead orderIds reported with send key');
    v = res.batchVerifySent(legs, [{ orderId: 101 }, { orderId: 102 }, { orderId: 103 }]);
    assert(v.length === 0, 'all resting -> nothing flagged');
    v = res.batchVerifySent([], [{ orderId: 1 }]);
    assert(v.length === 0, 'no sent legs -> empty');
    v = res.batchVerifySent(legs, []);
    assert(v.length === 2, 'empty snapshot flags everything (caller guards on complete!==false)');

    // Test 4: broker-authoritative shares — a same-direction TWS position
    // overrides the row's frozen qty (the stale-shares regression: batch exits
    // used the qty from when the drawer was opened, not the live position).
    window.twsPositionFor = (t) => t === 'PLTR' ? { qty: 500, avgCost: 180 } : null;
    const c2 = res.collectBatchTradesFromDom();
    assert(c2.trades[0].shares === 500, 'same-direction broker qty overrides stale input, got ' + c2.trades[0].shares);
    assert(fakeInputs['.batch-shares'].value === 500, 'input updated to broker qty');
    fakeInputs['.batch-shares'].value = '67';      // reset row to stale qty
    window.twsPositionFor = () => ({ qty: -40 });  // wrong direction -> keep row value
    const c3 = res.collectBatchTradesFromDom();
    assert(c3.trades[0].shares === 67, 'opposite-direction position does not override');
    window.twsPositionFor = () => null;            // feed off -> keep row value
    const c4 = res.collectBatchTradesFromDom();
    assert(c4.trades[0].shares === 67, 'no position -> row value kept');

    // Test 5: collectBuilderTrades picks up builder rows with rowId + strategy.
    const b1 = res.collectBuilderTrades();
    assert(b1.length === 1, 'builder collects one row');
    assert(b1[0].ticker === 'PLTR' && b1[0].rowId === '1' && b1[0].strategyId === 'opt1', 'builder row fields');
    assert(b1[0].shares === 100 && b1[0].entry === 180 && b1[0].stop === 172, 'builder numeric fields');

    // Test 6: combined orders preview renders every leg (stop + targets) per row.
    res.renderBuilderOrdersPreview();
    const prevHtml = elements['builderPreviewBody'].innerHTML;
    assert(prevHtml.includes('PLTR'), 'preview shows ticker');
    assert(prevHtml.includes('STP 172.00'), 'preview shows stop leg');
    assert(prevHtml.includes('SELL 100') && prevHtml.includes('LMT'), 'preview shows action/qty + limit leg');

    // Test 7: sendTwsBuilderAll without a configured bridge errors, doesn't send.
    elements['errorToast'].innerText = '';
    await res.sendTwsBuilderAll();
    assert(elements['errorToast'].innerText.includes('TWS bridge not configured'), 'send-all guard reports missing bridge');

    // Test 8: brokerExitShares — same-direction broker qty wins, else DOM value.
    window.twsPositionFor = (t) => t === 'PLTR' ? { qty: 500 } : null;
    assert(res.brokerExitShares('PLTR', true, 100) === 500, 'long + long position -> broker qty');
    assert(res.brokerExitShares('PLTR', false, 100) === 100, 'short vs long position -> DOM qty');
    window.twsPositionFor = () => null;
    assert(res.brokerExitShares('PLTR', true, 100) === 100, 'no position -> DOM qty');

    // Test 9: tradeOrdersHtml renders every working order incl. bracket legs —
    // parent/OCA metadata goes on the chip title, empty list -> empty strip.
    const ords = [
      { orderId: 10, symbol: 'PLTR', action: 'SELL', qty: 100, type: 'STP', auxPrice: 172, status: 'Submitted', orderRef: 'PSC-PLTR-x-1', parentId: 0, ocaGroup: 'PLTR_opt1_L0' },
      { orderId: 11, symbol: 'PLTR', action: 'SELL', qty: 40, type: 'LMT', lmtPrice: 196.2, status: 'Submitted', orderRef: 'PSC-PLTR-x-2', parentId: 0, ocaGroup: 'PLTR_opt1_L0' },
      { orderId: 12, symbol: 'PLTR', action: 'BUY', qty: 100, type: 'MKT', status: 'PreSubmitted', orderRef: '', parentId: 9, ocaGroup: '' }
    ];
    const strip = res.tradeOrdersHtml({ ticker: 'PLTR' }, ords);
    assert(strip.includes('SELL 100 STP') && strip.includes('SELL 40 LMT') && strip.includes('BUY 100 MKT'), 'all three legs render');
    assert(strip.includes('OCA PLTR_opt1_L0'), 'OCA group surfaces in title');
    assert(strip.includes('child of #9'), 'bracket parent link surfaces in title');
    assert(strip.includes('PreSubmitted'), 'status shown');
    assert(res.tradeOrdersHtml({ ticker: 'PLTR' }, []) === '', 'no orders -> empty strip');

    // Test 10: tradeExitStrategyId — real stored strategy wins; stale/missing ids
    // fall back to lspb for pullbacks, twsAutoSendStrategyId otherwise.
    assert(res.tradeExitStrategyId({ strategyId: 'lspb' }, 'v3', true) === 'lspb', 'stored lspb kept');
    assert(res.tradeExitStrategyId({ strategyId: 'pasted' }, 'pb', true) === 'lspb', 'pasted/non-strategy id -> lspb for pb');
    const autoId = res.tradeExitStrategyId({ strategyId: 'does-not-exist' }, 'v3', true);
    assert(typeof autoId === 'string' && autoId.length > 0 && autoId !== 'does-not-exist', 'stale id -> resolved default');

    // Test 11: tradeGroupKey/tradeGroups — QLD sleeve, LS Pullback (sleeve or
    // strategyId lspb), everything else falls into the LS v3 bucket; group
    // order pins QLD first, then v3, then pb.
    assert(res.tradeGroupKey({ sleeve: 'QLD' }) === 'qld', 'QLD sleeve -> qld');
    assert(res.tradeGroupKey({ sleeve: 'LS Pullback' }) === 'pb', 'pb sleeve -> pb');
    assert(res.tradeGroupKey({ strategyId: 'lspb' }) === 'pb', 'lspb strategyId -> pb');
    assert(res.tradeGroupKey({ sleeve: 'LS v3', strategyId: 'opt1' }) === 'v3', 'opt1 -> v3');
    assert(res.tradeGroupKey({}) === 'v3', 'no markers -> v3');
    const grp = res.tradeGroups([
      { ticker: 'A', sleeve: 'LS Pullback' },
      { ticker: 'B' },
      { ticker: 'QLD', sleeve: 'QLD' },
      { ticker: 'C', strategyId: 'short16' },
    ]);
    assert(grp.map(g => g.key).join(',') === 'qld,v3,pb', 'group order qld,v3,pb — got ' + grp.map(g => g.key).join(','));
    assert(grp[1].trades.map(t => t.ticker).join(',') === 'B,C', 'v3 bucket keeps log order');
    assert(res.tradeGroups([]).length === 0, 'empty -> no groups');

    console.log('Batch TP tests passed!');
    process.exit(0);
  } catch (e) {
    console.error('Batch TP test failed:', e);
    process.exit(1);
  }
})();
