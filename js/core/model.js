import { createBitmap, cloneBitmap, getPixel, setPixel, copyRegion, blitRegion } from './pixels.js';
import { newId } from './palettes.js';
import { compositeFloatOnLayer } from './floating.js';
import { removeEntry } from './strips.js';
import { NEIGHBOR_DIRS } from './neighbors.js';

export const PROJECT_VERSION = 2;
export const DEFAULT_SETTINGS = {
  spriteSheetW: 256, spriteSheetH: 256,
  tileSheetW: 256, tileSheetH: 256,
  tileW: 16, tileH: 16,
  frameW: 16, frameH: 16,
  durationMs: 100,
  smoothThumbnails: true,
  targetPlatform: 'none', // see js/core/platforms.js -- drives live edit-time compatibility warnings
  // 'strict': export quantization is capped at the target's real per-
  // sprite/tile hardware limit (e.g. NES 4, GBA 16). 'total': capped at
  // the platform's whole system palette instead (e.g. NES's ~56-color
  // master palette) -- the per-tile/sprite INDEX COUNT hardware limit is
  // never relaxed (native binary exporters still hard-cap at MAX_COLORS
  // regardless of this setting), only which colors those indices may be
  // chosen from. See js/app/main.js's resolveC99Items.
  exportColorMode: 'strict',
};
const MAX_DIM = 4096;

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
// every other project's "default". See setProject() in app/state.js, which
// points state.onion at this object so the frame editor's existing
// state.onion.* reads/writes persist as part of the project automatically.
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
// A sheet now stores its layers inside a hierarchical `layerTree` instead of
// a flat `layers[]` array. The tree is made of group nodes (folders) and leaf
// layer nodes. Groups can own an animation (`animationId`), meaning the group
// holds the animation's private sub-layers. Every operation that used to read
// `sheet.layers` now goes through `sheetLayers(sheet)` or `contextLayers(sheet,
// animId)`.

export function createLayerNode(name, width, height) {
  return {
    id: newId('ly'), type: LAYER, name, visible: true, opacity: 1,
    bitmap: createBitmap(width, height),
  };
}

export function createGroupNode(name, { animationId = null, open = true } = {}) {
  return { id: newId('gp'), type: GROUP, name, animationId, open, children: [] };
}

