// Browser glue between the pure format code in js/core/palette-io.js and the
// file system. Everything here is IO and DOM; the parsing, serializing and
// bitmap math all live in core so they stay node-testable.
import {
  formatFromFilename, paletteFilename, serializePaletteText, parsePaletteText,
  paletteToStripBitmap, bitmapToPaletteColors,
} from '../../core/palette-io.js';
import { createPalette, addSwatch, setLock } from '../../core/palettes.js';
import { medianCutPalette, colorFrequency } from '../../core/quantize.js';
import { encodePng, decodePng } from '../../core/pngcodec.js';
import { downloadBlob, supportsFS } from '../../platform/browser/project-io.js';

const PALETTE_FILE_TYPES = [{
  description: 'Palette files',
  accept: { 'application/octet-stream': ['.gpl', '.hex', '.pal', '.png'] },
}];

async function paletteBlob(palette, format) {
  if (format === 'png') {
    const bytes = await encodePng(paletteToStripBitmap(palette));
    return new Blob([bytes], { type: 'image/png' });
  }
  return new Blob([serializePaletteText(palette, format)], { type: 'text/plain' });
}

export async function exportPalette(palette, format) {
  const filename = paletteFilename(palette, format);
  const blob = await paletteBlob(palette, format);
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

async function pickPaletteFile() {
  if (supportsFS()) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: PALETTE_FILE_TYPES });
      return handle.getFile();
    } catch {
      return null;
    }
  }
  return pickFileFallback('.gpl,.hex,.pal,.png');
}

// Import ALWAYS creates a new palette -- never overwrites the selected one,
// so there is no destructive path here at all. The name comes from the
// .gpl header when there is one, else the filename.
export async function importPalette() {
  const file = await pickPaletteFile();
  if (!file) return null;
  const format = formatFromFilename(file.name);
  if (!format) throw new Error(`unsupported palette format: ${file.name}`);

  let parsed;
  if (format === 'png') {
    const bitmap = await decodePng(new Uint8Array(await file.arrayBuffer()));
    parsed = { name: '', colors: bitmapToPaletteColors(bitmap), lock: null };
  } else {
    parsed = parsePaletteText(await file.text(), format);
  }
  if (parsed.colors.length === 0) throw new Error(`no colors found in ${file.name}`);

  const fallbackName = file.name.replace(/\.[^.]+$/, '');
  // Built unlocked and filled via addSwatch so `colors` and `empty` are only
  // ever grown together, then locked afterwards if the file said so.
  const palette = createPalette({ name: parsed.name || fallbackName });
  for (const c of parsed.colors) addSwatch(palette, c);
  // A .gpl lock comment can disagree with the entry count it was written
  // beside (hand-edited file, truncated export). colors.length is the
  // authority; only the reason is taken from the comment.
  if (parsed.lock) setLock(palette, palette.colors.length, parsed.lock.reason);
  return palette;
}

// maxColors === 0 means "every distinct color", which is what you want when
// lifting a palette off pixel art that is already palettised.
export function paletteFromArtwork(bitmaps, maxColors) {
  const colors = maxColors > 0
    ? medianCutPalette(bitmaps, maxColors).map(c => [c[0], c[1], c[2], 255])
    : colorFrequency(bitmaps).map(c => [c[0], c[1], c[2], 255]);
  const palette = createPalette({ name: 'From artwork' });
  for (const c of colors) addSwatch(palette, c);
  return palette;
}
