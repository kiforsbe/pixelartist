import { spriteDocumentProvider } from './documents.js';
import { registerSpriteContributions } from './contributions.js';

export const spriteMode = Object.freeze({
  id: 'sprites', label: 'Sprite Sheets', order: 10,
  documentKinds: ['sprite-sheet'], defaultViewId: 'sprites.sheet',
  register(api) { api.documents.register(spriteDocumentProvider); registerSpriteContributions(api); },
  activate() {},
});
