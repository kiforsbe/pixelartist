import { CommandStack } from '../core/commands.js';
import { createProject, createSheet } from '../core/model.js';

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
  selectedTileIndex: null,    // tile tool selection (tile mode)
  editingFrameId: null,       // frame editor target
  editingTileIndex: null,     // tile editor target
  onion: { enabled: false, back: 1, ahead: 1 },
  overlays: { labels: true, sequences: true },
  commands: new CommandStack(),
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
// events used app-wide: 'project', 'sheet', 'selection', 'tool', 'view',
// 'history', 'pixels', 'colors', 'brushSize'
export function activeSheet() {
  return state.project?.sheets.find(s => s.id === state.activeSheetId) ?? null;
}
export function activeLayer() {
  const sheet = activeSheet();
  return sheet?.layers.find(l => l.id === state.activeLayerId) ?? null;
}
export function markDirty() { state.dirty = true; emit('project'); }
export function setProject(project) {
  state.project = project;
  const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
  const sheet = project.sheets.find(s => s.kind === kind) ?? null;
  state.activeSheetId = sheet ? sheet.id : null;
  state.activeLayerId = sheet ? (sheet.layers[0]?.id ?? null) : null;
  state.commands.clear();
  state.dirty = false;
  emit('project');
  emit('view');
}
export function newDemoProject() {
  const project = createProject('untitled');
  createSheet(project, { name: 'Sprites', width: 128, height: 128, kind: 'sprite' });
  createSheet(project, { name: 'Tiles', width: 128, height: 128, kind: 'tile' });
  return project;
}
