const fs = require('fs');
const h = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');

const start = h.indexOf('<script>');
const end = h.lastIndexOf('</script>');
const code = h.slice(start + 8, end);

const elements = {};
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
      appendChild: (ch) => elements[id].children.push(ch),
      addEventListener: () => {},
      setAttribute: (k, v) => { elements[id][k] = v; },
      getAttribute: (k) => elements[id][k]
    };
  }
  return elements[id];
}

const document = {
  getElementById: (id) => mockElement(id),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: (tag) => mockElement('elem_' + Math.random()),
  addEventListener: () => {}
};
const localStorage = {
  getItem: (k) => null,
  setItem: () => {}
};
const window = {
  speechSynthesis: { speak: () => {}, cancel: () => {} }
};
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };

try {
  const sandbox = { elements, document, localStorage, window, console, setTimeout, clearTimeout, parseFloat, parseInt, Number, Array, Math, Date, String };
  const fn = new Function(...Object.keys(sandbox), code + '; return { openStrategyModal, closeStrategyModal };');
  const res = fn(...Object.values(sandbox));

  const overlay = mockElement('strategyModalOverlay');
  assert(overlay.classList.contains('hidden'), 'overlay starts hidden');

  res.openStrategyModal('PLTR', true, 179.94, 67, 172.54, 172.55);
  assert(!overlay.classList.contains('hidden'), 'overlay unhidden after open');
  assert(overlay.style.display === 'flex', 'overlay display flex after open');

  const cards = elements['modalOrdersCardsContainer'].innerHTML;
  assert(cards.length > 0, 'order cards rendered');
  assert(!cards.includes('Unable to calculate orders'), 'no build error rendered');
  assert(cards.includes('SELL 67'), 'leg card carries the position size');
  assert(/STP \$(\d)/.test(cards), 'leg card renders a stop leg');
  assert(cards.includes('LMT'), 'leg card renders a target leg');
  assert(cards.includes('PLTR'), 'leg card names the ticker');

  res.closeStrategyModal();
  assert(overlay.classList.contains('hidden'), 'overlay hidden after close');
  assert(overlay.style.display === 'none', 'overlay display none after close');

  console.log('modal tests passed');
  process.exit(0);
} catch (e) {
  console.error('Error during execution:', e);
  process.exit(1);
}
