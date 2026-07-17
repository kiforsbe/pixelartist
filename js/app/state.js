import { CommandStack } from '../core/commands.js';
import { createProject, createSheet, DEFAULT_SETTINGS, findLayer, findNode, sheetLayers, contextLayers as modelContextLayers } from '../core/model.js';

// Test mode (?autotest): automated browser sessions suppress modal dialogs
// (beforeunload guard, autosave-restore prompt, confirm() gates auto-accept).
export const AUTOTEST = new URLSearchParams(location.search).has('autotest');
export const confirmOrAuto = (msg) => AUTOTEST || confirm(msg);

export const state = {
  project: null,
  fileHandle: null, dirHandle: null, saveMode: null, // 'packed'|'unpacked'|null
  dirty: false,
  mode: 'sprites',            // 'sprites' | 'tiles'
  view: 'sheet',              // 'sheet' | 'frame' | 'tile'  (focused editors)
  activeSheetId: null,        // per current mode
  activeLayerId: null,
  tool: 'pencil',
  brushSize: 1,
  primary: [0, 0, 0, 255], secondary: [255, 255, 255, 255],
  selectedFrameId: null, selectedAnimationId: null,
  selectedTileId: null,       // tile tool selection (tile mode)
  editingFrameId: null,       // frame editor target
  editingTileId: null,        // tile editor target
  onion: { enabled: false, back: 1, ahead: 1 },
  overlays: { labels: true, sequences: true },
  commands: new CommandStack(),
  floating: null,             // active floating selection (core/floating.js shape) or null
};

const listeners = new Map(); // event -> Set<fn>
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
export function emit(event, payload) {
  listeners.get(event)?.forEach(fn => fn(payload));
  if (event !== '*') listeners.get('*')?.forEach(fn => fn(payload));
}
// events used app-wide: 'project' (data mutated OR project replaced), 'view',
// 'tool', 'history', 'selection', 'pixels', 'colors', 'brushSize', 'playhead'
export function activeSheet() {
  return state.project?.sheets.find(s => s.id === state.activeSheetId) ?? null;
}
export function activeLayer() {
  const sheet = activeSheet();
  return sheet ? findLayer(sheet.layerTree, state.activeLayerId) : null;
}
// Layers visible/editable in the current context. When an animation is
// selected, operations that would otherwise affect "all layers" are scoped to
// the layers inside that animation's group.
export function currentContextLayers() {
  const sheet = activeSheet();
  if (!sheet) return [];
  return modelContextLayers(sheet, state.selectedAnimationId);
}
export function markDirty() { state.dirty = true; emit('project'); }
export function setProject(project) {
  state.project = project;
  const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
  const sheet = project.sheets.find(s => s.kind === kind) ?? null;
  state.activeSheetId = sheet ? sheet.id : null;
  state.activeLayerId = sheet ? (sheetLayers(sheet)[0]?.id ?? null) : null;
  state.commands.clear();
  state.dirty = false;
  emit('project');
  emit('view');
}
export function newDefaultProject(settings = DEFAULT_SETTINGS) {
  const project = createProject('untitled', settings);
  createSheet(project, { name: 'Sprites', width: settings.spriteSheetW, height: settings.spriteSheetH, kind: 'sprite' });
  createSheet(project, { name: 'Tiles', width: settings.tileSheetW, height: settings.tileSheetH, kind: 'tile' });
  return project;
}
