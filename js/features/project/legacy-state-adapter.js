export function syncLegacyStateToHost(host, legacyState) {
  if (!host) return;
  const modeId = legacyState.mode;
  if (host.activeModeId !== modeId && host.registries.modes.get(modeId)) host.activateMode(modeId);
  if (host.store.getState().project.model !== legacyState.project ||
      host.store.getState().project.dirty !== !!legacyState.dirty) {
    host.store.setProject(legacyState.project, { dirty: !!legacyState.dirty, reason: 'legacy-project' });
  }
  const reference = modeId === 'maps'
    ? (legacyState.activeMapId ? { kind: 'map', id: legacyState.activeMapId } : null)
    : (legacyState.activeSheetId ? { kind: modeId === 'sprites' ? 'sprite-sheet' : 'tile-sheet', id: legacyState.activeSheetId } : null);
  host.documents.setActive(reference, { modeId, allowMissing: true });
  host.store.transaction('legacy-session', state => {
    state.session.activeViewId = modeId === 'maps' ? 'maps.canvas'
      : legacyState.view === 'frame' ? 'sprites.frame'
      : legacyState.view === 'tile' ? 'tiles.tile'
      : `${modeId}.sheet`;
    state.session.activeToolId = legacyState.tool;
    if (reference && modeId === 'maps') {
      // Maps' layer/item selection is host-authoritative (SelectionService is
      // the sole writer, from the map Presenter and the map-layer panel). Only
      // seed a default the first time this map is seen this session; otherwise
      // an unconditional overwrite here would clobber every SelectionService
      // write on the very next legacy event.
      const key = `${reference.kind}:${reference.id}`;
      if (!state.session.selectionsByDocument[key]) {
        const map = legacyState.project?.maps?.find(m => m.id === reference.id);
        state.session.selectionsByDocument[key] = { layerId: map?.layers[0]?.id ?? null, mapItemId: null };
      }
    } else if (reference) {
      // Sprites/tiles layer+frame+animation selection is host-authoritative
      // (SelectionService is the sole writer now, from command handlers and
      // presentation files). Only seed a default the first time this
      // document is seen this session -- mirrors the maps branch above.
      // legacyState.selectedTileId/selectedTerrainSetId stay legacy-owned
      // (out of scope for this migration) and are refreshed unconditionally,
      // same as before.
      const key = `${reference.kind}:${reference.id}`;
      const existing = state.session.selectionsByDocument[key];
      state.session.selectionsByDocument[key] = {
        ...(existing ?? { layerId: legacyState.activeLayerId, frameId: legacyState.selectedFrameId, animationId: legacyState.selectedAnimationId }),
        tileId: legacyState.selectedTileId,
        terrainSetId: legacyState.selectedTerrainSetId,
      };
    }
  });
  host.contextKeys.update({
    modeId,
    documentKind: reference?.kind,
    viewId: host.store.getState().session.activeViewId,
    toolId: legacyState.tool,
    hasDocument: !!reference,
  });
}
