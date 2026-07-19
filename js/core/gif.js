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
    const gceFlags = 0x08 | (transparentIndex >= 0 ? 0x01 : 0x00); // disposal=2 (restore to background), transparency flag
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
