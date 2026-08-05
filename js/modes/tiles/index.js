import { tileDocumentProvider } from './documents.js';
import { registerTileContributions } from './contributions.js';

export const tileMode = Object.freeze({
  id: 'tiles', label: 'Tile Sheets', order: 20,
  documentKinds: ['tile-sheet'], defaultViewId: 'tiles.sheet',
  register(api) { api.documents.register(tileDocumentProvider); registerTileContributions(api); },
  activate() {},
});
