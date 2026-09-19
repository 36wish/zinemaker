/* The phone layout. Everything here is measured against an emulated handset
   rather than assumed from the stylesheet, because the failures that matter
   are geometric: controls off the screen, a sheet taller than the stage, a
   toolbar that eats the page. The suite puts the viewport back afterwards,
   since every browser suite shares the one window. */

'use strict';

const { assert } = require('./harness');

const PHONE = [390, 740];

/* The runner hands the shared window to collect(); teardown needs it too. */
let page = null;

/* Touch gestures carry a pointerType, which is what tells the app a tap is a
   tap; the mouse gestures in the editor suite deliberately do not. */
const TAP = `(function (target, x, y, ms) {
  const ev = t => target.dispatchEvent(new PointerEvent(t, {
    clientX: x, clientY: y, button: 0, buttons: t === 'pointerup' ? 0 : 1,
    pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true
  }));
  ev('pointerdown'); ev('pointerup');
})`;

const TOUCH_DRAG = `(function (target, x0, y0, x1, y1) {
  const ev = (t, el, x, y) => el.dispatchEvent(new PointerEvent(t, {
    clientX: x, clientY: y, button: 0, buttons: t === 'pointerup' ? 0 : 1,
    pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true
  }));
  ev('pointerdown', target, x0, y0);
  ev('pointermove', window, x1, y1);
  ev('pointerup', window, x1, y1);
})`;

/* The sheet slides, so let the transition land before measuring it. */
const settle = () => new Promise(r => setTimeout(r, 280));

