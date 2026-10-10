import { createBitmap, cloneBitmap, getPixel, setPixel, blitRegion } from './pixels.js';
import { newId, normalizePalette } from './palettes.js';
import { compositeFloatOnLayer } from './floating.js';
import { convertLegacySheet } from './legacy-animations.js';
import { NEIGHBOR_DIRS } from './neighbors.js';
import { MAX_PALETTE_COLORS, DEFAULT_PIXEL_SNAPPER_CONFIG } from './pixelSnapper.js';
import { DEFAULT_MAP_BOUNDS, mapContentBounds } from '../domain/maps/maps.js';
import { toPlain as brushToPlain, fromPlain as brushFromPlain } from './brush-io.js';

export { DEFAULT_MAP_BOUNDS, createMap, createMapLayer, mapContentBounds, refreshMapBounds } from '../domain/maps/maps.js';
export { fpsStepToMs, msToFps, effectiveDuration } from '../domain/sprites/animation-timing.js';

export const PROJECT_VERSION = 4;
export const DEFAULT_SETTINGS = {
  spriteSheetW: 256, spriteSheetH: 256,
  tileSheetW: 256, tileSheetH: 256,
  tileW: 16, tileH: 16,
  frameW: 16, frameH: 16,
  durationMs: 100,
  // Widest the Animations workbench's auto layout may pack a band of frames
  // (js/domain/sprites/auto-layout.js). Files saved before it existed load
  // with spriteSheetW instead (deserializeProject).
  sheetMaxWidth: 256,
  smoothThumbnails: true,
  targetPlatform: 'none', // see js/core/platforms.js -- drives live edit-time compatibility warnings
  // 'strict': export quantization is capped at the target's real per-
  // sprite/tile hardware limit (e.g. NES 4, GBA 16). 'total': capped at
  // the platform's whole system palette instead (e.g. NES's ~56-color
  // master palette) -- the per-tile/sprite INDEX COUNT hardware limit is
  // never relaxed (native binary exporters still hard-cap at MAX_COLORS
  // regardless of this setting), only which colors those indices may be
  // chosen from. See file-controller.js's resolveC99Items.
  exportColorMode: 'strict',
  // See js/core/pixelSnapper.js -- auto-detects and snaps a pasted/
  // imported image's implicit pixel grid back to its true resolution.
  // Applies to both Document > Import Sheet from Image and OS-clipboard
  // paste (document-controller.js and components/canvas/float-session.js).
  pixelSnapperEnabled: false,
  // Quantization budget for grid detection (and, with no target palette,
  // the final output's own color count) -- defaults to the module's max so
  // "no palette selected" keeps close to full RGB fidelity per its own
  // default. See js/core/pixelSnapper.js's snapPixels `kColors` option.
  pixelSnapperKColors: MAX_PALETTE_COLORS,
  // Skips auto-detection entirely and forces this exact pixel size when
  // set; null means auto-detect. See snapPixels' `pixelSizeOverride`.
  pixelSnapperPixelSizeOverride: null,
  // Which palette the snapped output is remapped to: '' (default) tracks
  // whatever palette is currently active in the Colors panel, 'none' skips
  // palette-remapping entirely (raw quantized colors), any other value is
  // a specific palette's id. See resolvePixelSnapperPalette() below.
  pixelSnapperPaletteId: '',
  // Advanced tuning knobs (Project Settings > Import > Advanced) -- mirror
  // js/core/pixelSnapper.js's own DEFAULT_PIXEL_SNAPPER_CONFIG exactly, so
  // leaving them untouched reproduces today's default behavior. Passed
  // through as snapPixels' `config` override; see project-pixel-snapper.js
  // for the exact field mapping.
  pixelSnapperMaxIterations: DEFAULT_PIXEL_SNAPPER_CONFIG.maxKmeansIterations,
  pixelSnapperPeakThreshold: DEFAULT_PIXEL_SNAPPER_CONFIG.peakThresholdMultiplier,
  pixelSnapperPeakDistanceFilter: DEFAULT_PIXEL_SNAPPER_CONFIG.peakDistanceFilter,
  pixelSnapperSearchWindowRatio: DEFAULT_PIXEL_SNAPPER_CONFIG.walkerSearchWindowRatio,
  pixelSnapperMinSearchWindow: DEFAULT_PIXEL_SNAPPER_CONFIG.walkerMinSearchWindow,
  pixelSnapperStrengthThreshold: DEFAULT_PIXEL_SNAPPER_CONFIG.walkerStrengthThreshold,
  pixelSnapperMinCutsPerAxis: DEFAULT_PIXEL_SNAPPER_CONFIG.minCutsPerAxis,
  pixelSnapperFallbackSegments: DEFAULT_PIXEL_SNAPPER_CONFIG.fallbackTargetSegments,
  pixelSnapperMaxStepRatio: DEFAULT_PIXEL_SNAPPER_CONFIG.maxStepRatio,
};
export const MAX_DIM = 4096;

