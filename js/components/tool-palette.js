// Drawing tools: tool palette (buttons + options + keyboard shortcuts).
//
// The pointer-driven stroke lifecycle bound to a CanvasView lives in
// components/canvas/drawing-engine.js; this module owns only the TOOLS
// registry, the shared tool-options state, and the palette UI.

import { isTypingTarget } from './canvas/float-session.js';
import { getEditorHost } from '../host/runtime.js';
import { getBrushLibrary, bindActiveBrushSync } from '../features/brushes/brush-library.js';
import { drawBrushIcon, openBrushManager } from '../features/brushes/brush-manager.js';

function currentModeId() { return getEditorHost()?.store.getState().session.activeModeId ?? null; }
function currentToolId() { return getEditorHost()?.store.getState().session.activeToolId ?? 'pencil'; }
function drawingSettings() { return getEditorHost().store.getState().workspace.drawing; }

export const TOOLS = [
  { id: 'pencil', icon: '✏️', key: 'b', isAvailable: () => currentModeId() !== 'maps' },
  { id: 'eraser', icon: '🧽', key: 'e', isAvailable: () => currentModeId() !== 'maps' },
  { id: 'fill', icon: '🪣', key: 'g', isAvailable: () => currentModeId() !== 'maps' },
  { id: 'softflood', label: 'Soft flood', icon: '🫗', key: 'k', isAvailable: () => currentModeId() !== 'maps' },
  { id: 'line', icon: '📏', key: 'l', isAvailable: () => currentModeId() !== 'maps' },
  { id: 'rect', icon: '▭', key: 'u', isAvailable: () => currentModeId() !== 'maps' },
  { id: 'ellipse', icon: '◯', key: 'o', isAvailable: () => currentModeId() !== 'maps' },
  { id: 'eyedropper', icon: '💉', key: 'i', isAvailable: () => currentModeId() !== 'maps' },
  // These are shared with Maps mode; mapmode.js intercepts their pointer events.
  { id: 'select', icon: '⛶', key: 'm' },
  { id: 'move', icon: '✋', key: 'v' },
];

export const BRUSH_TOOLS = new Set(['pencil', 'eraser']);
export const SHAPE_TOOLS = new Set(['line', 'rect', 'ellipse']);

// Shared tool options (fill contiguity, shape fill) — read by bindDrawing,
// edited by the tool-options row built in mountToolPalette.
export const toolOptions = {
  contiguous: true,
  filled: false,
  softFlood: { tolerance: 0, feather: 0, contiguous: true },
};

// Maps the evenly-spaced tolerance/feather slider positions onto
// exponentially-spaced RGBA distances. This gives precise control over the
// small distances commonly used for pixel art while retaining 0–255 at the end.
const SOFT_FLOOD_DISTANCE_CURVE = 5;
const SOFT_FLOOD_DISTANCE_SCALE = Math.exp(SOFT_FLOOD_DISTANCE_CURVE) - 1;
function softFloodDistanceFromSlider(value) {
  const progress = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  return Math.round(((Math.exp(SOFT_FLOOD_DISTANCE_CURVE * progress) - 1) / SOFT_FLOOD_DISTANCE_SCALE) * 255);
}
function softFloodDistanceToSlider(value) {
  const tolerance = Math.max(0, Math.min(255, Number(value) || 0)) / 255;
  return Math.round((Math.log(1 + tolerance * SOFT_FLOOD_DISTANCE_SCALE) / SOFT_FLOOD_DISTANCE_CURVE) * 100);
}

// ---------------------------------------------------------- external tools
//
// Small registration hook so other UI modules (frames.js's frame tool) can
// add a button + an options row to the palette without this module knowing
// anything about them ahead of time. `mountToolPalette(el)` is called once by main.js;
// `registerTool()` may be called any time after that (main.js calls it right
// after mountToolPalette), so it must be able to append into an
// already-rendered palette rather than requiring a remount (a remount would
// re-add the window keydown listener and duplicate hotkey handling).
//
// def: {id, icon, key, isAvailable?: () => bool} — isAvailable gates both the
// button's visibility and whether its hotkey fires (re-checked on every
// 'view' event, e.g. sprite/tile mode switches).
// buildOptionsRow?: (optionsRowEl) => rowEl — appends the tool's own option
// controls into the shared options row and returns the element(s) whose
// visibility should be toggled on/off with the built-in rows (shown only
// while that tool is active). May return an array of elements.
const extraTools = [];
let paletteApi = null; // set once mountToolPalette has run; used for late registrations

