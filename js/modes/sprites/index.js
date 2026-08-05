import { spriteDocumentProvider } from './documents.js';

export const spriteMode = Object.freeze({
  id: 'sprites', label: 'Sprite Sheets', order: 10,
  documentKinds: ['sprite-sheet'], defaultViewId: 'sprites.sheet',
  register(api) { api.documents.register(spriteDocumentProvider); },
  activate() {},
});