module.exports = {
  name: 'Phone layout',
  browser: true,

  collect(t) {
    page = t.page;

    /* Box of an element, in viewport coordinates. */
    const rect = sel => page.evaluate(`(() => {
      const r = document.querySelector('${sel}').getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom),
               left: Math.round(r.left), right: Math.round(r.right),
               w: Math.round(r.width), h: Math.round(r.height) };
    })()`);

    const phone = async over => {
      await page.reset(over);
      await page.emulate(PHONE[0], PHONE[1]);
      await settle();
    };

    t.check('a handset gets the narrow layout and a coarse pointer', async () => {
      await phone();
      const r = await page.evaluate(`({
        narrow: narrow(),
        coarse: matchMedia('(pointer: coarse)').matches,
        sideShown: getComputedStyle(document.getElementById('side')).display,
        toggleShown: getComputedStyle(document.getElementById('panelBtn')).display,
        helpShown: getComputedStyle(document.getElementById('helpBtn')).display
      })`);
      assert.eq(r.narrow, true);
      assert.eq(r.coarse, true, 'touch emulation should make the pointer coarse');
      assert.ok(r.sideShown !== 'none', 'the controls must not be thrown away on a phone');
      assert.ok(r.toggleShown !== 'none', 'the toggle for them has to be reachable');
      assert.ok(r.helpShown !== 'none', 'help is reachable on a phone too');
    });

    t.check('the inspector waits off screen and slides up when asked for', async () => {
      await phone();
      const shut = await rect('#side');
      assert.ok(shut.top >= 740, 'the sheet must start clear of the viewport, got ' + shut.top);

      await page.evaluate("document.getElementById('panelBtn').click()");
      await settle();
      const open = await rect('#side');
      assert.near(open.bottom, 740, 1, 'an open sheet sits on the bottom edge');
      assert.ok(open.top > 105 && open.top < 740, 'and leaves the stage visible above it');
      assert.ok(await page.evaluate("document.getElementById('inspector').children.length > 0"),
        'the sheet holds the real inspector');

      await page.evaluate("document.getElementById('sideClose').click()");
      await settle();
      assert.ok((await rect('#side')).top >= 740, 'the close button puts it back');
      assert.eq(await page.evaluate('sideOpen'), false);
    });

    t.check('help opens the sheet, because it has nowhere else to appear', async () => {
      await phone();
      await page.evaluate("document.getElementById('helpBtn').click()");
      await settle();
      const r = await rect('#side');
      assert.near(r.bottom, 740, 1, 'asking for help must bring the sheet up');
      assert.ok(await page.evaluate("!document.getElementById('help').hidden"));
      await page.evaluate("setHelp(false); setSide(false);");
      await settle();
    });

    t.check('nothing overflows the width, and the toolbar leaves the stage room', async () => {
      await phone();
      const r = await page.evaluate(`({
        scrollW: document.documentElement.scrollWidth,
        inner: innerWidth,
        barH: Math.round(document.querySelector('.bar').getBoundingClientRect().height),
        stripFits: document.getElementById('strip').scrollWidth <= innerWidth,
        smallest: Math.min.apply(null, [...document.querySelectorAll('.bar button')]
          .filter(b => b.offsetWidth)                 // the export menu is shut
          .map(b => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height)))
      })`);
      assert.eq(r.scrollW <= r.inner, true, 'the page scrolls sideways: ' + r.scrollW);
      assert.ok(r.barH <= 120, 'the toolbar takes ' + r.barH + 'px of a 740px screen');
      assert.eq(r.stripFits, true, 'all eight thumbnails should fit without scrolling');
      assert.ok(r.smallest >= 35, 'a toolbar button is only ' + r.smallest + 'px across');
    });

    t.check('the whole spread fits on the screen at once', async () => {
      await phone();
      const stage = await page.evaluate(`({
        w: document.getElementById('stage').clientWidth,
        h: document.getElementById('stage').clientHeight,
        scrollH: document.getElementById('stage').scrollHeight
      })`);
      const box = await rect('#sheetBox');
      assert.ok(box.w <= stage.w, 'the sheet is wider than the stage: ' + box.w + ' > ' + stage.w);
      assert.ok(stage.scrollH <= stage.h + 1,
        'the stage scrolls vertically: ' + stage.scrollH + ' > ' + stage.h);
      assert.ok(box.w > stage.w * 0.8, 'the sheet should use the width it has, got ' + box.w);
    });

    t.check('a landscape handset still fits the spread', async () => {
      await page.reset();
      await page.emulate(740, 390);
      await settle();
      const stage = await page.evaluate(`({
        h: document.getElementById('stage').clientHeight,
        scrollH: document.getElementById('stage').scrollHeight
      })`);
      assert.ok(stage.scrollH <= stage.h + 1,
        'the stage scrolls: ' + stage.scrollH + ' > ' + stage.h);
      await page.emulate(PHONE[0], PHONE[1]);
    });

    t.check('an element is dragged by a finger, not scrolled past', async () => {
      await phone();
      const r = await page.evaluate(`(() => {
        setActive(1); addText(); stopEdit();
        const el = selected(), node = nodes.get(el.id);
        const before = { x: el.x, y: el.y };
        const touchAction = getComputedStyle(node).touchAction;
        const r = node.getBoundingClientRect();
        ${TOUCH_DRAG}(node, r.left + 8, r.top + 8, r.left + 48, r.top + 38);
        return { touchAction: touchAction, before: before, after: { x: el.x, y: el.y } };
      })()`);
      assert.eq(r.touchAction, 'none',
        'the browser would claim the gesture for scrolling first');
      assert.ok(r.after.x > r.before.x && r.after.y > r.before.y,
        'the element did not follow the finger: ' + JSON.stringify(r.after));
    });

    t.check('a double tap opens text for editing', async () => {
      await phone();
      const r = await page.evaluate(`(() => {
        setActive(1); addText(); stopEdit();
        const el = selected(), node = nodes.get(el.id);
        const r = node.getBoundingClientRect();
        const x = r.left + 8, y = r.top + 8;
        ${TAP}(node, x, y);
        const afterOne = editingId;
        ${TAP}(node, x, y);
        const afterTwo = editingId;
        stopEdit();
        return { id: el.id, afterOne: afterOne, afterTwo: afterTwo };
      })()`);
      assert.eq(r.afterOne, null, 'one tap only selects');
      assert.eq(r.afterTwo, r.id, 'the second tap should start editing');
    });

    t.check('a tap after a drag is not half a double tap', async () => {
      await phone();
      const r = await page.evaluate(`(() => {
        setActive(1); addText(); stopEdit();
        const el = selected(), node = nodes.get(el.id);
        const r = node.getBoundingClientRect();
        ${TOUCH_DRAG}(node, r.left + 8, r.top + 8, r.left + 40, r.top + 30);
        const b = node.getBoundingClientRect();
        ${TAP}(node, b.left + 8, b.top + 8);
        return editingId;
      })()`);
      assert.eq(r, null, 'dragging then tapping must not drop into the text');
    });

    t.check('the toggle flags a selection while the controls are hidden', async () => {
      await phone();
      const r = await page.evaluate(`(() => {
        const btn = document.getElementById('panelBtn');
        setActive(1); addText(); stopEdit();
        const withSel = btn.classList.contains('hot');
        setSide(true);
        const whileOpen = btn.classList.contains('hot');
        setSide(false); select(null);
        return { withSel: withSel, whileOpen: whileOpen, empty: btn.classList.contains('hot') };
      })()`);
      assert.eq(r.withSel, true, 'picking something up should point at the controls');
      assert.eq(r.whileOpen, false, 'with the sheet open the hint is noise');
      assert.eq(r.empty, false);
    });

    t.check('the desktop layout comes back on a wide window', async () => {
      await page.unemulate();
      await settle();
      const r = await page.evaluate(`(() => {
        const side = document.getElementById('side').getBoundingClientRect();
        return { narrow: narrow(), sideRight: Math.round(side.right),
                 inner: innerWidth, sideTop: Math.round(side.top),
                 toggle: getComputedStyle(document.getElementById('panelBtn')).display };
      })()`);
      assert.eq(r.narrow, false);
      assert.eq(r.toggle, 'none', 'the toggle belongs to the phone layout only');
      assert.near(r.sideRight, r.inner, 2, 'the inspector is a column again');
      assert.ok(r.sideTop < 200, 'and runs the height of the window');
    });
  },

  /* Whatever happened above, hand the shared window back as it was found. */
  async teardown() {
    if (page) await page.unemulate();
  }
};
