// Terrain set CRUD + slot mutation helpers. Mirrors js/core/tilegrids.js's
// role: pure, DOM-free, mutates the sheet directly (the eager-mutate half
// of this codebase's do()-then-snapshot command idiom -- js/ui/tilemode.js
// wraps these with state.commands.push()).
import { newId } from './palettes.js';

export function createTerrainSet(sheet, { name, tileW, tileH }) {
  const ts = { id: newId('ts'), name, tileW, tileH, slots: {}, symmetry: { flip: false, rotate: false }, layer: null };
  sheet.terrainSets.push(ts);
  return ts;
}

// Clears the terrainSetId/blobIndex back-reference on every tile that
// pointed at this set (tiles survive -- same "metadata goes away, pixels
// don't" convention as removeTileGrid).
export function removeTerrainSet(sheet, terrainSetId) {
  sheet.terrainSets = sheet.terrainSets.filter(ts => ts.id !== terrainSetId);
  for (const tile of sheet.tiles) {
    if (tile.terrainSetId === terrainSetId) {
      tile.terrainSetId = undefined;
      tile.blobIndex = undefined;
    }
  }
}

// Assigns `tile` into `terrainSet`'s `blobIndex` slot, explicitly. Enforces
// exclusivity in BOTH directions: if `tile` currently occupies a different
// slot (this set or another), that slot is vacated first; and if
// `blobIndex` currently holds a DIFFERENT tile, that former occupant's own
// terrainSetId/blobIndex back-reference is cleared too (otherwise it would
// keep claiming a slot the terrain set's `slots` map no longer agrees it
// owns).
export function assignSlot(sheet, terrainSet, blobIndex, tile) {
  const previousOccupantId = terrainSet.slots[blobIndex];
  if (previousOccupantId != null && previousOccupantId !== tile.id) {
    const previousOccupant = sheet.tiles.find(t => t.id === previousOccupantId);
    if (previousOccupant && previousOccupant.terrainSetId === terrainSet.id && previousOccupant.blobIndex === blobIndex) {
      previousOccupant.terrainSetId = undefined;
      previousOccupant.blobIndex = undefined;
    }
  }
  if (tile.terrainSetId != null) {
    const owner = sheet.terrainSets.find(ts => ts.id === tile.terrainSetId);
    if (owner) {
      for (const idx of Object.keys(owner.slots)) {
        if (owner.slots[idx] === tile.id) delete owner.slots[idx];
      }
    }
  }
  terrainSet.slots[blobIndex] = tile.id;
  tile.terrainSetId = terrainSet.id;
  tile.blobIndex = blobIndex;
}

// Clears an explicit slot assignment. If `tile` is given and still points
// at this exact slot, its back-reference is cleared too (it may already
// have been reassigned elsewhere, in which case leave it alone).
export function clearSlot(terrainSet, blobIndex, tile) {
  delete terrainSet.slots[blobIndex];
  if (tile && tile.terrainSetId === terrainSet.id && tile.blobIndex === blobIndex) {
    tile.terrainSetId = undefined;
    tile.blobIndex = undefined;
  }
}

// Called after a tile's own w/h changes (standalone tile resize) -- if it
// no longer matches its terrain set's tileW/tileH, auto-detach it.
export function detachFromTerrainSetIfMismatched(sheet, tile) {
  if (tile.terrainSetId == null) return;
  const ts = sheet.terrainSets.find(t => t.id === tile.terrainSetId);
  if (!ts || (tile.w === ts.tileW && tile.h === ts.tileH)) return;
  clearSlot(ts, tile.blobIndex, tile);
}

// Groups a preset's cells by blobIndex, preserving raster order within each
// group (preset.cells is already top-to-bottom, left-to-right). A group's
// FIRST cell is its "primary" -- the one that wins when a preset lists the
// same blobIndex on more than one cell (the Blob-47 templates do this
// intentionally, e.g. "isolated" 3x in the 7x7 layout, at cells (0,0),
// (6,0), and (0,6) -- tile indices 0, 6, and 42; (0,0) wins). Shared by
// applyLayoutPreset below and js/ui/tilemode.js's Add Terrain Set layout
// preview, so both agree on which cell is primary without duplicating the
// grouping rule.
export function groupCellsByBlobIndex(cells) {
  const map = new Map();
  for (const cell of cells) {
    if (!map.has(cell.blobIndex)) map.set(cell.blobIndex, []);
    map.get(cell.blobIndex).push(cell);
  }
  return map;
}

// Applies a saved layout preset against a same-shaped source region:
// `sourceTiles` is a flat, row-major array of tiles (`cols` wide) -- each
// preset cell's blobIndex is assigned to the tile at that (col, row).
// Silently skips a cell whose source tile is missing or size-mismatched.
//
// A duplicate blobIndex's non-primary cells are left with no
// blobIndex/terrainSetId of their own, even though importPresetArtOntoLayer
// (js/ui/tilemode.js) still paints reference art onto them. Track those as
// `duplicateOf` (-> the tile that won the slot) purely so the UI can flag
// them as dead ends; nothing else reads this field.
export function applyLayoutPreset(sheet, terrainSet, preset, sourceTiles, cols) {
  const validCells = preset.cells.filter((cell) => {
    const t = sourceTiles[cell.row * cols + cell.col];
    return t && t.w === terrainSet.tileW && t.h === terrainSet.tileH;
  });
  for (const [blobIndex, cells] of groupCellsByBlobIndex(validCells)) {
    const primary = sourceTiles[cells[0].row * cols + cells[0].col];
    assignSlot(sheet, terrainSet, blobIndex, primary);
    for (const cell of cells) {
      const t = sourceTiles[cell.row * cols + cell.col];
      t.duplicateOf = (t === primary) ? undefined : primary.id;
    }
  }
}

// Called after a bulk tile removal (grid deletion) that may have left a
// terrain set with nothing referencing it. Only checks the given
// candidates (the terrainSetIds the removed tiles used to belong to) --
// never sweeps the whole sheet, so a terrain set that was already empty
// for unrelated reasons (e.g. just created via "(none -- add tiles
// manually)") is never touched by this call. Returns the ids actually
// removed, so the caller can clear any UI selection pointing at them.
export function pruneEmptyTerrainSets(sheet, candidateIds) {
  const removedIds = [];
  for (const id of candidateIds) {
    const ts = sheet.terrainSets.find(t => t.id === id);
    if (!ts) continue;
    if (!sheet.tiles.some(t => t.terrainSetId === id)) {
      removeTerrainSet(sheet, id);
      removedIds.push(id);
    }
  }
  return removedIds;
}

// Captures a `{col,row} -> blobIndex` mapping as a new named, reusable
// preset. `cells` is built by the caller (it needs grid-specific context --
// which (col,row) each currently-assigned tile sits at within the source
// region the user picked when saving).
export function saveLayoutPreset(sheet, name, cols, rows, cells) {
  const preset = { id: newId('tlp'), name, cols, rows, cells };
  sheet.terrainLayoutPresets.push(preset);
  return preset;
}
