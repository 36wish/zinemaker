/* Minimal QR Code encoder: byte mode, versions 1-10, EC levels L/M/Q/H.
   Ten versions is plenty for a URL or a short note, which is all a zine needs,
   and it keeps the tables small. Written from the spec rather than pulled from
   a CDN so the app keeps working offline from file://. */

'use strict';

var QR = (function () {

  /* ---- GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 ---- */
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;

  /* ---- Error-correction block layout, versions 1-10.
     [ecCodewordsPerBlock, blocksInGroup1, dataPerBlock1, blocksInGroup2, dataPerBlock2]
     Each row must satisfy: data + ec*blocks === total codewords for that version. ---- */
  const EC = {
    L: [[7,1,19],[10,1,34],[15,1,55],[20,1,80],[26,1,108],[18,2,68],[20,2,78],[24,2,97],[30,2,116],[18,2,68,2,69]],
    M: [[10,1,16],[16,1,28],[26,1,44],[18,2,32],[24,2,43],[16,4,27],[18,4,31],[22,2,38,2,39],[22,3,36,2,37],[26,4,43,1,44]],
    Q: [[13,1,13],[22,1,22],[18,2,17],[26,2,24],[18,2,15,2,16],[24,4,19],[18,2,14,4,15],[22,4,18,2,19],[20,4,16,4,17],[24,6,19,2,20]],
    H: [[17,1,9],[28,1,16],[22,2,13],[16,4,9],[22,2,11,2,12],[28,4,15],[26,4,13,1,14],[26,4,14,2,15],[24,4,12,4,13],[28,6,15,2,16]]
  };
  const ALIGN = [[], [6,18], [6,22], [6,26], [6,30], [6,34],
                 [6,22,38], [6,24,42], [6,26,46], [6,28,50]];
  const ECBITS = { L: 1, M: 0, Q: 3, H: 2 };
  const LEVELS = ['L', 'M', 'Q', 'H'];

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0
  ];

  const dataCount = s => s[1] * s[2] + (s[3] ? s[3] * s[4] : 0);

  /* ---- Reed-Solomon ---- */
  function rsGen(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j <= g.length; j++) {
        ng[j] = (j < g.length ? g[j] : 0) ^ (j > 0 ? mul(g[j - 1], EXP[i]) : 0);
      }
      g = ng;
    }
    return g;                         // length n+1, leading coefficient 1
  }

  function rsEncode(data, ecLen) {
    const g = rsGen(ecLen);
    const res = new Array(ecLen).fill(0);
    for (const d of data) {
      const factor = d ^ res[0];
      res.shift(); res.push(0);
      for (let i = 0; i < ecLen; i++) res[i] ^= mul(g[i + 1], factor);
    }
    return res;
  }

  /* ---- BCH check bits for the format and version areas ---- */
  function formatBits(ecl, mask) {
    const d = (ECBITS[ecl] << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return (((d << 10) | rem) ^ 0x5412) & 0x7fff;
  }

  function versionBits(ver) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (ver << 12) | rem;
  }

  /* ---- penalty scoring, used to choose the mask ---- */
  function penalty(m, size) {
    let p = 0;
    const line = get => {
      let run = 1;
      for (let i = 1; i < size; i++) {
        if (get(i) === get(i - 1)) {
          run++;
          if (run === 5) p += 3; else if (run > 5) p++;
        } else run = 1;
      }
    };
    for (let r = 0; r < size; r++) line(i => m[r][i]);
    for (let c = 0; c < size; c++) line(i => m[i][c]);

    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
      }
    }

    const finder = [1,0,1,1,1,0,1,0,0,0,0];
    const rfinder = finder.slice().reverse();
    const match = (get, at, pat) => {
      for (let i = 0; i < 11; i++) if (get(at + i) !== pat[i]) return false;
      return true;
    };
    for (let r = 0; r < size; r++) for (let c = 0; c <= size - 11; c++) {
      if (match(i => m[r][i], c, finder) || match(i => m[r][i], c, rfinder)) p += 40;
    }
    for (let c = 0; c < size; c++) for (let r = 0; r <= size - 11; r++) {
      if (match(i => m[i][c], r, finder) || match(i => m[i][c], r, rfinder)) p += 40;
    }

    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    const pct = dark * 100 / (size * size);
    p += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return p;
  }

  /* ---- the function patterns, which data must skip ---- */
  function skeleton(ver) {
    const size = ver * 4 + 17;
    const m = [], fn = [];
    for (let r = 0; r < size; r++) {
      m.push(new Array(size).fill(0));
      fn.push(new Array(size).fill(0));
    }
    const set = (r, c, v) => { m[r][c] = v; fn[r][c] = 1; };

    [[0, 0], [0, size - 7], [size - 7, 0]].forEach(corner => {
      const R = corner[0], C = corner[1];
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const rr = R + r, cc = C + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const ring = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                     (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(rr, cc, (ring || core) ? 1 : 0);
      }
    });

    for (let i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0 ? 1 : 0);
      set(i, 6, i % 2 === 0 ? 1 : 0);
    }

    // Alignment patterns are omitted only where they would hit a finder —
    // the ones sitting on the timing pattern stay, and agree with it.
    const centres = ALIGN[ver - 1];
    const onFinder = (r, c) => (r < 8 && c < 8) ||
                               (r < 8 && c >= size - 8) ||
                               (r >= size - 8 && c < 8);
    centres.forEach(r0 => centres.forEach(c0 => {
      if (onFinder(r0, c0)) return;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        set(r0 + dr, c0 + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
      }
    }));

    set(size - 8, 8, 1);                       // always dark
    for (let i = 0; i <= 8; i++) {             // reserved for format info
      if (i !== 6) { fn[8][i] = 1; fn[i][8] = 1; }
    }
    for (let i = 0; i < 8; i++) {
      fn[8][size - 1 - i] = 1;
      fn[size - 1 - i][8] = 1;
    }

    if (ver >= 7) {
      const vb = versionBits(ver);
      for (let i = 0; i < 18; i++) {
        const b = (vb >> i) & 1;
        const r = Math.floor(i / 3), c = size - 11 + (i % 3);
        set(r, c, b); set(c, r, b);
      }
    }
    return { size: size, m: m, fn: fn };
  }

  function drawFormat(m, size, ecl, mask) {
    const bits = formatBits(ecl, mask);
    const bit = i => (bits >> i) & 1;
    for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
    m[7][8] = bit(6);
    m[8][8] = bit(7);
    m[8][7] = bit(8);
    for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i);
    m[size - 8][8] = 1;
  }

  /* ---- encode ---- */
  function make(text, ecl) {
    ecl = EC[ecl] ? ecl : 'M';
    const bytes = new TextEncoder().encode(String(text == null ? '' : text));

    let ver = 0, spec = null;
    for (let v = 1; v <= 10; v++) {
      const s = EC[ecl][v - 1];
      const need = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
      if (need <= dataCount(s) * 8) { ver = v; spec = s; break; }
    }
    if (!ver) throw new Error('too long for a version-10 QR code');

    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(4, 4);
    push(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(b => push(b, 8));

    const nData = dataCount(spec), cap = nData * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    for (let i = 0; data.length < nData; i++) data.push(i % 2 ? 0x11 : 0xec);

    const ecLen = spec[0], blocks = [];
    const groups = [[spec[1], spec[2]]];
    if (spec[3]) groups.push([spec[3], spec[4]]);
    let p = 0;
    groups.forEach(gr => {
      for (let i = 0; i < gr[0]; i++) { blocks.push(data.slice(p, p + gr[1])); p += gr[1]; }
    });
    const ecs = blocks.map(b => rsEncode(b, ecLen));

    const out = [];
    const longest = Math.max.apply(null, blocks.map(b => b.length));
    for (let i = 0; i < longest; i++) blocks.forEach(b => { if (i < b.length) out.push(b[i]); });
    for (let i = 0; i < ecLen; i++) ecs.forEach(e => out.push(e[i]));

    const sk = skeleton(ver), size = sk.size, fn = sk.fn;
    const base = sk.m;

    let bi = 0;
    const total = out.length * 8;
    for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right = 5;                    // the timing column
      for (let v = 0; v < size; v++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - v : v;
          if (fn[r][c]) continue;
          base[r][c] = bi < total ? (out[bi >> 3] >> (7 - (bi & 7))) & 1 : 0;
          bi++;
        }
      }
    }

    let best = null, bestScore = Infinity, bestMask = 0;
    for (let k = 0; k < 8; k++) {
      const cand = base.map(row => row.slice());
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        if (!fn[r][c] && MASKS[k](r, c)) cand[r][c] ^= 1;
      }
      drawFormat(cand, size, ecl, k);
      const score = penalty(cand, size);
      if (score < bestScore) { bestScore = score; best = cand; bestMask = k; }
    }

    return { size: size, version: ver, level: ecl, mask: bestMask, modules: best };
  }

  /* Merge each row's dark runs into one path so the SVG stays small. */
  function path(qr) {
    let d = '';
    for (let r = 0; r < qr.size; r++) {
      let c = 0;
      while (c < qr.size) {
        if (!qr.modules[r][c]) { c++; continue; }
        let n = 0;
        while (c + n < qr.size && qr.modules[r][c + n]) n++;
        d += 'M' + c + ' ' + r + 'h' + n + 'v1h-' + n + 'z';
        c += n;
      }
    }
    return d;
  }

  return { make: make, path: path, LEVELS: LEVELS, EC: EC, ALIGN: ALIGN,
           skeleton: skeleton, formatBits: formatBits, versionBits: versionBits,
           dataCount: dataCount };
})();

if (typeof module !== 'undefined') module.exports = QR;
