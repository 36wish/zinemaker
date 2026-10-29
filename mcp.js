/* Zine Maker's agent interface: the editor offered as WebMCP tools.

   A browser that implements WebMCP gives the page a model context —
   document.modelContext in the current draft, navigator.modelContext in
   earlier previews and the MCP-B polyfill — and an AI agent working in that
   browser can then call the tools the page registers there. Nothing here runs
   a server, opens a socket or fetches anything on its own: the tools are plain
   functions over the same state the mouse edits, so the app stays a static
   page. A browser without WebMCP simply never sees them.

   Loaded after app.js and leaning on its top-level functions, the way the
   tests do. init() calls registerAgentTools() once the document has loaded.
   Every change an agent makes is one undo step and goes through save(), so the
   person watching sees it happen and can take it back. Geometry is in
   millimetres and pages are numbered 1–8, as the UI shows them; font sizes
   are in points, as the inspector labels them. */

'use strict';

/* --------------------------------------------------------------- helpers */

const agentPage = n => n - 1;                 // tool page number -> panel index
const agentPt = mmVal => Math.round(mmVal * PT * 100) / 100;
const agentEdgeNames = { t: 'top', b: 'bottom', l: 'left', r: 'right' };

function agentFail(msg) { throw new Error(msg); }

function agentFind(id) {
  for (let pi = 0; pi < doc().panels.length; pi++) {
    const el = doc().panels[pi].els.find(e => e.id === id);
    if (el) return { el: el, pi: pi };
  }
  agentFail('No element with id "' + id + '". Call get_zine for the current ids.');
}

function agentColour(v, name) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v).trim());
  if (!m) agentFail(name + ' must be a hex colour like #ff4f6d, got "' + v + '".');
  const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
  return '#' + h.toLowerCase();
}

/* Checks an input against its tool's schema: flat objects only, which is all
   any tool takes. An agent that misspells a property hears about it instead
   of the call quietly doing less than it asked. */
function agentCheck(tool, input) {
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) agentFail('Input must be an object.');
  const props = tool.inputSchema.properties || {};
  Object.keys(input).forEach(k => {
    const s = props[k], v = input[k];
    if (!s) agentFail('Unknown property "' + k + '". ' + tool.name + ' takes: ' +
                      (Object.keys(props).join(', ') || 'nothing') + '.');
    if (v == null) return;
    const type = Array.isArray(s.type) ? s.type : [s.type];
    const ok = type.some(t =>
      t === 'integer' ? Number.isInteger(v) :
      t === 'number' ? typeof v === 'number' && isFinite(v) :
      t === 'null' ? v === null : typeof v === t);
    if (!ok) agentFail(k + ' must be ' + type.join(' or ') + '.');
    if (s.enum && s.enum.indexOf(v) < 0) agentFail(k + ' must be one of: ' + s.enum.join(', ') + '.');
    if (s.minimum != null && v < s.minimum) agentFail(k + ' must be at least ' + s.minimum + '.');
    if (s.maximum != null && v > s.maximum) agentFail(k + ' must be at most ' + s.maximum + '.');
  });
  (tool.inputSchema.required || []).forEach(k => {
    if (input[k] == null) agentFail(k + ' is required.');
  });
  return input;
}

/* A text box's height is whatever its words wrap to, so measure it the way
   the page would lay it out, off screen. */
function agentTextHeight(el) {
  const g = geom();
  const box = document.createElement('div');
  box.className = 'panel';
  box.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;width:' +
                      g.panelW + 'px;height:' + g.panelH + 'px';
  const n = makeNode(Object.assign({}, el, { rot: 0 }), false, 0);
  box.appendChild(n);
  document.body.appendChild(box);
  const h = n.offsetHeight;
  box.remove();
  return h;
}

function agentHeight(el) { return el.type === 'text' ? agentTextHeight(el) : el.h; }

/* What would surprise someone looking at the print: a QR code that cannot
   hold its data, or a part of the element on the rim the printer skips. */