// 8 maximally-distinct hues (one per possible Back/Ahead step count), reused
// for both directions -- so "step 3 back" and "step 3 ahead" read the same
// color family and every step within a direction is unambiguous from its
// neighbors at a glance, out of the box (still fully overridable per-step
// via the frame editor's ⚙ dialog).
const ONION_STEP_PALETTE = [
  '#ff4040', '#ff9640', '#ffe640', '#7aff40',
  '#40ffc8', '#40a0ff', '#9640ff', '#ff40c8',
];

// A fresh object every call (never a shared constant) -- project.settings.onion
// is mutated in place as the user drags sliders/pickers in the frame editor,
// so aliasing this across projects would leak one project's onion tweaks into
// every other project's "default". Project creation stores a fresh object
// so frame-editor changes remain isolated to that project.
export function defaultOnionSettings() {
  const stepColors = { back: {}, ahead: {} };
  for (let k = 1; k <= 8; k++) {
    stepColors.back[k] = ONION_STEP_PALETTE[k - 1];
    stepColors.ahead[k] = ONION_STEP_PALETTE[k - 1];
  }
  return {
    enabled: false, back: 1, ahead: 0, mask: false, outline: true,
    currentAlpha: 1,
    backMaskAlpha: 0.35, backOutlineAlpha: 0.35,
    aheadMaskAlpha: 0.35, aheadOutlineAlpha: 0.35,
    backColor: '#ff4040', aheadColor: '#40ff40',
    stepColors,
  };
}

export const LAYER = 'layer';
export const GROUP = 'group';

// ---------------------------------------------------------------- tree model
// A sheet stores its layers inside a hierarchical `layerTree` of group
// nodes (folders) and leaf layer nodes. Read them through
// `sheetLayers(sheet)`; animations do not own layers.

export function createLayerNode(name, width, height) {
  return {
    id: newId('ly'), type: LAYER, name, visible: true, opacity: 1, locked: false,
    bitmap: createBitmap(width, height),
  };
}

export function createGroupNode(name, { open = true } = {}) {
  return { id: newId('gp'), type: GROUP, name, open, children: [] };
}

export function createProject(name, settings = { ...DEFAULT_SETTINGS }) {
  return { version: PROJECT_VERSION, name, settings: { onion: defaultOnionSettings(), ...settings },
    sheets: [], maps: [], palettes: [], activePaletteId: null, brushes: [] };
}

export function newDefaultProject(settings = DEFAULT_SETTINGS) {
  const project = createProject('untitled', settings);
  createSheet(project, { name: 'Sprites', width: settings.spriteSheetW, height: settings.spriteSheetH, kind: 'sprite' });
  createSheet(project, { name: 'Tiles', width: settings.tileSheetW, height: settings.tileSheetH, kind: 'tile' });
  return project;
}

// Works for both indexed (fixed-size) and free-form swatch palettes --
// `indexed` only matters for export quantization budgets (see
// file-controller.js's resolveC99Items), not for "is there a color list to use" here.
function paletteColorsById(project, id) {
  const palette = project.palettes.find(p => p.id === id);
  if (!palette?.colors.length) return null;
  return palette.colors.map(c => [c[0], c[1], c[2]]);
}

// The project's active palette's colors as plain [r,g,b] triples, or null
// when there's no active palette or it has no colors yet.
export function activePaletteColors(project) {
  return paletteColorsById(project, project.activePaletteId);
}

// Resolves project.settings.pixelSnapperPaletteId into actual [r,g,b]
// colors for js/core/pixelSnapper.js's snapPixels `palette` option: ''
// (the default) tracks whatever palette is currently active in the Colors
// panel, 'none' means no target palette at all (raw quantized colors,
// full RGB fidelity), anything else is a specific palette's id.
export function resolvePixelSnapperPalette(project) {
  const id = project.settings.pixelSnapperPaletteId;
  if (!id) return activePaletteColors(project);
  if (id === 'none') return null;
  return paletteColorsById(project, id);
}