export function registerTool(def, buildOptionsRow) {
  const entry = { ...def, buildOptionsRow };
  extraTools.push(entry);
  if (paletteApi) paletteApi.addTool(entry);
}

// ---------------------------------------------------------------- palette UI

export function mountToolPalette(el) {
  const host = getEditorHost();
  const { store } = host;
  if (!store.getState().session.activeToolId) store.updateSession({ activeToolId: 'pencil' }, 'tool');
  el.innerHTML = '<h3>Tools</h3>';

  const buttonsHost = el;
  const btnRow = document.createElement('div');
  btnRow.className = 'tool-buttons';
  const buttons = new Map();
  const extraRows = []; // [{id, els: [el,...]}] for tools registered via registerTool()

  function makeButton(t) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-icon-lg';
    btn.dataset.tool = t.id;
    btn.textContent = t.icon;
    btn.title = `${t.label ?? t.id} (${t.key})`;
    btn.addEventListener('click', () => selectTool(t.id));
    buttons.set(t.id, btn);
    btnRow.appendChild(btn);
    return btn;
  }
  for (const t of TOOLS) makeButton(t);
  buttonsHost.appendChild(btnRow);

  // ---- separate tool options panel ----
  const optionsPanel = document.createElement('div');
  optionsPanel.className = 'tool-options-panel';
  buttonsHost.appendChild(optionsPanel);

  const toolNameEl = document.createElement('h3');
  toolNameEl.className = 'tool-options-title';
  optionsPanel.appendChild(toolNameEl);

  const optionsRow = document.createElement('div');
  optionsRow.className = 'tool-options';
  optionsPanel.appendChild(optionsRow);

  // Common options are always rendered in the same layout so their position
  // does not jump when switching between tools that share them.
  const brushRow = document.createElement('label');
  brushRow.className = 'tool-option-row';
  brushRow.dataset.commonOption = 'size';
  brushRow.appendChild(document.createTextNode('Size'));
  const brushInput = document.createElement('input');
  brushInput.type = 'number'; brushInput.min = '1'; brushInput.max = '16';
  brushInput.value = String(drawingSettings().brush.mask.size);
  brushInput.addEventListener('change', () => {
    let v = parseInt(brushInput.value, 10);
    if (!Number.isFinite(v)) v = 1;
    v = Math.max(1, Math.min(16, v));
    brushInput.value = String(v);
    const cur = drawingSettings().brush;
    store.updateDrawingSettings({ brush: { ...cur, mask: { ...cur.mask, size: v } } });
  });
  brushRow.appendChild(brushInput);
  optionsRow.appendChild(brushRow);

  // ---- brush picker strip (Task 15b) ----
  // A row of swatches below Size, one per library brush, plus a button that
  // opens the full manager. getBrushLibrary(...) is the shared, WeakMap-
  // memoized accessor -- brush-manager.js's dialog is the first consumer
  // and this is the second, and both MUST see the same instance (an add/
  // edit/remove from either place has to show up in the other without a
  // reload). Never createBrushLibrary() here: calling it a second time is
  // exactly the cache-divergence bug brush-library.test.mjs's
  // characterization test exists to document.
  const lib = getBrushLibrary(host.preferences);
  // A <div>, not the <label> the other rows use -- a <label> wrapping
  // several <button>s (a labelable element) would forward an empty-padding
  // click to whichever button happens to be first, which is not what any
  // of contiguousRow/filledRow rely on (they each wrap exactly one input).
  const brushPickerRow = document.createElement('div');
  brushPickerRow.className = 'tool-option-row brush-picker-row';
  brushPickerRow.dataset.commonOption = 'size';
  const brushPickerStrip = document.createElement('div');
  brushPickerStrip.className = 'brush-picker-strip';
  brushPickerRow.appendChild(brushPickerStrip);
  const brushManagerBtn = document.createElement('button');
  brushManagerBtn.type = 'button';
  brushManagerBtn.className = 'btn-icon-sm brush-picker-manage';
  brushManagerBtn.title = 'Brushes…';
  brushManagerBtn.textContent = '⚙️';
  brushManagerBtn.addEventListener('click', () => openBrushManager());
  brushPickerRow.appendChild(brushManagerBtn);
  optionsRow.appendChild(brushPickerRow);

  // Rebuilds the swatches themselves (icons + count) -- called whenever the
  // LIBRARY changes (a brush added/edited/removed), via lib.subscribe
  // below. Kept separate from updateBrushSwatchSelection (called from the
  // shared refresh() below, which runs far more often) so picking a
  // different active brush -- which does not change the library -- never
  // redraws every icon just to move one highlight.
  function renderBrushSwatches() {
    brushPickerStrip.innerHTML = '';
    const activeId = drawingSettings().brush.id;
    for (const brush of lib.list()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'brush-swatch';
      btn.dataset.brushId = brush.id;
      if (brush.id === activeId) btn.classList.add('is-active');
      btn.title = brush.name;
      const icon = document.createElement('canvas');
      icon.className = 'brush-swatch-icon';
      // Reuses brush-manager.js's own thumbnail renderer rather than a
      // second implementation -- same rasterizeMask grid, centered and
      // unsmoothed on a checkerboard, that the manager's own grid draws.
      drawBrushIcon(icon, brush);
      btn.appendChild(icon);
      // The full brush object, not a merge -- picking a swatch REPLACES the
      // active brush wholesale (mask kind, ink, pressure, everything),
      // unlike the Size input above, which patches one field of the brush
      // already active. store.updateDrawingSettings, never a direct
      // `workspace.drawing.brush =` assignment, matches the Size input's
      // own mutation path just above.
      btn.addEventListener('click', () => store.updateDrawingSettings({ brush }));
      brushPickerStrip.appendChild(btn);
    }
  }

  // Cheap highlight-only pass for the shared refresh() below (which runs on
  // every tool/mode switch and mask-size change): swaps the .is-active
  // class without redrawing every icon.
  function updateBrushSwatchSelection() {
    const activeId = drawingSettings().brush.id;
    for (const btn of brushPickerStrip.children) {
      btn.classList.toggle('is-active', btn.dataset.brushId === activeId);
    }
  }

  renderBrushSwatches();
  const disposeBrushLibrary = lib.subscribe(renderBrushSwatches);
  // The swatch click above hands the store a DETACHED SNAPSHOT of the brush,
  // so a later library edit (the manager's controls, or its Undo/Redo) never
  // reached the canvas -- the picker went on highlighting a brush the canvas
  // was no longer using. This pushes a changed definition back through
  // updateDrawingSettings; `mask.size` is deliberately left alone, because
  // the Size input two rows up and the `[`/`]` keys own it as a live
  // override. See bindActiveBrushSync's own comment for the full reasoning.
  const disposeBrushSync = bindActiveBrushSync(lib, store);

  const optionChecks = document.createElement('div');
  optionChecks.className = 'tool-option-checks';
  optionChecks.dataset.commonOption = 'checks';

  const contiguousRow = document.createElement('label');
  contiguousRow.className = 'tool-option-row';
  const contiguousInput = document.createElement('input');
  contiguousInput.type = 'checkbox';
  contiguousInput.checked = toolOptions.contiguous;
  contiguousInput.addEventListener('change', () => { toolOptions.contiguous = contiguousInput.checked; });
  contiguousRow.append(document.createTextNode('Contiguous'), contiguousInput);
  optionChecks.appendChild(contiguousRow);

  const filledRow = document.createElement('label');
  filledRow.className = 'tool-option-row';
  const filledInput = document.createElement('input');
  filledInput.type = 'checkbox';
  filledInput.checked = toolOptions.filled;
  filledInput.addEventListener('change', () => { toolOptions.filled = filledInput.checked; });
  filledRow.append(document.createTextNode('Filled'), filledInput);
  optionChecks.appendChild(filledRow);

  optionsRow.appendChild(optionChecks);

  const softFloodRow = document.createElement('div');
  softFloodRow.className = 'tool-options';
  for (const [label, key] of [['Tolerance', 'tolerance'], ['Feather', 'feather']]) {
    const row = document.createElement('label');
    row.className = 'tool-option-row soft-flood-control';
    const labelEl = document.createElement('span'); labelEl.textContent = label;
    const input = document.createElement('input');
    input.type = 'range'; input.min = '0'; input.max = '100';
    input.value = String(softFloodDistanceToSlider(toolOptions.softFlood[key]));
    const value = document.createElement('span'); value.textContent = input.value;
    input.addEventListener('input', () => {
      const actual = softFloodDistanceFromSlider(input.value);
      toolOptions.softFlood[key] = actual;
      value.textContent = String(actual);
    });
    value.textContent = String(toolOptions.softFlood[key]);
    row.append(labelEl, value, input);
    softFloodRow.appendChild(row);
  }
  const softContiguous = document.createElement('label');
  softContiguous.className = 'tool-option-row';
  const softContiguousInput = document.createElement('input');
  softContiguousInput.type = 'checkbox'; softContiguousInput.checked = toolOptions.softFlood.contiguous;
  softContiguousInput.addEventListener('change', () => { toolOptions.softFlood.contiguous = softContiguousInput.checked; });
  softContiguous.append(document.createTextNode('Contiguous'), softContiguousInput);
  softFloodRow.appendChild(softContiguous);
  optionsRow.appendChild(softFloodRow);

  function toolLabel(id) {
    const t = TOOLS.find(x => x.id === id) ?? extraTools.find(x => x.id === id);
    return t ? `${t.icon} ${t.label ?? t.id}` : id;
  }

  function toolTitle(id) {
    const t = TOOLS.find(x => x.id === id) ?? extraTools.find(x => x.id === id);
    if (!t) return id;
    return t.label ?? (t.id.charAt(0).toUpperCase() + t.id.slice(1));
  }

  function optionVisibleFor(id) {
    return {
      size: BRUSH_TOOLS.has(id),
      contiguous: id === 'fill',
      filled: id === 'rect' || id === 'ellipse',
      softFlood: id === 'softflood',
    };
  }

  function refresh() {
    const toolId = currentToolId();
    for (const [id, btn] of buttons) {
      const entry = TOOLS.find(t => t.id === id) ?? extraTools.find(t => t.id === id);
      btn.classList.toggle('active', toolId === id);
      btn.hidden = !!entry?.isAvailable && !entry.isAvailable();
    }
    for (const extra of extraTools) {
      const btn = buttons.get(extra.id);
      if (btn && extra.isAvailable) btn.hidden = !extra.isAvailable();
    }
    toolNameEl.textContent = toolTitle(toolId);
    const vis = optionVisibleFor(toolId);
    brushRow.style.display = vis.size ? '' : 'none';
    // Same gate as Size -- the active-brush concept only matters while a
    // brush tool (pencil/eraser) is selected.
    brushPickerRow.style.display = vis.size ? '' : 'none';
    contiguousRow.style.display = vis.contiguous ? '' : 'none';
    filledRow.style.display = vis.filled ? '' : 'none';
    optionChecks.style.display = (vis.contiguous || vis.filled) ? '' : 'none';
    softFloodRow.style.display = vis.softFlood ? '' : 'none';
    for (const { id, els } of extraRows)
      for (const rEl of els) rEl.style.display = toolId === id ? '' : 'none';
    const cur = drawingSettings().brush;
    brushInput.value = String(cur.mask.size);
    // A custom mask has no scalar size to edit.
    brushInput.disabled = cur.mask.kind === 'custom';
    updateBrushSwatchSelection();
  }

  function selectTool(id) {
    store.updateSession({ activeToolId: id }, 'tool');
  }

  function addTool(entry) {
    makeButton(entry);
    if (entry.buildOptionsRow) {
      const built = entry.buildOptionsRow(optionsRow);
      const els = Array.isArray(built) ? built : (built ? [built] : []);
      extraRows.push({ id: entry.id, els });
    }
    refresh();
  }

  // pick up any tools registered before this (re)mount
  for (const entry of extraTools) addTool(entry);
  paletteApi = { addTool, refresh };

  refresh();
  const disposables = [
    store.subscribe(s => s.session.activeModeId, refresh),
    store.subscribe(s => s.session.activeToolId, refresh),
    store.subscribe(s => s.workspace.drawing.brush.mask.size, refresh),
    // Two brushes can share a mask size (e.g. two square-size-1 brushes with
    // different ink), so the subscription above alone would miss a swatch
    // switch between them -- this one exists specifically for that case.
    store.subscribe(s => s.workspace.drawing.brush.id, refresh),
  ];

  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    const t = [...TOOLS, ...extraTools].find(t => t.key === e.key.toLowerCase() && (!t.isAvailable || t.isAvailable()));
    if (!t) return;
    e.preventDefault();
    selectTool(t.id);
  };
  window.addEventListener('keydown', onKeyDown);
  return {
    dispose() {
      disposables.forEach(dispose => dispose());
      disposeBrushLibrary();
      disposeBrushSync();
      window.removeEventListener('keydown', onKeyDown);
      if (paletteApi?.refresh === refresh) paletteApi = null;
    },
  };
}
