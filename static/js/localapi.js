/* BookBoom web: the in-page server.
 * Every api/ request is answered right here from IndexedDB (static/js/engine.js), so the app works
 * whether or not the service worker is running: first visit, hard refresh, private windows, and
 * when index.html is opened straight from a folder (file://). The service worker only keeps the
 * app files for offline use and receives PDFs shared to the installed app. Classic script. */
/* global KY */
(function () {
  'use strict';
  if (typeof KY === 'undefined') return;
  const origFetch = window.fetch.bind(window);
  const apiBase = () => new URL('api/', document.baseURI).href;
  const FAKE = 'https://ketabyar.local/api/';

  // returns the part after api/ when url points at this app's api, otherwise null
  function apiPath(input) {
    let href;
    try { href = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), document.baseURI).href; } catch { return null; }
    const base = apiBase();
    return href.startsWith(base) ? href.slice(base.length) : null;
  }

  async function handle(sub, init, original) {
    const u = new URL(sub, FAKE);
    const opts = {};
    const src = original && typeof original !== 'string' ? original : null;
    opts.method = (init && init.method) || (src && src.method) || 'GET';
    opts.headers = (init && init.headers) || (src && src.headers) || undefined;
    let body = init && init.body;
    if (body === undefined && src && !['GET', 'HEAD'].includes(opts.method)) body = await src.clone().blob();
    if (body !== undefined && body !== null && !['GET', 'HEAD'].includes(opts.method.toUpperCase())) opts.body = body;
    const req = new Request(u.href, opts);
    try { return await KY.handle(req, u.pathname.slice('/api/'.length), u); }
    catch (err) { return new Response(JSON.stringify({ error: String((err && err.message) || err) }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
  }

  window.fetch = function (input, init) {
    const sub = apiPath(input);
    if (sub === null) return origFetch(input, init);
    return handle(sub, init, input);
  };

  // <img src="api/...">, <audio src="api/..."> and friends: swap in a blob: url made from the same data
  const blobs = new Map();
  const ATTR = 'src';
  async function swap(el) {
    const raw = el.getAttribute(ATTR);
    if (!raw || el.dataset.kyApi === raw) return;
    const sub = apiPath(raw);
    if (sub === null) return;
    el.dataset.kyApi = raw;
    let url = blobs.get(raw);
    if (!url) {
      const r = await handle(sub, { method: 'GET' });
      if (!r.ok) { el.dispatchEvent(new Event('error')); return; }
      url = URL.createObjectURL(await r.blob());
      blobs.set(raw, url);
      if (blobs.size > 400) { const [k, v] = blobs.entries().next().value; blobs.delete(k); URL.revokeObjectURL(v); }
    }
    if (el.getAttribute(ATTR) === raw) { el.setAttribute(ATTR, url); el.dataset.kyApi = url; }
  }
  const SEL = 'img[src*="api/"],audio[src*="api/"],source[src*="api/"],video[src*="api/"]';
  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches && root.matches(SEL)) swap(root);
    root.querySelectorAll && root.querySelectorAll(SEL).forEach(swap);
  }
  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'attributes') scan(m.target);
      else m.addedNodes.forEach(scan);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  document.addEventListener('DOMContentLoaded', () => scan(document.documentElement));

  // links to api/ files (notes export etc.) download instead of navigating to a page that doesn't exist
  document.addEventListener('click', async e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.hasAttribute('data-dl')) return;
    const sub = apiPath(a.getAttribute('href'));
    if (sub === null) return;
    e.preventDefault();
    const r = await handle(sub, { method: 'GET' });
    if (!r.ok) return;
    const cd = r.headers.get('content-disposition') || '';
    let name = 'download';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
    if (m) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await r.blob()); link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  }, true);

  // the book's PDF as bytes, for pdf.js (works on http(s) and file:// alike)
  window.KYLocal = {
    async pdfData(url) {
      const r = await window.fetch(url);
      if (!r.ok) throw new Error('PDF not found on this device');
      return new Uint8Array(await r.arrayBuffer());
    },
    handle: (path, init) => handle(path, init),
  };
})();
