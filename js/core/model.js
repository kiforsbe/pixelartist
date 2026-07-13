import { createBitmap, cloneBitmap, getPixel, setPixel } from './pixels.js';
import { newId } from './palettes.js';

export const PROJECT_VERSION = 2;
export const DEFAULT_SETTINGS = {
  spriteSheetW: 256, spriteSheetH: 256,
  tileSheetW: 256, tileSheetH: 256,
  tileW: 16, tileH: 16,
  frameW: 16, frameH: 16,
  durationMs: 100,
};
const MAX_DIM = 4096;

export function createProject(name, settings = { ...DEFAULT_SETTINGS }) {
  return { version: PROJECT_VERSION, name, settings: { ...settings },
    sheets: [], palettes: [], activePaletteId: null };
}

export function createSheet(project, { name, width, height, kind, tileW, tileH }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM)
    throw new Error(`sheet size must be 1..${MAX_DIM}`);
  const sheet = {
    id: newId('sh'), name, width, height, kind,
    layers: [], frames: [], animations: [],
    tile: kind === 'tile'
      ? { tileWidth: tileW ?? 16, tileHeight: tileH ?? 16, names: {}, neighbors: {} }
      : null,
  };
  project.sheets.push(sheet);
  addLayer(sheet, 'Layer 1');
  return sheet;
}

export function addLayer(sheet, name) {
  const layer = { id: newId('ly'), name, visible: true, opacity: 1,
    bitmap: createBitmap(sheet.width, sheet.height) };
  sheet.layers.push(layer);
  return layer;
}

export function removeLayer(sheet, layerId) {
  sheet.layers = sheet.layers.filter(l => l.id !== layerId);
}

export function moveLayer(sheet, layerId, toIndex) {
  const i = sheet.layers.findIndex(l => l.id === layerId);
  const [l] = sheet.layers.splice(i, 1);
  sheet.layers.splice(toIndex, 0, l);
}

function compositeOver(dst, src, opacity) {
  for (let y = 0; y < dst.height; y++)
    for (let x = 0; x < dst.width; x++) {
      const s = getPixel(src, x, y);
      const sa = (s[3] / 255) * opacity;
      if (sa === 0) continue;
      const d = getPixel(dst, x, y);
      const da = d[3] / 255;
      const oa = sa + da * (1 - sa);
      const mix = (sc, dc) => oa === 0 ? 0 : Math.round((sc * sa + dc * da * (1 - sa)) / oa);
      setPixel(dst, x, y, [mix(s[0], d[0]), mix(s[1], d[1]), mix(s[2], d[2]), Math.round(oa * 255)]);
    }
}

export function mergeDown(sheet, layerId) {
  const i = sheet.layers.findIndex(l => l.id === layerId);
  if (i <= 0) throw new Error('cannot merge bottom layer');
  compositeOver(sheet.layers[i - 1].bitmap, sheet.layers[i].bitmap, sheet.layers[i].opacity);
  sheet.layers.splice(i, 1);
}

export function flattenSheet(sheet) {
  const out = createBitmap(sheet.width, sheet.height);
  for (const l of sheet.layers) if (l.visible) compositeOver(out, l.bitmap, l.opacity);
  return out;
}

export function addFrame(sheet, { name, x, y, w, h, pivotX = 0, pivotY = 0 }) {
  const frame = { id: newId('fr'), name, x, y, w, h, pivotX, pivotY };
  sheet.frames.push(frame);
  return frame;
}

export function removeFrame(sheet, frameId) {
  sheet.frames = sheet.frames.filter(f => f.id !== frameId);
  for (const a of sheet.animations)
    a.frames = a.frames.filter(af => af.frameId !== frameId);
}

export function addAnimation(sheet, name, strip = false) {
  const anim = { id: newId('an'), name, loop: true, strip, frames: [] };
  sheet.animations.push(anim);
  return anim;
}

export function tileCount(sheet) {
  const cols = Math.floor(sheet.width / sheet.tile.tileWidth);
  const rows = Math.floor(sheet.height / sheet.tile.tileHeight);
  return cols * rows;
}

export function tileRect(sheet, index) {
  const cols = Math.floor(sheet.width / sheet.tile.tileWidth);
  return {
    x: (index % cols) * sheet.tile.tileWidth,
    y: Math.floor(index / cols) * sheet.tile.tileHeight,
    w: sheet.tile.tileWidth, h: sheet.tile.tileHeight,
  };
}

export function serializeProject(project) {
  const images = [];
  const json = {
    version: PROJECT_VERSION, name: project.name,
    settings: { ...project.settings },
    activePaletteId: project.activePaletteId,
    palettes: project.palettes.map(p => ({ ...p, colors: p.colors.map(c => [...c]) })),
    sheets: project.sheets.map(s => ({
      id: s.id, name: s.name, width: s.width, height: s.height, kind: s.kind,
      tile: s.tile ? structuredClone(s.tile) : null,
      frames: s.frames.map(f => ({ ...f })),
      animations: s.animations.map(a => ({ ...a, frames: a.frames.map(x => ({ ...x })) })),
      layers: s.layers.map(l => {
        const path = `images/${s.id}/${l.id}.png`;
        images.push({ path, bitmap: cloneBitmap(l.bitmap) });
        return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, image: path };
      }),
    })),
  };
  return { json, images };
}

export function deserializeProject(json, imagesByPath) {
  const v = validateProjectJson(json);
  if (!v.ok) throw new Error(v.error);
  return {
    version: json.version, name: json.name,
    settings: { ...json.settings },
    activePaletteId: json.activePaletteId ?? null,
    palettes: json.palettes ?? [],
    sheets: json.sheets.map(s => ({
      ...s,
      tile: s.tile ?? null,
      frames: s.frames ?? [],
      animations: (s.animations ?? []).map(a => ({ ...a, strip: a.strip ?? false })),
      layers: s.layers.map(l => {
        const bitmap = imagesByPath.get(l.image);
        if (!bitmap) throw new Error(`missing image ${l.image}`);
        return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, bitmap };
      }),
    })),
  };
}

const SETTINGS_KEYS = ['spriteSheetW', 'spriteSheetH', 'tileSheetW', 'tileSheetH',
  'tileW', 'tileH', 'frameW', 'frameH', 'durationMs'];

export function validateProjectJson(json) {
  if (!json || typeof json !== 'object') return { ok: false, error: 'not an object' };
  if (json.version !== PROJECT_VERSION)
    return { ok: false, error: `unsupported version ${json.version} (expected ${PROJECT_VERSION})` };
  if (!json.settings || typeof json.settings !== 'object')
    return { ok: false, error: 'missing settings' };
  for (const k of SETTINGS_KEYS)
    if (typeof json.settings[k] !== 'number')
      return { ok: false, error: `settings.${k} missing or not a number` };
  if (!Array.isArray(json.sheets)) return { ok: false, error: 'missing sheets' };
  for (const s of json.sheets)
    for (const l of s.layers ?? [])
      if (typeof l.image !== 'string') return { ok: false, error: `layer ${l.id} missing image path` };
  return { ok: true, error: null };
}