// A sheet owns everything about it (layerTree, frames, animations, and for
// tile sheets tileGrids/tiles/terrainSets/terrainLayoutPresets) inline on the
// sheet object itself -- nothing elsewhere in the project references a sheet
// by id -- so removing it from project.sheets is the whole operation; there's
// no separate cascade to walk.
export function removeSheet(project, sheetId) {
  const i = project.sheets.findIndex(s => s.id === sheetId);
  if (i === -1) return null;
  return project.sheets.splice(i, 1)[0];
}

export function createSheet(project, { name, width, height, kind }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM)
    throw new Error(`sheet size must be 1..${MAX_DIM}`);
  const root = createGroupNode(name);
  root.children.push(createLayerNode('Layer 1', width, height));
  const sheet = {
    id: newId('sh'), name, width, height, kind,
    layerTree: root, frames: [], animations: [],
    tileGrids: kind === 'tile' ? [] : null,
    tiles: kind === 'tile' ? [] : null,
    terrainSets: kind === 'tile' ? [] : null,
    terrainLayoutPresets: kind === 'tile' ? [] : null,
    tileLayerNames: kind === 'tile' ? [] : null,
  };
  project.sheets.push(sheet);
  return sheet;
}

// ---------------------------------------------------------------- tree traversal

export function flattenLayers(root) {
  const out = [];
  function walk(node) {
    if (node.type === LAYER) out.push(node);
    else if (node.children) for (const c of node.children) walk(c);
  }
  walk(root);
  return out;
}

export function sheetLayers(sheet) { return flattenLayers(sheet.layerTree); }

// Crops or pads every layer to width x height, keeping content at its
// coordinates (anchored top-left). The auto-layout engine grows a sheet with
// it and undo shrinks the sheet back (js/core/sheet-layout.js). Each layer
// keeps its bitmap object: earlier history entries (stroke patches) hold on
// to it and must still reach the layer after a resize.
export function resizeSheetCanvas(sheet, width, height) {
  if (!validImportDimension(width) || !validImportDimension(height))
    throw new Error(`sheet size must be 1..${MAX_DIM}`);
  if (width === sheet.width && height === sheet.height) return;
  const keepW = Math.min(width, sheet.width), keepH = Math.min(height, sheet.height);
  for (const layer of sheetLayers(sheet)) {
    const next = createBitmap(width, height);
    const src = layer.bitmap.data;
    for (let y = 0; y < keepH; y++)
      next.data.set(src.subarray(y * sheet.width * 4, (y * sheet.width + keepW) * 4), y * width * 4);
    Object.assign(layer.bitmap, { width, height, data: next.data });
  }
  sheet.width = width;
  sheet.height = height;
}

export function findNode(root, id) {
  if (root.id === id) return root;
  if (nodeChildren(root)) for (const c of nodeChildren(root)) {
    const found = findNode(c, id);
    if (found) return found;
  }
  return null;
}

export function findLayer(root, id) {
  const n = findNode(root, id);
  return n?.type === LAYER ? n : null;
}

export function findGroup(root, id) {
  const n = findNode(root, id);
  return n?.type === GROUP ? n : null;
}

function nodeChildren(node) { return node.children ?? null; }

export function findParent(root, id) {
  const children = nodeChildren(root);
  if (!children) return null;
  for (let i = 0; i < children.length; i++) {
    if (children[i].id === id) return { parent: root, index: i };
    const found = findParent(children[i], id);
    if (found) return found;
  }
  return null;
}

