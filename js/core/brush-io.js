// js/core/brush-io.js
// Brush file formats. Pure; no DOM, no File API.
//
// PNG is the shareable format: opaque pixels are mask coverage and their
// colors are the `stamp` payload, so a brush can be authored in the app
// itself. JSON carries the settings a PNG cannot -- ink kind, opacity,
// spacing, scatter, pressure.

import { createBitmap, setPixel, getPixel } from './pixels.js';
import { normalizeBrush, MAX_CUSTOM_BITMAP_DIM } from './brushes.js';

export function bitmapToBrush(bitmap, name = 'Brush') {
  const bits = new Uint8Array(bitmap.width * bitmap.height);
  const colors = [];
  for (let y = 0, i = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++, i++) {
      const p = getPixel(bitmap, x, y);
      bits[i] = p[3] > 0 ? 1 : 0;
      colors.push([p[0], p[1], p[2], p[3]]);
    }
  }
  return normalizeBrush({
    name,
    mask: { kind: 'custom', bitmap: { width: bitmap.width, height: bitmap.height, bits }, colors },
  });
}

export function brushToBitmap(brush) {
  const g = brush.mask.bitmap;
  if (!g) return createBitmap(1, 1);
  const out = createBitmap(g.width, g.height);
  const colors = brush.mask.colors;
  for (let y = 0, i = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++, i++) {
      if (!g.bits[i]) continue;
      setPixel(out, x, y, colors?.[i] ?? [0, 0, 0, 255]);
    }
  }
  return out;
}

// Uint8Array does not survive JSON, so the mask bits travel as a plain array
// and are rehydrated on the way back in.
function toPlain(brush) {
  const b = { ...brush, mask: { ...brush.mask } };
  if (b.mask.bitmap) {
    b.mask.bitmap = { ...b.mask.bitmap, bits: Array.from(b.mask.bitmap.bits) };
  }
  return b;
}

// Defence against a hostile/corrupt file, ahead of normalizeBrush: a custom
// bitmap whose declared dimensions exceed the cap or whose `bits` length
// disagrees with width*height is refused outright rather than silently
// degraded. rasterizeMask (brushes.js) already clamps the same cap as a last
// line of defence for any caller that bypasses this parser, but a bad FILE
// should be reported as bad, not quietly turned into a garbage brush --
// (see task-11-brief-amendment.md Ruling 30). Only fires when both
// dimensions are given and finite: negative/NaN/short-bits cases already
// degrade safely inside rasterizeMask and are deliberately left to it.
function assertSaneCustomBitmap(bmp) {
  if (!bmp || typeof bmp !== 'object') return;
  const w = Number(bmp.width), h = Number(bmp.height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return;
  if (w > MAX_CUSTOM_BITMAP_DIM || h > MAX_CUSTOM_BITMAP_DIM) {
    throw new Error('Custom brush mask exceeds the maximum allowed size');
  }
  if (Array.isArray(bmp.bits) && bmp.bits.length !== w * h) {
    throw new Error('Custom brush mask bits length does not match its declared dimensions');
  }
}

function fromPlain(raw) {
  assertSaneCustomBitmap(raw?.mask?.bitmap);
  const b = normalizeBrush(raw);
  if (b.mask.bitmap?.bits) {
    b.mask.bitmap = { ...b.mask.bitmap, bits: Uint8Array.from(b.mask.bitmap.bits) };
  }
  return b;
}

export function serializeBrushJson(brush) {
  return JSON.stringify(toPlain(brush), null, 2);
}

export function parseBrushJson(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Not a brush file');
  return fromPlain(raw);
}

export function serializeLibraryJson(brushes) {
  return JSON.stringify({ version: 1, brushes: brushes.map(toPlain) }, null, 2);
}

export function parseLibraryJson(text) {
  const raw = JSON.parse(text);
  const list = Array.isArray(raw) ? raw : raw?.brushes;
  if (!Array.isArray(list)) throw new Error('Not a brush library file');
  return list.map(fromPlain);
}
