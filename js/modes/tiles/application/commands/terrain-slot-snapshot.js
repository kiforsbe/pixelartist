// js/modes/tiles/application/commands/terrain-slot-snapshot.js

// Captures every side effect core/terrainsets.js's assignSlot()/applyLayoutPreset()
// can produce: assignSlot can mutate a DIFFERENT terrain set's slots (when the
// tile being assigned already belongs to another set), and can clear a previous
// slot occupant's terrainSetId/blobIndex on ANY tile on the sheet -- so the
// snapshot covers every terrain set's slots and every tile's back-reference
// fields, not just the one terrain set/tile a caller is directly acting on.
export function captureTerrainSlotState(sheet) {
  return {
    terrainSets: sheet.terrainSets.map(ts => ({ id: ts.id, slots: { ...ts.slots } })),
    tiles: sheet.tiles.map(t => ({
      id: t.id, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex, duplicateOf: t.duplicateOf,
    })),
  };
}

export function restoreTerrainSlotState(sheet, snapshot) {
  for (const s of snapshot.terrainSets) {
    const ts = sheet.terrainSets.find(t => t.id === s.id);
    if (ts) ts.slots = { ...s.slots };
  }
  for (const s of snapshot.tiles) {
    const t = sheet.tiles.find(x => x.id === s.id);
    if (t) Object.assign(t, { terrainSetId: s.terrainSetId, blobIndex: s.blobIndex, duplicateOf: s.duplicateOf });
  }
}
