// Palette file formats: parse and serialize only. Deliberately free of DOM,
// host and pngcodec imports (pngcodec needs OffscreenCanvas) so the whole
// module runs under `node --test` -- the PNG helpers below the text formats
// are pure bitmap math for the same reason, and the actual encode/decode
// lives in the feature layer.
//
// Every format here is RGB-only: export drops alpha, import forces 255.
// Palettes in this app can carry alpha (the color panel has an alpha
// slider), so that loss is real and worth knowing about -- none of these
// four interchange formats has an alpha channel to put it in.
//
// Every entry is written, empty slots included: a palette locked to 54
// exports 54 entries, which is the point of locking it.

import { colorFrequency } from './quantize.js';

export const PALETTE_FORMATS = ['gpl', 'hex', 'pal', 'png'];

export function formatFromFilename(filename) {
  const parts = String(filename).split('.');
  if (parts.length < 2) return null;
  const ext = parts.pop().toLowerCase();
  return PALETTE_FORMATS.includes(ext) ? ext : null;
}

// `.hex` and `.png` have no metadata channel and `.pal` has no room for the
// reason, so the filename is where provenance survives for three of the
// four formats. Kept identical across all four so a set of exports of the
// same palette sorts together.
export function paletteFilename(palette, ext) {
  const suffix = palette.lock
    ? ` (${palette.lock.reason ? `${palette.lock.reason} ` : ''}${palette.lock.size})`
    : '';
  const base = `${palette.name}${suffix}`.replace(/[\/:*?"<>|]/g, '_');
  return `${base}.${ext}`;
}

// ---- GIMP .gpl ----
// The only one of the four with a metadata channel: `Name:` is standard, and
// the lock rides in a `#` comment that every other .gpl reader ignores.
const GPL_LOCK_RE = /^#\s*Locked to\s+(\d+)\s+entries(?:\s*\(([^)]*)\))?/i;

export function serializeGpl(palette) {
  const lines = ['GIMP Palette', `Name: ${palette.name}`, 'Columns: 16'];
  if (palette.lock) lines.push(`# Locked to ${palette.lock.size} entries (${palette.lock.reason})`);
  for (const [r, g, b] of palette.colors) {
    lines.push(`${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseGpl(text) {
  let name = '', lock = null;
  const colors = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^GIMP Palette$/i.test(line) || /^Columns:/i.test(line)) continue;
    if (/^Name:/i.test(line)) { name = line.slice(5).trim(); continue; }
    if (line.startsWith('#')) {
      const m = line.match(GPL_LOCK_RE);
      if (m) lock = { size: Number(m[1]), reason: m[2] ?? '' };
      continue;
    }
    const rgb = readRgb(line);
    if (rgb) colors.push(rgb);
  }
  return { name, colors, lock };
}

// A .gpl color line is "r g b" plus an optional trailing color name, so read
// the first three fields and ignore the rest.
function readRgb(line) {
  const parts = line.split(/\s+/);
  if (parts.length < 3) return null;
  const rgb = parts.slice(0, 3).map(Number);
  if (!rgb.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) return null;
  return [rgb[0], rgb[1], rgb[2], 255];
}

// ---- plain hex ----
// One rrggbb per line. Written separately from core/palettes.js's
// parseHexColors, which splits on whitespace and validates nothing -- a
// hand-edited .hex file wants the `#` prefix tolerated and junk lines
// skipped rather than turned into NaN swatches.
export function serializeHex(palette) {
  const hex = palette.colors.map(([r, g, b]) =>
    [r, g, b].map(v => v.toString(16).padStart(2, '0')).join(''));
  return `${hex.join('\n')}\n`;
}

export function parseHex(text) {
  const colors = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(line)) continue;
    colors.push([
      parseInt(line.slice(0, 2), 16),
      parseInt(line.slice(2, 4), 16),
      parseInt(line.slice(4, 6), 16),
      255,
    ]);
  }
  return { name: '', colors, lock: null };
}

// ---- JASC .pal ----
// Header is JASC-PAL / 0100 / count, so the entry count is self-evident in
// the file itself -- that IS this format's provenance for a locked palette.
// CRLF because that is what the format's own tooling writes.
export function serializePal(palette) {
  const lines = ['JASC-PAL', '0100', String(palette.colors.length)];
  for (const [r, g, b] of palette.colors) lines.push(`${r} ${g} ${b}`);
  return `${lines.join('\r\n')}\r\n`;
}

export function parsePal(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!/^JASC-PAL$/i.test(lines[0] ?? '')) throw new Error('not a JASC-PAL file');
  const declared = Number(lines[2]);
  const body = lines.slice(3);
  const limit = Number.isInteger(declared) && declared >= 0 ? declared : body.length;
  const colors = [];
  for (const line of body.slice(0, limit)) {
    const rgb = readRgb(line);
    if (rgb) colors.push(rgb);
  }
  return { name: '', colors, lock: null };
}

// ---- dispatch ----
export function serializePaletteText(palette, format) {
  if (format === 'gpl') return serializeGpl(palette);
  if (format === 'hex') return serializeHex(palette);
  if (format === 'pal') return serializePal(palette);
  throw new Error(`not a text palette format: ${format}`);
}

export function parsePaletteText(text, format) {
  if (format === 'gpl') return parseGpl(text);
  if (format === 'hex') return parseHex(text);
  if (format === 'pal') return parsePal(text);
  throw new Error(`not a text palette format: ${format}`);
}

// ---- PNG swatch strip ----
// The least precise of the four formats: a PNG carries no entry order, no
// name and no count, so an import can only recover the distinct colors --
// ordered by frequency, which is not the order they were authored in.
// Round-tripping a palette through PNG is lossy by construction; the format
// exists because swatch strips are how palettes get shared in practice.

export const PALETTE_PNG_CELL = 16;

export function paletteToStripBitmap(palette, { cell = PALETTE_PNG_CELL, columns = 16 } = {}) {
  const n = palette.colors.length;
  // A zero-width bitmap is not a thing any encoder will accept, and an
  // empty palette is a legitimate thing to export.
  if (n === 0) return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  const cols = Math.max(1, Math.min(columns, n));
  const rows = Math.ceil(n / cols);
  const width = cols * cell, height = rows * cell;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = palette.colors[i];
    const ox = (i % cols) * cell, oy = Math.floor(i / cols) * cell;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const o = ((oy + y) * width + (ox + x)) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

// colorFrequency keys on full RGBA, so force opacity first and then dedupe:
// two source pixels that differ only in alpha are one palette color here.
export function bitmapToPaletteColors(bitmap) {
  const seen = new Set(), out = [];
  for (const [r, g, b] of colorFrequency([bitmap])) {
    const key = `${r},${g},${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([r, g, b, 255]);
  }
  return out;
}
