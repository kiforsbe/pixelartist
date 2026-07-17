// Terrain set CRUD + slot mutation helpers. Mirrors js/core/tilegrids.js's
// role: pure, DOM-free, mutates the sheet directly (the eager-mutate half
// of this codebase's do()-then-snapshot command idiom -- js/ui/tilemode.js
// wraps these with state.commands.push()).
import { newId } from './palettes.js';

export function createTerrainSet(sheet, { name, tileW, tileH }) {
  const ts = { id: newId('ts'), name, tileW, tileH, slots: {}, symmetry: { flip: false, rotate: false } };
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

// Applies a saved layout preset against a same-shaped source region:
// `sourceTiles` is a flat, row-major array of tiles (`cols` wide) -- each
// preset cell's blobIndex is assigned to the tile at that (col, row).
// Silently skips a cell whose source tile is missing or size-mismatched.
export function applyLayoutPreset(sheet, terrainSet, preset, sourceTiles, cols) {
  for (const cell of preset.cells) {
    const t = sourceTiles[cell.row * cols + cell.col];
    if (t && t.w === terrainSet.tileW && t.h === terrainSet.tileH) {
      assignSlot(sheet, terrainSet, cell.blobIndex, t);
    }
  }
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
