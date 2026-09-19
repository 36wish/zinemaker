/* The QR encoder, checked without trusting it.
   Capacities come from the published tables and from the geometry of the
   matrix; error correction is checked by RS syndromes, which is polynomial
   evaluation rather than the division the encoder does; and the payload is
   read back out of the finished symbol. */

'use strict';

const { assert } = require('./harness');
const QR = require('../qr.js');

/* Published total codewords per version, and the spare bits left over. */
const TOTAL = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const REMAINDER = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
const LEVELS = ['L', 'M', 'Q', 'H'];

/* GF(256) built here rather than imported from the module under test. */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;

const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0
];

const FINDER = [
  [1,1,1,1,1,1,1], [1,0,0,0,0,0,1], [1,0,1,1,1,0,1], [1,0,1,1,1,0,1],
  [1,0,1,1,1,0,1], [1,0,0,0,0,0,1], [1,1,1,1,1,1,1]
];

function structure(qr) {
  const m = qr.modules, size = qr.size, v = qr.version;

  [[0, 0], [0, size - 7], [size - 7, 0]].forEach(p => {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      assert.eq(m[p[0] + r][p[1] + c], FINDER[r][c], 'v' + v + ' finder at ' + p + ' cell ' + r + ',' + c);
    }
  });

  for (let i = 8; i < size - 8; i++) {
    assert.eq(m[6][i], i % 2 === 0 ? 1 : 0, 'v' + v + ' horizontal timing at ' + i);
    assert.eq(m[i][6], i % 2 === 0 ? 1 : 0, 'v' + v + ' vertical timing at ' + i);
  }
  assert.eq(m[size - 8][8], 1, 'v' + v + ' dark module');

  const centres = QR.ALIGN[v - 1];
  const onFinder = (r, c) => (r < 8 && c < 8) || (r < 8 && c >= size - 8) || (r >= size - 8 && c < 8);
  centres.forEach(r0 => centres.forEach(c0 => {
    if (onFinder(r0, c0)) return;
    assert.eq(m[r0][c0], 1, 'v' + v + ' alignment centre ' + r0 + ',' + c0);
    assert.eq(m[r0 - 1][c0], 0, 'v' + v + ' alignment ring ' + r0 + ',' + c0);
    assert.eq(m[r0 - 2][c0], 1, 'v' + v + ' alignment border ' + r0 + ',' + c0);
  }));

  let f1 = 0;
  for (let i = 0; i <= 5; i++) f1 |= m[i][8] << i;
  f1 |= m[7][8] << 6; f1 |= m[8][8] << 7; f1 |= m[8][7] << 8;
  for (let i = 9; i < 15; i++) f1 |= m[8][14 - i] << i;
  let f2 = 0;
  for (let i = 0; i < 8; i++) f2 |= m[8][size - 1 - i] << i;
  for (let i = 8; i < 15; i++) f2 |= m[size - 15 + i][8] << i;
  assert.eq(f1, f2, 'v' + v + ' the two format-info copies must agree');
  assert.eq(f1, QR.formatBits(qr.level, qr.mask), 'v' + v + ' format info');

  let rem = f1 ^ 0x5412;                       // must be a valid BCH word
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  assert.eq(rem, 0, 'v' + v + ' format info is not a valid BCH codeword');

  if (v >= 7) {
    let vb = 0;
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = size - 11 + (i % 3);
      assert.eq(m[r][c], m[c][r], 'v' + v + ' version info copies at ' + i);
      vb |= m[r][c] << i;
    }
    assert.eq(vb, QR.versionBits(v), 'v' + v + ' version info');
    assert.eq(vb >> 12, v, 'v' + v + ' version info must encode the version');
  }
}

function readBack(qr) {
  const size = qr.size, v = qr.version, spec = QR.EC[qr.level][v - 1];
  const fn = QR.skeleton(v).fn;

  const bits = [];
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const up = ((right + 1) & 2) === 0;
        const r = up ? size - 1 - vert : vert;
        if (fn[r][c]) continue;
        bits.push(qr.modules[r][c] ^ (MASKS[qr.mask](r, c) ? 1 : 0));
      }
    }
  }
  const cw = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    cw.push(b);
  }

  const ecLen = spec[0], shape = [];
  for (let i = 0; i < spec[1]; i++) shape.push(spec[2]);
  for (let i = 0; i < (spec[3] || 0); i++) shape.push(spec[4]);
  const nb = shape.length, longest = Math.max.apply(null, shape);
  const data = shape.map(() => []), ecs = shape.map(() => []);
  let p = 0;
  for (let i = 0; i < longest; i++) {
    for (let b = 0; b < nb; b++) if (i < shape[b]) data[b].push(cw[p++]);
  }
  for (let i = 0; i < ecLen; i++) for (let b = 0; b < nb; b++) ecs[b].push(cw[p++]);

  for (let b = 0; b < nb; b++) {
    const full = data[b].concat(ecs[b]);
    for (let s = 0; s < ecLen; s++) {
      let acc = 0;
      for (let i = 0; i < full.length; i++) acc = mul(acc, EXP[s]) ^ full[i];
      assert.eq(acc, 0, 'v' + v + '-' + qr.level + ' block ' + b + ' syndrome ' + s);
    }
  }

  const flat = [].concat.apply([], data), db = [];
  flat.forEach(x => { for (let i = 7; i >= 0; i--) db.push((x >> i) & 1); });
  let q = 0;
  const take = n => { let x = 0; for (let i = 0; i < n; i++) x = (x << 1) | db[q++]; return x; };
  assert.eq(take(4), 4, 'v' + v + ' mode must be byte');
  const len = take(v < 10 ? 8 : 16);
  const out = [];
  for (let i = 0; i < len; i++) out.push(take(8));
  return Buffer.from(out).toString('utf8');
}