function findGroupParent(root, groupId) {
  const children = nodeChildren(root);
  if (!children) return null;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.type === GROUP && c.id === groupId) return { parent: root, index: i };
    if (c.type === GROUP) {
      const found = findGroupParent(c, groupId);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------- layer ops

export function addLayer(sheet, name, groupId = sheet.layerTree.id) {
  const group = findGroup(sheet.layerTree, groupId) ?? sheet.layerTree;
  const layer = createLayerNode(name, sheet.width, sheet.height);
  group.children.push(layer);
  return layer;
}

export function addGroup(sheet, name, parentId = sheet.layerTree.id) {
  const parent = findGroup(sheet.layerTree, parentId) ?? sheet.layerTree;
  const group = createGroupNode(name);
  parent.children.push(group);
  return group;
}

export function removeLayer(sheet, layerId) {
  const loc = findParent(sheet.layerTree, layerId);
  if (!loc) return;
  const node = loc.parent.children[loc.index];
  if (node.type !== LAYER) return;
  loc.parent.children.splice(loc.index, 1);
}

export function removeGroup(sheet, groupId) {
  const loc = findGroupParent(sheet.layerTree, groupId);
  if (!loc) return;
  loc.parent.children.splice(loc.index, 1);
}

export function moveLayer(sheet, layerId, toIndex) {
  const loc = findParent(sheet.layerTree, layerId);
  if (!loc) return;
  const [node] = loc.parent.children.splice(loc.index, 1);
  const clamped = Math.max(0, Math.min(loc.parent.children.length, toIndex));
  loc.parent.children.splice(clamped, 0, node);
}

export function moveNode(sheet, nodeId, toParentId, toIndex) {
  const srcLoc = findParent(sheet.layerTree, nodeId);
  const dstParent = findGroup(sheet.layerTree, toParentId) ?? sheet.layerTree;
  if (!srcLoc || !dstParent) return;
  const node = srcLoc.parent.children[srcLoc.index];
  if (!node) return;

  // Prevent moving the root group.
  if (node.type === GROUP && node === sheet.layerTree) return;

  // Prevent moving a group into itself or its descendants.
  function contains(parent, childId) {
    if (parent.id === childId) return true;
    if (!parent.children) return false;
    return parent.children.some(c => c.type === GROUP && contains(c, childId));
  }
  if (node.type === GROUP && contains(node, dstParent.id)) return;

  // Adjust target index when reordering within the same parent.
  let adjustedToIndex = toIndex;
  if (srcLoc.parent === dstParent && srcLoc.index < toIndex) {
    adjustedToIndex = Math.max(0, toIndex - 1);
  }

  const [moved] = srcLoc.parent.children.splice(srcLoc.index, 1);
  const clamped = Math.max(0, Math.min(dstParent.children.length, adjustedToIndex));
  dstParent.children.splice(clamped, 0, moved);
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
  const loc = findParent(sheet.layerTree, layerId);
  if (!loc || loc.index <= 0) throw new Error('cannot merge bottom layer');
  const dest = loc.parent.children[loc.index - 1];
  if (dest.type !== LAYER) throw new Error('cannot merge into a group');
  const src = loc.parent.children[loc.index];
  // Bake both layers' effective opacity/visibility, then stop applying the
  // destination opacity to the newly merged source a second time.
  const merged = flattenSheetLayers([dest, src], dest.bitmap.width, dest.bitmap.height);
  blitRegion(dest.bitmap, merged, 0, 0);
  dest.opacity = 1;
  dest.visible = dest.visible || src.visible;
  loc.parent.children.splice(loc.index, 1);
}

export function flattenSheetLayers(layers, width, height, floating = null, sheetId = null) {
  const out = createBitmap(width, height);
  const hasFloat = floating && floating.sheetId && (sheetId == null || floating.sheetId === sheetId);
  for (const l of layers) {
    if (!l.visible) continue;
    const withFloat = hasFloat ? compositeFloatOnLayer(l.bitmap, floating, l.id) : null;
    compositeOver(out, withFloat ?? l.bitmap, l.opacity);
  }
  return out;
}

// overrideLayers: optional array of layer-shaped objects ({id, bitmap, ...}).
// Any real layer whose id matches one here is swapped for the override
// version for this flatten pass only -- lets a filter dialog preview a
// hypothetical edit on the real canvas/sheet without touching real layer
// data (same by-id substitution preview-panel.js's own override mechanism
// uses for the side Preview panel; that panel builds the array either one consumes).
function withOverrides(layers, overrideLayers) {
  if (!overrideLayers) return layers;
  const byId = new Map(overrideLayers.map(l => [l.id, l]));
  return layers.map(l => byId.get(l.id) ?? l);
}

export function flattenSheet(sheet, floating = null, overrideLayers = null) {
  return flattenSheetLayers(withOverrides(sheetLayers(sheet), overrideLayers), sheet.width, sheet.height, floating, sheet.id);
}

// ---------------------------------------------------------------- frames / animations

export function addFrame(sheet, { name, x, y, w, h, pivotX = 0, pivotY = 0 }) {
  const frame = { id: newId('fr'), name, x, y, w, h, pivotX, pivotY };
  sheet.frames.push(frame);
  return frame;
}

export function removeFrame(sheet, frameId) {
  sheet.frames = sheet.frames.filter(f => f.id !== frameId);
  for (const a of sheet.animations) a.frames = a.frames.filter(e => e.frameId !== frameId);
}

// A new animation is manual with no frames. `defaults` seeds the base-
// duration fields from the project's own default (project.settings, see the
// Animation-panel design doc); omitting it (e.g. direct unit-test calls)
// falls back to ms-100/unset.
export function addAnimation(sheet, name, defaults = {}) {
  const anim = {
    id: newId('an'), name, loop: true, frames: [], layout: 'manual', cell: null,
    baseDuration: defaults.durationMs ?? 100,
    baseFps: defaults.baseFps,
    baseStep: defaults.baseStep,
  };
  sheet.animations.push(anim);
  return anim;
}

// The v4 animation shape: strips, breaks and animation-owned layer groups
// are gone (js/core/legacy-animations.js converts older files). Used for
// both save and load so neither direction can leak a legacy field.
export function normalizeAnimation(a) {
  const { strip: _strip, breaks: _breaks, layerGroupId: _layerGroupId, ...rest } = a;
  const auto = a.layout === 'auto' && a.cell?.w >= 1 && a.cell?.h >= 1;
  return {
    ...rest,
    frames: (a.frames ?? []).map(e => ({ ...e })),
    layout: auto ? 'auto' : 'manual',
    cell: auto ? { w: a.cell.w, h: a.cell.h } : null,
  };
}

// The auto-layout invariants a loaded file must meet: every frame exists,
// has the cell's size and the animation's one pivot, and belongs to no
// earlier auto animation. A hand-edited file that breaks them would let the
// planner move rects it sized wrongly, so such an animation loads manual.
function demoteBrokenAutoAnimations(sheet) {
  const frames = new Map(sheet.frames.map(f => [f.id, f]));
  const claimed = new Set();
  for (const anim of sheet.animations) {
    if (anim.layout !== 'auto') continue;
    const list = [...new Set(anim.frames.map(e => e.frameId))].map(id => frames.get(id));
    const [first] = list;
    const ok = list.every(f => f && !claimed.has(f.id) && f.w === anim.cell.w && f.h === anim.cell.h &&
      f.pivotX === first.pivotX && f.pivotY === first.pivotY);
    if (!ok) { anim.layout = 'manual'; anim.cell = null; continue; }
    for (const f of list) claimed.add(f.id);
  }
}

function clearGroupOwnership(group) {
  delete group.animationId;
  for (const c of group.children ?? []) if (c.type === GROUP) clearGroupOwnership(c);
}

export function renameAnimation(sheet, animId, name) {
  const anim = sheet.animations.find(a => a.id === animId);
  if (!anim) return false;
  anim.name = name;
  return true;
}


// Clears any dangling reference to a just-removed tile: other tiles'
// manual neighbor slots, and any terrain set's slot map. Called from every
// place a tile record is actually dropped from sheet.tiles (deleteTile in
// tilemode.js, grid-shrink in resizeGridAxis).
export function scrubTileReferences(sheet, removedTileId) {
  for (const tile of sheet.tiles) {
    if (tile.duplicateOf === removedTileId) tile.duplicateOf = undefined;
    if (!tile.neighbors) continue;
    for (const dir of NEIGHBOR_DIRS) {
      const slot = tile.neighbors[dir];
      if (slot?.mode === 'tile' && slot.tileId === removedTileId) {
        tile.neighbors[dir] = { ...slot, mode: 'empty', tileId: null };
      }
    }
  }
  for (const ts of sheet.terrainSets ?? []) {
    for (const idx of Object.keys(ts.slots)) {
      if (ts.slots[idx] === removedTileId) delete ts.slots[idx];
    }
  }
}

// ---------------------------------------------------------------- serialization

function serializeGroup(group, sheetId, images) {
  return {
    id: group.id, type: group.type, name: group.name, open: group.open ?? true,
    children: group.children.map(c => {
      if (c.type === LAYER) {
        const path = `images/${sheetId}/${c.id}.png`;
        images.push({ path, bitmap: cloneBitmap(c.bitmap) });
        return { id: c.id, type: LAYER, name: c.name, visible: c.visible, opacity: c.opacity, locked: !!c.locked, image: path };
      }
      return serializeGroup(c, sheetId, images);
    }),
  };
}

function deserializeLayerBitmap(path, sheet, imagesByPath) {
  const bitmap = imagesByPath.get(path);
  if (!bitmap) throw new Error(`missing image ${path}`);
  if (bitmap.width !== sheet.width || bitmap.height !== sheet.height)
    throw new Error(`image ${path} dimensions must match sheet ${sheet.id} (${sheet.width}x${sheet.height})`);
  // Rendering and PNG encoding require ImageData-compatible, complete RGBA pixels.
  if (!(bitmap.data instanceof Uint8ClampedArray) || bitmap.data.length !== sheet.width * sheet.height * 4)
    throw new Error(`image ${path} has invalid RGBA data`);
  return bitmap;
}

function deserializeGroup(json, sheet, imagesByPath) {
  const group = {
    id: json.id, type: GROUP, name: json.name,
    animationId: json.animationId ?? null, open: json.open ?? true,
    children: [],
  };
  for (const c of json.children ?? []) {
    if (c.type === LAYER) {
      const bitmap = deserializeLayerBitmap(c.image, sheet, imagesByPath);
      group.children.push({ id: c.id, type: LAYER, name: c.name, visible: c.visible, opacity: c.opacity, locked: !!c.locked, bitmap });
    } else {
      group.children.push(deserializeGroup(c, sheet, imagesByPath));
    }
  }
  return group;
}

// Backward-compat helper: turn a legacy flat `layers[]` into a root group.
function migrateLegacyLayers(sheetJson, imagesByPath) {
  return {
    id: newId('gp'), type: GROUP, name: sheetJson.name ?? 'root', open: true,
    children: (sheetJson.layers ?? []).map(l => {
      const bitmap = deserializeLayerBitmap(l.image, sheetJson, imagesByPath);
      return { id: l.id, type: LAYER, name: l.name, visible: l.visible, opacity: l.opacity, locked: false, bitmap };
    }),
  };
}

// Legacy sheets stored one uniform grid as sheet.tile = { tileWidth,
// tileHeight, names, neighbors }, with every tile's identity implied by its
// row-major array index. Synthesize the equivalent explicit grid + tiles;
// names carry over unchanged, but neighbor slots referencing another tile
// by that old array index must be re-keyed onto the new tile's id (see the
// resolution pass below) since js/core/neighbors.js's Phase A shape keys
// cross-tile references on tileId, not array position.
function migrateLegacyTile(sheetJson) {
  const t = sheetJson.tile;
  const cols = Math.floor(sheetJson.width / t.tileWidth);
  const rows = Math.floor(sheetJson.height / t.tileHeight);
  const grid = { id: newId('tg'), x: 0, y: 0, cellW: t.tileWidth, cellH: t.tileHeight, cols, rows, spacingX: 0, spacingY: 0 };
  const tiles = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      tiles.push({
        id: newId('ti'), x: col * t.tileWidth, y: row * t.tileHeight, w: t.tileWidth, h: t.tileHeight,
        name: t.names?.[index], gridId: grid.id, gridCol: col, gridRow: row,
        neighbors: undefined, // resolved below, once every tile in this grid has an id
      });
    }
  }
  // Legacy neighbor slots reference the OTHER tile by its old row-major
  // array index (tileIndex) — js/core/neighbors.js's Phase A shape keys
  // that reference on tileId instead (Task 3), so resolve old-index ->
  // new-tile-id here rather than carrying the stale index over verbatim.
  for (let i = 0; i < tiles.length; i++) {
    const legacy = t.neighbors?.[i];
    if (!legacy) continue;
    const neighbors = {};
    for (const dir of Object.keys(legacy)) {
      const slot = legacy[dir];
      neighbors[dir] = {
        mode: slot.mode,
        tileId: (slot.mode === 'tile' && slot.tileIndex != null) ? (tiles[slot.tileIndex]?.id ?? null) : null,
        flipH: slot.flipH, flipV: slot.flipV,
      };
    }
    tiles[i].neighbors = neighbors;
  }
  return { tileGrids: [grid], tiles };
}

