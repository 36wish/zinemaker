# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page editor for a **one-sheet zine**: eight panels imposed on one sheet of
paper that folds into a booklet. Upload images, set text, insert QR codes, export a
print-ready PDF. There is no flat single-page mode and no single-panel view — the
editor always shows a spread — and both were removed deliberately.

## Commands

There is no build, no package manager, no dependency, and no test framework. Three
files load directly in a browser.

```bash
# Run it: just open the file. No server needed.
start index.html                     # or drag index.html into a browser

# Tests — needs Chrome (set CHROME=<path> if it is somewhere unusual)
node test/run.js                     # everything, ~3s
node test/run.js "cut line"          # substring filter on "<suite> <test>"

# Syntax check after editing
node --check app.js && node --check qr.js
```

**Never add a bundler, a CDN `<script>`, or an npm dependency.** The app is required
to work offline from a `file://` URL *and* to be servable as a static GitHub Page —
that constraint is why the PDF writer, the QR encoder and the DOM rasteriser are all
hand-rolled here. The test suite obeys the same rule: Node 18+ has `fetch` and
`WebSocket` built in, so nothing needs installing.

### How the tests work

`test/run.js` collects `test/*.test.js`. Suites marked `browser: true` share one
headless Chrome opened on the local file; suites can also define `setup`/`teardown`
to manage their own (that is how the Pages suite starts a web server). Everything in
`app.js` is a top-level `function`/`const` in one classic script, so
`page.evaluate()` can call any of it directly — the tests drive the real code rather
than reimplementing it.

| suite | covers |
|---|---|
| `qr.test.js` | the encoder, in plain Node (`qr.js` is requireable) |
| `editor.test.js` | elements, spread selection, synthesised drag/rotate gestures, templates, undo |
| `print.test.js` | imposition, margins and guides, measured off the 300 dpi raster |
| `files.test.js` | the `.zine` container and the PDF, byte by byte |
| `pages.test.js` | the site served over HTTP from a project subpath |

Call `await page.reset({...})` at the top of a browser test; suites share one page,
so a test that skips it will inherit the previous one's document.

Two habits worth keeping. **Measure, do not eyeball** — panel seams, rim clipping and
PDF offsets have all been wrong at some point, and only pixel or byte measurement
caught it. And when a guide or hairline is involved, **project ink across the whole
axis rather than sampling one row**: a dashed line only inks a third of its length,
so a single scanline lands in a gap and reports a missing line that is really there.

## Architecture

### Files

- `index.html` — markup plus **two separate stylesheets** (see below).
- `app.js` — the whole editor. Sectioned by banner comments: state, persistence,
  history, elements, layouts, drawing, interaction, inspector, export, `.zine`, boot.
- `qr.js` — self-contained QR encoder, exposed as the global `QR`. Byte mode,
  versions 1–10, EC levels L/M/Q/H.
- `.nojekyll` — makes GitHub Pages serve the files verbatim.

Deploying is just publishing the repo root: there is no build step, every path is
relative so a project subpath works, and nothing is fetched from the network.

### The `#page-css` rule

`index.html` has two `<style>` blocks and the distinction is load-bearing:

- `<style id="page-css">` styles **panel content only** (`.panel`, `.el`, `.el-text`,
  `.el-img`, `.el-qr`, the `.f-*` photo filters). At export time its `textContent` is
  read verbatim and injected into the SVG used for rasterising. It must stay
  self-contained — no variables from the other sheet, nothing the export does not need.
- The second `<style>` is editor chrome (toolbar, inspector, selection handles, the
  printer-margin hatching). None of it reaches the export.

Putting a content style in the wrong block means it renders on screen and vanishes
from the PDF, or vice versa.

### Units

