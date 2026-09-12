// js/core/brush-io.js
// Brush file formats. Pure; no DOM, no File API.
//
// PNG is the shareable format: opaque pixels are mask coverage and their
// colors are the `stamp` payload, so a brush can be authored in the app
// itself. JSON carries the settings a PNG cannot -- ink kind, opacity,
// spacing, scatter, pressure.

import { createBitmap, setPixel, getPixel, copyRegion } from './pixels.js';
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

// --- Make Brush From Selection (Task 15b, moved here in fix round 1) -----
//
// Pure: takes whatever bitmap the caller hands it and crops `rect` out of it
// before turning the crop into a custom-mask brush. It has no opinion on
// WHICH bitmap that should be -- that choice belongs to the caller, not to
// this function, which is why it stays a 3-line wrapper over copyRegion +
// bitmapToBrush with no DOM/host dependency.
//
// The one production call site (js/features/brushes/brush-manager.js's
// `brush.fromSelection` action) passes flattenSheet(sheet) -- the COMPOSITE
// of every visible layer -- not activeLayer().bitmap. A user who marquees a
// region of a multi-layer sprite and asks for a brush is asking for what
// they can see; handing them a brush built from one layer, with pixels from
// other layers silently missing, would not match their selection and
// nothing on screen would explain why. captureLayers (the clipboard's path,
// float-session.js) defaults to the active layer for a different reason --
// cut/copy is meant to move that layer's content -- which does not apply
// here.
// The bound an in-app capture is held to, exported so a caller can compare it
// against the rect it asked for and TELL the user its selection was cropped.
//
// Capture is a PRODUCER of custom masks, and every consumer of one
// (fromPlain, and so library.add / project load / file import) refuses a
// bitmap over MAX_CUSTOM_BITMAP_DIM outright -- correctly, for an untrusted
// file. A marquee is not an untrusted file, but it is just as easily over the
// cap: any selection wider or taller than 256px produced a brush that
// library.add then threw on, from inside a CommandRegistry.execute that does
// not catch, so the capture failed with no brush and no message at all.
//
// Bounding the REGION is not the same thing as clamping the finished mask,
// and the difference matters: copyRegion produces a bitmap whose stride
// matches its own width, whereas rasterizeMask re-reads an oversized source's
// bits at the DECLARED width and shears the result (a vertical line comes out
// diagonal). The size has to be settled before the pixels are read, which is
// here.
export function boundedBrushRegion(rect) {
  return {
    x: rect.x,
    y: rect.y,
    w: Math.max(0, Math.min(MAX_CUSTOM_BITMAP_DIM, rect.w)),
    h: Math.max(0, Math.min(MAX_CUSTOM_BITMAP_DIM, rect.h)),
  };
}

export function brushFromSelection(bitmap, rect, name) {
  // Bounded here as well as at the call site: this is the in-app producer, and
  // it must not be able to hand back a brush that the library will refuse,
  // whichever caller reaches it.
  const r = boundedBrushRegion(rect);
  return bitmapToBrush(copyRegion(bitmap, r.x, r.y, r.w, r.h), name);
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
//
// Exported (Task 12) so js/core/model.js can apply the identical transform to
// brushes embedded in a project file. bundle.js JSON.stringifies the whole
// project body -- unlike sheet bitmaps, which ride separately as PNG images
// -- so an embedded custom-mask brush hits exactly the same Uint8Array-through-
// JSON hazard a standalone .brush.json file does; reusing this function keeps
// the two paths from drifting into two different (and possibly differently
// buggy) answers to the same problem.
export function toPlain(brush) {
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

// Exported (Task 12) alongside toPlain, for the same reason: model.js must
// rehydrate embedded brushes with the identical logic a standalone file uses,
// including the hostile-dimension check -- a corrupt project file is no more
// trustworthy than a corrupt .brush.json.
export function fromPlain(raw) {
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
