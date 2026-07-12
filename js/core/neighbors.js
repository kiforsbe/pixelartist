export const NEIGHBOR_DIRS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

const DIR_BY_DELTA = {
  '-1,-1': 'nw', '0,-1': 'n', '1,-1': 'ne',
  '-1,0': 'w', '1,0': 'e',
  '-1,1': 'sw', '0,1': 's', '1,1': 'se',
};

function emptySlot() { return { mode: 'same', tileIndex: null, flipH: false, flipV: false }; }

export function defaultPreset() {
  const p = {};
  for (const d of NEIGHBOR_DIRS) p[d] = emptySlot();
  return p;
}

export function getPreset(sheet, tileIndex) {
  const stored = sheet.tile.neighbors[tileIndex];
  const p = defaultPreset();
  if (stored) for (const d of NEIGHBOR_DIRS) if (stored[d]) p[d] = { ...stored[d] };
  return p;
}

export function setSlot(sheet, tileIndex, dir, slot) {
  if (!sheet.tile.neighbors[tileIndex])
    sheet.tile.neighbors[tileIndex] = defaultPreset();
  sheet.tile.neighbors[tileIndex][dir] = { ...slot };
}

export function resolveNeighborGrid(preset, centerIndex, radius = 1) {
  const cells = [];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const dir = DIR_BY_DELTA[`${Math.sign(dx)},${Math.sign(dy)}`];
      const slot = preset[dir];
      let tileIndex;
      if (slot.mode === 'empty') tileIndex = null;
      else if (slot.mode === 'tile') tileIndex = slot.tileIndex;
      else tileIndex = centerIndex;
      cells.push({ dx, dy, tileIndex, flipH: slot.flipH, flipV: slot.flipV });
    }
  return cells;
}