function agentWarnings(el, pi) {
  const out = [];
  if (el.type === 'qr' && !qrFor(el.text || '', el.ecl || 'M').ok) {
    out.push('Too much data for a QR code: shorten it or lower error_correction.');
  }
  if (el.type === 'image' && !el.src) out.push('Empty photo frame: it shows on screen but never prints.');
  const e = unsafeEdges(pi), g = geom(), h = agentHeight(el);
  if (e && !el.rot) {
    const reach = { t: -el.y, b: el.y + h - g.panelH, l: -el.x, r: el.x + el.w - g.panelW };
    const rim = Object.keys(agentEdgeNames).filter(k => e[k] && reach[k] > -e[k] * PT);
    if (rim.length) {
      out.push('Reaches into the printer margin at the ' + rim.map(k => agentEdgeNames[k]).join(' and ') +
               ' — that part will not print.');
    }
  }
  return out;
}

function agentDescribe(el, pi) {
  const o = { id: el.id, type: el.type, page: pi + 1, layer: doc().panels[pi].els.indexOf(el),
              x: mmv(el.x), y: mmv(el.y), width: mmv(el.w), height: mmv(agentHeight(el)),
              rotation: el.rot || 0, both_pages: !!el.span };
  if (el.type === 'text') {
    Object.assign(o, {
      text: el.text, font: (FONTS[el.font] || FONTS[0]).n, size: el.size, color: el.color,
      align: el.align, bold: !!el.bold, italic: !!el.italic, line_spacing: el.lh,
      letter_spacing: el.ls, background: el.bg || null
    });
  } else if (el.type === 'qr') {
    Object.assign(o, {
      data: el.text, error_correction: el.ecl || 'M', dark: el.dark || '#111111',
      light: el.light || '#ffffff', quiet: el.quiet == null ? 4 : el.quiet,
      opacity: el.opacity == null ? 1 : el.opacity
    });
  } else {
    Object.assign(o, {
      has_photo: !!el.src, fit: el.fit || 'cover', filter: el.filter || 'none',
      shape: el.shape || 'rect', focus_x: el.px == null ? 50 : el.px,
      focus_y: el.py == null ? 50 : el.py, opacity: el.opacity == null ? 1 : el.opacity,
      corner_radius: el.radius || 0
    });
  }
  const w = agentWarnings(el, pi);
  if (w.length) o.warnings = w;
  return o;
}

/* Which properties each element type has, so update_element can say so when
   asked to set a font on a photo rather than ignoring it. */
const AGENT_OWN = {
  text: ['text', 'font', 'size', 'color', 'align', 'bold', 'italic', 'line_spacing',
         'letter_spacing', 'background'],
  qr: ['data', 'error_correction', 'dark', 'light', 'quiet', 'opacity'],
  image: ['fit', 'filter', 'shape', 'focus_x', 'focus_y', 'opacity', 'corner_radius']
};
const AGENT_COMMON = ['x', 'y', 'width', 'height', 'rotation', 'both_pages'];

function agentApply(el, a) {
  Object.keys(a).forEach(k => {
    if (a[k] == null || AGENT_COMMON.indexOf(k) >= 0 || AGENT_OWN[el.type].indexOf(k) >= 0) return;
    if (AGENT_OWN.text.concat(AGENT_OWN.qr, AGENT_OWN.image).indexOf(k) >= 0) {
      agentFail(k + ' does not apply to a ' + { text: 'text box', qr: 'QR code', image: 'photo' }[el.type] + '.');
    }
  });
  if (a.height != null && el.type === 'text') agentFail('A text box is as tall as its words; set width instead.');
  if (a.x != null) el.x = agentPt(a.x);
  if (a.y != null) el.y = agentPt(a.y);
  if (a.width != null) el.w = Math.max(8, agentPt(a.width));
  if (a.height != null) el.h = Math.max(8, agentPt(a.height));
  if (el.type === 'qr') el.h = el.w;                  // always square
  if (a.rotation != null) el.rot = wrapDeg(a.rotation);
  if (a.both_pages != null) { if (a.both_pages) el.span = true; else delete el.span; }
  if (a.opacity != null) el.opacity = a.opacity;

  if (a.text != null) el.text = a.text;
  if (a.font != null) el.font = FONTS.findIndex(f => f.n === a.font);
  if (a.size != null) el.size = a.size;
  if (a.color != null) el.color = agentColour(a.color, 'color');
  if (a.align != null) el.align = a.align;
  if (a.bold != null) el.bold = a.bold;
  if (a.italic != null) el.italic = a.italic;
  if (a.line_spacing != null) el.lh = a.line_spacing;
  if (a.letter_spacing != null) el.ls = a.letter_spacing;
  if (a.background !== undefined) el.bg = a.background ? agentColour(a.background, 'background') : '';

  if (a.data != null) el.text = a.data;
  if (a.error_correction != null) el.ecl = a.error_correction;
  if (a.dark != null) el.dark = agentColour(a.dark, 'dark');
  if (a.light != null) el.light = agentColour(a.light, 'light');
  if (a.quiet != null) el.quiet = a.quiet;

  if (a.fit != null) el.fit = a.fit;
  if (a.filter != null) el.filter = a.filter;
  if (a.shape != null) { if (a.shape === 'rect') delete el.shape; else el.shape = a.shape; }
  if (a.focus_x != null) el.px = a.focus_x;
  if (a.focus_y != null) el.py = a.focus_y;
  if (a.corner_radius != null) el.radius = a.corner_radius;
}

