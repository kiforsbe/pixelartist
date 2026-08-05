import { state, markDirty } from '../../app/state.js';

export function commitAddTileLayer(sheet, name) {
  const before = sheet.layers.slice();
  sheet.layers.push(name);
  const after = sheet.layers.slice();
  state.commands.push({
    label: 'add layer name',
    do() { sheet.layers = after.slice(); },
    undo() { sheet.layers = before.slice(); },
  });
  markDirty();
}

export function commitRemoveTileLayer(sheet, name) {
  const before = sheet.layers.slice();
  const tileLayers = sheet.tiles.map(tile => ({ tile, layer: tile.layer }));
  sheet.layers = sheet.layers.filter(layer => layer !== name);
  for (const tile of sheet.tiles) {
    if (tile.layer === name) tile.layer = undefined;
  }
  const after = sheet.layers.slice();
  state.commands.push({
    label: 'remove layer name',
    do() {
      sheet.layers = after.slice();
      for (const tile of sheet.tiles) {
        if (tile.layer === name) tile.layer = undefined;
      }
    },
    undo() {
      sheet.layers = before.slice();
      for (const entry of tileLayers) entry.tile.layer = entry.layer;
    },
  });
  markDirty();
}
