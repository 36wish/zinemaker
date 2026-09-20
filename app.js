/* Zine Maker — one sheet of paper, eight panels.
   Document state lives in localStorage; image bytes live in IndexedDB, kept
   out of that JSON so a handful of photos never blow its budget. Export
   rasterises the sheet through an SVG <foreignObject> and wraps the JPEG in
   a hand-rolled PDF, so there are no dependencies. */

'use strict';

const $ = s => document.querySelector(s);
const PT = 72 / 25.4;                       // points per millimetre
const KEY = 'zinemaker.v1';
const DPI = 300;

const PAPER = {                              // portrait, millimetres
  a4:     { w: 210,   h: 297,   label: 'A4' },
  letter: { w: 215.9, h: 279.4, label: 'US Letter' }
};

/* Imposition. Sheet is landscape, 4 columns x 2 rows.
   Top row prints rotated 180 degrees.
       [5] [4] [3] [2]    <- upside down
       [6] [7] [8] [1]
   The slit runs along the middle, across the two centre columns. */
const IMPOSE = [
  { col: 3, row: 1, rot: 0 },    // 1  front cover
  { col: 3, row: 0, rot: 180 },  // 2
  { col: 2, row: 0, rot: 180 },  // 3
  { col: 1, row: 0, rot: 180 },  // 4
  { col: 0, row: 0, rot: 180 },  // 5
  { col: 0, row: 1, rot: 0 },    // 6
  { col: 1, row: 1, rot: 0 },    // 7
  { col: 2, row: 1, rot: 0 }     // 8  back cover
];
const LABELS = ['cover', '2', '3', '4', '5', '6', '7', 'back'];

/* Facing pages, as they meet when the folded booklet is opened: the back and
   front covers sit together on the outside, then 2|3, 4|5, 6|7 within. */
const SPREADS = [[7, 0], [1, 2], [3, 4], [5, 6]];

const FONTS = [
  { n: 'Sans',       c: '"Helvetica Neue",Arial,sans-serif' },
  { n: 'Serif',      c: 'Georgia,"Times New Roman",serif' },
  { n: 'Typewriter', c: '"Courier New",Courier,monospace' },
  { n: 'Impact',     c: 'Impact,Haettenschweiler,"Arial Black",sans-serif' },
  { n: 'Heavy',      c: '"Arial Black",Gadget,sans-serif' },
  { n: 'Comic',      c: '"Comic Sans MS","Chalkboard SE",cursive' },
  { n: 'Script',     c: '"Brush Script MT","Segoe Script",cursive' },
  { n: 'Condensed',  c: '"Arial Narrow","Liberation Sans Narrow",sans-serif' }
];
const FILTERS = [
  { v: 'none',   n: 'None' },
  { v: 'bw',     n: 'B&W' },
  { v: 'copy',   n: 'Photocopy' },
  { v: 'ink',    n: 'High contrast' },
  { v: 'invert', n: 'Negative' }
];

/* ------------------------------------------------------------------ state */

const uid = () => Math.random().toString(36).slice(2, 9);
const blankPanel = () => ({ bg: '#ffffff', els: [] });
const blankDoc = n => ({ panels: Array.from({ length: n }, blankPanel) });

let state = {
  v: 1, paper: 'a4', title: 'untitled zine', active: 0,
  margin: 5,                        // mm of unprintable edge to stay clear of
  trimMargin: false,                // trim that edge off after printing, for an edge-to-edge zine
  cut: true,                        // print a guide along the slit
  guides: false,                    // print dotted panel outlines
  singleView: false,                // phone only: one panel on screen instead of the spread
  docs: { mini: blankDoc(8) }
};

const clampMargin = m => Math.min(25, Math.max(0, isFinite(m) ? m : 0));

/* The panels must stay exactly a quarter of the sheet wide and half of it
   tall, or the folds stop landing on the panel edges. So the printer margin
   is not a scale factor: it is a rim of the sheet that cannot be printed, and
   whichever panel edges lie along that rim lose a few mm.

   Which edges those are depends on where the panel sits in the imposition and
   which way up it prints — the top row is upside down, so the sheet's top edge
   is that panel's *bottom*. Returns millimetres in the panel's own
   orientation, or null when there is no margin — or when trimming before
   folding, since then the panel grid is already inset clear of the rim. */
function unsafeEdges(pi) {
  if (state.trimMargin) return null;
  const m = clampMargin(state.margin);
  if (!m) return null;
  const c = IMPOSE[pi];
  if (!c) return null;
  const onSheet = {
    l: c.col === 0 ? m : 0,
    r: c.col === 3 ? m : 0,
    t: c.row === 0 ? m : 0,
    b: c.row === 1 ? m : 0
  };
  return c.rot === 180
    ? { t: onSheet.b, b: onSheet.t, l: onSheet.r, r: onSheet.l }
    : onSheet;
}

let selId = null, editingId = null, curZoom = 1;
const nodes = new Map();
let hist = [], future = [];

const doc = () => state.docs.mini;
const panel = () => doc().panels[state.active] || doc().panels[0];

/* Which panels are on screen: both halves of the current spread, unless a
   phone has been asked for just the one — everything downstream (the sheet,
   its zoom, the labels above it, the spine) works off this list rather than
   state.active alone, so that one flag is all setSingleView() has to touch.
   Ignored on a wide screen even if it is set, so resizing back down to a
   phone with it already on picks up right where it left off. */
function visiblePanels() {
  if (narrow() && state.singleView) return [state.active];
  return SPREADS.find(s => s.indexOf(state.active) >= 0) || [state.active];
}

/* The selection may live in either visible panel, so look it up by id. */
function findSel() {
  for (const pi of visiblePanels()) {
    const el = doc().panels[pi].els.find(e => e.id === selId);
    if (el) return { el: el, pi: pi };
  }
  return null;
}
const selected = () => { const f = findSel(); return f ? f.el : null; };
const selPanel = () => { const f = findSel(); return f ? doc().panels[f.pi] : panel(); };

/* Trimming before folding removes the margin from the sheet first, so the
   panel grid itself has to shrink and shift inward to match — otherwise the
   folds, made on the smaller trimmed paper, would land off the artwork.
   Leaving the border keeps panels at a full quarter/half of the sheet, as
   before, with offsetX/Y at zero. */
function geom() {
  const p = PAPER[state.paper];
  const sw = p.h * PT, sh = p.w * PT;           // landscape sheet
  const m = (state.trimMargin ? clampMargin(state.margin) : 0) * PT;
  return {
    sheetW: sw, sheetH: sh,
    panelW: (sw - 2 * m) / 4, panelH: (sh - 2 * m) / 2,
    offsetX: m, offsetY: m,
    count: 8
  };
}

/* -------------------------------------------------------------- persistence */

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

async function saveNow() {
  try { await migrateImages(); } catch (err) { /* IndexedDB unavailable: src stays inline below */ }
  const docs = JSON.parse(JSON.stringify(state.docs));
  Object.values(docs).forEach(d => d.panels.forEach(p => p.els.forEach(el => {
    if (el.type === 'image' && el.assetId) delete el.src;
  })));
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.assign({}, state, { docs: docs })));
  } catch (err) {
    toast('Browser storage is full — recent changes were not saved.', 5000);
  }
}

async function load() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch (err) { /* private mode */ }
  if (!raw) return false;
  try {
    const s = JSON.parse(raw);
    if (!s || !s.docs) return false;
    state = {
      v: 1,
      paper: PAPER[s.paper] ? s.paper : 'a4',
      title: typeof s.title === 'string' ? s.title : 'untitled zine',
      active: 0,
      margin: clampMargin(s.margin == null ? 5 : s.margin),
      trimMargin: !!s.trimMargin,
      cut: s.cut !== false,
      guides: !!s.guides,
      singleView: !!s.singleView,
      docs: { mini: fixDoc(s.docs.mini, 8) }
    };
    state.active = Math.min(Math.max(0, s.active | 0), doc().panels.length - 1);
    await hydrateImages();
    return true;
  } catch (err) { return false; }
}

function fixDoc(d, n) {
  const out = blankDoc(n);
  const src = (d && Array.isArray(d.panels)) ? d.panels : [];
  for (let i = 0; i < n; i++) {
    if (!src[i]) continue;
    out.panels[i].bg = src[i].bg || '#ffffff';
    out.panels[i].els = (Array.isArray(src[i].els) ? src[i].els : [])
      .filter(e => e && (e.type === 'text' || e.type === 'image' || e.type === 'qr'))
      .map(e => Object.assign({}, e, { id: e.id || uid() }));
  }
  return out;
}

/* --------------------------------------------------------------- images

   Image bytes live in IndexedDB, not localStorage: a zine with more than a
   couple of photos would blow the ~5 MB localStorage budget long before the
   1500px downscale in importImage() ever came close. An image element in
   state.docs carries assetId, a hash of its bytes, in place of the src data
   URL it needs to render — saveNow() drops src before writing to
   localStorage once an element has an assetId, and hydrateImages() rebuilds
   src from IndexedDB after a reload. Content-addressing means two elements
   sharing a photo share one row for free, the same dedup saveZine() already
   does for the .zine file — and a freshly imported image, or one read back
   from a .zine, is simply src with no assetId yet, so it is migrated into
   IndexedDB the first time saveNow() runs rather than needing its own path.

   Nothing is deleted mid-session: an element that stops using a photo just
   leaves its row unreferenced. pruneImages() runs once, right after load(),
   because that is the only moment nothing else — undo history included,
   which lives in memory only and does not survive a reload — could still
   need it. */

