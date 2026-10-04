/* The usability pass: the settings view handing the column back, millimetre
   fields, plain labels, photo frames, click-to-edit, page turning, the spread
   strip, snapping, swatches, undo toasts, deeper undo, the save note and the
   folding guide. Each is driven through the real wiring and measured, not
   read off the stylesheet. */

'use strict';

const { assert, pngDataUrl } = require('./harness');

let page = null;

/* A mouse gesture, as the editor suite synthesises it, with modifier keys. */
const GESTURE = `(function (target, x0, y0, x1, y1, opts) {
  const ev = (t, el, x, y) => el.dispatchEvent(new PointerEvent(t, {
    clientX: x, clientY: y, button: 0, buttons: t === 'pointerup' ? 0 : 1,
    bubbles: true, altKey: !!(opts && opts.alt)
  }));
  ev('pointerdown', target, x0, y0);
  ev('pointermove', window, x1, y1);
  ev('pointerup', window, x1, y1);
})`;

const CLICK = `(function (target, x, y) {
  const ev = t => target.dispatchEvent(new PointerEvent(t, {
    clientX: x, clientY: y, button: 0, buttons: t === 'pointerup' ? 0 : 1, bubbles: true
  }));
  ev('pointerdown'); window.dispatchEvent(new PointerEvent('pointerup', {
    clientX: x, clientY: y, button: 0, buttons: 0, bubbles: true }));
})`;

const settle = () => new Promise(r => setTimeout(r, 300));

