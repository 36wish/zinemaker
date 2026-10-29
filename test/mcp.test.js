/* The WebMCP tools in mcp.js: how they register with a model context, and
   that each one does to the document what the matching mouse action would —
   measured in points and pixels, not taken on trust. */

'use strict';

const { assert } = require('./harness');

/* Calls a tool the way an agent would, returning { ok, value } or { ok: false, error }
   along with how many undo steps the call left behind. */
const call = (name, args) => `(async () => {
  const before = hist.length;
  try {
    const value = await callAgentTool(${JSON.stringify(name)}, ${JSON.stringify(args || {})});
    return { ok: true, value: value, steps: hist.length - before };
  } catch (err) {
    return { ok: false, error: err.message, steps: hist.length - before };
  }
})()`;

module.exports = {
  name: 'Agent tools (WebMCP)',
  browser: true,
  collect(t) {
    const page = t.page;

    t.check('a browser with WebMCP lists the tools at load and runs them', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        const mc = document.modelContext;
        if (!mc || typeof mc.getTools !== 'function') return { native: false };
        // Chrome versions differ: some take the arguments as an object, some
        // as the JSON text the agent sent. Either has to reach the tool.
        const tools = await mc.getTools();
        const add = tools.find(t => t.name === 'add_text');
        const args = { page: 3, text: 'from the agent' };
        let out = null;
        if (add) {
          try { out = await mc.executeTool(add, args); }
          catch (err) { out = await mc.executeTool(add, JSON.stringify(args)); }
        }
        return { native: true, names: tools.map(t => t.name), out: out,
                 placed: doc().panels[2].els.map(e => e.text) };
      })()`);
      if (!r.native) return;            // this Chrome has no WebMCP: the fakes below still cover it
      const ours = await page.evaluate('AGENT_TOOLS.map(t => t.name)');
      ours.forEach(n => assert.ok(r.names.indexOf(n) >= 0, n + ' is listed'));
      assert.eq(JSON.parse(r.out).text, 'from the agent', 'the result comes back as JSON');
      assert.deepEq(r.placed, ['from the agent']);
    });

    t.check('every tool registers with document.modelContext, and registering again replaces them', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        const seen = [];
        Object.defineProperty(document, 'modelContext', { configurable: true, value: {
          registerTool(tool, opts) {
            if (seen.some(s => s.tool.name === tool.name && !s.opts.signal.aborted)) {
              return Promise.reject(new Error('duplicate ' + tool.name));
            }
            seen.push({ tool: tool, opts: opts });
            return Promise.resolve();
          }
        } });
        const first = registerAgentTools();
        const firstSignals = seen.map(s => s.opts.signal);
        const second = registerAgentTools();
        const tools = seen.slice(first).map(s => s.tool);
        const ran = await tools.find(t => t.name === 'get_zine').execute({}, {});
        delete document.modelContext;
        registerAgentTools();             // back onto the browser's own, if it has one
        return {
          first: first, second: second,
          oldAborted: firstSignals.every(s => s.aborted),
          names: tools.map(t => t.name),
          badNames: tools.filter(t => !/^[A-Za-z0-9_.-]{1,128}$/.test(t.name)).map(t => t.name),
          noDescription: tools.filter(t => !t.description).map(t => t.name),
          badSchema: tools.filter(t => t.inputSchema.type !== 'object' ||
            (t.inputSchema.required || []).some(k => !t.inputSchema.properties[k])).map(t => t.name),
          plainResult: typeof ran.title === 'string' && !ran.content
        };
      })()`);
      assert.ok(r.first >= 10, 'registered ' + r.first + ' tools');
      assert.eq(r.second, r.first, 'registering again registers the same set');
      assert.eq(r.oldAborted, true, 'the first set is unregistered through its signal');
      assert.eq(new Set(r.names).size, r.names.length, 'tool names are unique');
      assert.deepEq(r.badNames, [], 'names fit the draft spec');
      assert.deepEq(r.noDescription, [], 'every tool has a description');
      assert.deepEq(r.badSchema, [], 'every schema is an object whose required keys exist');
      assert.eq(r.plainResult, true, 'the current draft gets the plain result');
    });

    t.check('an older navigator.modelContext gets MCP content blocks, errors included', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        const tools = {};
        Object.defineProperty(document, 'modelContext', { configurable: true, value: undefined });
        Object.defineProperty(navigator, 'modelContext', { configurable: true, value: {
          registerTool(tool) { tools[tool.name] = tool; return { unregister() { delete tools[tool.name]; } }; }
        } });
        registerAgentTools();
        const ok = await tools.add_text.execute({ page: 2, text: 'hi' });
        const bad = await tools.add_text.execute({ page: 2, text: 'hi', colour: '#000000' });
        const pic = await tools.render_preview.execute({ page: 2, view: 'page' });
        delete navigator.modelContext;
        delete document.modelContext;
        registerAgentTools();
        return {
          okText: ok.content[0].type === 'text' && JSON.parse(ok.content[0].text).text,
          badError: bad.isError === true && bad.content[0].text,
          picType: pic.content[0].type, picMime: pic.content[0].mimeType,
          picData: /^iVBOR/.test(pic.content[0].data)
        };
      })()`);
      assert.eq(r.okText, 'hi');
      assert.includes(r.badError, 'Unknown property "colour"');
      assert.eq(r.picType, 'image', 'a preview arrives as an image block the agent can see');
      assert.eq(r.picMime, 'image/png');
      assert.eq(r.picData, true, 'the image block holds bare base64 PNG');
    });

    t.check('add_text places text in mm on the right page, as one undo step, and shows it', async () => {
      await page.reset();
      const r = await page.evaluate(call('add_text', {
        page: 4, text: 'HELLO\nTHERE', x: 10, y: 20, width: 50, size: 24, font: 'Impact',
        color: '#F00', align: 'center', background: '#ffffff'
      }));
      assert.eq(r.ok, true, r.error);
      assert.eq(r.steps, 1, 'one call is one undo step');
      const s = await page.evaluate(`(() => {
        const el = doc().panels[3].els[0];
        return { x: el.x, y: el.y, w: el.w, font: el.font, color: el.color, bg: el.bg,
                 text: el.text, active: state.active, sel: selId === el.id,
                 onScreen: nodes.has(el.id), h: nodes.get(el.id).offsetHeight };
      })()`);
      assert.near(s.x, 10 * 72 / 25.4, 0.01, 'x in points');
      assert.near(s.y, 20 * 72 / 25.4, 0.01, 'y in points');
      assert.near(s.w, 50 * 72 / 25.4, 0.01, 'width in points');
      assert.eq(s.font, 3, 'Impact by name');
      assert.eq(s.color, '#ff0000', 'short hex expanded');
      assert.eq(s.text, 'HELLO\nTHERE');
      assert.eq(s.active, 3, 'its page comes up');
      assert.eq(s.sel, true, 'and it is selected');
      assert.eq(s.onScreen, true);
      assert.near(r.value.height, s.h / (72 / 25.4), 0.2, 'reported height is the laid-out height');
      assert.eq(r.value.page, 4);
    });

    t.check('bad input is refused with a reason and changes nothing', async () => {
      await page.reset();
      const cases = [
        ['add_text', { page: 9, text: 'x' }, 'at most 8'],
        ['add_text', { page: 1 }, 'text is required'],
        ['add_text', { page: 1, text: 'x', font: 'Papyrus' }, 'one of'],
        ['add_text', { page: 1, text: 'x', color: 'red' }, 'hex colour'],
        ['add_text', { page: 1, text: 'x', height: 20 }, 'Unknown property "height"'],
        ['update_element', { id: 'nope', x: 1 }, 'No element'],
        ['undo', { steps: 'two' }, 'integer']
      ];
      for (const c of cases) {
        const r = await page.evaluate(call(c[0], c[1]));
        assert.eq(r.ok, false, c[0] + ' ' + JSON.stringify(c[1]) + ' should fail');
        assert.includes(r.error, c[2]);
        assert.eq(r.steps, 0, 'a refused call leaves no undo step');
      }
      const img = await page.evaluate(call('add_image', { page: 1 }));
      const r = await page.evaluate(call('update_element', { id: img.value.id, font: 'Serif' }));
      assert.includes(r.error, 'does not apply to a photo');
      assert.eq(r.steps, 0, 'checked before history is touched');
      const n = await page.evaluate('doc().panels.reduce((n, p) => n + p.els.length, 0)');
      assert.eq(n, 1, 'only the frame was added');
    });

    t.check('add_image takes a data URL, downscales it and keeps its proportions', async () => {
      await page.reset();
      const url = await page.evaluate(`(() => {
        const c = document.createElement('canvas'); c.width = 3000; c.height = 1500;
        const x = c.getContext('2d'); x.fillStyle = '#2a6'; x.fillRect(0, 0, 3000, 1500);
        return c.toDataURL('image/png');
      })()`);
      const r = await page.evaluate(call('add_image', { page: 2, url: url, width: 60, filter: 'bw', shape: 'circle' }));
      assert.eq(r.ok, true, r.error);
      assert.near(r.value.width, 60, 0.1);
      assert.near(r.value.height, 30, 0.2, 'height follows the photo');
      assert.eq(r.value.has_photo, true);
      const s = await page.evaluate(`(async () => {
        const el = doc().panels[1].els[0];
        const probe = new Image();
        await new Promise(res => { probe.onload = res; probe.src = el.src; });
        return { data: /^data:image\\//.test(el.src), long: Math.max(probe.width, probe.height),
                 filter: el.filter, shape: el.shape };
      })()`);
      assert.eq(s.data, true, 'stored as a data URL');
      assert.eq(s.long, 1500, 'downscaled like any import');
      assert.eq(s.filter, 'bw');
      assert.eq(s.shape, 'circle');
      const z = await page.evaluate(call('get_zine'));
      assert.ok(JSON.stringify(z.value).indexOf('data:') < 0, 'get_zine never carries photo bytes');

      const frame = await page.evaluate(call('add_image', { page: 2 }));
      assert.eq(frame.value.has_photo, false, 'no url: an empty frame');
      assert.includes(frame.value.warnings.join(' '), 'never prints');
    });

    t.check('update_element edits, moves between pages and reorders layers', async () => {
      await page.reset();
      const a = (await page.evaluate(call('add_qr', { page: 3, data: 'https://example.org', width: 30 }))).value;
      const b = (await page.evaluate(call('add_text', { page: 3, text: 'over' }))).value;
      assert.near(a.width, 30, 0.1);
      assert.near(a.height, 30, 0.1, 'a QR code is square');
      let r = await page.evaluate(call('update_element', { id: a.id, layer: 'top', dark: '#223344', width: 40 }));
      assert.eq(r.ok, true, r.error);
      assert.eq(r.value.layer, 1, 'raised above the text');
      assert.near(r.value.height, 40, 0.1, 'still square');
      r = await page.evaluate(call('update_element', { id: b.id, to_page: 6, text: 'moved' }));
      assert.eq(r.value.page, 6);
      const s = await page.evaluate(`({ p3: doc().panels[2].els.length, p6: doc().panels[5].els.map(e => e.text),
                                         active: state.active })`);
      assert.eq(s.p3, 1);
      assert.deepEq(s.p6, ['moved']);
      assert.eq(s.active, 5, 'the page it went to comes up');
      r = await page.evaluate(call('delete_element', { id: a.id }));
      assert.eq(r.steps, 1);
      assert.eq(await page.evaluate('doc().panels[2].els.length'), 0);
    });

    t.check('layouts, page colours and the printer margin warning', async () => {
      await page.reset();
      let r = await page.evaluate(call('apply_layout', { page: 1, layout: 'Cover' }));
      assert.eq(r.ok, true, r.error);
      assert.deepEq(r.value.elements.map(e => e.type), ['image', 'text', 'text']);
      r = await page.evaluate(call('set_page', { page: 1, background: '#ffd23f' }));
      assert.eq(await page.evaluate('doc().panels[0].bg'), '#ffd23f');
      const z = (await page.evaluate(call('get_zine'))).value;
      assert.deepEq(z.spreads, [[8, 1], [2, 3], [4, 5], [6, 7]]);
      assert.eq(z.pages[0].unprintable_edges_mm.bottom, 5, 'every page loses its bottom edge');
      const cover = z.pages[0].elements;
      assert.ok(cover[0].warnings.some(w => /printer margin/.test(w)),
        'the full-width cover photo is flagged as reaching the rim');
      r = await page.evaluate(call('set_page', { page: 1, clear: true }));
      assert.eq(r.value.elements, 0);
      assert.eq(r.value.background, '#ffffff');
    });

    t.check('undo and redo share the editor\'s history', async () => {
      await page.reset();
      await page.evaluate(call('add_text', { page: 1, text: 'one' }));
      await page.evaluate(call('add_text', { page: 1, text: 'two' }));
      let r = await page.evaluate(call('undo', { steps: 2 }));
      assert.eq(r.value.undone, 2);
      assert.eq(await page.evaluate('doc().panels[0].els.length'), 0);
      r = await page.evaluate(call('redo'));
      assert.eq(r.value.redone, 1);
      assert.deepEq(await page.evaluate('doc().panels[0].els.map(e => e.text)'), ['one']);
    });

    t.check('render_preview draws a spread in reading order, tinting the rim the printer skips', async () => {
      await page.reset();
      await page.evaluate(call('set_page', { page: 1, background: '#ff0000' }));
      const r = await page.evaluate(call('render_preview', { page: 1 }));
      assert.eq(r.ok, true, r.error);
      assert.deepEq(r.value.pages, [8, 1], 'the outside spread: back on the left, cover on the right');
      const px = await page.evaluate(`(async () => {
        const img = new Image();
        await new Promise(res => { img.onload = res; img.src = 'data:image/png;base64,${r.value.data}'; });
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const at = (fx, fy) => [...x.getImageData(Math.round(fx * img.width), Math.round(fy * img.height), 1, 1).data];
        return { w: img.width, h: img.height, left: at(0.25, 0.5), right: at(0.75, 0.5), rim: at(0.25, 0.995) };
      })()`);
      const g = await page.evaluate('geom()');
      assert.eq(px.w, Math.round(g.panelW * 2 * 2), 'two pages wide at 2 px/pt');
      assert.eq(px.h, Math.round(g.panelH * 2));
      assert.deepEq(px.left.slice(0, 3), [255, 255, 255], 'the back is white');
      assert.ok(px.right[0] > 240 && px.right[1] < 15 && px.right[2] < 15, 'the cover is red: ' + px.right);
      assert.ok(px.rim[1] < 235 && px.rim[0] > 240, 'the bottom rim is tinted: ' + px.rim);

      const sheet = (await page.evaluate(call('render_preview', { view: 'sheet' }))).value;
      assert.eq(sheet.width, Math.round(g.sheetW * 1.5), 'the sheet view is the whole imposed sheet');
    });

    t.check('set_document changes print settings and the toolbar follows', async () => {
      await page.reset();
      const r = await page.evaluate(call('set_document', { title: 'night bus', paper: 'letter', printer_margin_mm: 40 }));
      assert.eq(r.ok, false, 'margin is capped at 25');
      const r2 = await page.evaluate(call('set_document', { title: 'night bus', paper: 'letter', printer_margin_mm: 3 }));
      assert.eq(r2.ok, true, r2.error);
      const s = await page.evaluate(`({ title: $('#title').value, paper: $('#paper').value, m: state.margin })`);
      assert.deepEq(s, { title: 'night bus', paper: 'letter', m: 3 });
    });

    t.check('Connect agent copies a prompt naming every tool and the real page size', async () => {
      await page.reset({ title: 'night bus', margin: 4 });
      const r = await page.evaluate(`(async () => {
        const btn = $('#agentBtn');
        const shown = btn.offsetWidth > 0;
        let copied = null;
        const real = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
          value: { writeText: t => { copied = t; return Promise.resolve(); } } });
        btn.click();
        for (let i = 0; i < 50 && !/Copied/.test($('#toast').textContent); i++) await new Promise(res => setTimeout(res, 10));
        delete navigator.clipboard;
        const g = geom();
        return { shown: shown, copied: copied, toast: $('#toast').textContent,
                 size: mmv(g.panelW) + ' × ' + mmv(g.panelH) + ' mm',
                 tools: AGENT_TOOLS.map(t => t.name) };
      })()`);
      assert.eq(r.shown, true, 'the button is in the toolbar on a wide screen');
      assert.ok(r.copied, 'something reached the clipboard');
      r.tools.forEach(n => assert.includes(r.copied, '- ' + n + ':', 'the prompt lists ' + n));
      assert.includes(r.copied, r.size, 'the page size is the real one');
      assert.includes(r.copied, '"night bus"');
      assert.includes(r.copied, '4 mm strip');
      assert.includes(r.copied, "callAgentTool('get_zine'", 'a way in for an agent that can only run JavaScript');
      assert.includes(r.toast, 'Copied a prompt');
    });

    t.check('without the async clipboard the prompt still copies the old way', async () => {
      await page.reset();
      const r = await page.evaluate(`(async () => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
          value: { writeText: () => Promise.reject(new Error('denied')) } });
        const exec = document.execCommand;
        let selected = null;
        document.execCommand = cmd => { selected = cmd === 'copy' ? String(getSelection() || document.activeElement.value) : null; return true; };
        const ok = await copyAgentPrompt();
        document.execCommand = exec;
        delete navigator.clipboard;
        return { ok: ok, selected: selected, left: document.querySelectorAll('body > textarea').length };
      })()`);
      assert.eq(r.ok, true);
      assert.includes(r.selected, 'get_zine', 'the prompt was what got copied');
      assert.eq(r.left, 0, 'the helper textarea is cleaned up');
    });
  }
};