let imageDbPromise = null;
function imageDb() {
  if (!imageDbPromise) {
    imageDbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
      const req = indexedDB.open('zinemaker-images', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('images');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return imageDbPromise;
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* A fast, non-cryptographic hash: a collision would only ever show the
   wrong photo, never anything security-sensitive, and this has to run on
   every image add without an async round trip. */
function contentId(bytes) {
  let h1 = 0x811c9dc5, h2 = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
    h2 = Math.imul(h2 ^ bytes[bytes.length - 1 - i], 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') +
         (h2 >>> 0).toString(16).padStart(8, '0') +
         bytes.length.toString(16);
}

async function putImage(dataUrl) {
  const a = dataUrlBytes(dataUrl);
  if (!a) return null;
  const id = contentId(a.bytes);
  const db = await imageDb();
  const store = db.transaction('images', 'readwrite').objectStore('images');
  const existing = await idbRequest(store.get(id));
  if (!existing) await idbRequest(store.put({ type: a.type, bytes: a.bytes }, id));
  return id;
}

async function getImage(id) {
  const db = await imageDb();
  return idbRequest(db.transaction('images', 'readonly').objectStore('images').get(id));
}

async function pruneImages(keepIds) {
  const db = await imageDb();
  const store = db.transaction('images', 'readwrite').objectStore('images');
  const keys = await idbRequest(store.getAllKeys());
  keys.forEach(k => { if (!keepIds.has(k)) store.delete(k); });
}

/* Give every image element still holding only its in-memory src (freshly
   added, or read back from a .zine file) a home in IndexedDB and an
   assetId, the first time it is saved. */
async function migrateImages() {
  for (const d of Object.values(state.docs)) {
    for (const p of d.panels) {
      for (const el of p.els) {
        if (el.type === 'image' && !el.assetId && typeof el.src === 'string') {
          const id = await putImage(el.src);
          if (id) el.assetId = id;
        }
      }
    }
  }
}

/* Fill in the data URL every image element needs to render — localStorage
   never held it, only assetId — then drop anything IndexedDB is holding
   that the document just loaded does not reference any more. */
async function hydrateImages() {
  const keep = new Set();
  for (const d of Object.values(state.docs)) {
    for (const p of d.panels) {
      for (const el of p.els) {
        if (el.type !== 'image' || !el.assetId) continue;
        keep.add(el.assetId);
        if (typeof el.src === 'string') continue;
        try {
          const rec = await getImage(el.assetId);
          if (rec) el.src = bytesDataUrl(rec.type, rec.bytes);
        } catch (err) { /* IndexedDB unavailable: element renders empty */ }
      }
    }
  }
  try { await pruneImages(keep); } catch (err) { /* not critical */ }
}

/* ------------------------------------------------------------------ history */

function pushHistory() {
  hist.push(JSON.stringify(state.docs));
  if (hist.length > 10) hist.shift();
  future.length = 0;
  syncUndo();
}
function undo() {
  if (!hist.length) return;
  future.push(JSON.stringify(state.docs));
  state.docs = JSON.parse(hist.pop());
  afterTimeTravel();
}
function redo() {
  if (!future.length) return;
  hist.push(JSON.stringify(state.docs));
  state.docs = JSON.parse(future.pop());
  afterTimeTravel();
}
function afterTimeTravel() {
  state.active = Math.min(state.active, doc().panels.length - 1);
  if (!selected()) selId = null;
  editingId = null;
  syncUndo(); paintAll(); save();
}
function syncUndo() {
  $('#undo').disabled = !hist.length;
  $('#redo').disabled = !future.length;
}

/* ---------------------------------------------------------------- elements */

function addText() {
  stopEdit();
  const g = geom();
  const el = {
    id: uid(), type: 'text',
    x: Math.round(g.panelW * 0.12), y: Math.round(g.panelH * 0.4),
    w: Math.round(g.panelW * 0.76), rot: 0,
    text: 'type here', font: 0, size: 13,
    color: '#111111', align: 'left', lh: 1.35, ls: 0,
    bold: false, italic: false, bg: '', pad: 4
  };
  pushHistory();
  panel().els.push(el);
  selId = el.id;
  paintAll(); save();
  startEdit(el.id, true);
}

async function addImageFiles(fileList) {
  const files = [...fileList].filter(f => /^image\//.test(f.type));
  if (!files.length) return;
  toast('Processing ' + files.length + ' image' + (files.length > 1 ? 's' : '') + '...');
  const g = geom();
  pushHistory();
  for (const f of files) {
    let img;
    try { img = await importImage(f); }
    catch (err) { toast('Could not read ' + f.name, 3000); continue; }
    const maxW = g.panelW * 0.8, maxH = g.panelH * 0.55;
    let w = maxW, h = w * img.h / img.w;
    if (h > maxH) { h = maxH; w = h * img.w / img.h; }
    panel().els.push({
      id: uid(), type: 'image',
      x: Math.round((g.panelW - w) / 2), y: Math.round((g.panelH - h) / 2),
      w: Math.round(w), h: Math.round(h), rot: 0,
      src: img.src, fit: 'cover', filter: 'none', opacity: 1, radius: 0
    });
    selId = panel().els[panel().els.length - 1].id;
  }
  paintAll(); save();
  hideToast();
}

/* Downscale on import: full-resolution photos blow the 5 MB storage budget
   long before they improve a page that prints 74 mm wide. */
function importImage(file) {
  const MAX = 1500;
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        let src;
        try {
          src = hasAlpha(ctx, w, h)
            ? cv.toDataURL('image/png')
            : cv.toDataURL('image/jpeg', 0.85);
        } catch (err) { src = fr.result; }
        if (src.length > fr.result.length) src = fr.result;
        resolve({ src, w, h });
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

function hasAlpha(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4 * 17) if (d[i] < 250) return true;
  return false;
}

function addQr() {
  stopEdit();
  const g = geom();
  const side = Math.round(Math.min(g.panelW, g.panelH) * 0.42);
  const el = {
    id: uid(), type: 'qr',
    x: Math.round((g.panelW - side) / 2), y: Math.round((g.panelH - side) / 2),
    w: side, h: side, rot: 0,
    text: 'https://example.com', ecl: 'M',
    dark: '#111111', light: '#ffffff', quiet: 4, opacity: 1
  };
  pushHistory();
  panel().els.push(el);
  selId = el.id;
  paintAll(); save();
}

function duplicateSel() {
  const el = selected(), p = selPanel(); if (!el) return;
  stopEdit(); pushHistory();
  const copy = Object.assign({}, el, { id: uid(), x: el.x + 8, y: el.y + 8 });
  p.els.push(copy);
  selId = copy.id;
  paintAll(); save();
}

function removeSel() {
  const el = selected(), p = selPanel(); if (!el) return;
  stopEdit(); pushHistory();
  p.els = p.els.filter(e => e.id !== el.id);
  selId = null;
  paintAll(); save();
}

function layer(dir) {
  const els = selPanel().els;
  const i = els.findIndex(e => e.id === selId);
  if (i < 0) return;
  const j = dir === 'front' ? els.length - 1 : dir === 'back' ? 0
          : Math.min(els.length - 1, Math.max(0, i + dir));
  if (i === j) return;
  pushHistory();
  els.splice(j, 0, els.splice(i, 1)[0]);
  paintAll(); save();
}

/* ---------------------------------------------------------------- layouts */

/* Slot geometry is in fractions of the panel, so one table serves both the
   panels of any paper size. Text sizes are fractions of
   the panel width for the same reason. */
const TEMPLATES = [
  { n: 'Cover', slots: [
    { t: 'image', x: 0, y: 0, w: 1, h: .58 },
    { t: 'text', x: .08, y: .63, w: .84, size: .13, lh: .98, font: 3, align: 'left', text: 'TITLE' },
    { t: 'text', x: .08, y: .88, w: .84, size: .042, font: 2, align: 'left', text: 'issue one' }
  ] },
  { n: 'Full bleed', slots: [
    { t: 'image', x: 0, y: 0, w: 1, h: 1 },
    { t: 'text', x: .06, y: .84, w: .88, size: .045, font: 0, align: 'left',
      bg: '#ffffff', text: 'caption' }
  ] },
  { n: 'Photo, text', slots: [
    { t: 'image', x: .08, y: .08, w: .84, h: .42 },
    { t: 'text', x: .08, y: .55, w: .84, size: .075, font: 4, align: 'left', text: 'HEADING' },
    { t: 'text', x: .08, y: .68, w: .84, size: .042, lh: 1.45, font: 0, align: 'left', text: 'body copy' }
  ] },
  { n: 'Text, photo', slots: [
    { t: 'text', x: .08, y: .07, w: .84, size: .075, font: 4, align: 'left', text: 'HEADING' },
    { t: 'text', x: .08, y: .2, w: .84, size: .042, lh: 1.45, font: 0, align: 'left', text: 'body copy' },
    { t: 'image', x: .08, y: .52, w: .84, h: .4 }
  ] },
  { n: 'Stacked', slots: [
    { t: 'image', x: .08, y: .07, w: .84, h: .35 },
    { t: 'image', x: .08, y: .45, w: .84, h: .35 },
    { t: 'text', x: .08, y: .84, w: .84, size: .04, font: 2, align: 'center', text: 'caption' }
  ] },
  { n: 'Four up', slots: [
    { t: 'image', x: .07, y: .08, w: .41, h: .34 },
    { t: 'image', x: .52, y: .08, w: .41, h: .34 },
    { t: 'image', x: .07, y: .46, w: .41, h: .34 },
    { t: 'image', x: .52, y: .46, w: .41, h: .34 },
    { t: 'text', x: .07, y: .84, w: .86, size: .038, font: 2, align: 'center', text: 'caption' }
  ] },
  { n: 'Quote', slots: [
    { t: 'text', x: .1, y: .3, w: .8, size: .095, lh: 1.15, font: 1, align: 'center',
      italic: true, text: 'a line worth\nsetting large' },
    { t: 'text', x: .1, y: .72, w: .8, size: .038, font: 2, align: 'center', text: '— source' }
  ] },
  { n: 'Columns', slots: [
    { t: 'text', x: .07, y: .07, w: .86, size: .07, font: 4, align: 'left', text: 'HEADING' },
    { t: 'text', x: .07, y: .22, w: .41, size: .034, lh: 1.5, font: 0, align: 'left', text: 'left column' },
    { t: 'text', x: .52, y: .22, w: .41, size: .034, lh: 1.5, font: 0, align: 'left', text: 'right column' }
  ] },
  { n: 'Collage', slots: [
    { t: 'image', x: .04, y: .1, w: .52, h: .34, rot: -6 },
    { t: 'image', x: .42, y: .3, w: .5, h: .32, rot: 5 },
    { t: 'image', x: .1, y: .55, w: .54, h: .33, rot: -3 },
    { t: 'text', x: .5, y: .8, w: .45, size: .05, font: 5, align: 'center', rot: 4,
      bg: '#ffffff', text: 'cut + paste' }
  ] },
  { n: 'Back + QR', slots: [
    { t: 'text', x: .1, y: .12, w: .8, size: .055, font: 4, align: 'center', text: 'THANKS' },
    { t: 'qr', x: .3, y: .34, w: .4 },
    { t: 'text', x: .1, y: .76, w: .8, size: .034, lh: 1.4, font: 2, align: 'center',
      text: 'made on a photocopier' }
  ] }
];

function slotDefault(s) {
  if (s.t === 'qr') {
    return { id: uid(), type: 'qr', x: 0, y: 0, w: 10, h: 10, rot: 0,
             text: 'https://example.com', ecl: 'M', dark: '#111111',
             light: '#ffffff', quiet: 4, opacity: 1 };
  }
  return { id: uid(), type: 'text', x: 0, y: 0, w: 10, rot: 0,
           text: s.text || 'text', font: 0, size: 12, color: '#111111',
           align: 'left', lh: 1.35, ls: 0, bold: false, italic: false,
           bg: '', pad: 4 };
}

/* Pour whatever is already on the panel into the template's slots, in order,
   and leave anything left over exactly where it was. */
function applyTemplate(tpl) {
  stopEdit();
  pushHistory();
  const p = panel(), g = geom();
  const pool = { text: [], image: [], qr: [] };
  p.els.forEach(e => { if (pool[e.type]) pool[e.type].push(e); });

  const placed = [], used = {};
  tpl.slots.forEach(s => {
    let el = pool[s.t].shift();
    if (!el) {
      if (s.t === 'image') return;        // no photo to put here: leave it empty
      el = slotDefault(s);
    }
    used[el.id] = 1;
    el.x = Math.round(s.x * g.panelW);
    el.y = Math.round(s.y * g.panelH);
    el.w = Math.round(s.w * g.panelW);
    el.rot = s.rot || 0;
    if (s.t === 'image') el.h = Math.round(s.h * g.panelH);
    if (s.t === 'qr') el.h = el.w;
    if (s.t === 'text') {
      if (s.size) el.size = Math.max(4, Math.round(s.size * g.panelW));
      if (s.align) el.align = s.align;
      if (s.font != null) el.font = s.font;
      if (s.lh) el.lh = s.lh;
      el.italic = !!s.italic;
      el.bg = s.bg || '';
    }
    placed.push(el);
  });
  p.els.forEach(e => { if (!used[e.id]) placed.push(e); });
  p.els = placed;
  selId = null;
  paintAll(); save();
  toast('Applied "' + tpl.n + '" to ' + LABELS[state.active], 2000);
}

/* ----------------------------------------------------------------- drawing */

/* QR codes are cheap to build but get rebuilt on every repaint of every
   thumbnail, so remember the last few. */
const qrCache = new Map();
function qrFor(text, ecl) {
  const key = ecl + '\u0000' + text;
  if (qrCache.has(key)) return qrCache.get(key);
  let made;
  try {
    const q = QR.make(text, ecl);
    made = { ok: true, size: q.size, path: QR.path(q), version: q.version };
  } catch (err) {
    made = { ok: false, error: err.message };
  }
  if (qrCache.size > 40) qrCache.clear();
  qrCache.set(key, made);
  return made;
}

const SVGNS = 'http://www.w3.org/2000/svg';

function paintQr(node, el) {
  const q = qrFor(el.text || '', el.ecl || 'M');
  const key = (el.text || '') + '|' + (el.ecl || 'M') + '|' + el.dark + '|' +
              el.light + '|' + el.quiet;
  if (node._qrKey === key) return;
  node._qrKey = key;

  const old = node.querySelector('.body');
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'body');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('preserveAspectRatio', 'none');

  if (!q.ok) {                       // too much data: show something obvious
    svg.setAttribute('viewBox', '0 0 10 10');
    const bg = document.createElementNS(SVGNS, 'rect');
    bg.setAttribute('width', '10'); bg.setAttribute('height', '10');
    bg.setAttribute('fill', el.light || '#ffffff');
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', '5'); t.setAttribute('y', '6.4');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', '5');
    t.setAttribute('fill', el.dark || '#111111');
    t.textContent = '!';
    svg.appendChild(bg); svg.appendChild(t);
  } else {
    const quiet = el.quiet == null ? 4 : el.quiet;
    const total = q.size + quiet * 2;
    svg.setAttribute('viewBox', '0 0 ' + total + ' ' + total);
    const bg = document.createElementNS(SVGNS, 'rect');
    bg.setAttribute('width', total); bg.setAttribute('height', total);
    bg.setAttribute('fill', el.light || '#ffffff');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('transform', 'translate(' + quiet + ' ' + quiet + ')');
    p.setAttribute('d', q.path);
    p.setAttribute('fill', el.dark || '#111111');
    svg.appendChild(bg); svg.appendChild(p);
  }
  node.replaceChild(svg, old);
}

function styleNode(node, el) {
  const s = node.style;
  s.left = el.x + 'px';
  s.top = el.y + 'px';
  s.width = el.w + 'px';
  s.height = el.type === 'text' ? 'auto' : el.h + 'px';
  s.transform = el.rot ? 'rotate(' + el.rot + 'deg)' : '';
  s.opacity = el.opacity == null ? 1 : el.opacity;

  const body = node.querySelector('.body');
  if (el.type === 'text') {
    const f = FONTS[el.font] || FONTS[0];
    body.style.font = (el.italic ? 'italic ' : '') + (el.bold ? '700 ' : '400 ') +
                      el.size + 'px/' + el.lh + ' ' + f.c;
    body.style.color = el.color;
    body.style.textAlign = el.align;
    body.style.letterSpacing = el.ls + 'px';
    body.style.background = el.bg || 'transparent';
    body.style.padding = (el.bg ? el.pad : 0) + 'px';
  } else if (el.type === 'qr') {
    el.h = el.w;                       // a QR code is always square
    s.height = el.w + 'px';
    paintQr(node, el);
  } else {
    if (body.getAttribute('src') !== el.src) body.setAttribute('src', el.src);
    body.className = 'body' + (el.filter && el.filter !== 'none' ? ' f-' + el.filter : '');
    body.style.objectFit = el.fit || 'cover';
    body.style.borderRadius = (el.radius || 0) + 'px';
  }
}

function makeNode(el, interactive) {
  const d = document.createElement('div');
  d.className = 'el el-' + el.type;
  d.dataset.id = el.id;
  if (el.type === 'text') {
    const b = document.createElement('div');
    b.className = 'body';
    b.textContent = el.text;
    d.appendChild(b);
  } else if (el.type === 'qr') {
    const ph = document.createElementNS(SVGNS, 'svg');       // replaced by paintQr
    ph.setAttribute('class', 'body');
    d.appendChild(ph);
  } else {
    const img = document.createElement('img');
    img.className = 'body';
    img.setAttribute('alt', '');
    d.appendChild(img);
  }
  if (interactive) {
    const ui = document.createElement('div');
    ui.className = 'ui';
    ui.innerHTML = '<div class="stem"></div><div class="h rot"></div>' +
                   '<div class="h e"></div>' +
                   (el.type === 'text' ? '' : '<div class="h se"></div>');
    d.appendChild(ui);
  }
  styleNode(d, el);
  return d;
}

/* The part of a panel the printer cannot reach, drawn over the artwork so you
   can see exactly what a photo loses when you push it past the line. */
function chopBands(pi) {
  const e = unsafeEdges(pi);
  if (!e) return null;
  const wrap = document.createElement('div');
  wrap.className = 'chop';
  ['t', 'b', 'l', 'r'].forEach(side => {
    if (!e[side]) return;
    const b = document.createElement('div');
    b.className = 'band band-' + side;
    b.style[(side === 't' || side === 'b') ? 'height' : 'width'] = (e[side] * PT) + 'px';
    wrap.appendChild(b);
  });
  return wrap.firstChild ? wrap : null;
}

function paintPage() {
  const sheet = $('#sheet'), g = geom(), list = visiblePanels();
  sheet.style.width = g.panelW * list.length + 'px';
  sheet.style.height = g.panelH + 'px';

  if (editingId) {                       // never rebuild under a live caret
    list.forEach(pi => doc().panels[pi].els.forEach(el => {
      const n = nodes.get(el.id);
      if (n) styleNode(n, el);
    }));
  } else {
    nodes.clear();
    sheet.textContent = '';
    list.forEach(pi => {
      const p = doc().panels[pi];
      const pd = document.createElement('div');
      pd.className = 'panel';
      pd.dataset.pi = pi;
      pd.style.width = g.panelW + 'px';
      pd.style.height = g.panelH + 'px';
      pd.style.background = p.bg;
      p.els.forEach(el => {
        const n = makeNode(el, true);
        nodes.set(el.id, n);
        pd.appendChild(n);
      });
      const chop = chopBands(pi);
      if (chop) pd.appendChild(chop);       // last, so it lies over the artwork
      sheet.appendChild(pd);
    });
  }
  nodes.forEach((n, id) => n.classList.toggle('sel', id === selId));
  $('#spine').classList.toggle('on', list.length === 2);
  paintLabels(list);
  fitZoom();
}

/* Page names above the sheet; the highlighted one receives new elements. */
function paintLabels(list) {
  const row = $('#sheetLabels');
  row.textContent = '';
  list.forEach(pi => {
    const s = document.createElement('span');
    const pill = document.createElement('i');
    pill.textContent = LABELS[pi];
    s.appendChild(pill);
    s.title = 'Panel ' + (pi + 1);
    if (pi === state.active) s.className = 'on';
    s.addEventListener('click', () => setActive(pi));
    row.appendChild(s);
  });
}

function setActive(pi) {
  if (pi === state.active) return;
  stopEdit();
  state.active = pi;
  if (!findSel()) selId = null;
  paintAll(); save();
}

/* The thumbnails, the page labels and the stage padding all change height
   with the viewport, so measure them rather than assuming a desktop window.
   Falls back to the desktop figures for the first paint, before the strip
   exists; paintStrip() calls this again once it does. */
function fitZoom() {
  const g = geom(), stage = $('#stage'), sheet = $('#sheet');
  const cols = visiblePanels().length;
  const cs = getComputedStyle(stage);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const stripH = $('#strip').offsetHeight || 96;
  const labelH = $('#sheetLabels').offsetHeight || 22;
  const availW = stage.clientWidth - padX - 4;
  const availH = stage.clientHeight - padY - stripH - labelH - 10;
  const z = Math.max(0.15, Math.min(availW / (g.panelW * cols), availH / g.panelH, 2.6));
  curZoom = z;
  sheet.style.transform = 'scale(' + z + ')';
  sheet.style.setProperty('--iz', 1 / z);
  const box = $('#sheetBox');
  box.style.width = g.panelW * cols * z + 'px';
  box.style.height = g.panelH * z + 'px';
}

function paintStrip() {
  const strip = $('#strip'), g = geom();
  const tz = (narrow() ? 46 : 58) / g.panelH;   // all eight have to fit a phone
  const shown = visiblePanels();
  strip.textContent = '';
  doc().panels.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'thumb' + (i === state.active ? ' on'
                           : shown.indexOf(i) >= 0 ? ' facing' : '');
    b.title = 'Panel ' + (i + 1) + ' (' + LABELS[i] + ')';
    const tp = document.createElement('div');
    tp.className = 'tp';
    tp.style.width = g.panelW * tz + 'px';
    tp.style.height = g.panelH * tz + 'px';
    const mini = document.createElement('div');
    mini.className = 'panel';
    mini.style.cssText = 'width:' + g.panelW + 'px;height:' + g.panelH + 'px;' +
                         'background:' + p.bg + ';transform:scale(' + tz + ')';
    p.els.forEach(el => mini.appendChild(makeNode(el, false)));
    tp.appendChild(mini);
    const lbl = document.createElement('span');
    lbl.className = 'tl';
    lbl.textContent = LABELS[i];
    b.appendChild(tp); b.appendChild(lbl);
    b.addEventListener('click', () => setActive(i));
    strip.appendChild(b);
  });
  fitZoom();                 // the strip's height is part of the sheet's budget
}

/* Thumbnails redraw every panel, so coalesce bursts (typing, dragging). */
let stripPending = false;
function paintStripSoon() {
  if (stripPending) return;
  stripPending = true;
  requestAnimationFrame(() => { stripPending = false; paintStrip(); });
}

function paintAll() { paintPage(); paintStrip(); buildInspector(); }

/* ------------------------------------------------------------- interaction */

function select(id) {
  if (selId === id) return;
  if (editingId && editingId !== id) stopEdit();
  selId = id;
  nodes.forEach((n, k) => n.classList.toggle('sel', k === id));
  buildInspector();
}

function elById(id) {
  for (const pi of visiblePanels()) {
    const el = doc().panels[pi].els.find(e => e.id === id);
    if (el) return el;
  }
  return null;
}

function startEdit(id, selectAll) {
  const el = elById(id);
  const node = nodes.get(id);
  if (!el || el.type !== 'text' || !node) return;
  editingId = id;
  node.classList.add('editing');
  const body = node.querySelector('.body');
  body.setAttribute('contenteditable', 'plaintext-only');
  if (body.contentEditable !== 'plaintext-only') body.setAttribute('contenteditable', 'true');
  body.focus();
  const range = document.createRange();
  range.selectNodeContents(body);
  if (!selectAll) range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  body.oninput = () => {
    el.text = body.innerText.replace(/\u00a0/g, ' ');
    paintStripSoon(); save();
  };
}

function stopEdit() {
  if (!editingId) return;
  const node = nodes.get(editingId);
  if (node) {
    const body = node.querySelector('.body');
    body.removeAttribute('contenteditable');
    body.oninput = null;
    body.blur();
    node.classList.remove('editing');
  }
  editingId = null;
  paintAll();
}

/* Coordinates are panel-local, so measure against the element's own panel. */
function pageXY(ev, node) {
  const box = (node && node.parentNode) || $('#sheet');
  const r = box.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / curZoom, y: (ev.clientY - r.top) / curZoom };
}

