// js/features/brushes/brush-files.js
// Browser glue between the pure format code in js/core/brush-io.js and the
// file system. Mirrors js/features/palettes/palette-files.js: File System
// Access API with a downloadBlob fallback. Everything here is IO and DOM;
// the parsing/serializing/bitmap math all stays in brush-io.js so it stays
// node-testable -- never add a window/document/Blob reference there.
import {
  bitmapToBrush, brushToBitmap,
  serializeBrushJson, parseBrushJson,
  serializeLibraryJson, parseLibraryJson,
} from '../../core/brush-io.js';
import { encodePng, decodePng } from '../../core/pngcodec.js';
import { downloadBlob, supportsFS } from '../../platform/browser/project-io.js';

const BRUSH_FILE_TYPES = [{
  description: 'Brush files',
  accept: { 'application/octet-stream': ['.json', '.png'] },
}];

// `.png` has no metadata channel at all (mask + stamp colors only, no ink/
// pressure/spacing), so unlike a palette's lock reason there is nothing to
// fold into the filename beyond the name itself.
export function brushFilename(brush, format) {
  const base = brush.name.replace(/[\/:*?"<>|]/g, '_');
  return format === 'png' ? `${base}.png` : `${base}.brush.json`;
}

async function brushBlob(brush, format) {
  if (format === 'png') {
    const bytes = await encodePng(brushToBitmap(brush));
    return new Blob([bytes], { type: 'image/png' });
  }
  return new Blob([serializeBrushJson(brush)], { type: 'application/json' });
}

export async function exportBrush(brush, format) {
  const filename = brushFilename(brush, format);
  const blob = await brushBlob(brush, format);
  if (supportsFS()) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: filename });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch {
      // User cancelled the picker, or the API refused -- fall through to the
      // download path rather than failing the export outright.
    }
  }
  downloadBlob(blob, filename);
}

function pickFileFallback(accept) {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept });
    input.onchange = () => resolve(input.files[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

async function pickBrushFile() {
  if (supportsFS()) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: BRUSH_FILE_TYPES });
      return handle.getFile();
    } catch {
      return null;
    }
  }
  return pickFileFallback('.json,.png');
}

// Pure: decides whether a parsed JSON file is a whole-library export
// (serializeLibraryJson's shape -- a bare array, or `{version, brushes}`) or
// a single brush, and parses it with the matching core function either way.
// Split out from importBrush() below specifically so this decision -- and
// both parse paths -- are testable without a DOM (importBrush itself needs
// `window`/`document` to pick the file in the first place).
export function parseImportedBrushJson(text) {
  const raw = JSON.parse(text);
  const isLibrary = Array.isArray(raw) || Array.isArray(raw?.brushes);
  return isLibrary ? parseLibraryJson(text) : parseBrushJson(text);
}

// Returns a single Brush (a .png, or a .json holding one brush), an ARRAY of
// Brushes (a .json library file), or null if the picker was cancelled. The
// caller (the manager dialog) tells the two apart with Array.isArray before
// handing either shape to mergeIncoming, which wants a list regardless.
//
// Import never overwrites anything that already exists in the library --
// same "always creates, never overwrites the current selection" rule
// palette-files.js's importPalette documents for palettes -- mergeIncoming
// is what lets the caller honor that by id.
export async function importBrush() {
  const file = await pickBrushFile();
  if (!file) return null;
  if (/\.png$/i.test(file.name)) {
    const bitmap = await decodePng(new Uint8Array(await file.arrayBuffer()));
    const name = file.name.replace(/\.[^.]+$/, '');
    return bitmapToBrush(bitmap, name);
  }
  return parseImportedBrushJson(await file.text());
}
