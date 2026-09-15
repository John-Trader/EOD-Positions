(async () => {
const fs = require('fs');
const h = fs.readFileSync('C:/Users/levif/Desktop/End-of-day/index.html', 'utf8');

const start = h.indexOf('<script>');
const end = h.lastIndexOf('</script>');
const code = h.slice(start + 8, end);

// DOM-ish element with real child semantics (querySelector recurses, appendChild
// moves existing nodes, insertBefore works, remove() splices from parent).
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: '', innerText: '', _innerHTML: '', value: '', checked: false, className: '',
    style: {}, children: [], dataset: {}, title: '', disabled: false, parent: null,
    get innerHTML() { return el._innerHTML; },
    set innerHTML(v) { el._innerHTML = v; if (v === '') el.children.forEach(c => c.parent = null), el.children = []; },
    get firstChild() { return el.children[0] || null; },
    classList: {
      add: (...c) => { c.forEach(cls => { if (!el.className.split(/\s+/).includes(cls)) el.className = (el.className + ' ' + cls).trim(); }); },
      remove: (...c) => { c.forEach(cls => { el.className = el.className.split(/\s+/).filter(x => x && x !== cls).join(' '); }); },
      contains: (c) => el.className.split(/\s+/).includes(c),
      toggle: (c, on) => { if (on === undefined) on = !el.classList.contains(c); if (on) el.classList.add(c); else el.classList.remove(c); }
    },
    appendChild: (ch) => {
      if (!ch) return ch;
      if (ch.parent) { const i = ch.parent.children.indexOf(ch); if (i >= 0) ch.parent.children.splice(i, 1); }
      ch.parent = el; el.children.push(ch); return ch;
    },
    insertBefore: (ch, ref) => {
      if (!ch) return ch;
      if (ch.parent) { const i = ch.parent.children.indexOf(ch); if (i >= 0) ch.parent.children.splice(i, 1); }
      const i = ref ? el.children.indexOf(ref) : -1;
      ch.parent = el;
      if (i < 0) el.children.push(ch); else el.children.splice(i, 0, ch);
      return ch;
    },
    remove: () => { if (el.parent) { const i = el.parent.children.indexOf(el); if (i >= 0) el.parent.children.splice(i, 1); el.parent = null; } },
    addEventListener: () => {},
    setAttribute: (k, v) => { if (k.startsWith('data-')) el.dataset[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = v; else el[k] = v; },
    getAttribute: (k) => el.dataset[k] !== undefined ? el.dataset[k] : el[k],
    textContent: '',
  };
  const match = (node, sel) => {
    if (!node || !sel) return false;
    if (sel[0] === '#') return node.id === sel.slice(1);
    if (sel[0] === '.') return (node.className || '').split(/\s+/).includes(sel.slice(1));
    const m = sel.match(/^\[data-([a-zA-Z-]+)="([^"]+)"\]$/);
    if (m) { const key = m[1].replace(/-([a-z])/g, (mm, c) => c.toUpperCase()); return node.dataset[key] === m[2]; }
    return false;
  };
  const walk = (node, pred, out) => {
    for (const ch of node.children) { if (pred(ch)) out.push(ch); walk(ch, pred, out); }
    return out;
  };
  el.querySelector = (sel) => walk(el, (n) => match(n, sel), [])[0] || null;
  el.querySelectorAll = (sel) => walk(el, (n) => match(n, sel), []);
  return el;
}

const elements = {};
function mockElement(id) {
  if (!elements[id]) elements[id] = Object.assign(makeEl('div'), { id });
  return elements[id];
}

const document = {
  getElementById: (id) => mockElement(id),
  querySelectorAll: () => [], querySelector: () => null,
  createElement: (tag) => makeEl(tag),
  addEventListener: () => {}, hidden: false, body: makeEl('body')
};
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
const location = { protocol: 'http:', hostname: 'localhost', href: 'http://localhost:8080/' };
const fetch = async () => { throw new Error('no fetch in test'); };
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
  const fn = new Function(...Object.keys(sandbox), code + '; return { pbSortRank, renderPbSection, renderV3Section, pbCatOf, PB_CATS, set currentPage(v) { currentPage = v; }, set currentViewMode(v) { currentViewMode = v; }, get currentViewMode() { return currentViewMode; } };');
  const api = fn(...Object.values(sandbox));

  const quote = { c: 100, h: 101, l: 99, pc: 98, bid: 99.9, ask: 100.1 };
  const pb = (ticker, tf, cat) => ({ ticker, kind: 'pb', tf, cat: cat || 'auto', success: true, data: { ...quote } });

  // ---- pbCatOf / pbSortRank ----
  assertEq(api.pbCatOf(pb('SPY', 'weekly')), 'etf_w', 'SPY weekly -> etf_w');
  assertEq(api.pbCatOf(pb('GOOG', 'weekly')), 'nas_w', 'GOOG weekly -> nas_w');
  assertEq(api.pbCatOf(pb('XLE', 'daily')), 'etf_d', 'XLE daily -> etf_d');
  assertEq(api.pbCatOf(pb('MSFT', 'daily')), null, 'MSFT daily -> no category');
  assertEq(api.pbCatOf({ ticker: 'ZZZ', tf: 'weekly', cat: 'etf_w' }), 'etf_w', 'explicit cat honored');

  const rEtfW = api.pbSortRank(pb('SPY', 'weekly'));
  const rNasW = api.pbSortRank(pb('GOOG', 'weekly'));
  const rEtfD = api.pbSortRank(pb('XLE', 'daily'));
  const rNoCat = api.pbSortRank(pb('MSFT', 'daily'));
  const rNoTf = api.pbSortRank({ ticker: 'ABC', kind: 'pb', tf: null, cat: 'auto' });
  assertTrue(rEtfW < rNasW && rNasW < rEtfD && rEtfD < rNoCat && rNoCat < rNoTf,
    `rank order weeklyETF<weeklyNAS<dailyETF<dailyNoCat<noTF (${rEtfW},${rNasW},${rEtfD},${rNoCat},${rNoTf})`);

  // ---- renderPbSection: weekly first (ETF then NAS), then daily ETF, then rest ----
  api.currentPage = 'scanner';
  api.currentViewMode = 'cards';
  const cont = makeEl('div');
  const shuffled = [
    pb('MSFT', 'daily'),            // uncategorized daily
    pb('GOOG', 'weekly'),           // weekly NAS
    pb('ABC', null),                // no tf -> last
    pb('SPY', 'weekly'),            // weekly ETF
    pb('XLE', 'daily'),             // daily ETF
  ];
  api.renderPbSection(shuffled, 0.05, cont);

  const sec = cont.children.find(c => c.dataset.role === 'pbSection');
  assertTrue(!!sec, 'pbSection wrapper exists');
  const hdr = sec.children.find(c => (c.className || '').includes('pb-hdr'));
  assertTrue(!!hdr && hdr.innerHTML.includes('LS Pullback') && hdr.innerHTML.includes('5 signals'), 'pb header text');
  const wrap = sec.children.find(c => (c.className || '').includes('pb-wrap'));
  const order1 = wrap.children.map(c => c.id);
  assertEq(order1, ['pbcard-SPY', 'pbcard-GOOG', 'pbcard-XLE', 'pbcard-MSFT', 'pbcard-ABC'], 'pb card order = weeklyETF, weeklyNAS, dailyETF, dailyNoCat, noTF');

  // Re-render with different input order -> existing cards re-ordered, no dupes
  api.renderPbSection([pb('XLE', 'daily'), pb('SPY', 'weekly'), pb('ABC', null), pb('GOOG', 'weekly'), pb('MSFT', 'daily')], 0.05, cont);
  const wrap2 = sec.children.find(c => (c.className || '').includes('pb-wrap'));
  const order2 = wrap2.children.map(c => c.id);
  assertEq(order2, order1, 're-render re-sorts existing cards without duplicates');
  assertEq(cont.children.filter(c => c.dataset.role === 'pbSection').length, 1, 'still exactly one pbSection');

  // pending shell -> success: placeholder must be replaced by a real card, not stuck
  api.renderPbSection([{ ...pb('SPY', 'weekly'), success: false, pending: true, error: 'Waiting for live quote...' }], 0.05, cont);
  let spyNode = wrap.querySelector('#pbcard-SPY');
  assertTrue(!!spyNode && spyNode.dataset.shell === 'pending', 'pending shell rendered for SPY');
  api.renderPbSection([pb('SPY', 'weekly')], 0.05, cont);
  spyNode = wrap.querySelector('#pbcard-SPY');
  assertTrue(!!spyNode && !spyNode.dataset.shell && spyNode.innerHTML.includes('data-field'), 'pending shell replaced by real pb card');
  assertEq(wrap.children.filter(c => c.id === 'pbcard-SPY').length, 1, 'no duplicate pb card after pending->success');

  // Table view ordering
  api.currentViewMode = 'table';
  api.renderPbSection(shuffled, 0.05, cont);
  const tw = sec.querySelector('#pbTableWrap');
  assertTrue(!!tw, 'pbTableWrap exists in table mode');
  assertEq(tw.children.map(c => c.id), ['pbrow-SPY', 'pbrow-GOOG', 'pbrow-XLE', 'pbrow-MSFT', 'pbrow-ABC'], 'pb table rows sorted');
  assertTrue(!sec.querySelector('#pbcard-SPY'), 'table mode has no stray pb cards');

  // pb table pending->success: shell card inside tw removed, row created, no dupes
  api.renderPbSection([{ ...pb('QQQ', 'weekly'), success: false, pending: true, error: 'Waiting for live quote...' }], 0.05, cont);
  assertTrue(!!tw.querySelector('#pbcard-QQQ'), 'pb table shows pending shell');
  api.renderPbSection([{ ...pb('QQQ', 'weekly'), success: false, pending: true, error: 'Waiting for live quote...' }], 0.05, cont);
  assertEq(tw.children.filter(c => c.id === 'pbcard-QQQ').length, 1, 're-render does not duplicate pending shell');
  api.renderPbSection([pb('QQQ', 'weekly')], 0.05, cont);
  assertTrue(!!tw.querySelector('#pbrow-QQQ'), 'pb row appears after pending->success');
  assertTrue(!tw.querySelector('#pbcard-QQQ'), 'pending shell removed after pbrow created');

  // lsv3 page suppresses the pb section entirely
  api.currentViewMode = 'cards';
  api.currentPage = 'lsv3';
  api.renderPbSection(shuffled, 0.05, cont);
  assertTrue(!cont.querySelector('[data-role="pbSection"]'), 'pbSection removed on lsv3 page');
  api.currentPage = 'scanner';

  // ---- renderV3Section header ----
  const v3 = [{ ticker: 'AAPL', kind: 'v3', success: true, trigger: 105, data: { ...quote } }];
  api.renderV3Section(v3, 1000, 0.05, cont);
  let v3hdr = cont.children.find(c => (c.className || '').includes('v3-hdr'));
  assertTrue(!!v3hdr, 'v3 header exists');
  assertTrue(v3hdr.innerHTML.includes('LS v3 Breakout') && v3hdr.innerHTML.includes('1 signal'), 'v3 header text + count');
  assertTrue(cont.children[0] === v3hdr, 'v3 header is first child (above cards and pbSection)');
  assertTrue(!!cont.querySelector('#card-AAPL'), 'v3 card still rendered below header');

  // idempotent re-render: still one header, still on top
  api.renderV3Section(v3, 1000, 0.05, cont);
  assertEq(cont.children.filter(c => (c.className || '').includes('v3-hdr')).length, 1, 'v3 header not duplicated');
  assertTrue(cont.children[0] === v3hdr, 'v3 header stays first on re-render');

  // error v3 items still render as cards under the header
  api.renderV3Section([{ ticker: 'BAD', kind: 'v3', success: false, error: 'no quote' }], 1000, 0.05, cont);
  assertEq(cont.children[0].className.includes('v3-hdr'), true, 'header first with error card');
  assertTrue(!!cont.querySelector('#card-BAD'), 'error card rendered');
  assertTrue(cont.querySelector('#card-BAD').parent === cont, 'error card is a direct container child');

  // empty results -> header removed
  api.renderV3Section([], 1000, 0.05, cont);
  assertTrue(!cont.children.some(c => (c.className || '').includes('v3-hdr')), 'v3 header removed when no results');
  assertTrue(!cont.querySelector('#card-BAD'), 'stale error card cleaned up');

  // table mode: header still on top, tableWrap below it
  api.currentViewMode = 'table';
  api.renderV3Section(v3, 1000, 0.05, cont);
  v3hdr = cont.children.find(c => (c.className || '').includes('v3-hdr'));
  assertTrue(!!v3hdr && cont.children[0] === v3hdr, 'v3 header first in table mode');
  assertTrue(!!cont.querySelector('#tableWrap'), 'tableWrap present in table mode');
  assertTrue(!!cont.querySelector('#table-row-AAPL'), 'v3 table row rendered');

  // v3 pending->success in card mode: shell replaced by a real card
  api.currentViewMode = 'cards';
  api.renderV3Section([{ ticker: 'MSFT', kind: 'v3', success: false, pending: true, error: 'Waiting for live quote...' }], 1000, 0.05, cont);
  let m = cont.querySelector('#card-MSFT');
  assertTrue(!!m && m.dataset.shell === 'pending', 'v3 pending shell rendered');
  api.renderV3Section([{ ticker: 'MSFT', kind: 'v3', success: true, trigger: 400, data: { ...quote } }], 1000, 0.05, cont);
  m = cont.querySelector('#card-MSFT');
  assertTrue(!!m && !m.dataset.shell && m.innerHTML.includes('data-field'), 'v3 pending shell replaced by real card');
  assertEq(cont.children.filter(c => c.id === 'card-MSFT').length, 1, 'no duplicate v3 card after pending->success');
  assertTrue(cont.children[0].className.includes('v3-hdr'), 'v3 header still first after transitions');

  // ---- v3 content must stay above an existing pbSection (progressive-render order) ----
  const cont2 = makeEl('div');
  api.renderPbSection([pb('SPY', 'weekly')], 0.05, cont2);
  assertTrue(!!cont2.querySelector('[data-role="pbSection"]'), 'pbSection pre-exists');
  api.renderV3Section(v3, 1000, 0.05, cont2);
  let kids = cont2.children;
  let pbIdx = kids.findIndex(c => c.dataset.role === 'pbSection');
  let cardIdx = kids.findIndex(c => c.id === 'card-AAPL');
  assertTrue(cardIdx >= 0 && pbIdx >= 0 && cardIdx < pbIdx, 'v3 card lands above pbSection');
  assertTrue(kids[0].className.includes('v3-hdr'), 'v3 header first with pbSection present');

  // a new v3 card on a later render also stays above pbSection
  api.renderV3Section([...v3, { ticker: 'TSLA', kind: 'v3', success: true, trigger: 250, data: { ...quote } }], 1000, 0.05, cont2);
  kids = cont2.children;
  pbIdx = kids.findIndex(c => c.dataset.role === 'pbSection');
  const tslaIdx = kids.findIndex(c => c.id === 'card-TSLA');
  assertTrue(tslaIdx >= 0 && tslaIdx < pbIdx, 'late v3 card stays above pbSection');

  // v3 pending/error shells also stay above pbSection
  api.renderV3Section([...v3, { ticker: 'TSLA', kind: 'v3', success: true, trigger: 250, data: { ...quote } },
    { ticker: 'SLOW', kind: 'v3', success: false, pending: true, error: 'Waiting for live quote...' }], 1000, 0.05, cont2);
  kids = cont2.children;
  pbIdx = kids.findIndex(c => c.dataset.role === 'pbSection');
  const slowIdx = kids.findIndex(c => c.id === 'card-SLOW');
  assertTrue(slowIdx >= 0 && slowIdx < pbIdx, 'v3 pending shell stays above pbSection');

  // table mode: tableWrap stays above pbSection too
  api.currentViewMode = 'table';
  api.renderV3Section(v3, 1000, 0.05, cont2);
  kids = cont2.children;
  pbIdx = kids.findIndex(c => c.dataset.role === 'pbSection');
  const twIdx = kids.findIndex(c => c.id === 'tableWrap');
  assertTrue(twIdx >= 0 && twIdx < pbIdx, 'tableWrap stays above pbSection');
  api.currentViewMode = 'cards';

  console.log('\nSection ordering/header tests passed');
} catch (e) {
  console.error('Unexpected error:', e);
  process.exit(1);
}
})();