/* Keep angles in [-180, 180) so the inspector's slider can reach both ways. */
const wrapDeg = d => Math.round(((d % 360) + 540) % 360 - 180);

/* Elements may bleed off the edge — that is half the point of a zine — but
   never so far that there is nothing left on the panel to grab. */
const KEEP = 20;
function clampPos(el, node) {
  const g = geom();
  const h = el.type === 'text' ? (node ? node.offsetHeight : 0) : el.h;
  el.x = Math.min(g.panelW - KEEP, Math.max(KEEP - el.w, el.x));
  el.y = Math.min(g.panelH - KEEP, Math.max(KEEP - h, el.y));
}

function rotVec(dx, dy, deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

/* Resizing rotates around the box centre, so growing a rotated element would
   drift its visible top-left. Shift the origin back by the same amount. */
function anchorFix(el, dw, dh) {
  if (!el.rot) return;
  const r = el.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const dx = dw / 2, dy = dh / 2;
  el.x += -dx + dx * c - dy * s;
  el.y += -dy + dx * s + dy * c;
}

/* History is only recorded once the pointer actually moves, so a plain click
   to select something does not fill the undo stack with identical states. */
let dragging = false;
function drag(ev, onMove) {
  const snap = JSON.stringify(state.docs);
  let moved = false;
  dragging = true;
  const move = e => {
    if (e.pointerId !== ev.pointerId) return;   // a second finger is not this drag
    e.preventDefault();
    if (!moved) {
      moved = true;
      lastTap.id = null;            // a gesture that moved is not half a tap
      hist.push(snap);
      if (hist.length > 10) hist.shift();
      future.length = 0;
      syncUndo();
    }
    onMove(e);
  };
  /* pointercancel as well as pointerup: a touch the browser takes back — a
     second finger, a system gesture — never sends an up, and the listeners
     would outlive the gesture. */
  const up = e => {
    if (e && e.pointerId !== ev.pointerId) return;
    dragging = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (moved) { paintStripSoon(); syncInspector(); save(); }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/* A touch drag has to be cancelled for the element to move at all, and that
   cancels the synthesised dblclick with it, so touch gets its own double-tap
   detector. Mouse users keep the real dblclick handler. */
let lastTap = { id: null, t: 0 };
function doubleTapped(id, ev) {
  if (ev.pointerType !== 'touch' && ev.pointerType !== 'pen') return false;
  const now = Date.now();
  const again = lastTap.id === id && now - lastTap.t < 400;
  lastTap = { id: again ? null : id, t: now };
  return again;
}

function onPagePointerDown(ev) {
  if (ev.button !== 0 || dragging) return;
  const handle = ev.target.closest('.h');
  const hit = ev.target.closest('.el');
  const pd = ev.target.closest('.panel');
  // Clicking anywhere in a panel makes it the one that receives new elements.
  const pi = pd ? +pd.dataset.pi : state.active;
  if (!hit) { setActive(pi); stopEdit(); select(null); return; }
  const id = hit.dataset.id;
  if (editingId === id && !handle) return;       // let the caret do its job
  ev.preventDefault();
  setActive(pi);                                 // both may rebuild every node
  select(id);
  const el = selected();
  const node = nodes.get(id);
  if (!el || !node) return;

  if (!handle && el.type === 'text' && doubleTapped(id, ev)) {
    startEdit(id, false);
    return;
  }

  if (handle && handle.classList.contains('rot')) {
    const r = node.parentNode.getBoundingClientRect();
    const h = el.type === 'text' ? node.offsetHeight : el.h;
    const cx = r.left + (el.x + el.w / 2) * curZoom;
    const cy = r.top + (el.y + h / 2) * curZoom;
    drag(ev, e => {
      let a = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI + 90;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      el.rot = wrapDeg(a);
      styleNode(node, el);
    });
    return;
  }

  if (handle) {
    const east = handle.classList.contains('e');
    const start = pageXY(ev, node), w0 = el.w, h0 = el.h;
    drag(ev, e => {
      const p = pageXY(e, node);
      const d = rotVec(p.x - start.x, p.y - start.y, el.rot || 0);
      const w = Math.max(16, Math.round(w0 + d.x));
      let h = el.h, dh = 0;
      if (el.type === 'qr') {
        dh = w - el.w;                 // stays square; height follows width
      } else if (!east && el.type === 'image') {
        h = e.shiftKey ? Math.max(16, Math.round(h0 + d.y))
                       : Math.max(16, Math.round(w * h0 / w0));
        dh = h - el.h;
      }
      anchorFix(el, w - el.w, dh);
      el.w = w;
      if (el.type === 'image') el.h = h;
      styleNode(node, el);
    });
    return;
  }

  const start = pageXY(ev, node), x0 = el.x, y0 = el.y;
  drag(ev, e => {
    const p = pageXY(e, node);
    let dx = p.x - start.x, dy = p.y - start.y;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    el.x = Math.round(x0 + dx);
    el.y = Math.round(y0 + dy);
    clampPos(el, node);
    node.style.left = el.x + 'px';
    node.style.top = el.y + 'px';
  });
}

function onKey(e) {
  if (e.target.matches('input, textarea, select')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault(); e.shiftKey ? redo() : undo(); return;
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (editingId) {
    if (e.key === 'Escape') { e.preventDefault(); stopEdit(); }
    return;
  }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSel(); return; }
  if (e.key === 'Escape' && helpOpen) { setHelp(false); return; }
  if (e.key === 'Escape' && sideOpen) { setSide(false); return; }
  if (e.key === 'Escape' && elemDrawerOpen) { setElemDrawer(false); return; }
  if (e.key === 'Escape') { select(null); return; }
  const el = selected();
  if (!el) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSel(); return; }
  if (e.key === 'Enter' && el.type === 'text') { e.preventDefault(); startEdit(el.id, true); return; }
  const step = e.shiftKey ? 10 : 1;
  const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (nudge) {
    e.preventDefault();
    pushHistory();
    el.x += nudge[0]; el.y += nudge[1];
    clampPos(el, nodes.get(el.id));
    styleNode(nodes.get(el.id), el);
    paintStripSoon(); syncInspector(); save();
  }
}

/* ---------------------------------------------------------------- inspector */

function opts(list, cur, val, name) {
  return list.map((o, i) => {
    const v = val ? o[val] : i;
    return '<option value="' + v + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' +
           (name ? o[name] : o) + '</option>';
  }).join('');
}

function foldDiagram() {
  const cw = 60, ch = 42, x0 = 4, y0 = 12;
  const g = geom(), mmv = clampMargin(state.margin);
  const bx = mmv / (g.sheetW / PT) * cw * 4, by = mmv / (g.sheetH / PT) * ch * 2;
  const trimOn = state.trimMargin && mmv > 0;

  /* Leaving the border: panels stay full size and a dashed boundary shows the
     safe area eating into the outer ones. Trimming before folding: the panels
     are already inset by that same amount, so draw them smaller and shifted
     in, with the untrimmed sheet as an outer reference rectangle. */
  const gx = trimOn ? bx : 0, gy = trimOn ? by : 0;
  const cw2 = trimOn ? (cw * 4 - bx * 2) / 4 : cw;
  const ch2 = trimOn ? (ch * 2 - by * 2) / 2 : ch;

  let cells = '';
  IMPOSE.forEach((c, i) => {
    const x = x0 + gx + c.col * cw2, y = y0 + gy + c.row * ch2;
    const tx = x + cw2 / 2, ty = y + ch2 / 2 + 3;
    cells += '<rect x="' + x + '" y="' + y + '" width="' + cw2 + '" height="' + ch2 + '"/>' +
      '<text x="' + tx + '" y="' + ty + '" text-anchor="middle"' +
      (c.rot ? ' transform="rotate(180 ' + tx + ' ' + (ty - 3) + ')"' : '') + '>' +
      (i + 1) + '</text>';
  });

  const outline = trimOn
    ? '<rect x="' + x0 + '" y="' + y0 + '" width="' + (cw * 4) + '" height="' + (ch * 2) + '"/>'
    : '';
  const band = (!trimOn && mmv > 0)
    ? '<rect class="band" x="' + (x0 + bx) + '" y="' + (y0 + by) + '" width="' +
      (cw * 4 - bx * 2) + '" height="' + (ch * 2 - by * 2) + '"/>'
    : '';
  const cutY = y0 + gy + ch2;
  return '<svg class="fold" viewBox="0 0 ' + (cw * 4 + 8) + ' ' + (ch * 2 + 26) + '">' +
    '<text x="4" y="8">print one side, landscape</text>' + outline + cells + band +
    '<line class="cut" x1="' + (x0 + gx + cw2) + '" y1="' + cutY + '" x2="' + (x0 + gx + cw2 * 3) + '" y2="' + cutY + '"/>' +
    '<text x="4" y="' + (y0 + ch * 2 + 12) + '">red line = cut the slit' +
    (mmv > 0
      ? (trimOn ? ', outer box = trim before folding' : ', dashed = printable area')
      : '') +
    '</text></svg>';
}

/* On a phone the settings button means the whole project, full stop, so the
   sheet it opens never switches to a selected element's own controls — see
   syncElemDrawer() for where those go instead. On a wide screen there is no
   such button and no elem-drawer; the one sidebar column still shows
   whichever is relevant, as it always has. */
function buildInspector() {
  const side = $('#inspector'), el = selected();
  side.innerHTML = (!narrow() && el) ? inspectorForEl(el) : inspectorForPage();
  wireInspector(side);
  syncElemDrawer();
  paintHelp();
}

function inspectorForEl(el) {
  const common =
    '<div class="grp"><div class="row">' +
      '<div class="col"><label class="f">Rotate</label>' +
        '<input type="range" data-k="rot" data-num min="-180" max="180" step="1" value="' + el.rot + '"></div>' +
      '<div><label class="f">&deg;</label><input class="num" type="number" data-k="rot" data-num value="' + el.rot + '"></div>' +
    '</div><div class="row">' +
      '<div class="col"><label class="f">X</label><input class="num grow" type="number" data-k="x" data-num value="' + el.x + '"></div>' +
      '<div class="col"><label class="f">Y</label><input class="num grow" type="number" data-k="y" data-num value="' + el.y + '"></div>' +
      '<div class="col"><label class="f">W</label><input class="num grow" type="number" data-k="w" data-num value="' + el.w + '"></div>' +
    '</div></div>' +
    '<div class="grp"><label class="f">Arrange</label><div class="seg" style="margin-bottom:8px">' +
      '<button data-layer="back">Back</button><button data-layer="-1">&minus;</button>' +
      '<button data-layer="1">+</button><button data-layer="front">Front</button></div>' +
    '<div class="row"><button class="grow" data-act="dup">Duplicate</button>' +
      '<button class="grow" data-act="del">Delete</button></div></div>';

  if (el.type === 'text') {
    return '<h2>Text</h2>' +
      '<div class="grp"><div class="row">' +
        '<select class="grow" data-k="font" data-num>' + opts(FONTS, el.font, null, 'n') + '</select>' +
      '</div><div class="row">' +
        '<div class="col"><label class="f">Size</label><input class="num grow" type="number" min="4" max="200" data-k="size" data-num value="' + el.size + '"></div>' +
        '<div class="col"><label class="f">Line</label><input class="num grow" type="number" step="0.05" data-k="lh" data-num value="' + el.lh + '"></div>' +
        '<div class="col"><label class="f">Track</label><input class="num grow" type="number" step="0.2" data-k="ls" data-num value="' + el.ls + '"></div>' +
      '</div><div class="row">' +
        '<div class="seg grow"><button data-k="align" data-v="left"' + on(el.align === 'left') + '>L</button>' +
        '<button data-k="align" data-v="center"' + on(el.align === 'center') + '>C</button>' +
        '<button data-k="align" data-v="right"' + on(el.align === 'right') + '>R</button></div>' +
        '<div class="seg"><button data-k="bold" data-toggle' + on(el.bold) + ' style="font-weight:800">B</button>' +
        '<button data-k="italic" data-toggle' + on(el.italic) + ' style="font-style:italic">I</button></div>' +
      '</div><div class="row">' +
        '<label class="f" style="margin:0;flex:1">Ink</label><input type="color" data-k="color" value="' + el.color + '">' +
        '<label class="f" style="margin:0 0 0 10px">Box</label><input type="color" data-k="bg" value="' + (el.bg || '#ffffff') + '">' +
        '<button data-act="nobg" title="No box background">&#10005;</button>' +
      '</div></div>' + common;
  }

  if (el.type === 'qr') {
    const q = qrFor(el.text || '', el.ecl || 'M');
    return '<h2>QR code</h2>' +
      '<div class="grp"><div class="row">' +
        '<div class="col"><label class="f">Links to</label>' +
        '<input class="grow" type="text" data-k="text" value="' + esc(el.text || '') + '"></div>' +
      '</div><div class="row">' +
        '<div class="col"><label class="f">Correction</label><select class="grow" data-k="ecl">' +
          QR.LEVELS.map(L => '<option value="' + L + '"' + (el.ecl === L ? ' selected' : '') +
            '>' + L + (L === 'M' ? ' (normal)' : L === 'H' ? ' (toughest)' : '') + '</option>').join('') +
        '</select></div>' +
        '<div><label class="f">Quiet</label>' +
        '<input class="num" type="number" min="0" max="8" data-k="quiet" data-num value="' +
        (el.quiet == null ? 4 : el.quiet) + '"></div>' +
      '</div><div class="row">' +
        '<label class="f" style="margin:0;flex:1">Ink</label><input type="color" data-k="dark" value="' + (el.dark || '#111111') + '">' +
        '<label class="f" style="margin:0 0 0 10px">Paper</label><input type="color" data-k="light" value="' + (el.light || '#ffffff') + '">' +
      '</div><div class="hint">' +
        (q.ok ? 'version ' + q.version + ', ' + q.size + '×' + q.size +
                ' modules — prints ' + mm(el.w) + ' mm wide'
              : '<b style="color:var(--accent)">Too much data.</b> Shorten the link or lower the correction level.') +
      '</div></div>' + common;
  }

  return '<h2>Image</h2>' +
    '<div class="grp"><div class="row">' +
      '<div class="col"><label class="f">Effect</label><select class="grow" data-k="filter">' + opts(FILTERS, el.filter, 'v', 'n') + '</select></div>' +
    '</div><div class="row">' +
      '<div class="col"><label class="f">Fit</label><div class="seg">' +
        '<button data-k="fit" data-v="cover"' + on(el.fit !== 'contain') + '>Crop</button>' +
        '<button data-k="fit" data-v="contain"' + on(el.fit === 'contain') + '>Whole</button></div></div>' +
    '</div><div class="row">' +
      '<div class="col"><label class="f">Opacity</label><input type="range" min="0.05" max="1" step="0.05" data-k="opacity" data-num value="' + (el.opacity == null ? 1 : el.opacity) + '"></div>' +
      '<div><label class="f">Round</label><input class="num" type="number" min="0" data-k="radius" data-num value="' + (el.radius || 0) + '"></div>' +
    '</div><div class="row">' +
      '<div class="col"><label class="f">H</label><input class="num grow" type="number" data-k="h" data-num value="' + el.h + '"></div>' +
    '</div></div>' + common;
}

const on = b => b ? ' class="on"' : '';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                          .replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Little diagram of a template's slots, drawn from the same numbers that
   position the real elements. */
function templateThumb(tpl) {
  const W = 44, H = 62;
  let r = '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fff"/>';
  tpl.slots.forEach(s => {
    const x = s.x * W, y = s.y * H, w = s.w * W;
    const rot = s.rot ? ' transform="rotate(' + s.rot + ' ' + (x + w / 2) + ' ' + (y + 4) + ')"' : '';
    if (s.t === 'image') {
      r += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + (s.h * H) +
           '" fill="#c9cbd6"' + rot + '/>';
    } else if (s.t === 'qr') {
      r += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + w +
           '" fill="#3c3f52"' + rot + '/>';
    } else {
      const lh = Math.max(1.2, s.size * W * 0.9);
      const lines = s.size > .06 ? 1 : 3;
      for (let i = 0; i < lines; i++) {
        r += '<rect x="' + x + '" y="' + (y + i * lh * 1.7) + '" width="' +
             (i === lines - 1 && lines > 1 ? w * 0.6 : w) + '" height="' + lh +
             '" fill="#6f7488"' + rot + '/>';
      }
    }
  });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '">' + r + '</svg>';
}

function inspectorForPage() {
  const g = geom();
  return '<div class="side-section">This page<small>Panel ' + (state.active + 1) + ' of 8' +
      (isNaN(LABELS[state.active]) ? ' &mdash; ' + LABELS[state.active] : '') + '</small></div>' +

    '<div class="grp"><div class="row"><label class="f" style="margin:0;flex:1">Panel colour</label>' +
      '<input type="color" data-page="bg" value="' + panel().bg + '"></div>' +
      '<div class="hint" style="margin-top:10px">' + mm(g.panelW) + ' &times; ' + mm(g.panelH) + ' mm</div></div>' +

    '<div class="grp"><h2>Layout</h2><div class="tpl-grid">' +
      TEMPLATES.map((t, i) => '<button class="tpl" data-tpl="' + i + '" title="Apply &quot;' +
        esc(t.n) + '&quot;">' + templateThumb(t) + '<span>' + esc(t.n) + '</span></button>').join('') +
    '</div></div>' +

    '<div class="grp"><div class="row">' +
      '<button class="grow" data-act="clearPanel">Clear this panel</button></div></div>' +

    '<div class="side-section">Whole project<small>Same on every page</small></div>' +

    '<div class="grp"><h2>Printer margin</h2>' +
      '<div class="row"><div class="col">' +
        '<input type="range" min="0" max="20" step="0.5" data-margin value="' + state.margin + '"></div>' +
        '<div><input class="num" type="number" min="0" max="25" step="0.5" data-margin value="' +
        state.margin + '"></div><span class="hint">mm</span></div></div>' +
      '<div class="row">' +
        '<label class="f" style="margin:0;flex:1">After printing</label>' +
        '<div class="seg"><button data-trim="0"' + on(!state.trimMargin) + '>Leave border</button>' +
        '<button data-trim="1"' + on(state.trimMargin) + '>Trim it off</button></div></div>' +
      (state.trimMargin && state.margin > 0
        ? '<div class="hint">A cut line prints ' + state.margin + ' mm in from the sheet ' +
          'edge &mdash; cut along it before folding.</div>'
        : '') +
    '</div>' +

    '<div class="grp"><h2>Print guides</h2>' +
      '<div class="row">' +
        '<label class="f" style="margin:0;flex:1">Panel outlines</label>' +
        '<div class="seg"><button data-guides="0"' + on(!state.guides) + '>Off</button>' +
        '<button data-guides="1"' + on(state.guides) + '>On</button></div></div>' +
      '<div class="row">' +
        '<label class="f" style="margin:0;flex:1">Cut line</label>' +
        '<div class="seg"><button data-cut="0"' + on(!state.cut) + '>Off</button>' +
        '<button data-cut="1"' + on(state.cut) + '>On</button></div></div></div>';
}

/* ------------------------------------------------------------------- help */

/* Everything that explains rather than controls lives here, hidden until asked
   for, so the inspector stays a column of controls. Rebuilt on demand because
   the margin and guide notes describe the panel and settings in front of you. */
let helpOpen = false;

function helpHtml() {
  return '<div class="help-head"><h2>Help</h2>' +
      '<button data-act="closeHelp">Close</button></div>' +

    '<h3>Editing</h3>' +
    '<p>Each spread shows the two pages that face each other when the zine is ' +
      'folded: back and cover, then 2 and 3, 4 and 5, 6 and 7. Click a page, its ' +
      'label above the sheet, or a thumbnail to make it the page that receives ' +
      'new items. On a phone, the two-page button in the toolbar switches to one ' +
      'page at a time, larger, and back.</p>' +
    '<p>Double-click text to edit it, or double-tap it on a touch screen. Paste ' +
      'or drop images straight onto the page, or drop a <b>.zine</b> file to ' +
      'open it.</p>' +
    '<p><kbd>Del</kbd> removes &nbsp; <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates &nbsp; ' +
      '<kbd>&larr;&uarr;&darr;&rarr;</kbd> nudge, with <kbd>Shift</kbd> &times;10. ' +
      '<kbd>Shift</kbd> while dragging locks the axis; while rotating it snaps ' +
      'to 15&deg;. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes.</p>' +

    '<h3>Layouts</h3>' +
    '<p>A layout pours what is already on the page into its slots &mdash; photos ' +
      'and text in the order you added them. Anything left over stays where it ' +
      'was, and an empty photo slot is left empty.</p>' +

    '<h3>QR codes</h3>' +
    '<p>Keep a QR code at least 20 mm wide with a pale background behind it, and ' +
      'scan the printout once before running off copies.</p>' +

    '<h3>Printer margin</h3>' +
    '<p>' + marginNote() + '</p>' +

    '<h3>Folding</h3>' + foldDiagram() +
    (state.trimMargin && state.margin > 0
      ? '<p>Print the exported PDF on one side of a single sheet. Before folding ' +
        'anything, trim ' + state.margin + ' mm off all four edges with a paper cutter, ' +
        'following the line printed near the edge &mdash; that strip was always blank, ' +
        'the printer cannot reach it, so cutting it away first just removes the border.</p>' +
        '<p>Then fold the trimmed sheet in half the long way, then in half twice more. ' +
        'Unfold to the long half-fold, cut the slit, then push the ends together and ' +
        'fold into a booklet. The panel grid was inset by the same amount, so the folds ' +
        'still land exactly on the panel edges, and the finished zine reads edge to edge.</p>'
      : '<p>Print the exported PDF on one side of a single sheet. Fold in half the ' +
        'long way, then in half twice more. Unfold to the long half-fold, cut the ' +
        'slit, then push the ends together and fold into a booklet.</p>' +
        '<p>No trimming is needed: every fold lands on the middle of the paper, which ' +
        'is exactly where the panel edges are.</p>') +

    '<h3>Print guides</h3>' +
    '<p>' +
      (state.guides ? 'Dotted lines mark every panel edge. ' : '') +
      (state.cut ? 'A solid line marks the slit. ' : '') +
      (state.trimMargin && state.margin > 0 ? 'A solid line near the sheet edge marks the trim. ' : '') +
      (state.guides || state.cut || (state.trimMargin && state.margin > 0)
        ? 'These fall on creases or cuts you are making anyway &mdash; the outlines are ' +
          'the folds, the middle line is the slit, and the outer one is the trim &mdash; ' +
          'so a tidy fold and cut hides them.'
        : 'All are off, so nothing is printed over the artwork; use the diagram above.') +
    '</p>' +

    '<h3>Files</h3>' +
    '<p><b>Save</b> writes an editable, compressed <b>.zine</b> file holding ' +
      'everything, images included. <b>Export PDF</b> renders the sheet at 300 dpi ' +
      'for printing; <b>PNG</b> is the same render as an image. Your work is also ' +
      'kept in this browser between visits.</p>';
}

function paintHelp() {
  if (!helpOpen) return;
  const box = $('#help');
  box.innerHTML = helpHtml();
  box.querySelectorAll('[data-act="closeHelp"]').forEach(b =>
    b.addEventListener('click', () => setHelp(false)));
}

function setHelp(open) {
  helpOpen = !!open;
  $('#help').hidden = !helpOpen;
  $('#inspector').hidden = helpOpen;
  const btn = $('#helpBtn');
  btn.classList.toggle('on', helpOpen);
  btn.setAttribute('aria-pressed', helpOpen ? 'true' : 'false');
  paintHelp();
  if (helpOpen && narrow()) setSide(true);     // nowhere else for it to appear
  syncDocSettings();          // help takes the same spot in the sheet
}

const narrow = () => window.matchMedia('(max-width: 860px)').matches;

/* --------------------------------------------------------- one page or two

   A spread is two facing panels, which is the whole point on a wide screen
   — there is room, and folding is easier to picture with both in view. On a
   phone the two together can be too small to work in, so state.singleView
   lets it show just the active one instead; visiblePanels() is the only
   other place that reads it. Persisted like margin/cut/guides, but a wide
   screen ignores it outright, so it never affects anything there. */
function setSingleView(v) {
  state.singleView = !!v;
  if (!findSel()) selId = null;    // the other half's selection may have left view
  paintAll(); save(); syncViewToggle();
}

function syncViewToggle() {
  const btn = $('#viewToggle');
  if (!btn) return;
  btn.classList.toggle('on', state.singleView);
  btn.setAttribute('aria-pressed', state.singleView ? 'true' : 'false');
  btn.title = state.singleView ? 'Show both pages of the spread' : 'Show one page at a time';
}

/* -------------------------------------------------------- the side as a sheet

   A phone has no room for a column beside the stage, so under the narrow
   media query the sidebar sits off the bottom of the screen until asked for.
   On a wide screen it is always in view and this toggle changes nothing. */
let sideOpen = false;

function setSide(open) {
  sideOpen = !!open;
  document.body.classList.toggle('side-open', sideOpen);
  $('#panelBtn').setAttribute('aria-expanded', sideOpen ? 'true' : 'false');
  $('#panelBtn').classList.toggle('on', sideOpen);
}

/* ---------------------------------------------------- the element's drawer

   A second sheet, independent of #side: the settings button is the whole
   project's, never a selected element's, so a selection gets its own bar
   instead of borrowing that one. It appears — closed, as a peeking bar —
   the instant something becomes selected, and disappears the instant
   nothing is. Opening it is a separate choice, left up to whoever wants it. */
let elemDrawerOpen = false;

function setElemDrawer(open) {
  elemDrawerOpen = !!open;
  $('#elemDrawer').classList.toggle('open', elemDrawerOpen);
  $('#elemPeek').setAttribute('aria-expanded', elemDrawerOpen ? 'true' : 'false');
}

const elemLabel = el => el.type === 'text' ? 'Text' : el.type === 'qr' ? 'QR code' : 'Image';

function syncElemDrawer() {
  const el = selected(), drawer = $('#elemDrawer');
  const show = narrow() && !!el;
  const wasShown = !drawer.hidden;
  drawer.hidden = !show;
  if (!show) {
    if (wasShown) setElemDrawer(false);     // closed again, ready for next time
    return;
  }
  if (!wasShown) setElemDrawer(false);      // just appeared: start closed, not sprung open
  $('#elemPeekLabel').textContent = elemLabel(el);
  $('#elemInspector').innerHTML = inspectorForEl(el);
  wireInspector($('#elemInspector'));
}

/* The title, paper size and file buttons live in the toolbar on a wide
   screen, where there is room for them; a phone has none, so they park in
   a "Document" group at the top of the settings sheet instead. Moving the
   real elements (rather than cloning them and syncing two copies) keeps
   their listeners and values automatically correct wherever they are. A
   comment node dropped in front of each one on first use marks where it
   came from, so putting it back is just `marker.after(el)`. */
const MOBILE_SETTINGS = [
  { id: 'title', slot: 'slotTitle' },
  { id: 'paper', slot: 'slotPaper' },
  { id: 'newZine', slot: 'slotNew' },
  { id: 'openZine', slot: 'slotOpen' },
  { id: 'saveZine', slot: 'slotSave' }
];
let mobileAnchors = null, mobileControlsIn = false;

function captureMobileAnchors() {
  mobileAnchors = MOBILE_SETTINGS.map(m => {
    const el = $('#' + m.id);
    const marker = document.createComment(m.id);
    el.parentNode.insertBefore(marker, el);
    return { el: el, marker: marker, slot: m.slot };
  });
}

function layoutMobileControls() {
  if (!mobileAnchors) captureMobileAnchors();
  const wantIn = narrow();
  if (wantIn === mobileControlsIn) return;      // already where it should be
  mobileControlsIn = wantIn;
  mobileAnchors.forEach(a => {
    if (wantIn) $('#' + a.slot).appendChild(a.el);
    else a.marker.after(a.el);
  });
}

/* Help takes over the same sheet, so the document group hides while help is
   open rather than fighting it for space. */
function syncDocSettings() {
  layoutMobileControls();
  $('#docSettings').hidden = !(narrow() && !helpOpen);
}

/* On a wide screen the toolbar always has room; on a phone it might not,
   and no fixed breakpoint covers every handset. So rather than letting the
   row wrap — which costs a whole second line of stage — shrink the buttons
   by just enough to fit one, via the --bar-scale custom property the CSS
   reads back (see the narrow media query). Only ever shrinks; a screen with
   room to spare gets scale 1, same size as always.

   flex-wrap normally absorbs the overflow before it could be measured, so
   .measuring forces one line first. scrollWidth is no good for that
   measurement even then: it is defined as never less than clientWidth, so
   once a trial scale shrinks the row past a comfortable fit it reads back
   exactly clientWidth regardless of how much smaller the row actually is,
   and the loop can never tell it has already succeeded. Measuring to the
   last button's own right edge has no such floor. A single division isn't
   exact either way — fixed borders and glyph widths do not shrink perfectly
   in step with padding — so this runs a few times, each pass correcting for
   whatever the last one over- or undershot. It aims a couple of pixels
   under the real budget: a fit measured exactly to the pixel in the forced
   single-line layout can still round the wrong way once flex-wrap gets to
   decide for real, and that costs a whole line. */
function fitBar() {
  const bar = $('.bar'), SLACK = 2;
  if (!narrow()) { bar.style.removeProperty('--bar-scale'); return; }
  const padRight = parseFloat(getComputedStyle(bar).paddingRight) || 0;
  let scale = 1;
  for (let i = 0; i < 14; i++) {
    bar.style.setProperty('--bar-scale', scale.toFixed(3));
    bar.classList.add('measuring');
    const kids = [...bar.children].filter(c => getComputedStyle(c).display !== 'none');
    const last = kids[kids.length - 1];
    const barRect = bar.getBoundingClientRect();
    const need = last ? last.getBoundingClientRect().right - barRect.left + padRight : 0;
    const have = barRect.width - SLACK;
    bar.classList.remove('measuring');
    if (need <= have || scale <= 0.55) break;
    scale = Math.max(0.55, scale * (have / need));
  }
}

const mm = pt => (pt / PT).toFixed(1);

function marginNote() {
  const g = geom();
  if (state.trimMargin) {
    if (state.margin <= 0) {
      return 'No margin, so there is nothing to trim. The design runs right to the ' +
             'paper edge &mdash; fine for a borderless printer, otherwise your printer ' +
             'will crop it for you.';
    }
    return 'With &ldquo;Trim it off&rdquo; on, the panel grid is inset ' + state.margin +
      ' mm from every edge of the <b>sheet</b>, so no panel ever reaches into the strip ' +
      'most printers cannot reach &mdash; nothing here is clipped. Panels are ' +
      mm(g.panelW) + ' × ' + mm(g.panelH) + ' mm, a touch smaller than a full quarter of ' +
      'the sheet, to leave room for the cut.<br><br>Cut that ' + state.margin + ' mm strip ' +
      'off all four edges of the printed sheet &mdash; the line near the edge shows where ' +
      '&mdash; <b>before</b> you fold. The folds then land exactly on the panel edges, same ' +
      'as always, and the finished zine reads edge to edge.' +
      '<br><br>Print at 100% / actual size, not &ldquo;fit to page&rdquo;.';
  }
  const e = unsafeEdges(state.active);
  if (!e) {
    return 'No margin. The design runs right to the paper edge &mdash; fine for a ' +
           'borderless printer, otherwise your printer will crop it for you.';
  }
  const sides = [];
  if (e.t) sides.push('top');
  if (e.b) sides.push('bottom');
  if (e.l) sides.push('left');
  if (e.r) sides.push('right');
  const safeW = g.panelW / PT - e.l - e.r, safeH = g.panelH / PT - e.t - e.b;
  const where = 'This panel (' + LABELS[state.active] + ') sits ' +
    (sides.length > 1 ? 'in a corner' : 'along an edge') + ' of the sheet, so its ';
  return 'The outer ' + state.margin + ' mm of the <b>sheet</b> is the strip most ' +
    'printers cannot reach. Panels keep their full ' + mm(g.panelW) + ' × ' +
    mm(g.panelH) + ' mm so the folds still land on the panel edges &mdash; instead, ' +
    'anything in the striped band is simply lost.<br><br>' +
    (sides.length
      ? where + sides.join(' and ') + ' edge' + (sides.length > 1 ? 's are' : ' is') +
        ' clipped, leaving ' + safeW.toFixed(1) + ' × ' + safeH.toFixed(1) + ' mm to work in.'
      : 'This panel is in the middle of the sheet, so none of it is clipped.') +
    '<br><br>Print at 100% / actual size, not &ldquo;fit to page&rdquo;.' +
    ' Turn on &ldquo;Trim it off&rdquo; below if you plan to cut this border away ' +
    'before folding, for an edge-to-edge result.';
}

/* Shared between #inspector and, on a phone, #elemInspector — each only
   ever holds markup relevant to itself (data-k and friends are exclusive to
   inspectorForEl's output, the rest to inspectorForPage's), so wiring both
   from the same set of selectors is safe. */
function wireInspector(side) {
  side.querySelectorAll('[data-k]').forEach(node => {
    const k = node.dataset.k;
    const num = node.hasAttribute('data-num');
    if (node.tagName === 'BUTTON') {
      node.addEventListener('click', () => {
        const el = selected(); if (!el) return;
        pushHistory();
        el[k] = node.hasAttribute('data-toggle') ? !el[k] : node.dataset.v;
        paintPage(); paintStrip(); buildInspector(); save();
      });
      return;
    }
    const apply = () => {
      const el = selected(); if (!el) return;
      let v = num ? parseFloat(node.value) : node.value;
      if (num && !isFinite(v)) return;
      if (num && (k === 'w' || k === 'h')) v = Math.max(8, v);
      if (k === 'rot') v = wrapDeg(v);
      el[k] = v;
      paintPage(); paintStripSoon(); syncInspector(); save();
    };
    // One undo entry per interaction, not per intermediate value.
    const mark = () => { if (!node._h) { node._h = 1; pushHistory(); } };
    node.addEventListener('pointerdown', mark);
    node.addEventListener('keydown', mark);
    node.addEventListener('input', () => { mark(); apply(); });
    node.addEventListener('change', () => { node._h = 0; apply(); });
    node.addEventListener('blur', () => { node._h = 0; });
  });

  side.querySelectorAll('[data-layer]').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.layer;
    layer(v === 'front' || v === 'back' ? v : parseInt(v, 10));
  }));

  side.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', () => {
    applyTemplate(TEMPLATES[+b.dataset.tpl]);
  }));

  [['data-cut', 'cut'], ['data-guides', 'guides']].forEach(pair => {
    side.querySelectorAll('[' + pair[0] + ']').forEach(b => b.addEventListener('click', () => {
      state[pair[1]] = b.getAttribute(pair[0]) === '1';
      buildInspector(); save();
    }));
  });

  /* Trimming changes geom() itself (panel size and the on-screen chop bands
     both depend on it), so the sheet needs a real repaint, not just the
     inspector text. */
  side.querySelectorAll('[data-trim]').forEach(b => b.addEventListener('click', () => {
    state.trimMargin = b.getAttribute('data-trim') === '1';
    paintAll(); save();
  }));

  /* Print settings sit outside the undo stack, which only snapshots state.docs. */
  side.querySelectorAll('[data-margin]').forEach(node => {
    const apply = () => {
      const v = parseFloat(node.value);
      if (!isFinite(v)) return;
      state.margin = clampMargin(v);
      side.querySelectorAll('[data-margin]').forEach(o => {
        if (o !== node) o.value = state.margin;
      });
      save();
    };
    node.addEventListener('input', () => { apply(); paintPage(); paintHelp(); });
    node.addEventListener('change', () => { apply(); paintAll(); });
  });

  const bg = side.querySelector('[data-page="bg"]');
  if (bg) {
    bg.addEventListener('pointerdown', () => pushHistory());
    bg.addEventListener('input', () => { panel().bg = bg.value; paintPage(); paintStrip(); save(); });
  }

  side.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'dup') duplicateSel();
    else if (a === 'del') removeSel();
    else if (a === 'nobg') { const el = selected(); if (el) { pushHistory(); el.bg = ''; paintAll(); save(); } }
    else if (a === 'clearPanel') {
      if (!confirm('Clear everything on this panel?')) return;
      pushHistory();
      doc().panels[state.active] = blankPanel();
      selId = null; paintAll(); save();
    }
  }));
}

