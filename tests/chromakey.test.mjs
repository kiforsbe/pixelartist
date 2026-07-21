import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromaKeyBitmap, distanceHistogram } from '../js/core/chromakey.js';

function bmp(width, height, pixels) {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((rgba, i) => data.set(rgba, i * 4));
  return { width, height, data };
}

test('chromaKeyBitmap transparent mode: full match (within tolerance, no softness) zeroes RGBA like the eraser', () => {
  const b = bmp(1, 1, [[10, 10, 10, 255]]); // near-black, well inside 50% tolerance of a black key
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 50, softness: 0, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [0, 0, 0, 0]);
});

test('chromaKeyBitmap: pixel beyond tolerance+softness is left byte-identical', () => {
  const b = bmp(1, 1, [[200, 200, 200, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 10, softness: 0, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [200, 200, 200, 255]);
});

test('chromaKeyBitmap: fully transparent source pixels are skipped even at zero distance', () => {
  const b = bmp(1, 1, [[0, 0, 0, 0]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 100, softness: 0, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [0, 0, 0, 0]);
});

test('chromaKeyBitmap transparent mode: mid-softness-band match gets partial alpha; RGB unaffected here since the pixel is already neutral grey', () => {
  // A grey key (black) has zero chrominance, so distance against a grey pixel reduces to
  // exactly |pixelValue| (Cb/Cr both 0 for any grey, Y == the grey's own value since the
  // Rec.601 luma coefficients sum to 1) -- at tolerance=0/softness=100 that puts distance=100
  // at strength (300-100)/300 = 2/3 exactly, so alpha comes out to round(255*(1 - 2/3)) = 85
  // with no rounding ambiguity. Spill-suppression desaturation (see the dedicated test below)
  // is a no-op on an already-grey pixel -- its luma equals every channel already -- so RGB
  // stays [100,100,100] here specifically, not because desaturation was skipped.
  const b = bmp(1, 1, [[100, 100, 100, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 0, softness: 100, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [100, 100, 100, 85]);
});

test('chromaKeyBitmap replace mode: full-strength match lerps RGB fully to replacementColor, alpha untouched', () => {
  const b = bmp(1, 1, [[200, 150, 50, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 100, softness: 0, mode: 'replace', replacementColor: [10, 20, 30] });
  assert.deepEqual([...out.data], [10, 20, 30, 255]);
});

test('chromaKeyBitmap replace mode: mid-softness-band match partially blends RGB toward replacementColor', () => {
  // Same grey-key/grey-pixel trick as the transparent-mode mid-band test: distance=100,
  // strength = (300-100)/300 = 2/3 exactly.
  // newR = round(100 + (255-100) * 2/3) = round(203.33...) = 203
  const b = bmp(1, 1, [[100, 100, 100, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 0, softness: 100, mode: 'replace', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [203, 203, 203, 255]);
});

test('chromaKeyBitmap transparent mode: partial match on a colorful pixel desaturates it toward its own luminance (spill suppression)', () => {
  // key=[20,50,235] is saturated enough (chroma magnitude ~102) to clamp keySaturation to 1,
  // giving a fixed lumaWeight of exactly 0.15. pixel = key - 20 in every channel: Cb/Cr are
  // unaffected by a uniform per-channel shift (their coefficients sum to 0 by construction),
  // so dCb = dCr = 0 exactly and dY = -20 exactly, giving distance = |-20 * 0.15| = 3 exactly.
  // At tolerance=0/softness=100 (edge=300), strength = (300-3)/300 = 99/100 = 0.99 exactly.
  // luma = 0.299*0 + 0.587*30 + 0.114*215 = 42.12
  // newR = round(0 + 42.12*0.99) = round(41.6988) = 42
  // newG = round(30 + (42.12-30)*0.99) = round(41.9988) = 42
  // newB = round(215 + (42.12-215)*0.99) = round(43.8488) = 44
  // newA = round(255 * (1-0.99)) = round(2.55) = 3
  const b = bmp(1, 1, [[0, 30, 215, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [20, 50, 235], tolerance: 0, softness: 100, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [42, 42, 44, 3]);
});

test('chromaKeyBitmap: one key pick catches multiple shades of the same hue, but leaves a differently-hued pixel of similar darkness untouched', () => {
  // The whole point of matching on chrominance instead of raw RGB: a bright green and a
  // shadowed/dark green are far apart in plain RGB distance, but close in Cb/Cr (same hue).
  // A dark blue and a dark red sit at roughly the same brightness as the dark green, but on
  // a completely different hue -- chrominance keeps them clearly separated regardless.
  const key = [0, 255, 0], tolerance = 60, softness = 0, replacementColor = [255, 255, 255];
  const key1 = chromaKeyBitmap(bmp(1, 1, [[50, 220, 50, 255]]), { keyColor: key, tolerance, softness, mode: 'transparent', replacementColor });
  const key2 = chromaKeyBitmap(bmp(1, 1, [[10, 80, 10, 255]]), { keyColor: key, tolerance, softness, mode: 'transparent', replacementColor });
  const keptBlue = chromaKeyBitmap(bmp(1, 1, [[10, 10, 80, 255]]), { keyColor: key, tolerance, softness, mode: 'transparent', replacementColor });
  const keptRed = chromaKeyBitmap(bmp(1, 1, [[80, 10, 10, 255]]), { keyColor: key, tolerance, softness, mode: 'transparent', replacementColor });
  assert.deepEqual([...key1.data], [0, 0, 0, 0]);
  assert.deepEqual([...key2.data], [0, 0, 0, 0]);
  assert.deepEqual([...keptBlue.data], [10, 10, 80, 255]);
  assert.deepEqual([...keptRed.data], [80, 10, 10, 255]);
});

test('chromaKeyBitmap: percent-to-radius easing keeps a modest softness from sweeping in loosely-similar colors', () => {
  // Radius is eased with a square curve (see percentToRadius in the source), not linear, so a
  // grey pixel just 20 units off black on the grey axis falls outside even the full
  // 0%-tolerance + 10%-softness band (edge = (10/100)^2 * 300 = 3) and is left untouched.
  const b = bmp(1, 1, [[20, 20, 20, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 0, softness: 10, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [20, 20, 20, 255]);
});

test('chromaKeyBitmap: protectColor fully shields a pixel that exactly matches both the key and the protect color', () => {
  const key = [0, 255, 0];
  const b = bmp(1, 1, [[...key, 255]]);
  const out = chromaKeyBitmap(b, {
    keyColor: key, tolerance: 50, softness: 0, mode: 'transparent', replacementColor: [255, 255, 255],
    protectColor: key, protectTolerance: 50, protectSoftness: 0,
  });
  // Without protection this pixel is a full key match (dist=0) and would get zeroed --
  // protectStrength is also 1 here (dist to protectColor is 0 too, same color), so effective
  // strength = 1 * (1-1) = 0 and the pixel is left completely untouched.
  assert.deepEqual([...out.data], [0, 255, 0, 255]);
});

test('chromaKeyBitmap: protectColor partially shields a pixel that only partially matches the protect color', () => {
  const key = [0, 255, 0];
  const pixel = [10, 90, 10, 255]; // dark greenish -- a strong key match on its own
  const withoutProtect = chromaKeyBitmap(bmp(1, 1, [pixel]), { keyColor: key, tolerance: 60, softness: 20, mode: 'transparent', replacementColor: [255, 255, 255] });
  const withProtect = chromaKeyBitmap(bmp(1, 1, [pixel]), {
    keyColor: key, tolerance: 60, softness: 20, mode: 'transparent', replacementColor: [255, 255, 255],
    protectColor: [0, 0, 0], protectTolerance: 40, protectSoftness: 40,
  });
  assert.deepEqual([...withoutProtect.data], [0, 0, 0, 0]); // fully keyed with no protection at all
  assert.deepEqual([...withProtect.data], [33, 74, 33, 132]); // shielded: keeps some alpha and color, not zeroed
});

test('distanceHistogram: buckets pixel counts by distance from the reference color', () => {
  const b = bmp(3, 1, [[0, 0, 0, 255], [50, 50, 50, 255], [255, 255, 255, 255]]);
  const { counts, maxDistance } = distanceHistogram([b], [0, 0, 0], 10);
  // Grey-on-grey distance reduces to the plain pixel value (same identity the mid-band tests
  // above rely on): dist(black)=0 -> bucket 0, dist([50,50,50])=50 -> bucket floor(50/300*10)=1,
  // dist(white)=255 -> bucket floor(255/300*10)=8.
  assert.deepEqual([...counts], [1, 1, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert.equal(maxDistance, 300);
});

test('distanceHistogram: fully transparent pixels are excluded, same as chromaKeyBitmap', () => {
  const b = bmp(1, 1, [[0, 0, 0, 0]]);
  const { counts } = distanceHistogram([b], [0, 0, 0], 4);
  assert.deepEqual([...counts], [0, 0, 0, 0]);
});

test('chromaKeyBitmap: does not mutate the input bitmap', () => {
  const b = bmp(1, 1, [[10, 10, 10, 255]]);
  const before = [...b.data];
  chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 50, softness: 0, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...b.data], before);
});
