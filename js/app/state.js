import { CommandStack } from '../core/commands.js';
import { createProject, createSheet, DEFAULT_SETTINGS, defaultOnionSettings, findLayer, findNode, sheetLayers, contextLayers as modelContextLayers, flattenLayers, layerAnimationContext } from '../core/model.js';

// Test mode (?autotest): automated browser sessions suppress modal dialogs
// (beforeunload guard, autosave-restore prompt, confirm() gates auto-accept).
export const AUTOTEST = typeof location !== 'undefined' ? new URLSearchParams(location.search).has('autotest') : false;
export const confirmOrAuto = (msg) => AUTOTEST || (typeof confirm !== 'undefined' ? confirm(msg) : false);

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
  selectedTerrainSetId: null, // which terrain set's slot editor is open in the panel
  editingFrameId: null,       // frame editor target
  editingTileId: null,        // tile editor target
  // Saved as part of the project (project.settings.onion) so onion-skin
  // preferences persist across save/load -- setProject() below re-points
  // this at the loaded/new project's own settings.onion object, so every
  // existing state.onion.* read/write throughout the frame editor keeps
  // working unchanged while actually mutating project data. This initial
  // value is only ever seen before the first setProject() call.
  onion: defaultOnionSettings(),
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
// Layers to sweep for an "all layers" operation (Alt+cut/copy, Alt+drag-
// marquee-move) anchored to the CURRENTLY ACTIVE LAYER's own tree position,
// not state.selectedAnimationId -- so it never disagrees with what's
// actually selected in the layers panel. Narrows to just that layer's own
// animation group (strip or plain) when it's nested under one; otherwise the
// whole sheet, same as currentContextLayers()'s root fallback. See
// docs/superpowers/specs/2026-07-18-strip-area-constraint-design.md.
export function activeLayerScope() {
  const sheet = activeSheet();
  if (!sheet) return [];
  const ctx = layerAnimationContext(sheet, activeLayer());
  return ctx ? flattenLayers(ctx.group) : sheetLayers(sheet);
}
export function markDirty() { state.dirty = true; emit('project'); }
export function setProject(project) {
  state.project = project;
  // Defensive: a project built by anything other than createProject/
  // deserializeProject (neither of which should happen, but this keeps
  // state.onion valid rather than undefined either way).
  if (!project.settings.onion) project.settings.onion = defaultOnionSettings();
  state.onion = project.settings.onion;
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
