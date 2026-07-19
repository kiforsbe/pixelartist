# Export System Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split "Export" into a Document-menu "Export Sheet…" (active sheet
only) and a File-menu "Export Project…" (whole project), and add Tiled TSX,
animation export (GIF / spritesheet+json / image sequence), and C99 header
export (generic 8bpp / GBA 4bpp / NES 2bpp CHR) to the sheet-scoped export.

**Architecture:** New pure, `node --test`-testable builder modules
(`js/core/quantize.js`, `js/core/gif.js`, `js/app/c99Export.js`,
`js/app/tiledExport.js`, `js/app/animationExport.js`,
`js/app/projectExport.js`) mirror the existing `js/app/exports.js` pattern.
`js/app/main.js` wires their output into dialogs/downloads exactly like the
current `file.export` flow does today.

**Tech Stack:** Vanilla JS (ES modules), `node --test`, no dependencies, no
build step (see spec's Non-goals).

## Global Constraints

- No new npm dependencies, no build step (project-wide rule; see `README.md`
  "No dependencies, no build step").
- GIF is the only animated-image export format; no WebP/APNG (spec
  Non-goals).
- Tiled TSX applies to tile sheets only, not sprite sheets (spec
  Non-goals).
- Palette resolution order (spec "Palette source for quantization"): use
  `project.activePaletteId` if it points to an **indexed** palette, else
  auto-build from the exported item's own pixel colors, capped at the
  target's max color count (256 generic, 16 GBA, 4 NES).
- GIF loop encoding: include the `NETSCAPE2.0` extension with loop count 0
  when `animation.loop` is true; omit the extension entirely when false (a
  loop count of 1 would replay once more, not play once — see spec).
- GBA4/NES2 C99 targets require width and height to both be multiples of 8;
  reject with a clear error otherwise (`generic8` has no such constraint).
- Full design context: `docs/superpowers/specs/2026-07-19-export-system-design.md`.

---

### Task 1: Palette quantization helper

**Files:**
- Create: `js/core/quantize.js`
- Test: `tests/quantize.test.mjs`

**Interfaces:**
- Consumes: nothing new (no imports from other new modules).
- Produces: `colorFrequency(bitmaps) -> [[r,g,b,a], ...]` (most-frequent
  first, fully-transparent pixels excluded), `buildPalette(bitmaps,
  maxColors, sourcePalette=null) -> [[r,g,b,a], ...]` (uses
  `sourcePalette.colors` directly when `sourcePalette?.indexed`, else
  `colorFrequency` capped at `maxColors`), `quantizeBitmap(bmp, palette) ->
  Uint8Array` (one nearest-palette-index byte per pixel, row-major). Used
  by Task 2 (`gif.js`) and Task 7/8's C99 wiring in `main.js`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/quantize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorFrequency, buildPalette, quantizeBitmap } from '../js/core/quantize.js';

function bmp(width, height, pixels) {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((rgba, i) => data.set(rgba, i * 4));
  return { width, height, data };
}

test('colorFrequency: most-frequent first, transparent pixels excluded', () => {
  const b = bmp(2, 2, [
    [255, 0, 0, 255], [0, 255, 0, 255],
    [255, 0, 0, 255], [0, 0, 0, 0], // transparent, excluded
  ]);
  const freq = colorFrequency([b]);
  assert.deepEqual(freq, [[255, 0, 0, 255], [0, 255, 0, 255]]);
});

test('buildPalette: indexed source palette wins over pixel frequency', () => {
  const b = bmp(1, 1, [[255, 0, 0, 255]]);
  const pal = buildPalette([b], 256, { indexed: true, colors: [[1, 2, 3, 255], [4, 5, 6, 255]] });
  assert.deepEqual(pal, [[1, 2, 3, 255], [4, 5, 6, 255]]);
});

test('buildPalette: caps pixel-frequency palette at maxColors', () => {
  const b = bmp(3, 1, [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]);
  const pal = buildPalette([b], 2, null);
  assert.equal(pal.length, 2);
  assert.deepEqual(pal, [[255, 0, 0, 255], [0, 255, 0, 255]]);
});

test('quantizeBitmap: each pixel maps to its nearest palette index', () => {
  const b = bmp(2, 1, [[250, 5, 5, 255], [5, 5, 250, 255]]);
  const palette = [[255, 0, 0, 255], [0, 0, 255, 255]];
  assert.deepEqual([...quantizeBitmap(b, palette)], [0, 1]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` (or `node --test tests/quantize.test.mjs`)
Expected: FAIL with "Cannot find module '../js/core/quantize.js'"

- [ ] **Step 3: Write the implementation**

```js
// js/core/quantize.js
// Palette resolution + nearest-color quantization shared by GIF and C99
// export (both need an indexed palette; sheet pixels are stored as RGBA
// truecolor, see the export-system design doc's "Palette source" section).

// Counts exact RGBA occurrences across one or more bitmaps, most-frequent
// first. Fully-transparent pixels never need a palette slot.
export function colorFrequency(bitmaps) {
  const counts = new Map();
  const order = [];
  for (const bmp of bitmaps) {
    const d = bmp.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const key = `${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`;
      if (!counts.has(key)) order.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return order
    .map(key => ({ key, count: counts.get(key) }))
    .sort((a, b) => b.count - a.count)
    .map(({ key }) => key.split(',').map(Number));
}

// Builds a palette for a set of bitmaps: an indexed source palette's colors
// directly if given, otherwise the bitmaps' own most-frequent distinct
// colors, capped at maxColors.
export function buildPalette(bitmaps, maxColors, sourcePalette = null) {
  if (sourcePalette?.indexed) return sourcePalette.colors.slice(0, maxColors);
  return colorFrequency(bitmaps).slice(0, maxColors);
}

// Maps every pixel of `bmp` to its nearest palette index (0-based, by RGB
// distance -- these target formats have no partial transparency, so alpha
// is ignored once buildPalette has already excluded fully-transparent
// pixels from consideration).
export function quantizeBitmap(bmp, palette) {
  const indices = new Uint8Array(bmp.width * bmp.height);
  const d = bmp.data;
  for (let p = 0; p < indices.length; p++) {
    const i = p * 4;
    let best = 0, bestD = Infinity;
    for (let c = 0; c < palette.length; c++) {
      const pc = palette[c];
      const dist = (pc[0] - d[i]) ** 2 + (pc[1] - d[i + 1]) ** 2 + (pc[2] - d[i + 2]) ** 2;
      if (dist < bestD) { bestD = dist; best = c; }
    }
    indices[p] = best;
  }
  return indices;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all 4 new tests, plus the existing suite unaffected)

- [ ] **Step 5: Commit**

```bash
git add js/core/quantize.js tests/quantize.test.mjs
git commit -m "feat: add palette quantization helper for GIF/C99 export"
```

---

### Task 2: GIF89a encoder

**Files:**
- Create: `js/core/gif.js`
- Test: `tests/gif.test.mjs`

**Interfaces:**
- Consumes: `buildPalette` from `js/core/quantize.js` (Task 1).
- Produces: `encodeGif(frames, { loop = true }) -> Uint8Array`, where
  `frames: [{ pixels: Uint8ClampedArray (RGBA), width, height, delayMs }]`.
  Used by Task 5 (`animationExport.js`'s GIF frame builder feeds this) and
  Task 7/8's `main.js` wiring.

- [ ] **Step 1: Write the failing test**

```js
// tests/gif.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGif } from '../js/core/gif.js';

function px(r, g, b, a = 255) { return [r, g, b, a]; }

test('encodeGif: single 2x1 red/green frame, no loop, hand-verified byte layout', () => {
  const pixels = new Uint8ClampedArray([...px(255, 0, 0), ...px(0, 255, 0)]);
  const bytes = encodeGif([{ pixels, width: 2, height: 1, delayMs: 100 }], { loop: false });

  // Header + Logical Screen Descriptor
  assert.equal(String.fromCharCode(...bytes.slice(0, 6)), 'GIF89a');
  assert.deepEqual([...bytes.slice(6, 8)], [2, 0]); // width=2 LSB-first
  assert.deepEqual([...bytes.slice(8, 10)], [1, 0]); // height=1
  // packed byte: GCT present (0x80) | color-res(3b)=1 | sort(0) | size(3b)=1
  // -> tableSizeExp=0 (2-color GCT) since red+green = 2 distinct colors
  assert.equal(bytes[10] & 0x80, 0x80);
  assert.equal(bytes[10] & 0x07, 0); // tableSizeExp = 0 -> 2^(0+1) = 2 entries
  // Global Color Table: 2 entries x 3 bytes = 6 bytes, red then green
  // (both appear once -> frequency-tie order = first-encountered = red, green)
  const gct = bytes.slice(13, 19);
  assert.deepEqual([...gct], [255, 0, 0, 0, 255, 0]);

  // no loop -> no NETSCAPE2.0 Application Extension anywhere in the stream
  const asString = [...bytes].map(b => String.fromCharCode(b)).join('');
  assert.equal(asString.includes('NETSCAPE2.0'), false);

  // Graphic Control Extension starts right after the GCT (offset 19):
  // 0x21 0xF9 0x04 <flags> <delay LSB> <delay MSB> <transparent idx> 0x00
  const gceStart = 19;
  assert.deepEqual([...bytes.slice(gceStart, gceStart + 3)], [0x21, 0xf9, 0x04]);
  assert.equal(bytes[gceStart + 3] & 0x08, 0x08); // disposal method 2 (bit3 of the flags nibble)
  assert.deepEqual([...bytes.slice(gceStart + 4, gceStart + 6)], [10, 0]); // 100ms -> 10 centiseconds
  assert.equal(bytes[gceStart + 7], 0x00); // block terminator

  // Image Descriptor: 0x2C left(2) top(2) width(2) height(2) flags(1)
  const idStart = gceStart + 8;
  assert.equal(bytes[idStart], 0x2c);
  // 9 bytes after the separator: left(2) top(2) width(2) height(2) flags(1)
  assert.deepEqual([...bytes.slice(idStart + 1, idStart + 10)], [0, 0, 0, 0, 2, 0, 1, 0, 0]);

  // LZW: min code size byte, then hand-derived sub-block for indices [0,1]
  // at minCodeSize=2 (clear=4,eoi=5): codes emitted are clear(100b),
  // idx0(000b), idx1(001b), eoi(101b) at 3 bits each, LSB-first packed ->
  // byte0=0b00010001=0x44=68, byte1=0b00001010=0x0A=10 (derived by hand,
  // see design doc's LZW section for the bit-packing rule).
  const lzwStart = idStart + 10;
  assert.equal(bytes[lzwStart], 2); // minCodeSize
  assert.deepEqual([...bytes.slice(lzwStart + 1, lzwStart + 5)], [2, 68, 10, 0]); // sub-block: size,data,data,terminator

  // Trailer
  assert.equal(bytes.at(-1), 0x3b);
});

test('encodeGif: loop:true includes a NETSCAPE2.0 extension with loop count 0', () => {
  const pixels = new Uint8ClampedArray([...px(0, 0, 0)]);
  const bytes = encodeGif([{ pixels, width: 1, height: 1, delayMs: 50 }], { loop: true });
  const asString = [...bytes].map(b => String.fromCharCode(b)).join('');
  assert.equal(asString.includes('NETSCAPE2.0'), true);
});

test('encodeGif: throws on an empty frame list', () => {
  assert.throws(() => encodeGif([], { loop: false }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/gif.test.mjs`
Expected: FAIL with "Cannot find module '../js/core/gif.js'"

- [ ] **Step 3: Write the implementation**

```js
// js/core/gif.js
// Minimal GIF89a encoder (frames -> Uint8Array). Pure, no DOM. One global
// color table built across every frame (buildPalette from quantize.js),
// with one index reserved for transparency when any frame has fully-
// transparent pixels. See docs/superpowers/specs/2026-07-19-export-system-design.md
// for the byte-layout derivation this follows.
import { buildPalette } from './quantize.js';

function packSubBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

function lzwEncode(minCodeSize, indices) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const bytes = [];
  let bitBuf = 0, bitCount = 0;
  const emit = (code, codeSize) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) { bytes.push(bitBuf & 0xff); bitBuf >>= 8; bitCount -= 8; }
  };
  let dict, nextCode, codeSize;
  const reset = () => {
    dict = new Map(Array.from({ length: clearCode }, (_, i) => [String(i), i]));
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  };
  reset();
  emit(clearCode, codeSize);
  let w = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const wk = `${w},${indices[i]}`;
    if (dict.has(wk)) { w = wk; continue; }
    emit(dict.get(w), codeSize);
    if (nextCode === 4096) {
      emit(clearCode, codeSize);
      reset();
    } else {
      dict.set(wk, nextCode++);
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    }
    w = String(indices[i]);
  }
  emit(dict.get(w), codeSize);
  emit(eoiCode, codeSize);
  if (bitCount > 0) bytes.push(bitBuf & 0xff);
  return bytes;
}

function nearestIndex(palette, rgb) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i];
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const u16 = n => [n & 0xff, (n >>> 8) & 0xff];
const ascii = s => [...s].map(c => c.charCodeAt(0));

export function encodeGif(frames, { loop = true } = {}) {
  if (frames.length === 0) throw new Error('encodeGif: at least one frame required');

  const width = Math.max(...frames.map(f => f.width));
  const height = Math.max(...frames.map(f => f.height));
  const hasTransparency = frames.some(f => {
    for (let i = 3; i < f.pixels.length; i += 4) if (f.pixels[i] === 0) return true;
    return false;
  });

  let palette = buildPalette(
    frames.map(f => ({ width: f.width, height: f.height, data: f.pixels })),
    hasTransparency ? 255 : 256,
  );
  if (palette.length === 0) palette = [[0, 0, 0, 255]];
  const transparentIndex = hasTransparency ? palette.length : -1;
  if (hasTransparency) palette = [...palette, [0, 0, 0, 0]];

  let tableSize = 2;
  while (tableSize < palette.length) tableSize *= 2;
  const tableSizeExp = Math.log2(tableSize) - 1;
  const paddedPalette = Array.from({ length: tableSize }, (_, i) => palette[i] ?? [0, 0, 0, 255]);
  const minCodeSize = Math.max(2, Math.log2(tableSize));

  const out = [];
  out.push(...ascii('GIF89a'));
  out.push(...u16(width), ...u16(height));
  out.push(0x80 | (tableSizeExp << 4) | tableSizeExp, 0, 0);
  for (const c of paddedPalette) out.push(c[0], c[1], c[2]);

  if (loop) {
    out.push(0x21, 0xff, 0x0b, ...ascii('NETSCAPE2.0'), 0x03, 0x01, ...u16(0), 0x00);
  }

  for (const frame of frames) {
    const gceFlags = 0x08 | (transparentIndex >= 0 ? 0x01 : 0x00); // disposal=2, transparency flag
    out.push(0x21, 0xf9, 0x04, gceFlags, ...u16(Math.round(frame.delayMs / 10)),
      transparentIndex >= 0 ? transparentIndex : 0, 0x00);
    out.push(0x2c, ...u16(0), ...u16(0), ...u16(frame.width), ...u16(frame.height), 0x00);

    const indices = new Array(frame.width * frame.height);
    for (let p = 0; p < indices.length; p++) {
      const i = p * 4;
      indices[p] = frame.pixels[i + 3] === 0
        ? transparentIndex
        : nearestIndex(palette, [frame.pixels[i], frame.pixels[i + 1], frame.pixels[i + 2]]);
    }
    out.push(minCodeSize);
    out.push(...packSubBlocks(lzwEncode(minCodeSize, indices)));
  }
  out.push(0x3b);
  return new Uint8Array(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/gif.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add js/core/gif.js tests/gif.test.mjs
git commit -m "feat: add GIF89a encoder for animation export"
```

---

### Task 3: C99 header export (generic8 / GBA 4bpp / NES 2bpp CHR)

**Files:**
- Create: `js/app/c99Export.js`
- Test: `tests/c99Export.test.mjs`

**Interfaces:**
- Consumes: nothing new (operates on already-quantized index arrays, so it
  doesn't need `quantize.js` directly — that's the caller's job in Task
  7/8's `main.js` wiring).
- Produces: `buildC99({ projectName, target, palette, items }) -> { h, c }`
  (text), where `target` is `'generic8' | 'gba4' | 'nes2'`, `palette` is
  `[[r,g,b], ...]`, `items` is `[{ name, w, h, indices: Uint8Array }, ...]`.
  Used by Task 7/8's `main.js` wiring.

- [ ] **Step 1: Write the failing tests**

```js
// tests/c99Export.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildC99 } from '../js/app/c99Export.js';

test('buildC99 generic8: one byte per pixel, palette as [r,g,b] rows', () => {
  const { h, c } = buildC99({
    projectName: 'demo', target: 'generic8',
    palette: [[255, 0, 0], [0, 255, 0]],
    items: [{ name: 'tile0', w: 2, h: 1, indices: new Uint8Array([0, 1]) }],
  });
  assert.match(h, /extern const unsigned char demo_palette\[2\]\[3\];/);
  assert.match(h, /extern const unsigned char demo_tile0\[2\];/);
  assert.match(c, /const unsigned char demo_tile0\[2\] = \{0x00,0x01\};/);
  assert.match(c, /\{0xff,0x00,0x00\},\{0x00,0xff,0x00\}/);
});

test('buildC99 gba4: 8x8 tile packs to 32 bytes, low nibble = left pixel', () => {
  const indices = new Uint8Array(64); // all zero except the first two pixels
  indices[0] = 5; indices[1] = 10;
  const { c } = buildC99({
    projectName: 'demo', target: 'gba4',
    palette: Array.from({ length: 16 }, () => [0, 0, 0]),
    items: [{ name: 'tile0', w: 8, h: 8, indices }],
  });
  // byte0 = left(5) | right(10)<<4 = 5 | 160 = 165 = 0xa5; every other byte 0
  assert.match(c, /demo_tile0\[32\] = \{0xa5,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00\}/);
});

test('buildC99 nes2: 8x8 tile packs to 16 bytes, two 8-byte bitplanes', () => {
  // every row: values 0,1,2,3 repeated -> plane0=0x55, plane1=0x33 (see
  // design doc's NES section for the bit-by-bit derivation)
  const row = [0, 1, 2, 3, 0, 1, 2, 3];
  const indices = new Uint8Array(64);
  for (let y = 0; y < 8; y++) indices.set(row, y * 8);
  const { c } = buildC99({
    projectName: 'demo', target: 'nes2',
    palette: [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]],
    items: [{ name: 'tile0', w: 8, h: 8, indices }],
  });
  const expected = [...Array(8).fill('0x55'), ...Array(8).fill('0x33')].join(',');
  assert.match(c, new RegExp(`demo_tile0\\[16\\] = \\{${expected}\\}`));
});

test('buildC99: gba4/nes2 reject dimensions not a multiple of 8', () => {
  const items = [{ name: 't', w: 5, h: 8, indices: new Uint8Array(40) }];
  assert.throws(() => buildC99({ projectName: 'd', target: 'gba4', palette: [[0, 0, 0]], items }),
    /multiples of 8/);
});

test('buildC99: rejects a palette larger than the target supports', () => {
  const palette = Array.from({ length: 5 }, () => [0, 0, 0]);
  assert.throws(() => buildC99({ projectName: 'd', target: 'nes2', palette, items: [] }),
    /at most 4 colors/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/c99Export.test.mjs`
Expected: FAIL with "Cannot find module '../js/app/c99Export.js'"

- [ ] **Step 3: Write the implementation**

```js
// js/app/c99Export.js
// Packs already-quantized palette-index arrays into C99 source for retro
// targets. Palette/quantization is the caller's job (js/core/quantize.js) --
// this module is pure byte-packing.
const MAX_COLORS = { generic8: 256, gba4: 16, nes2: 4 };

function packTiles(w, h, indices, tileBytes, packTile) {
  if (w % 8 !== 0 || h % 8 !== 0)
    throw new Error(`${w}x${h}: dimensions must be multiples of 8 for tile-packed targets`);
  const cols = w / 8, rows = h / 8;
  const out = new Uint8Array(cols * rows * tileBytes);
  let o = 0;
  for (let ty = 0; ty < rows; ty++)
    for (let tx = 0; tx < cols; tx++) {
      const tile = new Uint8Array(64);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          tile[y * 8 + x] = indices[(ty * 8 + y) * w + (tx * 8 + x)];
      out.set(packTile(tile), o);
      o += tileBytes;
    }
  return out;
}

// 32 bytes/tile, 2px/byte, low nibble = left pixel (Tonc/GBATEK convention).
function packGba4Tile(tile) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (tile[i * 2] & 0x0f) | ((tile[i * 2 + 1] & 0x0f) << 4);
  return bytes;
}

// 16 bytes/tile: 8-byte plane0 (bit0 of each pixel) then 8-byte plane1
// (bit1), MSB = leftmost pixel (NESdev CHR convention).
function packNes2Tile(tile) {
  const bytes = new Uint8Array(16);
  for (let row = 0; row < 8; row++) {
    let plane0 = 0, plane1 = 0;
    for (let x = 0; x < 8; x++) {
      const v = tile[row * 8 + x] & 3;
      plane0 |= (v & 1) << (7 - x);
      plane1 |= ((v >> 1) & 1) << (7 - x);
    }
    bytes[row] = plane0;
    bytes[row + 8] = plane1;
  }
  return bytes;
}

function packItem(item, target) {
  if (target === 'generic8') return item.indices;
  if (target === 'gba4') return packTiles(item.w, item.h, item.indices, 32, packGba4Tile);
  if (target === 'nes2') return packTiles(item.w, item.h, item.indices, 16, packNes2Tile);
  throw new Error(`unknown C99 export target "${target}"`);
}

const hex = b => `0x${b.toString(16).padStart(2, '0')}`;

function cArray(name, bytes) {
  return `const unsigned char ${name}[${bytes.length}] = {${Array.from(bytes).map(hex).join(',')}};`;
}

function cPaletteArray(name, palette) {
  const rows = palette.map(c => `{${hex(c[0])},${hex(c[1])},${hex(c[2])}}`).join(',');
  return `const unsigned char ${name}[${palette.length}][3] = {${rows}};`;
}

export function buildC99({ projectName, target, palette, items }) {
  const maxColors = MAX_COLORS[target];
  if (!maxColors) throw new Error(`unknown C99 export target "${target}"`);
  if (palette.length > maxColors)
    throw new Error(`${target} supports at most ${maxColors} colors, got ${palette.length}`);

  const guard = `${projectName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_H`;
  const declarations = [`extern const unsigned char ${projectName}_palette[${palette.length}][3];`];
  const definitions = [cPaletteArray(`${projectName}_palette`, palette)];

  for (const item of items) {
    const packed = packItem(item, target);
    declarations.push(`extern const unsigned char ${projectName}_${item.name}[${packed.length}];`);
    definitions.push(cArray(`${projectName}_${item.name}`, packed));
  }

  const h = `#ifndef ${guard}\n#define ${guard}\n\n${declarations.join('\n')}\n\n#endif\n`;
  const c = `#include "${projectName}.h"\n\n${definitions.join('\n\n')}\n`;
  return { h, c };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/c99Export.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add js/app/c99Export.js tests/c99Export.test.mjs
git commit -m "feat: add C99 header export (generic8/GBA4/NES2 targets)"
```

---

### Task 4: Tiled TSX export

**Files:**
- Create: `js/app/tiledExport.js`
- Test: `tests/tiledExport.test.mjs`

**Interfaces:**
- Consumes: `blobIndexToMask` and `resolveTerrainSlot`, both from
  `js/core/blob47.js` (existing — note `resolveTerrainSlot` lives in
  `blob47.js`, not `terrainsets.js`, despite operating on a terrain set).
- Produces: `buildTiledTsx(sheet) -> string` (XML). Used by Task 7/8's
  `main.js` wiring.

- [ ] **Step 1: Write the failing test**

```js
// tests/tiledExport.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet } from '../js/core/model.js';
import { createTerrainSet, assignSlot } from '../js/core/terrainsets.js';
import { blobIndexToMask, NEIGHBOR_BITS } from '../js/core/blob47.js';
import { buildTiledTsx } from '../js/app/tiledExport.js';

function addTile(sheet, x, y, w, h) {
  const tile = { id: `t${sheet.tiles.length}`, x, y, w, h };
  sheet.tiles.push(tile);
  return tile;
}

test('buildTiledTsx: only tile sheets are meaningful; wangid encodes N,NE,E,SE,S,SW,W,NW presence', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Ground', width: 32, height: 16, kind: 'tile' });
  const tIsolated = addTile(sheet, 0, 0, 16, 16);
  const tFull = addTile(sheet, 16, 0, 16, 16);
  const ts = createTerrainSet(sheet, { name: 'Grass', tileW: 16, tileH: 16 });

  // blobIndex 0 is always the fully-isolated (no neighbors) configuration.
  assignSlot(sheet, ts, 0, tIsolated);
  // find the blobIndex whose canonical mask is "all 8 bits set" (fully surrounded)
  const fullMask = Object.values(NEIGHBOR_BITS).reduce((a, b) => a | b, 0);
  const fullIndex = blobIndexToMask.indexOf(fullMask);
  assignSlot(sheet, ts, fullIndex, tFull);

  const xml = buildTiledTsx(sheet);
  assert.match(xml, /<tileset[^>]*name="Ground"/);
  assert.match(xml, /<image source="Ground\.png" width="32" height="16"\/>/);
  assert.match(xml, /<wangset name="Grass"/);
  assert.match(xml, /<wangtile tileid="0" wangid="0,0,0,0,0,0,0,0"\/>/);
  assert.match(xml, /<wangtile tileid="1" wangid="1,1,1,1,1,1,1,1"\/>/);
});

test('buildTiledTsx: unassigned/unresolvable blob slots produce no wangtile', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Empty', width: 16, height: 16, kind: 'tile' });
  createTerrainSet(sheet, { name: 'Water', tileW: 16, tileH: 16 });
  const xml = buildTiledTsx(sheet);
  assert.match(xml, /<wangset name="Water"[^>]*><wangcolor[^/]*\/><\/wangset>/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tiledExport.test.mjs`
Expected: FAIL with "Cannot find module '../js/app/tiledExport.js'"

- [ ] **Step 3: Write the implementation**

```js
// js/app/tiledExport.js
// Builds a Tiled .tsx tileset (TMX Map Format) for a tile sheet, with
// <wangsets> built from the sheet's terrainSets. Each terrain set in this
// app is single-material blob-47 autotiling, so it maps to exactly one
// <wangset> with exactly one <wangcolor> (wangid index 1 = "this terrain
// present", index 0 = unset) -- see the export-system design doc.
import { blobIndexToMask, resolveTerrainSlot } from '../core/blob47.js';

// wangid order per the TMX spec: top, topright, right, bottomright, bottom,
// bottomleft, left, topleft -- exactly blob47's N,NE,E,SE,S,SW,W,NW bit
// order, so each direction's presence bit maps 1:1 to a wangid slot.
const WANG_BITS = [1, 2, 4, 8, 16, 32, 64, 128];

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function buildTiledTsx(sheet) {
  const indexById = new Map(sheet.tiles.map((t, i) => [t.id, i]));
  // Tiled requires one uniform tile grid per .tsx file; a sheet with mixed
  // per-tile sizes (this app allows that -- see exports.js's buildTilesJson
  // comment) can't be fully represented. Falls back to the first terrain
  // set's tile size, else the first tile's, else the whole sheet.
  const gridW = sheet.terrainSets?.[0]?.tileW ?? sheet.tiles[0]?.w ?? sheet.width;
  const gridH = sheet.terrainSets?.[0]?.tileH ?? sheet.tiles[0]?.h ?? sheet.height;
  const cols = Math.floor(sheet.width / gridW);

  const wangsets = (sheet.terrainSets ?? []).map(ts => {
    const wangtiles = [];
    for (let blobIndex = 0; blobIndex < blobIndexToMask.length; blobIndex++) {
      const resolved = resolveTerrainSlot(ts, blobIndex);
      if (!resolved) continue;
      const tileIndex = indexById.get(resolved.tileId);
      if (tileIndex == null) continue;
      const mask = blobIndexToMask[blobIndex];
      const wangid = WANG_BITS.map(bit => (mask & bit) ? 1 : 0).join(',');
      wangtiles.push(`<wangtile tileid="${tileIndex}" wangid="${wangid}"/>`);
    }
    return `<wangset name="${escapeXml(ts.name)}" type="mixed" tile="-1">` +
      `<wangcolor name="${escapeXml(ts.name)}" color="#ff0000" tile="-1" probability="1"/>` +
      wangtiles.join('') + `</wangset>`;
  });

  const wangsetsXml = wangsets.length ? `<wangsets>${wangsets.join('')}</wangsets>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<tileset version="1.10" tiledversion="1.10.2" name="${escapeXml(sheet.name)}" ` +
    `tilewidth="${gridW}" tileheight="${gridH}" tilecount="${sheet.tiles.length}" columns="${cols}">` +
    `<image source="${escapeXml(sheet.name)}.png" width="${sheet.width}" height="${sheet.height}"/>` +
    wangsetsXml +
    `</tileset>\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/tiledExport.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add js/app/tiledExport.js tests/tiledExport.test.mjs
git commit -m "feat: add Tiled TSX export for tile sheet terrain sets"
```

---

### Task 5: Animation export orchestrator (spritesheet+json / image sequence / GIF frame prep)

**Files:**
- Create: `js/app/animationExport.js`
- Test: `tests/animationExport.test.mjs`

**Interfaces:**
- Consumes: `flattenSheet`, `effectiveDuration` from `js/core/model.js`,
  `copyRegion` from `js/core/pixels.js` (all existing).
- Produces: `selectAnimations(sheet, animId) -> Animation[]`,
  `buildAnimationSpritesheet(sheet, anim) -> { bitmap, json }`,
  `buildAnimationImageSequence(sheet, anim) -> [{ name, bitmap }]`,
  `buildAnimationGifFrames(sheet, anim) -> [{ pixels, width, height,
  delayMs }]` (ready for `encodeGif` from Task 2). Used by Task 7/8's
  `main.js` wiring.

- [ ] **Step 1: Write the failing tests**

```js
// tests/animationExport.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, addFrame, addAnimation, sheetLayers } from '../js/core/model.js';
import { setPixel } from '../js/core/pixels.js';
import {
  selectAnimations, buildAnimationSpritesheet, buildAnimationImageSequence, buildAnimationGifFrames,
} from '../js/app/animationExport.js';

function makeSheetWithTwoFrameAnim() {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Hero', width: 8, height: 4, kind: 'sprite' });
  const layer = sheetLayers(sheet)[0];
  // frame 0 = (0,0,2,2) solid red; frame 1 = (2,0,2,2) solid green
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) setPixel(layer.bitmap, x, y, [255, 0, 0, 255]);
  for (let y = 0; y < 2; y++) for (let x = 2; x < 4; x++) setPixel(layer.bitmap, x, y, [0, 255, 0, 255]);
  const f0 = addFrame(sheet, { name: 'walk_0', x: 0, y: 0, w: 2, h: 2 });
  const f1 = addFrame(sheet, { name: 'walk_1', x: 2, y: 0, w: 2, h: 2 });
  const anim = addAnimation(sheet, 'walk');
  anim.frames.push({ frameId: f0.id, duration: 80 });
  anim.frames.push({ frameId: f1.id, duration: 120 });
  return { sheet, anim };
}

test('selectAnimations: by id, or every animation when animId is null', () => {
  const { sheet, anim } = makeSheetWithTwoFrameAnim();
  assert.deepEqual(selectAnimations(sheet, anim.id), [anim]);
  assert.deepEqual(selectAnimations(sheet, null), sheet.animations);
});

test('buildAnimationSpritesheet: frames packed left-to-right, correct pixels/offsets/durations', () => {
  const { sheet, anim } = makeSheetWithTwoFrameAnim();
  const { bitmap, json } = buildAnimationSpritesheet(sheet, anim);
  assert.equal(bitmap.width, 4);
  assert.equal(bitmap.height, 2);
  // frame 0 (red) at x=0..1, frame 1 (green) at x=2..3
  assert.deepEqual([...bitmap.data.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...bitmap.data.slice(8, 12)], [0, 255, 0, 255]);
  assert.deepEqual(json.frames.map(f => [f.name, f.x, f.w]), [['walk_0', 0, 2], ['walk_1', 2, 2]]);
  assert.deepEqual(json.animations[0].frames.map(f => f.duration), [80, 120]);
});

test('buildAnimationImageSequence: one named entry per frame, in order', () => {
  const { sheet, anim } = makeSheetWithTwoFrameAnim();
  const seq = buildAnimationImageSequence(sheet, anim);
  assert.deepEqual(seq.map(s => s.name), ['walk_000', 'walk_001']);
  assert.equal(seq[0].bitmap.width, 2);
});

test('buildAnimationGifFrames: pixels/dimensions/delay ready for encodeGif', () => {
  const { sheet, anim } = makeSheetWithTwoFrameAnim();
  const frames = buildAnimationGifFrames(sheet, anim);
  assert.deepEqual(frames.map(f => f.delayMs), [80, 120]);
  assert.equal(frames[0].width, 2);
  assert.deepEqual([...frames[0].pixels.slice(0, 4)], [255, 0, 0, 255]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/animationExport.test.mjs`
Expected: FAIL with "Cannot find module '../js/app/animationExport.js'"

- [ ] **Step 3: Write the implementation**

```js
// js/app/animationExport.js
// Builds spritesheet(PNG+JSON)/image-sequence/GIF-ready-frame output for
// one animation or every animation on a sprite sheet. Actual GIF byte
// encoding lives in js/core/gif.js -- this module only prepares frame data.
import { flattenSheet, effectiveDuration } from '../core/model.js';
import { copyRegion } from '../core/pixels.js';

function animFrameBitmaps(sheet, anim) {
  const flat = flattenSheet(sheet);
  return anim.frames.map(af => {
    const frame = sheet.frames.find(f => f.id === af.frameId);
    return { frame, bitmap: copyRegion(flat, frame.x, frame.y, frame.w, frame.h), delayMs: effectiveDuration(anim, af) };
  });
}

// A specific animation by id, or every animation on the sheet when animId
// is null/undefined.
export function selectAnimations(sheet, animId) {
  return animId ? sheet.animations.filter(a => a.id === animId) : sheet.animations;
}

// One PNG-worth-of-pixel-data per frame, packed left-to-right into a tight
// new image (not the original sheet layout), alongside the same
// Frames-JSON shape scoped to just this animation's own frames.
export function buildAnimationSpritesheet(sheet, anim) {
  const shots = animFrameBitmaps(sheet, anim);
  const width = shots.reduce((sum, s) => sum + s.bitmap.width, 0);
  const height = Math.max(...shots.map(s => s.bitmap.height));
  const packed = { width, height, data: new Uint8ClampedArray(width * height * 4) };

  let x = 0;
  const frames = shots.map((s, index) => {
    const rect = { name: s.frame.name, index, x, y: 0, w: s.bitmap.width, h: s.bitmap.height,
      pivotX: s.frame.pivotX, pivotY: s.frame.pivotY };
    for (let py = 0; py < s.bitmap.height; py++)
      for (let px = 0; px < s.bitmap.width; px++) {
        const si = (py * s.bitmap.width + px) * 4, di = (py * width + (x + px)) * 4;
        packed.data.set(s.bitmap.data.subarray(si, si + 4), di);
      }
    x += s.bitmap.width;
    return rect;
  });

  const json = {
    sheet: `${anim.name}.png`, width, height, frames,
    animations: [{ name: anim.name, loop: anim.loop,
      frames: shots.map((s, i) => ({ frame: frames[i].name, duration: s.delayMs })) }],
  };
  return { bitmap: packed, json };
}

// One { name, bitmap } per frame, named `<anim>_000`, `<anim>_001`, ...
export function buildAnimationImageSequence(sheet, anim) {
  return animFrameBitmaps(sheet, anim).map((s, i) =>
    ({ name: `${anim.name}_${String(i).padStart(3, '0')}`, bitmap: s.bitmap }));
}

// { pixels, width, height, delayMs } per frame, ready for js/core/gif.js's
// encodeGif.
export function buildAnimationGifFrames(sheet, anim) {
  return animFrameBitmaps(sheet, anim).map(s =>
    ({ pixels: s.bitmap.data, width: s.bitmap.width, height: s.bitmap.height, delayMs: s.delayMs }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/animationExport.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add js/app/animationExport.js tests/animationExport.test.mjs
git commit -m "feat: add per-animation export builders (spritesheet/sequence/gif frames)"
```

---

### Task 6: Whole-project export entry collection

**Files:**
- Create: `js/app/projectExport.js`
- Test: `tests/projectExport.test.mjs`

**Interfaces:**
- Consumes: nothing new (the concrete per-sheet builder is injected by the
  caller — see Task 8).
- Produces: `collectProjectExportEntries(project, selections,
  buildSheetExport) -> Promise<[{ path, data }]>`, where `selections:
  [{ sheetId, format }]` and `buildSheetExport(sheet, format) ->
  Promise<[{ path, data }]>`. Used by Task 8's `main.js` wiring.

- [ ] **Step 1: Write the failing test**

```js
// tests/projectExport.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet } from '../js/core/model.js';
import { collectProjectExportEntries } from '../js/app/projectExport.js';

test('collectProjectExportEntries: prefixes each builder output with its sheet name, skips missing sheets', async () => {
  const project = createProject('demo');
  const a = createSheet(project, { name: 'Hero', width: 8, height: 8, kind: 'sprite' });
  const b = createSheet(project, { name: 'Ground', width: 8, height: 8, kind: 'tile' });

  const calls = [];
  const buildSheetExport = async (sheet, format) => {
    calls.push([sheet.name, format]);
    return [{ path: `${format}.bin`, data: new Uint8Array([1]) }];
  };

  const entries = await collectProjectExportEntries(project, [
    { sheetId: a.id, format: 'json' },
    { sheetId: b.id, format: 'tsx' },
    { sheetId: 'missing', format: 'json' },
  ], buildSheetExport);

  assert.deepEqual(calls, [['Hero', 'json'], ['Ground', 'tsx']]);
  assert.deepEqual(entries.map(e => e.path), ['Hero/json.bin', 'Ground/tsx.bin']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/projectExport.test.mjs`
Expected: FAIL with "Cannot find module '../js/app/projectExport.js'"

- [ ] **Step 3: Write the implementation**

```js
// js/app/projectExport.js
// Runs a caller-supplied per-sheet export builder (the same builder the
// Document-menu "Export Sheet" dialog uses -- see main.js) across a chosen
// set of sheets, and collects every output as a flat { path, data } entry
// list ready for js/core/zip.js:zipWrite or a directory-handle walk. Kept
// as a thin, pure dispatcher: encodePng and friends are async/DOM-touching,
// so `buildSheetExport` is injected rather than imported here.
export async function collectProjectExportEntries(project, selections, buildSheetExport) {
  const entries = [];
  for (const { sheetId, format } of selections) {
    const sheet = project.sheets.find(s => s.id === sheetId);
    if (!sheet) continue;
    const sheetEntries = await buildSheetExport(sheet, format);
    for (const e of sheetEntries) entries.push({ path: `${sheet.name}/${e.path}`, data: e.data });
  }
  return entries;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/projectExport.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add js/app/projectExport.js tests/projectExport.test.mjs
git commit -m "feat: add whole-project export entry collection"
```

---

### Task 7: Document menu — "Export Sheet…" (Tiled TSX / Animation export / C99 header wiring)

**Files:**
- Modify: `index.html:45-53` (existing `#dlg-export`), plus two new
  `<dialog>` blocks added right after it
- Modify: `js/app/main.js:54-59` (export dialog DOM refs),
  `js/app/main.js:640-666` (`MENUS`), `js/app/main.js:1036-1078` (export
  action + handlers)

**Interfaces:**
- Consumes: `buildTiledTsx` (Task 4), `buildC99` (Task 3), `selectAnimations`
  / `buildAnimationSpritesheet` / `buildAnimationImageSequence` /
  `buildAnimationGifFrames` (Task 5), `encodeGif` (Task 2), `buildPalette` /
  `quantizeBitmap` (Task 1), plus existing `flattenSheet`, `copyRegion`,
  `zipWrite`, `encodePng`, `io.downloadBlob`.
- Produces: `document.exportSheet` action (replaces the old `file.export`
  action id; File menu's own export action is redefined fresh in Task 8).

No automated test: this codebase has no browser/DOM test harness (all
`tests/*.mjs` are pure `node --test` logic tests — see `tests/exports.test.mjs`
for the existing convention). Verify manually via the dev server instead.

- [ ] **Step 1: Update `index.html`'s export dialogs**

Replace the existing `#dlg-export` block and add two new dialogs right after it:

```html
<dialog id="dlg-export">
  <h3>Export Sheet</h3>
  <div class="row">
    <button id="export-png" class="btn-sm">Sheet PNG (flattened)</button>
    <button id="export-frames" class="btn-sm" disabled>Frames JSON</button>
    <button id="export-tiles" class="btn-sm" disabled>Tiles JSON</button>
    <button id="export-tsx" class="btn-sm" disabled>Tiled TSX</button>
    <button id="export-anim" class="btn-sm" disabled>Animation Export…</button>
    <button id="export-c99" class="btn-sm">C99 Header…</button>
  </div>
  <div class="row dlg-actions"><button id="export-cancel" class="btn-sm">Cancel</button></div>
</dialog>
<dialog id="dlg-export-anim">
  <h3>Animation Export</h3>
  <div class="dlg-grid">
    <span>Animation</span><select id="ea-animation" style="grid-column: 2 / span 3"></select>
  </div>
  <div class="row">
    <button id="ea-gif" class="btn-sm">GIF</button>
    <button id="ea-spritesheet" class="btn-sm">Spritesheet (PNG+JSON)</button>
    <button id="ea-sequence" class="btn-sm">Image Sequence</button>
  </div>
  <div class="row dlg-actions"><button id="ea-cancel" class="btn-sm">Cancel</button></div>
</dialog>
<dialog id="dlg-export-c99">
  <h3>C99 Header Export</h3>
  <div class="dlg-grid">
    <span>Target</span>
    <select id="ec-target" style="grid-column: 2 / span 3">
      <option value="generic8">Generic 8bpp indexed</option>
      <option value="gba4">Game Boy Advance (4bpp packed)</option>
      <option value="nes2">NES (2bpp planar CHR)</option>
    </select>
  </div>
  <div class="row dlg-actions"><button id="ec-export" class="btn-sm">Export</button><button id="ec-cancel" class="btn-sm">Cancel</button></div>
</dialog>
```

- [ ] **Step 2: Add new imports and DOM refs in `main.js`**

Near the top, alongside the existing `import { buildFramesJson, buildTilesJson } from './exports.js';`:

```js
import { buildTiledTsx } from './tiledExport.js';
import { buildC99 } from './c99Export.js';
import { selectAnimations, buildAnimationSpritesheet, buildAnimationImageSequence, buildAnimationGifFrames } from './animationExport.js';
import { encodeGif } from '../core/gif.js';
import { buildPalette, quantizeBitmap } from '../core/quantize.js';
import { encodePng } from './pngcodec.js';
import { zipWrite } from '../core/zip.js';
```

Extend `js/core/model.js`'s existing import (`main.js:4`) to also bring in
`copyRegion` — actually `copyRegion` lives in `js/core/pixels.js`, so add a
new import line:

```js
import { copyRegion } from '../core/pixels.js';
```

Next to the existing export dialog refs (`main.js:54-59`), add:

```js
const dlgExportAnim = document.getElementById('dlg-export-anim');
const eaAnimation = document.getElementById('ea-animation');
const eaGif = document.getElementById('ea-gif');
const eaSpritesheet = document.getElementById('ea-spritesheet');
const eaSequence = document.getElementById('ea-sequence');
const eaCancel = document.getElementById('ea-cancel');
markDefaultAction(dlgExportAnim, eaGif);
const dlgExportC99 = document.getElementById('dlg-export-c99');
const ecTarget = document.getElementById('ec-target');
const ecExport = document.getElementById('ec-export');
const ecCancel = document.getElementById('ec-cancel');
markDefaultAction(dlgExportC99, ecExport);
const btnExportTsx = document.getElementById('export-tsx');
const btnExportAnim = document.getElementById('export-anim');
const btnExportC99 = document.getElementById('export-c99');
```

- [ ] **Step 3: Rename the action, extend `updateExportButtons`, wire the new dialogs**

Update `MENUS` (`main.js:640-666`): remove `{ action: 'file.export' }` from
the File menu's items, add `{ action: 'document.exportSheet' }` to the
Document menu's items (after `document.deleteSheet`).

Replace `updateExportButtons` and the `file.export` action definition
(`main.js:1037-1050`) with:

```js
function updateExportButtons() {
  const sheet = activeSheet();
  const isSprite = sheet?.kind === 'sprite';
  const isTile = sheet?.kind === 'tile';
  btnExportFrames.disabled = !isSprite;
  btnExportFrames.title = isSprite ? '' : 'Only available for sprite sheets';
  btnExportTiles.disabled = !isTile;
  btnExportTiles.title = isTile ? '' : 'Only available for tile sheets';
  btnExportTsx.disabled = !isTile;
  btnExportTsx.title = isTile ? '' : 'Only available for tile sheets';
  btnExportAnim.disabled = !isSprite || !sheet.animations.length;
  btnExportAnim.title = !isSprite ? 'Only available for sprite sheets'
    : sheet.animations.length ? '' : 'No animations on this sheet';
}
defineAction('document.exportSheet', {
  label: 'Export Sheet…',
  run: () => { updateExportButtons(); dlgExport.showModal(); },
  isEnabled: () => !!state.project,
});
```

After the existing `btnExportTiles` handler (`main.js:1070-1078`), add:

```js
btnExportTsx.addEventListener('click', () => {
  dlgExport.close();
  commitFloatIfAny();
  const sheet = activeSheet();
  if (!sheet || sheet.kind !== 'tile') return;
  const xml = buildTiledTsx(sheet);
  io.downloadBlob(new Blob([xml], { type: 'application/xml' }), `${sheet.name}.tsx`);
});

btnExportAnim.addEventListener('click', () => {
  const sheet = activeSheet();
  if (!sheet) return;
  eaAnimation.innerHTML = '<option value="">All animations</option>' +
    sheet.animations.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  dlgExport.close();
  dlgExportAnim.showModal();
});
eaCancel.addEventListener('click', () => dlgExportAnim.close());

function chosenAnimations() {
  return selectAnimations(activeSheet(), eaAnimation.value || null);
}
eaGif.addEventListener('click', () => {
  dlgExportAnim.close();
  commitFloatIfAny();
  const sheet = activeSheet();
  for (const anim of chosenAnimations()) {
    const bytes = encodeGif(buildAnimationGifFrames(sheet, anim), { loop: anim.loop });
    io.downloadBlob(new Blob([bytes], { type: 'image/gif' }), `${sheet.name}-${anim.name}.gif`);
  }
});
eaSpritesheet.addEventListener('click', async () => {
  dlgExportAnim.close();
  commitFloatIfAny();
  const sheet = activeSheet();
  for (const anim of chosenAnimations()) {
    const { bitmap, json } = buildAnimationSpritesheet(sheet, anim);
    io.downloadBlob(new Blob([await encodePng(bitmap)], { type: 'image/png' }), `${sheet.name}-${anim.name}.png`);
    io.downloadBlob(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), `${sheet.name}-${anim.name}.json`);
  }
});
eaSequence.addEventListener('click', async () => {
  dlgExportAnim.close();
  commitFloatIfAny();
  const sheet = activeSheet();
  for (const anim of chosenAnimations()) {
    const entries = [];
    for (const f of buildAnimationImageSequence(sheet, anim)) entries.push({ path: `${f.name}.png`, data: await encodePng(f.bitmap) });
    io.downloadBlob(new Blob([await zipWrite(entries)]), `${sheet.name}-${anim.name}-sequence.zip`);
  }
});

btnExportC99.addEventListener('click', () => { dlgExport.close(); dlgExportC99.showModal(); });
ecCancel.addEventListener('click', () => dlgExportC99.close());
function resolveC99Items(sheet, target) {
  const flat = flattenSheet(sheet);
  const rects = sheet.kind === 'sprite' ? sheet.frames : sheet.tiles;
  const bitmaps = rects.map(r => copyRegion(flat, r.x, r.y, r.w, r.h));
  const maxColors = target === 'generic8' ? 256 : target === 'gba4' ? 16 : 4;
  const sourcePalette = state.project.palettes.find(p => p.id === state.project.activePaletteId);
  const palette = buildPalette(bitmaps, maxColors, sourcePalette).map(c => [c[0], c[1], c[2]]);
  const items = rects.map((r, i) => ({ name: r.name || `item_${i}`, w: r.w, h: r.h, indices: quantizeBitmap(bitmaps[i], palette) }));
  return { palette, items };
}
ecExport.addEventListener('click', () => {
  dlgExportC99.close();
  commitFloatIfAny();
  const sheet = activeSheet();
  if (!sheet || !state.project) return;
  const target = ecTarget.value;
  try {
    const { palette, items } = resolveC99Items(sheet, target);
    const { h, c } = buildC99({ projectName: sheet.name, target, palette, items });
    io.downloadBlob(new Blob([h], { type: 'text/plain' }), `${sheet.name}.h`);
    io.downloadBlob(new Blob([c], { type: 'text/plain' }), `${sheet.name}.c`);
  } catch (e) {
    alert(`C99 export failed: ${e.message}`);
  }
});
```

- [ ] **Step 4: Verify manually**

Run: `./serve.ps1` (or `python -m http.server 8080`), open
`http://localhost:8080`.

1. Open (or create) a project with a sprite sheet that has at least one
   animation, and a tile sheet with a terrain set.
2. `Document > Export Sheet…` on the sprite sheet: confirm PNG/Frames JSON
   still work, "Tiled TSX" is disabled, "Animation Export…" is enabled.
3. Click "Animation Export…", pick an animation, try GIF (downloads a
   `.gif` that opens/plays in a browser tab or image viewer), Spritesheet
   (downloads matching `.png`+`.json`), Image Sequence (downloads a `.zip`
   of numbered PNGs).
4. `Document > Export Sheet…` on the tile sheet: "Frames JSON" disabled,
   "Tiled TSX" enabled — click it, confirm a `.tsx` file downloads and its
   XML contains `<wangset>`/`<wangtile>` entries.
5. "C99 Header…" on both sheet kinds: try all three targets, confirm `.h`
   and `.c` files download; try a sprite sheet with a frame whose w/h isn't
   a multiple of 8 with GBA/NES targets and confirm the alert fires instead
   of a silent failure.
6. Confirm `File` menu no longer shows an "Export…" item (removed in this
   task; re-added as "Export Project…" in Task 8).

- [ ] **Step 5: Commit**

```bash
git add index.html js/app/main.js
git commit -m "feat: move sheet export to Document menu, add Tiled TSX/animation/C99 export"
```

---

### Task 8: File menu — "Export Project…" (whole-project ZIP / folder export)

**Files:**
- Modify: `index.html` (new `#dlg-export-project` dialog)
- Modify: `js/app/main.js` (new imports/refs, `MENUS`, new `file.export`
  action)
- Modify: `js/app/io.js` (factor `saveUnpacked`'s directory-walk into a
  shared helper, add `saveEntriesToFolder`)

**Interfaces:**
- Consumes: `collectProjectExportEntries` (Task 6), plus every per-sheet
  builder wired in Task 7 (via a new `buildSheetExportEntries(sheet,
  format)` dispatcher in `main.js`).
- Produces: `file.export` action (new "Export Project…" behavior),
  `io.saveEntriesToFolder(entries, dirHandle?)`.

No automated test (same reasoning as Task 7 — DOM/File-System-Access-API
code, verified manually).

- [ ] **Step 1: Add the dialog to `index.html`**

```html
<dialog id="dlg-export-project" class="dlg-wide">
  <h3>Export Project</h3>
  <div id="ep-sheets"></div>
  <div class="row">
    <label><input type="radio" name="ep-dest" id="ep-dest-zip" value="zip" checked> Download ZIP</label>
    <label id="ep-dest-folder-row" hidden><input type="radio" name="ep-dest" id="ep-dest-folder" value="folder"> Save to folder</label>
  </div>
  <div class="row dlg-actions"><button id="ep-export" class="btn-sm">Export</button><button id="ep-cancel" class="btn-sm">Cancel</button></div>
</dialog>
```

- [ ] **Step 2: Factor `io.js`'s directory-walk into a shared helper, add `saveEntriesToFolder`**

Replace `saveUnpacked` (`js/app/io.js:64-76`) with:

```js
async function writeEntriesToDir(dirHandle, entries) {
  for (const { path, data } of entries) {
    const parts = path.split('/');
    let dir = dirHandle;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(parts.at(-1), { create: true });
    const w = await fh.createWritable();
    await w.write(data); await w.close();
  }
}

export async function saveUnpacked(project, dirHandle = null) {
  if (!dirHandle) dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const entries = await buildEntries(project, encodePng);
  await writeEntriesToDir(dirHandle, entries);
  return dirHandle;
}

export async function saveEntriesToFolder(entries, dirHandle = null) {
  if (!dirHandle) dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await writeEntriesToDir(dirHandle, entries);
  return dirHandle;
}
```

- [ ] **Step 3: Wire the dialog in `main.js`**

Add DOM refs alongside Task 7's:

```js
const dlgExportProject = document.getElementById('dlg-export-project');
const epSheets = document.getElementById('ep-sheets');
const epDestFolderRow = document.getElementById('ep-dest-folder-row');
const epExport = document.getElementById('ep-export');
const epCancel = document.getElementById('ep-cancel');
markDefaultAction(dlgExportProject, epExport);
epCancel.addEventListener('click', () => dlgExportProject.close());
```

Add the import for Task 6's collector, alongside the others added in Task 7:

```js
import { collectProjectExportEntries } from './projectExport.js';
```

Add the format dispatcher and the `file.export` action (this replaces
nothing — `file.export` was removed from the registry's meaningful use in
Task 7, though `defineAction` simply overwrites the id if anything is still
registered under it):

```js
const SHEET_FORMATS = {
  sprite: [
    ['json', 'JSON + PNG'], ['gif', 'Animations (GIF, all)'],
    ['c99-generic8', 'C99 (generic 8bpp)'], ['c99-gba4', 'C99 (GBA 4bpp)'], ['c99-nes2', 'C99 (NES 2bpp)'],
  ],
  tile: [
    ['json', 'JSON + PNG'], ['tsx', 'Tiled TSX'],
    ['c99-generic8', 'C99 (generic 8bpp)'], ['c99-gba4', 'C99 (GBA 4bpp)'], ['c99-nes2', 'C99 (NES 2bpp)'],
  ],
};

async function buildSheetExportEntries(sheet, format) {
  const flat = flattenSheet(sheet);
  if (format === 'json') {
    const isSprite = sheet.kind === 'sprite';
    const json = isSprite ? buildFramesJson(sheet) : buildTilesJson(sheet);
    return [
      { path: `${sheet.name}.png`, data: await encodePng(flat) },
      { path: `${sheet.name}.${isSprite ? 'frames' : 'tiles'}.json`, data: new TextEncoder().encode(JSON.stringify(json, null, 2)) },
    ];
  }
  if (format === 'tsx') {
    return [
      { path: `${sheet.name}.png`, data: await encodePng(flat) },
      { path: `${sheet.name}.tsx`, data: new TextEncoder().encode(buildTiledTsx(sheet)) },
    ];
  }
  if (format === 'gif') {
    return sheet.animations.map(anim => ({
      path: `${anim.name}.gif`,
      data: encodeGif(buildAnimationGifFrames(sheet, anim), { loop: anim.loop }),
    }));
  }
  if (format.startsWith('c99-')) {
    const target = format.slice(4);
    const { palette, items } = resolveC99Items(sheet, target);
    const { h, c } = buildC99({ projectName: sheet.name, target, palette, items });
    return [
      { path: `${sheet.name}.h`, data: new TextEncoder().encode(h) },
      { path: `${sheet.name}.c`, data: new TextEncoder().encode(c) },
    ];
  }
  throw new Error(`unknown export format "${format}"`);
}

defineAction('file.export', {
  label: 'Export Project…',
  run: () => {
    if (!state.project) return;
    epSheets.innerHTML = '';
    for (const sheet of state.project.sheets) {
      const row = document.createElement('div');
      row.className = 'row';
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true, id: `ep-sheet-${sheet.id}` });
      const label = Object.assign(document.createElement('label'), { htmlFor: cb.id, textContent: sheet.name, style: 'flex:1' });
      const select = document.createElement('select');
      select.id = `ep-format-${sheet.id}`;
      for (const [value, text] of SHEET_FORMATS[sheet.kind]) select.appendChild(new Option(text, value));
      row.append(cb, label, select);
      epSheets.appendChild(row);
    }
    epDestFolderRow.hidden = !io.supportsFS();
    dlgExportProject.showModal();
  },
  isEnabled: () => !!state.project,
});

epExport.addEventListener('click', async () => {
  dlgExportProject.close();
  commitFloatIfAny();
  const selections = state.project.sheets
    .filter(s => document.getElementById(`ep-sheet-${s.id}`).checked)
    .map(s => ({ sheetId: s.id, format: document.getElementById(`ep-format-${s.id}`).value }));
  const entries = await collectProjectExportEntries(state.project, selections, buildSheetExportEntries);
  const dest = document.querySelector('input[name="ep-dest"]:checked').value;
  if (dest === 'folder') await io.saveEntriesToFolder(entries);
  else io.downloadBlob(new Blob([await zipWrite(entries)]), `${state.project.name}-export.zip`);
});
```

Update `MENUS` (touched again in this task): add `{ action: 'file.export' }`
back to the File menu's items, after the `file.saveAs` separator (same
position it held before Task 7 removed it).

- [ ] **Step 4: Verify manually**

Run: `./serve.ps1`, open `http://localhost:8080`.

1. Open a project with at least one sprite sheet and one tile sheet.
2. `File > Export Project…`: confirm both sheets are listed, checked by
   default, each with a format dropdown scoped to its kind (sprite sheet
   shows GIF/C99 options, no Tiled TSX; tile sheet shows Tiled TSX, no GIF).
3. Leave "Download ZIP" selected, click Export: confirm a `.zip` downloads
   containing `<SheetName>/...` folders with the expected files per chosen
   format.
4. Uncheck one sheet, change the other's format, re-export: confirm only
   the checked sheet's chosen-format output is in the resulting ZIP.
5. In Chrome/Edge, select "Save to folder" (only visible there), export,
   pick a directory, confirm the same file layout is written to disk
   instead of zipped.

- [ ] **Step 5: Commit**

```bash
git add index.html js/app/main.js js/app/io.js
git commit -m "feat: add File > Export Project (whole-project ZIP/folder export)"
```

---

## Post-plan

After Task 8, run `npm test` once more to confirm the full suite (including
all six new pure-logic test files) passes together, then hand off to
`superpowers:finishing-a-development-branch`.
