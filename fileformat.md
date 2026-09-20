# File formats

Zine Maker reads and writes three file formats: its own `.zine` project
container, an exported print-ready PDF, and (for the PNG "export" button) a
plain raster PNG. This document describes the two structured formats — `.zine`
and the PDF — byte by byte. The PNG is just a rasterisation of the sheet with
no extra structure, so it isn't covered further.

All geometry inside a document is in **points** (1/72"), matching the PDF page
space it is eventually placed into. `PT = 72 / 25.4` is the conversion factor
used anywhere the UI takes millimetres.

## The `.zine` container

A `.zine` file is one self-contained binary file: everything needed to reopen
the project, with no assets alongside it. It is written by `saveZine()` and
read by `readZine()` in `app.js`.

### Layout (format version 2)

```
offset  size  content
0       4     magic bytes "ZINE" (0x5A 0x49 0x4E 0x45)
4       1     container format version (currently 2)
5       1     flags — bit 0 set means the description below is deflated
6       4     uint32 LE — byte length of the description
10      4     uint32 LE — number of images that follow
14      N     the description: UTF-8 JSON, deflated unless the flag says not
14+N    ...   images, one after another
```

Each image is stored as:

```
size  content
4     uint32 LE — byte length of this image
n     the image's original bytes (JPEG/PNG as captured, not re-encoded)
```

Images are stored as their **original file bytes**, not the base64 data URLs
the editor keeps in memory — a quarter smaller on its own — and are left
uncompressed, since JPEG/PNG data will not deflate any further. Identical
images (compared by their data-URL string) are stored once and referenced by
index from every element that uses them.

The JSON description is deflated with the standard `CompressionStream`
('deflate') API when available; if that API is missing (or fails), it falls
back to storing the raw UTF-8 JSON and clears flag bit 0 accordingly.

### The description JSON

```json
{
  "format": "zine",
  "formatVersion": 2,
  "app": "zinemaker",
  "saved": "<ISO 8601 timestamp>",
  "title": "<string>",
  "paper": "a4" | "letter",
  "margin": <number, millimetres>,
  "cut": <bool>,
  "guides": <bool>,
  "assets": [ { "type": "<mime type>", "bytes": <length> }, ... ],
  "docs": { "mini": { "panels": [ /* 8 panels */ ] } }
}
```

- `paper` selects a page size from the `PAPER` table (A4 or US Letter,
  portrait millimetres; the sheet itself is landscape, double that footprint).
- `margin` is the printer's unprintable rim, in millimetres, clamped to
  0–25.
- `cut` / `guides` toggle the cut-line and panel-outline print guides.
- `assets` is metadata only (mime type and byte length) for the images that
  follow the description in the file; it exists for inspection/diagnostics,
  not for reconstructing images — the actual bytes are the length-prefixed
  blobs after the description.
- `docs.mini` is the only document today (`docs.flat` and other legacy modes
  are ignored on load): an array of exactly 8 panels, indexed 0–7 as
  page 1 (front cover) through page 8 (back cover).

#### Panel

```json
{ "bg": "<CSS colour>", "els": [ /* elements, back to front */ ] }
```

`els` is ordered back-to-front (painting order); later entries draw on top.

#### Element (common fields)

Every element has:

- `type`: `"text"` | `"image"` | `"qr"`
- `x`, `y`: position in points, from the panel's own top-left corner
- `w`: width in points
- `rot`: rotation in degrees

An **image** element additionally carries `asset` — an integer index into the
image table described above — in place of the in-memory `src` field (which
holds a data URL only while the document lives in `state`/`localStorage`, not
in the saved file). `saveZine()` strips `src` and adds `asset`; `readZine()`
does the reverse, rebuilding a data URL from the stored bytes and the
recorded mime type.

Type-specific fields, as produced by the editor:

- **text**: `text`, `font` (index into the `FONTS` table), `size` (points),
  `color`, `align` (`left`/`center`/`right`), `lh` (line-height multiplier),
  `ls` (letter-spacing, px), `bold`, `italic`, `bg` (highlight colour, or
  `''` for none), `pad`.
- **image**: `h` (height, points — the only element type with an explicit
  height besides `qr`), `fit` (`cover`/`contain`), `filter` (one of the
  `FILTERS` presets), `opacity`, `radius` (corner radius, points).
- **qr**: `h` (always equal to `w` — QR codes are always square), `text` (the
  encoded payload), `ecl` (error-correction level `L`/`M`/`Q`/`H`), `dark`/
  `light` (module/background colours), `quiet` (quiet-zone width in modules),
  `opacity`.

Unknown keys are ignored on load and missing ones fall back to defaults
(`fixDoc()` in `app.js`), so files written by either an older or newer version
of the app still open.

### Backward compatibility: format version 1

`readZine()` sniffs the first byte of the file: if it is `{` (0x7B), the whole
file is treated as **plain JSON** — the entire description object above,
without the binary header, length-prefixed image table, or deflate — and
images are inline data URLs in each element's `src`, exactly as they sit in
memory. This was the original (`formatVersion: 1`) format, before images were
split out as a separate, non-base64 table. That path is kept indefinitely so
old files keep opening.

If a file declares a `formatVersion` newer than the app's own `ZINE_FORMAT`,
it is still opened — on the assumption that the description JSON degrades
gracefully — with a toast warning that it was saved by a newer version.

## The exported PDF

`exportSheet('pdf')` produces a single-page, print-ready PDF with no external
library:

1. `buildSheetNode()` assembles the full landscape sheet off-screen: all 8
   panels placed per the `IMPOSE` imposition table (4 columns × 2 rows, top
   row rotated 180°), print guides (cut line / panel outlines) drawn over the
   artwork if enabled, then a white rectangle painted over the outer rim to
   represent the unprintable margin.
2. `rasterize()` serialises that DOM into an SVG `<foreignObject>` (with the
   page-only `#page-css` stylesheet prepended so panel content styles apply),
   loads it as a data-URL image, and draws it to a `<canvas>` at 300 dpi
   (`DPI` constant in `app.js`).
3. The canvas is encoded as a baseline JPEG at quality 0.94 (chosen because at
   300 dpi, artefacts around black text on white are what show up in print).
4. `buildPDF()` writes the PDF file by hand as a sequence of raw objects:

   - Object 1: `/Catalog` pointing at the pages tree.
   - Object 2: `/Pages`, one kid (this app always exports exactly one page).
   - Per page: a `/Page` object (`/MediaBox` sized to the sheet in points), an
     `/XObject` `/Image` holding the raw JPEG bytes (`/Filter /DCTDecode`,
     `/ColorSpace /DeviceRGB`, `/BitsPerComponent 8`), and a tiny content
     stream that positions and draws it (`cm` matrix scaled to the MediaBox,
     `/Im0 Do`).
   - An `xref` table built from the byte offset (`off[]`) recorded for every
     object as it was written, followed by the `trailer` and `startxref`.

Because the xref table is hand-built from tracked byte offsets, any change to
what gets written to the PDF must keep `off[]` and every object's `/Length`
value in exact step with the bytes actually emitted, or the file will not
open correctly in strict PDF readers.

The exported PNG (`exportSheet('png')`) skips step 3–4 entirely and just
downloads the rasterised canvas from step 2 as a PNG blob — no PDF wrapping.
