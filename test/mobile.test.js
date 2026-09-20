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

    t.check('title, paper size and the file buttons move into the settings sheet', async () => {
      await phone();
      const r = await page.evaluate(`(() => ({
        inBarBefore: !!document.querySelector('.bar #title, .bar #paper, .bar #openZine, .bar #saveZine'),
        title: document.getElementById('slotTitle').contains(document.getElementById('title')),
        paper: document.getElementById('slotPaper').contains(document.getElementById('paper')),
        open: document.getElementById('slotOpen').contains(document.getElementById('openZine')),
        save: document.getElementById('slotSave').contains(document.getElementById('saveZine'))
      }))()`);
      assert.eq(r.inBarBefore, false, 'the toolbar should not still hold them');
      assert.eq(r.title, true, 'the title input should be in its slot');
      assert.eq(r.paper, true, 'the paper select should be in its slot');
      assert.eq(r.open, true, 'the open button should be in its slot');
      assert.eq(r.save, true, 'the save button should be in its slot');
    });

    t.check('the moved title and paper controls still drive real state', async () => {
      await phone();
      const r = await page.evaluate(`(() => {
        const t = document.getElementById('title');
        t.value = 'Phone Edited';
        t.dispatchEvent(new Event('input', { bubbles: true }));
        const p = document.getElementById('paper');
        p.value = 'letter';
        p.dispatchEvent(new Event('change', { bubbles: true }));
        return { title: state.title, paper: state.paper };
      })()`);
      assert.eq(r.title, 'Phone Edited', 'the relocated title input should still update state');
      assert.eq(r.paper, 'letter', 'the relocated paper select should still update state');
    });

    t.check('help hides the document group without moving its controls back out', async () => {
      await phone();
      await page.evaluate("document.getElementById('helpBtn').click()");
      await settle();
      const open = await page.evaluate(`({
        docHidden: document.getElementById('docSettings').hidden,
        stillParked: document.getElementById('slotTitle').contains(document.getElementById('title'))
      })`);
      assert.eq(open.docHidden, true, 'help takes over the sheet, so the document group steps aside');
      assert.eq(open.stillParked, true, 'closing help should not have to re-fetch the title from the toolbar');

      await page.evaluate("setHelp(false); setSide(false);");
      await settle();
      const closed = await page.evaluate("document.getElementById('docSettings').hidden");
      assert.eq(closed, false, 'closing help brings the document group back');
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
      assert.ok(r.smallest >= 30, 'a toolbar button is only ' + r.smallest + 'px across');
    });

    t.check('the toolbar stays one row by shrinking, on phones narrower than it expects', async () => {
      // No fixed breakpoint owns this — sweep down to the narrowest phones
      // still sold (320px) and confirm fitBar() earns its keep on each one.
      for (const w of [320, 340, 360, 375, 390]) {
        await page.reset();
        await page.emulate(w, 740);
        await settle();
        const r = await page.evaluate(`(() => {
          const bar = document.querySelector('.bar');
          const tops = [...bar.children]
            .filter(c => getComputedStyle(c).display !== 'none')
            .map(c => c.getBoundingClientRect().top);
          return {
            // Different button types centre a few px apart on the same row
            // (padding and glyph metrics differ); a real wrap jumps a whole
            // button height, comfortably clear of this.
            oneRow: Math.max(...tops) - Math.min(...tops) < 12,
            scale: parseFloat(getComputedStyle(bar).getPropertyValue('--bar-scale')),
            scrollW: document.documentElement.scrollWidth
          };
        })()`);
        assert.eq(r.oneRow, true, 'the toolbar wrapped to a second row at ' + w + 'px');
        assert.ok(r.scale > 0 && r.scale <= 1, 'the scale should be a shrink factor at ' + w + 'px, got ' + r.scale);
        assert.eq(r.scrollW <= w, true, 'shrinking should not itself cause sideways scroll at ' + w + 'px');
      }
    });

    t.check('the toolbar only shrinks as far as it needs to, and not at all on a wide screen', async () => {
      await phone();
      const roomy = await page.evaluate(
        "parseFloat(getComputedStyle(document.querySelector('.bar')).getPropertyValue('--bar-scale'))");
      assert.near(roomy, 1, 0.12, 'a 390px phone has room to spare and should barely shrink, got ' + roomy);

      await page.unemulate();
      await settle();
      const wide = await page.evaluate(
        "getComputedStyle(document.querySelector('.bar')).getPropertyValue('--bar-scale')");
      assert.eq(wide.trim(), '', 'a wide window should not be scaling the toolbar at all');
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

    t.check('a phone can switch to one page and back, and it renders bigger alone', async () => {
      await phone();
      const before = await page.evaluate(`(() => {
        setActive(1);   // panels 1 and 2 face each other in SPREADS
        return { visible: visiblePanels().slice(), zoom: curZoom, labels: document.getElementById('sheetLabels').children.length };
      })()`);
      assert.deepEq(before.visible, [1, 2], 'starts on the spread, as it always has');
      assert.eq(before.labels, 2);

      await page.evaluate("document.getElementById('viewToggle').click()");
      await settle();
      const after = await page.evaluate(`({
        visible: visiblePanels().slice(), zoom: curZoom, singleView: state.singleView,
        on: document.getElementById('viewToggle').classList.contains('on'),
        labels: document.getElementById('sheetLabels').children.length,
        spineOn: document.getElementById('spine').classList.contains('on')
      })`);
      assert.deepEq(after.visible, [1], 'only the active panel should be on screen now');
      assert.eq(after.singleView, true);
      assert.eq(after.on, true, 'the button should show it is in effect');
      assert.eq(after.labels, 1);
      assert.eq(after.spineOn, false, 'no fold to mark with only one page shown');
      assert.ok(after.zoom > before.zoom * 1.7,
        'one page alone should render noticeably bigger, got ' + before.zoom + ' -> ' + after.zoom);

      // still reachable by panel, not just spread
      await page.evaluate('setActive(5)');
      const jumped = await page.evaluate('visiblePanels().slice()');
      assert.deepEq(jumped, [5], 'switching panels while in single view should still show just the one');

      await page.evaluate("document.getElementById('viewToggle').click()");
      await settle();
      const back = await page.evaluate(`({
        visible: visiblePanels().slice(), singleView: state.singleView,
        on: document.getElementById('viewToggle').classList.contains('on')
      })`);
      assert.deepEq(back.visible, [5, 6], 'toggling off returns to panel 5\'s spread');
      assert.eq(back.singleView, false);
      assert.eq(back.on, false);
    });

    t.check('a wide screen always shows the spread, even with single view left on', async () => {
      await page.unemulate();
      await page.reset({ singleView: true });
      const r = await page.evaluate('({ visible: visiblePanels().slice(), narrow: narrow() })');
      assert.eq(r.narrow, false);
      assert.deepEq(r.visible, [7, 0], 'a wide screen ignores singleView entirely');
      await page.evaluate("state.singleView = false");
      await page.emulate(PHONE[0], PHONE[1]);
      await settle();
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

    t.check('a selection gets its own drawer, closed, separate from the settings button', async () => {
      await phone();
      const r = await page.evaluate(`(() => {
        setActive(1); addText(); stopEdit();
        const el = selected();
        const drawer = document.getElementById('elemDrawer');
        return {
          shown: !drawer.hidden,
          open: drawer.classList.contains('open'),
          label: document.getElementById('elemPeekLabel').textContent,
          pageStillShowsPage: document.getElementById('inspector').textContent.indexOf('This page') >= 0,
          pageHasNoElementFields: !document.querySelector('#inspector [data-k]')
        };
      })()`);
      assert.eq(r.shown, true, 'selecting something should bring the drawer up');
      assert.eq(r.open, false, 'it should appear closed, not sprung open');
      assert.eq(r.label, 'Text', 'the peek should say what is selected');
      assert.eq(r.pageStillShowsPage, true,
        'the settings sheet must keep showing the project, not the selection');
      assert.eq(r.pageHasNoElementFields, true,
        'a selected element\'s own fields must not leak into the settings sheet');
    });

    t.check('nothing selected means no drawer, and deselecting closes it again', async () => {
      await phone();
      const before = await page.evaluate("document.getElementById('elemDrawer').hidden");
      assert.eq(before, true, 'nothing is selected yet, so there is nothing to peek at');

      await page.evaluate(`(() => {
        setActive(1); addText(); stopEdit();
        document.getElementById('elemPeek').click();
      })()`);
      await settle();
      assert.eq(await page.evaluate("document.getElementById('elemDrawer').classList.contains('open')"),
        true, 'the peek should open on tap');

      await page.evaluate('select(null)');
      await settle();
      const after = await page.evaluate(`({
        hidden: document.getElementById('elemDrawer').hidden,
        open: document.getElementById('elemDrawer').classList.contains('open')
      })`);
      assert.eq(after.hidden, true, 'deselecting should take the drawer away entirely');
      assert.eq(after.open, false, 'and it should not remember being open for next time');
    });

    t.check('opening the settings sheet pushes the element drawer aside, and back', async () => {
      await phone();
      await page.evaluate(`(() => {
        setActive(1); addText(); stopEdit();
        document.getElementById('elemPeek').click();
      })()`);
      await settle();
      const withBoth = await page.evaluate(`(() => {
        document.getElementById('panelBtn').click();
        return true;
      })()`);
      await settle();
      const r = await page.evaluate(`(() => {
        const d = document.getElementById('elemDrawer').getBoundingClientRect();
        return { top: Math.round(d.top), innerH: innerHeight };
      })()`);
      assert.ok(r.top >= r.innerH, 'the element drawer should be off screen while settings is open, got top=' + r.top);

      await page.evaluate("setSide(false)");
      await settle();
      const back = await page.evaluate(`(() => {
        const d = document.getElementById('elemDrawer').getBoundingClientRect();
        return { top: Math.round(d.top), open: document.getElementById('elemDrawer').classList.contains('open') };
      })()`);
      assert.ok(back.top < 740, 'the element drawer should come back once settings closes');
      assert.eq(back.open, true, 'it should remember it was open');
    });

    t.check('the settings button never switches to a selected element, on a wide screen either', async () => {
      await page.unemulate();
      await page.reset();
      const wide = await page.evaluate(`(() => {
        setActive(1); addText(); stopEdit();
        return document.getElementById('inspector').textContent.indexOf('Text') >= 0 &&
          !!document.querySelector('#inspector [data-k="rot"]');
      })()`);
      assert.eq(wide, true, 'a wide screen has room, so its one sidebar still shows the selection as before');
    });

    t.check('the desktop layout comes back on a wide window', async () => {
      await phone();
      await page.evaluate(`(() => {
        const t = document.getElementById('title');
        t.value = 'Round Trip'; t.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await page.unemulate();
      await settle();
      const r = await page.evaluate(`(() => {
        const side = document.getElementById('side').getBoundingClientRect();
        return { narrow: narrow(), sideRight: Math.round(side.right),
                 inner: innerWidth, sideTop: Math.round(side.top),
                 toggle: getComputedStyle(document.getElementById('panelBtn')).display,
                 titleInBar: document.querySelector('.bar #title') === document.getElementById('title'),
                 openInBar: document.querySelector('.bar #openZine') !== null,
                 titleVal: document.getElementById('title').value,
                 docHidden: document.getElementById('docSettings').hidden
               };
      })()`);
      assert.eq(r.narrow, false);
      assert.eq(r.toggle, 'none', 'the toggle belongs to the phone layout only');
      assert.near(r.sideRight, r.inner, 2, 'the inspector is a column again');
      assert.ok(r.sideTop < 200, 'and runs the height of the window');
      assert.eq(r.titleInBar, true, 'the title input should be back in the toolbar');
      assert.eq(r.openInBar, true, 'the file buttons should be back in the toolbar too');
      assert.eq(r.titleVal, 'Round Trip', 'moving it back must not lose what was typed');
      assert.eq(r.docHidden, true, 'the document group has nothing to show on a wide screen');
    });
  },

  /* Whatever happened above, hand the shared window back as it was found. */
  async teardown() {
    if (page) await page.unemulate();
  }
};
