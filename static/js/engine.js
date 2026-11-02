/* BookBoom in-browser server.
 * Used by the stand-alone web version (no Python): the service worker answers every api/ request
 * from IndexedDB on the device, with the same JSON the Python server returns.
 * Classic script (loaded with importScripts); needs fflate for backups. */
/* global fflate */
'use strict';
const KY = (() => {
  const VERSION = '3.12.0';
  const DB_NAME = 'ketabyar';
  const STORES = {
    books: { keyPath: 'id', autoIncrement: true, idx: [['sha256', 'sha256', { unique: true }]] },
    files: {}, covers: {},
    pagetext: { keyPath: ['book_id', 'page'], idx: [['book', 'book_id']] },
    notes: { keyPath: 'id', autoIncrement: true, idx: [['book', 'book_id']] },
    bookmarks: { keyPath: 'id', autoIncrement: true, idx: [['book', 'book_id']] },
    cards: { keyPath: 'id', autoIncrement: true, idx: [['book', 'book_id']] },
    reviews: { keyPath: 'id', autoIncrement: true, idx: [['card', 'card_id']] },
    activity: { keyPath: ['day', 'book_id'], idx: [['book', 'book_id']] },
    settings: {},
    ink: { keyPath: ['book_id', 'page'], idx: [['book', 'book_id']] },
    lookup_history: { keyPath: 'q' },
    lookup_cache: { keyPath: ['kind', 'q'] },
    recordings: { keyPath: ['book_id', 'name'], idx: [['book', 'book_id']] },
    snapshots: { keyPath: 'name' },  // 3.0: daily copies of the library (no PDFs or page text), the safety net
  };
  let _db;
  // stores or indexes this database is missing (a library made by an older BookBoom web version)
  function missing(d, t) {
    const out = [];
    for (const [name, o] of Object.entries(STORES)) {
      if (!d.objectStoreNames.contains(name)) { out.push(name); continue; }
      if (!t || !(o.idx || []).length) continue;
      const s = t.objectStore(name);
      if ((o.idx || []).some(([n]) => !s.indexNames.contains(n))) out.push(name + '#idx');
    }
    return out;
  }
  function openAt(version) {
    return new Promise((res, rej) => {
      const r = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
      r.onupgradeneeded = () => {
        const d = r.result, t = r.transaction;
        for (const [name, o] of Object.entries(STORES)) {
          let s;
          if (d.objectStoreNames.contains(name)) s = t.objectStore(name);
          else {
            const opts = {};
            if (o.keyPath) opts.keyPath = o.keyPath;
            if (o.autoIncrement) opts.autoIncrement = true;
            s = d.createObjectStore(name, opts);
          }
          for (const [n, k, io] of o.idx || []) if (!s.indexNames.contains(n)) s.createIndex(n, k, io || {});
        }
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => {};  // another tab still has the old version open; it closes on versionchange
    });
  }
  function open() {
    if (_db) return _db;
    _db = (async () => {
      let d = await openAt(0);
      let need = missing(d);
      if (!need.length) {
        // indexes can only be checked inside a transaction
        const names = Object.keys(STORES).filter(n => (STORES[n].idx || []).length);
        try { need = missing(d, d.transaction(names, 'readonly')); } catch { need = ['?']; }
      }
      if (need.length) { const v = d.version + 1; d.close(); d = await openAt(v); }
      d.onversionchange = () => { d.close(); _db = null; };
      d.onclose = () => { _db = null; };  // the browser closed it (storage cleared, Safari in the background)
      return d;
    })();
    _db.catch(() => { _db = null; });
    return _db;
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function tx(stores, mode, fn) {
    let d = await open(), t;
    try { t = d.transaction(stores, mode); }
    catch (e) { if (e && e.name !== 'InvalidStateError') throw e; _db = null; d = await open(); t = d.transaction(stores, mode); }
    const done = new Promise((res, rej) => {
      t.oncomplete = res;
      t.onabort = () => rej(friendly(t.error) || new Error('the change could not be saved'));
    });
    done.catch(() => {});
    const s = Array.isArray(stores) ? Object.fromEntries(stores.map(n => [n, t.objectStore(n)])) : t.objectStore(stores);
    let out;
    try { out = await fn(s, t); }
    catch (e) {
      // never let half of a change be saved (a restore that cleared the library and then hit a bad record)
      try { t.abort(); } catch {}
      throw friendly(e);
    }
    await done;
    return out;
  }
  function friendly(e) {
    if (e && (e.name === 'QuotaExceededError' || /quota|disk|space/i.test(e.message || ''))) {
      const q = new Error('There is not enough storage space on this device (the browser refused to save it). Free some space or remove books you no longer need, then try again.');
      q.name = 'QuotaExceededError';
      return q;
    }
    return e;
  }
  const get = (store, key) => tx(store, 'readonly', s => req(s.get(key)));
  const all = (store, index, key) => tx(store, 'readonly', s => req(index ? s.index(index).getAll(key) : s.getAll()));
  const put = (store, val, key) => tx(store, 'readwrite', s => req(key === undefined ? s.put(val) : s.put(val, key)));
  const del = (store, key) => tx(store, 'readwrite', s => req(s.delete(key)));
  const count = store => tx(store, 'readonly', s => req(s.count()));
  async function delByBook(stores, bookId) {
    await tx(stores, 'readwrite', async s => {
      for (const n of stores) {
        const keys = await req(s[n].index('book').getAllKeys(bookId));
        keys.forEach(k => s[n].delete(k));
      }
    });
  }

  // ------------------------------------------------------------ helpers
  const pad = n => String(n).padStart(2, '0');
  const isoLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = () => isoLocal(new Date());
  const today = () => now().slice(0, 10);
  const dayOffset = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoLocal(d).slice(0, 10); };
  const hasPersian = s => /[\u0600-\u06FF]/.test(s || '');
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const err = (msg, status = 400) => json({ error: msg }, status);
  const notFound = () => err('not found', 404);
  // header values must be Latin-1: the plain filename= gets an ASCII stand-in, filename*= carries the real (e.g. Persian) name
  const download = (body, type, name) => new Response(body, { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}` } });
  const asciiName = name => (String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '').replace(/_{2,}/g, '_') || 'download');
  const like = (hay, q) => normalize(String(hay ?? '')).includes(normalize(q));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // Python's int(): a number or a numeric string, otherwise the default (never NaN in the database)
  const toInt = (v, d = 0) => { const n = typeof v === 'number' ? v : parseInt(v, 10); return Number.isFinite(n) ? Math.trunc(n) : d; };
  const str = v => (v === null || v === undefined) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  const methodNotAllowed = () => err('method not allowed', 405);
  // the in-page server (localapi.js) hands FormData/Blob bodies over as they are, so a big PDF or backup
  // is never copied into a multipart body and parsed back again
  const formOf = request => request._form || request.formData();
  const blobOf = request => (request._body instanceof Blob ? request._body : request.blob());
  function cleanTitle(name) {
    let stem = (name || '').replace(/\.[^.]+$/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    return stem || 'Untitled';
  }
  function bookJson(b) {
    const o = { ...b };
    o.tags = (o.tags || '').split(',').filter(Boolean);
    o.favorite = !!o.favorite;
    try { o.toc = typeof o.toc === 'string' ? JSON.parse(o.toc || '[]') : (o.toc || []); } catch { o.toc = []; }
    o.progress = o.pages ? Math.round(100 * Math.min(o.max_page, o.pages) / o.pages) : 0;
    return o;
  }
  // minutes_left: the reader's own pace once 10 pages and 10 minutes are logged (kept within 20 s–10 min a page), otherwise 90 s a page (same as app.py)
  const halfUp = x => Math.floor(x + 0.5);
  async function secondsPerPage() {
    let secs = 0, pages = 0;
    for (const a of await all('activity')) { secs += +a.seconds || 0; pages += +a.pages || 0; }
    if (pages < 10 || secs < 600) return 90;
    return Math.min(600, Math.max(20, secs / pages));  // jumping through a book counts pages without reading time
  }
  function withEta(o, spp) {
    const pages = +o.pages || 0;
    o.minutes_left = o.status === 'finished' ? 0 : pages > 0 ? halfUp(spp * Math.max(0, pages - (+o.last_page || 1)) / 60) : null;
    return o;
  }
  const noteJson = n => ({ ...n, rects: typeof n.rects === 'string' ? safeParse(n.rects, []) : (n.rects || []) });
  function safeParse(s, d) { try { return JSON.parse(s); } catch { return d; } }
  async function sha256(buf) {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function getBook(id) { return get('books', +id); }
  async function bumpActivity(bookId, { seconds = 0, pages = 0, reviews = 0 }) {
    await tx('activity', 'readwrite', async s => {
      const k = [today(), bookId];
      const a = (await req(s.get(k))) || { day: k[0], book_id: bookId, seconds: 0, pages: 0, reviews: 0 };
      a.seconds += seconds; a.pages += pages; a.reviews += reviews;
      s.put(a);
    });
  }
  // search folds what Persian/Arabic text writes in several ways: Arabic ي ى ك ة ە vs Persian ی ک ه, harakat and
  // other marks (and Latin accents), tatweel ـ, the zero-width non-joiner (می‌خواهم = میخواهم), Persian/Arabic digits.
  const normalize = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640\u200b-\u200f\u00ad\ufeff]/g, '').toLowerCase()
    .replace(/[يىئ]/g, 'ی').replace(/ك/g, 'ک').replace(/[ةە]/g, 'ه')
    .replace(/[\u0660-\u0669]/g, c => String(c.charCodeAt(0) - 0x660)).replace(/[\u06f0-\u06f9]/g, c => String(c.charCodeAt(0) - 0x6f0));

  // ------------------------------------------------------------ books
  async function importPdf(blob, name, collection) {
    const head = new TextDecoder('latin1').decode(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()));
    if (!head.includes('%PDF')) throw new Error('not a PDF file');
    const sha = await sha256(await blob.arrayBuffer());  // the bytes are only held while hashing
    const b = {
      title: cleanTitle(name).slice(0, 300), author: '', description: '', filename: sha.slice(0, 20) + '.pdf', original_name: (name || '').slice(0, 300),
      sha256: sha, size: blob.size, pages: 0, language: '', collection: collection || '', tags: '', favorite: 0, status: 'unread', rating: 0,
      last_page: 1, max_page: 0, zoom: 'width', seconds: 0, added: now(), last_opened: null, has_cover: 0, toc: '', pending_index: 1,
    };
    // check and add in one transaction, so the same PDF added twice at once is one book (not a constraint error)
    const file = blob.type === 'application/pdf' && !(typeof File !== 'undefined' && blob instanceof File) ? blob : new Blob([blob], { type: 'application/pdf' });
    const res = await tx(['books', 'files'], 'readwrite', async s => {
      const existing = await req(s.books.index('sha256').get(sha));
      if (existing) return { book: bookJson(existing), created: false };
      b.id = await req(s.books.add(b));
      s.files.put(file, b.id);
      return { book: bookJson(b), created: true };
    });
    return res;
  }

  async function listBooks() {
    const [books, notes, bms, cards] = await Promise.all([all('books'), all('notes'), all('bookmarks'), all('cards')]);
    const c = (arr, f) => arr.reduce((m, x) => (f(x) && (m[x.book_id] = (m[x.book_id] || 0) + 1), m), {});
    const h = c(notes, n => n.kind === 'highlight'), n = c(notes, n => n.kind === 'note'), bm = c(bms, () => true), cd = c(cards, () => true);
    books.sort((a, b) => str(b.last_opened || b.added).localeCompare(str(a.last_opened || a.added)));
    const spp = await secondsPerPage();
    return books.map(b => ({ ...withEta(bookJson(b), spp), highlights: h[b.id] || 0, notes: n[b.id] || 0, bookmarks: bm[b.id] || 0, cards: cd[b.id] || 0 }));
  }

  const EDITABLE = new Set(['toc', 'title', 'author', 'description', 'collection', 'tags', 'favorite', 'status', 'rating', 'zoom', 'language']);
  async function editBook(id, body) {
    const b = await getBook(id); if (!b) return notFound();
    for (let [k, v] of Object.entries(body || {})) {
      if (!EDITABLE.has(k)) continue;
      if (k === 'tags') v = [...new Set((Array.isArray(v) ? v : str(v).split(',')).map(x => String(x).trim()).filter(Boolean))].sort().join(',');
      if (k === 'favorite') v = v ? 1 : 0;
      if (k === 'toc') v = JSON.stringify((Array.isArray(v) ? v : []).filter(i => i && typeof i === 'object' && !Array.isArray(i)).map(i => ({ title: str(i.title).slice(0, 300), page: toInt(i.page ?? 1, 1), level: toInt(i.level ?? 0) })));
      if (k === 'status' && !['unread', 'reading', 'finished'].includes(v)) continue;
      if (k === 'rating') v = clamp(toInt(v || 0), 0, 5);
      if (k === 'title' && !str(v).trim()) continue;
      if (['title', 'author', 'description', 'collection', 'zoom', 'language'].includes(k)) v = str(v);
      b[k] = v;
    }
    await put('books', b);
    return json(withEta(bookJson(b), await secondsPerPage()));
  }

  async function deleteBook(id) {
    id = +id;
    await delReviewsOf((await all('cards', 'book', id)).map(c => c.id));
    await tx(['books', 'files', 'covers'], 'readwrite', s => { s.books.delete(id); s.files.delete(id); s.covers.delete(id); });
    await delByBook(['pagetext', 'notes', 'bookmarks', 'cards', 'activity', 'ink', 'recordings'], id);
    await tx('lookup_history', 'readwrite', async s => {
      for (const h of await req(s.getAll())) if (h.book_id === id) { h.book_id = null; s.put(h); }
    });
    return json({ ok: true });
  }

  async function progress(id, body) {
    const b = await getBook(id); if (!b) return notFound();
    let page = toInt(body.page || b.last_page || 1, 1);
    const secs = clamp(toInt(body.seconds || 0), 0, 600);
    const pages = Math.max(0, toInt(body.pages || b.pages || 0));
    if (pages) page = clamp(page, 1, pages);
    const newPages = (secs || body.turned) ? Math.max(0, page - (b.max_page || 0)) : 0;
    let status = b.status;
    if (status === 'unread' && (secs || page > 1)) status = 'reading';
    // reaching the last page is not finishing the book (textbooks end with an answer key): only PATCH status does that
    Object.assign(b, { last_page: page, max_page: Math.max(b.max_page || 0, page), pages: pages > 0 ? pages : b.pages, seconds: (b.seconds || 0) + secs, last_opened: now(), status });
    await put('books', b);
    if (secs || newPages) await bumpActivity(b.id, { seconds: secs, pages: newPages });
    const out = withEta(bookJson(b), await secondsPerPage());
    out.at_end = !!(out.pages > 0 && page >= out.pages);
    return json(out);
  }

  // page-side indexer (pdf.js runs in the page) sends what Python's PyMuPDF used to extract
  async function indexBook(id, body) {
    const b = await getBook(id); if (!b) return notFound();
    const texts = Array.isArray(body.texts) ? body.texts : [];
    b.pages = Math.max(0, toInt(body.pages || b.pages || 0));
    const mt = String(body.title || '').trim();
    if (mt && mt.length > 2 && !/^(untitled|microsoft word|document\d*)/i.test(mt) && !/\.(docx?|pdf)$/i.test(mt) && b.title === cleanTitle(b.original_name)) b.title = mt.slice(0, 300);
    if (!b.author && body.author) b.author = String(body.author).trim().slice(0, 200);
    const sample = texts.slice(0, 5).join(' ') + ' ' + b.title;
    if (!b.language) b.language = hasPersian(sample) ? 'fa' : (sample.trim() ? 'en' : '');
    delete b.pending_index;
    await tx(['books', 'pagetext'], 'readwrite', s => {
      s.books.put(b);
      texts.forEach((t, i) => { t = (t || '').trim(); if (t) s.pagetext.put({ book_id: b.id, page: i + 1, text: t }); });
    });
    return json(bookJson(b));
  }

  async function bookFile(id, url) {
    const b = await getBook(id); const f = await get('files', +id);
    if (!b || !f) return notFound();
    const headers = { 'Content-Type': 'application/pdf', 'Content-Length': String(f.size) };
    if (url.searchParams.get('download') === '1') headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(b.original_name || b.title + '.pdf')}`;
    return new Response(f, { headers });
  }

  async function cover(id) {
    const c = await get('covers', +id);
    if (!c) return notFound();
    return new Response(c, { headers: { 'Content-Type': /^image\/(png|jpeg|webp|gif)$/.test(c.type) ? c.type : 'image/png', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
  }

  async function setCover(id, request) {
    const b = await getBook(id); if (!b) return notFound();
    const ct = request.headers.get('content-type') || '';
    if (!request._form && !ct.includes('multipart')) return err('the page sends the cover picture in this version');
    const fd = await formOf(request);
    const img = fd.get('image');
    if (!img || typeof img === 'string') return err('no image');
    if (img.size > 20 * 1024 * 1024) return err('picture too large', 413);
    // stored as a PNG picture whatever the upload claims, so it is only ever shown as an image
    const pic = new Blob([img], { type: /^image\/(png|jpeg|webp|gif)$/.test(img.type) ? img.type : 'image/png' });
    await tx(['covers', 'books'], 'readwrite', s => { s.covers.put(pic, b.id); b.has_cover = 1; s.books.put(b); });
    return json({ ok: true });
  }

  // ------------------------------------------------------------ ink / bookmarks / notes
  async function getInk(id) {
    const out = {};
    for (const r of await all('ink', 'book', +id)) { const st = safeParse(r.strokes, null); if (Array.isArray(st)) out[String(r.page)] = st; }
    return json(out);
  }
  function cleanStrokes(strokes) {
    const clean = [];
    for (const st of strokes.slice(0, 3000)) {
      if (!st || typeof st !== 'object' || !Array.isArray(st.p)) continue;
      const pts = st.p.slice(0, 4000).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
      if (!pts.length) continue;
      clean.push({ t: st.t === 'hl' ? 'hl' : 'pen', c: str(st.c || '#1f3a8a').slice(0, 20), w: clamp(+st.w || 0.003, 0.0005, 0.08), p: pts });
    }
    return clean;
  }
  async function putInk(id, page, body) {
    const strokes = body.strokes || [];
    if (!Array.isArray(strokes)) return err('strokes must be a list');
    const clean = cleanStrokes(strokes);
    if (clean.length) await put('ink', { book_id: +id, page: +page, strokes: JSON.stringify(clean), updated: now() });
    else await del('ink', [+id, +page]);
    return json({ page: +page, strokes: clean.length });
  }

  async function addBookmark(id, body) {
    const page = toInt(body.page || 1, 1);
    const ex = (await all('bookmarks', 'book', +id)).find(b => b.page === page);
    if (ex) return json(ex);
    const bm = { book_id: +id, page, label: str(body.label || '').slice(0, 200), created: now() };
    bm.id = await put('bookmarks', bm);
    return json(bm, 201);
  }

  async function allNotes(url) {
    const q = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim(), book = url.searchParams.get('book'), color = url.searchParams.get('color');
    const titles = Object.fromEntries((await all('books')).map(b => [b.id, b.title]));
    let notes = await all('notes');
    notes = notes.filter(n => titles[n.book_id] !== undefined && (!book || n.book_id === +book) && (!q || like(n.quote, q) || like(n.body, q)) && (!color || n.color === color));
    notes.sort((a, b) => str(b.updated).localeCompare(str(a.updated)));
    return json(notes.slice(0, 2000).map(n => ({ ...noteJson(n), book_title: titles[n.book_id] })));
  }
  const byPageId = (a, b) => a.page - b.page || a.id - b.id;

  async function notesMd(id) {
    const b = await getBook(id); if (!b) return notFound();
    const lines = [`# ${b.title}`, ''];
    if (b.author) lines.push(`*${b.author}*`, '');
    for (const n of (await all('notes', 'book', b.id)).sort(byPageId)) {
      lines.push(`## p. ${n.page}`);
      if (n.quote) lines.push('> ' + n.quote.replace(/\n/g, '\n> '), '');
      if (n.body) lines.push(n.body, '');
    }
    const cards = (await all('cards', 'book', b.id)).sort((a, c) => a.page - c.page);
    if (cards.length) { lines.push('---', '# Flashcards', ''); cards.forEach(c => lines.push(`**Q:** ${c.front}`, `**A:** ${c.back}`, '')); }
    const safe = str(b.title).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().replace(/^[ .]+|[ .]+$/g, '').slice(0, 80) || 'book';
    return download(lines.join('\n'), 'text/markdown; charset=utf-8', `${safe} - notes.md`);
  }
  async function allNotesMd() {
    const books = (await all('books')).sort((a, b) => str(a.title).localeCompare(str(b.title), undefined, { sensitivity: 'base' }));
    const notes = await all('notes'), lines = ['# BookBoom notes', ''];
    for (const b of books) {
      const mine = notes.filter(n => n.book_id === b.id).sort(byPageId);
      if (!mine.length) continue;
      lines.push(`## ${b.title || 'Untitled'}`, '');
      if (b.author) lines.push(`*${b.author}*`, '');
      for (const n of mine) {
        lines.push(`### p. ${n.page}`);
        if (n.quote) lines.push('> ' + n.quote.replace(/\n/g, '\n> '), '');
        if (n.body) lines.push(n.body, '');
      }
    }
    return download(lines.join('\n'), 'text/markdown; charset=utf-8', `BookBoom notes ${today()}.md`);
  }

  // ------------------------------------------------------------ flashcards
  // like Python's naive local datetimes: "+1 day" keeps the clock time across a daylight-saving change
  const addLocal = (d, ms) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds() + ms);
  const NOTE_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'];
  const noteColor = v => (NOTE_COLORS.includes(v) ? v : 'yellow');
  function schedule(c, grade, when = new Date()) {
    const num = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
    let ease = num(c.ease, 2.5), interval = num(c.interval, 0), reps = num(c.reps, 0), lapses = num(c.lapses, 0); let due;
    if (grade === 0) {
      reps = 0; lapses += 1; interval = 0; ease = Math.max(1.3, ease - 0.2);
      due = addLocal(when, 10 * 60000);
    } else {
      if (reps === 0) interval = { 1: 1, 2: 1, 3: 4 }[grade];
      else if (reps === 1) interval = { 1: 3, 2: 6, 3: 8 }[grade];
      else interval = Math.max(interval, 1) * { 1: 1.2, 2: ease, 3: ease * 1.3 }[grade];
      interval = Math.min(interval, 36500);  // 100 years: keeps the due date a real date
      ease = Math.max(1.3, ease + { 1: -0.15, 2: 0, 3: 0.15 }[grade]);
      reps += 1;
      due = addLocal(when, Math.round(interval * 86400000));
    }
    return { ease: Math.round(ease * 1000) / 1000, interval: Math.round(interval * 1000) / 1000, reps, lapses, due: isoLocal(due) };
  }
  async function listCards(url) {
    const titles = Object.fromEntries((await all('books')).map(b => [b.id, b.title]));
    const book = url.searchParams.get('book'), due = url.searchParams.get('due') === '1', n = now();
    const sus = url.searchParams.get('suspended');
    let cards = (await all('cards')).filter(c => (!book || c.book_id === +book) && (due ? c.due <= n && !+c.suspended : sus === '0' || sus === '1' ? (+c.suspended ? 1 : 0) === +sus : true));
    cards.sort((a, b) => str(a.due).localeCompare(str(b.due)));
    return json(cards.slice(0, 5000).map(c => ({ ...c, book_title: c.book_id ? (titles[c.book_id] ?? null) : null })));
  }
  async function addCard(body) {
    const front = str(body.front || '').trim();
    if (!front) return err('front is required');
    const bookId = body.book_id ? toInt(body.book_id, -1) : null;
    if (bookId && !(await getBook(bookId))) return notFound();
    const c = { book_id: bookId, page: toInt(body.page || 0), front: front.slice(0, 5000), back: str(body.back || '').slice(0, 20000), due: now(), interval: 0, ease: 2.5, reps: 0, lapses: 0, suspended: 0, created: now() };
    c.id = await put('cards', c);
    return json(c, 201);
  }
  function csvRows(text, delim) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
      if (ch === '"' && f === '') q = true;
      else if (ch === delim) { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  // a PDF, zip, picture or other binary file picked by mistake would otherwise become dozens of junk cards
  function looksBinary(buf) {
    const u = new Uint8Array(buf, 0, Math.min(8192, buf.byteLength)), sig = String.fromCharCode(...u.slice(0, 13));
    if (/^(%PDF|PK\x03\x04|\x89PNG|\xff\xd8\xff|GIF8|SQLite format)/.test(sig)) return true;
    if ((u[0] === 0xff && u[1] === 0xfe) || (u[0] === 0xfe && u[1] === 0xff)) return false;
    return u.includes(0);
  }
  function decodeText(buf) {
    const u = new Uint8Array(buf);
    if (u[0] === 0xff && u[1] === 0xfe) return new TextDecoder('utf-16le').decode(u);
    if (u[0] === 0xfe && u[1] === 0xff) return new TextDecoder('utf-16be').decode(u);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u).replace(/^\ufeff/, ''); } catch {}
    try { return new TextDecoder('windows-1256').decode(u); } catch { return new TextDecoder('latin1').decode(u); }
  }
  async function importCards(request) {
    const fd = await formOf(request); const f = fd.get('file');
    if (!f || typeof f === 'string') return err('no file');
    const bookId = fd.get('book_id') ? toInt(fd.get('book_id'), -1) : null;
    if (bookId !== null && !(await getBook(bookId))) return notFound();
    const buf = await f.slice(0, 5000000).arrayBuffer();
    if (looksBinary(buf)) return err("This isn't a text file of cards. Choose a CSV, TSV or Anki text export.");
    const lines = decodeText(buf).split(/(?<=\n)/);
    while (lines.length && (lines[0].startsWith('#') || !lines[0].trim())) lines.shift();
    if (!lines.length) return json({ added: 0, skipped: 0 });
    const sample = lines.slice(0, 20).join('');
    const delim = sample.includes('\t') ? '\t' : ((sample.split(';').length > sample.split(',').length) ? ';' : ',');
    const existing = new Set((await all('cards')).map(c => str(c.front).trim() + '\u0000' + str(c.back).trim()));
    let added = 0, skipped = 0; const fresh = [];
    csvRows(lines.join(''), delim).forEach((cols, i) => {
      cols = cols.map(c => c.replace(/<br\s*\/?>/gi, '\n').trim());
      if (!cols.length || !cols[0]) return;
      if (i === 0 && ['front', 'question', 'word', 'term'].includes(cols[0].toLowerCase())) return;
      const front = cols[0].slice(0, 5000), back = (cols[1] || '').slice(0, 20000), k = front + '\u0000' + back;
      if (existing.has(k)) { skipped++; return; }
      existing.add(k); added++;
      fresh.push({ book_id: bookId, page: 0, front, back, due: now(), interval: 0, ease: 2.5, reps: 0, lapses: 0, suspended: 0, created: now() });
    });
    await tx('cards', 'readwrite', s => fresh.forEach(c => s.add(c)));
    return json({ added, skipped });
  }
  async function exportCards(url) {
    const titles = Object.fromEntries((await all('books')).map(b => [b.id, b.title]));
    const book = url.searchParams.get('book');
    const cards = (await all('cards')).filter(c => !book || c.book_id === +book).sort((a, b) => a.id - b.id);
    const cell = v => { v = str(v); return /[\t\n\r"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    let out = '#separator:tab\n#html:false\n#columns:Front\tBack\tTags\n';
    for (const c of cards) {
      const tag = (titles[c.book_id] || '').trim().replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60);
      out += [c.front, c.back || '', ('bookboom ' + tag).trim()].map(cell).join('\t') + '\n';
    }
    return download('\ufeff' + out, 'text/plain; charset=utf-8', 'bookboom-cards.txt');
  }
  async function reviewCard(id, body) {
    const c = await get('cards', +id); if (!c) return notFound();
    const g = body.grade ?? 2;
    const grade = typeof g === 'number' ? Math.trunc(g) : (/^\s*-?\d+(\.\d+)?\s*$/.test(String(g)) ? Math.trunc(+g) : NaN);
    if (!Number.isFinite(grade)) return err('grade must be 0, 1, 2 or 3');
    const gr = clamp(grade, 0, 3);
    const practice = [true, 1, '1', 'true'].includes(body.practice);  // same as app.py
    const prev = JSON.stringify(Object.fromEntries(SCHEDULE_COLS.map(k => [k, k === 'suspended' ? (+c.suspended ? 1 : 0) : c[k] ?? null])));
    let leech = false;
    if (!practice) { Object.assign(c, schedule(c, gr)); leech = gr === 0 && isLeech(c.lapses); if (leech) c.suspended = 1; }
    await tx(['cards', 'reviews'], 'readwrite', s => {
      if (!practice) s.cards.put(c);
      s.reviews.add({ card_id: c.id, ts: now(), grade: gr, practice: practice ? 1 : 0, prev });
    });
    if (c.book_id) await bumpActivity(c.book_id, { reviews: 1 });
    return json({ ...c, leech });
  }
  const SCHEDULE_COLS = ['ease', 'interval', 'reps', 'lapses', 'due', 'suspended'];
  // forgotten 8 times, a card is set aside (again every 4 more), like Anki's leeches; same as app.py
  const isLeech = l => l >= 8 && (l - 8) % 4 === 0;
  // the card's schedule before a review, as logged; only well-formed values (a backup may come from anywhere)
  function prevState(text) {
    const p = safeParse(text || '', null), out = {};
    if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
    for (const k of ['ease', 'interval']) if (typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0) out[k] = p[k];
    for (const k of ['reps', 'lapses']) if (typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0) out[k] = Math.trunc(p[k]);
    if (typeof p.due === 'string' && p.due) out.due = p.due.slice(0, 40);
    if (p.suspended === 0 || p.suspended === 1) out.suspended = p.suspended;
    return out;
  }
  async function undoReview(id) {
    const c = await get('cards', +id);
    const rv = c && (await all('reviews', 'card', c.id)).sort((a, b) => b.id - a.id)[0];
    if (!rv) return err('no review to undo', 404);
    if (!rv.practice) Object.assign(c, prevState(rv.prev));
    await tx(['cards', 'reviews', 'activity'], 'readwrite', async s => {
      s.cards.put(c);
      s.reviews.delete(rv.id);
      if (c.book_id) {
        const k = [str(rv.ts).slice(0, 10), c.book_id], a = await req(s.activity.get(k));
        if (a) { a.reviews = Math.max(0, (+a.reviews || 0) - 1); s.activity.put(a); }
      }
    });
    return json(c);
  }
  async function delReviewsOf(cardIds) {
    if (!cardIds.length) return;
    await tx('reviews', 'readwrite', async s => {
      for (const cid of cardIds) (await req(s.index('card').getAllKeys(cid))).forEach(k => s.delete(k));
    });
  }

  // ------------------------------------------------------------ lookups (dictionary / translation)
  async function cached(kind, q, producer) {
    const hit = await get('lookup_cache', [kind, q]);
    if (hit) return [safeParse(hit.data, null), true];
    const data = await producer();
    if (data != null) await put('lookup_cache', { kind, q, data: JSON.stringify(data), created: now() });
    return [data, false];
  }
  async function fetchJson(u) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(u, { signal: ctl.signal, headers: { Accept: 'application/json' } });
      if (r.status === 404) { const e = new Error('404'); e.code = 404; throw e; }
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async function defineWord(word) {
    let raw;
    try { raw = await fetchJson('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word)); }
    catch (e) { if (e.code === 404) return { word, found: false }; throw e; }
    let phon = '', audio = ''; const meanings = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      phon = phon || entry.phonetic || '';
      for (const p of entry.phonetics || []) { phon = phon || p.text || ''; if (!audio && p.audio) audio = p.audio; }
      for (const m of entry.meanings || []) {
        const defs = (m.definitions || []).slice(0, 4).map(d => ({ d: d.definition || '', ex: d.example || '' }));
        const syn = [...new Set([...(m.synonyms || []), ...(m.definitions || []).flatMap(d => d.synonyms || [])])].slice(0, 8);
        meanings.push({ pos: m.partOfSpeech || '', defs, syn });
      }
    }
    return { word, found: meanings.length > 0, phonetic: phon, audio, meanings: meanings.slice(0, 6) };
  }
  async function translateText(text, pair) {
    const [sl, tl] = pair.split('|');
    try {
      const u = new URL('https://translate.googleapis.com/translate_a/single');
      [['client', 'gtx'], ['sl', sl], ['tl', tl], ['dt', 't'], ['dt', 'bd'], ['q', text]].forEach(([k, v]) => u.searchParams.append(k, v));
      const raw = await fetchJson(u.href);
      const out = (raw[0] || []).filter(s => s && s[0]).map(s => s[0]).join('').trim();
      const alts = [];
      for (const g of (raw[1] || [])) for (const w of (g[1] || []).slice(0, 4)) if (w && w !== out && !alts.includes(w) && alts.length < 6) alts.push(w);
      if (out) return { text, translation: out, alternatives: alts, source: 'Google Translate' };
    } catch {}
    try {
      const raw = await fetchJson('https://api.mymemory.translated.net/get?' + new URLSearchParams({ q: text, langpair: pair }));
      const out = raw?.responseData?.translatedText || '';
      if (out && !out.toUpperCase().includes('MYMEMORY WARNING') && String(raw.responseStatus) === '200') {
        const alts = [];
        for (const m of (raw.matches || []).slice(0, 8)) { const tr = (m.translation || '').trim(); if (tr && tr !== out && !alts.includes(tr) && alts.length < 4) alts.push(tr); }
        return { text, translation: out, alternatives: alts, source: 'MyMemory' };
      }
    } catch {}
    return null;
  }
  async function define(url) {
    const w = (url.searchParams.get('w') || '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[^A-Za-z' -]/g, '').trim().toLowerCase().replace(/'s$/, '').replace(/^'+|'+$/g, '');
    if (!w || w.length > 60) return err('give one English word or phrase');
    try { const [d, c] = await cached('define', w, () => defineWord(w)); return json({ ...d, cached: c }); }
    catch { return json({ word: w, found: false, offline: true }); }
  }
  async function translate(url) {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 500);
    if (!q) return err('nothing to translate');
    const to = url.searchParams.get('to') || (hasPersian(q) ? 'en' : 'fa');
    const pair = to === 'en' ? 'fa|en' : 'en|fa';
    try {
      const [d, c] = await cached('tr:' + pair, q.toLowerCase(), () => translateText(q, pair));
      return d ? json({ ...d, cached: c }) : json({ text: q, translation: '', offline: true });
    } catch { return json({ text: q, translation: '', offline: true }); }
  }
  async function addLookup(body) {
    const q = str(body.q || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!q) return err('empty');
    let bookId = body.book_id ? toInt(body.book_id, -1) : null;
    if (bookId && !(await getBook(bookId))) bookId = null;
    await tx('lookup_history', 'readwrite', async s => {
      const h = await req(s.get(q));
      if (h) { h.count = toInt(h.count, 0) + 1; h.last = now(); if (bookId) { h.book_id = bookId; h.page = toInt(body.page || 0); } s.put(h); }
      else s.put({ q, book_id: bookId, page: toInt(body.page || 0), count: 1, last: now() });
    });
    return json({ ok: true });
  }
  async function listLookups() {
    const titles = Object.fromEntries((await all('books')).map(b => [b.id, b.title]));
    const cardFronts = new Set((await all('cards')).map(c => str(c.front).trim().toLowerCase()));
    const cache = {};
    for (const c of await all('lookup_cache')) cache[c.kind + '\u0000' + c.q] = c.data;
    const hist = (await all('lookup_history')).filter(h => typeof h.q === 'string').sort((a, b) => str(b.last).localeCompare(str(a.last))).slice(0, 500);
    return json(hist.map(h => {
      const item = { ...h, book_title: h.book_id ? (titles[h.book_id] ?? null) : null };
      const key = h.q.replace(/[^A-Za-z' -]/g, '').trim().toLowerCase();
      const d = cache['define\u0000' + key];
      const tr = cache['tr:en|fa\u0000' + h.q.toLowerCase()] || cache['tr:fa|en\u0000' + h.q.toLowerCase()];
      if (d) {
        const dd = safeParse(d, {}); item.phonetic = dd.phonetic || '';
        const m = (dd.meanings || [{}])[0];
        item.definition = m ? ((m.pos ? m.pos + ': ' : '') + ((m.defs || [{}])[0]?.d || '')) : '';
      }
      if (tr) item.translation = safeParse(tr, {}).translation || '';
      item.has_card = cardFronts.has(h.q.toLowerCase().trim());
      return item;
    }));
  }

  // ------------------------------------------------------------ search
  async function search(url) {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return json({ pages: [], notes: [], books: [] });
    const book = url.searchParams.get('book');
    const words = (normalize(q).match(/[\p{L}\p{N}]+/gu) || []);
    const books = await all('books'); const titles = Object.fromEntries(books.map(b => [b.id, b.title]));
    const pages = [];
    if (words.length) {
      const res = words.map((w, i) => i === words.length - 1 ? new RegExp('(?:^|[^\\p{L}\\p{N}])' + esc(w), 'u') : new RegExp('(?:^|[^\\p{L}\\p{N}])' + esc(w) + '(?![\\p{L}\\p{N}])', 'u'));
      const rows = book ? await all('pagetext', 'book', +book) : await all('pagetext');
      for (const r of rows) {
        if (titles[r.book_id] === undefined) continue;
        if (typeof r.text !== 'string') continue;
        const nt = normalize(r.text);
        if (!res.every(re => re.test(nt))) continue;
        let score = 0; words.forEach(w => { score += nt.split(w).length - 1; });
        pages.push({ book_id: r.book_id, page: r.page, snip: snippet(r.text, nt, words), title: titles[r.book_id], _s: score });
      }
      if (book) pages.sort((a, b) => a.page - b.page); else pages.sort((a, b) => b._s - a._s);
      pages.forEach(p => delete p._s);
    }
    const bookHits = book ? [] : books.filter(b => [b.title, b.author, b.tags, b.collection].some(v => like(v, q))).slice(0, 50).map(bookJson);
    const notes = (await all('notes')).filter(n => titles[n.book_id] !== undefined && (!book || n.book_id === +book) && (like(n.quote, q) || like(n.body, q)))
      .slice(0, 100).map(n => ({ ...noteJson(n), book_title: titles[n.book_id] }));
    return json({ pages: pages.slice(0, 300), notes, books: bookHits });
  }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function snippet(text, nt, words) {
    // map normalized positions back roughly: normalized text is close in length for Latin/Persian
    const toks = text.split(/(\s+)/);
    const ntoks = toks.map(normalize);
    let first = ntoks.findIndex(t => words.some(w => t.includes(w)));
    if (first < 0) first = 0;
    const start = Math.max(0, first - 14), end = Math.min(toks.length, first + 16);
    let out = toks.slice(start, end).map((t, i) => (words.some(w => ntoks[start + i].includes(w)) && t.trim()) ? `\u0001${t}\u0002` : t).join('').replace(/\s+/g, ' ').trim();
    return (start > 0 ? '…' : '') + out + (end < toks.length ? '…' : '');
  }

  // ------------------------------------------------------------ stats / settings
  async function stats(url) {
    const days = clamp(toInt(url.searchParams.get('days') || 30, 30), 0, 3660);
    const start = dayOffset(-(days - 1));
    const act = await all('activity');
    const per = {};
    for (const a of act) if (a.day >= start) { const p = per[a.day] || (per[a.day] = { seconds: 0, pages: 0, reviews: 0 }); p.seconds += a.seconds; p.pages += a.pages; p.reviews += a.reviews; }
    // reviews of cards that belong to no book (imported or typed in Study) are only in the review log
    const revs = await all('reviews'), logged = {};
    for (const rv of revs) { const d = str(rv.ts).slice(0, 10); logged[d] = (logged[d] || 0) + 1; }
    const series = [];
    for (let i = 0; i < days; i++) { const d = dayOffset(-(days - 1 - i)); const r = per[d] || {}; series.push({ day: d, seconds: r.seconds || 0, pages: r.pages || 0, reviews: Math.max(r.reviews || 0, logged[d] || 0) }); }
    const byDay = {};
    for (const a of act) { const p = byDay[a.day] || (byDay[a.day] = { s: 0, r: 0 }); p.s += a.seconds; p.r += a.reviews; }
    const active = new Set(Object.entries(byDay).filter(([, v]) => v.s >= 60 || v.r > 0).map(([k]) => k));
    for (const d in logged) active.add(d);
    let streak = 0, off = active.has(today()) ? 0 : -1;
    while (active.has(dayOffset(off))) { streak++; off--; }
    const books = await all('books'); const byStatus = {};
    books.forEach(b => { byStatus[b.status] = (byStatus[b.status] || 0) + 1; });
    const tops = {};
    for (const a of act) if (a.day >= start) tops[a.book_id] = (tops[a.book_id] || 0) + a.seconds;
    const titles = Object.fromEntries(books.map(b => [b.id, b.title]));
    const top = Object.entries(tops).filter(([id]) => titles[id] !== undefined).map(([id, s]) => ({ id: +id, title: titles[id], seconds: s })).sort((a, b) => b.seconds - a.seconds).slice(0, 5);
    const cards = await all('cards'); const n = now();
    const goal = (await get('settings', 'daily_goal')) ?? '20';
    const td = today(), horizon = dayOffset(29), perDue = {};
    const liveCards = cards.filter(c => !+c.suspended);
    for (const c of liveCards) { const d = str(c.due).slice(0, 10); if (d <= horizon) perDue[d] = (perDue[d] || 0) + 1; }
    const forecast = [];
    for (let i = 0; i < 30; i++) {
      const d = dayOffset(i);
      forecast.push({ date: d, count: i ? (perDue[d] || 0) : Object.entries(perDue).reduce((s, [k, v]) => s + (k <= d ? v : 0), 0) });
    }
    const since = dayOffset(-29);
    const counted = revs.filter(r => !r.practice && str(r.ts).slice(0, 10) >= since), correct = counted.filter(r => r.grade >= 1).length;
    const retention = { reviews: counted.length, correct, pct: counted.length ? halfUp(100 * correct / counted.length) : null };
    const yearStart = dayOffset(-364), perYear = {};
    for (const a of act) if (a.day >= yearStart) { const p = perYear[a.day] || (perYear[a.day] = { seconds: 0, pages: 0 }); p.seconds += a.seconds; p.pages += a.pages; }
    const year = [];
    for (let i = 0; i < 365; i++) { const d = dayOffset(-(364 - i)); const p = perYear[d] || {}; year.push({ date: d, seconds: p.seconds || 0, pages: p.pages || 0 }); }
    const reviewsToday = revs.filter(r => str(r.ts).slice(0, 10) === td).length;
    return json({
      forecast, retention, year, reviews_today: reviewsToday,
      series, streak, total_seconds: act.reduce((s, a) => s + a.seconds, 0), total_pages: act.reduce((s, a) => s + a.pages, 0), by_status: byStatus, top,
      books: books.length, notes: await count('notes'), cards: cards.length, due: liveCards.filter(c => c.due <= n).length, suspended: cards.length - liveCards.length, goal: toInt(goal, 20), today: series[series.length - 1] || {},
    });
  }
  async function getSettings() {
    const out = {};
    await tx('settings', 'readonly', async s => {
      const keys = await req(s.getAllKeys()); const vals = await req(s.getAll());
      keys.forEach((k, i) => { out[k] = vals[i]; });
    });
    return out;
  }

  // ------------------------------------------------------------ recordings
  const REC_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac' };
  const REC_NAME = /^p(\d+)-(\d{8}-\d{6}(?:-\d+)?)\.(webm|ogg|m4a|mp3|wav|aac)$/;
  const recItem = r => ({ name: r.name, page: r.page, size: r.blob.size, created: r.created, url: `api/recordings/${r.book_id}/${r.name}` });
  async function addRecording(id, page, request) {
    if (!(await getBook(id))) return notFound();
    const ctype = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = REC_EXT[ctype];
    if (!ext) return err('send audio (webm, ogg, mp4, mp3 or wav)');
    const blob = await blobOf(request);
    if (!blob.size) return err('empty recording');
    if (blob.size > 40 * 1024 * 1024) return err('recording too long', 413);
    const d = new Date(); const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const existing = new Set((await all('recordings', 'book', +id)).map(r => r.name));
    let name = `p${page}-${stamp}.${ext}`, n = 1;
    while (existing.has(name)) name = `p${page}-${stamp}-${n++}.${ext}`;
    const r = { book_id: +id, name, page: +page, created: new Date().toISOString().slice(0, 19) + 'Z', blob: new Blob([blob], { type: ctype }) };
    await put('recordings', r);
    return json(recItem(r), 201);
  }

  // ------------------------------------------------------------ zip files (backups)
  // Written and read here rather than with fflate's Zip/Unzip: those can't make archives over 4 GB (no ZIP64),
  // and the streaming Unzip accepts a cut-off download and inflates every entry it meets (zip bombs).
  // Reading goes through the central directory, so only the entries a restore needs are touched and stored PDFs
  // are kept as slices of the chosen file instead of being copied into memory.
  const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
  function crc32(crc, u8) { let c = ~crc; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (~c) >>> 0; }
  const U32 = 0xffffffff;
  const Z64 = { at: U32, entries: 0xffff };  // when ZIP64 records are needed (lowered by the tests)
  const w16 = (a, o, v) => { a[o] = v & 255; a[o + 1] = (v >>> 8) & 255; };
  const w32 = (a, o, v) => { a[o] = v & 255; a[o + 1] = (v >>> 8) & 255; a[o + 2] = (v >>> 16) & 255; a[o + 3] = (v >>> 24) & 255; };
  const w64 = (a, o, v) => { w32(a, o, v % 4294967296); w32(a, o + 4, Math.floor(v / 4294967296)); };
  const r64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;
  async function* chunks(blob) {
    const rd = blob.stream().getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) return; yield value; }
  }
  // items: async iterable of { name, bytes (Uint8Array, deflated) | blob (stored) }; yields the zip piece by piece
  async function* zipStream(items) {
    const te = new TextEncoder(), cd = []; let off = 0;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for await (const it of items) {
      const name = te.encode(it.name);
      let method = 0, crc = 0, usize, csize, body = null;
      if (it.bytes) { usize = it.bytes.length; crc = crc32(0, it.bytes); body = fflate.deflateSync(it.bytes, { level: 6 }); method = 8; csize = body.length; }
      else { usize = csize = it.blob.size; for await (const ch of chunks(it.blob)) crc = crc32(crc, ch); }  // sizes and CRC go in the header: no data descriptors
      const z64 = usize >= Z64.at || csize >= Z64.at, n = name.length;
      const lh = new Uint8Array(30 + n + (z64 ? 20 : 0));
      w32(lh, 0, 0x04034b50); w16(lh, 4, z64 ? 45 : 20); w16(lh, 6, 0x800); w16(lh, 8, method); w16(lh, 10, time); w16(lh, 12, date);
      w32(lh, 14, crc); w32(lh, 18, z64 ? U32 : csize); w32(lh, 22, z64 ? U32 : usize); w16(lh, 26, n); w16(lh, 28, z64 ? 20 : 0); lh.set(name, 30);
      if (z64) { w16(lh, 30 + n, 1); w16(lh, 32 + n, 16); w64(lh, 34 + n, usize); w64(lh, 42 + n, csize); }
      yield lh;
      if (body) yield body;
      else { let sent = 0; for await (const ch of chunks(it.blob)) { sent += ch.length; yield ch; } if (sent !== csize) throw new Error('a file changed while it was being backed up'); }
      cd.push({ name, method, crc, usize, csize, off, time, date });
      off += lh.length + csize;
    }
    const cdStart = off;
    for (const e of cd) {
      const big = [e.usize >= Z64.at ? e.usize : null, e.csize >= Z64.at ? e.csize : null, e.off >= Z64.at ? e.off : null].filter(v => v !== null);
      const n = e.name.length, xl = big.length ? 4 + 8 * big.length : 0;
      const h = new Uint8Array(46 + n + xl);
      w32(h, 0, 0x02014b50); w16(h, 4, 45); w16(h, 6, big.length ? 45 : 20); w16(h, 8, 0x800); w16(h, 10, e.method); w16(h, 12, e.time); w16(h, 14, e.date);
      w32(h, 16, e.crc); w32(h, 20, e.csize >= Z64.at ? U32 : e.csize); w32(h, 24, e.usize >= Z64.at ? U32 : e.usize); w16(h, 28, n); w16(h, 30, xl);
      w32(h, 42, e.off >= Z64.at ? U32 : e.off); h.set(e.name, 46);
      if (xl) { w16(h, 46 + n, 1); w16(h, 48 + n, 8 * big.length); big.forEach((v, i) => w64(h, 50 + n + 8 * i, v)); }
      off += h.length;
      yield h;
    }
    const cdSize = off - cdStart, count = cd.length;
    const z64end = count >= Z64.entries || cdSize >= Z64.at || cdStart >= Z64.at;
    if (z64end) {
      const z = new Uint8Array(56 + 20);
      w32(z, 0, 0x06064b50); w64(z, 4, 44); w16(z, 12, 45); w16(z, 14, 45); w64(z, 24, count); w64(z, 32, count); w64(z, 40, cdSize); w64(z, 48, cdStart);
      w32(z, 56, 0x07064b50); w64(z, 64, off); w32(z, 72, 1);
      yield z;
    }
    const e = new Uint8Array(22);
    w32(e, 0, 0x06054b50); w16(e, 8, z64end ? 0xffff : count); w16(e, 10, z64end ? 0xffff : count); w32(e, 12, z64end ? U32 : cdSize); w32(e, 16, z64end ? U32 : cdStart);
    yield e;
  }
  function streamOf(gen) {
    return new ReadableStream({
      async pull(c) { try { const { done, value } = await gen.next(); if (done) c.close(); else c.enqueue(value); } catch (e) { c.error(e); } },
      cancel() { gen.return(); },
    }, { highWaterMark: 4 });
  }

  class ZipError extends Error {}
  const badZip = () => new ZipError('bad zip');
  // the central directory: name -> { method, csize, usize, off, crc, flags }
  async function readZip(blob) {
    const size = blob.size;
    if (size < 22) throw badZip();
    const tailLen = Math.min(size, 65535 + 22 + 20);
    const tail = new Uint8Array(await blob.slice(size - tailLen).arrayBuffer()), dv = new DataView(tail.buffer);
    let p = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50 && i + 22 + dv.getUint16(i + 20, true) <= tail.length) { p = i; break; }
    if (p < 0) throw badZip();  // no end record: a cut-off download or not a zip at all
    let count = dv.getUint16(p + 10, true), cdSize = dv.getUint32(p + 12, true), cdOff = dv.getUint32(p + 16, true), cdEnd = size - tailLen + p;
    if (count === 0xffff || cdSize === U32 || cdOff === U32) {
      if (p >= 20 && dv.getUint32(p - 20, true) === 0x07064b50) {
        const at = r64(dv, p - 12);
        if (at + 56 > cdEnd) throw badZip();
        const z = new DataView(await blob.slice(at, at + 56).arrayBuffer());
        if (z.getUint32(0, true) !== 0x06064b50) throw badZip();
        count = r64(z, 32); cdSize = r64(z, 40); cdOff = r64(z, 48); cdEnd = at;
      }
    }
    if (cdOff + cdSize > cdEnd || count > 500000) throw badZip();
    const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer()), cv = new DataView(cd.buffer);
    const out = new Map(), td = new TextDecoder();
    let q = 0;
    for (let i = 0; i < count; i++) {
      if (q + 46 > cd.length || cv.getUint32(q, true) !== 0x02014b50) throw badZip();
      const flags = cv.getUint16(q + 8, true), method = cv.getUint16(q + 10, true), crc = cv.getUint32(q + 16, true);
      let csize = cv.getUint32(q + 20, true), usize = cv.getUint32(q + 24, true), off = cv.getUint32(q + 42, true);
      const nl = cv.getUint16(q + 28, true), xl = cv.getUint16(q + 30, true), cl = cv.getUint16(q + 32, true);
      if (q + 46 + nl + xl + cl > cd.length) throw badZip();
      const name = td.decode(cd.subarray(q + 46, q + 46 + nl));
      for (let x = q + 46 + nl, xe = x + xl; x + 4 <= xe;) {
        const id = cv.getUint16(x, true), len = cv.getUint16(x + 2, true);
        if (id === 1) {
          let y = x + 4;
          const take = () => { if (y + 8 > x + 4 + len) throw badZip(); const v = r64(cv, y); y += 8; return v; };
          if (usize === U32) usize = take();
          if (csize === U32) csize = take();
          if (off === U32) off = take();
        }
        x += 4 + len;
      }
      q += 46 + nl + xl + cl;
      if (!out.has(name)) out.set(name, { name, method, csize, usize, off, crc, flags });
    }
    return out;
  }
  // one entry as a Blob. Stored entries are slices of the zip (no copy); deflated ones are inflated with a size limit.
  async function unzipEntry(zip, e, { max, type = '', budget }) {
    if (e.flags & 1) throw new ZipError('encrypted backup');
    if (e.usize > max || (e.method !== 0 && e.usize > budget.left)) { const x = new ZipError('too large'); x.tooBig = true; throw x; }
    const lh = new DataView(await zip.slice(e.off, e.off + 30).arrayBuffer());
    if (lh.byteLength < 30 || lh.getUint32(0, true) !== 0x04034b50) throw badZip();
    const start = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    if (start + e.csize > zip.size) throw badZip();
    const raw = zip.slice(start, start + e.csize);
    if (e.method === 0) { if (e.csize !== e.usize) throw badZip(); return new Blob([raw], { type }); }
    if (e.method !== 8) throw new ZipError('unsupported compression');
    budget.left -= e.usize;
    const parts = []; let n = 0, crc = 0;
    const inf = new fflate.Inflate((chunk) => {
      n += chunk.length;
      if (n > e.usize) throw badZip();  // more data than the directory promised: a zip bomb or a broken file
      crc = crc32(crc, chunk); parts.push(chunk);
    });
    for await (const ch of chunks(raw)) inf.push(ch, false);
    inf.push(new Uint8Array(0), true);
    if (n !== e.usize || crc !== e.crc) throw badZip();
    return new Blob(parts, { type });
  }

  // ------------------------------------------------------------ backup / restore (zip with data.json, same format as the Python app)
  const TABLES = ['books', 'notes', 'bookmarks', 'cards', 'reviews', 'activity', 'ink', 'lookup_history', 'lookup_cache'];
  async function backup(url) {
    const withPdfs = url.searchParams.get('pdfs') !== '0';
    const data = { app: 'ketabyar', format: 2, version: VERSION, exported: now(), settings: await getSettings() };
    for (const t of TABLES) data[t] = await all(t);
    data.books = data.books.map(b => { const o = { ...b }; delete o.pending_index; return o; });
    data.pagetext = await all('pagetext');
    const books = await all('books'), recs = await all('recordings');
    async function* items() {
      yield { name: 'data.json', bytes: fflate.strToU8(JSON.stringify(data)) };
      for (const b of books) {
        if (withPdfs) { const f = await get('files', b.id); if (f) yield { name: `library/${b.filename}`, blob: f }; }
        const c = await get('covers', b.id); if (c) yield { name: `covers/${b.id}.png`, blob: c };
      }
      for (const r of recs) if (REC_NAME.test(r.name)) yield { name: `recordings/${r.book_id}/${r.name}`, blob: r.blob };
    }
    // streamed with back-pressure: one PDF at a time is read while the download is written
    return new Response(streamOf(zipStream(items())), { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="bookboom-backup-${today()}.zip"` } });
  }

  // A backup may come from anywhere (an old version, the desktop app, someone else): every row is rebuilt from
  // the columns the Python app has, with the same types, so nothing odd (wrong types, __proto__ keys, NaN ids,
  // orphans, keys IndexedDB refuses) gets into the library. Column -> s string, s? string or null, i integer,
  // r number, id row id, ref a restored book's id, ref? same or null, day YYYY-MM-DD, key non-empty string.
  const COLS = {
    books: { id: 'id', title: 's', author: 's', description: 's', filename: 's', original_name: 's', sha256: 's', size: 'i', pages: 'i', language: 's', collection: 's', tags: 's', favorite: 'i', status: 's', rating: 'i', last_page: 'i', max_page: 'i', zoom: 's', seconds: 'i', added: 's', last_opened: 's?', has_cover: 'i', toc: 's' },
    bookmarks: { id: 'id', book_id: 'ref', page: 'i', label: 's', created: 's' },
    notes: { id: 'id', book_id: 'ref', page: 'i', kind: 's', color: 's', quote: 's', body: 's', rects: 's', created: 's', updated: 's' },
    cards: { id: 'id', book_id: 'ref?', page: 'i', front: 's', back: 's', due: 's', interval: 'r', ease: 'r', reps: 'i', lapses: 'i', created: 's', suspended: 'i' },
    reviews: { id: 'id', card_id: 'card', ts: 's', grade: 'i', practice: 'i', prev: 's' },
    activity: { day: 'day', book_id: 'ref', seconds: 'i', pages: 'i', reviews: 'i' },
    ink: { book_id: 'ref', page: 'i', strokes: 's', updated: 's' },
    lookup_history: { q: 'key', book_id: 'ref?', page: 'i', count: 'i', last: 's' },
    lookup_cache: { kind: 'key', q: 'key', data: 's', created: 's' },
    pagetext: { book_id: 'ref', page: 'i', text: 's' },
  };
  const DEFAULTS = { title: 'Untitled', status: 'unread', last_page: 1, zoom: 'width', ease: 2.5, count: 1, kind: 'note', color: 'yellow', rects: '[]', data: 'null', last_opened: null, grade: 2 };
  const ROW_TABLES = ['notes', 'bookmarks', 'cards', 'reviews', 'activity', 'ink', 'lookup_history', 'lookup_cache', 'pagetext'];
  function cleanRow(table, r, bookIds, cardIds) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const o = {}, t = now();
    for (const [k, kind] of Object.entries(COLS[table])) {
      const has = Object.prototype.hasOwnProperty.call(r, k);
      let v = has ? r[k] : undefined;
      const def = k in DEFAULTS ? DEFAULTS[k] : (['added', 'created', 'updated', 'due', 'last', 'ts'].includes(k) ? t : (kind === 'i' || kind === 'r' ? 0 : ''));
      if (kind === 'id') {
        const n = Number(v);
        if (has && v !== null && Number.isInteger(n) && n > 0 && n < 2 ** 40) o.id = n;  // others get a new id
        else if (table === 'books') return null;  // the rest of the backup points at books by id
      } else if (kind === 'ref' || kind === 'ref?') {
        const n = Number(v);
        const ok = v !== null && v !== undefined && v !== '' && Number.isInteger(n) && bookIds.has(n);
        const none = v === null || v === undefined || v === '' || v === 0;
        // a card of a book that isn't in the backup is dropped (as the desktop app does); a looked-up word keeps its row
        if (ok) o[k] = n; else if (kind === 'ref' || (table === 'cards' && !none)) return null; else o[k] = null;
      } else if (kind === 'card') {  // a review of a card that isn't in the backup is dropped
        const n = Number(v);
        if (v === null || v === undefined || v === '' || !Number.isInteger(n) || !cardIds || !cardIds.has(n)) return null;
        o[k] = n;
      } else if (kind === 'i' || kind === 'r') {
        const n = typeof v === 'boolean' ? +v : Number(v);
        o[k] = v === null || v === undefined || v === '' || !Number.isFinite(n) ? (has && v !== undefined && v !== null && v !== '' ? 0 : def) : (kind === 'i' ? Math.trunc(n) : n);
      } else if (kind === 'day') {
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
        o[k] = v;
      } else if (kind === 'key') {
        if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
        if (typeof v !== 'string' || !v) return null;
        o[k] = v;
      } else {  // text
        if (v === null || v === undefined) o[k] = kind === 's?' ? null : def;
        else if (k === 'tags' && Array.isArray(v)) o[k] = v.map(str).join(',');
        else o[k] = str(v);
      }
    }
    if (table === 'books') {
      o.filename = String(o.filename).split(/[\\/]/).pop();
      if (!o.sha256) o.sha256 = 'restored-' + o.id;
      if (!o.filename) o.filename = o.sha256.slice(0, 20) + '.pdf';
      if (!['unread', 'reading', 'finished'].includes(o.status)) o.status = 'unread';
      if (!o.title.trim()) o.title = 'Untitled';
      o.rating = clamp(o.rating, 0, 5); o.favorite = o.favorite ? 1 : 0;
      try { const toc = JSON.parse(o.toc || '[]'); o.toc = Array.isArray(toc) ? o.toc : ''; } catch { o.toc = ''; }
    }
    if (table === 'notes') {
      if (!/^(#[0-9a-f]{3,8}|[a-z]{3,16})$/i.test(o.color)) o.color = 'yellow';
      if (!['note', 'highlight'].includes(o.kind)) o.kind = 'note';
      const rects = safeParse(o.rects, []);
      o.rects = JSON.stringify(Array.isArray(rects) ? rects.filter(Array.isArray).slice(0, 5000).map(x => x.slice(0, 4).map(n => +n || 0)) : []);
    }
    if (table === 'ink') {
      const st = safeParse(o.strokes, null);
      if (!Array.isArray(st)) return null;
      const clean = cleanStrokes(st);
      if (!clean.length) return null;
      o.strokes = JSON.stringify(clean);
    }
    if (table === 'cards' && !o.front.trim()) return null;
    if (table === 'reviews') {
      o.grade = clamp(o.grade, 0, 3); o.practice = o.practice ? 1 : 0;
      const p = prevState(o.prev); o.prev = Object.keys(p).length ? JSON.stringify(p) : '';
    }
    return o;
  }
  function cleanBackup(data) {
    const out = { books: [], settings: [] };
    const bySha = new Map(), byId = new Map();
    for (const r of data.books) {
      const b = cleanRow('books', r, null); if (!b) continue;
      // later rows win, like the Python app's INSERT OR REPLACE (ids and PDF hashes are unique)
      const old = bySha.get(b.sha256); if (old) byId.delete(old.id);
      const oldId = byId.get(b.id); if (oldId) bySha.delete(oldId.sha256);
      bySha.set(b.sha256, b); byId.set(b.id, b);
    }
    out.books = [...byId.values()];
    const ids = new Set(out.books.map(b => b.id));
    let cardIds = null;
    for (const t of ROW_TABLES) {  // cards come before reviews: a review needs its card
      const rows = (Array.isArray(data[t]) ? data[t] : []).map(r => cleanRow(t, r, ids, cardIds)).filter(Boolean);
      // rows that keep their id first, so a new id handed out to a row without one never overwrites another
      out[t] = [...rows.filter(r => 'id' in r), ...rows.filter(r => !('id' in r))];
      if (t === 'cards') cardIds = new Set(out.cards.filter(r => 'id' in r).map(r => r.id));
    }
    const st = data.settings;
    if (st && typeof st === 'object' && !Array.isArray(st)) for (const k of Object.keys(st)) out.settings.push([String(k).slice(0, 60), str(st[k]).slice(0, 2000)]);
    return out;
  }

  const OLD_DB_MSG = 'This backup was made by an older BookBoom. Make a new backup in BookBoom 1.7 or newer on your computer, then restore that one.';
  async function restore(request) {
    const fd = await formOf(request); const f = fd.get('file');
    if (!f || typeof f === 'string') return err('no file');
    let zip;
    try { zip = await readZip(f); } catch { return err('bad zip'); }
    const dj = zip.get('data.json');
    if (!dj) return err(zip.has('ketabyar.db') ? OLD_DB_MSG : 'not a BookBoom backup');
    const budget = { left: 1536 * 1024 * 1024 };  // most a restore may inflate in memory (backups store files uncompressed)
    let data;
    try { data = JSON.parse(await (await unzipEntry(f, dj, { max: 512 * 1024 * 1024, budget })).text()); }
    catch (e) { return err(e.tooBig ? 'This backup is too large to restore in the browser.' : 'This backup is damaged (its data.json could not be read).'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.books)) return err('not a BookBoom backup');
    const clean = cleanBackup(data);
    const pdfs = {}, covers = {}, recs = [];
    try {
      for (const b of clean.books) {
        const e = zip.get('library/' + b.filename);
        if (e && !pdfs[b.filename]) pdfs[b.filename] = await unzipEntry(f, e, { max: 8 * 1024 ** 4, type: 'application/pdf', budget });
        const c = zip.get(`covers/${b.id}.png`);
        if (c) covers[b.id] = await unzipEntry(f, c, { max: 20 * 1024 * 1024, type: 'image/png', budget });
      }
      const ids = new Set(clean.books.map(b => b.id));
      for (const [name, e] of zip) {
        const parts = name.split('/');
        if (parts[0] !== 'recordings' || parts.length !== 3 || !/^\d+$/.test(parts[1]) || !ids.has(+parts[1])) continue;
        const m = REC_NAME.exec(parts[2]);
        if (!m) continue;
        const type = 'audio/' + (m[3] === 'm4a' ? 'mp4' : m[3] === 'mp3' ? 'mpeg' : m[3]);
        recs.push({ book_id: +parts[1], name: parts[2], page: +m[1], created: new Date().toISOString().slice(0, 19) + 'Z', blob: await unzipEntry(f, e, { max: 64 * 1024 * 1024, type, budget }) });
      }
    } catch (e) { return err(e.tooBig ? 'A file in this backup is too large to restore in the browser.' : 'This backup is damaged (bad zip).'); }
    if (await count('books')) await takeSnapshot(true).catch(() => null);  // the library as it was, in case this backup is the wrong one
    return applyRestore(clean, pdfs, covers, recs);
  }
  // puts a cleaned backup in place of the library, in one transaction. PDFs, covers, recordings and page text the
  // backup doesn't carry are kept from this device when the same PDF (same hash) is here.
  async function applyRestore(clean, pdfs, covers, recs, keepExtras = false) {
    // keep PDFs already on this device when the backup was made without them
    const oldFiles = {};
    const wanted = new Set(clean.books.filter(b => !pdfs[b.filename]).map(b => b.sha256));
    const here = await all('books');
    if (wanted.size) for (const b of here) if (wanted.has(b.sha256)) { const fl = await get('files', b.id); if (fl) oldFiles[b.sha256] = fl; }
    if (keepExtras) {  // a snapshot: covers, recordings and page text come from this device, moved to the snapshot's book ids
      const toId = new Map(clean.books.map(b => [b.sha256, b.id])), moved = new Map();
      for (const b of here) if (toId.has(b.sha256)) moved.set(b.id, toId.get(b.sha256));
      for (const [from, to] of moved) {
        const c = await get('covers', from); if (c) covers[to] = c;
        (await all('recordings', 'book', from)).forEach(r => recs.push({ ...r, book_id: to }));
      }
      const has = new Set();
      for (const r of await all('pagetext')) if (moved.has(r.book_id)) { clean.pagetext.push({ ...r, book_id: moved.get(r.book_id) }); has.add(moved.get(r.book_id)); }
      for (const b of clean.books) if (!has.has(b.id)) b.pending_index = 1;  // searched again once its PDF is opened here
    }
    const stores = ['books', 'files', 'covers', 'pagetext', 'notes', 'bookmarks', 'cards', 'reviews', 'activity', 'settings', 'ink', 'lookup_history', 'lookup_cache', 'recordings'];
    let missingPdfs = 0;
    try {
      // one transaction: if anything fails (no space left, ...) the library stays as it was
      await tx(stores, 'readwrite', s => {
        stores.forEach(n => s[n].clear());
        for (const b of clean.books) {
          const file = pdfs[b.filename] || oldFiles[b.sha256];
          b.has_cover = covers[b.id] ? 1 : 0;
          if (!file) delete b.pending_index;
          s.books.put(b);
          if (file) s.files.put(file, b.id); else missingPdfs++;
          if (covers[b.id]) s.covers.put(covers[b.id], b.id);
        }
        for (const t of ROW_TABLES) clean[t].forEach(r => s[t].put(r));
        for (const [k, v] of clean.settings) s.settings.put(v, k);
        recs.forEach(r => s.recordings.put(r));
      });
    } catch (e) { return err('Restore failed, nothing was changed: ' + ((e && e.message) || e), e && e.name === 'QuotaExceededError' ? 507 : 500); }
    return json({ ok: true, books: clean.books.length, missing_pdfs: missingPdfs });
  }

  // ------------------------------------------------------------ safety snapshots (same API as the desktop app)
  const SNAP_KEEP = 7, SNAP_NAME = /^ketabyar-(\d{4}-\d{2}-\d{2})(?:-(\d{6}))?\.json$/;
  let snapBusy = null;
  async function takeSnapshot(force = false) {
    const day = today(), have = await all('snapshots');
    if (!force && have.some(x => x.day === day)) return null;
    const nb = await count('books');
    if (!nb && !force) return null;  // an empty library must not push out good snapshots
    const data = { app: 'ketabyar', format: 2, version: VERSION, exported: now(), settings: await getSettings() };
    for (const t of TABLES) data[t] = await all(t);
    data.books = data.books.map(b => { const o = { ...b }; delete o.pending_index; return o; });
    const t = now(), name = force ? `ketabyar-${day}-${t.slice(11, 19).replace(/:/g, '')}.json` : `ketabyar-${day}.json`;
    const snap = { name, day, time: t, books: nb, notes: data.notes.length, cards: data.cards.length, data: JSON.stringify(data) };
    snap.size = snap.data.length;
    const old = [...have.filter(x => x.name !== name), snap].sort((a, b) => b.name.localeCompare(a.name)).slice(SNAP_KEEP);
    await tx('snapshots', 'readwrite', s => { s.put(snap); old.forEach(o => s.delete(o.name)); });
    return snap;
  }
  // the daily snapshot, at most once at a time (the app asks for info on every start)
  function dailySnapshot() {
    if (!snapBusy) snapBusy = takeSnapshot().catch(() => null).finally(() => { snapBusy = null; });
    return snapBusy;
  }
  const snapInfo = x => ({ name: x.name, day: x.day, time: x.time, size: x.size, books: x.books, notes: x.notes, cards: x.cards });
  async function restoreSnapshot(name) {
    if (!SNAP_NAME.test(name)) return notFound();
    const x = await get('snapshots', name); if (!x) return notFound();
    const data = safeParse(x.data, null);
    if (!data || typeof data !== 'object' || !Array.isArray(data.books)) return err('This snapshot is damaged.');
    if (await count('books')) await takeSnapshot(true);  // the library as it is now, so this can be taken back too
    const clean = cleanBackup(data);
    return applyRestore(clean, {}, {}, [], true);
  }

  // ------------------------------------------------------------ router
  async function handle(request, path, url) {
    const m = request.method.toUpperCase();
    const body = async () => {
      try { const b = await request.clone().json(); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; } catch { return {}; }
    };
    const only = (...ms) => ms.includes(m);
    let r;
    if (path === 'snapshots') {
      if (m === 'GET') return json({ enabled: true, keep: SNAP_KEEP, trash_days: 0, items: (await all('snapshots')).sort((a, b) => b.name.localeCompare(a.name)).map(snapInfo) });
      if (m === 'POST') return json(snapInfo(await takeSnapshot(true)), 201);
      return methodNotAllowed();
    }
    if ((r = path.match(/^snapshots\/([^/]+)\/restore$/))) return m === 'POST' ? restoreSnapshot(decodeURIComponent(r[1])) : methodNotAllowed();
    if (path === 'info') await dailySnapshot();
    if (path === 'info') return json({ version: VERSION, local: true, books: await count('books'), search: true, covers: true, max_mb: 1024, lan: false, lan_urls: [], storage: await storageInfo() });
    if (path === 'books') {
      if (m === 'GET') return json(await listBooks());
      if (m !== 'POST') return methodNotAllowed();
      const fd = await formOf(request);
      const files = [...fd.getAll('files'), ...fd.getAll('file')].filter(f => f && typeof f !== 'string');
      if (!files.length) return err('no files');
      const coll = str(fd.get('collection') || '').trim();
      const out = [];
      for (const f of files) {
        try { const { book, created } = await importPdf(f, f.name || 'book.pdf', coll); out.push({ ok: true, created, book, name: f.name }); }
        catch (e) { out.push({ ok: false, name: f.name, error: friendly(e).message }); }
      }
      return json(out);
    }
    if (path === 'scan') return json([]);
    if ((r = path.match(/^books\/(\d+)$/))) {
      if (m === 'GET') { const b = await getBook(r[1]); return b ? json(withEta(bookJson(b), await secondsPerPage())) : notFound(); }
      if (m === 'PATCH') return editBook(r[1], await body());
      if (m === 'DELETE') return (await getBook(r[1])) ? deleteBook(r[1]) : notFound();
      return methodNotAllowed();
    }
    if ((r = path.match(/^books\/(\d+)\/(file|cover|progress|index|ink|bookmarks|notes|notes\.md|recordings)$/))) {
      const [, id, what] = r;
      if (what === 'file') return only('GET', 'HEAD') ? bookFile(id, url) : methodNotAllowed();
      if (what === 'cover') return m === 'POST' ? setCover(id, request) : only('GET', 'HEAD') ? cover(id) : methodNotAllowed();
      if (!(await getBook(id))) return notFound();
      if (what === 'progress') return m === 'POST' ? progress(id, await body()) : methodNotAllowed();
      if (what === 'index') return m === 'POST' ? indexBook(id, await body()) : methodNotAllowed();
      if (what === 'ink') return m === 'GET' ? getInk(id) : methodNotAllowed();
      if (what === 'bookmarks') {
        if (m === 'POST') return addBookmark(id, await body());
        return m === 'GET' ? json((await all('bookmarks', 'book', +id)).sort((a, b) => a.page - b.page)) : methodNotAllowed();
      }
      if (what === 'notes') {
        if (m === 'GET') return json((await all('notes', 'book', +id)).sort(byPageId).map(noteJson));
        if (m !== 'POST') return methodNotAllowed();
        const b = await body(); const t = now();
        const n = { book_id: +id, page: toInt(b.page || 1, 1), kind: ['note', 'highlight'].includes(b.kind) ? b.kind : 'note', color: noteColor(b.color),
          quote: str(b.quote || '').slice(0, 20000), body: str(b.body || '').slice(0, 50000), rects: JSON.stringify(b.rects || []), created: t, updated: t };
        n.id = await put('notes', n);
        return json(noteJson(n), 201);
      }
      if (what === 'notes.md') return m === 'GET' ? notesMd(id) : methodNotAllowed();
      if (what === 'recordings') {
        if (m !== 'GET') return methodNotAllowed();
        const page = toInt(url.searchParams.get('page'), 0);
        let items = (await all('recordings', 'book', +id)).filter(x => !page || x.page === page).map(recItem);
        items.sort((a, b) => b.name.localeCompare(a.name));
        return json(items);
      }
    }
    if ((r = path.match(/^books\/(\d+)\/ink\/(\d+)$/))) {
      if (m !== 'PUT') return methodNotAllowed();
      if (!(await getBook(r[1]))) return notFound();
      return putInk(r[1], r[2], await body());
    }
    if ((r = path.match(/^books\/(\d+)\/recordings\/(\d+)$/))) return m === 'POST' ? addRecording(r[1], r[2], request) : methodNotAllowed();
    if ((r = path.match(/^recordings\/(\d+)\/([^/]+)$/))) {
      let name; try { name = decodeURIComponent(r[2]); } catch { return notFound(); }
      if (!REC_NAME.test(name)) return notFound();
      const rec = await get('recordings', [+r[1], name]);
      if (!rec) return notFound();
      if (m === 'DELETE') { await del('recordings', [rec.book_id, rec.name]); return json({ ok: true }); }
      if (!only('GET', 'HEAD')) return methodNotAllowed();
      return new Response(rec.blob, { headers: { 'Content-Type': rec.blob.type || 'audio/webm', 'Content-Length': String(rec.blob.size) } });
    }
    if ((r = path.match(/^bookmarks\/(\d+)$/))) {
      if (m === 'DELETE') { await del('bookmarks', +r[1]); return json({ ok: true }); }
      if (m !== 'PATCH') return methodNotAllowed();
      const bm = await get('bookmarks', +r[1]); if (!bm) return notFound();
      bm.label = str((await body()).label || '').slice(0, 200); await put('bookmarks', bm); return json(bm);
    }
    if (path === 'notes') return m === 'GET' ? allNotes(url) : methodNotAllowed();
    if (path === 'notes.md') return m === 'GET' ? allNotesMd() : methodNotAllowed();
    if ((r = path.match(/^notes\/(\d+)$/))) {
      if (m === 'DELETE') { await del('notes', +r[1]); return json({ ok: true }); }
      if (m !== 'PATCH') return methodNotAllowed();
      const n = await get('notes', +r[1]); if (!n) return notFound();
      const b = await body(); let changed = false;
      for (const k of ['body', 'color', 'kind', 'quote']) if (k in b) { if (k === 'kind' && !['note', 'highlight'].includes(b[k])) continue; n[k] = k === 'color' ? noteColor(b[k]) : str(b[k]); changed = true; }
      if (changed) { n.updated = now(); await put('notes', n); }
      return json(noteJson(n));
    }
    if (path === 'cards') return m === 'POST' ? addCard(await body()) : m === 'GET' ? listCards(url) : methodNotAllowed();
    if (path === 'cards/export') return m === 'GET' ? exportCards(url) : methodNotAllowed();
    if (path === 'cards/import') return m === 'POST' ? importCards(request) : methodNotAllowed();
    if ((r = path.match(/^cards\/(\d+)$/))) {
      if (m === 'DELETE') { await tx(['cards', 'reviews'], 'readwrite', async s => { s.cards.delete(+r[1]); (await req(s.reviews.index('card').getAllKeys(+r[1]))).forEach(k => s.reviews.delete(k)); }); return json({ ok: true }); }
      if (m !== 'PATCH') return methodNotAllowed();
      const c = await get('cards', +r[1]); if (!c) return notFound();
      const b = await body();
      if ('front' in b) { const f = str(b.front ?? '').slice(0, 5000).trim(); if (!f) return err('front is required'); c.front = f; }
      if ('back' in b) c.back = str(b.back ?? '').slice(0, 20000);
      const yes = v => [true, 1, '1', 'true'].includes(v);
      if ('suspended' in b) c.suspended = yes(b.suspended) ? 1 : 0;
      if (yes(b.reset)) Object.assign(c, { ease: 2.5, interval: 0, reps: 0, lapses: 0, suspended: 0, due: now() });
      await put('cards', c); return json(c);
    }
    if ((r = path.match(/^cards\/(\d+)\/review$/))) return m === 'POST' ? reviewCard(r[1], await body()) : methodNotAllowed();
    if ((r = path.match(/^cards\/(\d+)\/undo$/))) return m === 'POST' ? undoReview(r[1]) : methodNotAllowed();
    if (path === 'lookups') {
      if (m === 'POST') return addLookup(await body());
      if (m === 'GET') return listLookups();
      if (m !== 'DELETE') return methodNotAllowed();
      const q = url.searchParams.get('q');
      if (q === null) await tx('lookup_history', 'readwrite', s => s.clear()); else await del('lookup_history', q);
      return json({ ok: true });
    }
    if (path === 'define') return define(url);
    if (path === 'translate') return translate(url);
    if (path === 'search') return search(url);
    if (path === 'stats') return stats(url);
    if (path === 'settings') {
      if (m === 'PUT') {  // same rules as app.py: null removes a setting, lists and objects are stored as JSON
        const b = await body();
        await tx('settings', 'readwrite', s => Object.entries(b).forEach(([k, v]) => {
          const key = String(k).slice(0, 60);
          if (v === null || v === undefined) s.delete(key);
          else s.put((typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 2000), key);
        }));
      }
      else if (m !== 'GET') return methodNotAllowed();
      return json(await getSettings());
    }
    if (path === 'backup') return m === 'GET' ? backup(url) : methodNotAllowed();
    if (path === 'restore') return m === 'POST' ? restore(request) : methodNotAllowed();
    return notFound();
  }
  async function storageInfo() {
    try { const e = await navigator.storage.estimate(); return { used: e.usage, quota: e.quota }; } catch { return null; }
  }

  // Android "Share → BookBoom" (installed app): store the PDF, then open the app on it
  async function shareTarget(request, base) {
    // The system share sheet sends no referrer. A post from another website (a form aimed at this address) does,
    // unless it hides it; either way it must not slip books into the library.
    if (request.referrer && request.referrer !== 'about:client' && new URL(request.referrer).origin !== new URL(base).origin) return Response.redirect(`${base}?shared=none`, 303);
    let first = null;
    try {
      const fd = await request.formData();
      for (const f of fd.getAll('files')) {
        if (!f || typeof f === 'string') continue;
        try { const { book } = await importPdf(f, f.name || 'shared.pdf', ''); first = first || book; } catch {}
      }
    } catch {}
    return Response.redirect(first ? `${base}#/read/${first.id}` : `${base}?shared=none`, 303);
  }

  return { handle, shareTarget, VERSION, schedule, csvRows, normalize, snippet, isoLocal, _test: { Z64, readZip, unzipEntry, zipStream, crc32, cleanBackup, open } };
})();
if (typeof module !== 'undefined') module.exports = KY;
