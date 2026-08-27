const fs = require('fs');
const h = fs.readFileSync('C:/Users/levif/Desktop/End-of-day/index.html', 'utf8');

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
      addEventListener: () => {}
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

try {
  const sandbox = { elements, document, localStorage, window, console, setTimeout, clearTimeout, parseFloat, parseInt, Number, Array, Math, Date, String };
  const fn = new Function(...Object.keys(sandbox), code + '; return { openStrategyModal };');
  const res = fn(...Object.values(sandbox));
  console.log('Script loaded successfully');
  res.openStrategyModal('PLTR', true, 179.94, 67, 172.54, 172.55);
  console.log('openStrategyModal executed successfully!');
  console.log('strategyModalOverlay className after open:', elements['strategyModalOverlay'].className);
  console.log('modalOrdersCardsContainer innerHTML:', elements['modalOrdersCardsContainer'].innerHTML);
} catch (e) {
  console.error('Error during execution:', e);
}
