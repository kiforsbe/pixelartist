// One writer queue for user saves and background recovery. Snapshot guards keep
// completion of an old write from changing a newer project or clearing edits.
export function createProjectPersistence({ host, session, io, beforeSave, isFloating }) {
  let tail = Promise.resolve();
  const point = () => ({
    ...host.store.getState().project,
    pixels: host.store.getState().workspace.pixelRevision,
  });
  const sameProject = saved => {
    const current = host.store.getState().project;
    return current.model === saved.model && current.generation === saved.generation;
  };
  function enqueue(operation) {
    const result = tail.then(operation);
    tail = result.catch(() => {}); // A rejected write must not poison later saves.
    return result;
  }
  return {
    save({ saveAs = false } = {}) {
      const requested = point();
      return enqueue(async () => {
        if (!requested.model || !sameProject(requested)) return;
        beforeSave();
        const saved = point();
        const handle = await io.savePacked(saved.model, saveAs ? null : session.fileHandle);
        if (!sameProject(saved)) return;
        Object.assign(session, { fileHandle: handle, dirHandle: null, saveMode: 'packed' });
        const current = point();
        if (current.revision !== saved.revision || current.pixels !== saved.pixels) return;
        host.projects.markSaved();
        // Recovery writes use this queue too, so a queued newer autosave cannot
        // be deleted by the completion of this older save.
        await io.clearAutosave().catch(() => {});
      });
    },
    autosave() {
      const requested = point();
      return enqueue(async () => {
        if (requested.model && sameProject(requested) && host.projects.dirty && !isFloating()) {
          await io.autosave(requested.model);
        }
      });
    },
  };
}
