// BookBoom web version: service worker.
// It keeps the app files for offline use (and makes the app installable), receives PDFs shared to the installed
// app, and answers api/ requests that reach the network layer (<img>/<audio> sources before the page swaps them,
// links opened in a new tab). The page itself answers every api/ fetch (static/js/localapi.js), so the app works
// without it too. The cache name carries a hash of the build: every new build installs a complete, consistent copy.
importScripts('static/vendor/fflate.min.js', 'static/js/engine.js');
const CACHE = 'bookboom-web-3.12.0-5c82a1c8a2';
const SHELL = ["./", "index.html", "manifest.webmanifest", "static/css/app.css", "static/fonts/Fraunces-Variable.woff2", "static/fonts/Inter-Variable.woff2", "static/fonts/Vazirmatn-Variable.woff2", "static/img/icon-192.png", "static/img/icon-512.png", "static/img/icon-96.png", "static/img/icon-maskable-192.png", "static/img/icon-maskable-512.png", "static/img/icon.svg", "static/js/app.bundle.js", "static/js/boot.js", "static/js/engine.js", "static/js/localapi.js", "static/js/web-boot.js", "static/vendor/fflate.min.js", "static/vendor/pdfjs/pdf.worker.min.mjs", "static/vendor/pdfjs/pdfjs-data.js"];
const BASE = new URL('./', self.location).href;          // works at a domain root or in a sub-folder (GitHub Pages)
const APP = BASE;                                          // the cached app page (index.html is stored under this address too)
const API = new URL('api/', BASE).pathname;
const SHARE = new URL('share-target', BASE).pathname;
const APP_PATHS = [new URL(BASE).pathname, new URL('index.html', BASE).pathname];

// only complete (200), same-origin responses are kept. Hosts that redirect (Cloudflare Pages sends /index.html
// to /) give a "redirected" response, which a browser refuses to show for a page load, so it is stored as a plain copy.
async function storable(r) {
  if (!r || r.status !== 200 || r.type !== 'basic') return null;
  if (!r.redirected) return r;
  return new Response(await r.blob(), { status: 200, statusText: r.statusText, headers: r.headers });
}
const offline = () => new Response('BookBoom is offline and this file was not saved for offline use yet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(async p => {
      const u = new URL(p, BASE).href;
      const r = await storable(await fetch(new Request(u, { cache: 'reload' })));
      if (!r) throw new Error('could not save ' + p + ' for offline use');
      await c.put(u, r);
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => (k.startsWith('bookboom-web-') || k.startsWith('ketabyar-web-')) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return;
  if (u.pathname.startsWith(API)) {
    // The page never navigates to api/ with a form. Another website can (a cross-site form post opens it as a
    // page, and this worker would answer it): that must never change the library (restore, import, settings...).
    if (req.mode === 'navigate' && req.method !== 'GET' && req.method !== 'HEAD') { e.respondWith(new Response('Forbidden', { status: 403 })); return; }
    e.respondWith(KY.handle(req, u.pathname.slice(API.length), u).catch(err => new Response(JSON.stringify({ error: String(err && err.message || err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  if (u.pathname === SHARE && req.method === 'POST') { e.respondWith(KY.shareTarget(req, BASE)); return; }
  if (req.method !== 'GET' || req.headers.has('range')) return;  // partial (206) responses can't be cached: leave them to the network
  if (req.mode === 'navigate') {
    if (APP_PATHS.includes(u.pathname)) {
      // the app page, whatever its ?query (start_url ?source=pwa, ?open-file=1, ?shared=none): offline-first
      e.respondWith(caches.open(CACHE).then(c => c.match(APP)).then(hit => hit || fetch(req).catch(offline)));
    } else {
      // any other page in this folder (README.md, ...) is not the app: network first, saved copy when offline
      e.respondWith(fetch(req).catch(async () => (await caches.match(req, { cacheName: CACHE })) || offline()));
    }
    return;
  }
  // app files: from this version's cache; anything not in it yet is fetched once and kept for offline use
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req);
    if (hit) return hit;
    const r = await fetch(req);
    if (r.status === 200 && r.type === 'basic' && !r.redirected) e.waitUntil(c.put(req, r.clone()).catch(() => {}));
    return r;
  })());
});