export function serializeProject(project) {
  const images = [];
  const json = {
    version: PROJECT_VERSION, name: project.name,
    settings: { ...project.settings, sheetMaxWidth: project.settings.sheetMaxWidth ?? project.settings.spriteSheetW },
    activePaletteId: project.activePaletteId,
    // Embedded brushes go through the same toPlain a standalone .brush.json
    // uses. bundle.js JSON.stringifies this whole body (bundle.js:7), and a
    // custom mask's `bits` is a Uint8Array -- which JSONs to an OBJECT, not an
    // array, and rehydrates to an EMPTY one. Without this the brush would
    // survive the round trip listed, selectable, and painting nothing.
    brushes: (project.brushes ?? []).map(brushToPlain),
    palettes: project.palettes.map(p => ({
      ...p,
      colors: p.colors.map(c => [...c]),
      empty: [...p.empty],
      emptyColor: [...p.emptyColor],
      lock: p.lock ? { ...p.lock } : null,
    })),
    maps: (project.maps ?? []).map(m => ({
      ...m, bounds: mapContentBounds(project, m), snap: { ...m.snap }, layers: m.layers.map(l => ({
        ...l, tiles: l.tiles?.map(t => ({ ...t })), terrain: l.terrain?.map(t => ({ ...t })), sprites: l.sprites?.map(s => ({ ...s })),
      })),
    })),
    sheets: project.sheets.map(s => ({
      id: s.id, name: s.name, width: s.width, height: s.height, kind: s.kind,
      tileGrids: s.tileGrids ? s.tileGrids.map(g => ({ ...g })) : null,
      tiles: s.tiles ? s.tiles.map(t => ({
        ...t,
        neighbors: t.neighbors ? { ...t.neighbors } : undefined,
        tags: t.tags ? [...t.tags] : undefined,
      })) : null,
      terrainSets: s.terrainSets ? s.terrainSets.map(ts => ({
        ...ts, slots: { ...ts.slots }, symmetry: { ...ts.symmetry },
      })) : null,
      terrainLayoutPresets: s.terrainLayoutPresets
        ? s.terrainLayoutPresets.map(p => ({ ...p, cells: p.cells.map(c => ({ ...c })) }))
        : null,
      // Keep the existing project-file key; only the runtime name changed.
      layers: s.tileLayerNames ? s.tileLayerNames.slice() : null,
      frames: s.frames.map(f => ({ ...f })),
      animations: s.animations.map(normalizeAnimation),
      layerTree: serializeGroup(s.layerTree, s.id, images),
    })),
  };
  return { json, images };
}

