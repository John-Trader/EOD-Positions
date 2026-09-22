// Release-asset parity: the runtime modules must appear together in every
// surface that enumerates them — index.html script order, the bridge's static
// file map, _serve.js public files, electron-builder.yml whitelist, and the
// service worker's shell set. A module missing from any surface 404s offline
// or inside the packaged exe.
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAIL: ' + m); };

// Canonical public shell — everything the app needs to boot.
const SHELL = ['index.html', 'ledger.js', 'state-schema.js', 'state-store.js', 'sync.js', 'manifest.webmanifest', 'sw.js', 'icon.svg'];

try {
  // ---- index.html: script order (schema → store → sync → ledger) ----
  const html = read('index.html');
  const srcs = [...html.matchAll(/<script\s+src="\.\/([^"]+)"><\/script>/g)].map(m => m[1]);
  const order = ['state-schema.js', 'state-store.js', 'sync.js', 'ledger.js'];
  const idx = order.map(f => srcs.indexOf(f));
  assert(idx.every(i => i >= 0), 'index.html loads all state modules — got ' + srcs.join(','));
  assert(idx[0] < idx[1] && idx[1] < idx[2] && idx[2] < idx[3], 'script order schema→store→sync→ledger — got ' + srcs.join(','));

  // ---- tws-bridge static map ----
  const srv = read('tws-bridge/server.js');
  const mapBlock = /const STATIC_FILES = \{([\s\S]*?)\};/m.exec(srv)[1];
  const served = [...mapBlock.matchAll(/'\/[^']+':\s*'([^']+)'/g)].map(m => m[1]);
  SHELL.forEach(f => assert(served.includes(f), 'bridge serves ' + f));
  assert(served.every(f => SHELL.includes(f)), 'bridge serves only public shell — extra: ' + served.filter(f => !SHELL.includes(f)));

  // ---- _serve.js public files ----
  const serve = read('_serve.js');
  const pubBlock = /publicFiles = new Set\(\[([\s\S]*?)\]\)/.exec(serve)[1];
  const pub = [...pubBlock.matchAll(/'([^']+)'/g)].map(m => m[1]);
  SHELL.forEach(f => assert(pub.includes(f), '_serve.js publishes ' + f));
  assert(pub.every(f => SHELL.includes(f)), '_serve.js publishes only public shell — extra: ' + pub.filter(f => !SHELL.includes(f)));

  // ---- electron-builder.yml whitelist ----
  const yml = read('electron-builder.yml');
  SHELL.forEach(f => assert(yml.includes('- ' + f), 'builder ships ' + f));

  // ---- sw.js shell set ----
  const sw = read('sw.js');
  SHELL.filter(f => f !== 'index.html' && f !== 'sw.js').forEach(f => assert(sw.includes('./' + f), 'sw caches ' + f));
  // cache keys are limited to the canonical shell map — every SHELL_ASSETS entry
  // must point at one of the known asset URL constants, nothing else.
  const swMapBlock = /SHELL_ASSETS = new Map\(\[([\s\S]*?)\]\)/.exec(sw)[1];
  const urls = [...swMapBlock.matchAll(/(\w+_URL|SCOPE_URL)\.href/g)].map(m => m[1]);
  const allowed = new Set(['SCOPE_URL', 'HTML_URL', 'MANIFEST_URL', 'ICON_URL', 'LEDGER_URL', 'STATE_SCHEMA_URL', 'STATE_STORE_URL', 'SYNC_URL']);
  urls.forEach(u => assert(allowed.has(u), 'sw caches only shell assets — unexpected ' + u));
  // private/bearer requests must bypass the cache entirely
  assert(/PRIVATE_HEADERS\.some/.test(sw), 'sw skips requests carrying auth headers');
  assert(/x-psc-bridge/.test(sw), 'sw rejects token-injected bridge HTML');
  // scope-bounded cleanup only
  assert(/startsWith\(CACHE_PREFIX\)/.test(sw), 'sw prunes only its own cache prefix');

  console.log('_test_assets OK');
} catch (e) {
  console.error(e.stack || e);
  process.exit(1);
}
