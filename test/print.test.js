/* Print geometry, measured off the real 300 dpi raster rather than trusted.
   This is where the expensive mistakes live: a panel that is not exactly a
   quarter of the sheet, or a margin that eats the wrong edge, produces a zine
   that folds wrong and nobody notices until it is on paper. */

'use strict';

const { assert, pngDataUrl } = require('./harness');

const A4_LANDSCAPE = { w: 297, h: 210 };       // mm
const PANEL = { w: 297 / 4, h: 210 / 2 };      // 74.25 x 105

/* Renders the sheet and hands back a probe with millimetre coordinates. */
const RASTER = (dpi, setup) => `(async () => {
  ${setup || ''}
  const g = geom();
  const cv = await rasterize(buildSheetNode(), g.sheetW, g.sheetH, ${dpi} / 72);
  const ctx = cv.getContext('2d');
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const perMm = (${dpi} / 72) * (72 / 25.4);
  const at = (x, y) => px[((y * cv.width) + x) * 4];
  return { w: cv.width, h: cv.height, perMm: perMm,
           data: Array.from(px.filter ? [] : []), cv: null,
           probe: (function () { return null; })() };
})()`;

module.exports = {
  name: 'Print geometry',
  browser: true,
  collect(t) {
    const page = t.page;

    t.check('a panel is exactly a quarter of the sheet by half', async () => {
      await page.reset();
      const g = await page.evaluate('(() => { const g = geom(); return ' +
        '{ sheetW: g.sheetW, sheetH: g.sheetH, panelW: g.panelW, panelH: g.panelH, PT: PT }; })()');
      assert.near(g.panelW * 4, g.sheetW, 1e-9, 'four panels across');
      assert.near(g.panelH * 2, g.sheetH, 1e-9, 'two panels down');
      assert.near(g.panelW / g.PT, PANEL.w, 0.01, 'panel width in mm');
      assert.near(g.panelH / g.PT, PANEL.h, 0.01, 'panel height in mm');
    });

    t.check('the margin never changes the panel size', async () => {
      await page.reset();
      const sizes = await page.evaluate(`(() => [0, 5, 12, 25].map(m => {
        state.margin = m; const g = geom();
        return Math.round(g.panelW * 1e6) + 'x' + Math.round(g.panelH * 1e6);
      }))()`);
      assert.eq(new Set(sizes).size, 1, 'panel size must not vary with margin: ' + sizes.join(' '));
    });

    t.check('imposition puts each page in its published cell', async () => {
      const cells = await page.evaluate(
        "IMPOSE.map((c, i) => (i + 1) + ':' + c.col + ',' + c.row + ',' + c.rot).join(' ')");
      assert.eq(cells,
        '1:3,1,0 2:3,0,180 3:2,0,180 4:1,0,180 5:0,0,180 6:0,1,0 7:1,1,0 8:2,1,0');
    });

    t.check('facing pages pair the way the fold puts them', async () => {
      const s = await page.evaluate('JSON.stringify(SPREADS)');
      assert.eq(s, '[[7,0],[1,2],[3,4],[5,6]]', 'back|cover, 2|3, 4|5, 6|7');
    });

    t.check('the clipped edge of each panel accounts for the upside-down row', async () => {
      await page.reset();
      const edges = await page.evaluate(`(() => state.docs.mini.panels.map((_, i) => {
        const e = unsafeEdges(i);
        return LABELS[i] + ':' + ['t','b','l','r'].filter(k => e && e[k]).join('');
      }).join(' '))()`);
      // Every panel loses its bottom, because the top row prints rotated; the
      // outer columns lose a side as well.
      assert.eq(edges, 'cover:br 2:bl 3:b 4:b 5:br 6:bl 7:b back:b');
    });

    t.check('no margin means no clipped edges at all', async () => {
      await page.reset({ margin: 0 });
      const any = await page.evaluate('state.docs.mini.panels.some((_, i) => unsafeEdges(i) !== null)');
      assert.eq(any, false);
    });

    t.check('full-bleed artwork is clipped at exactly the margin, all four sides', async () => {
      await page.reset({ margin: 5 });
      const r = await page.evaluate(`(async () => {
        const black = ${pngDataUrl('#000000')};
        const g = geom();
        state.docs.mini.panels.forEach((p, i) => p.els.push({ id: 'b' + i, type: 'image',
          x: 0, y: 0, w: Math.round(g.panelW), h: Math.round(g.panelH), rot: 0,
          src: black, fit: 'cover', filter: 'none', opacity: 1, radius: 0 }));
        state.cut = false; state.guides = false;
        const cv = await rasterize(buildSheetNode(), g.sheetW, g.sheetH, 300 / 72);
        const ctx = cv.getContext('2d');
        const perMm = (300 / 72) * (72 / 25.4);
        const v = (x, y) => ctx.getImageData(x, y, 1, 1).data[0];
        const scanIn = (fromEnd, horizontal, fixed) => {
          const n = horizontal ? cv.width : cv.height;
          for (let i = 0; i < n; i++) {
            const k = fromEnd ? n - 1 - i : i;
            if ((horizontal ? v(k, fixed) : v(fixed, k)) < 128) return +(i / perMm).toFixed(2);
          }
          return -1;
        };
        // sample away from panel seams so antialiasing cannot confuse it
        return {
          left: scanIn(false, true, Math.round(cv.height * 0.72)),
          right: scanIn(true, true, Math.round(cv.height * 0.72)),
          top: scanIn(false, false, Math.round(cv.width * 0.6)),
          bottom: scanIn(true, false, Math.round(cv.width * 0.6))
        };
      })()`);
      ['left', 'right', 'top', 'bottom'].forEach(side => {
        assert.near(r[side], 5, 0.12, 'ink starts ' + r[side] + ' mm from the ' + side);
      });
    });

    t.check('panel seams land on the true quarter and half lines', async () => {
      await page.reset({ margin: 0 });
      const seams = await page.evaluate(`(async () => {
        const greys = ['#101010','#303030','#505050','#707070','#909090','#a8a8a8','#c0c0c0','#d8d8d8'];
        state.docs.mini.panels.forEach((p, i) => { p.bg = greys[i]; p.els = []; });
        state.cut = false; state.guides = false;
        const g = geom();
        const cv = await rasterize(buildSheetNode(), g.sheetW, g.sheetH, 300 / 72);
        const ctx = cv.getContext('2d');
        const perMm = (300 / 72) * (72 / 25.4);
        const edges = (line, n, read) => {
          const out = [];
          // skip the outermost pixels: the SVG rasteriser leaves a faint
          // 1-2px fringe at the canvas edge that is not part of the artwork
          for (let i = 3; i < n - 2; i++) if (Math.abs(read(i) - read(i - 1)) > 6) out.push(i);
          return out;
        };
        const row = ctx.getImageData(0, Math.round(cv.height * 0.75), cv.width, 1).data;
        const col = ctx.getImageData(Math.round(cv.width * 0.375), 0, 1, cv.height).data;
        const group = list => {            // antialiasing gives 2 steps per seam
          const g2 = [];
          list.forEach(x => {
            if (g2.length && x - g2[g2.length - 1][g2[g2.length - 1].length - 1] <= 2) {
              g2[g2.length - 1].push(x);
            } else g2.push([x]);
          });
          return g2.map(b => +((b.reduce((a, c) => a + c, 0) / b.length) / perMm).toFixed(2));
        };
        return {
          vertical: group(edges(null, cv.width, i => row[i * 4])),
          horizontal: group(edges(null, cv.height, i => col[i * 4]))
        };
      })()`);
      assert.eq(seams.vertical.length, 3, 'three vertical seams, got ' + seams.vertical.join(', '));
      [74.25, 148.5, 222.75].forEach((want, i) => {
        assert.near(seams.vertical[i], want, 0.3, 'vertical seam ' + i);
      });
      assert.eq(seams.horizontal.length, 1, 'one horizontal seam, got ' + seams.horizontal.join(', '));
      assert.near(seams.horizontal[0], 105, 0.3, 'horizontal seam');
    });

    t.check('the cut line prints along the middle two columns only', async () => {
      await page.reset({ margin: 0, cut: true, guides: false });
      const r = await page.evaluate(`(async () => {
        const g = geom();
        const cv = await rasterize(buildSheetNode(), g.sheetW, g.sheetH, 300 / 72);
        const ctx = cv.getContext('2d');
        const perMm = (300 / 72) * (72 / 25.4);
        const mid = Math.round(cv.height / 2);
        const strip = ctx.getImageData(0, mid - 2, cv.width, 5).data;
        const inkAt = x => {
          for (let dy = 0; dy < 5; dy++) if (strip[((dy * cv.width) + x) * 4] < 230) return true;
          return false;
        };
        let first = -1, last = -1;
        for (let x = 0; x < cv.width; x++) if (inkAt(x)) { if (first < 0) first = x; last = x; }
        // count separate runs of ink: a solid line is exactly one
        let runs = 0, on = false;
        for (let x = first; x >= 0 && x <= last; x++) {
          const k = inkAt(x);
          if (k && !on) runs++;
          on = k;
        }
        return { startMm: +(first / perMm).toFixed(1), endMm: +(last / perMm).toFixed(1), dashes: runs };
      })()`);
      assert.near(r.startMm, 297 / 4, 0.5, 'cut line starts at the first quarter');
      assert.near(r.endMm, 297 * 3 / 4, 0.5, 'cut line ends at the third quarter');
      assert.eq(r.dashes, 1, 'the cut line should be one unbroken run, counted ' + r.dashes);
    });

    t.check('turning the cut line off leaves the centreline clean', async () => {
      await page.reset({ margin: 0, cut: false, guides: false });
      const ink = await page.evaluate(`(async () => {
        const g = geom();
        const cv = await rasterize(buildSheetNode(), g.sheetW, g.sheetH, 150 / 72);
        const ctx = cv.getContext('2d');
        const mid = Math.round(cv.height / 2);
        const strip = ctx.getImageData(0, mid - 1, cv.width, 3).data;
        let n = 0;
        for (let i = 0; i < strip.length; i += 4) if (strip[i] < 230) n++;
        return n;
      })()`);
      assert.eq(ink, 0, 'found ink on the centreline with the cut line off');
    });

    t.check('panel outlines print on every fold when switched on', async () => {
      await page.reset({ margin: 0, cut: false, guides: true });
      const r = await page.evaluate(`(async () => {
        const g = geom();
        const cv = await rasterize(buildSheetNode(), g.sheetW, g.sheetH, 300 / 72);
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        const perMm = (300 / 72) * (72 / 25.4);
        // Project ink onto each axis. A dashed line only inks a third of its
        // length, so sampling one row or column can land in a gap; counting
        // down the whole axis does not care about the dash phase.
        const colInk = new Array(cv.width).fill(0);
        const rowInk = new Array(cv.height).fill(0);
        for (let y = 0; y < cv.height; y++) {
          for (let x = 0; x < cv.width; x++) {
            if (d[((y * cv.width) + x) * 4] < 230) { colInk[x]++; rowInk[y]++; }
          }
        }
        const groups = (counts, floor, per) => {
          const hits = [];
          counts.forEach((n, i) => { if (n > floor) hits.push(i); });
          const out = [];
          hits.forEach(i => {
            if (out.length && i - out[out.length - 1].last <= 3) {
              out[out.length - 1].last = i;
            } else out.push({ first: i, last: i });
          });
          return out.map(b => +(((b.first + b.last) / 2) / per).toFixed(2));
        };
        return {
          verticals: groups(colInk, cv.height * 0.1, perMm),
          horizontals: groups(rowInk, cv.width * 0.1, perMm)
        };
      })()`);
      assert.eq(r.verticals.length, 3, 'expected three fold lines, saw ' + r.verticals.join(', '));
      [74.25, 148.5, 222.75].forEach((want, i) => {
        assert.near(r.verticals[i], want, 0.3, 'vertical fold line ' + i);
      });
      assert.eq(r.horizontals.length, 1, 'expected one horizontal fold line, saw ' + r.horizontals.join(', '));
      assert.near(r.horizontals[0], 105, 0.3, 'horizontal fold line');
    });

    t.check('guides stay off the sheet when both options are off', async () => {
      await page.reset({ margin: 0, cut: false, guides: false });
      const ink = await page.evaluate(`(async () => {
        const g = geom();
        const cv = await rasterize(buildSheetNode(), g.sheetW, g.sheetH, 150 / 72);
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 245) n++;
        return n;
      })()`);
      assert.eq(ink, 0, 'a blank zine with no guides should render as blank paper');
    });

    t.check('the on-screen chop band matches the margin and only marks real edges', async () => {
      await page.reset({ margin: 5 });
      const r = await page.evaluate(`(() => {
        setActive(0);
        const panels = [...document.querySelectorAll('#sheet > .panel')].map(pd =>
          pd.dataset.pi + ':' + [...pd.querySelectorAll('.chop .band')]
            .map(b => b.className.replace('band band-', '')).sort().join(''));
        const b = document.querySelector('#sheet .panel[data-pi="0"] .band-b');
        return { panels: panels.join(' '),
                 thickness: b ? Math.round(parseFloat(b.style.height) * 100) / 100 : null,
                 expected: Math.round(5 * PT * 100) / 100,
                 pointerEvents: getComputedStyle(document.querySelector('#sheet .chop')).pointerEvents };
      })()`);
      assert.eq(r.panels, '7:b 0:br', 'back shows a bottom band, cover bottom and right');
      assert.eq(r.thickness, r.expected, 'band thickness in points');
      assert.eq(r.pointerEvents, 'none', 'the band must not intercept the pointer');
    });

    t.check('chop bands disappear at zero margin', async () => {
      await page.reset({ margin: 0 });
      const n = await page.evaluate("document.querySelectorAll('#sheet .chop').length");
      assert.eq(n, 0);
    });

    t.check('export raster is 300 dpi and carries the artwork', async () => {
      await page.reset({ margin: 5 });
      const r = await page.evaluate(`(async () => {
        setActive(0); addText();
        selected().text = 'HELLO'; selected().size = 40; stopEdit();
        const g = geom();
        const cv = await rasterize(buildSheetNode(), g.sheetW, g.sheetH, 300 / 72);
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let ink = 0;
        for (let i = 0; i < d.length; i += 4 * 37) if (d[i] < 128) ink++;
        return { w: cv.width, h: cv.height, ink: ink };
      })()`);
      assert.eq(r.w, 3508, 'A4 landscape width at 300 dpi');
      assert.eq(r.h, 2480, 'A4 landscape height at 300 dpi');
      assert.ok(r.ink > 20, 'the rendered sheet looks blank');
    });

    t.check('US Letter keeps the same quarter-and-half relationship', async () => {
      await page.reset({ paper: 'letter' });
      const g = await page.evaluate('(() => { const g = geom(); return ' +
        '{ sheetW: g.sheetW, sheetH: g.sheetH, panelW: g.panelW, panelH: g.panelH, PT: PT }; })()');
      assert.near(g.panelW * 4, g.sheetW, 1e-9);
      assert.near(g.panelH * 2, g.sheetH, 1e-9);
      assert.near(g.sheetW / g.PT, 279.4, 0.01, 'letter landscape width');
      await page.reset();
    });
  }
};