const CASES = [
  'A',
  'hi',
  'https://example.com',
  'https://zine.example.org/issue-01?from=qr&utm=paper',
  'Punctuation ~!@#$%^&*()_+ and unicode — café über 你好',
  'x'.repeat(40),
  'y'.repeat(120),
  'w'.repeat(130),
  'z'.repeat(200)
];

module.exports = {
  name: 'QR encoder',
  browser: false,
  collect(t) {
    t.check('block table matches the published codeword totals', () => {
      for (let v = 1; v <= 10; v++) LEVELS.forEach(L => {
        const s = QR.EC[L][v - 1];
        const blocks = s[1] + (s[3] || 0);
        assert.eq(QR.dataCount(s) + s[0] * blocks, TOTAL[v - 1], 'v' + v + '-' + L);
      });
    });

    t.check('those totals also match the free space in the matrix', () => {
      for (let v = 1; v <= 10; v++) {
        const sk = QR.skeleton(v);
        let free = 0;
        for (let r = 0; r < sk.size; r++) for (let c = 0; c < sk.size; c++) if (!sk.fn[r][c]) free++;
        assert.eq(free, TOTAL[v - 1] * 8 + REMAINDER[v - 1], 'v' + v + ' free modules');
      }
    });

    t.check('alignment patterns survive crossing the timing pattern', () => {
      // v7+ places alignment at row/col 6, on top of the timing pattern; only
      // the ones colliding with a finder are dropped.
      const qr = QR.make('https://example.com', 'M');
      assert.ok(qr.version >= 1);
      const big = QR.make('z'.repeat(150), 'L');       // forces v7+
      assert.ok(big.version >= 7, 'expected a version 7 or larger symbol');
      assert.eq(big.modules[6][22], 1, 'alignment centre on the timing row');
    });

    t.check('finders, timing, alignment and format bits are well formed', () => {
      CASES.forEach(text => LEVELS.forEach(L => {
        let qr;
        try { qr = QR.make(text, L); } catch (e) { return; }
        structure(qr);
      }));
    });

    t.check('error correction passes an independent syndrome check', () => {
      CASES.forEach(text => LEVELS.forEach(L => {
        let qr;
        try { qr = QR.make(text, L); } catch (e) { return; }
        readBack(qr);
      }));
    });

    t.check('payload reads back byte for byte, versions 1 to 10', () => {
      const seen = {};
      CASES.forEach(text => LEVELS.forEach(L => {
        let qr;
        try { qr = QR.make(text, L); }
        catch (e) {
          const need = 4 + 16 + Buffer.byteLength(text, 'utf8') * 8;
          assert.ok(need > QR.dataCount(QR.EC[L][9]) * 8,
            'refused ' + text.length + ' chars at ' + L + ' but it should fit');
          return;
        }
        assert.eq(readBack(qr), text, 'round trip at ' + L);
        assert.eq(qr.size, qr.version * 4 + 17, 'size for v' + qr.version);
        seen['v' + qr.version] = true;
      }));
      for (let v = 1; v <= 10; v++) assert.ok(seen['v' + v], 'no case exercised version ' + v);
    });

    t.check('picks the smallest version that fits', () => {
      assert.eq(QR.make('A', 'L').version, 1);
      assert.eq(QR.make('x'.repeat(17), 'L').version, 1);     // v1-L holds 17 bytes
      assert.eq(QR.make('x'.repeat(18), 'L').version, 2);
    });

    t.check('refuses data past version 10 rather than truncating', () => {
      let threw = false;
      try { QR.make('z'.repeat(400), 'H'); } catch (e) { threw = true; }
      assert.ok(threw, 'expected an error for an oversized payload');
    });

    t.check('svg path covers exactly the dark modules', () => {
      const q = QR.make('https://example.com', 'M');
      let area = 0;
      QR.path(q).replace(/M\d+ \d+h(\d+)/g, (_, n) => { area += +n; return ''; });
      let dark = 0;
      for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) dark += q.modules[r][c];
      assert.eq(area, dark, 'path area vs matrix');
    });
  }
};