/* Every change lands on screen: the page it touched comes up, the element it
   touched is selected, and the whole thing is saved like any other edit. */
function agentShow(pi, id) {
  state.active = pi;
  selId = id || null;
  paintAll(); save();
}

/* Keep enough of an element on the spread to grab, as a drag would. */
function agentClamp(el, pi) {
  clampPos(el, { offsetHeight: agentHeight(el) }, pi);
}

/* Photos come in through importImage(), so an agent's picture is downscaled
   and re-encoded exactly like one chosen from disk. */
async function agentFetchImage(url) {
  let blob;
  try {
    const res = await fetch(url);
    if (!res.ok) agentFail('Fetching the image failed: HTTP ' + res.status + '.');
    blob = await res.blob();
  } catch (err) {
    agentFail('Could not fetch the image (' + err.message + '). A URL on another site has to allow ' +
              'cross-origin requests; a data: URL always works.');
  }
  if (!/^image\//.test(blob.type)) agentFail('That URL is not an image (it is ' + (blob.type || 'untyped') + ').');
  try { return await importImage(blob); }
  catch (err) { agentFail('The browser could not read that image.'); }
}

/* -------------------------------------------------------------- schemas */

const AGENT_P = {
  page: { type: 'integer', minimum: 1, maximum: 8,
          description: 'Page number: 1 is the front cover, 2–7 the inside pages in reading order, 8 the back cover.' },
  id: { type: 'string', description: 'Element id, from get_zine or the call that added it.' },
  x: { type: 'number', description: 'Distance of the left edge from the left of its page, in mm. May be negative to bleed off.' },
  y: { type: 'number', description: 'Distance of the top edge from the top of its page, in mm. May be negative to bleed off.' },
  width: { type: 'number', minimum: 3, description: 'Width in mm.' },
  height: { type: 'number', minimum: 3, description: 'Height in mm.' },
  rotation: { type: 'number', description: 'Clockwise rotation in degrees, about the centre.' },
  both_pages: { type: 'boolean',
                description: 'Run across the fold onto the facing page, printing straight through the crease, instead of stopping at the fold.' },
  opacity: { type: 'number', minimum: 0.05, maximum: 1, description: 'Opacity, 0.05–1.' },

  text: { type: 'string', description: 'The words. \\n starts a new line.' },
  font: { type: 'string', enum: FONTS.map(f => f.n), description: 'Typeface.' },
  size: { type: 'number', minimum: 4, maximum: 200, description: 'Font size in points.' },
  color: { type: 'string', description: 'Text colour, hex like #111111.' },
  align: { type: 'string', enum: ['left', 'center', 'right'] },
  bold: { type: 'boolean' },
  italic: { type: 'boolean' },
  line_spacing: { type: 'number', minimum: 0.5, maximum: 4, description: 'Line height as a multiple of the font size.' },
  letter_spacing: { type: 'number', minimum: -10, maximum: 40, description: 'Extra space between letters, in points.' },
  background: { type: ['string', 'null'], description: 'Fill behind the text, hex colour, or null for none.' },

  data: { type: 'string', description: 'What the QR code encodes, usually a URL.' },
  error_correction: { type: 'string', enum: QR.LEVELS,
                      description: 'Damage tolerance: L low, M normal, Q high, H highest. Higher holds less data.' },
  dark: { type: 'string', description: 'QR module colour, hex.' },
  light: { type: 'string', description: 'QR background colour, hex.' },
  quiet: { type: 'integer', minimum: 0, maximum: 8, description: 'Blank border around the code, in code squares.' },

  fit: { type: 'string', enum: ['cover', 'contain'],
         description: 'cover fills the frame and crops; contain shows the whole photo.' },
  filter: { type: 'string', enum: FILTERS.map(f => f.v),
            description: 'Photo effect: ' + FILTERS.map(f => f.v + ' (' + f.n + ')').join(', ') + '.' },
  shape: { type: 'string', enum: SHAPES.map(s => s.v), description: 'Mask the photo is cut to.' },
  focus_x: { type: 'number', minimum: 0, maximum: 100, description: 'With fit cover, which part shows: 0 left edge, 100 right edge.' },
  focus_y: { type: 'number', minimum: 0, maximum: 100, description: 'With fit cover, which part shows: 0 top edge, 100 bottom edge.' },
  corner_radius: { type: 'number', minimum: 0, description: 'Rounded corners, in points.' }
};

function agentSchema(keys, required, extra) {
  const properties = {};
  keys.forEach(k => { properties[k] = AGENT_P[k]; });
  Object.assign(properties, extra || {});
  return { type: 'object', properties: properties, required: required || [], additionalProperties: false };
}

const AGENT_TEXT_KEYS = ['page', 'x', 'y', 'width', 'rotation', 'both_pages'].concat(AGENT_OWN.text);
const AGENT_QR_KEYS = ['page', 'x', 'y', 'width', 'rotation', 'both_pages'].concat(AGENT_OWN.qr);
const AGENT_IMAGE_KEYS = ['page', 'x', 'y', 'width', 'height', 'rotation', 'both_pages'].concat(AGENT_OWN.image);

/* ---------------------------------------------------------------- tools */

const AGENT_TOOLS = [
  {
    name: 'get_zine',
    title: 'Read the zine',
    description: 'Everything in the zine: title, paper, page size, printer margin, which pages face each ' +
      'other, and every page with its background and elements (ids, mm geometry, properties, and ' +
      'warnings such as artwork in the unprintable rim). The zine is one sheet folded into an ' +
      'eight-page booklet; facing pages are 8|1 (outside), 2|3, 4|5, 6|7. Coordinates are mm from ' +
      'the top-left of each page. Call this first.',
    annotations: { readOnlyHint: true },
    inputSchema: agentSchema([]),
    run() {
      const g = geom(), p = PAPER[state.paper];
      return {
        title: state.title,
        paper: { id: state.paper, name: p.label, width_mm: p.w, height_mm: p.h },
        page_size_mm: { width: mmv(g.panelW), height: mmv(g.panelH) },
        printer_margin_mm: clampMargin(state.margin),
        trim_margin: !!state.trimMargin,
        cut_guide: !!state.cut,
        spreads: SPREADS.map(s => s.map(i => i + 1)),
        showing: visiblePanels().map(i => i + 1),
        active_page: state.active + 1,
        selected: selId,
        can_undo: hist.length > 0,
        can_redo: future.length > 0,
        layouts: TEMPLATES.map(t => t.n),
        pages: doc().panels.map((pn, pi) => {
          const e = unsafeEdges(pi), sp = spanPartner(pi);
          const rim = {};
          if (e) Object.keys(agentEdgeNames).forEach(k => { if (e[k]) rim[agentEdgeNames[k]] = e[k]; });
          return {
            page: pi + 1, label: LABELS[pi], background: pn.bg,
            facing_page: sp ? sp.pi + 1 : null,
            unprintable_edges_mm: rim,
            elements: pn.els.map(el => agentDescribe(el, pi))
          };
        })
      };
    }
  },
  {
    name: 'render_preview',
    title: 'Look at the zine',
    description: 'A PNG of how the zine looks. view "spread" (default) shows a page with the one it faces, ' +
      'the way a reader sees them; "page" shows one page; "sheet" shows the whole imposed print sheet ' +
      'exactly as it exports, with the top row upside down. In spread and page views the strip the ' +
      'printer cannot reach is tinted pink and empty photo frames are outlined; neither prints.',
    annotations: { readOnlyHint: true },
    inputSchema: agentSchema(['page'], [], {
      view: { type: 'string', enum: ['spread', 'page', 'sheet'] }
    }),
    async run(a) {
      const g = geom(), view = a.view || 'spread';
      const pi = a.page ? agentPage(a.page) : state.active;
      stopEdit();
      let node, w, h, scale, pages;
      if (view === 'sheet') {
        node = buildSheetNode(); w = g.sheetW; h = g.sheetH; scale = 1.5; pages = [1, 2, 3, 4, 5, 6, 7, 8];
      } else {
        const list = view === 'page' ? [pi] : SPREADS.find(s => s.indexOf(pi) >= 0);
        w = g.panelW * list.length; h = g.panelH; scale = 2; pages = list.map(i => i + 1);
        node = document.createElement('div');
        node.style.cssText = 'position:relative;overflow:hidden;background:#ffffff;width:' + w + 'px;height:' + h + 'px';
        list.forEach((i, k) => {
          const pn = document.createElement('div');
          pn.className = 'panel';
          pn.style.cssText = 'position:absolute;top:0;left:' + (k * g.panelW) + 'px;width:' + g.panelW +
                             'px;height:' + g.panelH + 'px;background:' + doc().panels[i].bg;
          paintList(i).forEach(it => {
            const n = makeNode(it.el, false, it.dx);
            if (it.el.type === 'image' && !it.el.src) n.style.outline = '1.5px dashed #8a8fa3';
            pn.appendChild(n);
          });
          const e = unsafeEdges(i);
          if (e) Object.keys(agentEdgeNames).forEach(s => {
            if (!e[s]) return;
            const b = document.createElement('div'), v = e[s] * PT + 'px';
            b.style.cssText = 'position:absolute;background:rgba(255,40,100,.22);' +
              (s === 't' ? 'left:0;right:0;top:0;height:' + v : s === 'b' ? 'left:0;right:0;bottom:0;height:' + v
                : s === 'l' ? 'top:0;bottom:0;left:0;width:' + v : 'top:0;bottom:0;right:0;width:' + v);
            pn.appendChild(b);
          });
          node.appendChild(pn);
        });
      }
      const cv = await rasterize(node, w, h, scale);
      const url = cv.toDataURL('image/png');
      return { type: 'image', mimeType: 'image/png', data: url.slice(url.indexOf(',') + 1),
               width: cv.width, height: cv.height, view: view, pages: pages };
    }
  },
  {
    name: 'set_document',
    title: 'Change print settings',
    description: 'Title, paper size and print settings for the whole zine. printer_margin_mm is the rim ' +
      'most home printers cannot reach (default 5); trim_margin means the edge is cut off before ' +
      'folding for an edge-to-edge zine; cut_guide prints a line along the slit.',
    inputSchema: agentSchema([], [], {
      title: { type: 'string' },
      paper: { type: 'string', enum: Object.keys(PAPER), description: 'a4 or letter (US Letter).' },
      printer_margin_mm: { type: 'number', minimum: 0, maximum: 25 },
      trim_margin: { type: 'boolean' },
      cut_guide: { type: 'boolean' }
    }),
    run(a) {
      stopEdit();
      if (a.title != null) { state.title = a.title; $('#title').value = a.title; }
      if (a.paper != null) { state.paper = a.paper; $('#paper').value = a.paper; }
      if (a.printer_margin_mm != null) state.margin = clampMargin(a.printer_margin_mm);
      if (a.trim_margin != null) state.trimMargin = a.trim_margin;
      if (a.cut_guide != null) state.cut = a.cut_guide;
      paintAll(); save();
      return { title: state.title, paper: state.paper, printer_margin_mm: state.margin,
               trim_margin: state.trimMargin, cut_guide: state.cut };
    }
  },
  {
    name: 'show_page',
    title: 'Turn to a page',
    description: 'Bring a page, and the one facing it, up on screen for the person using the editor.',
    annotations: { readOnlyHint: true },
    inputSchema: agentSchema(['page'], ['page']),
    run(a) {
      stopEdit();
      setActive(agentPage(a.page));
      return { showing: visiblePanels().map(i => i + 1) };
    }
  },
  {
    name: 'add_text',
    title: 'Add text',
    description: 'Add a text box to a page. It wraps to its width and is as tall as its words. ' +
      'Defaults: Sans 13 pt, #111111, across the middle of the page.',
    inputSchema: agentSchema(AGENT_TEXT_KEYS, ['page', 'text']),
    run(a) {
      stopEdit();
      const g = geom(), pi = agentPage(a.page);
      const el = {
        id: uid(), type: 'text',
        x: Math.round(g.panelW * 0.12), y: Math.round(g.panelH * 0.4),
        w: Math.round(g.panelW * 0.76), rot: 0,
        text: '', font: 0, size: 13,
        color: '#111111', align: 'left', lh: 1.35, ls: 0,
        bold: false, italic: false, bg: '', pad: 4
      };
      agentApply(el, a);
      agentClamp(el, pi);
      pushHistory();
      doc().panels[pi].els.push(el);
      agentShow(pi, el.id);
      return agentDescribe(el, pi);
    }
  },
  {
    name: 'add_image',
    title: 'Add a photo',
    description: 'Add a photo to a page from a URL (https, or a data: URL; other sites must allow ' +
      'cross-origin requests). It is downscaled to 1500 px like any import. Without width and height ' +
      'it is centred at up to 80% of the page width, keeping its proportions; with only one, the ' +
      'other follows the photo. With no url, adds an empty photo frame for the person to fill.',
    inputSchema: agentSchema(AGENT_IMAGE_KEYS, ['page'], {
      url: { type: 'string', description: 'Where to get the picture: https://… or data:image/…' }
    }),
    async run(a) {
      const g = geom(), pi = agentPage(a.page);
      const img = a.url ? await agentFetchImage(a.url) : null;
      stopEdit();
      const ratio = img ? img.h / img.w : 0.75;
      let w = g.panelW * 0.8, h = w * ratio;
      if (h > g.panelH * 0.55) { h = g.panelH * 0.55; w = h / ratio; }
      if (a.width != null && a.height == null) { w = agentPt(a.width); h = w * ratio; }
      if (a.height != null && a.width == null) { h = agentPt(a.height); w = h / ratio; }
      const el = Object.assign(emptyFrame(), {
        x: Math.round((g.panelW - w) / 2), y: Math.round((g.panelH - h) / 2),
        w: Math.round(w), h: Math.round(h), src: img ? img.src : ''
      });
      const rest = Object.assign({}, a);
      if (a.width == null || a.height == null) { delete rest.width; delete rest.height; }
      delete rest.url;
      agentApply(el, rest);
      agentClamp(el, pi);
      pushHistory();
      doc().panels[pi].els.push(el);
      agentShow(pi, el.id);
      return agentDescribe(el, pi);
    }
  },
  {
    name: 'add_qr',
    title: 'Add a QR code',
    description: 'Add a QR code to a page. It is always square; width sets its size. ' +
      'Defaults: about 30 mm, centred, error correction M.',
    inputSchema: agentSchema(AGENT_QR_KEYS, ['page', 'data']),
    run(a) {
      stopEdit();
      const g = geom(), pi = agentPage(a.page);
      const side = Math.round(Math.min(g.panelW, g.panelH) * 0.42);
      const el = {
        id: uid(), type: 'qr',
        x: Math.round((g.panelW - side) / 2), y: Math.round((g.panelH - side) / 2),
        w: side, h: side, rot: 0,
        text: '', ecl: 'M', dark: '#111111', light: '#ffffff', quiet: 4, opacity: 1
      };
      if (a.width != null && a.x == null) el.x = Math.round((g.panelW - agentPt(a.width)) / 2);
      if (a.width != null && a.y == null) el.y = Math.round((g.panelH - agentPt(a.width)) / 2);
      agentApply(el, a);
      agentClamp(el, pi);
      pushHistory();
      doc().panels[pi].els.push(el);
      agentShow(pi, el.id);
      return agentDescribe(el, pi);
    }
  },
  {
    name: 'update_element',
    title: 'Change an element',
    description: 'Change any properties of an existing element; leave out what should stay. ' +
      'to_page moves it to another page at the same position; layer reorders it on its page.',
    inputSchema: agentSchema(['id'].concat(AGENT_COMMON, AGENT_OWN.text, AGENT_OWN.qr, AGENT_OWN.image), ['id'], {
      to_page: AGENT_P.page,
      layer: { type: 'string', enum: ['top', 'raise', 'lower', 'bottom'],
               description: 'top: in front of everything on its page; bottom: behind everything.' }
    }),
    run(a) {
      stopEdit();
      const f = agentFind(a.id);
      const el = f.el;
      const trial = JSON.parse(JSON.stringify(el));
      const rest = Object.assign({}, a);
      delete rest.id; delete rest.to_page; delete rest.layer;
      agentApply(trial, rest);                         // fail before touching history
      pushHistory();
      agentApply(el, rest);
      let pi = f.pi;
      if (a.to_page != null && agentPage(a.to_page) !== pi) {
        const from = doc().panels[pi];
        from.els = from.els.filter(e => e !== el);
        pi = agentPage(a.to_page);
        doc().panels[pi].els.push(el);
      }
      if (a.layer) {
        const els = doc().panels[pi].els, i = els.indexOf(el);
        const j = a.layer === 'top' ? els.length - 1 : a.layer === 'bottom' ? 0
                : Math.min(els.length - 1, Math.max(0, i + (a.layer === 'raise' ? 1 : -1)));
        els.splice(j, 0, els.splice(i, 1)[0]);
      }
      agentClamp(el, pi);
      agentShow(pi, el.id);
      return agentDescribe(el, pi);
    }
  },
  {
    name: 'delete_element',
    title: 'Delete an element',
    description: 'Remove an element from its page. The person can undo it.',
    inputSchema: agentSchema(['id'], ['id']),
    run(a) {
      stopEdit();
      const f = agentFind(a.id);
      pushHistory();
      doc().panels[f.pi].els = doc().panels[f.pi].els.filter(e => e !== f.el);
      agentShow(f.pi, null);
      return { deleted: a.id, page: f.pi + 1 };
    }
  },
  {
    name: 'apply_layout',
    title: 'Apply a layout',
    description: 'Arrange a page from a layout template. What is already on the page is poured into the ' +
      'template\'s slots in order (photos first); slots with nothing to fill them get placeholder text ' +
      'or an empty photo frame, and anything left over stays where it was. "Across the fold" and ' +
      '"Wide photo" fill the whole spread. Fill frames with update_element or add_image afterwards.',
    inputSchema: agentSchema(['page'], ['page', 'layout'], {
      layout: { type: 'string', enum: TEMPLATES.map(t => t.n) }
    }),
    run(a) {
      stopEdit();
      const pi = agentPage(a.page);
      state.active = pi;
      applyTemplate(TEMPLATES.find(t => t.n === a.layout));
      return { page: a.page, elements: doc().panels[pi].els.map(el => agentDescribe(el, pi)) };
    }
  },
  {
    name: 'set_page',
    title: 'Change a page',
    description: 'Set a page\'s background colour, or clear everything off it (clear runs first, so both ' +
      'together give a fresh page in a new colour).',
    inputSchema: agentSchema(['page'], ['page'], {
      background: { type: 'string', description: 'Page colour, hex like #ffd23f.' },
      clear: { type: 'boolean', description: 'Remove every element and reset the colour to white.' }
    }),
    run(a) {
      stopEdit();
      const pi = agentPage(a.page);
      const bg = a.background != null ? agentColour(a.background, 'background') : null;
      pushHistory();
      if (a.clear) doc().panels[pi] = blankPanel();
      if (bg) doc().panels[pi].bg = bg;
      agentShow(pi, null);
      return { page: a.page, background: doc().panels[pi].bg, elements: doc().panels[pi].els.length };
    }
  },
  {
    name: 'move_page',
    title: 'Reorder pages',
    description: 'Move a page, with everything on it, to another position; the pages between shift along.',
    inputSchema: agentSchema([], ['from', 'to'], { from: AGENT_P.page, to: AGENT_P.page }),
    run(a) {
      if (a.from !== a.to) movePage(agentPage(a.from), agentPage(a.to));
      return { page: a.to };
    }
  },
  {
    name: 'undo',
    title: 'Undo',
    description: 'Take back the last change, the agent\'s or the person\'s — it is one shared history.',
    inputSchema: agentSchema([], [], { steps: { type: 'integer', minimum: 1, maximum: 100 } }),
    run(a) {
      stopEdit();
      let n = 0;
      while (n < (a.steps || 1) && hist.length) { undo(); n++; }
      return { undone: n, can_undo: hist.length > 0, can_redo: future.length > 0 };
    }
  },
  {
    name: 'redo',
    title: 'Redo',
    description: 'Put back what undo took back.',
    inputSchema: agentSchema([], [], { steps: { type: 'integer', minimum: 1, maximum: 100 } }),
    run(a) {
      stopEdit();
      let n = 0;
      while (n < (a.steps || 1) && future.length) { redo(); n++; }
      return { redone: n, can_undo: hist.length > 0, can_redo: future.length > 0 };
    }
  },
  {
    name: 'export_zine',
    title: 'Download the zine',
    description: 'Download a file to the person\'s computer: "pdf" is the print-ready sheet at 300 dpi ' +
      '(the editor then shows folding instructions), "png" the same render as an image, "zine" a ' +
      'project file that reopens in the editor with every photo.',
    annotations: { consequentialHint: true },
    inputSchema: agentSchema([], ['format'], { format: { type: 'string', enum: ['pdf', 'png', 'zine'] } }),
    async run(a) {
      if (a.format === 'zine') await saveZine();
      else await exportSheet(a.format);
      return { downloaded: slug(state.title) + '.' + a.format };
    }
  }
];

/* ------------------------------------------------------------ dispatch */

/* The one way in, for the model context and for the tests alike. */
async function callAgentTool(name, input) {
  const tool = AGENT_TOOLS.find(t => t.name === name);
  if (!tool) agentFail('No tool called "' + name + '".');
  return tool.run(agentCheck(tool, input));
}

/* WebMCP's current draft hands the agent whatever execute resolves to,
   serialised as JSON. Earlier previews and the MCP-B polyfill pass the result
   through as an MCP CallToolResult instead, so there it is wrapped in content
   blocks — an image as an image block, so the agent actually sees it. */
function agentContent(r) {
  if (r && r.type === 'image') {
    return { content: [{ type: 'image', data: r.data, mimeType: r.mimeType },
                       { type: 'text', text: JSON.stringify({ view: r.view, pages: r.pages, width: r.width, height: r.height }) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(r) }] };
}

let agentRegistration = null;

function registerAgentTools() {
  const current = document.modelContext, mc = current || navigator.modelContext;
  if (!mc || typeof mc.registerTool !== 'function') return 0;
  const legacy = !current;

  // Registering again (the tests do) replaces the old set rather than
  // colliding with it: aborting the signal is how the draft unregisters.
  if (agentRegistration) {
    agentRegistration.abort.abort();
    agentRegistration.handles.forEach(h => {
      try {
        if (h.handle && typeof h.handle.unregister === 'function') h.handle.unregister();
        else if (typeof h.mc.unregisterTool === 'function') h.mc.unregisterTool(h.name);
      } catch (err) { /* already gone */ }
    });
  }
  const abort = new AbortController();
  agentRegistration = { abort: abort, handles: [] };

  let n = 0;
  AGENT_TOOLS.forEach(t => {
    const def = {
      name: t.name, title: t.title, description: t.description,
      inputSchema: t.inputSchema, annotations: t.annotations || {},
      // Arguments arrive parsed; accept them still as JSON text, just in case.
      execute: input => callAgentTool(t.name, typeof input === 'string' ? JSON.parse(input) : input).then(
        r => legacy ? agentContent(r) : r,
        err => {
          if (!legacy) throw err;
          return { content: [{ type: 'text', text: err.message }], isError: true };
        })
    };
    try {
      const handle = mc.registerTool(def, { signal: abort.signal });
      if (handle && typeof handle.then === 'function') {
        handle.catch(err => console.warn('WebMCP: could not register ' + t.name + ': ' + err.message));
      }
      agentRegistration.handles.push({ mc: mc, name: t.name, handle: legacy ? handle : null });
      n++;
    } catch (err) {
      console.warn('WebMCP: could not register ' + t.name + ': ' + err.message);
    }
  });
  return n;
}
