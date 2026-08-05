let editorHost = null;

export function setEditorHost(host) {
  if (editorHost && editorHost !== host) throw new Error('EditorHost is already configured');
  editorHost = host;
}

export function getEditorHost() { return editorHost; }