export function deserializeProject(json, imagesByPath) {
  const v = validateProjectJson(json);
  if (!v.ok) throw new Error(v.error);
  return {
    version: PROJECT_VERSION, name: json.name,
    // onion/targetPlatform/exportColorMode/pixelSnapper* fall back to their
    // defaults for files saved before those fields existed --
    // deserializeProject only ever runs on a freshly-parsed json, so this
    // is never aliased to another live project.
    settings: {
      onion: defaultOnionSettings(),
      targetPlatform: DEFAULT_SETTINGS.targetPlatform,
      exportColorMode: DEFAULT_SETTINGS.exportColorMode,
      // Every pixelSnapper* field (enabled/palette/kColors/override + the
      // 9 advanced tuning knobs) defaults the same way -- spread instead of
      // listing each one, so a future addition doesn't need a matching
      // edit here too.
      ...Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([k]) => k.startsWith('pixelSnapper'))),
      sheetMaxWidth: json.settings.spriteSheetW,
      ...json.settings,
    },
    activePaletteId: json.activePaletteId ?? null,
    brushes: (json.brushes ?? []).map(brushFromPlain),
    palettes: (json.palettes ?? []).map(normalizePalette),
    maps: (json.maps ?? []).map(m => ({
      id: m.id, name: m.name ?? 'Map',
      bounds: m.bounds ? { ...m.bounds } : { ...DEFAULT_MAP_BOUNDS },
      snap: { mode: m.snap?.mode ?? 'map', gridW: Math.max(1, m.snap?.gridW ?? json.settings.tileW), gridH: Math.max(1, m.snap?.gridH ?? json.settings.tileH) },
      layers: (m.layers ?? []).map(l => ({
        id: l.id, name: l.name ?? (l.type === 'sprite' ? 'Sprite Layer' : 'Tile Layer'), type: l.type === 'sprite' ? 'sprite' : 'tile',
        visible: l.visible !== false, locked: !!l.locked, opacity: l.opacity ?? 1,
        ...(l.type === 'sprite' ? { sprites: (l.sprites ?? []).map(s => ({ ...s })) } : { tiles: (l.tiles ?? []).map(t => ({ ...t })), terrain: (l.terrain ?? []).map(t => ({ ...t })) }),
      })),
    })),
    sheets: json.sheets.map(s => {
      const layerTree = s.layerTree
        ? deserializeGroup(s.layerTree, s, imagesByPath)
        : migrateLegacyLayers(s, imagesByPath);
      const sheet = {
        id: s.id, name: s.name, width: s.width, height: s.height, kind: s.kind,
        ...(() => {
          if (s.kind !== 'tile') return { tileGrids: null, tiles: null, terrainSets: null, terrainLayoutPresets: null, tileLayerNames: null };
          if (!s.tiles && s.tile) return { ...migrateLegacyTile(s), terrainSets: [], terrainLayoutPresets: [], tileLayerNames: [] };
          return {
            tileGrids: s.tileGrids ?? [], tiles: s.tiles ?? [],
            terrainSets: s.terrainSets ?? [], terrainLayoutPresets: s.terrainLayoutPresets ?? [],
            // Without a tree, saved `layers` are legacy pixels, not tile names.
            tileLayerNames: s.layerTree ? (s.layers ?? []) : [],
          };
        })(),
        frames: s.frames ?? [],
        animations: (s.animations ?? []).map(a => ({ ...a, frames: (a.frames ?? []).map(e => ({ ...e })) })),
        layerTree,
      };
      if (json.version < 4) convertLegacySheet(sheet);
      sheet.animations = sheet.animations.map(normalizeAnimation);
      demoteBrokenAutoAnimations(sheet);
      clearGroupOwnership(sheet.layerTree);
      return sheet;
    }),
  };
}

