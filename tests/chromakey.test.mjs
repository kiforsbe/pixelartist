import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromaKeyBitmap } from '../js/core/chromakey.js';

function bmp(width, height, pixels) {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((rgba, i) => data.set(rgba, i * 4));
  return { width, height, data };
}

test('chromaKeyBitmap transparent mode: full match (within tolerance, no softness) zeroes RGBA like the eraser', () => {
  const b = bmp(1, 1, [[10, 10, 10, 255]]); // ~3.9% off black on the grey axis, well inside 50% tolerance
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
  // Grey-axis key (black) + grey-axis pixel cancels the sqrt(3) term out of the strength
  // ratio, so at tolerance=0/softness=100 strength reduces exactly to (255 - d) / 255,
  // which makes the resulting alpha come out to exactly d (128) with no rounding ambiguity.
  // Spill-suppression desaturation (see the dedicated test below) is a no-op on an
  // already-grey pixel -- its luma equals every channel already -- so RGB stays [128,128,128]
  // here specifically, not because desaturation was skipped.
  const b = bmp(1, 1, [[128, 128, 128, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 0, softness: 100, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [128, 128, 128, 128]);
});

test('chromaKeyBitmap transparent mode: partial match on a colorful pixel desaturates it toward its own luminance (spill suppression)', () => {
  // Key is colorful (not grey) here, and the pixel is key+50 in every channel -- same
  // grey-axis-relative-to-key trick as above (dist = 50*sqrt(3), so tolerance=0/softness=100
  // gives strength = (255sqrt3 - 50sqrt3) / 255sqrt3 = 205/255 = 41/51 exactly), but since the
  // KEY isn't grey, the pixel itself, [50,150,250], isn't grey either -- so desaturation has a
  // real, checkable effect this time. luma = 0.299*50 + 0.587*150 + 0.114*250 = 131.5.
  // newR = round(50 + (131.5-50)*41/51) = round(115.5196) = 116
  // newG = round(150 + (131.5-150)*41/51) = round(135.1275) = 135
  // newB = round(250 + (131.5-250)*41/51) = round(154.7353) = 155
  // newA = round(255 * (1 - 41/51)) = round(255 * 10/51) = 50 exactly (255/51 = 5)
  const b = bmp(1, 1, [[50, 150, 250, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 100, 200], tolerance: 0, softness: 100, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [116, 135, 155, 50]);
});

test('chromaKeyBitmap: percent-to-radius easing keeps a modest softness from sweeping in loosely-similar colors', () => {
  // Radius is eased with a square curve (see percentToRadius in the source), not linear, so a
  // grey pixel just 20 units off black on the grey axis (dist = 20*sqrt(3) ~= 34.6) falls
  // outside even the full 0%-tolerance + 10%-softness band (edge = (10/100)^2 * 255sqrt(3) ~=
  // 4.4) and is left completely untouched -- a linear mapping would have given this same
  // 10% softness an edge of ~44, which WOULD have partially caught this pixel.
  const b = bmp(1, 1, [[20, 20, 20, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 0, softness: 10, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [20, 20, 20, 255]);
});

test('chromaKeyBitmap replace mode: full-strength match lerps RGB fully to replacementColor, alpha untouched', () => {
  const b = bmp(1, 1, [[200, 150, 50, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 100, softness: 0, mode: 'replace', replacementColor: [10, 20, 30] });
  assert.deepEqual([...out.data], [10, 20, 30, 255]);
});

test('chromaKeyBitmap replace mode: mid-softness-band match partially blends RGB toward replacementColor', () => {
  const b = bmp(1, 1, [[128, 128, 128, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 0, softness: 100, mode: 'replace', replacementColor: [255, 255, 255] });
  // strength = (255-128)/255 = 127/255; newR = round(128 + (255-128) * 127/255) = round(191.25...) = 191
  assert.deepEqual([...out.data], [191, 191, 191, 255]);
});

test('chromaKeyBitmap: does not mutate the input bitmap', () => {
  const b = bmp(1, 1, [[10, 10, 10, 255]]);
  const before = [...b.data];
  chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 50, softness: 0, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...b.data], before);
});
