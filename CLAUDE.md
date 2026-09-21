# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page editor for a **one-sheet zine**: eight panels imposed on one sheet of
paper that folds into a booklet. Upload images, set text, insert QR codes, export a
print-ready PDF. There is no flat single-page mode — a separate layout that showed
the whole imposed sheet rather than a spread — and it was removed deliberately.
The document itself is still always a spread of facing panels; on a phone only,
`state.singleView` lets the *screen* show just the active one at a time (see
"Small screens"), which is a display choice `visiblePanels()` makes, not a second
editing model — `SPREADS`, `IMPOSE` and export never hear about it.

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
| `mobile.test.js` | the phone layout, measured on an emulated handset |
| `pages.test.js` | the site served over HTTP from a project subpath |

Call `await page.reset({...})` at the top of a browser test; suites share one page,
so a test that skips it will inherit the previous one's document. The same goes for
the viewport: `page.emulate(w, h)` puts the shared window into a handset — size,
pixel ratio and a touch screen, so `pointer: coarse` resolves — and whoever calls it
owes a `page.unemulate()` in their teardown.

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

### Small screens

One breakpoint, `max-width: 860px`, and `narrow()` in `app.js` reads the same query
so the script and the stylesheet cannot disagree. Under it the sidebar stops being a
column and becomes a sheet that slides up over the stage, toggled by `#panelBtn` and
`setSide()`; `body.side-open` is the only state. **Never hide the inspector on a
phone** — it is the only place most controls exist, which is what the earlier
breakpoint got wrong. Help shares that sheet, so `setHelp(true)` opens it.

