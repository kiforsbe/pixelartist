// js/modes/tiles/application/geometry/tile-editor-geometry.js

// Mirrors core/neighbors.js's private DIR_BY_DELTA table (not exported
// there) -- used here only to figure out which slot a clicked cell
// belongs to.
const DIR_BY_SIGN = {
  '-1,-1': 'nw', '0,-1': 'n', '1,-1': 'ne',
  '-1,0': 'w', '1,0': 'e',
  '-1,1': 'sw', '0,1': 's', '1,1': 'se',
};
export function dirForCell(dx, dy) {
  return DIR_BY_SIGN[`${Math.sign(dx)},${Math.sign(dy)}`];
}

export const DIR_LABELS = {
  nw: 'Northwest', n: 'North', ne: 'Northeast',
  w: 'West', e: 'East',
  sw: 'Southwest', s: 'South', se: 'Southeast',
};

// Sheet-global-to-editor-local offset: the editor's content space is a
// (2*radius+1) x (2*radius+1) grid of `tile`-sized cells, with the CENTER
// cell occupying the tile's own rect -- so the top-left of the content
// grid sits `radius` cells up/left of the tile.
export function computeOffset(tile, radius) {
  return { x: tile.x - radius * tile.w, y: tile.y - radius * tile.h };
}

export function mapEditorPoint(offsetPt, x, y) {
  return { x: x + offsetPt.x, y: y + offsetPt.y };
}

// Editor-local cell lookup: returns {dx, dy} (tile units relative to
// center, 0,0 excluded -- that's the center) or null when (x, y) falls
// outside the content grid.
export function cellAt(tile, radius, contentW, contentH, x, y) {
  if (x < 0 || y < 0 || x >= contentW || y >= contentH) return null;
  const dx = Math.floor(x / tile.w) - radius;
  const dy = Math.floor(y / tile.h) - radius;
  if (dx === 0 && dy === 0) return null;
  return { dx, dy };
}

export function insideCenter(tile, radius, x, y) {
  return x >= radius * tile.w && x < radius * tile.w + tile.w &&
    y >= radius * tile.h && y < radius * tile.h + tile.h;
}
