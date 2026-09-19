/* The two file formats the app writes: the binary .zine container and the
   PDF. Both are assembled by hand, so both are checked byte by byte — a wrong
   offset in either produces a file that opens nowhere. */

'use strict';

const { assert, pngDataUrl } = require('./harness');

/* Builds a zine with something of every kind on it, then hands back the bytes
   saveZine would have written. */
const BUILD_AND_SAVE = `(async () => {
  const px = ${pngDataUrl('#8e44ad')};
  setActive(2);
  panel().els.push({ id: 'i1', type: 'image', x: 4, y: 4, w: 60, h: 60, rot: 0,
    src: px, fit: 'cover', filter: 'copy', opacity: 1, radius: 0 });
  panel().els.push({ id: 'i2', type: 'image', x: 9, y: 9, w: 60, h: 60, rot: 12,
    src: px, fit: 'cover', filter: 'none', opacity: 0.5, radius: 3 });
  setActive(7); addQr();
  setActive(0); addText(); stopEdit();
  selected().text = 'cover words';
  state.title = 'binary round trip';
  state.margin = 7.5; state.cut = false; state.guides = true;

  let captured = null;
  const real = window.download;
  window.download = (blob, name) => { captured = { blob: blob, name: name }; };
  await saveZine();
  window.download = real;
  const bytes = new Uint8Array(await captured.blob.arrayBuffer());
  return { name: captured.name, bytes: Array.from(bytes) };
})()`;

/* Key order changes when src is swapped for asset and back, so compare with
   every object's keys sorted. */
const CANON = `(o => JSON.stringify(o, (k, v) =>
  (v && typeof v === 'object' && !Array.isArray(v))
    ? Object.keys(v).sort().reduce((a, k2) => (a[k2] = v[k2], a), {})
    : v))`;