module.exports = {
  name: 'Usability',
  browser: true,

  async teardown() { if (page) await page.unemulate(); },

  collect(t) {
    page = t.page;

    t.check('selecting something else hands the column back from the settings view', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        addText(); stopEdit(); const a = selId;
        setSide(true);
        const settings = $('#inspector h2').textContent;
        addQr();                              // a new selection
        return { settings: settings, after: $('#inspector h2').textContent,
                 sideOpen: sideOpen, pressed: $('#panelBtn').classList.contains('on') };
      })()`);
      assert.eq(r.settings, 'Whole project', 'the button still opens the project view');
      assert.eq(r.after, 'QR code', 'a new selection shows its own controls, not the project');
      assert.eq(r.sideOpen, false);
      assert.eq(r.pressed, false, 'and the button stops looking pressed');
    });

    t.check('position and size read and write millimetres, and fit three digits', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        panel().els.push({ id: 'big', type: 'image', x: PT * 12.5, y: PT * 40, w: PT * 168,
          h: PT * 100, rot: 0, src: ${pngDataUrl('#888888')}, fit: 'cover', filter: 'none',
          opacity: 1, radius: 0 });
        selId = 'big'; paintAll();
        const f = k => $('#inspector input[data-k="' + k + '"][data-mm]');
        const shown = { x: f('x').value, w: f('w').value, h: f('h').value };
        const w = f('w');
        const fits = w.scrollWidth <= w.clientWidth;
        w.value = '50'; w.dispatchEvent(new Event('input')); w.dispatchEvent(new Event('change'));
        const el = selected();
        return { shown: shown, fits: fits, wPt: el.w, wantPt: 50 * PT };
      })()`);
      assert.eq(r.shown.x, '12.5', 'x shows in mm');
      assert.eq(r.shown.w, '168', 'width shows in mm');
      assert.eq(r.shown.h, '100', 'height sits beside width for an image');
      assert.eq(r.fits, true, 'a three-digit value must not be clipped');
      assert.near(r.wPt, r.wantPt, 0.01, 'typing 50 mm stores 50 mm worth of points');
    });

    t.check('controls use plain words, and nothing says Back or Front', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        addText(); stopEdit();
        const txt = $('#inspector').textContent;
        const words = [...$('#inspector').querySelectorAll('button')].map(b => b.textContent.trim());
        const aligns = [...$('#inspector').querySelectorAll('[data-k="align"]')].map(b => b.getAttribute('aria-label'));
        addQr();
        const qr = $('#inspector').textContent;
        return { txt: txt, words: words, aligns: aligns, qr: qr };
      })()`);
      ['Line spacing', 'Letter spacing', 'Background', 'Layer order', 'Edit text', 'From left mm']
        .forEach(w => assert.includes(r.txt, w));
      ['Track', 'Ink', 'Box'].forEach(w =>
        assert.eq(new RegExp('\\\\b' + w + '\\\\b').test(r.txt), false, 'still says ' + w));
      assert.eq(r.words.indexOf('Back') < 0 && r.words.indexOf('Front') < 0, true,
        '"Back" reads as the back cover');
      assert.deepEq(r.aligns, ['Align left', 'Align center', 'Align right']);
      ['Damage tolerance', 'Border', 'Background'].forEach(w => assert.includes(r.qr, w));
      ['Quiet', 'Correction', 'Paper'].forEach(w =>
        assert.eq(r.qr.indexOf(w) < 0, true, 'the QR controls still say ' + w));
    });

    t.check('the interface says page, never panel', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        select(null); buildInspector();
        const insp = $('#inspector').textContent;
        const titles = [...document.querySelectorAll('#strip .thumb, #sheetLabels span')].map(n => n.title);
        setSide(true);
        const proj = $('#inspector').textContent;
        setSide(false);
        return { insp: insp, titles: titles.join('|'), proj: proj };
      })()`);
      assert.eq(/panel/i.test(r.insp), false, 'page view: ' + r.insp);
      assert.eq(/panel/i.test(r.proj), false, 'project view: ' + r.proj);
      assert.eq(/panel/i.test(r.titles), false, 'tooltips: ' + r.titles);
    });

    t.check('an empty photo frame fills in place and never prints', async () => {
      await page.reset({ margin: 0, cut: false });
      const r = await page.evaluate(`(async () => {
        setActive(2);
        applyTemplate(TEMPLATES.find(x => x.n === 'Framed photo'));
        const frame = panel().els[0];
        // empty: nothing reaches the export
        const g = geom();
        const cv = await rasterize(buildSheetNode(), g.sheetW, g.sheetH, 0.5);
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let ink = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) ink++;
        // fill it as the picker would
        const box = { w: frame.w, h: frame.h, x: frame.x };
        const c = document.createElement('canvas'); c.width = 40; c.height = 20;
        c.getContext('2d').fillRect(0, 0, 40, 20);
        const blob = await new Promise(res => c.toBlob(res, 'image/png'));
        fillTarget = frame.id;
        await addImageFiles([new File([blob], 'a.png', { type: 'image/png' })]);
        const after = panel().els;
        return { ink: ink, count: after.length, filled: /^data:image/.test(after[0].src),
                 same: after[0].w === box.w && after[0].h === box.h && after[0].x === box.x,
                 drawnAsImg: nodes.get(frame.id).querySelector('.body').tagName };
      })()`);
      assert.eq(r.ink, 0, 'an empty frame is chrome only, so the export is blank paper');
      assert.eq(r.count, 1, 'the photo goes into the frame, not beside it');
      assert.eq(r.filled, true);
      assert.eq(r.same, true, 'the frame keeps its size and place');
      assert.eq(r.drawnAsImg, 'IMG');
    });

    t.check('clicking selected text again starts editing; a first click only selects', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0); addText(); stopEdit();
        const id = selId, node = nodes.get(id);
        select(null);
        const b = node.getBoundingClientRect();
        ${CLICK}(node, b.left + 5, b.top + 5);
        const first = { sel: selId === id, editing: editingId };
        ${CLICK}(nodes.get(id), b.left + 5, b.top + 5);
        const second = editingId === id;
        stopEdit();
        return { first: first, second: second };
      })()`);
      assert.eq(r.first.sel, true);
      assert.eq(r.first.editing, null, 'a first click only selects');
      assert.eq(r.second, true, 'clicking it again starts editing');
    });

    t.check('the toolbar names its buttons on a wide screen, and File holds open/save/new', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        const label = id => { const s = document.querySelector('#' + id + ' .btn-label');
          return s && s.offsetWidth > 0 ? s.textContent : ''; };
        const out = { text: label('addText'), image: label('addImage'), qr: label('addQr'),
                      file: label('fileBtn'), menuShut: $('#fileMenu').hidden };
        $('#fileBtn').click();
        out.menuOpen = !$('#fileMenu').hidden;
        out.items = ['openZine', 'saveZine', 'newZine'].every(id => $('#fileMenu').contains($('#' + id)));
        document.body.click();
        out.closedOutside = $('#fileMenu').hidden;
        out.saveNote = $('#saveState').textContent;
        return out;
      })()`);
      assert.eq(r.text, 'Text'); assert.eq(r.image, 'Image'); assert.eq(r.qr, 'QR code');
      assert.eq(r.file, 'File');
      assert.eq(r.menuShut, true);
      assert.eq(r.menuOpen, true);
      assert.eq(r.items, true, 'open, save and new all live in the File menu');
      assert.eq(r.closedOutside, true);
      assert.eq(r.saveNote, 'Saved in this browser');
    });

    t.check('the thumbnail strip is grouped by spread, in the order the sheet shows them', async () => {
      await page.reset();
      const r = await page.evaluate(`[...document.querySelectorAll('#strip .pair')]
        .map(p => [...p.querySelectorAll('.thumb .tl')].map(n => n.textContent).join('|'))`);
      assert.deepEq(r, ['back|cover', '2|3', '4|5', '6|7']);
    });

    t.check('pages turn by spread with the arrows and keys, and stop at the ends', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0); select(null);
        const out = { prevAtStart: $('#prevPage').disabled };
        $('#nextPage').click(); out.afterNext = visiblePanels().slice();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
        out.afterKey = visiblePanels().slice();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        out.afterArrow = visiblePanels().slice();
        out.nextAtEnd = $('#nextPage').disabled;
        $('#prevPage').click(); out.back = visiblePanels().slice();
        return out;
      })()`);
      assert.eq(r.prevAtStart, true, 'nothing comes before the outside spread');
      assert.deepEq(r.afterNext, [1, 2]);
      assert.deepEq(r.afterKey, [3, 4]);
      assert.deepEq(r.afterArrow, [5, 6], 'arrows turn pages when nothing is selected');
      assert.eq(r.nextAtEnd, true);
      assert.deepEq(r.back, [3, 4]);
    });

    t.check('the printer rim says what it is on screen, and none of that prints', async () => {
      await page.reset({ margin: 5 });
      const r = await page.evaluate(`({
        label: (document.querySelector('#sheet .chop .band-b span') || {}).textContent || '',
        inExport: !!buildSheetNode().querySelector('.chop')
      })`);
      assert.includes(r.label, 'Print margin');
      assert.eq(r.inExport, false);
    });

    t.check('dragging snaps to the page centre and shows a guide; Alt drags freely', async () => {
      await page.reset({ margin: 0 });
      const r = await page.evaluate(`(() => {
        setActive(0);
        const g = geom();
        panel().els.push({ id: 'q', type: 'qr', x: 20, y: 30, w: 60, h: 60, rot: 0,
          text: 'x', ecl: 'M', dark: '#111111', light: '#ffffff', quiet: 4, opacity: 1 });
        selId = 'q'; paintAll();
        const el = selected();
        // aim the centre 2pt left of the page centre: inside the snap distance
        const want = g.panelW / 2 - el.w / 2 - 2 - el.x;
        let n = nodes.get('q'), b = n.getBoundingClientRect();
        let guide = false;
        const watch = new MutationObserver(recs => recs.forEach(m => m.addedNodes.forEach(x => {
          if (x.classList && x.classList.contains('snap-guide')) guide = true;
        })));
        watch.observe($('#sheet'), { childList: true });
        ${GESTURE}(n, b.left + 5, b.top + 5, b.left + 5 + want * curZoom, b.top + 5);
        watch.takeRecords().forEach(m => m.addedNodes.forEach(x => {
          if (x.classList && x.classList.contains('snap-guide')) guide = true;
        }));
        watch.disconnect();
        const snapped = el.x + el.w / 2 - g.panelW / 2;
        el.x = 20; paintAll();
        n = nodes.get('q'); b = n.getBoundingClientRect();
        ${GESTURE}(n, b.left + 5, b.top + 5, b.left + 5 + want * curZoom, b.top + 5, { alt: true });
        const free = el.x + el.w / 2 - g.panelW / 2;
        return { snapped: snapped, guide: guide, free: free,
                 leftover: document.querySelectorAll('.snap-guide').length };
      })()`);
      assert.near(r.snapped, 0, 0.6, 'the centre should land on the page centre');
      assert.eq(r.guide, true, 'a guide shows while it holds');
      assert.eq(r.leftover, 0, 'and goes when the drag ends');
      assert.ok(Math.abs(r.free) >= 1.4, 'with Alt it stays where it was put, got ' + r.free);
    });

    t.check('colour swatches set the colour, and custom colours are remembered', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        addText(); stopEdit();
        $('#inspector .sw[data-k="color"][data-c="#3a86ff"]').click();
        const colour = selected().color;
        $('#inspector .sw.none[data-k="bg"]').click();
        const bg = selected().bg;
        const pick = $('#inspector input[type="color"][data-k="color"]');
        pick.value = '#123456';
        pick.dispatchEvent(new Event('input')); pick.dispatchEvent(new Event('change'));
        const recent = !!$('#inspector .sw[data-k="color"][data-c="#123456"]');
        select(null); buildInspector();
        $('#inspector .sw[data-page="bg"][data-c="#ffd23f"]').click();
        return { colour: colour, bg: bg, recent: recent, page: panel().bg };
      })()`);
      assert.eq(r.colour, '#3a86ff');
      assert.eq(r.bg, '', 'the "none" swatch clears a text background');
      assert.eq(r.recent, true, 'a custom colour joins the swatches');
      assert.eq(r.page, '#ffd23f', 'page colour has swatches too');
    });

    t.check('a layout, a cleared page and a deletion each offer Undo, with no dialog', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        window.confirm = () => { throw new Error('asked first'); };
        setActive(3); addText(); stopEdit();
        const out = {};
        applyTemplate(TEMPLATES.find(x => x.n === 'Quote'));
        const btn = $('#toast button');
        out.offered = !!btn && btn.textContent === 'Undo';
        btn.click();
        out.undone = panel().els.length === 1 && panel().els[0].text === 'type here';
        select(null); buildInspector();
        $('#inspector [data-act="clearPanel"]').click();
        out.cleared = panel().els.length === 0;
        $('#toast button').click();
        out.restored = panel().els.length === 1;
        select(panel().els[0].id); removeSel();
        out.deleteOffer = !!$('#toast button');
        window.confirm = () => true;
        return out;
      })()`);
      assert.eq(r.offered, true, 'applying a layout offers Undo');
      assert.eq(r.undone, true, 'and Undo puts the page back');
      assert.eq(r.cleared, true, 'clearing a page no longer asks first');
      assert.eq(r.restored, true);
      assert.eq(r.deleteOffer, true);
    });

    t.check('undo reaches back far further, and history never copies the photos', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const big = 'data:image/png;base64,' + 'A'.repeat(200000);
        panel().els.push({ id: 'p', type: 'image', x: 10, y: 10, w: 50, h: 50, rot: 0,
          src: big, fit: 'cover', filter: 'none', opacity: 1, radius: 0 });
        for (let i = 0; i < 60; i++) { pushHistory(); panel().els[0].x += 1; }
        const largest = Math.max.apply(null, hist.map(h => h.length));
        for (let i = 0; i < 60; i++) undo();
        const el = doc().panels[0].els[0];
        return { depth: 60, largest: largest, x: el.x, srcBack: el.src === big };
      })()`);
      assert.ok(r.largest < 5000, 'a snapshot should hold a reference, not the photo: ' + r.largest);
      assert.eq(r.x, 10, 'sixty steps undo all the way back');
      assert.eq(r.srcBack, true, 'and the photo comes back intact');
    });

    t.check('an export is followed by the folding guide, unless turned off', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        try { localStorage.removeItem(FOLD_KEY); } catch (e) {}
        showFoldGuide();
        const dlg = $('#foldDialog');
        const out = { open: dlg.open, diagram: !!dlg.querySelector('svg.fold'),
                      steps: dlg.querySelectorAll('.steps li').length };
        $('#foldNoShow').checked = true; $('#foldNoShow').dispatchEvent(new Event('change'));
        $('#foldClose').click();
        out.closed = !dlg.open;
        showFoldGuide();
        out.staysShut = !dlg.open;
        localStorage.removeItem(FOLD_KEY);
        return out;
      })()`);
      assert.eq(r.open, true);
      assert.eq(r.diagram, true, 'with the same fold diagram help uses');
      assert.ok(r.steps >= 4, 'and numbered steps');
      assert.eq(r.closed, true);
      assert.eq(r.staysShut, true, '"Don’t show after every export" sticks');
    });

    t.check('a phone starts on one page unless a view was picked by hand', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        const fresh = JSON.stringify({ docs: { mini: blankDoc(8) }, singleView: false });
        const chosen = JSON.stringify({ docs: { mini: blankDoc(8) }, singleView: false, viewPref: true });
        localStorage.setItem(KEY, fresh); await load(); const a = state.singleView;
        localStorage.setItem(KEY, chosen); await load(); const b = state.singleView;
        localStorage.clear();
        return { a: a, b: b };
      })()`);
      assert.eq(r.a, true, 'one page at a time is the phone default');
      assert.eq(r.b, false, 'but a choice made by hand is kept');
    });

    t.check('on a phone, toolbar words drop to icons and the open drawer keeps the selection visible', async () => {
      await page.reset({ singleView: true });
      await page.emulate(390, 740);
      await settle();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const g = geom();
        panel().els.push({ id: 'low', type: 'qr', x: 60, y: g.panelH - 70, w: 50, h: 50, rot: 0,
          text: 'x', ecl: 'M', dark: '#111111', light: '#ffffff', quiet: 4, opacity: 1 });
        selId = 'low'; paintAll();
        return { labels: [...document.querySelectorAll('.bar .btn-label')].filter(s => s.offsetWidth).length,
                 file: getComputedStyle($('#fileWrap')).display };
      })()`);
      assert.eq(r.labels, 0, 'icon only on a phone');
      assert.eq(r.file, 'none', 'the File button gives way to the settings sheet');
      await page.evaluate('setElemDrawer(true)');
      await settle();
      const v = await page.evaluate(`(() => {
        const n = nodes.get('low').getBoundingClientRect();
        const d = $('#elemDrawer').getBoundingClientRect();
        return { bottom: Math.round(n.bottom), drawerTop: Math.round(d.top) };
      })()`);
      assert.ok(v.bottom <= v.drawerTop, 'the selection sits above the open drawer: ' +
        v.bottom + ' vs ' + v.drawerTop);
      await page.evaluate('setElemDrawer(false)');
      await settle();
      const back = await page.evaluate("document.querySelector('.paper-wrap').style.transform");
      assert.eq(back, '', 'and the sheet slides back when it shuts');
      await page.unemulate();
    });

    t.check('dragging a thumbnail onto another moves that page there', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        doc().panels.forEach((p, i) => { p.bg = '#00000' + i; });
        paintAll();
        const th = i => $('#strip .thumb[data-pi="' + i + '"]').getBoundingClientRect();
        const a = th(1), b = th(5);
        const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
        const bx = b.x + b.width / 2, by = b.y + b.height / 2;
        const src = $('#strip .thumb[data-pi="1"]');
        const ev = (t, el, x, y) => el.dispatchEvent(new PointerEvent(t, {
          clientX: x, clientY: y, button: 0, buttons: t === 'pointerup' ? 0 : 1,
          bubbles: true, pointerType: 'mouse' }));
        ev('pointerdown', src, ax, ay);
        ev('pointermove', window, bx, by);
        ev('pointerup', window, bx, by);
        const moved = doc().panels.map(p => p.bg.slice(-1)).join('');
        const active = state.active;
        undo();
        return { moved: moved, active: active,
                 back: doc().panels.map(p => p.bg.slice(-1)).join('') };
      })()`);
      assert.eq(r.moved, '02345167', 'page 2 lands in slot 6, the rest shift up');
      assert.eq(r.active, 5, 'and the moved page is the one shown');
      assert.eq(r.back, '01234567', 'one undo puts them back');
    });
  }
};