export function createProject(name, settings = { ...DEFAULT_SETTINGS }) {
  return { version: PROJECT_VERSION, name, settings: { onion: defaultOnionSettings(), ...settings },
    sheets: [], palettes: [], activePaletteId: null };
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
    layers: kind === 'tile' ? [] : null,
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

  // Only layer nodes may be moved into animation-owned groups; keep
  // animation layer scopes isolated from arbitrary group nesting.
  if (dstParent.animationId && node.type !== LAYER) return;

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
  compositeOver(dest.bitmap, src.bitmap, src.opacity);
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

export function flattenSheet(sheet, floating = null) {
  const acceptedStrips = (sheet.animations ?? [])
    .filter(a => a.strip && a.layerGroupId)
    .map(a => ({ anim: a, group: findGroup(sheet.layerTree, a.layerGroupId) }))
    .filter(s => s.group);

  const stripLayerIds = new Set();
  for (const { group } of acceptedStrips) for (const l of flattenLayers(group)) stripLayerIds.add(l.id);

  // Everything except an accepted strip's own layers composites normally.
  const baseLayers = sheetLayers(sheet).filter(l => !stripLayerIds.has(l.id));
  const out = flattenSheetLayers(baseLayers, sheet.width, sheet.height, floating, sheet.id);

  // Each accepted strip then exclusively (hard-replace, not alpha-blend)
  // owns its own frame rects: opaque to whatever's on `out` underneath,
  // genuinely transparent (not a peek-through) wherever the strip itself
  // has none of its own content.
  for (const { anim, group } of acceptedStrips) {
    const stripComposite = flattenSheetLayers(flattenLayers(group), sheet.width, sheet.height, floating, sheet.id);
    for (const entry of anim.frames) {
      const frame = sheet.frames.find(f => f.id === entry.frameId);
      if (!frame) continue;
      const region = copyRegion(stripComposite, frame.x, frame.y, frame.w, frame.h);
      blitRegion(out, region, frame.x, frame.y);
    }
  }
  return out;
}

// ---------------------------------------------------------------- animation layer groups

export function animationGroup(sheet, animId) {
  const anim = sheet.animations.find(a => a.id === animId);
  if (!anim?.layerGroupId) return null;
  return findGroup(sheet.layerTree, anim.layerGroupId) ?? null;
}

export function contextLayers(sheet, animId = null) {
  if (!animId) return sheetLayers(sheet);
  const group = animationGroup(sheet, animId);
  return group ? flattenLayers(group) : sheetLayers(sheet);
}

// Given a layer, resolves the animation that owns it -- i.e. the layer is
// nested directly under an animation-owned group (group.animationId set).
// Returns null for a root layer, a layer under a plain (non-animation)
// group, or a null layer. A layer can only be nested under an animation-
// owned group after that animation has been accepted (see acceptAnimation)
// -- a floating animation has no group/layer at all, so this never needs to
// special-case "floating". Works for both strip and plain animations;
// callers that care about strip-ness check ctx.anim.strip themselves.
export function layerAnimationContext(sheet, layer) {
  if (!layer) return null;
  const loc = findParent(sheet.layerTree, layer.id);
  const group = loc?.parent;
  if (!group?.animationId) return null;
  const anim = sheet.animations.find(a => a.id === group.animationId);
  return anim ? { anim, group } : null;
}

// ---------------------------------------------------------------- frames / animations

export function addFrame(sheet, { name, x, y, w, h, pivotX = 0, pivotY = 0 }) {
  const frame = { id: newId('fr'), name, x, y, w, h, pivotX, pivotY };
  sheet.frames.push(frame);
  return frame;
}

export function removeFrame(sheet, frameId) {
  sheet.frames = sheet.frames.filter(f => f.id !== frameId);
  for (const a of sheet.animations) {
    let i;
    while ((i = a.frames.findIndex(af => af.frameId === frameId)) !== -1) {
      const r = removeEntry(a.frames, a.breaks, i);
      a.frames = r.entries;
      a.breaks = r.breaks;
    }
  }
}

// A new animation starts FLOATING: no group, no layer, layerGroupId null.
// It previews whatever's already on the sheet under its own frames (see
// contextLayers()'s null-group fallback and flattenSheet()'s exclusive-
// compositing skip for floating strips below) until acceptAnimation() is
// called -- explicitly (Enter key, frames.js) or automatically (first
// paint stroke, tools.js). This lets a strip be freely repositioned/resized
// to align with existing imported artwork before committing to a layer.
// `defaults` seeds the new animation's base-duration fields from the
// project's own default (project.settings, see the Animation-panel design
// doc) instead of a hardcoded value -- callers that create a user-visible
// animation should pass `state.project?.settings`; omitting it (e.g. direct
// unit-test calls) falls back to ms-100/unset, same as before this field existed.
export function addAnimation(sheet, name, strip = false, defaults = {}) {
  const anim = {
    id: newId('an'), name, loop: true, strip, breaks: [], frames: [], layerGroupId: null,
    baseDuration: defaults.durationMs ?? 100,
    baseFps: defaults.baseFps,
    baseStep: defaults.baseStep,
  };
  sheet.animations.push(anim);
  return anim;
}

// fps/step -> ms conversion for the "animate on Ns" base-duration model (see
// the Animation-panel design doc). Pure math, shared by js/ui/baseDurationControl.js
// and anything else that needs to seed/redisplay a base duration from fps+step.
export function fpsStepToMs(fps, step) {
  return Math.round(1000 / fps * step);
}
export function msToFps(ms) {
  return 1000 / ms;
}

// Resolves a per-frame animation entry's actual playback/export duration
// (ms), honoring the "inherit until edited" model: an entry's own field is
// read only when it matches the animation's current primary unit
// (anim.baseFps set = fps-primary, reads entry.step; unset = ms-primary,
// reads entry.duration) -- the OTHER field on the entry, if any, is dormant
// and ignored, not deleted (see the design doc's non-destructive note).
export function effectiveDuration(anim, entry) {
  if (anim.baseFps) {
    const step = entry.step ?? anim.baseStep ?? 1;
    return fpsStepToMs(anim.baseFps, step);
  }
  return entry.duration ?? anim.baseDuration ?? 100;
}

// Promotes a floating animation into a committed one: freezes whatever's
// currently visible under each of its own frames (i.e. flattenSheet(sheet)
// cropped to that frame's rect -- for an accepted strip elsewhere this
// already respects that strip's own exclusive ownership, so overlapping an
// already-accepted strip freezes ITS content, not something hidden below
// it) into one brand-new layer, then wires the group in. Caller's
// responsibility to only call this once, while anim.layerGroupId is still
// null -- see commitAcceptAnimation's idempotency guard in ui/frames.js.
export function acceptAnimation(sheet, anim) {
  const group = createGroupNode(anim.name, { animationId: anim.id });
  const layer = createLayerNode('Layer 1', sheet.width, sheet.height);
  const flat = flattenSheet(sheet);
  for (const entry of anim.frames) {
    const frame = sheet.frames.find(f => f.id === entry.frameId);
    if (!frame) continue;
    const region = copyRegion(flat, frame.x, frame.y, frame.w, frame.h);
    blitRegion(layer.bitmap, region, frame.x, frame.y);
  }
  group.children.push(layer);
  sheet.layerTree.children.push(group);
  anim.layerGroupId = group.id;
  return group;
}

export function renameAnimation(sheet, animId, name) {
  const anim = sheet.animations.find(a => a.id === animId);
  if (!anim) return false;
  anim.name = name;
  const group = animationGroup(sheet, animId);
  if (group) group.name = name;
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
    id: group.id, type: group.type, name: group.name,
    animationId: group.animationId ?? null, open: group.open ?? true,
    children: group.children.map(c => {
      if (c.type === LAYER) {
        const path = `images/${sheetId}/${c.id}.png`;
        images.push({ path, bitmap: cloneBitmap(c.bitmap) });
        return { id: c.id, type: LAYER, name: c.name, visible: c.visible, opacity: c.opacity, image: path };
      }
      return serializeGroup(c, sheetId, images);
    }),
  };
}

