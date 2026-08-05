import { state, markDirty } from '../../app/state.js';
import {
  createTerrainSet, removeTerrainSet, assignSlot, clearSlot, applyLayoutPreset,
} from '../../core/terrainsets.js';

export function commitAddTerrainSet(sheet, opts) {
  const before = sheet.terrainSets.slice();
  const created = createTerrainSet(sheet, opts);
  const after = sheet.terrainSets.slice();
  state.commands.push({
    label: 'add terrain set',
    do() { sheet.terrainSets = after.slice(); },
    undo() { sheet.terrainSets = before.slice(); },
  });
  markDirty();
  return created;
}

export function commitDeleteTerrainSet(sheet, terrainSetId) {
  const beforeSets = sheet.terrainSets.slice();
  const beforeTiles = sheet.tiles.map(t => ({ t, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  removeTerrainSet(sheet, terrainSetId);
  const afterSets = sheet.terrainSets.slice();
  state.commands.push({
    label: 'delete terrain set',
    do() {
      sheet.terrainSets = afterSets.slice();
      for (const b of beforeTiles) if (b.terrainSetId === terrainSetId) { b.t.terrainSetId = undefined; b.t.blobIndex = undefined; }
    },
    undo() {
      sheet.terrainSets = beforeSets.slice();
      for (const b of beforeTiles) { b.t.terrainSetId = b.terrainSetId; b.t.blobIndex = b.blobIndex; }
    },
  });
  markDirty();
}

export function commitRenameTerrainSet(terrainSet, name) {
  const before = terrainSet.name;
  const after = name || before;
  if (before === after) return;
  state.commands.push({
    label: 'rename terrain set',
    do() { terrainSet.name = after; },
    undo() { terrainSet.name = before; },
  });
  markDirty();
}

export function commitAssignSlot(sheet, terrainSet, blobIndex, tile) {
  const beforeTiles = sheet.tiles.map(t => ({ t, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  const beforeSlots = { ...terrainSet.slots };
  assignSlot(sheet, terrainSet, blobIndex, tile);
  const afterSlots = { ...terrainSet.slots };
  const afterTileState = { terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex };
  state.commands.push({
    label: 'assign terrain slot',
    do() {
      terrainSet.slots = { ...afterSlots };
      tile.terrainSetId = afterTileState.terrainSetId;
      tile.blobIndex = afterTileState.blobIndex;
    },
    undo() {
      terrainSet.slots = { ...beforeSlots };
      for (const b of beforeTiles) { b.t.terrainSetId = b.terrainSetId; b.t.blobIndex = b.blobIndex; }
    },
  });
  markDirty();
}

export function commitClearSlot(terrainSet, blobIndex, tile) {
  const beforeSlots = { ...terrainSet.slots };
  const before = { terrainSetId: tile?.terrainSetId, blobIndex: tile?.blobIndex };
  clearSlot(terrainSet, blobIndex, tile);
  const afterSlots = { ...terrainSet.slots };
  state.commands.push({
    label: 'clear terrain slot',
    do() {
      terrainSet.slots = { ...afterSlots };
      if (tile) { tile.terrainSetId = undefined; tile.blobIndex = undefined; }
    },
    undo() {
      terrainSet.slots = { ...beforeSlots };
      if (tile) { tile.terrainSetId = before.terrainSetId; tile.blobIndex = before.blobIndex; }
    },
  });
  markDirty();
}

export function commitSetSymmetry(terrainSet, key, value) {
  if (terrainSet.symmetry[key] === value) return;
  const before = terrainSet.symmetry[key];
  state.commands.push({
    label: `set terrain symmetry ${key}`,
    do() { terrainSet.symmetry[key] = value; },
    undo() { terrainSet.symmetry[key] = before; },
  });
  markDirty();
}

export function commitApplyLayoutPreset(sheet, terrainSet, preset, sourceTiles, cols) {
  const beforeSlots = { ...terrainSet.slots };
  const beforeTiles = sheet.tiles.map(t => ({ t, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  applyLayoutPreset(sheet, terrainSet, preset, sourceTiles, cols);
  const afterSlots = { ...terrainSet.slots };
  const afterTiles = sheet.tiles.map(t => ({ terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  state.commands.push({
    label: 'import terrain layout',
    do() {
      terrainSet.slots = { ...afterSlots };
      sheet.tiles.forEach((t, i) => { t.terrainSetId = afterTiles[i].terrainSetId; t.blobIndex = afterTiles[i].blobIndex; });
    },
    undo() {
      terrainSet.slots = { ...beforeSlots };
      for (const b of beforeTiles) { b.t.terrainSetId = b.terrainSetId; b.t.blobIndex = b.blobIndex; }
    },
  });
  markDirty();
}

export function commitSetTerrainSetLayer(terrainSet, layer) {
  const after = layer || null;
  if (terrainSet.layer === after) return;
  const before = terrainSet.layer;
  state.commands.push({
    label: 'set terrain set layer',
    do() { terrainSet.layer = after; },
    undo() { terrainSet.layer = before; },
  });
  markDirty();
}