module.exports = {
  name: 'File formats',
  browser: true,
  collect(t) {
    const page = t.page;

    t.check('.zine starts with its magic number and a deflated description', async () => {
      await page.reset();
      const r = await page.evaluate(BUILD_AND_SAVE);
      const b = Buffer.from(r.bytes);
      assert.eq(r.name, 'binary-round-trip.zine', 'filename comes from the title');
      assert.eq(b.slice(0, 4).toString('latin1'), 'ZINE', 'magic');
      assert.eq(b[4], 2, 'container version');
      assert.eq(b[5], 1, 'deflate flag');
      const metaLen = b.readUInt32LE(6);
      const assets = b.readUInt32LE(10);
      assert.ok(metaLen > 0 && metaLen < b.length, 'meta length is inside the file');
      assert.eq(assets, 1, 'two elements share one image, so it is stored once');
      // the description must not be readable as plain text: it is compressed
      assert.ok(b.slice(14, 14 + metaLen).toString('latin1').indexOf('"format"') < 0,
        'the description should be deflated, not plain JSON');
      // image bytes follow, length-prefixed, and are a real PNG
      const at = 14 + metaLen;
      const imgLen = b.readUInt32LE(at);
      assert.eq(b.slice(at + 4, at + 8).toString('latin1'), '\u0089PNG', 'raw PNG bytes, not base64');
      assert.eq(at + 4 + imgLen, b.length, 'the file ends exactly after the last image');
    });

    t.check('.zine is markedly smaller than the equivalent JSON', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        const saved = await ${BUILD_AND_SAVE};
        const plain = JSON.stringify({ format: 'zine', formatVersion: 2, app: 'zinemaker',
          saved: new Date().toISOString(), title: state.title, paper: state.paper,
          margin: state.margin, cut: state.cut, guides: state.guides,
          docs: state.docs }, null, 2).length;
        return { binary: saved.bytes.length, json: plain };
      })()`);
      assert.ok(r.binary < r.json * 0.5,
        'expected well under half the JSON size, got ' + r.binary + ' vs ' + r.json);
    });

    t.check('.zine reopens to exactly the document that was saved', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        const saved = await ${BUILD_AND_SAVE};
        const canon = ${CANON};
        const before = canon(state.docs);
        const settings = [state.title, state.margin, state.cut, state.guides].join('|');

        state.docs = { mini: blankDoc(8) };
        state.title = 'wiped'; state.margin = 0; state.cut = true; state.guides = false;
        await openZine(new File([new Uint8Array(saved.bytes)], 'x.zine'));

        const imgs = state.docs.mini.panels[2].els.filter(e => e.type === 'image');
        return {
          docsMatch: canon(state.docs) === before,
          settings: [state.title, state.margin, state.cut, state.guides].join('|') === settings,
          titleInput: document.getElementById('title').value,
          images: imgs.length,
          rehydrated: imgs.every(e => /^data:image\\/png;base64,/.test(e.src)),
          shared: imgs.length === 2 && imgs[0].src === imgs[1].src,
          keptFilter: (imgs[0] || {}).filter,
          qr: !!state.docs.mini.panels[7].els.find(e => e.type === 'qr')
        };
      })()`);
      assert.eq(r.docsMatch, true, 'every panel and element must come back identical');
      assert.eq(r.settings, true, 'title, margin and guide settings travel with the file');
      assert.eq(r.titleInput, 'binary round trip', 'the toolbar follows the loaded file');
      assert.eq(r.images, 2);
      assert.eq(r.rehydrated, true, 'images come back as data URLs');
      assert.eq(r.shared, true, 'a shared image is handed back to both elements');
      assert.eq(r.keptFilter, 'copy', 'per-element settings survive');
      assert.eq(r.qr, true);
    });

    t.check('a plain-JSON .zine from format version 1 still opens', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        const legacy = JSON.stringify({ format: 'zine', formatVersion: 1, app: 'zinemaker',
          saved: '2026-01-01T00:00:00.000Z', title: 'legacy file', paper: 'a4',
          mode: 'mini', margin: 3, docs: state.docs });
        await openZine(new File([legacy], 'old.zine'));
        return { title: state.title, margin: state.margin };
      })()`);
      assert.eq(r.title, 'legacy file');
      assert.eq(r.margin, 3);
    });

    t.check('a file saved by the old flat-page version still opens as the zine', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        const mini = blankDoc(8);
        mini.panels[0].els.push({ id: 'k', type: 'text', x: 5, y: 5, w: 60, rot: 0,
          text: 'kept', font: 0, size: 10, color: '#111', align: 'left', lh: 1.3, ls: 0,
          bold: false, italic: false, bg: '', pad: 4 });
        const old = JSON.stringify({ format: 'zine', formatVersion: 2, app: 'zinemaker',
          saved: 'x', title: 'old flat file', paper: 'letter', mode: 'flat', margin: 4,
          docs: { mini: mini, flat: blankDoc(1) } });
        await openZine(new File([old], 'old-flat.zine'));
        return { title: state.title, paper: state.paper, docs: Object.keys(state.docs).join(','),
                 kept: state.docs.mini.panels[0].els[0].text, panels: state.docs.mini.panels.length,
                 hasMode: 'mode' in state };
      })()`);
      assert.eq(r.title, 'old flat file');
      assert.eq(r.paper, 'letter');
      assert.eq(r.docs, 'mini', 'the flat document is dropped, not carried around');
      assert.eq(r.kept, 'kept');
      assert.eq(r.panels, 8);
      assert.eq(r.hasMode, false, 'the old mode field must not leak back into state');
    });

    t.check('a saved .zine no longer carries a mode or a flat document', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        const saved = await ${BUILD_AND_SAVE};
        const meta = await readZine(new File([new Uint8Array(saved.bytes)], 'x.zine'));
        return { docs: Object.keys(meta.docs).join(','), hasMode: 'mode' in meta,
                 hasSpread: 'spread' in meta };
      })()`);
      assert.eq(r.docs, 'mini', 'only the eight-panel document is written');
      assert.eq(r.hasMode, false, 'the mode field is no longer written');
      assert.eq(r.hasSpread, false);
    });

    t.check('a file from a newer format still opens as best it can', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        const future = JSON.stringify({ format: 'zine', formatVersion: 99, app: 'zinemaker',
          saved: 'x', title: 'from the future', paper: 'a4', mode: 'mini',
          margin: 4, unknownKey: { nested: true }, docs: state.docs });
        await openZine(new File([future], 'future.zine'));
        return state.title;
      })()`);
      assert.eq(r, 'from the future');
    });

    t.check('rubbish is refused without destroying the open document', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        setActive(0); addText(); stopEdit();
        const before = JSON.stringify(state.docs);
        await openZine(new File([new Uint8Array([1,2,3,4,5,6,7,8,9])], 'junk.zine'));
        const afterBinary = JSON.stringify(state.docs) === before;
        await openZine(new File(['{{{ not json at all'], 'bad.zine'));
        const afterText = JSON.stringify(state.docs) === before;
        await openZine(new File(['{"format":"something-else"}'], 'other.zine'));
        const afterWrongFormat = JSON.stringify(state.docs) === before;
        return { afterBinary, afterText, afterWrongFormat };
      })()`);
      assert.eq(r.afterBinary, true, 'random bytes must not clobber the document');
      assert.eq(r.afterText, true, 'malformed JSON must not clobber the document');
      assert.eq(r.afterWrongFormat, true, 'a foreign JSON file must be refused');
    });

    t.check('the PDF is a well-formed single-page document', async () => {
      await page.reset({ margin: 5 });
      const r = await page.evaluate(`(async () => {
        setActive(0); addText(); stopEdit();
        selected().text = 'PDF'; selected().size = 40;
        const g = geom();
        const cv = await rasterize(buildSheetNode(), g.sheetW, g.sheetH, 300 / 72);
        const jb = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.94));
        const jpeg = new Uint8Array(await jb.arrayBuffer());
        const pdf = buildPDF([{ jpeg: jpeg, pxW: cv.width, pxH: cv.height,
                                ptW: g.sheetW, ptH: g.sheetH }]);
        return { bytes: Array.from(new Uint8Array(await pdf.arrayBuffer())),
                 jpegLen: jpeg.length, pxW: cv.width, pxH: cv.height };
      })()`);
      const b = Buffer.from(r.bytes);
      const s = b.toString('latin1');

      assert.eq(s.slice(0, 8), '%PDF-1.4', 'header');
      assert.ok(s.trimEnd().endsWith('%%EOF'), 'trailer');

      const sx = /startxref\s+(\d+)/.exec(s);
      assert.ok(sx, 'startxref present');
      assert.eq(s.slice(+sx[1], +sx[1] + 4), 'xref', 'startxref points at the table');

      const head = /xref\n0 (\d+)\n/.exec(s.slice(+sx[1]));
      const count = +head[1];
      assert.eq(count, 6, 'catalog, pages, page, image, content and the free entry');

      // every entry must be 20 bytes and land exactly on its object
      const body = s.slice(+sx[1] + head[0].length + 20);
      for (let i = 1; i < count; i++) {
        const entry = body.slice((i - 1) * 20, i * 20);
        assert.ok(/^\d{10} \d{5} n \n$/.test(entry), 'xref entry ' + i + ' is malformed: ' + JSON.stringify(entry));
        const off = parseInt(entry.slice(0, 10), 10);
        assert.ok(s.startsWith(i + ' 0 obj', off), 'xref entry ' + i + ' does not point at object ' + i);
      }

      const imgObj = /4 0 obj\n<<[^>]*\/Length (\d+) >>\nstream\n/.exec(s);
      assert.ok(imgObj, 'image object');
      assert.eq(+imgObj[1], r.jpegLen, 'image /Length matches the JPEG');
      const dataStart = imgObj.index + imgObj[0].length;
      assert.eq(b[dataStart], 0xff, 'JPEG SOI survived');
      assert.eq(b[dataStart + 1], 0xd8, 'JPEG SOI survived');
      assert.eq(s.slice(dataStart + r.jpegLen, dataStart + r.jpegLen + 11), '\nendstream\n',
        'the image stream ends where /Length says it does');

      const cs = /5 0 obj\n<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(s);
      assert.eq(cs[2].length, +cs[1], 'content stream /Length');
      assert.includes(s, '/Width ' + r.pxW + ' /Height ' + r.pxH, 'image dimensions');
      assert.includes(s, 'MediaBox [0 0 841.89 595.28]', 'A4 landscape media box');
      assert.includes(s, '841.89 0 0 595.28 0 0 cm', 'image is scaled to the whole page');
    });

    t.check('exporting a PNG and a PDF both produce a plausible file', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        setActive(0); addText(); stopEdit();
        const got = {};
        const real = window.download;
        window.download = (blob, name) => { got[name.split('.').pop()] = blob.size; };
        await exportSheet('png');
        await exportSheet('pdf');
        window.download = real;
        return got;
      })()`);
      assert.ok(r.png > 5000, 'png looks too small: ' + r.png);
      assert.ok(r.pdf > 5000, 'pdf looks too small: ' + r.pdf);
    });
  }
};