Everything geometric is in **points** (1/72"), including element `x`/`y`/`w`/`h` and
font sizes, so numbers map straight onto the PDF. `PT = 72 / 25.4` converts from
millimetres, which is what the UI shows the user. Element coordinates are always
**panel-local**, measured from that panel's top-left corner.

### State

One `state` object, autosaved to `localStorage` under `zinemaker.v1` on a debounce,
and sanitised through `fixDoc()` on load. The document is `state.docs.mini` (8
panels). Undo/redo snapshots `state.docs` as JSON, capped at 10 entries because
images live inline as data URLs. Loaders ignore the old `mode`, `spread` and
`docs.flat` fields, so files and storage written by earlier versions still open.

Images are **always data URLs**, never blob URLs. Canvas rasterisation of an SVG that
references a blob URL can taint the canvas on a `file://` origin; data URLs cannot.
Imports are downscaled to 1500px on the long edge to survive the ~5 MB storage budget.

### Imposition, spreads and the printer rim

Three related tables, all keyed by panel index 0–7 (page 1–8, cover first, back last):

- `IMPOSE` — where each panel prints on the landscape sheet, 4 columns × 2 rows. The
  top row prints **rotated 180°**.
- `SPREADS` — which panels face each other when folded: `back|cover`, `2|3`, `4|5`,
  `6|7`. Drives the two-up editing view.
- `unsafeEdges(pi)` — which edges of a panel fall on the sheet's unprintable rim,
  **in that panel's own orientation**. This is the subtle one: because the top row is
  upside down, the sheet's top edge is those panels' *bottom*. Every panel ends up
  losing its bottom edge; the four outer-column panels also lose one side.

A panel is always exactly `sheetW/4 × sheetH/2`. **Do not scale the artwork to fit a
margin** — an earlier version did, and it broke folding, because folds land on the
middle of the *paper*, not the middle of the artwork. The margin is a rim of the
sheet that gets clipped, not a scale factor.

### Rendering

`paintAll()` = `paintPage()` + `paintStrip()` + `buildInspector()`. `paintPage()`
rebuilds the visible spread into `#sheet` and keeps `nodes`, an id→DOM map.

The sidebar is two elements: `#inspector` (controls only) and `#help`, hidden until
the toolbar's Help button is pressed and built on demand by `helpHtml()`. **Explanatory
text belongs in `helpHtml()`, not in the inspector** — a test asserts the inspector
stays free of it. Help is rebuilt from `buildInspector()` so its margin note keeps
describing the active panel.

Two invariants worth knowing before touching it:

- **Never rebuild the DOM under a live caret.** While `editingId` is set,
  `paintPage()` only restyles existing nodes; rebuilding would blur the
  contenteditable. Anything structural calls `stopEdit()` first.
- Selection may live in either half of a spread, so look elements up with
  `findSel()` / `elById()` rather than assuming `state.active`. Mutating actions use
  `selPanel()`, not `panel()`.

Zoom is a CSS `scale()` on `#sheet` with `transform-origin: top left`, and
`--iz` (its inverse) is set alongside so handles and hairlines can counter-scale.
`#sheetBox` is sized to the *scaled* dimensions to keep page layout honest.

### Export

`buildSheetNode()` → `rasterize()` → JPEG → `buildPDF()`, with no library at any step:

1. `buildSheetNode()` assembles the full sheet off-screen, placing every panel per
   `IMPOSE`, then paints a white border of `margin` over the top as the unprintable
   rim.
2. `rasterize()` serialises that DOM into an SVG `<foreignObject>` (with `page-css`
   prepended), loads it as a data-URL image and draws it to a canvas at 300 dpi. This
   is why images must be data URLs and fonts must be system fonts — an SVG loaded as
   an image cannot fetch anything.
3. `buildPDF()` writes the PDF by hand: one page, one baseline-JPEG XObject scaled to
   the MediaBox. It tracks byte offsets for the xref table, so **any change to what
   gets written must keep `off[]` and the `/Length` values in step**.

### The `.zine` file

Binary container, format version 2, written by `saveZine()` and read by `readZine()`:

```
"ZINE" │ u8 version │ u8 flags │ u32 meta length │ u32 image count │ meta │ images…
```

Metadata is UTF-8 JSON deflated with `CompressionStream` (flag bit 0; falls back to
raw if the API is missing). Images follow as length-prefixed **original bytes**, not
base64 — that alone is a quarter smaller, and they are not deflated because JPEG/PNG
will not compress further. Duplicate images are stored once and referenced by index;
elements carry `asset` in place of `src`, swapped back on load.

`readZine()` sniffs a leading `{` and still parses the plain-JSON format version 1.
Keep that path when changing the format.

## Other agent configs

A `~/.gemini` directory exists on this machine. If you want its user-level items
(MCP servers, commands, subagents, skills, instructions) available in Claude Code,
reply `/import` to scan and list what is importable, then `/import --yes=<digest>`
using the digest the scan prints. If `/import` is unavailable on this surface, run
`claude import` from a terminal instead.
