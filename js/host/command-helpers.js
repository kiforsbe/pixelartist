// Shared shape for a Command Handler that mutates one project entity
// (a sprite/tile sheet, a map, ...) with undo/redo support. Every history
// step re-enters services.projects.mutate() so the host store gets a fresh
// transaction + dirty flag on both do AND undo; resolve() re-looks-up the
// entity by id on every call rather than closing over a stale reference, so
// undo/redo still work after other mutations reorder/replace the project.
//
// `after(project, entity)` runs once per do/undo, after apply/revert -- for
// bookkeeping that must stay in sync regardless of direction (e.g. maps'
// refreshMapBounds).
// `scope` is forwarded to HistoryService.execute() -- omit it (the normal
// case) and the command lands on the active document's undo history; pass
// PROJECT_SCOPE for a command that mutates nothing but project-level state,
// so it stays undoable from whichever document is open.
export function runEntityCommand(services, label, resolve, apply, revert, { after, scope } = {}) {
  const command = {
    label,
    do: () => services.projects.mutate(label, project => {
      const entity = resolve(project);
      apply(entity, project);
      after?.(project, entity);
    }),
    undo: () => services.projects.mutate(label, project => {
      const entity = resolve(project);
      revert(entity, project);
      after?.(project, entity);
    }),
  };
  services.history.execute(command, { scope });
}
