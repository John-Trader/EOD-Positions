// Live-data tests: RTH-only HOD/LOD updates, zero guards, REST resync merge, voice transitions.
const fs = require('fs');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const code = h.slice(h.indexOf('<script>') + 8, h.lastIndexOf('</script>'));

// Controllable clock: FakeDate() with no args returns `fakeNow`.
let fakeNow = Date.parse('2026-09-01T18:00:00Z'); // 14:00 ET, RTH
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(fakeNow); else super(...a); }
  static now() { return fakeNow; }
}

const elements = {};
function mockElement(id) {
  if (!elements[id]) elements[id] = {
    id, innerText: '', innerHTML: '', value: id === 'apiProvider' ? 'finnhub' : (id === 'riskValue' ? '500' : ''), className: '', dataset: {}, style: {}, children: [],
    classList: { add: (...c) => { elements[id].className += ' ' + c.join(' '); }, remove: (...c) => { c.forEach(cls => elements[id].className = elements[id].className.replace(new RegExp('\\b' + cls + '\\b', 'g'), '').trim()); }, contains: (c) => elements[id].className.includes(c), toggle: () => {} },
    querySelectorAll: () => [], querySelector: () => null, appendChild: () => {}, removeChild: () => {}, insertAdjacentHTML: () => {}, addEventListener: () => {}, setAttribute: () => {}, click: () => {}, remove: () => {}
  };
  return elements[id];
}
const spoken = [];
const document = { getElementById: mockElement, querySelectorAll: () => [], querySelector: () => null, createElement: () => mockElement('e' + Math.random()), addEventListener: () => {}, body: mockElement('body') };
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const window = { speechSynthesis: { speak: (u) => spoken.push(u.text), cancel: () => {} }, addEventListener: () => {} };
class SpeechSynthesisUtterance { constructor(t) { this.text = t; } }
const navigator = { clipboard: { writeText: () => Promise.resolve() } };
const sandbox = { elements, document, localStorage, window, navigator, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval, alert: () => {}, confirm: () => true, prompt: () => null, Date: FakeDate, SpeechSynthesisUtterance };
const fn = new Function(...Object.keys(sandbox), code + `
  return { realtimeQuotes, applyLivePrice, mergeRestQuote, nyNow, speakResults, announceTriggerTransitions, toggleVoice, setTriggerState: (s) => { triggerActiveState = s; }, getTriggerState: () => triggerActiveState };`);
const api = fn(...Object.values(sandbox));
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };

try {
  assert(api.nyNow().isRTH, 'fixture time is RTH');
  api.realtimeQuotes['AAA'] = { c: 100, h: 101, l: 99, pc: 98, bid: null, ask: null };

  // RTH: HOD/LOD move
  assert(api.applyLivePrice('AAA', 102), 'apply ok');
  assert(api.realtimeQuotes['AAA'].h === 102 && api.realtimeQuotes['AAA'].c === 102, 'HOD moved during RTH');
  api.applyLivePrice('AAA', 98.5);
  assert(api.realtimeQuotes['AAA'].l === 98.5, 'LOD moved during RTH');

  // After hours: last price moves, HOD/LOD frozen
  fakeNow = Date.parse('2026-09-01T20:30:00Z'); // 16:30 ET
  assert(!api.nyNow().isRTH, '16:30 ET not RTH');
  api.applyLivePrice('AAA', 110);
  assert(api.realtimeQuotes['AAA'].c === 110, 'last price updates after hours');
  assert(api.realtimeQuotes['AAA'].h === 102 && api.realtimeQuotes['AAA'].l === 98.5, 'HOD/LOD frozen after hours');
  api.applyLivePrice('AAA', 90);
  assert(api.realtimeQuotes['AAA'].l === 98.5, 'LOD frozen after hours (down print)');

  // Bad prints ignored
  assert(!api.applyLivePrice('AAA', NaN) && !api.applyLivePrice('AAA', 0) && !api.applyLivePrice('ZZZ', 5), 'invalid prints rejected');

  // Zero HOD/LOD from a bad baseline gets replaced, not clamped to 0
  fakeNow = Date.parse('2026-09-01T18:00:00Z');
  api.realtimeQuotes['BBB'] = { c: 50, h: 0, l: 0, pc: 49, bid: null, ask: null };
  api.applyLivePrice('BBB', 50.5);
  assert(api.realtimeQuotes['BBB'].h === 50.5 && api.realtimeQuotes['BBB'].l === 50.5, 'zero h/l replaced by first valid print');

  // Resync merge: socket quiet -> REST close wins; widens h/l; never narrows
  api.realtimeQuotes['CCC'] = { c: 20, h: 21, l: 19, pc: 18, bid: null, ask: null };
  let changed = api.mergeRestQuote('CCC', { c: 20.4, h: 21.5, l: 19.5, pc: 18.2, bid: 20.3, ask: 20.5 });
  const q = api.realtimeQuotes['CCC'];
  assert(changed && q.c === 20.4 && q.h === 21.5 && q.l === 19 && q.pc === 18.2 && q.bid === 20.3, 'resync merged (quiet socket takes REST close, LOD kept lower)');
  api.applyLivePrice('CCC', 20.6); // socket active now
  changed = api.mergeRestQuote('CCC', { c: 20.1, h: 21.5, l: 19, pc: 18.2, bid: null, ask: null });
  assert(api.realtimeQuotes['CCC'].c === 20.6, 'live close kept when socket is active');

  // Voice transitions: only inactive -> active speaks
  api.toggleVoice(); spoken.length = 0;
  const mk = (c) => ({ ticker: 'AAA', trigger: 105, success: true, data: { c, h: 106, l: 99, pc: 98, bid: null, ask: null } });
  api.setTriggerState({});
  api.announceTriggerTransitions([mk(104)], new Set(['AAA']), 500, 0);
  assert(spoken.length === 0, 'below trigger: silent');
  api.announceTriggerTransitions([mk(105.2)], new Set(['AAA']), 500, 0);
  assert(spoken.length === 1 && /AAA\. Long Trigger Active/.test(spoken[0]), 'crossing trigger speaks once');
  api.announceTriggerTransitions([mk(105.5)], new Set(['AAA']), 500, 0);
  assert(spoken.length === 1, 'staying active does not re-speak');
  api.announceTriggerTransitions([mk(104.9)], new Set(['AAA']), 500, 0);
  api.announceTriggerTransitions([mk(105.1)], new Set(['AAA']), 500, 0);
  assert(spoken.length === 2, 're-crossing speaks again');

  console.log('Live-data tests passed!');
  process.exit(0);
} catch (e) {
  console.error('Live test failed:', e.message);
  process.exit(1);
}