**On a phone, `#panelBtn` and its sheet (`#side`) mean the whole project, full
stop — never a page or a selected element.** `inspectorForPage()` is split into
`pageSectionHtml()` ("This page": panel colour, layout, clear panel) and
`projectSectionHtml()` ("Whole project": printer margin, print guides);
`buildInspector()` puts only `projectSectionHtml()` into `#inspector` when
`narrow()`, `inspectorForEl(el)` when wide and something is selected, and the
full `inspectorForPage()` (both sections concatenated) when wide and nothing
is. "This page" and a selection each get their own independent bottom sheet
instead, and the two are mutually exclusive by construction — one needs
`selected()`, the other needs `!selected()` — so they never contend for the
same tab: `#elemDrawer`, shown by `syncElemDrawer()` whenever something is
selected, and `#pageDrawer`, its mirror image, shown by `syncPageDrawer()`
whenever nothing is. Both start closed (`.elem-peek` only, not `.open`) the
moment they appear rather than sprung open, and tapping their own peek bar
(`#elemPeek` / `#pagePeek`) is the only thing that opens either
(`elemDrawerOpen` / `pageDrawerOpen`). `#pageDrawer` reuses `#elemDrawer`'s CSS
wholesale by sharing its `.elem-drawer` class — `.page-drawer` is just a JS
hook, not a separate stylesheet rule. All three sheets share the bottom edge,
so `body.side-open .elem-drawer` pushes both drawers off screen while `#side`
is open rather than letting them stack — the two are equivalent bottom-sheet
CSS (`transform: translateY`, sliding up), just their closed position leaves
their own peek bar on screen instead of going fully off it. `wireInspector()`
takes the container to wire as a parameter now, since `#inspector`,
`#elemInspector` and `#pageInspector` all need it and never share markup
(`data-k` and its siblings only ever appear in `inspectorForEl`'s output);
`syncInspector()` (used mid-drag, so it must not rebuild anything) only ever
targets `#inspector` or `#elemInspector`, since it bails out immediately when
nothing is selected and `#pageDrawer` only ever shows when nothing is. On a
wide screen `#elemDrawer` and `#pageDrawer` stay `hidden` and the one sidebar
column behaves exactly as it always did.

The title, paper size and the open/save buttons live in the toolbar on a wide
screen but have nowhere to go on a phone, so `MOBILE_SETTINGS` in `app.js` moves
the real elements — not clones — into a "Document" group at the top of the sheet
(`#docSettings`, with `#slotTitle`/`#slotPaper`/`#slotOpen`/`#slotSave` as the
landing spots). `captureMobileAnchors()` drops a comment node in front of each one
the first time it runs, so `layoutMobileControls()` can put it back with
`marker.after(el)` on a wide screen; nothing is cloned, so there is no second copy
to keep in sync. `syncDocSettings()` drives both the move and `#docSettings`'
visibility, and hides that whole group while help is open rather than moving
anything — help and the document group share the one sheet. It runs from `init()`,
from `setHelp()`, and from the `resize` handler, so crossing the breakpoint either
way sorts itself out. **Scope any CSS aimed at the toolbar's copy of these
elements to `.bar`** (e.g. `.bar #title`), because an ID selector still matches
them after they move.

What is left in the toolbar (the icon buttons and the export split) still has to
fit one row on any phone, not just the ones a breakpoint was written for, so
`fitBar()` in `app.js` shrinks it by however much that width actually needs
rather than by a fixed step. It writes a `--bar-scale` custom property that the
narrow media query's `calc()` rules read back for padding, icon size, gap and
the two remaining text buttons' font size; a wide screen never sets it, so
`var(--bar-scale, 1)` falls back to full size everywhere. Measuring the overflow
takes a `.measuring` class that forces one line — `flex-wrap` normally absorbs
it before `scrollWidth` would ever show it, and `overflow: hidden` plus
`flex-shrink: 0` on the children are both needed too, or the browser quietly
shrinks or hides the same overflow instead of reporting it. **`.bar` needs
`min-width: 0`** — a flex/grid item's own minimum otherwise defaults to its
content's, so unshrinkable children could grow the toolbar's own grid track
past the window instead of ever registering as overflow. Division from one
measurement isn't exact (borders and glyphs do not shrink in step with
padding), so it loops a few times, and aims a couple of pixels under budget —
a fit measured to the exact pixel in the forced single-line layout can still
round the wrong way once `flex-wrap` gets to decide for real, which costs a
whole line. Runs from the same places as `syncDocSettings()`, after it, since
moving the document controls out is what the bar's remaining children measure
against. **Never measure that overflow with `scrollWidth`** — it is defined as
never less than `clientWidth`, so once a trial scale shrinks the row below a
comfortable fit it reads back exactly `clientWidth` no matter how much smaller
the row actually got, and the loop can never tell it has already succeeded.
Measure to the last child's own right edge instead, which has no such floor.

On a phone, `#viewToggle` and `setSingleView()` let `state.singleView` show just
`state.active` instead of its spread — `visiblePanels()` is the only other place
that reads the flag, and only under `narrow()`, so a wide screen ignores it even
if it was left on. Persisted like `margin`/`cut`/`guides` (`load()` restores it,
`save()` writes the whole `state`), but **never written into the `.zine` file** —
`saveZine()`'s `meta` is an explicit field list and deliberately leaves it out,
since it is a viewing preference for this screen, not part of the document.

Touch is not just a narrower mouse:

- `.sheet .el { touch-action: none }` — without it the browser claims the drag for
  scrolling and the element never moves. Bare panel keeps the default, so a drag on
  empty paper still scrolls the stage.
- Cancelling that drag cancels the synthesised `dblclick` with it, so
  `doubleTapped()` recognises a double tap on text for `pointerType` touch and pen.
  The mouse, and the test suite's own gestures, keep the real `dblclick`.
- `@media (pointer: coarse)` grows the hit areas, the selection handles included —
  they counter-scale with `--iz`, so those sizes are screen pixels.
- Form controls go to 16px on a narrow screen, below which iOS zooms the whole page
  in when one takes focus.

`fitZoom()` measures the strip, the labels and the stage padding rather than
assuming a desktop window, and `paintStrip()` calls it once the thumbnails exist,
since their height is part of the sheet's budget.

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
