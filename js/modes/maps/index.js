import { mapDocumentProvider } from './documents.js';

export const mapMode = Object.freeze({
  id: 'maps', label: 'Maps', order: 30,
  documentKinds: ['map'], defaultViewId: 'maps.canvas',
  register(api) { api.documents.register(mapDocumentProvider); },
  activate() {},
});