function newZine() {
  if (!confirm('Delete this whole zine and start a new one?')) return;
  pushHistory();
  state.docs = { mini: blankDoc(8) };
  state.title = 'untitled zine';
  state.active = 0; selId = null;
  $('#title').value = state.title;
  paintAll(); save();
}

/* Keep inspector numbers in step with direct manipulation on the page. */
function syncInspector() {
  const el = selected();
  if (!el) return;
  // A phone keeps the element's own fields in #elemInspector, never #inspector.
  const side = narrow() ? $('#elemInspector') : $('#inspector');
  side.querySelectorAll('[data-k]').forEach(node => {
    if (node.tagName === 'BUTTON' || node === document.activeElement) return;
    const v = el[node.dataset.k];
    if (v != null && node.value !== String(v)) node.value = v;
  });
}

/* ------------------------------------------------------------------ export */

/* Print guides are drawn as SVG strokes rather than CSS-styled divs. A
   hairline div carrying a repeating gradient does not survive rasterising
   through <foreignObject> — at some sub-pixel offsets Chrome drops it
   entirely — whereas stroke-dasharray is exact and always paints. */
function guideOverlay(g) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + g.sheetW + ' ' + g.sheetH);
  svg.setAttribute('width', g.sheetW);
  svg.setAttribute('height', g.sheetH);
  svg.setAttribute('style', 'position:absolute;left:0;top:0;overflow:visible');
  return svg;
}

