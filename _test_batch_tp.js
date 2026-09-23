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
    const fn = new Function(...Object.keys(sandbox), code + '\nreturn { onBatchPreviewTpInput, renderBatchPreview, collectBatchTradesFromDom, buildExitLegs, batchVerifySent, collectBuilderTrades, renderBuilderOrdersPreview, sendTwsBuilderAll, brokerExitShares, tradeOrdersHtml, tradeExitStrategyId, tradeGroupKey, tradeGroups, builderPbTimed, portfolioOverviewStats };');
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
    assert(res.tradeGroupKey({ kind: 'pb' }) === 'pb', 'kind pb -> pb');
    assert(res.tradeGroupKey({ holdUnit: 'week' }) === 'pb', 'weekly hold -> pb');
    assert(res.tradeGroupKey({ regime: 'LS Pullback · 25% @1R + 75% timed' }) === 'pb', 'old pb regime name -> pb');
    assert(res.tradeGroupKey({ sleeve: 'QLD', holdUnit: 'week' }) === 'qld', 'QLD weekly stays qld');
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

    // Test 12: pb timed exits must honor the timedExitTime setting (default
    // '15:45' in this harness), not the old '15:55' hardcode.
    builderInputs['.b-opt'].value = 'lspb';
    builderInputs['.b-pb-exit-date'].value = '2027-01-05';
    const pbt = res.builderPbTimed(fakeBuilderRow);
    assert(pbt && pbt.timedExit && pbt.timedExit.time === '15:45', 'pb timed exit uses timedExitTime setting, got ' + (pbt && pbt.timedExit && pbt.timedExit.time));
    assert(pbt.timedExit.date === '2027-01-05' && pbt.holdUnit === 'day', 'pb timed exit keeps row date + day unit');
    builderInputs['.b-pb-cat'].value = 'week';
    assert(res.builderPbTimed(fakeBuilderRow).holdUnit === 'week', 'week cat -> week holdUnit');
    builderInputs['.b-opt'].value = 'opt1';
    builderInputs['.b-pb-cat'].value = 'day';
    builderInputs['.b-pb-exit-date'].value = '';

    // Test 13: portfolioOverviewStats — broker values when live (invested =
    // Σ|mktValue|), margin/bp/cash/P&L from the /account map, 210% cap math
    // excluding QLD, per-group notional split; journal fallback without broker.
    const tr = [
      { status: 'ACTIVE', shares: 100, entryPrice: 10, sleeve: 'QLD' },          // $1000
      { status: 'ACTIVE', shares: 50, entryPrice: 20 },                          // v3 $1000
      { status: 'ACTIVE', shares: 10, entryPrice: 30, sleeve: 'LS Pullback' },   // pb $300
      { status: 'CLOSED', shares: 999, entryPrice: 99 },                         // ignored
    ];
    const s1 = res.portfolioOverviewStats(tr, {
      positionsLive: true,
      positions: { AAA: { qty: 5, mktPrice: 100, mktValue: 500 }, BBB: { qty: -2, mktPrice: 50 } },
      accountValues: { NetLiquidation: '10000', MaintMarginReq: '3000', InitMarginReq: '4000', BuyingPower: '50000', AvailableFunds: '7000', TotalCashBalance: '1000', UnrealizedPnL: '250' },
      manualEquity: 8000,
      dailyPnL: -42.5,
    });
    assert(s1.netLiq === 10000 && s1.netLiqSrc === 'TWS', 'broker netliq wins over manual');
    assert(s1.invested === 600 && s1.investedSrc === 'broker' && s1.positionsCount === 2, 'invested = Σ|mktValue| with qty*mktPrice fallback, got ' + s1.invested);
    assert(s1.marginUsed === 3000 && s1.marginInit === 4000 && Math.abs(s1.marginPct - 0.3) < 1e-9, 'margin used + init + pct');
    assert(s1.buyingPower === 50000 && s1.availFunds === 7000 && s1.cash === 1000, 'bp/avail/cash');
    assert(s1.unrealized === 250 && s1.dailyPnl === -42.5, 'pnl fields');
    assert(s1.groups.qld.notional === 1000 && s1.groups.v3.notional === 1000 && s1.groups.pb.notional === 300, 'group split');
    assert(s1.bookedNotional === 1300 && Math.abs(s1.bookedPct - 0.13) < 1e-9, 'booked excludes QLD, pct vs netliq');

    const s2 = res.portfolioOverviewStats(tr.slice(0, 2), { manualEquity: 5000 });
    assert(s2.netLiq === 5000 && s2.netLiqSrc === 'manual', 'manual equity fallback');
    assert(s2.invested === 2000 && s2.investedSrc === 'journal' && s2.positionsCount === 2, 'journal invested incl QLD');
    assert(s2.marginUsed === null && s2.buyingPower === null && s2.unrealized === null, 'no broker cells without account map');
    assert(Math.abs(s2.bookedPct - 0.2) < 1e-9, 'booked pct vs manual equity');

    // Open P&L falls back to Σ per-position unrealizedPNL when the account tag
    // is absent (or account sync is off while the positions feed is live).
    const s2b = res.portfolioOverviewStats(tr, {
      positionsLive: true,
      positions: { AAA: { qty: 5, mktPrice: 100, mktValue: 500, unrealizedPNL: 30 }, BBB: { qty: -2, mktPrice: 50, unrealizedPNL: -12.5 } },
      accountValues: { NetLiquidation: '10000' },   // no UnrealizedPnL tag
      manualEquity: 8000,
    });
    assert(s2b.unrealized === 17.5, 'per-position P&L fallback sums, got ' + s2b.unrealized);
    const s2c = res.portfolioOverviewStats(tr, {
      positionsLive: true,
      positions: { AAA: { qty: 5, mktPrice: 100, mktValue: 500, unrealizedPNL: 30 } },
      manualEquity: 5000,
    });
    assert(s2c.unrealized === 30, 'positions-only unrealized without account map');
    assert(s2c.marginUsed === null && s2c.netLiqSrc === 'manual', 'margin stays unavailable without NetLiquidation');

    const s3 = res.portfolioOverviewStats([], {});
    assert(s3.netLiq === null && s3.netLiqSrc === 'none' && s3.bookedPct === null && s3.invested === 0, 'empty state is all unavailable');

    console.log('Batch TP tests passed!');
    process.exit(0);
  } catch (e) {
    console.error('Batch TP test failed:', e);
    process.exit(1);
  }
})();
