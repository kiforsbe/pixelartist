import { registerAnimationsContributions } from './contributions.js';

// The Animations workbench edits the active sprite sheet. Sprites mode owns
// the sprite-sheet document provider and the commands this mode dispatches
// (their `when` predicates admit 'animations').
export const animationsMode = Object.freeze({
  id: 'animations', label: 'Animations', order: 15,
  documentKinds: ['sprite-sheet'], defaultViewId: 'animations.canvas',
  register(api) { registerAnimationsContributions(api); },
  activate() {},
});
