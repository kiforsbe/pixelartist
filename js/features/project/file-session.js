export const fileSession = {
  fileHandle: null,
  dirHandle: null,
  saveMode: null,
};

export function resetFileSession() {
  fileSession.fileHandle = null;
  fileSession.dirHandle = null;
  fileSession.saveMode = null;
}
