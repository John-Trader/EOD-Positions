const SCOPE_URL = new URL('./', self.registration.scope);
const CACHE_PREFIX = `positioncalc-shell-${encodeURIComponent(SCOPE_URL.pathname)}-`;
const CACHE_NAME = `${CACHE_PREFIX}v2.1.8`;
const HTML_URL = new URL('./index.html', SCOPE_URL).href;
const MANIFEST_URL = new URL('./manifest.webmanifest', SCOPE_URL).href;
const ICON_URL = new URL('./icon.svg', SCOPE_URL).href;
const TAILWIND_URL = 'https://cdn.tailwindcss.com/';
const SHELL_ASSETS = new Map([
  [SCOPE_URL.href, { key: HTML_URL, type: 'text/html', html: true }],
  [HTML_URL, { key: HTML_URL, type: 'text/html', html: true }],
  [MANIFEST_URL, { key: MANIFEST_URL, type: 'application/manifest+json' }],
  [ICON_URL, { key: ICON_URL, type: 'image/svg+xml' }]
]);
const PRIVATE_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'apikey', 'x-auth-token', 'x-finnhub-token'];

function isSafeShellResponse(response, url, asset) {
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return response.ok && !response.redirected && response.url === url && type === asset.type;
}

async function fetchTailwind() {
  const response = await fetch(new Request(TAILWIND_URL, {
    mode: 'no-cors',
    credentials: 'omit',
    cache: 'reload'
  }));
  if (response.type !== 'opaque' && !(response.ok && response.url === TAILWIND_URL && !response.redirected)) {
    throw new Error('Tailwind shell resource unavailable');
  }
  return response;
}

async function cachedResponse(key) {
  try {
    return await caches.match(key, { cacheName: CACHE_NAME });
  } catch {
    return undefined;
  }
}

async function storeResponse(key, response) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(key, response.clone());
  } catch {
    return;
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const entries = await Promise.all([HTML_URL, MANIFEST_URL, ICON_URL].map(async url => {
      const response = await fetch(new Request(url, { cache: 'reload', credentials: 'omit', redirect: 'error' }));
      if (!isSafeShellResponse(response, url, SHELL_ASSETS.get(url))) {
        throw new Error('App shell resource unavailable');
      }
      return [url, response];
    }).concat([fetchTailwind().then(response => [TAILWIND_URL, response])]));
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(entries.map(([url, response]) => cache.put(url, response)));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

async function networkFirstShell(request, asset) {
  let response;
  try {
    response = await fetch(request);
    if (isSafeShellResponse(response, request.url, asset)) {
      await storeResponse(asset.key, response);
    }
    if (response.ok || response.status < 500) return response;
  } catch {
    response = undefined;
  }
  const cached = await cachedResponse(asset.key);
  return cached || response || new Response('App shell unavailable offline. Open the app online once and try again.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function cachedTailwind() {
  const cached = await cachedResponse(TAILWIND_URL);
  if (cached) return cached;
  try {
    const response = await fetchTailwind();
    await storeResponse(TAILWIND_URL, response);
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.search || url.hash || url.username || url.password || PRIVATE_HEADERS.some(header => request.headers.has(header))) return;
  if (url.href === TAILWIND_URL && request.destination === 'script') {
    event.respondWith(cachedTailwind());
    return;
  }
  if (url.origin !== SCOPE_URL.origin) return;
  const asset = SHELL_ASSETS.get(url.href);
  if (!asset || (asset.html && request.mode !== 'navigate')) return;
  event.respondWith(networkFirstShell(request, asset));
});
