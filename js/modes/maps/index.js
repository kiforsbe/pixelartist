import { mapDocumentProvider } from './documents.js';
import { registerMapContributions } from './contributions.js';

export const mapMode = Object.freeze({
  id: 'maps', label: 'Maps', order: 30,
  documentKinds: ['map'], defaultViewId: 'maps.canvas',
  register(api) { api.documents.register(mapDocumentProvider); registerMapContributions(api); },
  activate() {},
});
