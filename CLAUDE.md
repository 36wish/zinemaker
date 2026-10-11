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
to be servable as a static GitHub Page (or any other plain static host) with no
build step — that constraint is why the PDF writer, the QR encoder and the DOM
rasteriser are all hand-rolled here. It is not required to work from a `file://`
URL; the app is meant to be hosted. The test suite obeys the same no-dependency
rule: Node 18+ has `fetch` and `WebSocket` built in, so nothing needs installing.

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
| `usability.test.js` | settings hand-back, mm fields, labels, photo frames, page turning, snapping, swatches, undo toasts and depth, fold guide |

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
panels). Undo/redo snapshots `state.docs` as JSON, capped at `HISTORY` (100)
entries. Snapshots are in-memory only and never touch `localStorage`, and they do
**not** carry photos: `snapshot()` swaps every long `src` for an `@img:n` reference
into a session-long pool (`srcRef`/`refSrc`) and `restore()` swaps it back, so a
step costs a few KB however many photos the zine has. **Take snapshots with
`snapshot()` and record them with `recordHistory()`**, never
`JSON.stringify(state.docs)` straight into `hist` — `drag()` included — or the
photos go back into every entry. `recordHistory()` also dismisses an Undo toast,
since its button would now undo something else. Loaders ignore the old `mode`,
`spread` and `docs.flat` fields, so files and storage written by earlier versions
still open.

Images are **always data URLs in memory**, never blob URLs — an SVG loaded as an
image for export cannot fetch a blob URL's bytes, so `rasterize()` needs a data URL
regardless of where the app is hosted. But a zine with more than a couple of photos
would blow well past `localStorage`'s ~5 MB budget if those data URLs sat in the
JSON `save()` writes, which is why the bytes themselves live in IndexedDB instead
(see "Image storage" below); imports are still downscaled to 1500px on the long
edge, since nothing is served at higher resolution than that on a 74mm-wide panel.

### Image storage

