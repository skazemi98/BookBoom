// BookBoom web version: this service worker is the app's server.
// It keeps the app files for offline use, receives PDFs shared to the installed app, and answers api/ requests
// from IndexedDB on this device (the page normally answers those itself, see static/js/localapi.js).
importScripts('static/vendor/fflate.min.js', 'static/js/engine.js');
const CACHE = 'bookboom-web-2.1.0';
const SHELL = ["./", "index.html", "manifest.webmanifest", "static/css/app.css", "static/fonts/Inter-Variable.woff2", "static/fonts/Vazirmatn-Variable.woff2", "static/img/icon-192.png", "static/img/icon-512.png", "static/img/icon-96.png", "static/img/icon-maskable-192.png", "static/img/icon-maskable-512.png", "static/img/icon.svg", "static/js/app.bundle.js", "static/js/boot.js", "static/js/engine.js", "static/js/localapi.js", "static/js/web-boot.js", "static/vendor/fflate.min.js", "static/vendor/pdfjs/pdf.worker.min.mjs", "static/vendor/pdfjs/pdfjs-data.js"];
const BASE = new URL('./', self.location).href;          // works at a domain root or in a sub-folder (GitHub Pages)
const API = new URL('api/', BASE).pathname;
const SHARE = new URL('share-target', BASE).pathname;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(p => new Request(new URL(p, BASE), { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => (k.startsWith('bookboom-web-') || k.startsWith('ketabyar-web-')) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  if (u.pathname.startsWith(API)) {
    e.respondWith(KY.handle(e.request, u.pathname.slice(API.length), u).catch(err => new Response(JSON.stringify({ error: String(err && err.message || err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  if (u.pathname === SHARE && e.request.method === 'POST') { e.respondWith(KY.shareTarget(e.request, BASE)); return; }
  if (e.request.method !== 'GET') return;
  // app files: cache first (instant + offline), refreshed in the background
  e.respondWith(caches.open(CACHE).then(async c => {
    const key = e.request.mode === 'navigate' ? new URL('index.html', BASE).href : e.request;
    const hit = await c.match(key, { ignoreSearch: e.request.mode === 'navigate' });
    const net = fetch(e.request).then(r => { if (r.ok && r.type === 'basic') c.put(key, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || new Response('Offline', { status: 503 });
  }));
});