/* A straight guide stroke. With a dash and gap it is dashed, stretched so the
   run starts and ends on a dash; with neither it is solid. */
function guideStroke(svg, x1, y1, x2, y2, dash, gap, colour, width) {
  const line = document.createElementNS(SVGNS, 'line');
  line.setAttribute('x1', x1); line.setAttribute('y1', y1);
  line.setAttribute('x2', x2); line.setAttribute('y2', y2);
  line.setAttribute('stroke', colour);
  line.setAttribute('stroke-width', width || '0.75');
  if (dash) {
    const len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
    const n = Math.max(1, Math.round((len + gap) / (dash + gap)));
    const period = (len + gap) / n;
    line.setAttribute('stroke-dasharray', (period - gap).toFixed(3) + ' ' + gap);
  }
  svg.appendChild(line);
  return line;
}

function buildSheetNode() {
  const g = geom();
  const root = document.createElement('div');
  root.style.cssText = 'position:relative;overflow:hidden;background:#ffffff;width:' +
                       g.sheetW + 'px;height:' + g.sheetH + 'px';

  /* Panels stay exactly a quarter of the sheet wide and half of it tall (or,
     when trimming before folding, a quarter/half of the trimmed area, inset
     by the margin), so every fold lands on a panel edge either way. The
     margin is painted over the finished sheet as bare paper, which is what
     the printer leaves there anyway. */
  const block = document.createElement('div');
  block.style.cssText = 'position:absolute;left:0;top:0;width:' + g.sheetW +
                        'px;height:' + g.sheetH + 'px';
  root.appendChild(block);

  const cells = IMPOSE.map((c, i) => ({ i: i, col: c.col, row: c.row, rot: c.rot }));

  cells.forEach(c => {
    const p = doc().panels[c.i];
    const pn = document.createElement('div');
    pn.className = 'panel';
    pn.style.cssText = 'position:absolute;left:' + (g.offsetX + c.col * g.panelW) + 'px;top:' +
      (g.offsetY + c.row * g.panelH) + 'px;width:' + g.panelW + 'px;height:' + g.panelH +
      'px;background:' + p.bg + ';transform:rotate(' + c.rot + 'deg)';
    p.els.forEach(el => pn.appendChild(makeNode(el, false)));
    block.appendChild(pn);
  });

  /* Print guides, drawn over the artwork so they read whatever is underneath.
     All land on creases: the panel outlines are exactly the fold lines, and
     the scissors go straight through the cut line, so a clean fold and cut
     leaves neither of them showing on the finished zine. offsetX/Y is zero
     unless trimming before folding, so this is the same math either way. */
  const m = clampMargin(state.margin) * PT;

  if (state.guides || state.cut) {
    const svg = guideOverlay(g);
    if (state.guides) {
      for (let c = 1; c < 4; c++) {
        const x = g.offsetX + g.panelW * c;
        guideStroke(svg, x, g.offsetY, x, g.sheetH - g.offsetY, 1.2, 2.4, '#b4b4b4');
      }
      const midY = g.offsetY + g.panelH;
      guideStroke(svg, g.offsetX, midY, g.sheetW - g.offsetX, midY, 1.2, 2.4, '#b4b4b4');
    }
    if (state.cut) {
      const midY = g.offsetY + g.panelH;
      guideStroke(svg, g.offsetX + g.panelW, midY, g.offsetX + g.panelW * 3, midY,
                  0, 0, '#6e6e6e', '1');
    }
    root.appendChild(svg);
  }

  if (m > 0) {
    const rim = document.createElement('div');
    rim.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;' +
      'box-sizing:border-box;border:' + m + 'px solid #ffffff';
    root.appendChild(rim);
  }

  /* Trimming before folding: the panel grid above is already inset by m, so
     this line runs right along its outer edge — cut along it first, then
     fold the smaller sheet exactly as usual. */
  if (state.trimMargin && m > 0) {
    const trim = guideOverlay(g);
    guideStroke(trim, m, m, g.sheetW - m, m, 0, 0, '#6e6e6e', '1');
    guideStroke(trim, m, g.sheetH - m, g.sheetW - m, g.sheetH - m, 0, 0, '#6e6e6e', '1');
    guideStroke(trim, m, m, m, g.sheetH - m, 0, 0, '#6e6e6e', '1');
    guideStroke(trim, g.sheetW - m, m, g.sheetW - m, g.sheetH - m, 0, 0, '#6e6e6e', '1');
    root.appendChild(trim);
  }
  return root;
}