const SETTINGS_SHEET_DIMENSION_KEYS = ['spriteSheetW', 'spriteSheetH', 'tileSheetW', 'tileSheetH'];
const SETTINGS_ITEM_DIMENSION_KEYS = ['tileW', 'tileH', 'frameW', 'frameH'];

function validImportDimension(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_DIM;
}

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

export function validateProjectJson(json) {
  if (!json || typeof json !== 'object') return { ok: false, error: 'not an object' };
  if (![2, 3, PROJECT_VERSION].includes(json.version))
    return { ok: false, error: `unsupported version ${json.version} (expected ${PROJECT_VERSION})` };
  if (!json.settings || typeof json.settings !== 'object')
    return { ok: false, error: 'missing settings' };
  for (const k of SETTINGS_SHEET_DIMENSION_KEYS)
    if (!validImportDimension(json.settings[k]))
      return { ok: false, error: `settings.${k} must be an integer in 1..${MAX_DIM}` };
  // Item defaults do not allocate canvases and may exceed the sheet size limit.
  for (const k of SETTINGS_ITEM_DIMENSION_KEYS)
    if (!validPositiveInteger(json.settings[k]))
      return { ok: false, error: `settings.${k} must be a positive safe integer` };
  if (!Number.isFinite(json.settings.durationMs) || json.settings.durationMs <= 0)
    return { ok: false, error: 'settings.durationMs must be finite and positive' };
  if ((json.version >= 4 || json.settings.sheetMaxWidth !== undefined) && !validImportDimension(json.settings.sheetMaxWidth))
    return { ok: false, error: `settings.sheetMaxWidth must be an integer in 1..${MAX_DIM}` };
  if (!Array.isArray(json.sheets)) return { ok: false, error: 'missing sheets' };
  for (const s of json.sheets) {
    if (!validImportDimension(s?.width) || !validImportDimension(s?.height))
      return { ok: false, error: `sheet ${s?.id} dimensions must be integers in 1..${MAX_DIM}` };
    if (s.kind === 'tile' && !s.tiles && s.tile &&
        (!validPositiveInteger(s.tile.tileWidth) || !validPositiveInteger(s.tile.tileHeight)))
      return { ok: false, error: `sheet ${s.id} legacy tile dimensions must be positive safe integers` };
    const hasTree = s.layerTree && typeof s.layerTree === 'object' && s.layerTree.type === GROUP;
    const hasLayers = Array.isArray(s.layers);
    if (!hasTree && !hasLayers) return { ok: false, error: `sheet ${s.id} missing layerTree` };
    const layers = hasTree ? flattenLayers(s.layerTree) : (s.layers ?? []);
    for (const l of layers)
      if (typeof l.image !== 'string') return { ok: false, error: `layer ${l.id} missing image path` };
  }
  return { ok: true, error: null };
}