function deserializeGroup(json, sheetId, imagesByPath) {
  const group = {
    id: json.id, type: GROUP, name: json.name,
    animationId: json.animationId ?? null, open: json.open ?? true,
    children: [],
  };
  for (const c of json.children ?? []) {
    if (c.type === LAYER) {
      const bitmap = imagesByPath.get(c.image);
      if (!bitmap) throw new Error(`missing image ${c.image}`);
      group.children.push({ id: c.id, type: LAYER, name: c.name, visible: c.visible, opacity: c.opacity, bitmap });
    } else {
      group.children.push(deserializeGroup(c, sheetId, imagesByPath));
    }
  }
  return group;
}

// Backward-compat helper: turn a legacy flat `layers[]` into a root group.
function migrateLegacyLayers(sheetJson, sheetId, imagesByPath) {
  return {
    id: newId('gp'), type: GROUP, name: sheetJson.name ?? 'root', animationId: null, open: true,
    children: (sheetJson.layers ?? []).map(l => {
      const bitmap = imagesByPath.get(l.image);
      if (!bitmap) throw new Error(`missing image ${l.image}`);
      return { id: l.id, type: LAYER, name: l.name, visible: l.visible, opacity: l.opacity, bitmap };
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
    settings: { ...project.settings },
    activePaletteId: project.activePaletteId,
    palettes: project.palettes.map(p => ({ ...p, colors: p.colors.map(c => [...c]) })),
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
      layers: s.layers ? s.layers.slice() : null,
      frames: s.frames.map(f => ({ ...f })),
      animations: s.animations.map(a => ({ ...a, frames: a.frames.map(x => ({ ...x })), breaks: (a.breaks ?? []).slice(), layerGroupId: a.layerGroupId ?? null })),
      layerTree: serializeGroup(s.layerTree, s.id, images),
    })),
  };
  return { json, images };
}

export function deserializeProject(json, imagesByPath) {
  const v = validateProjectJson(json);
  if (!v.ok) throw new Error(v.error);
  return {
    version: json.version, name: json.name,
    // onion/targetPlatform/exportColorMode fall back to their defaults for
    // files saved before those fields existed -- deserializeProject only
    // ever runs on a freshly-parsed json, so this is never aliased to
    // another live project.
    settings: {
      onion: defaultOnionSettings(),
      targetPlatform: DEFAULT_SETTINGS.targetPlatform,
      exportColorMode: DEFAULT_SETTINGS.exportColorMode,
      ...json.settings,
    },
    activePaletteId: json.activePaletteId ?? null,
    palettes: json.palettes ?? [],
    sheets: json.sheets.map(s => {
      const layerTree = s.layerTree
        ? deserializeGroup(s.layerTree, s.id, imagesByPath)
        : migrateLegacyLayers(s, s.id, imagesByPath);
      return {
        id: s.id, name: s.name, width: s.width, height: s.height, kind: s.kind,
        ...(() => {
          if (s.kind !== 'tile') return { tileGrids: null, tiles: null, terrainSets: null, terrainLayoutPresets: null, layers: null };
          if (!s.tiles && s.tile) return { ...migrateLegacyTile(s), terrainSets: [], terrainLayoutPresets: [], layers: [] };
          return {
            tileGrids: s.tileGrids ?? [], tiles: s.tiles ?? [],
            terrainSets: s.terrainSets ?? [], terrainLayoutPresets: s.terrainLayoutPresets ?? [],
            layers: s.layers ?? [],
          };
        })(),
        frames: s.frames ?? [],
        animations: (s.animations ?? []).map(a => ({ ...a, strip: a.strip ?? false, breaks: a.breaks ?? [], layerGroupId: a.layerGroupId ?? null })),
        layerTree,
      };
    }),
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
  for (const s of json.sheets) {
    const hasTree = s.layerTree && typeof s.layerTree === 'object' && s.layerTree.type === GROUP;
    const hasLayers = Array.isArray(s.layers);
    if (!hasTree && !hasLayers) return { ok: false, error: `sheet ${s.id} missing layerTree` };
    const layers = hasTree ? flattenLayers(s.layerTree) : (s.layers ?? []);
    for (const l of layers)
      if (typeof l.image !== 'string') return { ok: false, error: `layer ${l.id} missing image path` };
  }
  return { ok: true, error: null };
}
