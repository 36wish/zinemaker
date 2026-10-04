/* Editing behaviour: elements, selection across a spread, direct
   manipulation, layout templates and undo. Driven through the same code paths
   the mouse uses, because the bugs here have all been in the wiring rather
   than in any single function. */

'use strict';

const { assert, pngDataUrl } = require('./harness');

/* Synthesises a real pointer gesture on an element in the page. */
const GESTURE = `(function (target, x0, y0, x1, y1, opts) {
  const ev = (t, el, x, y) => el.dispatchEvent(new PointerEvent(t, {
    clientX: x, clientY: y, button: 0, buttons: t === 'pointerup' ? 0 : 1,
    bubbles: true, shiftKey: !!(opts && opts.shift)
  }));
  ev('pointerdown', target, x0, y0);
  ev('pointermove', window, x1, y1);
  ev('pointerup', window, x1, y1);
})`;

module.exports = {
  name: 'Editor',
  browser: true,
  collect(t) {
    const page = t.page;

    t.check('adding text puts it on the active panel and starts editing', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(3);
        addText();
        const el = selected();
        const r = { onPanel: doc().panels[3].els.length, type: el.type,
                    editing: editingId === el.id };
        stopEdit();
        return r;
      })()`);
      assert.eq(r.onPanel, 1);
      assert.eq(r.type, 'text');
      assert.eq(r.editing, true, 'a new text box should be ready to type into');
    });

    t.check('images import as data URLs, keep aspect and are downscaled', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        const c = document.createElement('canvas');
        c.width = 3000; c.height = 2000;
        const x = c.getContext('2d');
        x.fillStyle = '#c0392b'; x.fillRect(0, 0, 3000, 2000);
        const blob = await new Promise(res => c.toBlob(res, 'image/png'));
        await addImageFiles([new File([blob], 'big.png', { type: 'image/png' })]);
        const el = selected();
        const probe = new Image();
        await new Promise(res => { probe.onload = res; probe.src = el.src; });
        return { type: el.type, isData: /^data:image\\//.test(el.src),
                 aspect: +(el.w / el.h).toFixed(2), longEdge: Math.max(probe.width, probe.height) };
      })()`);
      assert.eq(r.type, 'image');
      assert.eq(r.isData, true, 'images must be data URLs, never blob URLs');
      assert.near(r.aspect, 1.5, 0.02, 'aspect ratio preserved');
      assert.eq(r.longEdge, 1500, 'downscaled to the storage budget');
    });

    t.check('every page is shown as a spread of the two that face each other', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        const out = {};
        setActive(0);
        out.outer = visiblePanels().join(',');
        out.panels = document.querySelectorAll('#sheet > .panel').length;
        out.labels = [...document.querySelectorAll('#sheetLabels span')].map(s => s.textContent).join('|');
        out.pairs = [0, 1, 2, 3, 4, 5, 6, 7].map(i => { setActive(i); return visiblePanels().join(''); }).join(' ');
        return out;
      })()`);
      assert.eq(r.outer, '7,0', 'the outer spread is back then cover');
      assert.eq(r.panels, 2);
      assert.eq(r.labels, 'back|cover');
      assert.eq(r.pairs, '70 12 12 34 34 56 56 70', 'each page is always shown with its partner');
    });

    t.check('the flat page format and the page/spread toggle are gone', async () => {
      await page.reset();
      const r = await page.evaluate(`({
        modeSelect: !!document.getElementById('mode'),
        viewToggle: !!document.getElementById('view'),
        flatOption: !!document.querySelector('option[value="flat"]'),
        pageButton: !!document.querySelector('[data-view]'),
        stateMode: 'mode' in state, stateSpread: 'spread' in state,
        docs: Object.keys(state.docs).join(',')
      })`);
      assert.eq(r.modeSelect, false, 'the format selector should be removed');
      assert.eq(r.viewToggle, false, 'the page/spread toggle should be removed');
      assert.eq(r.flatOption, false);
      assert.eq(r.pageButton, false);
      assert.eq(r.stateMode, false, 'state should no longer carry a mode');
      assert.eq(r.stateSpread, false, 'state should no longer carry a spread flag');
      assert.eq(r.docs, 'mini', 'only the eight-panel document remains');
    });

    t.check('help is hidden until asked for, and the button toggles it', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        const help = document.getElementById('help'), insp = document.getElementById('inspector');
        const btn = document.getElementById('helpBtn');
        const out = { startsHidden: help.hidden, startEmpty: help.innerHTML === '',
                      inspectorShown: !insp.hidden, pressed0: btn.getAttribute('aria-pressed') };
        btn.click();
        out.openShown = !help.hidden; out.openHasContent = help.textContent.length > 500;
        out.inspectorHidden = insp.hidden; out.pressed1 = btn.getAttribute('aria-pressed');
        out.hasFoldDiagram = !!help.querySelector('svg.fold');
        btn.click();
        out.closedAgain = help.hidden && !insp.hidden;
        setHelp(true);
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        out.escapeCloses = help.hidden && !insp.hidden;
        setHelp(true);
        help.querySelector('[data-act="closeHelp"]').click();
        out.closeButton = help.hidden && !insp.hidden;
        return out;
      })()`);
      assert.eq(r.startsHidden, true, 'help must be hidden by default');
      assert.eq(r.startEmpty, true, 'and should not even be built until opened');
      assert.eq(r.inspectorShown, true);
      assert.eq(r.pressed0, 'false');
      assert.eq(r.openShown, true);
      assert.eq(r.openHasContent, true);
      assert.eq(r.inspectorHidden, true, 'help takes the place of the inspector while open');
      assert.eq(r.pressed1, 'true');
      assert.eq(r.hasFoldDiagram, true, 'the fold diagram lives in help now');
      assert.eq(r.closedAgain, true, 'the button toggles it back');
      assert.eq(r.escapeCloses, true, 'Escape closes help');
      assert.eq(r.closeButton, true, 'the Close button closes help');
    });

    t.check('the inspector holds controls and the explanations moved to help', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        const insp = document.getElementById('inspector');
        const pageText = insp.textContent;
        addText(); stopEdit();
        const textText = insp.textContent;
        setActive(0); addQr();
        const qrText = insp.textContent;
        select(null); buildInspector();
        setHelp(true);
        const help = document.getElementById('help').textContent;
        setHelp(false);
        return { pageText: pageText, textText: textText, qrText: qrText, help: help };
      })()`);
      ['Fold in half', 'Pours what', 'pours what', 'striped band', 'Print at 100%',
       'No trimming', 'nudge'].forEach(phrase => {
        assert.eq(r.pageText.indexOf(phrase) < 0, true, 'the page inspector still explains: ' + phrase);
      });
      assert.eq(r.textText.indexOf('Double-click') < 0, true, 'the text inspector still explains');
      assert.eq(r.qrText.indexOf('scan the printout') < 0, true, 'the QR inspector still explains');
      ['Double-click text to edit it', 'pours what is already on the page',
       'scan the printout once', 'striped band', 'Fold in half the long way',
       'No trimming is needed', 'Print at 100%', 'nudge'].forEach(phrase => {
        assert.ok(r.help.indexOf(phrase) >= 0, 'help is missing: ' + phrase);
      });
      assert.ok(r.pageText.indexOf('Layout') >= 0, 'the page controls themselves must stay in the inspector');
      assert.eq(r.pageText.indexOf('Printer margin') < 0, true,
        'project controls now stay behind the settings button, not mixed into the page view');
    });

    t.check('panel dimensions live in project settings, by the trim controls, not the page panel', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        select(null); setActive(0); buildInspector();
        const pageText = document.getElementById('inspector').textContent;
        setSide(true);
        const projectText = document.getElementById('inspector').textContent;
        return { pageText: pageText, projectText: projectText };
      })()`);
      assert.eq(/mm/.test(r.pageText), false, 'the page panel should no longer mention panel dimensions');
      assert.ok(/Each page prints .*mm/.test(r.projectText),
        'the printer-margin section should state the panel size, got: ' + r.projectText);
    });

    t.check('the panel dimensions in project settings track the trim setting', async () => {
      await page.reset({ margin: 10, trimMargin: false });
      const dims = t => /Each page prints ([^.]*)\./.exec(t)[1];
      const r = await page.evaluate(`(() => {
        setSide(true);
        const before = document.getElementById('inspector').textContent;
        state.trimMargin = true; paintAll();
        const after = document.getElementById('inspector').textContent;
        return { before: before, after: after };
      })()`);
      assert.ok(dims(r.before) !== dims(r.after),
        'turning trim on shrinks the panel, so the stated size should change too');
    });

    t.check('help describes the panel in front of you', async () => {
      await page.reset({ margin: 5 });
      const r = await page.evaluate(`(() => {
        setHelp(true);
        const text = () => document.getElementById('help').textContent;
        setActive(0); paintHelp(); const cover = text();
        setActive(2); paintHelp(); const inner = text();
        state.margin = 0; paintHelp(); const none = text();
        setHelp(false);
        return { cover: cover, inner: inner, none: none };
      })()`);
      assert.includes(r.cover, 'in a corner', 'the cover sits in a corner of the sheet');
      assert.includes(r.inner, 'along an edge', 'page 3 only touches one edge');
      assert.includes(r.none, 'No margin', 'and the note follows the margin setting');
    });

    t.check('dragging an element on the right-hand page moves it by the pointer delta', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(1);                          // spread 2|3, active is the left page
        const right = visiblePanels()[1];
        doc().panels[right].els.push({ id: 'drag', type: 'text', x: 20, y: 20, w: 100,
          rot: 0, text: 'grab me', font: 0, size: 12, color: '#111', align: 'left',
          lh: 1.3, ls: 0, bold: false, italic: false, bg: '', pad: 4 });
        paintAll();
        const el = doc().panels[right].els[0];
        const node = nodes.get(el.id);
        const box = node.getBoundingClientRect();
        const x0 = el.x, y0 = el.y;
        ${GESTURE}(node, box.left + 6, box.top + 6, box.left + 6 + 40, box.top + 6 + 24);
        return { dx: Math.round(el.x - x0), dy: Math.round(el.y - y0),
                 wantDx: Math.round(40 / curZoom), wantDy: Math.round(24 / curZoom),
                 activeFollowed: state.active === right, selected: selId === el.id };
      })()`);
      assert.eq(r.dx, r.wantDx, 'horizontal movement is panel-local');
      assert.eq(r.dy, r.wantDy, 'vertical movement is panel-local');
      assert.eq(r.activeFollowed, true, 'clicking a page makes it active');
      assert.eq(r.selected, true);
    });

    t.check('rotating measures the centre from the element own panel', async () => {
      // If the centre were taken from the sheet, an element on the right-hand
      // page would be out by a whole panel width and the angle would be wrong.
      await page.reset();
      const rot = await page.evaluate(`(() => {
        setActive(1);
        const right = visiblePanels()[1];
        doc().panels[right].els.push({ id: 'spin', type: 'text', x: 30, y: 60, w: 120,
          rot: 0, text: 'spin', font: 0, size: 14, color: '#111', align: 'left',
          lh: 1.3, ls: 0, bold: false, italic: false, bg: '', pad: 4 });
        setActive(right); paintAll(); select('spin');
        const el = doc().panels[right].els[0];
        const node = nodes.get('spin');
        const pr = node.parentNode.getBoundingClientRect();
        const cx = pr.left + (el.x + el.w / 2) * curZoom;
        const cy = pr.top + (el.y + node.offsetHeight / 2) * curZoom;
        const handle = node.querySelector('.h.rot');
        const hb = handle.getBoundingClientRect();
        ${GESTURE}(handle, hb.left + 5, hb.top + 5, cx + 120, cy);
        return el.rot;
      })()`);
      assert.eq(rot, 90, 'dragging the handle due east of centre should give 90 degrees');
    });

    t.check('the rotation slider has a magnetic detent at 0°', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0); addText(); stopEdit();
        buildInspector();
        const el = selected();
        const range = document.querySelector('#inspector input[type="range"][data-k="rot"]');
        const num = document.querySelector('#inspector input[type="number"][data-k="rot"]');
        range.value = 2; range.dispatchEvent(new Event('input', { bubbles: true }));
        const nearZero = { rot: el.rot, sliderValue: range.value };
        range.value = 10; range.dispatchEvent(new Event('input', { bubbles: true }));
        const away = el.rot;
        num.value = 2; num.dispatchEvent(new Event('input', { bubbles: true }));
        const numberField = el.rot;
        return { nearZero: nearZero, away: away, numberField: numberField };
      })()`);
      assert.eq(r.nearZero.rot, 0, 'a small drag near zero should snap the value to it');
      assert.eq(r.nearZero.sliderValue, '0', 'the thumb should snap too, not just the stored value');
      assert.eq(r.away, 10, 'a value well away from zero should not be pulled in');
      assert.eq(r.numberField, 2, 'the exact number field has no detent to fight');
    });

    t.check('shift locks the drag axis', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0); addText(); stopEdit();
        const el = selected(), node = nodes.get(el.id);
        const box = node.getBoundingClientRect();
        const y0 = el.y;
        ${GESTURE}(node, box.left + 5, box.top + 5, box.left + 45, box.top + 12, { shift: true });
        return { movedY: el.y - y0 };
      })()`);
      assert.eq(r.movedY, 0, 'the smaller axis should be pinned');
    });

    /* ------------------------------------------------ across the fold */

    /* A spanning element is one element, painted twice. These check the
       second copy is really a copy — same element, right offset, right panel
       — rather than anything the document has to carry twice. */
    t.check('spanning paints a second copy in the facing panel, one panel width over', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);                            // spread back|cover
        const spread = visiblePanels();          // [7, 0]
        const put = (pi, x) => {
          doc().panels[pi].els.push({ id: 'e' + pi, type: 'text', x: x, y: 40, w: 90,
            rot: 0, text: 'over the fold', font: 0, size: 12, color: '#111',
            align: 'left', lh: 1.3, ls: 0, bold: false, italic: false, bg: '', pad: 4,
            span: true });
        };
        put(spread[0], geom().panelW - 40);      // left page, reaching right
        put(spread[1], -40);                     // right page, reaching left
        paintAll();
        const g = geom();
        const where = id => {
          const gn = guestNodes.get(id);
          // Compared as numbers: the browser rounds what it echoes back.
          return { left: parseFloat(gn.style.left), panel: +gn.parentNode.dataset.pi };
        };
        return {
          count: guestNodes.size,
          fromLeft: where('e' + spread[0]),
          fromRight: where('e' + spread[1]),
          wantLeft: g.panelW - 40 - g.panelW,
          wantRight: -40 + g.panelW,
          leftPanel: spread[0], rightPanel: spread[1]
        };
      })()`);
      assert.eq(r.count, 2, 'both spanning elements should be lent to the facing page');
      assert.near(r.fromLeft.left, r.wantLeft, 0.01, 'a left-hand page reaches right, so its copy sits back a panel');
      assert.eq(r.fromLeft.panel, r.rightPanel, 'and the copy belongs to the right-hand page');
      assert.near(r.fromRight.left, r.wantRight, 0.01, 'a right-hand page reaches left, so its copy sits forward a panel');
      assert.eq(r.fromRight.panel, r.leftPanel, 'and that copy belongs to the left-hand page');
    });

    t.check('an element that does not span is clipped at the fold, with no copy', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const left = visiblePanels()[0];
        doc().panels[left].els.push({ id: 'plain', type: 'text', x: geom().panelW - 40,
          y: 40, w: 90, rot: 0, text: 'clipped', font: 0, size: 12, color: '#111',
          align: 'left', lh: 1.3, ls: 0, bold: false, italic: false, bg: '', pad: 4 });
        paintAll();
        return guestNodes.size;
      })()`);
      assert.eq(r, 0, 'only a spanning element is painted on the facing page');
    });

    t.check('the inspector toggles spanning, and undo takes it back', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0); addText(); stopEdit(); buildInspector();
        const el = selected();
        const press = v => {
          document.querySelector('#inspector [data-span="' + v + '"]').click();
          buildInspector();
        };
        press('1');
        const on = { span: el.span, copies: guestNodes.size,
                     marked: !!document.querySelector('#inspector [data-span="1"].on') };
        press('0');
        const off = { span: selected().span, copies: guestNodes.size };
        press('1');
        undo();
        return { on: on, off: off, afterUndo: !!(elById(el.id) || {}).span };
      })()`);
      assert.eq(r.on.span, true, 'pressing "Both pages" sets it');
      assert.eq(r.on.copies, 1, 'and the facing page gets the copy immediately');
      assert.eq(r.on.marked, true, 'the pressed button reads as chosen');
      assert.eq(r.off.span, undefined, 'pressing "One page" drops the flag rather than storing a false');
      assert.eq(r.off.copies, 0, 'and takes the copy away');
      assert.eq(r.afterUndo, false, 'undo puts it back the way it was');
    });

    /* The fold is not a wall: drag an element over it and it changes pages.
       Coordinates are panel-local, so the handover has to shift x by exactly
       one panel width or the element would jump. */
    t.check('dragging an element over the fold hands it to the facing page', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const spread = visiblePanels(), left = spread[0], right = spread[1];
        const g = geom();
        doc().panels[left].els.push({ id: 'cross', type: 'text', x: g.panelW - 60, y: 40,
          w: 100, rot: 0, text: 'moving in', font: 0, size: 12, color: '#111',
          align: 'left', lh: 1.3, ls: 0, bold: false, italic: false, bg: '', pad: 4 });
        setActive(left); paintAll();
        const el = doc().panels[left].els[0], node = nodes.get('cross');
        const box = node.getBoundingClientRect();
        const x0 = el.x;
        ${GESTURE}(node, box.left + 5, box.top + 5, box.left + 5 + 30 * curZoom, box.top + 5);
        return {
          onLeft: doc().panels[left].els.length, onRight: doc().panels[right].els.length,
          x: Math.round(el.x), want: Math.round(x0 + 30 - g.panelW),
          active: state.active, right: right, stillSelected: selId === 'cross'
        };
      })()`);
      assert.eq(r.onLeft, 0, 'it should have left the page it started on');
      assert.eq(r.onRight, 1, 'and arrived on the facing one');
      assert.eq(r.x, r.want, 'its x shifts by exactly one panel width');
      assert.eq(r.active, r.right, 'the page it landed on takes over as the active one');
      assert.eq(r.stillSelected, true, 'and it stays selected through the handover');
    });

    t.check('a right-hand page hands elements back the other way', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const spread = visiblePanels(), left = spread[0], right = spread[1];
        const g = geom();
        doc().panels[right].els.push({ id: 'back', type: 'text', x: 10, y: 40, w: 100,
          rot: 0, text: 'moving out', font: 0, size: 12, color: '#111', align: 'left',
          lh: 1.3, ls: 0, bold: false, italic: false, bg: '', pad: 4 });
        setActive(right); paintAll();
        const el = doc().panels[right].els[0], node = nodes.get('back');
        const box = node.getBoundingClientRect();
        const x0 = el.x;
        ${GESTURE}(node, box.left + 5, box.top + 5, box.left + 5 - 80 * curZoom, box.top + 5);
        return {
          onLeft: doc().panels[left].els.length, onRight: doc().panels[right].els.length,
          x: Math.round(el.x), want: Math.round(x0 - 80 + g.panelW), active: state.active, left: left
        };
      })()`);
      assert.eq(r.onRight, 0, 'it should have left the right-hand page');
      assert.eq(r.onLeft, 1, 'and arrived on the left-hand one');
      assert.eq(r.x, r.want, 'its x shifts back by exactly one panel width');
      assert.eq(r.active, r.left, 'the page it landed on takes over');
    });

    t.check('an element dragged short of the fold stays where it is', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const left = visiblePanels()[0], g = geom();
        doc().panels[left].els.push({ id: 'stay', type: 'text', x: g.panelW - 60, y: 40,
          w: 100, rot: 0, text: 'not yet', font: 0, size: 12, color: '#111',
          align: 'left', lh: 1.3, ls: 0, bold: false, italic: false, bg: '', pad: 4 });
        setActive(left); paintAll();
        const node = nodes.get('stay');
        const box = node.getBoundingClientRect();
        // Centre still short of the fold: 10pt is not enough to carry it over.
        ${GESTURE}(node, box.left + 5, box.top + 5, box.left + 5 + 5 * curZoom, box.top + 5);
        return { onLeft: doc().panels[left].els.length, active: state.active, left: left };
      })()`);
      assert.eq(r.onLeft, 1, 'ownership follows the centre, and the centre has not crossed');
      assert.eq(r.active, r.left, 'so the active page does not change either');
    });

    t.check('an element dropped across the fold runs onto both pages', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const spread = visiblePanels(), left = spread[0], right = spread[1], g = geom();
        // Wholly on the left-hand page, its right edge 20pt short of the fold.
        doc().panels[left].els.push({ id: 'drop', type: 'image', src: ${pngDataUrl('#3060c0')},
          x: Math.round(g.panelW - 120), y: 60, w: 100, h: 60, rot: 0 });
        setActive(left); paintAll();
        const node = nodes.get('drop'), box = node.getBoundingClientRect();
        // 60pt right: over the fold by 40, centre still 10 short of it.
        ${GESTURE}(node, box.left + 5, box.top + 5, box.left + 5 + 60 * curZoom, box.top + 5);
        const el = doc().panels[left].els[0];
        const gn = guestNodes.get('drop');
        const out = { owner: el && el.id, span: !!(el && el.span),
                      copyOn: gn ? +gn.parentNode.dataset.pi : null, right: right,
                      button: document.querySelector('#inspector [data-span="1"]').classList.contains('on') };
        undo();
        out.undone = !doc().panels[left].els[0].span;
        return out;
      })()`);
      assert.eq(r.owner, 'drop', 'its centre has not crossed, so it stays on the left-hand page');
      assert.eq(r.span, true, 'left reaching over the fold, it spans rather than being cut off there');
      assert.eq(r.copyOn, r.right, 'and the facing page paints the rest of it');
      assert.eq(r.button, true, 'the inspector shows Both pages straight away');
      assert.eq(r.undone, true, 'one undo puts the drag and the spanning back together');
    });

    t.check('stretching an element over the fold runs it onto both pages, even mid-stretch', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const spread = visiblePanels(), left = spread[0], g = geom();
        doc().panels[left].els.push({ id: 'grow', type: 'image', src: ${pngDataUrl('#c03060')},
          x: Math.round(g.panelW - 120), y: 60, w: 100, h: 60, rot: 0 });
        setActive(left); paintAll(); select('grow');
        const h = nodes.get('grow').querySelector('.h.se'), box = h.getBoundingClientRect();
        const x0 = box.left + box.width / 2, y0 = box.top + box.height / 2;
        const ev = (t, el, x) => el.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y0,
          button: 0, buttons: t === 'pointerup' ? 0 : 1, bubbles: true }));
        ev('pointerdown', h, x0);
        ev('pointermove', window, x0 + 80 * curZoom);
        const mid = guestNodes.has('grow');
        ev('pointerup', window, x0 + 80 * curZoom);
        const el = doc().panels[left].els[0];
        return { w: el.w, span: !!el.span, mid: mid, after: guestNodes.has('grow') };
      })()`);
      assert.eq(r.w, 180, 'the handle stretched it by the pointer delta');
      assert.eq(r.mid, true, 'it is not chopped at the fold while it is being stretched');
      assert.eq(r.span, true, 'and once it reaches over, it spans');
      assert.eq(r.after, true, 'so the facing half stays after letting go');
    });

    t.check('an element already stopped at the fold stays stopped through a nudge', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const left = visiblePanels()[0], g = geom();
        // Straddling the fold with One page: clipped there on purpose.
        doc().panels[left].els.push({ id: 'clip', type: 'text', x: g.panelW - 60, y: 40,
          w: 100, rot: 0, text: 'cropped', font: 0, size: 12, color: '#111',
          align: 'left', lh: 1.3, ls: 0, bold: false, italic: false, bg: '', pad: 4 });
        setActive(left); paintAll();
        const node = nodes.get('clip'), box = node.getBoundingClientRect();
        ${GESTURE}(node, box.left + 5, box.top + 5, box.left + 5 + 4 * curZoom, box.top + 5 + 10 * curZoom);
        const el = doc().panels[left].els[0];
        return { moved: Math.round(el.y), span: 'span' in el, copy: guestNodes.has('clip') };
      })()`);
      assert.eq(r.moved, 50, 'the nudge happened');
      assert.eq(r.span, false, 'but a choice of One page made while it straddles is kept');
      assert.eq(r.copy, false, 'so nothing is painted across the fold');
    });

    t.check('what counts as reaching over the fold allows for rotation, not a flush edge', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const spread = visiblePanels(), left = spread[0], right = spread[1], g = geom();
        const box = (x, rot) => ({ id: 'f', type: 'image', src: '', x: x, y: 60, w: 100, h: 100, rot: rot });
        return {
          flush: overFold(box(g.panelW - 100, 0), left),
          over: overFold(box(g.panelW - 98, 0), left),
          turned: overFold(box(g.panelW - 110, 45), left),   // a corner swings 20pt over
          rightFlush: overFold(box(0, 0), right),
          rightOver: overFold(box(-2, 0), right)
        };
      })()`);
      assert.eq(r.flush, false, 'an edge snapped exactly to the fold is not over it');
      assert.eq(r.over, true, 'two points past it is');
      assert.eq(r.turned, true, 'a corner rotated over the fold counts');
      assert.eq(r.rightFlush, false, 'the same holds for a right-hand page');
      assert.eq(r.rightOver, true, 'reaching backwards');
    });

    t.check('Both pages on text still being typed in paints the other half at once', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(5);
        addText();                                 // a new text box starts out being typed in
        const el = selected();
        el.x = Math.round(geom().panelW - 60); restyle(el);
        document.querySelector('#inspector [data-span="1"]').click();
        const gn = guestNodes.get(el.id);
        const body = nodes.get(el.id).querySelector('.body');
        body.textContent = 'still typing';
        body.dispatchEvent(new Event('input'));
        const out = { editing: editingId === el.id, copyOn: gn ? +gn.parentNode.dataset.pi : null,
                      copyText: gn ? gn.querySelector('.body').textContent : null,
                      sameNode: nodes.get(el.id).querySelector('.body') === body };
        document.querySelector('#inspector [data-span="0"]').click();
        out.copyGone = !guestNodes.has(el.id) && !document.querySelector('#sheet .guest');
        stopEdit();
        return out;
      })()`);
      assert.eq(r.editing, true, 'the caret is left where it was');
      assert.eq(r.sameNode, true, 'and the box being typed in is not rebuilt under it');
      assert.eq(r.copyOn, 6, 'the half across the fold appears on the facing page right away');
      assert.eq(r.copyText, 'still typing', 'and keeps up with the typing');
      assert.eq(r.copyGone, true, 'One page takes the copy away again, still mid-edit');
    });

    t.check('an element still cannot be dragged off the far side of the spread', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const left = visiblePanels()[0];
        doc().panels[left].els.push({ id: 'far', type: 'text', x: 30, y: 40, w: 100,
          rot: 0, text: 'runaway', font: 0, size: 12, color: '#111', align: 'left',
          lh: 1.3, ls: 0, bold: false, italic: false, bg: '', pad: 4 });
        setActive(left); paintAll();
        const el = doc().panels[left].els[0], node = nodes.get('far');
        const box = node.getBoundingClientRect();
        ${GESTURE}(node, box.left + 5, box.top + 5, box.left - 4000, box.top - 4000);
        return { x: el.x, y: el.y, minX: 20 - el.w,
                 stillHome: doc().panels[left].els.length };
      })()`);
      assert.ok(r.x >= r.minX, 'x ran off the outer edge to ' + r.x);
      assert.ok(r.y > -1000, 'y ran away to ' + r.y);
      assert.eq(r.stillHome, 1, 'there is no page out that way to hand it to');
    });

    t.check('grabbing the borrowed half selects the element on its own page', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const spread = visiblePanels(), left = spread[0];
        doc().panels[left].els.push({ id: 'reach', type: 'text', x: geom().panelW - 30,
          y: 40, w: 120, rot: 0, text: 'reaching', font: 0, size: 12, color: '#111',
          align: 'left', lh: 1.3, ls: 0, bold: false, italic: false, bg: '', pad: 4,
          span: true });
        setActive(left); paintAll(); select(null);
        const gn = guestNodes.get('reach');
        const box = gn.getBoundingClientRect();
        gn.dispatchEvent(new PointerEvent('pointerdown', { clientX: box.left + 4,
          clientY: box.top + 4, button: 0, buttons: 1, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
        return { selected: selId, owner: doc().panels[left].els.length,
                 handles: !!nodes.get('reach') };
      })()`);
      assert.eq(r.selected, 'reach', 'the copy answers for the element it is a copy of');
      assert.eq(r.owner, 1, 'and grabbing it does not move the element anywhere');
      assert.eq(r.handles, true, 'the handles stay on its own page');
    });

    t.check('typing in a spanning text box updates the half across the fold', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const left = visiblePanels()[0];
        doc().panels[left].els.push({ id: 'say', type: 'text', x: geom().panelW - 30,
          y: 40, w: 140, rot: 0, text: 'before', font: 0, size: 12, color: '#111',
          align: 'left', lh: 1.3, ls: 0, bold: false, italic: false, bg: '', pad: 4,
          span: true });
        setActive(left); paintAll();
        startEdit('say', true);
        const body = nodes.get('say').querySelector('.body');
        body.textContent = 'after the fold';
        body.dispatchEvent(new Event('input', { bubbles: true }));
        return { stored: elById('say').text,
                 copy: guestNodes.get('say').querySelector('.body').textContent };
      })()`);
      assert.eq(r.stored, 'after the fold', 'the element itself keeps the text');
      assert.eq(r.copy, 'after the fold',
        'and the copy is told by hand, since the caret stops the sheet rebuilding');
    });

    t.check('clicking the blank stage clears the selection', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(1); addText(); stopEdit();
        const selBefore = selected() && selected().id;
        const stage = document.getElementById('stage');
        const sheet = document.querySelector('.sheet-box').getBoundingClientRect();
        stage.dispatchEvent(new MouseEvent('click', {
          clientX: stage.getBoundingClientRect().left + 5,
          clientY: sheet.top + sheet.height / 2, bubbles: true
        }));
        return { selBefore: selBefore, selAfter: selected() };
      })()`);
      assert.ok(r.selBefore, 'a text element should have been selected first');
      assert.eq(r.selAfter, null, 'clicking the blank stage should clear the selection');
    });

    t.check("clicking a page label deselects, even the active page's own", async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0); addText(); stopEdit();
        const before = selected() && selected().id;
        // the active page's own label: same page, so setActive() alone is a no-op
        document.querySelector('#sheetLabels span.on').click();
        const afterSame = selected();

        addText(); stopEdit();
        const beforeOther = selected() && selected().id;
        const other = [...document.querySelectorAll('#sheetLabels span')]
          .find(s => !s.classList.contains('on'));
        other.click();

        return { before: before, afterSame: afterSame, beforeOther: beforeOther, afterOther: selected() };
      })()`);
      assert.ok(r.before, 'a text element should have been selected first');
      assert.eq(r.afterSame, null, "clicking the active page's own label should still deselect");
      assert.ok(r.beforeOther, 'a second text element should have been selected');
      assert.eq(r.afterOther, null, 'clicking another page\'s label should deselect too');
    });

    t.check('the image effect picker shows a live preview per filter, not a plain dropdown', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        const px = ${pngDataUrl('#3498db')};
        panel().els.push({ id: 'i1', type: 'image', x: 0, y: 0, w: 40, h: 40, rot: 0,
          src: px, fit: 'cover', filter: 'none', opacity: 1, radius: 0 });
        selId = 'i1';
        buildInspector();
        const el = selected();
        const swatches = [...document.querySelectorAll('#inspector .filter-grid .swatch')];
        const before = swatches.map(s => ({
          v: s.dataset.v, on: s.classList.contains('on'),
          src: s.querySelector('img').getAttribute('src'),
          imgClass: s.querySelector('img').className
        }));
        swatches.find(s => s.dataset.v === 'ink').click();
        return {
          count: before.length,
          allShowThePhoto: before.every(s => s.src === px),
          filterClassesMatch: before.every(s => s.imgClass === (s.v === 'none' ? '' : 'f-' + s.v)),
          noneWasOn: before.find(s => s.v === 'none').on,
          filterAfterClick: el.filter,
          inkNowOn: document.querySelector('#inspector .swatch[data-v="ink"]').classList.contains('on'),
          noneNowOff: !document.querySelector('#inspector .swatch[data-v="none"]').classList.contains('on')
        };
      })()`);
      assert.eq(r.count, 5, 'one swatch per filter');
      assert.eq(r.allShowThePhoto, true, 'every swatch should preview the actual selected photo');
      assert.eq(r.filterClassesMatch, true, 'each swatch should carry its own filter class, not a shared one');
      assert.eq(r.noneWasOn, true, 'the starting filter should be marked current');
      assert.eq(r.filterAfterClick, 'ink', 'clicking a swatch should apply that filter');
      assert.eq(r.inkNowOn, true, 'the clicked swatch should become the marked one');
      assert.eq(r.noneNowOff, true, 'the old current swatch should lose the mark');
    });

    t.check('the font picker shows each name set in its own font', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0); addText(); stopEdit();
        buildInspector();
        return [...document.querySelectorAll('#inspector select[data-k="font"] option')]
          .map(o => getComputedStyle(o).fontFamily);
      })()`);
      assert.eq(r.length, 8, 'one option per font');
      assert.ok(r[1].toLowerCase().includes('georgia'), 'Serif option should render in Georgia, got ' + r[1]);
      assert.ok(r[3].toLowerCase().includes('impact'), 'Impact option should render in Impact, got ' + r[3]);
      assert.ok(r[4].toLowerCase().includes('arial black'),
        'Heavy option should render in Arial Black, got ' + r[4] +
        ' (a quoted family name breaking the style attribute would truncate this)');
      assert.ok(new Set(r).size > 1, 'options should not all fall back to one shared font');
    });

    t.check('a QR element renders, stays square and grows with its payload', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0); addQr();
        const el = selected(), node = nodes.get(el.id);
        const small = node.querySelector('svg.body').getAttribute('viewBox');
        el.text = 'https://example.com/a-considerably-longer-address-than-before';
        styleNode(node, el);
        const big = node.querySelector('svg.body').getAttribute('viewBox');
        el.w = 140; styleNode(node, el);
        const square = el.h === 140;
        el.text = 'z'.repeat(400); styleNode(node, el);
        const overflow = !!node.querySelector('svg.body text');
        return { small: small, big: big, square: square, overflow: overflow,
                 hasPath: !!node.querySelector('svg.body path') };
      })()`);
      assert.eq(r.small, '0 0 33 33', 'a short URL is version 2 plus a 4 module quiet zone');
      assert.ok(r.big !== r.small, 'more data should need a bigger symbol');
      assert.eq(r.square, true, 'height follows width');
      assert.eq(r.overflow, true, 'an oversized payload shows a marker rather than failing silently');
    });

    t.check('a template pours existing content into its slots', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(2);
        const px = ${pngDataUrl('#3498db')};
        const g = geom();
        ['i1', 'i2'].forEach(id => panel().els.push({ id: id, type: 'image', x: 0, y: 0,
          w: 40, h: 40, rot: 0, src: px, fit: 'cover', filter: 'none', opacity: 1, radius: 0 }));
        panel().els.push({ id: 't1', type: 'text', x: 0, y: 0, w: 40, rot: 0, text: 'mine',
          font: 0, size: 9, color: '#111', align: 'left', lh: 1.3, ls: 0,
          bold: false, italic: false, bg: '', pad: 4 });
        panel().els.push({ id: 'spare', type: 'text', x: 7, y: 9, w: 30, rot: 0, text: 'left over',
          font: 0, size: 8, color: '#111', align: 'left', lh: 1.3, ls: 0,
          bold: false, italic: false, bg: '', pad: 4 });
        const before = panel().els.map(e => e.id).sort().join(',');
        applyTemplate(TEMPLATES.find(x => x.n === 'Stacked'));
        const els = panel().els, img = els.find(e => e.id === 'i1');
        const spare = els.find(e => e.id === 'spare');
        return {
          kept: els.map(e => e.id).sort().join(',') === before,
          reused: els.filter(e => e.type === 'image').length,
          placed: img.x === Math.round(.08 * g.panelW) && img.y === Math.round(.07 * g.panelH) &&
                  img.w === Math.round(.84 * g.panelW) && img.h === Math.round(.35 * g.panelH),
          spareUntouched: spare.x === 7 && spare.y === 9
        };
      })()`);
      assert.eq(r.kept, true, 'nothing may be destroyed by a layout');
      assert.eq(r.reused, 2, 'existing photos should fill the photo slots');
      assert.eq(r.placed, true, 'slot geometry comes from the panel fractions');
      assert.eq(r.spareUntouched, true, 'content with no slot stays where it was');
    });

    t.check('a template with nothing to pour leaves empty photo frames and placeholder text', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(4);
        applyTemplate(TEMPLATES.find(x => x.n === 'Four up'));
        const imgs = panel().els.filter(e => e.type === 'image');
        const a = { frames: imgs.length, allEmpty: imgs.every(e => e.src === ''),
                    texts: panel().els.filter(e => e.type === 'text').length,
                    drawn: document.querySelectorAll('.el.empty .frame-hint').length };
        // applying again reuses the frames rather than stacking more
        applyTemplate(TEMPLATES.find(x => x.n === 'Stacked'));
        a.reused = panel().els.filter(e => e.type === 'image').length;
        setActive(7);
        applyTemplate(TEMPLATES.find(x => x.n === 'Back + QR'));
        const qr = panel().els.find(e => e.type === 'qr');
        a.madeQr = !!qr && qr.w === qr.h;
        return a;
      })()`);
      assert.eq(r.frames, 4, 'each photo slot gets a frame to fill');
      assert.eq(r.allEmpty, true, 'and the frames carry no invented image');
      assert.eq(r.drawn, 4, 'each is drawn with its "Add photo" prompt on screen');
      assert.eq(r.texts, 1);
      assert.eq(r.reused, 4, 'a second layout pours the same frames, leaving the spares in place');
      assert.eq(r.madeQr, true);
    });

    /* A wide layout is measured from the left-hand page's left edge, so the
       same table has to land correctly whichever half of the spread is
       active — on a right-hand page everything shifts back by a panel. */
    t.check('a wide layout fills the spread from either half of it', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        const i = TEMPLATES.findIndex(t => t.spread);
        const g = geom();
        const px = ${pngDataUrl('#336699')};
        const run = pi => {
          setActive(pi);
          panel().els = [{ id: 'photo' + pi, type: 'image', x: 0, y: 0, w: 40, h: 40,
            rot: 0, src: px, fit: 'cover', filter: 'none', opacity: 1, radius: 0 }];
          applyTemplate(TEMPLATES[i]);
          const el = doc().panels[pi].els[0];
          return { x: Math.round(el.x), w: Math.round(el.w), span: !!el.span };
        };
        const spread = SPREADS[0];                 // [7, 0]: back then cover
        const left = run(spread[0]), right = run(spread[1]);
        // and a one-page layout puts it back
        setActive(spread[0]);
        applyTemplate(TEMPLATES.find(t => !t.spread && t.slots.some(s => s.t === 'image')));
        return { left: left, right: right, panelW: Math.round(g.panelW),
                 twoPanels: Math.round(g.panelW * 2),
                 afterPlain: !!doc().panels[spread[0]].els[0].span };
      })()`);
      assert.eq(r.left.span, true, 'a wide layout spans');
      assert.eq(r.left.w, r.twoPanels, 'and is two panels wide');
      assert.eq(r.left.x, 0, 'from a left-hand page it starts at that page own edge');
      assert.eq(r.right.x, -r.panelW, 'from a right-hand page it starts a panel back');
      assert.eq(r.right.w, r.twoPanels, 'the same two panels either way');
      assert.eq(r.afterPlain, false, 'a one-page layout takes the spanning back off');
    });

    t.check('every template applies cleanly to every panel', async () => {
      await page.reset();
      const err = await page.evaluate(`(() => {
        for (let i = 0; i < 8; i++) {
          setActive(i);
          for (const tpl of TEMPLATES) {
            try { applyTemplate(tpl); }
            catch (e) { return tpl.n + ' on panel ' + i + ': ' + e.message; }
          }
        }
        return '';
      })()`);
      assert.eq(err, '');
    });

    t.check('undo and redo walk the document back and forward', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(0);
        addText(); stopEdit();
        addText(); stopEdit();
        const two = panel().els.length;
        undo();
        const afterUndo = panel().els.length;
        redo();
        const afterRedo = panel().els.length;
        return { two: two, afterUndo: afterUndo, afterRedo: afterRedo };
      })()`);
      assert.eq(r.two, 2);
      assert.eq(r.afterUndo, 1, 'undo should remove the second text box');
      assert.eq(r.afterRedo, 2, 'redo should put it back');
    });

    t.check('deleting and duplicating act on the selection own panel', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        setActive(1);
        const right = visiblePanels()[1];
        doc().panels[right].els.push({ id: 'z', type: 'text', x: 10, y: 10, w: 80, rot: 0,
          text: 'x', font: 0, size: 10, color: '#111', align: 'left', lh: 1.3, ls: 0,
          bold: false, italic: false, bg: '', pad: 4 });
        paintAll(); select('z');
        duplicateSel();
        const afterDup = doc().panels[right].els.length;
        const leftUntouched = doc().panels[visiblePanels()[0]].els.length;
        removeSel();
        return { afterDup: afterDup, leftUntouched: leftUntouched,
                 afterDelete: doc().panels[right].els.length };
      })()`);
      assert.eq(r.afterDup, 2, 'duplicate should land on the same page as the original');
      assert.eq(r.leftUntouched, 0, 'the facing page must not be touched');
      assert.eq(r.afterDelete, 1);
    });

    t.check('state survives a save and reload from browser storage', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        setActive(5); addText(); stopEdit();
        selected().text = 'persisted';
        state.title = 'stored zine'; state.margin = 8; state.guides = true;
        save();
        await new Promise(res => setTimeout(res, 400));
        const raw = JSON.parse(localStorage.getItem('zinemaker.v1'));
        return { title: raw.title, margin: raw.margin, guides: raw.guides,
                 text: raw.docs.mini.panels[5].els[0].text };
      })()`);
      assert.eq(r.title, 'stored zine');
      assert.eq(r.margin, 8);
      assert.eq(r.guides, true);
      assert.eq(r.text, 'persisted');
    });

    t.check('image bytes move to IndexedDB, keeping localStorage free of the data URL', async () => {
      await page.reset();
      await page.evaluate(`(async () => {
        const c = document.createElement('canvas');
        c.width = 40; c.height = 30;
        const x = c.getContext('2d');
        x.fillStyle = '#2ecc71'; x.fillRect(0, 0, 40, 30);
        const blob = await new Promise(res => c.toBlob(res, 'image/png'));
        setActive(4);
        await addImageFiles([new File([blob], 'leaf.png', { type: 'image/png' })]);
        save();
        await new Promise(res => setTimeout(res, 500));
      })()`);
      const before = await page.evaluate(`(() => {
        const raw = localStorage.getItem('zinemaker.v1');
        const el = doc().panels[4].els.find(e => e.type === 'image');
        return { rawHasDataUrl: raw.indexOf('data:image') >= 0, hasAssetId: !!el.assetId };
      })()`);
      assert.eq(before.rawHasDataUrl, false, 'localStorage should hold an assetId, not the image bytes');
      assert.eq(before.hasAssetId, true, 'the element should pick up an assetId once it is saved');

      await page.reload();
      const after = await page.evaluate(`(async () => {
        const el = doc().panels[4].els.find(e => e.type === 'image');
        const probe = new Image();
        await new Promise((res, rej) => { probe.onload = res; probe.onerror = rej; probe.src = el.src; });
        const c = document.createElement('canvas');
        c.width = probe.width; c.height = probe.height;
        c.getContext('2d').drawImage(probe, 0, 0);
        const px = c.getContext('2d').getImageData(0, 0, 1, 1).data;
        return { isData: /^data:image\\//.test(el.src), pixel: [px[0], px[1], px[2]] };
      })()`);
      assert.eq(after.isData, true, 'IndexedDB should hand back a data URL after reload');
      assert.deepEq(after.pixel, [46, 204, 113], 'the pixels should survive the round trip through IndexedDB');
    });

    t.check('"Start over" clears the title along with the document', async () => {
      await page.reset();
      const r = await page.evaluate(`(() => {
        $('#title').value = 'my great zine'; state.title = 'my great zine';
        setActive(2); addText(); stopEdit();
        document.querySelector('#newZine').click();
        return { stateTitle: state.title, inputValue: $('#title').value,
                 panelEmpty: doc().panels[2].els.length === 0 };
      })()`);
      assert.eq(r.stateTitle, 'untitled zine');
      assert.eq(r.inputValue, 'untitled zine', 'the title field should reset along with state.title');
      assert.eq(r.panelEmpty, true);
    });

  }
};
