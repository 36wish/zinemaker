# Zine Maker

A single-page editor for a **one-sheet zine**: eight panels imposed on one
sheet of paper that folds into an eight-page booklet. Upload images, set
text, insert QR codes, and export a print-ready PDF.

No build step, no package manager, no dependencies, no server. Three files —
`index.html`, `app.js`, `qr.js` — load directly in a browser, online or off.

## Using it

Just open `index.html` in a browser, or drag it in.

```bash
start index.html      # or: open index.html / double-click it
```

It also works served as a static site (e.g. GitHub Pages) from any subpath,
since every asset path is relative and nothing is fetched from the network.

### Editing

- The editor always shows a **spread**: the two pages that face each other
  once the sheet is folded — back and cover, then 2 and 3, 4 and 5, 6 and 7.
  Click a page, its label, or a thumbnail in the strip (grouped in the same
  pairs) to make it the one that receives new elements. Turn pages with the
  arrows beside the sheet, Page Up/Down, or a swipe on a phone — which shows
  one page at a time by default.
- Add text, drop in images, or insert a QR code from the toolbar.
- Double-click text, or click it again once selected, to edit it in place.
- Drag elements to move them, use the corner/edge handle to resize, and the
  handle above to rotate.
- Pick a layout template from the sidebar to pour existing content into a
  new arrangement. Photo slots with nothing to fill them become dashed
  "Add photo" frames: click one or drop a photo on it. Frames never print.
- Dragging snaps to page edges, centres and the printer margin; hold Alt to
  place freely. Positions and sizes are shown in millimetres.
- Drag anything over the fold and it moves to the page it lands on.
- Select a photo or a line of text and press **Both pages** to run it across
  the fold, printing straight through the crease onto the facing page. The
  two wide layout templates fill a whole spread the same way.
- Undo/redo with Ctrl/Cmd+Z (Shift to redo), or the toolbar buttons — up to
  100 steps. Layouts, clearing a page, deleting and opening a file also offer
  an Undo button straight away instead of asking first.
- Drop a `.zine` file anywhere on the page to open it.

### Printer margin and guides

The sidebar's **Printer margin** control marks a rim around the sheet that
most home printers can't reach; whatever falls in it will be clipped. This
is not a scale — panels always stay exactly a quarter of the sheet wide and
half tall, so folds line up — so pushing artwork past the margin line means
it's cropped, not shrunk. **Print guides** can overlay panel outlines and a
cut-line marker to help lining up the physical fold and cut.

### Saving

Everything autosaves to the browser's local storage as you work (about 5 MB
of budget). To keep a copy or move a project between machines, use:

New, Open and Save are in the toolbar's **File** menu (in the settings sheet on
a phone).

- **New** — deletes the whole zine and starts a blank one (undo brings it
  back).
- **Save** — writes a `.zine` file, a self-contained project file including
  every image. See [`fileformat.md`](fileformat.md) for the exact format.
- **Open** — loads a `.zine` file, replacing what's on screen (undo brings it
  back).

### Exporting

- **Export PDF** — renders the full imposed sheet at 300 dpi and writes a
  single-page, print-ready PDF.
- **Export PNG** — the same 300 dpi render as a plain image.

After an export the app shows these folding steps with a diagram (you can
turn that off). Print the PDF single-sided on one sheet, fold it down the two guide creases,
then cut along the centre slit to open it into an eight-page booklet.

## Development

No build, no package manager, no dependency, no test framework beyond what's
in this repo.

```bash
# Syntax check after editing
node --check app.js && node --check qr.js

# Tests — needs Chrome (set CHROME=<path> if it's somewhere unusual)
node test/run.js                     # everything, ~3s
node test/run.js "cut line"          # substring filter on "<suite> <test>"
```

See [`CLAUDE.md`](CLAUDE.md) for the full architecture writeup (imposition
tables, rendering pipeline, mobile layout, export internals, and so on), and
[`fileformat.md`](fileformat.md) for the `.zine` container and PDF formats.

Layouts in `app.js`'s `TEMPLATES` array are hand-written as fractions of a
panel, which is tedious to eyeball. `tools/template-editor.html` is a
standalone dev tool (not linked from the app) for laying a template out
visually — drag slots, tweak them in a form, copy the generated object
straight into `TEMPLATES`.

**Never add a bundler, a CDN `<script>`, or an npm dependency.** The app is
required to work offline from a `file://` URL and to be servable as a static
site with nothing to build — that's why the PDF writer, the QR encoder, and
the DOM rasteriser are all hand-rolled here.

## License

No license file is included; treat the code as all-rights-reserved unless
the repository owner says otherwise.