Image elements carry `assetId` — a content hash of the image's bytes — instead of
`src` once `saveNow()` (inside `save()`'s debounce) has migrated them: `migrateImages()`
hands any element that still only has an in-memory `src` and no `assetId` to
`putImage()`, which hashes it with `contentId()`, stores it in the `zinemaker-images`
IndexedDB database keyed by that hash, and returns the id. Because the id is a pure
function of the bytes, two elements — or two saves — sharing a photo end up sharing
one row for free, the same dedup `saveZine()` does independently for the `.zine`
file's own asset table. `saveNow()` then writes `state` to `localStorage` with `src`
stripped from every element that has an `assetId`, so the JSON blob never carries
image bytes.

`load()` does the reverse through `hydrateImages()`: every element with an `assetId`
but no `src` gets one rebuilt from IndexedDB via `getImage()` and `bytesDataUrl()`.
That is also the only point that calls `pruneImages()` to delete IndexedDB rows
nothing in the freshly loaded document references any more — safe only there,
because undo/redo history (the other thing that could still need an old image) lives
in memory and never survives a reload. Nothing is pruned mid-session: an element
that stops using a photo just leaves its row orphaned until the next load.

A freshly added image, or one read back from an opened `.zine` file, is just an
element with `src` and no `assetId` yet — it needs no separate code path, since
`migrateImages()` picks it up the next time anything calls `save()`. If IndexedDB is
unavailable, `migrateImages()`/`hydrateImages()` fail quietly and elements keep
their `src` inline, falling back to exactly the pre-IndexedDB behaviour (and its
~5 MB ceiling).

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

One fact falls out of `IMPOSE` and is load-bearing for everything in "Across the
fold" below: **every spread is two adjacent cells in the same row, at the same
rotation, with the left-hand page on the reading-left side** — `back|cover` at row 1
cols 2→3, `2|3` at row 0 cols 3→2, `4|5` at row 0 cols 1→0, `6|7` at row 1 cols
0→1. The two halves of a spread are therefore physically continuous on the paper,
the only cut (the slit) is horizontal so it never crosses a gutter, and
`unsafeEdges()` only ever puts the rim on a spread's *outer* edges, never the fold.
A test derives this from `IMPOSE` rather than trusting it.

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

The inspector shows geometry in **millimetres** — every other number the user sees
is mm — while the document stays in points. A field marked `data-mm` is converted
at the edge: `mmv()` on the way out (`inspectorForEl()`, `syncInspector()`) and
`× PT` in `wireInspector()`'s apply. Font size stays in points, labelled so. Labels
are plain words ("Line spacing", "Damage tolerance", "Layer order"); the layer
buttons avoid "Back"/"Front" because the back cover is a page called "back", and
the UI says **page**, never panel — `panel` is the code's word only.

Colour controls go through `colourField()`: the native picker plus `PRESETS` and
up to five recent custom colours, as `.sw` buttons carrying the **same target
attribute** as their picker (`data-k="color"`, `data-page="bg"`…), so one handler
routes both. Recents are a per-browser convenience under `zinemaker.colours`, not
document state.

Big, sweeping actions — a layout, clearing a page, deleting, opening a file — act
at once and call `undoToast()` after their `pushHistory()`, rather than asking
first with `confirm()`. Only "Start a new zine" still confirms, since undo history
does not survive a reload.

A **click** that does not move goes to `drag()`'s `onTap`: on text that was already
selected it starts editing at the click (`caretRangeFromPoint`), and on an empty
photo frame it opens the picker. The `dblclick` handler must not restart an edit
already running, or it throws that caret to the end. A move drag also snaps
(`snapMove()`) to page edges, centres and the printer margin lines of every visible
page, drawing `.snap-guide`s into `#sheet`; Alt skips it.

### Photo frames

A layout slot with no photo to pour becomes an **empty frame**: an `image` element
with `src: ''` (`emptyFrame()`). `makeNode()` draws it as a `div.body` inside
`.el.empty`, and its dashed look is **editor chrome, not `#page-css`**, so the export
draws nothing there — that is the whole of how frames stay out of print. Real
photos fill slots before frames do, so reapplying a layout reuses frames instead of
stacking new ones. `chooseFrame(id)` sets `fillTarget` and opens the file picker;
`addImageFiles()` puts the first file into that element at its own size (also how
"Replace photo" works), and dropping a file on a frame fills it. Every storage and
file path already tolerates `src: ''`: `migrateImages()` gets no bytes from it and
`saveZine()` keeps it inline.

### Photo masks

`el.shape` picks a mask from `SHAPES` (square, rounded, circle, oval, arch, star,
burst, heart, hexagon, diamond, triangle). `styleNode()` sets it as an **inline**
`clip-path` on the image body via `shapeClip(el)`, so it travels into the export
with the node and needs nothing in `#page-css`. Polygons are in percent so they
stretch with the frame; `circle` stays round, and `rounded`/`arch` are computed
in px from `w`/`h`. `print.test.js` measures the mask off the raster.

### Across the fold

An element with `span` set runs over the gutter onto the facing page. It is still
owned by exactly one panel and still carries that panel's local coordinates; what
changes is that it gets **painted twice** — once on its own page and once in the
facing panel offset by one panel width, which is what the adjacency fact above
makes possible. Each panel goes on clipping itself, so nothing leaks onto a page
that is not facing, and the two clipped halves meet exactly on the fold.

- `spanPartner(pi)` — the facing panel and the `dx` to draw this panel's elements at
  over there: `-panelW` for a left-hand page, `+panelW` for a right-hand one.
- `guestsFor(pi)` / `paintList(pi)` — what paints on a panel, back to front: its own
  elements with the facing page's spanning ones spliced in **at the layer index they
  hold over there**, so a spanning element keeps its layer number on both pages and
  `layer()` needs no special case. All three painters go through `paintList()` —
  `paintPage()`, `paintStrip()` and `buildSheetNode()` — which is the whole of what
  export had to learn.
- `nodes` is the element's own interactive node; `guestNodes` is the copy in the
  facing panel, carrying its offset in `dataset.dx`. **Restyle through `restyle(el)`,
  not `styleNode()`**, or the two halves drift apart mid-drag. Typing is the one
  thing `restyle()` cannot cover: `paintPage()` will not rebuild under a live caret,
  so `startEdit()`'s `oninput` copies the text across by hand. A copy never holds
  the caret, though, so under one `paintPage()` still adds and drops the copies
  themselves (`syncGuests()`) — otherwise "Both pages" on a text box still being
  typed in, which is every new one, sets the flag and paints nothing.

The fold is not a wall for *any* element, spanning or not:

- `clampPos()` keeps an element inside `spreadRange(pi)` — the whole spread — rather
  than inside the one panel, and `rehome()` hands it to the facing page when its
  **centre** crosses, shifting `x` by one panel width so coordinates stay panel-local
  and the handles stay on the half you can grab. That is also the editor's only
  "move this to the other page" gesture.
- An element that is not spanning would vanish into the gutter mid-gesture, so for
  the length of a move, resize or rotate `crossingId` lends it the same second copy
  a spanning one keeps. Lending it repaints the sheet, which is why **the move drag
  takes its deltas straight off the pointer** rather than through `pageXY()`, and
  resize looks its node up afresh on every move — the node the gesture started on
  is gone by then. Rotate measures its centre once, up front.
- **A gesture that leaves an element reaching over the fold turns `span` on** —
  dragged across, it stays across, which is what people expect and what the
  lent copy has just shown them. `overFold()` decides "reaching over", rotation
  included and ignoring an edge flush against the fold. The exception is an
  element that already reached over when the gesture began with `span` off: that
  is "One page" chosen while it straddles, a deliberate clip at the fold, and a
  nudge keeps it. One undo takes back the gesture and the span together.
- A template marked `spread` measures x and w across both pages (0 is the left-hand
  page's left edge, 2 the right-hand page's right edge) and everything it places
  spans; on a right-hand page `applyTemplate()` shifts the whole thing back by a
  panel. Heights and text sizes stay panel-relative so type does not double.

Two things measured rather than assumed, both in `print.test.js`:

- A block straddling the fold rasters as **one** unbroken run of ink, full width,
  centred on the crease — checked for both rotations and for an element owned by
  either half, because each has its own sign.
- The join keeps one lighter pixel on the fold, and **this is known, measured and
  deliberately left alone**. The two clipped halves do not quite cover the device
  pixel they share, so whatever is under them shows through: about 48 of 255 through
  black ink at 300 dpi, one pixel wide (0.085 mm), and it survives the PDF's JPEG at
  quality 0.94. It is the panel model's, not the span's — two plain adjacent panels
  of the same colour leave 27 the same way with nothing crossing them, which is what
  the control in that test measures.

  Before trying to fix it, know what has already been ruled out. It is a real
  geometric residue, not sequential-compositing loss, so nothing that only reorders
  or recolours the layers touches it — only ink drawn across that pixel *without* a
  clip fills it. Laying the element down a third time underneath, across the whole
  spread, and moving the two panels' backgrounds onto that bed so they stop painting
  paper into the residue, does work: 48 → 0, measured. It was still not kept, because
  making those panels transparent is what lets the bed show through, and it then
  shows through *everywhere*, not just in the residue — so anything translucent or
  soft-edged renders doubled (an `opacity: 0.5` element composites to 0.75, and a
  scaled image's soft edge reads about 0.6 pt wider). Trading a hairline for wrong
  opacity is a bad trade. Do not chase it by rounding panel geometry either — a
  panel is exactly a quarter of the sheet. The honest fix is to stop clipping per
  panel: one spread-wide box with a `clip-path` per element, so a spanning element
  simply has no clip and nothing is ever drawn twice. That is a rewrite of the
  rendering model, not a patch.

### Small screens

One breakpoint, `max-width: 860px`, and `narrow()` in `app.js` reads the same query
so the script and the stylesheet cannot disagree. Under it the sidebar stops being a
column and becomes a sheet that slides up over the stage, toggled by `#panelBtn` and
`setSide()`; `body.side-open` is the only state. **Never hide the inspector on a
phone** — it is the only place most controls exist, which is what the earlier
breakpoint got wrong. Help shares that sheet, so `setHelp(true)` opens it.

**`#panelBtn` ("Print settings" on a wide screen) means the whole project, full
stop — never a page or a selected element — and that now holds at every width,
not just on a phone.**
`inspectorForPage()` is gone; the old "This page" + "Whole project" markup is
split into `pageSectionHtml()` and `projectSectionHtml()`, and nothing ever
concatenates them back together. `buildInspector()` puts `projectSectionHtml()`
into `#inspector` whenever `narrow() || sideOpen`, `inspectorForEl(el)` when
neither and something is selected, and `pageSectionHtml()` when neither and
nothing is. `sideOpen` therefore means two different things depending on
width — on a phone it is `#side`'s open/shut sheet state, and on a wide
screen there is no sheet to open, so it is simply the settings button's own
toggle for which of the three the one sidebar column is showing — but it is
the one flag both read, so `setSide()` calls `buildInspector()` on every
flip and a wide screen's column swaps in place instead of sliding. On a wide
screen, `buildInspector()` turns the project view back off (`setSideState(false)`)
as soon as something other than `sideSel` — whatever was selected when it opened —
is selected, or a fresh selection's controls would be hidden behind it.

On a phone, "This page" and a selection each also get their own independent
bottom sheet, on top of that column, since there is no room to show either
beside the stage at all: `#elemDrawer`, shown by `syncElemDrawer()` whenever
something is selected, and `#pageDrawer`, its mirror image, shown by
`syncPageDrawer()` whenever nothing is — mutually exclusive by construction,
since one needs `selected()` and the other needs `!selected()`, so they never
contend for the same tab. Both start closed (`.elem-peek` only, not `.open`)
the moment they appear rather than sprung open, and tapping their own peek
bar (`#elemPeek` / `#pagePeek`) is the only thing that opens either
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
wide screen `#elemDrawer` and `#pageDrawer` stay `hidden`, since the one
sidebar column already covers what they are for.

The title, paper size and the new/open/save buttons live in the toolbar on a wide
screen — new/open/save inside the File menu (`#fileWrap`), where `.menu-label`
gives them long names — but have nowhere to go on a phone, so `MOBILE_SETTINGS` in `app.js` moves
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

With one page on screen, the facing page's spanning ink is **still painted** — it
prints on this page, so it is shown on this page — but it is not this page's to edit:
`elById()` cannot see it, so a tap on it falls through to a blank-paper click, and
`spreadRange()` / `rehome()` / `overFold()` all fall back to the single panel, so
nothing can be dragged onto a page that is not on screen, nor made to span by
bleeding off the edge. Pressing "Both pages" in one-page view calls
`setSingleView(false)` instead, because there the other half has nowhere to show
and the element would just look cut off at the page edge.

On a phone, `#viewToggle` and `setSingleView()` let `state.singleView` show just
`state.active` instead of its spread — `visiblePanels()` is the only other place
that reads the flag, and only under `narrow()`, so a wide screen ignores it even
if it was left on. **One page is the phone default**: a spread on a portrait phone
is half the size. `load()` applies that default unless `viewPref` says the view was
chosen by hand (`setSingleView()` sets it), since older storage holds an explicit
`false` that was only ever the old default. The toggle's icon shows the view in
effect. Persisted like `margin`/`cut`/`guides` (`load()` restores it,
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
- A quick sideways swipe on the stage turns the page (`turnPage()`), read from
  touch events because the browser cancels the pointer stream on a pan. Not on an
  element, the strip, or a drawer.
- With the element drawer open, `keepSelInView()` slides `.paper-wrap` up by a
  transform just far enough to show the selection above it, and back when it shuts;
  `curShift` lets it measure from the resting position.

`fitZoom()` measures the strip, the labels and the stage padding rather than
assuming a desktop window, and `paintStrip()` calls it once the thumbnails exist,
since their height is part of the sheet's budget. `#sheetLabels` (the page-name
row above the sheet) is hidden outright on a phone — the thumbnail strip below
already does the same job of switching pages, and dropping the row hands its
space back to the sheet — so `fitZoom()` treats its height as 0 there rather
than falling back to a desktop guess. The stage's own bottom padding on a
phone reserves room for whichever of `#elemDrawer` / `#pageDrawer` is peeking
(always one of them, since they are mutually exclusive — see "Small screens"
above), so the thumbnail strip scales to fit above it instead of under it.

Pages turn with `turnPage()` — by spread when a spread is showing, by page in
reading order in one-page view — from `#prevPage`/`#nextPage` (in the stage's
side gutter on a wide screen, hidden on a phone), Page Up/Down, ←/→ when nothing is
selected, or a swipe. The thumbnail strip is drawn in `.pair`s following `SPREADS`,
so it reads exactly as the stage does.

On a wide screen the toolbar must stay one row too: below 1340px the save note and
the secondary buttons' words (`.btn-label.opt`) go, below 1120px the logo and
dividers, below 1000px "Export". The add buttons keep their words throughout.

Zoom is a CSS `scale()` on `#sheet` with `transform-origin: top left`, and
`--iz` (its inverse) is set alongside so handles and hairlines can counter-scale.
`#sheetBox` is sized to the *scaled* dimensions to keep page layout honest.

### Export

After a successful export, `showFoldGuide()` opens `#foldDialog` with
`foldDiagram()` and numbered steps (`foldStepsHtml()`, which follows the trim
setting). "Don't show after every export" is a per-browser preference under
`zinemaker.foldGuide`. The harness's `reset()` closes it, since tests export.

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

`span` rides inside `docs` and needs nothing of its own here, but it is stored as a
flag that is either present or absent — `fixDoc()` coerces and **never writes a
stored `false`** — so files written before it existed stay byte for byte what they
were.

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
