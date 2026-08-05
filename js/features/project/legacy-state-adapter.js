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
    if (reference) {
      state.session.selectionsByDocument[`${reference.kind}:${reference.id}`] = {
        layerId: modeId === 'maps' ? legacyState.activeMapLayerId : legacyState.activeLayerId,
        frameId: legacyState.selectedFrameId,
        animationId: legacyState.selectedAnimationId,
        tileId: legacyState.selectedTileId,
        terrainSetId: legacyState.selectedTerrainSetId,
        mapItemId: legacyState.selectedMapItemId,
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
