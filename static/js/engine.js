/* BookBoom in-browser server.
 * Used by the stand-alone web version (no Python): the service worker answers every api/ request
 * from IndexedDB on the device, with the same JSON the Python server returns.
 * Classic script (loaded with importScripts); needs fflate for backups. */
/* global fflate */
'use strict';
const KY = (() => {
  const VERSION = '2.1.0';
  const DB_NAME = 'ketabyar';
  const STORES = {
    books: { keyPath: 'id', autoIncrement: true, idx: [['sha256', 'sha256', { unique: true }]] },
    files: {}, covers: {},
    pagetext: { keyPath: ['book_id', 'page'], idx: [['book', 'book_id']] },
    notes: { keyPath: 'id', autoIncrement: true, idx: [['book', 'book_id']] },
    bookmarks: { keyPath: 'id', autoIncrement: true, idx: [['book', 'book_id']] },
    cards: { keyPath: 'id', autoIncrement: true, idx: [['book', 'book_id']] },
    activity: { keyPath: ['day', 'book_id'], idx: [['book', 'book_id']] },
    settings: {},
    ink: { keyPath: ['book_id', 'page'], idx: [['book', 'book_id']] },
    lookup_history: { keyPath: 'q' },
    lookup_cache: { keyPath: ['kind', 'q'] },
    recordings: { keyPath: ['book_id', 'name'], idx: [['book', 'book_id']] },
  };
  let _db;
  function open() {
    if (_db) return _db;
    _db = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const [name, o] of Object.entries(STORES)) {
          if (d.objectStoreNames.contains(name)) continue;
          const opts = {};
          if (o.keyPath) opts.keyPath = o.keyPath;
          if (o.autoIncrement) opts.autoIncrement = true;
          const s = d.createObjectStore(name, opts);
          for (const [n, k, io] of o.idx || []) s.createIndex(n, k, io || {});
        }
      };
      r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); _db = null; }; res(r.result); };
      r.onerror = () => { _db = null; rej(r.error); };
    });
    return _db;
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function tx(stores, mode, fn) {
    const d = await open();
    const t = d.transaction(stores, mode);
    const s = Array.isArray(stores) ? Object.fromEntries(stores.map(n => [n, t.objectStore(n)])) : t.objectStore(stores);
    const out = await fn(s, t);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); });
    return out;
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
  const download = (body, type, name) => new Response(body, { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}` } });
  const like = (hay, q) => (hay || '').toLowerCase().includes(q.toLowerCase());
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
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
  const normalize = s => (s || '').normalize('NFKD').replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, '').toLowerCase()
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');

  // ------------------------------------------------------------ books
  async function importPdf(blob, name, collection) {
    const buf = await blob.arrayBuffer();
    const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
    if (!head.includes('%PDF')) throw new Error('not a PDF file');
    const sha = await sha256(buf);
    const existing = await tx('books', 'readonly', s => req(s.index('sha256').get(sha)));
    if (existing) return { book: bookJson(existing), created: false };
    const b = {
      title: cleanTitle(name).slice(0, 300), author: '', description: '', filename: sha.slice(0, 20) + '.pdf', original_name: (name || '').slice(0, 300),
      sha256: sha, size: buf.byteLength, pages: 0, language: '', collection: collection || '', tags: '', favorite: 0, status: 'unread', rating: 0,
      last_page: 1, max_page: 0, zoom: 'width', seconds: 0, added: now(), last_opened: null, has_cover: 0, toc: '', pending_index: 1,
    };
    const id = await tx(['books', 'files'], 'readwrite', async s => {
      const id = await req(s.books.add(b));
      s.files.put(new Blob([buf], { type: 'application/pdf' }), id);
      return id;
    });
    b.id = id;
    return { book: bookJson(b), created: true };
  }

  async function listBooks() {
    const [books, notes, bms, cards] = await Promise.all([all('books'), all('notes'), all('bookmarks'), all('cards')]);
    const c = (arr, f) => arr.reduce((m, x) => (f(x) && (m[x.book_id] = (m[x.book_id] || 0) + 1), m), {});
    const h = c(notes, n => n.kind === 'highlight'), n = c(notes, n => n.kind === 'note'), bm = c(bms, () => true), cd = c(cards, () => true);
    books.sort((a, b) => (b.last_opened || b.added).localeCompare(a.last_opened || a.added));
    return books.map(b => ({ ...bookJson(b), highlights: h[b.id] || 0, notes: n[b.id] || 0, bookmarks: bm[b.id] || 0, cards: cd[b.id] || 0 }));
  }

  const EDITABLE = new Set(['toc', 'title', 'author', 'description', 'collection', 'tags', 'favorite', 'status', 'rating', 'zoom', 'language']);
  async function editBook(id, body) {
    const b = await getBook(id); if (!b) return notFound();
    for (let [k, v] of Object.entries(body || {})) {
      if (!EDITABLE.has(k)) continue;
      if (k === 'tags') v = [...new Set((Array.isArray(v) ? v : String(v).split(',')).map(x => String(x).trim()).filter(Boolean))].sort().join(',');
      if (k === 'favorite') v = v ? 1 : 0;
      if (k === 'toc') v = JSON.stringify((v || []).filter(i => i && typeof i === 'object').map(i => ({ title: String(i.title || '').slice(0, 300), page: parseInt(i.page || 1), level: parseInt(i.level || 0) })));
      if (k === 'status' && !['unread', 'reading', 'finished'].includes(v)) continue;
      if (k === 'rating') v = clamp(parseInt(v || 0), 0, 5);
      if (k === 'title' && !String(v).trim()) continue;
      b[k] = v;
    }
    await put('books', b);
    return json(bookJson(b));
  }

  async function deleteBook(id) {
    id = +id;
    await tx(['books', 'files', 'covers'], 'readwrite', s => { s.books.delete(id); s.files.delete(id); s.covers.delete(id); });
    await delByBook(['pagetext', 'notes', 'bookmarks', 'cards', 'activity', 'ink', 'recordings'], id);
    await tx('lookup_history', 'readwrite', async s => {
      for (const h of await req(s.getAll())) if (h.book_id === id) { h.book_id = null; s.put(h); }
    });
    return json({ ok: true });
  }

  async function progress(id, body) {
    const b = await getBook(id); if (!b) return notFound();
    let page = parseInt(body.page || b.last_page || 1);
    const secs = clamp(parseInt(body.seconds || 0), 0, 600);
    const pages = parseInt(body.pages || b.pages || 0);
    if (pages) page = clamp(page, 1, pages);
    const newPages = (secs || body.turned) ? Math.max(0, page - (b.max_page || 0)) : 0;
    let status = b.status;
    if (status === 'unread' && (secs || page > 1)) status = 'reading';
    if (pages && page >= pages && status !== 'finished') status = 'finished';
    Object.assign(b, { last_page: page, max_page: Math.max(b.max_page || 0, page), pages: pages > 0 ? pages : b.pages, seconds: (b.seconds || 0) + secs, last_opened: now(), status });
    await put('books', b);
    if (secs || newPages) await bumpActivity(b.id, { seconds: secs, pages: newPages });
    return json(bookJson(b));
  }

  // page-side indexer (pdf.js runs in the page) sends what Python's PyMuPDF used to extract
  async function indexBook(id, body) {
    const b = await getBook(id); if (!b) return notFound();
    const texts = Array.isArray(body.texts) ? body.texts : [];
    b.pages = parseInt(body.pages || b.pages || 0);
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
    return new Response(c, { headers: { 'Content-Type': c.type || 'image/png', 'Cache-Control': 'no-cache' } });
  }

  async function setCover(id, request) {
    const b = await getBook(id); if (!b) return notFound();
    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('multipart')) return err('the page sends the cover picture in this version');
    const fd = await request.formData();
    const img = fd.get('image');
    if (!img) return err('no image');
    await tx(['covers', 'books'], 'readwrite', s => { s.covers.put(img, b.id); b.has_cover = 1; s.books.put(b); });
    return json({ ok: true });
  }

  // ------------------------------------------------------------ ink / bookmarks / notes
  async function getInk(id) {
    const out = {};
    for (const r of await all('ink', 'book', +id)) out[String(r.page)] = safeParse(r.strokes, []);
    return json(out);
  }
  async function putInk(id, page, body) {
    const strokes = body.strokes || [];
    if (!Array.isArray(strokes)) return err('strokes must be a list');
    const clean = [];
    for (const st of strokes.slice(0, 3000)) {
      if (!st || !Array.isArray(st.p)) continue;
      const pts = st.p.slice(0, 4000).filter(p => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number').map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
      if (!pts.length) continue;
      clean.push({ t: st.t === 'hl' ? 'hl' : 'pen', c: String(st.c || '#1f3a8a').slice(0, 20), w: clamp(+st.w || 0.003, 0.0005, 0.08), p: pts });
    }
    if (clean.length) await put('ink', { book_id: +id, page: +page, strokes: JSON.stringify(clean), updated: now() });
    else await del('ink', [+id, +page]);
    return json({ page: +page, strokes: clean.length });
  }

  async function addBookmark(id, body) {
    const page = parseInt(body.page || 1);
    const ex = (await all('bookmarks', 'book', +id)).find(b => b.page === page);
    if (ex) return json(ex);
    const bm = { book_id: +id, page, label: String(body.label || '').slice(0, 200), created: now() };
    bm.id = await put('bookmarks', bm);
    return json(bm, 201);
  }

  async function allNotes(url) {
    const q = (url.searchParams.get('q') || '').trim(), book = url.searchParams.get('book'), color = url.searchParams.get('color');
    const titles = Object.fromEntries((await all('books')).map(b => [b.id, b.title]));
    let notes = await all('notes');
    notes = notes.filter(n => titles[n.book_id] !== undefined && (!book || n.book_id === +book) && (!q || like(n.quote, q) || like(n.body, q)) && (!color || n.color === color));
    notes.sort((a, b) => b.updated.localeCompare(a.updated));
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
    const safe = b.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
    return download(lines.join('\n'), 'text/markdown; charset=utf-8', `${safe} - notes.md`);
  }

  // ------------------------------------------------------------ flashcards
  function schedule(c, grade) {
    const when = new Date();
    let { ease, interval, reps, lapses } = c; let due;
    if (grade === 0) {
      reps = 0; lapses += 1; interval = 0; ease = Math.max(1.3, ease - 0.2);
      due = new Date(when.getTime() + 10 * 60000);
    } else {
      if (reps === 0) interval = { 1: 1, 2: 1, 3: 4 }[grade];
      else if (reps === 1) interval = { 1: 3, 2: 6, 3: 8 }[grade];
      else interval = interval * { 1: 1.2, 2: ease, 3: ease * 1.3 }[grade];
      ease = Math.max(1.3, ease + { 1: -0.15, 2: 0, 3: 0.15 }[grade]);
      reps += 1;
      due = new Date(when.getTime() + interval * 86400000);
    }
    return { ease: Math.round(ease * 1000) / 1000, interval: Math.round(interval * 1000) / 1000, reps, lapses, due: isoLocal(due) };
  }
  async function listCards(url) {
    const titles = Object.fromEntries((await all('books')).map(b => [b.id, b.title]));
    const book = url.searchParams.get('book'), due = url.searchParams.get('due') === '1', n = now();
    let cards = (await all('cards')).filter(c => (!book || c.book_id === +book) && (!due || c.due <= n));
    cards.sort((a, b) => a.due.localeCompare(b.due));
    return json(cards.slice(0, 5000).map(c => ({ ...c, book_title: c.book_id ? (titles[c.book_id] ?? null) : null })));
  }
  async function addCard(body) {
    const front = String(body.front || '').trim();
    if (!front) return err('front is required');
    const bookId = body.book_id ? +body.book_id : null;
    if (bookId && !(await getBook(bookId))) return notFound();
    const c = { book_id: bookId, page: parseInt(body.page || 0), front: front.slice(0, 5000), back: String(body.back || '').slice(0, 20000), due: now(), interval: 0, ease: 2.5, reps: 0, lapses: 0, created: now() };
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
  function decodeText(buf) {
    const u = new Uint8Array(buf);
    if (u[0] === 0xff && u[1] === 0xfe) return new TextDecoder('utf-16le').decode(u);
    if (u[0] === 0xfe && u[1] === 0xff) return new TextDecoder('utf-16be').decode(u);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u).replace(/^\ufeff/, ''); } catch {}
    try { return new TextDecoder('windows-1256').decode(u); } catch { return new TextDecoder('latin1').decode(u); }
  }
  async function importCards(request) {
    const fd = await request.formData(); const f = fd.get('file');
    if (!f) return err('no file');
    const lines = decodeText(await f.slice(0, 5000000).arrayBuffer()).split(/(?<=\n)/);
    while (lines.length && (lines[0].startsWith('#') || !lines[0].trim())) lines.shift();
    if (!lines.length) return json({ added: 0, skipped: 0 });
    const sample = lines.slice(0, 20).join('');
    const delim = sample.includes('\t') ? '\t' : ((sample.split(';').length > sample.split(',').length) ? ';' : ',');
    const bookId = fd.get('book_id') ? +fd.get('book_id') : null;
    const existing = new Set((await all('cards')).map(c => c.front.trim() + '\u0000' + (c.back || '').trim()));
    let added = 0, skipped = 0; const fresh = [];
    csvRows(lines.join(''), delim).forEach((cols, i) => {
      cols = cols.map(c => c.replace(/<br\s*\/?>/gi, '\n').trim());
      if (!cols.length || !cols[0]) return;
      if (i === 0 && ['front', 'question', 'word', 'term'].includes(cols[0].toLowerCase())) return;
      const front = cols[0].slice(0, 5000), back = (cols[1] || '').slice(0, 20000), k = front + '\u0000' + back;
      if (existing.has(k)) { skipped++; return; }
      existing.add(k); added++;
      fresh.push({ book_id: bookId, page: 0, front, back, due: now(), interval: 0, ease: 2.5, reps: 0, lapses: 0, created: now() });
    });
    await tx('cards', 'readwrite', s => fresh.forEach(c => s.add(c)));
    return json({ added, skipped });
  }
  async function exportCards(url) {
    const titles = Object.fromEntries((await all('books')).map(b => [b.id, b.title]));
    const book = url.searchParams.get('book');
    const cards = (await all('cards')).filter(c => !book || c.book_id === +book).sort((a, b) => a.id - b.id);
    const cell = v => /[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    let out = '#separator:tab\n#html:false\n#columns:Front\tBack\tTags\n';
    for (const c of cards) {
      const tag = (titles[c.book_id] || '').trim().replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60);
      out += [c.front, c.back || '', ('bookboom ' + tag).trim()].map(cell).join('\t') + '\n';
    }
    return download('\ufeff' + out, 'text/plain; charset=utf-8', 'bookboom-cards.txt');
  }
  async function reviewCard(id, body) {
    const c = await get('cards', +id); if (!c) return notFound();
    const grade = clamp(parseInt(body.grade ?? 2), 0, 3);
    Object.assign(c, schedule(c, grade));
    await put('cards', c);
    if (c.book_id) await bumpActivity(c.book_id, { reviews: 1 });
    return json(c);
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
    const q = String(body.q || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!q) return err('empty');
    let bookId = body.book_id ? +body.book_id : null;
    if (bookId && !(await getBook(bookId))) bookId = null;
    await tx('lookup_history', 'readwrite', async s => {
      const h = await req(s.get(q));
      if (h) { h.count += 1; h.last = now(); if (bookId) { h.book_id = bookId; h.page = parseInt(body.page || 0); } s.put(h); }
      else s.put({ q, book_id: bookId, page: parseInt(body.page || 0), count: 1, last: now() });
    });
    return json({ ok: true });
  }
  async function listLookups() {
    const titles = Object.fromEntries((await all('books')).map(b => [b.id, b.title]));
    const cardFronts = new Set((await all('cards')).map(c => c.front.trim().toLowerCase()));
    const cache = {};
    for (const c of await all('lookup_cache')) cache[c.kind + '\u0000' + c.q] = c.data;
    const hist = (await all('lookup_history')).sort((a, b) => b.last.localeCompare(a.last)).slice(0, 500);
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
        const nt = normalize(r.text);
        if (!res.every(re => re.test(nt))) continue;
        let score = 0; words.forEach(w => { score += nt.split(w).length - 1; });
        pages.push({ book_id: r.book_id, page: r.page, snip: snippet(r.text, nt, words), title: titles[r.book_id], _s: score });
      }
      if (book) pages.sort((a, b) => a.page - b.page); else pages.sort((a, b) => b._s - a._s);
      pages.forEach(p => delete p._s);
    }
    const ql = q.toLowerCase();
    const bookHits = book ? [] : books.filter(b => [b.title, b.author, b.tags, b.collection].some(v => (v || '').toLowerCase().includes(ql))).slice(0, 50).map(bookJson);
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
    let out = toks.slice(start, end).map((t, i) => (words.some(w => ntoks[start + i].includes(w)) && t.trim()) ? `[[${t}]]` : t).join('').replace(/\s+/g, ' ').trim();
    return (start > 0 ? '…' : '') + out + (end < toks.length ? '…' : '');
  }

  // ------------------------------------------------------------ stats / settings
  async function stats(url) {
    const days = parseInt(url.searchParams.get('days') || 30);
    const start = dayOffset(-(days - 1));
    const act = await all('activity');
    const per = {};
    for (const a of act) if (a.day >= start) { const p = per[a.day] || (per[a.day] = { seconds: 0, pages: 0, reviews: 0 }); p.seconds += a.seconds; p.pages += a.pages; p.reviews += a.reviews; }
    const series = [];
    for (let i = 0; i < days; i++) { const d = dayOffset(-(days - 1 - i)); const r = per[d] || {}; series.push({ day: d, seconds: r.seconds || 0, pages: r.pages || 0, reviews: r.reviews || 0 }); }
    const byDay = {};
    for (const a of act) { const p = byDay[a.day] || (byDay[a.day] = { s: 0, r: 0 }); p.s += a.seconds; p.r += a.reviews; }
    const active = new Set(Object.entries(byDay).filter(([, v]) => v.s >= 60 || v.r > 0).map(([k]) => k));
    let streak = 0, off = active.has(today()) ? 0 : -1;
    while (active.has(dayOffset(off))) { streak++; off--; }
    const books = await all('books'); const byStatus = {};
    books.forEach(b => { byStatus[b.status] = (byStatus[b.status] || 0) + 1; });
    const tops = {};
    for (const a of act) if (a.day >= start) tops[a.book_id] = (tops[a.book_id] || 0) + a.seconds;
    const titles = Object.fromEntries(books.map(b => [b.id, b.title]));
    const top = Object.entries(tops).filter(([id]) => titles[id] !== undefined).map(([id, s]) => ({ id: +id, title: titles[id], seconds: s })).sort((a, b) => b.seconds - a.seconds).slice(0, 5);
    const cards = await all('cards'); const n = now();
    const goal = (await get('settings', 'daily_goal')) || '20';
    return json({
      series, streak, total_seconds: act.reduce((s, a) => s + a.seconds, 0), total_pages: act.reduce((s, a) => s + a.pages, 0), by_status: byStatus, top,
      books: books.length, notes: await count('notes'), cards: cards.length, due: cards.filter(c => c.due <= n).length, goal: parseInt(goal), today: series[series.length - 1] || {},
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
    const blob = await request.blob();
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

  // ------------------------------------------------------------ backup / restore (zip with data.json, same format as the Python app)
  const TABLES = ['books', 'notes', 'bookmarks', 'cards', 'activity', 'ink', 'lookup_history', 'lookup_cache'];
  async function backup(url) {
    const withPdfs = url.searchParams.get('pdfs') !== '0';
    const data = { app: 'ketabyar', format: 2, version: VERSION, exported: now(), settings: await getSettings() };
    for (const t of TABLES) data[t] = await all(t);
    data.books = data.books.map(b => { const o = { ...b }; delete o.pending_index; return o; });
    data.pagetext = await all('pagetext');
    const books = await all('books'); const recs = await all('recordings');
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    (async () => {
      const zip = new fflate.Zip((e, chunk, final) => { if (e) { w.abort(e); return; } w.write(chunk).catch(() => {}); if (final) w.close().catch(() => {}); });
      const addBytes = (name, u8, level) => { const f = level === 0 ? new fflate.ZipPassThrough(name) : new fflate.ZipDeflate(name, { level: 6 }); zip.add(f); f.push(u8, true); };
      addBytes('data.json', fflate.strToU8(JSON.stringify(data)), 6);
      for (const b of books) {
        if (withPdfs) { const f = await get('files', b.id); if (f) addBytes(`library/${b.filename}`, new Uint8Array(await f.arrayBuffer()), 0); }
        const c = await get('covers', b.id); if (c) addBytes(`covers/${b.id}.png`, new Uint8Array(await c.arrayBuffer()), 0);
      }
      for (const r of recs) addBytes(`recordings/${r.book_id}/${r.name}`, new Uint8Array(await r.blob.arrayBuffer()), 0);
      zip.end();
    })().catch(e => w.abort(e));
    return new Response(readable, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="bookboom-backup-${today()}.zip"` } });
  }

  function unzipStream(blob, onFile) {
    // streams the zip so a large library never sits in memory twice
    return new Promise((resolve, reject) => {
      const pending = [];
      const uz = new fflate.Unzip(file => {
        const parts = [];
        pending.push(new Promise((res, rej) => {
          file.ondata = (e, chunk, final) => {
            if (e) { rej(e); return; }
            parts.push(chunk);
            if (final) res(onFile(file.name, parts));
          };
        }));
        file.start();
      });
      uz.register(fflate.UnzipInflate);
      const reader = blob.stream().getReader();
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { uz.push(new Uint8Array(0), true); break; }
          uz.push(value);
        }
        await Promise.all(pending);
        resolve();
      })().catch(reject);
    });
  }

  async function restore(request) {
    const fd = await request.formData(); const f = fd.get('file');
    if (!f) return err('no file');
    let data = null; const pdfs = {}, covers = {}, recs = [];
    let sawDb = false;
    try {
      await unzipStream(f, (name, parts) => {
        if (name === 'data.json') data = JSON.parse(fflate.strFromU8(concat(parts)));
        else if (name === 'ketabyar.db') sawDb = true;
        else if (name.startsWith('library/') && name.endsWith('.pdf')) pdfs[name.slice(8)] = new Blob(parts, { type: 'application/pdf' });
        else if (name.startsWith('covers/') && name.endsWith('.png')) covers[parseInt(name.slice(7))] = new Blob(parts, { type: 'image/png' });
        else if (name.startsWith('recordings/')) {
          const [, bid, fname] = name.split('/');
          const m = REC_NAME.exec(fname || '');
          if (m) recs.push({ book_id: +bid, name: fname, page: +m[1], created: new Date().toISOString().slice(0, 19) + 'Z', blob: new Blob(parts, { type: 'audio/' + (m[3] === 'm4a' ? 'mp4' : m[3] === 'mp3' ? 'mpeg' : m[3]) }) });
        }
      });
    } catch (e) { return err('bad zip'); }
    if (!data) return err(sawDb ? 'This backup was made by an older BookBoom. Make a new backup in BookBoom 1.7 or newer on your computer, then restore that one.' : 'not a BookBoom backup');
    const stores = ['books', 'files', 'covers', 'pagetext', 'notes', 'bookmarks', 'cards', 'activity', 'settings', 'ink', 'lookup_history', 'lookup_cache', 'recordings'];
    // keep PDFs already on this device when the backup was made without them
    const oldFiles = {};
    for (const b of await all('books')) { const fl = await get('files', b.id); if (fl) oldFiles[b.sha256] = fl; }
    await tx(stores, 'readwrite', s => {
      stores.forEach(n => s[n].clear());
      for (let b of data.books || []) {
        b = tidy(b); if (!b) continue;
        b.filename = String(b.filename || '').split(/[\\/]/).pop();
        const file = pdfs[b.filename] || oldFiles[b.sha256];
        s.books.put(b);
        if (file) s.files.put(file, b.id);
        if (covers[b.id]) s.covers.put(covers[b.id], b.id);
      }
      for (const t of ['notes', 'bookmarks', 'cards', 'activity', 'ink', 'lookup_history', 'lookup_cache', 'pagetext']) (data[t] || []).forEach(r => { r = tidy(r); if (r) s[t].put(r); });
      for (const [k, v] of Object.entries(data.settings || {})) s.settings.put(String(v), k);
      recs.forEach(r => s.recordings.put(r));
    });
    const missing = (data.books || []).filter(b => !pdfs[b.filename] && !oldFiles[b.sha256]).length;
    return json({ ok: true, books: (data.books || []).length, missing_pdfs: missing });
  }
  // a backup may come from anywhere: numbers must be numbers (ids, pages, times), colours plain words
  const NUMERIC = new Set(['id', 'book_id', 'page', 'pages', 'size', 'seconds', 'progress', 'last_page', 'rating', 'interval', 'reps', 'lapses', 'ease', 'count', 'favorite', 'has_cover']);
  function tidy(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      if (NUMERIC.has(k)) { const n = Number(v); o[k] = Number.isFinite(n) ? n : 0; }
      else if (k === 'color' && typeof v === 'string' && !/^(#[0-9a-f]{3,8}|[a-z]{3,16})$/i.test(v)) o[k] = 'yellow';
      else if (k === 'day' && typeof v === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
      else if (k === 'rects' && Array.isArray(v)) o[k] = v.filter(Array.isArray).map(x => x.slice(0, 4).map(n => +n || 0));
      else o[k] = v;
    }
    if ('id' in r && !o.id && r.id !== 0) delete o.id;
    return o;
  }
  function concat(parts) {
    const n = parts.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(n); let o = 0;
    parts.forEach(p => { out.set(p, o); o += p.length; }); return out;
  }

  // ------------------------------------------------------------ router
  async function handle(request, path, url) {
    const m = request.method;
    const body = async () => { try { return await request.clone().json(); } catch { return {}; } };
    let r;
    if (path === 'info') return json({ version: VERSION, local: true, books: await count('books'), search: true, covers: true, max_mb: 1024, lan: false, lan_urls: [], storage: await storageInfo() });
    if (path === 'books') {
      if (m === 'GET') return json(await listBooks());
      if (m === 'POST') {
        const fd = await request.formData();
        const files = [...fd.getAll('files'), ...fd.getAll('file')].filter(f => f && typeof f !== 'string');
        if (!files.length) return err('no files');
        const coll = String(fd.get('collection') || '').trim();
        const out = [];
        for (const f of files) {
          try { const { book, created } = await importPdf(f, f.name || 'book.pdf', coll); out.push({ ok: true, created, book, name: f.name }); }
          catch (e) { out.push({ ok: false, name: f.name, error: e.message }); }
        }
        return json(out);
      }
    }
    if (path === 'scan') return json([]);
    if ((r = path.match(/^books\/(\d+)$/))) {
      if (m === 'GET') { const b = await getBook(r[1]); return b ? json(bookJson(b)) : notFound(); }
      if (m === 'PATCH') return editBook(r[1], await body());
      if (m === 'DELETE') return deleteBook(r[1]);
    }
    if ((r = path.match(/^books\/(\d+)\/(file|cover|progress|index|ink|bookmarks|notes|notes\.md|recordings)$/))) {
      const [, id, what] = r;
      if (what === 'file') return bookFile(id, url);
      if (what === 'cover') return m === 'POST' ? setCover(id, request) : cover(id);
      if (!(await getBook(id))) return notFound();
      if (what === 'progress') return progress(id, await body());
      if (what === 'index') return indexBook(id, await body());
      if (what === 'ink') return getInk(id);
      if (what === 'bookmarks') return m === 'POST' ? addBookmark(id, await body()) : json((await all('bookmarks', 'book', +id)).sort((a, b) => a.page - b.page));
      if (what === 'notes') {
        if (m === 'GET') return json((await all('notes', 'book', +id)).sort(byPageId).map(noteJson));
        const b = await body(); const t = now();
        const n = { book_id: +id, page: parseInt(b.page || 1), kind: ['note', 'highlight'].includes(b.kind) ? b.kind : 'note', color: String(b.color || 'yellow').slice(0, 20),
          quote: String(b.quote || '').slice(0, 20000), body: String(b.body || '').slice(0, 50000), rects: JSON.stringify(b.rects || []), created: t, updated: t };
        n.id = await put('notes', n);
        return json(noteJson(n), 201);
      }
      if (what === 'notes.md') return notesMd(id);
      if (what === 'recordings') {
        const page = url.searchParams.get('page');
        let items = (await all('recordings', 'book', +id)).filter(x => !page || x.page === +page).map(recItem);
        items.sort((a, b) => b.name.localeCompare(a.name));
        return json(items);
      }
    }
    if ((r = path.match(/^books\/(\d+)\/ink\/(\d+)$/)) && m === 'PUT') return putInk(r[1], r[2], await body());
    if ((r = path.match(/^books\/(\d+)\/recordings\/(\d+)$/)) && m === 'POST') return addRecording(r[1], r[2], request);
    if ((r = path.match(/^recordings\/(\d+)\/([^/]+)$/))) {
      if (!REC_NAME.test(r[2])) return notFound();
      const rec = await get('recordings', [+r[1], decodeURIComponent(r[2])]);
      if (!rec) return notFound();
      if (m === 'DELETE') { await del('recordings', [rec.book_id, rec.name]); return json({ ok: true }); }
      return new Response(rec.blob, { headers: { 'Content-Type': rec.blob.type || 'audio/webm', 'Content-Length': String(rec.blob.size) } });
    }
    if ((r = path.match(/^bookmarks\/(\d+)$/))) {
      if (m === 'DELETE') { await del('bookmarks', +r[1]); return json({ ok: true }); }
      const bm = await get('bookmarks', +r[1]); if (!bm) return json({});
      bm.label = String((await body()).label || '').slice(0, 200); await put('bookmarks', bm); return json(bm);
    }
    if (path === 'notes') return allNotes(url);
    if ((r = path.match(/^notes\/(\d+)$/))) {
      if (m === 'DELETE') { await del('notes', +r[1]); return json({ ok: true }); }
      const n = await get('notes', +r[1]); if (!n) return notFound();
      const b = await body(); let changed = false;
      for (const k of ['body', 'color', 'kind', 'quote']) if (k in b) { n[k] = b[k]; changed = true; }
      if (changed) { n.updated = now(); await put('notes', n); }
      return json(noteJson(n));
    }
    if (path === 'cards') return m === 'POST' ? addCard(await body()) : listCards(url);
    if (path === 'cards/export') return exportCards(url);
    if (path === 'cards/import') return importCards(request);
    if ((r = path.match(/^cards\/(\d+)$/))) {
      if (m === 'DELETE') { await del('cards', +r[1]); return json({ ok: true }); }
      const c = await get('cards', +r[1]); if (!c) return json({});
      const b = await body(); for (const k of ['front', 'back']) if (k in b) c[k] = b[k];
      await put('cards', c); return json(c);
    }
    if ((r = path.match(/^cards\/(\d+)\/review$/))) return reviewCard(r[1], await body());
    if (path === 'lookups') {
      if (m === 'POST') return addLookup(await body());
      if (m === 'GET') return listLookups();
      const q = url.searchParams.get('q');
      if (q === null) await tx('lookup_history', 'readwrite', s => s.clear()); else await del('lookup_history', q);
      return json({ ok: true });
    }
    if (path === 'define') return define(url);
    if (path === 'translate') return translate(url);
    if (path === 'search') return search(url);
    if (path === 'stats') return stats(url);
    if (path === 'settings') {
      if (m === 'PUT') { const b = await body(); await tx('settings', 'readwrite', s => Object.entries(b).forEach(([k, v]) => s.put(String(v).slice(0, 2000), String(k).slice(0, 60)))); }
      return json(await getSettings());
    }
    if (path === 'backup') return backup(url);
    if (path === 'restore') return restore(request);
    return notFound();
  }
  async function storageInfo() {
    try { const e = await navigator.storage.estimate(); return { used: e.usage, quota: e.quota }; } catch { return null; }
  }

  // Android "Share → BookBoom" (installed app): store the PDF, then open the app on it
  async function shareTarget(request, base) {
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

  return { handle, shareTarget, VERSION, schedule, csvRows, normalize, snippet, isoLocal };
})();
if (typeof module !== 'undefined') module.exports = KY;
