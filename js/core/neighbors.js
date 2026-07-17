export const NEIGHBOR_DIRS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

const DIR_BY_DELTA = {
  '-1,-1': 'nw', '0,-1': 'n', '1,-1': 'ne',
  '-1,0': 'w', '1,0': 'e',
  '-1,1': 'sw', '0,1': 's', '1,1': 'se',
};

function emptySlot() { return { mode: 'same', tileId: null, flipH: false, flipV: false }; }

export function defaultPreset() {
  const p = {};
  for (const d of NEIGHBOR_DIRS) p[d] = emptySlot();
  return p;
}

export function getPreset(tile) {
  const p = defaultPreset();
  if (tile.neighbors) for (const d of NEIGHBOR_DIRS) if (tile.neighbors[d]) p[d] = { ...tile.neighbors[d] };
  return p;
}

export function setSlot(tile, dir, slot) {
  if (!tile.neighbors) tile.neighbors = defaultPreset();
  tile.neighbors[dir] = { ...slot };
}

export function resolveNeighborGrid(preset, centerTileId, radius = 1) {
  const cells = [];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const dir = DIR_BY_DELTA[`${Math.sign(dx)},${Math.sign(dy)}`];
      const slot = preset[dir];
      let tileId;
      if (slot.mode === 'empty') tileId = null;
      else if (slot.mode === 'tile') tileId = slot.tileId;
      else tileId = centerTileId;
      cells.push({ dx, dy, tileId, flipH: slot.flipH, flipV: slot.flipV });
    }
  return cells;
}