/* Rasterise DOM without a library: serialise it into an SVG <foreignObject>
   and let the browser draw it. Images are data URLs, so the canvas stays clean. */
function rasterize(node, w, h, scale) {
  const style = document.createElement('style');
  style.textContent = document.getElementById('page-css').textContent;
  node.insertBefore(style, node.firstChild);
  const xml = new XMLSerializer().serializeToString(node);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(w * scale) +
    '" height="' + Math.round(h * scale) + '" viewBox="0 0 ' + w + ' ' + h + '">' +
    '<foreignObject x="0" y="0" width="' + w + '" height="' + h + '">' + xml +
    '</foreignObject></svg>';

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = Math.round(w * scale);
      cv.height = Math.round(h * scale);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      resolve(cv);
    };
    img.onerror = () => reject(new Error('The page could not be rendered.'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

const latin1 = s => {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
  return a;
};

/* Minimal PDF: each page is one baseline-JPEG XObject scaled to the MediaBox. */
function buildPDF(pages) {
  const parts = [];
  let pos = 0;
  const off = [];
  const put = x => {
    const b = typeof x === 'string' ? latin1(x) : x;
    parts.push(b); pos += b.length;
  };
  let n = 2;
  const ids = pages.map(() => ({ page: ++n, img: ++n, content: ++n }));

  put('%PDF-1.4\n%âãÏÓ\n');

  const obj = (i, head, stream) => {
    off[i] = pos;
    put(i + ' 0 obj\n' + head + '\n');
    if (stream !== undefined) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Count ' + pages.length + ' /Kids [' +
         ids.map(o => o.page + ' 0 R').join(' ') + '] >>');

  pages.forEach((p, i) => {
    const o = ids[i];
    const w = p.ptW.toFixed(2), h = p.ptH.toFixed(2);
    obj(o.page, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + ']' +
        ' /Resources << /XObject << /Im0 ' + o.img + ' 0 R >> >> /Contents ' + o.content + ' 0 R >>');
    obj(o.img, '<< /Type /XObject /Subtype /Image /Width ' + p.pxW + ' /Height ' + p.pxH +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
        p.jpeg.length + ' >>', p.jpeg);
    const cs = 'q\n' + w + ' 0 0 ' + h + ' 0 0 cm\n/Im0 Do\nQ\n';
    obj(o.content, '<< /Length ' + cs.length + ' >>', cs);
  });

  const xref = pos;
  let t = 'xref\n0 ' + (n + 1) + '\n0000000000 65535 f \n';
  for (let i = 1; i <= n; i++) t += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  put(t);
  put('trailer\n<< /Size ' + (n + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

  return new Blob(parts, { type: 'application/pdf' });
}

const slug = s => (s || 'zine').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '').slice(0, 40) || 'zine';

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------------------------------------------------- the .zine file

   A .zine is one self-contained binary file: everything needed to reopen the
   zine, with no assets alongside it.

     bytes  content
     0..3   magic "ZINE"
     4      container version (2)
     5      flags; bit 0 set means the description is deflated
     6..9   uint32 LE, byte length of the description that follows
     10..13 uint32 LE, number of images after it
     14..   the description: UTF-8 JSON, deflated unless the flag says not
     then   each image in turn: uint32 LE byte length, then those raw bytes

   Images are stored as their original bytes rather than the base64 data URLs
   the editor keeps in memory, which is a quarter smaller on its own; they are
   left uncompressed because JPEG and PNG data will not deflate any further.
   Identical images are stored once and referenced twice.

   The description is:

   { "format": "zine", "formatVersion": 2, "app": "zinemaker",
     "saved": <ISO 8601>, "title": string,
     "paper": "a4"|"letter", "margin": <mm>, "trimMargin": bool,
     "cut": bool, "guides": bool,
     "assets": [ { "type": <mime>, "bytes": <length> }, ... ],
     "docs": { "mini": { "panels": [ 8 ] } } }

   A panel is { "bg": <css colour>, "els": [ ... ] }; every element carries
   "type" ("text" | "image" | "qr"), "x"/"y"/"w" in points from the panel's
   top-left corner, and "rot" in degrees. An image element carries "asset",
   an index into the table, in place of its "src". Unknown keys are ignored on
   load and missing ones fall back to defaults, so files from either side of a
   change still open — including plain-JSON .zine files from version 1. */

const ZINE_FORMAT = 2;
const ZINE_MAGIC = [0x5a, 0x49, 0x4e, 0x45];          // "ZINE"

async function deflateBytes(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function inflateBytes(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function dataUrlBytes(url) {
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const head = url.slice(0, comma);
  if (head.indexOf(';base64') < 0) return null;
  const type = (head.match(/^data:([^;,]+)/) || [, 'application/octet-stream'])[1];
  let bin;
  try { bin = atob(url.slice(comma + 1)); } catch (err) { return null; }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { type: type, bytes: out };
}

function bytesDataUrl(type, bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return 'data:' + (type || 'image/png') + ';base64,' + btoa(bin);
}

const u32 = n => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

async function saveZine() {
  const docs = JSON.parse(JSON.stringify(state.docs));
  const assets = [], seen = new Map();

  Object.keys(docs).forEach(key => docs[key].panels.forEach(p => p.els.forEach(el => {
    if (el.type !== 'image' || typeof el.src !== 'string') return;
    if (seen.has(el.src)) { el.asset = seen.get(el.src); delete el.src; return; }
    const a = dataUrlBytes(el.src);
    if (!a) return;                               // keep anything unrecognised inline
    seen.set(el.src, assets.length);
    el.asset = assets.length;
    assets.push(a);
    delete el.src;
  })));

  const meta = {
    format: 'zine', formatVersion: ZINE_FORMAT, app: 'zinemaker',
    saved: new Date().toISOString(),
    title: state.title, paper: state.paper,
    margin: state.margin, trimMargin: state.trimMargin, cut: state.cut, guides: state.guides,
    assets: assets.map(a => ({ type: a.type, bytes: a.bytes.length })),
    docs: docs
  };

  const raw = new TextEncoder().encode(JSON.stringify(meta));
  let body = raw, flags = 0;
  if (typeof CompressionStream !== 'undefined') {
    try { body = await deflateBytes(raw); flags = 1; } catch (err) { body = raw; flags = 0; }
  }

  const head = new Uint8Array(14);
  head.set(ZINE_MAGIC, 0);
  head[4] = ZINE_FORMAT;
  head[5] = flags;
  head.set(u32(body.length), 6);
  head.set(u32(assets.length), 10);

  const parts = [head, body];
  assets.forEach(a => { parts.push(u32(a.bytes.length)); parts.push(a.bytes); });

  const blob = new Blob(parts, { type: 'application/octet-stream' });
  download(blob, slug(state.title) + '.zine');
  const plain = JSON.stringify(Object.assign({}, meta, { docs: state.docs })).length;
  toast('Saved ' + slug(state.title) + '.zine — ' + kb(blob.size) +
        ' (' + Math.max(0, Math.round((1 - blob.size / plain) * 100)) + '% smaller than JSON)', 3200);
}

const kb = n => n < 1024 ? n + ' B'
  : n < 1024 * 1024 ? (n / 1024).toFixed(0) + ' KB'
  : (n / 1024 / 1024).toFixed(2) + ' MB';

/* Accepts the binary container and, for anything saved by version 1, plain JSON. */
async function readZine(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0x7b) {                                  // '{' — a version 1 file
    return JSON.parse(new TextDecoder().decode(buf));
  }
  if (!ZINE_MAGIC.every((b, i) => buf[i] === b)) throw new Error('not a .zine file');

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = buf[5];
  const metaLen = dv.getUint32(6, true);
  const count = dv.getUint32(10, true);
  const metaRaw = buf.subarray(14, 14 + metaLen);
  const meta = JSON.parse(new TextDecoder().decode(
    (flags & 1) ? await inflateBytes(metaRaw) : metaRaw));

  const blobs = [];
  let at = 14 + metaLen;
  for (let i = 0; i < count; i++) {
    const len = dv.getUint32(at, true);
    at += 4;
    blobs.push(buf.subarray(at, at + len));
    at += len;
  }

  const table = meta.assets || [];
  Object.keys(meta.docs || {}).forEach(key => {
    const d = meta.docs[key];
    if (!d || !Array.isArray(d.panels)) return;
    d.panels.forEach(p => (p.els || []).forEach(el => {
      if (el && el.asset != null && blobs[el.asset]) {
        el.src = bytesDataUrl((table[el.asset] || {}).type, blobs[el.asset]);
        delete el.asset;
      }
    }));
  });
  return meta;
}

async function openZine(file) {
  let data;
  try {
    data = await readZine(file);
  } catch (err) {
    toast('That does not look like a .zine file.', 4000);
    return;
  }
  if (!data || data.format !== 'zine' || !data.docs) {
    toast('That does not look like a .zine file.', 4000);
    return;
  }
  if (data.formatVersion > ZINE_FORMAT) {
    toast('Saved by a newer version — opening as best we can.', 4000);
  }
  if (!confirm('Open "' + (data.title || 'untitled') +
               '"? This replaces what is on screen. (Undo will bring it back.)')) return;

  stopEdit();
  pushHistory();
  state.title = typeof data.title === 'string' ? data.title : 'untitled zine';
  state.paper = PAPER[data.paper] ? data.paper : 'a4';
  state.margin = clampMargin(data.margin == null ? 5 : data.margin);
  state.trimMargin = !!data.trimMargin;
  state.cut = data.cut !== false;
  state.guides = !!data.guides;
  state.docs = { mini: fixDoc(data.docs.mini, 8) };
  state.active = 0;
  selId = null;
  $('#title').value = state.title;
  $('#paper').value = state.paper;
  paintAll(); save();
  toast('Opened ' + file.name, 2500);
}

async function exportSheet(kind) {
  const wasSel = selId;
  stopEdit(); selId = null; paintPage();
  toast('Rendering at ' + DPI + " dpi, this takes a moment...");
  try {
    const g = geom();
    const cv = await rasterize(buildSheetNode(), g.sheetW, g.sheetH, DPI / 72);
    if (kind === 'png') {
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      download(blob, slug(state.title) + '.png');
    } else {
      // High quality: at 300 dpi the artefacts that matter are the ones
      // around black text on white, and they show up in print.
      const jpegBlob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.94));
      const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());
      const pdf = buildPDF([{ jpeg: jpeg, pxW: cv.width, pxH: cv.height, ptW: g.sheetW, ptH: g.sheetH }]);
      download(pdf, slug(state.title) + '.pdf');
    }
    toast('Saved ' + slug(state.title) + '.' + kind, 2200);
  } catch (err) {
    console.error(err);
    toast('Export failed: ' + err.message, 4000);
  }
  selId = wasSel;
  paintAll();
}

/* ------------------------------------------------------------------- toast */

let toastTimer = null;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('#toast').classList.remove('on'); }

/* -------------------------------------------------------------------- boot */

function seed() {
  const g = geom();
  panel().els.push({
    id: uid(), type: 'text',
    x: Math.round(g.panelW * 0.1), y: Math.round(g.panelH * 0.36),
    w: Math.round(g.panelW * 0.8), rot: -3,
    text: 'MY\nZINE', font: 3, size: 46, color: '#111111', align: 'left',
    lh: 0.95, ls: -1, bold: false, italic: false, bg: '', pad: 4
  });
}

function openExportMenu() {
  $('#exportMenu').hidden = false;
  $('#exportMenuBtn').setAttribute('aria-expanded', 'true');
}

function closeExportMenu() {
  $('#exportMenu').hidden = true;
  $('#exportMenuBtn').setAttribute('aria-expanded', 'false');
}

async function init() {
  if (!(await load())) seed();

  $('#title').value = state.title;
  $('#paper').value = state.paper;

  $('#title').addEventListener('input', e => { state.title = e.target.value; save(); });
  $('#addText').addEventListener('click', addText);
  $('#addImage').addEventListener('click', () => $('#file').click());
  $('#addQr').addEventListener('click', addQr);
  $('#file').addEventListener('change', e => { addImageFiles(e.target.files); e.target.value = ''; });
  $('#newZine').addEventListener('click', newZine);
  $('#openZine').addEventListener('click', () => $('#zineFile').click());
  $('#saveZine').addEventListener('click', saveZine);
  $('#helpBtn').addEventListener('click', () => setHelp(!helpOpen));
  $('#panelBtn').addEventListener('click', () => setSide(!sideOpen));
  $('#sideClose').addEventListener('click', () => setSide(false));
  $('#elemPeek').addEventListener('click', () => setElemDrawer(!elemDrawerOpen));
  $('#viewToggle').addEventListener('click', () => setSingleView(!state.singleView));
  $('#zineFile').addEventListener('change', e => {
    if (e.target.files[0]) openZine(e.target.files[0]);
    e.target.value = '';
  });
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#exportPdf').addEventListener('click', () => exportSheet('pdf'));
  $('#exportPng').addEventListener('click', () => { exportSheet('png'); closeExportMenu(); });
  $('#exportMenuBtn').addEventListener('click', e => {
    e.stopPropagation();
    $('#exportMenu').hidden ? openExportMenu() : closeExportMenu();
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.split')) closeExportMenu();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeExportMenu(); });

  $('#paper').addEventListener('change', e => {
    state.paper = e.target.value;
    paintAll(); save();
  });

  const page = $('#sheet');
  page.addEventListener('pointerdown', onPagePointerDown);
  page.addEventListener('dblclick', e => {
    const node = e.target.closest('.el');
    if (node && nodes.has(node.dataset.id)) {
      const el = elById(node.dataset.id);
      if (el && el.type === 'text') { select(el.id); startEdit(el.id, false); }
    }
  });
  document.addEventListener('keydown', onKey);
  // The thumbnails size themselves to the layout, the document controls move
  // between the toolbar and the settings sheet, the toolbar's own buttons
  // may need to shrink or return to size, and which sheet a selection's
  // controls live in depends on the same breakpoint — a resize can change
  // any of that, not just the zoom.
  window.addEventListener('resize', () => {
    fitZoom(); paintStripSoon(); syncDocSettings(); fitBar(); buildInspector();
  });

  const stage = $('#stage');
  let dragDepth = 0;
  stage.addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth) stage.classList.add('dragging'); });
  stage.addEventListener('dragover', e => e.preventDefault());
  stage.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; stage.classList.remove('dragging'); } });
  stage.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; stage.classList.remove('dragging');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    const first = e.dataTransfer.files[0];
    if (/\.zine$/i.test(first.name)) { openZine(first); return; }
    // Drop onto the half of the spread the cursor is actually over.
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const pd = over && over.closest('.panel[data-pi]');
    if (pd) setActive(+pd.dataset.pi);
    addImageFiles(e.dataTransfer.files);
  });
  document.addEventListener('paste', e => {
    if (editingId) return;
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); addImageFiles(files); }
  });

  syncDocSettings();          // move title/paper/open/save in if we start narrow
  fitBar();                   // and shrink the rest of the toolbar if it still needs it
  syncViewToggle();
  syncUndo();
  paintAll();
  save();
}

document.addEventListener('DOMContentLoaded', init);
