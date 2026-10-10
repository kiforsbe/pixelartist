// js/modes/animations/presentation/animation-timeline-presenter.js
// The Animations workbench's timeline dock: the sheet's layer tree and its
// frame sequence in one grid. Header: playback (first, previous, play/stop,
// next, last, loop), + Frame / Duplicate / remove for the selected column,
// and add layer / add folder / delete. Grid: tags, frame numbers, a row of
// composite thumbnails, then one row per visible layer-tree node -- the
// shared layer row (layer-tree.js) and one cel per column, a filled dot
// where that layer has pixels in that frame. Clicking a cel selects its
// frame and layer, Shift-click extends a range of columns within one
// animation; a tag selects its animation and renames on double-click. Within
// an animation's tag, `+` between columns inserts a blank frame (Alt: a copy
// of the frame to its left), dragging a frame number moves it -- or the range
// it is in -- (Alt: copies, Ctrl: inserts a linked use), and Delete / Left /
// Right on the focused grid remove or step the selection. Frame operations
// are actions with shortcuts and context menus (timeline-actions.js). A
// manual animation is offered an auto-layout before an operation that needs
// one. Playback plays the selected animation into the Preview panel.
import { flattenSheetLayers, findLayer } from '../../../core/model.js';
import { copyRegion } from '../../../core/pixels.js';
import { advancePlayback } from '../../../domain/sprites/playback.js';
import { getEditorHost } from '../../../host/runtime.js';
import { confirmOrAuto } from '../../../platform/browser/autotest.js';
import { activeSheet, currentContextLayers } from '../../../host/document-helpers.js';
import { activeFloating, commitFloatIfAny } from '../../../components/canvas/float-session.js';
import { createRasterCache } from '../../../components/canvas/raster-cache.js';
import { drawFit } from '../../../components/canvas/draw-fit.js';
import { dispatchLayout } from '../../../components/layout-dispatch.js';
import { setPreviewBitmap } from '../../../components/panels/preview-panel.js';
import { mountStorePanel } from '../../../components/panel-mount.js';
import { buildFrameDurationInput } from '../../../components/panels/frame-duration-input.js';
import { createDockResizer, workspaceDockMax } from '../../../components/dock-resizer.js';
import { attachDragReorder } from '../../../components/drag-reorder.js';
import { attachContextMenu } from '../../../components/context-menu.js';
import { defineTimelineActions, attachTimelineShortcuts, FRAME_MENU, CEL_MENU, TAG_MENU } from './timeline-actions.js';
import { setPlayingFrame, registerPlaybackStop } from './timeline-playback.js';
import {
  layerTreeRows, buildLayerRow, buildLayerTreeEnd, attachLayerTreeDrop, selectTreeNode, addSheetLayer, addSheetGroup, deleteSheetNode,
  nameClickPending, scheduleNameSelect, cancelNameClick,
} from '../../../components/panels/layer-tree.js';
import {
  timelineColumns, tagSpans, selectedColumn, celFilled, entryDurationLabel, directionGlyph, columnInRange, edgeDragPlan,
} from '../application/timeline-model.js';

// Column width, px: the header's size control, remembered per browser.
// From EXPAND_AT up the timeline shows thumbnails: a composite row and one
// per cel instead of its dot.
const COL_KEY = 'pixelartist.animTimelineColumn';
const COL_MIN = 16, COL_MAX = 64, COL_DEFAULT = 24;
const EXPAND_AT = 40;

function storedColumnWidth() {
  try {
    const v = Number(localStorage.getItem(COL_KEY));
    return v >= COL_MIN && v <= COL_MAX ? v : COL_DEFAULT;
  } catch { return COL_DEFAULT; }
}
const NEEDS_AUTO = 'Auto-layout this animation first';

function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}

function sheetDocument(sheet) { return { kind: 'sprite-sheet', id: sheet.id }; }

function iconButton(text, title) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'btn-icon-sm';
  button.textContent = text; button.title = title;
  return button;
}

export function mountAnimationTimeline(el) {
  el.innerHTML = '';
  const host = getEditorHost();

  // ---- header ----
  const header = document.createElement('div');
  header.className = 'timeline-header';
  const btnFirst = iconButton('⏮', 'First frame');
  const btnPrev = iconButton('◂', 'Previous frame');
  const btnPlay = iconButton('▶', 'Play');
  const btnNext = iconButton('▸', 'Next frame');
  const btnLast = iconButton('⏭', 'Last frame');
  const loopCheckbox = document.createElement('input');
  loopCheckbox.type = 'checkbox'; loopCheckbox.checked = true;
  const loopLabel = document.createElement('label');
  loopLabel.className = 'timeline-loop';
  loopLabel.title = 'Loop the preview playback (the exported Loop flag is in the Animations panel)';
  loopLabel.append(loopCheckbox, document.createTextNode('Loop'));
  const btnAdd = document.createElement('button');
  btnAdd.type = 'button'; btnAdd.textContent = '+ Frame';
  const btnDuplicate = document.createElement('button');
  btnDuplicate.type = 'button'; btnDuplicate.textContent = 'Duplicate';
  const btnRemove = iconButton('✕', 'Remove this frame');
  const separator = document.createElement('span');
  separator.className = 'timeline-separator';
  const btnAddLayer = iconButton('➕', 'Add layer');
  const btnAddFolder = iconButton('📁', 'Add folder');
  const btnDeleteNode = iconButton('🗑', 'Delete layer or folder');
  let colW = storedColumnWidth();
  const sizeInput = document.createElement('input');
  sizeInput.type = 'range'; sizeInput.className = 'anim-tl-size';
  sizeInput.min = String(COL_MIN); sizeInput.max = String(COL_MAX); sizeInput.step = '4';
  sizeInput.value = String(colW);
  sizeInput.title = 'Column width (wide columns show thumbnails)';
  // The slider and Ctrl+wheel over the grid set the same width.
  function setColumnWidth(width) {
    colW = Math.max(COL_MIN, Math.min(COL_MAX, width));
    sizeInput.value = String(colW);
    try { localStorage.setItem(COL_KEY, String(colW)); } catch { /* per-browser convenience only */ }
    panel.scheduleRender();
  }
  sizeInput.addEventListener('input', () => setColumnWidth(Number(sizeInput.value) || COL_DEFAULT));
  btnAddLayer.addEventListener('click', addSheetLayer);
  btnAddFolder.addEventListener('click', addSheetGroup);
  btnDeleteNode.addEventListener('click', deleteSheetNode);
  // The selected column's duration (refilled by render).
  const durationBox = document.createElement('div');
  durationBox.className = 'anim-tl-duration';
  header.append(btnFirst, btnPrev, btnPlay, btnNext, btnLast, loopLabel, btnAdd, btnDuplicate, btnRemove,
    durationBox, separator, btnAddLayer, btnAddFolder, btnDeleteNode, sizeInput);

  // ---- grid ----
  const grid = document.createElement('div');
  grid.className = 'anim-tl-grid';
  const tagsRow = document.createElement('div');
  tagsRow.className = 'anim-tl-row anim-tl-tags';
  const numsRow = document.createElement('div');
  numsRow.className = 'anim-tl-row anim-tl-nums';
  const cellsRow = document.createElement('div');
  cellsRow.className = 'anim-tl-row anim-tl-cells';
  const layersBox = document.createElement('div');
  layersBox.className = 'anim-tl-layers';
  // The end target after the rows (render) takes a node to the root bottom:
  // the Layers panel is hidden here, so this is the only way to reach it
  // when the last row sits inside an open folder.
  const disposeLayerDrop = attachLayerTreeDrop(layersBox, { emptyDropsToRoot: true });
  const empty = document.createElement('div');
  empty.className = 'anim-tl-empty';
  grid.append(tagsRow, numsRow, cellsRow, layersBox, empty);
  // Ctrl+wheel zooms the columns (the slider's setting); a plain wheel
  // scrolls as usual.
  grid.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !e.deltaY) return;
    e.preventDefault();
    setColumnWidth(colW + (e.deltaY < 0 ? 4 : -4));
  }, { passive: false });

  const main = document.createElement('div');
  main.className = 'timeline-main';
  main.append(header, grid);

  // ---- dock resize: mounted once beside .timeline-main, which render()
  // never clears. A fit shows every row: the grid's rows (not its
  // scrollHeight, which never drops below a tall dock's grid) plus its
  // bottom padding (4px, css/app.css) and horizontal scrollbar. ----
  const gridChrome = () => 4 + Math.max(0, (grid.offsetHeight || 0) - (grid.clientHeight || 0));
  const resizer = createDockResizer({
    target: el, edge: 'top', min: 100, max: () => workspaceDockMax(el),
    measureContent: () => (resizer.element.offsetHeight || 0) + (header.offsetHeight || 0)
      + Array.from(grid.children).reduce((sum, row) => sum + (row.hidden ? 0 : row.offsetHeight || 0), 0)
      + gridChrome() + Math.max(0, (el.offsetHeight || 0) - (el.clientHeight || 0)),
    prefs: host.preferences, prefKey: 'dock.animations.timeline.height', label: 'Resize the timeline panel',
  });
  el.append(resizer.element, main);

  // ---- state ----
  const sheet = () => activeSheet('sprite');
  const selection = () => { const s = sheet(); return s ? (host.selections.get(sheetDocument(s)) ?? {}) : {}; };
  const selectedAnim = () => sheet()?.animations.find(a => a.id === selection().animationId) ?? null;
  const columns = () => timelineColumns(sheet());
  const current = () => { const cols = columns(); return cols[selectedColumn(cols, selection())] ?? null; };

  const flatCache = createRasterCache();
  const flat = s => flatCache.getBitmap(s, x => flattenSheetLayers(currentContextLayers(), x.width, x.height, activeFloating(), x.id));
  function frameBitmap(s, frameId) {
    const f = s.frames.find(fr => fr.id === frameId);
    return f ? copyRegion(flat(s), f.x, f.y, f.w, f.h) : null;
  }

  function select(column) {
    const s = sheet();
    if (!s || !column) return;
    host.selections.patch({ animationId: column.animationId, frameId: column.frameId, entryIndex: column.index }, sheetDocument(s));
  }

  // ---- range selection: presenter-local, within one animation ----
  // `range` ({ animationId, from, to }, two or more entries) holds while the
  // selected column lies inside it; otherwise the selected column alone is
  // the selection. `anchor` is the last plain click, where Shift extends
  // from. Both are dropped when another animation is selected.
  let range = null, anchor = null;

  function selectedRange() {
    const anim = selectedAnim(), column = current();
    if (!anim || column?.animationId !== anim.id) return null;
    if (range?.animationId === anim.id && range.to < anim.frames.length && columnInRange(column, range)) {
      return { anim, from: range.from, to: range.to, column };
    }
    return { anim, from: column.index, to: column.index, column };
  }

  // Selects `column`; with `extend` (Shift) the range runs from the anchor
  // (else the selected column) to it, inside one animation only.
  function pick(column, extend = false) {
    stopPlaying();
    const cur = current();
    const base = !extend ? null
      : anchor?.animationId === column.animationId ? anchor
        : cur?.animationId === column.animationId ? cur : null;
    anchor = { animationId: column.animationId, index: base ? base.index : column.index };
    range = base && base.index !== column.index
      ? { animationId: column.animationId, from: Math.min(base.index, column.index), to: Math.max(base.index, column.index) }
      : null;
    select(column);
    panel.scheduleRender();
  }

  // Selects entry `index` of `anim` alone (or, with `extend`, up to it).
  function pickEntry(anim, index, extend = false) {
    if (!anim?.frames[index]) return;
    pick({ animationId: anim.id, index, frameId: anim.frames[index].frameId }, extend);
  }

  // Sets the range to entries [from..to] of `anim` and selects `at` in it.
  function setRange(anim, from, to, at = from) {
    if (!anim?.frames[at]) return;
    anchor = { animationId: anim.id, index: from };
    range = to > from ? { animationId: anim.id, from, to } : null;
    select({ animationId: anim.id, index: at, frameId: anim.frames[at].frameId });
    panel.scheduleRender();
  }

  // ---- playback (drives the Preview panel and, through timeline-playback.js,
  // the main view) ----
  let playing = false, rafId = null, lastTs = null, acc = 0, position = 0;
  let cursor = null; // place in the direction's play order (advancePlayback)
  let playingId = null; // the animation being played

  // Playback ends when the selection moves to another animation or the
  // playing entry disappears (undo, a delete from elsewhere).
  const playbackStale = anim => anim?.id !== playingId || position >= anim.frames.length;

  function setPlayButton() {
    btnPlay.textContent = playing ? '⏹' : '▶';
    btnPlay.title = playing ? 'Stop' : 'Play';
  }
  function stopPlaying() {
    playing = false;
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null; lastTs = null;
    setPlayingFrame(null);
    setPlayButton();
    updatePlayhead();
  }
  function tick(ts) {
    const anim = selectedAnim();
    if (!playing || playbackStale(anim)) { stopPlaying(); return; }
    if (lastTs == null) lastTs = ts;
    const result = advancePlayback(anim, position, acc, ts - lastTs, loopCheckbox.checked, cursor);
    lastTs = ts;
    position = result.position; acc = result.acc; cursor = result.cursor;
    if (result.stopped) stopPlaying();
    else setPlayingFrame(anim.frames[position]?.frameId ?? null);
    renderPreview(); updatePlayhead();
    if (playing) rafId = requestAnimationFrame(tick);
  }
  function startPlaying() {
    const anim = selectedAnim();
    if (!anim?.frames.length) return;
    // The main view plays frames under it: a float settles first (its own
    // undo step), as on a column change.
    commitFloatIfAny();
    playing = true;
    playingId = anim.id;
    position = Math.max(0, current()?.animationId === anim.id ? current().index : 0);
    acc = 0; lastTs = null; cursor = null;
    setPlayingFrame(anim.frames[position].frameId);
    setPlayButton();
    updatePlayhead();
    rafId = requestAnimationFrame(tick);
  }
  btnPlay.addEventListener('click', () => { if (playing) stopPlaying(); else startPlaying(); });
  // A press on the main view while playing stops on the frame it shows and
  // selects it, so what is painted is what was seen.
  const disposePlaybackStop = registerPlaybackStop(() => {
    if (!playing) return;
    const anim = selectedAnim(), at = position;
    stopPlaying();
    pickEntry(anim, at);
  });

  function renderPreview() {
    const s = sheet();
    if (!s) { setPreviewBitmap(null); return; }
    const anim = selectedAnim();
    const frameId = playing ? anim?.frames[position]?.frameId : current()?.frameId;
    setPreviewBitmap(frameId ? frameBitmap(s, frameId) : null);
  }

  // Marks the playing column's number (and, expanded, its composite cell);
  // the rows' leading corner cells are not columns.
  function updatePlayhead() {
    const cols = columns(), anim = selectedAnim();
    const at = i => playing && cols[i]?.animationId === anim?.id && cols[i]?.index === position;
    for (const row of [numsRow, cellsRow]) {
      Array.from(row.children).filter(c => !c.classList.contains('anim-tl-corner'))
        .forEach((c, i) => c.classList.toggle('playhead', at(i)));
    }
  }

  // ---- navigation ----
  function step(delta) {
    stopPlaying();
    const cols = columns();
    if (!cols.length) return;
    const index = selectedColumn(cols, selection());
    pick(cols[index === -1 ? 0 : Math.max(0, Math.min(cols.length - 1, index + delta))]);
  }
  // Shift+Left/Right: moves the range's free end, never out of the animation.
  function extend(delta) {
    const anim = selectedAnim(), column = current();
    if (!anim || column?.animationId !== anim.id) return;
    pickEntry(anim, Math.max(0, Math.min(anim.frames.length - 1, column.index + delta)), true);
  }
  function edge(last) {
    stopPlaying();
    const anim = selectedAnim();
    if (!anim?.frames.length) return;
    pickEntry(anim, last ? anim.frames.length - 1 : 0);
  }
  // `,` / `.`: the previous / next entry of the selected animation, wrapping.
  function stepInAnimation(delta) {
    const anim = selectedAnim();
    if (!anim?.frames.length) return;
    const column = current();
    const index = column?.animationId === anim.id ? column.index : 0;
    pickEntry(anim, (index + delta + anim.frames.length) % anim.frames.length);
  }
  btnPrev.addEventListener('click', () => step(-1));
  btnNext.addEventListener('click', () => step(1));
  btnFirst.addEventListener('click', () => edge(false));
  btnLast.addEventListener('click', () => edge(true));

  // ---- editing columns ----
  const findAnim = id => sheet()?.animations.find(a => a.id === id) ?? null;

  // Manual animations whose offer was declined for a reorder: reorders
  // work by hand, so they are not asked again this session.
  const declinedForReorder = new Set();

  // Auto-lays-out `anim`. Frames whose pivots differ are re-framed onto one
  // pivot at the sprite size only after an explicit yes, since that can crop
  // pixels. -> the command result, or null when that yes was refused.
  function autoLayoutWithSizePrompt(s, anim) {
    const result = dispatchLayout('animations.autoLayout', { sheetId: s.id, animationId: anim.id });
    if (!result?.needsSize) return result;
    const { w, h } = result.suggested;
    if (!confirmOrAuto(`"${anim.name}" has frames whose pivots differ. Align them on one pivot at ${w}×${h}? `
      + 'Each frame is re-framed around its pivot; pixels outside the new frame are cropped.')) return null;
    return dispatchLayout('animations.autoLayout', { sheetId: s.id, animationId: anim.id, size: result.suggested });
  }

  // An offer -- { mark } -- once the animation is auto-laid-out, else false.
  // `mark` is the history position before an accepted conversion (null when
  // it already was auto), which settleOffer folds the gesture into.
  function ensureAuto(s, anim, { forReorder = false } = {}) {
    if (anim.layout === 'auto') return { mark: null };
    if (forReorder && declinedForReorder.has(anim.id)) return false;
    if (!confirmOrAuto(`"${anim.name}" is laid out by hand. Auto-layout it first?`)) {
      if (forReorder) declinedForReorder.add(anim.id);
      return false;
    }
    // A pending float commits as its own undo step, outside the gesture.
    commitFloatIfAny();
    const mark = host.history.mark();
    const result = autoLayoutWithSizePrompt(s, anim);
    if (!result && forReorder) declinedForReorder.add(anim.id);
    return result?.ok ? { mark } : false;
  }

  // After the gesture an accepted offer allowed: one undo step with the
  // conversion, or -- the gesture refused -- rolled back without a trace so
  // the animation stays manual.
  function settleOffer(offer, ok) {
    if (!offer?.mark) return;
    if (ok) host.history.combineSince(offer.mark);
    else host.history.rollbackTo(offer.mark);
  }

  // Runs `gesture(s, anim)` -> a command result on `anim`, first offering
  // the auto layout when it is manual; an accepted offer and the gesture
  // are one undo step. -> the result when it succeeded, else null.
  function withAuto(anim, gesture) {
    const s = sheet();
    if (!s || !anim) return null;
    stopPlaying(); // a structural change; playback would index stale entries
    const offer = ensureAuto(s, anim);
    if (!offer) return null;
    const result = gesture(s, findAnim(anim.id));
    settleOffer(offer, !!result?.ok);
    return result?.ok ? result : null;
  }

  // Inserts a frame at entry `at` of an auto animation -- a copy of copyOf,
  // else blank -- and selects it. -> the command result.
  function insertAt(s, animationId, at, copyOf) {
    stopPlaying(); // a structural change; playback would index stale entries
    const result = dispatchLayout('animations.addFrame', { sheetId: s.id, animationId, at, copyOf });
    if (result?.ok) pickEntry(findAnim(animationId), at);
    return result;
  }

  // ---- operations on the selection (the actions in timeline-actions.js) ----
  const rangeArgs = (s, r) => ({ sheetId: s.id, animationId: r.anim.id, from: r.from, to: r.to });

  // A blank frame after the selection (the animation's end without one).
  function insertBlank() {
    const anim = selectedAnim(), r = selectedRange();
    if (!anim) return;
    withAuto(anim, (s, a) => insertAt(s, a.id, r ? r.to + 1 : a.frames.length, null));
  }

  // Copies of the selected entries right after them; the copies become the
  // selection (the dragged column's counterpart selected).
  function duplicateFrames() {
    const r = selectedRange();
    if (!r) return;
    const result = withAuto(r.anim, s => dispatchLayout('animations.duplicateFrames', rangeArgs(s, r)));
    if (result) setRange(findAnim(r.anim.id), result.from, result.to, result.from + r.column.index - r.from);
  }

  // Another use of the selected column's frame after the selection.
  function insertLinked() {
    const r = selectedRange();
    if (!r) return;
    const at = r.to + 1;
    const result = withAuto(r.anim, (s, a) => dispatchLayout('animations.linkFrame', { sheetId: s.id, animationId: a.id, at, frameId: r.column.frameId }));
    if (result) pickEntry(findAnim(r.anim.id), at);
  }

  // Gives the selected (linked) column a frame of its own.
  function unlinkFrame() {
    const r = selectedRange();
    if (!r) return;
    withAuto(r.anim, (s, a) => dispatchLayout('animations.unlinkFrame', { sheetId: s.id, animationId: a.id, index: r.column.index }));
  }

  // Removes the selected entries (both layouts) and selects the neighbour.
  function deleteFrames() {
    const s = sheet(), r = selectedRange();
    if (!s || !r) return;
    stopPlaying();
    if (!dispatchLayout('animations.deleteFrames', rangeArgs(s, r))?.ok) return;
    const anim = findAnim(r.anim.id);
    pickEntry(anim, Math.min(r.from, (anim?.frames.length ?? 0) - 1));
  }

  function reverseFrames() {
    const s = sheet(), r = selectedRange();
    if (!s || !r || r.to === r.from) return;
    stopPlaying();
    if (dispatchLayout('animations.reverseFrames', rangeArgs(s, r))?.ok) setRange(findAnim(r.anim.id), r.from, r.to, r.column.index);
  }

  // The selected layer's pixels inside the selected column's frame.
  function clearCel() {
    const s = sheet(), r = selectedRange(), layerId = selection().layerId;
    if (s && r && layerId) dispatchLayout('animations.clearCel', { sheetId: s.id, frameId: r.column.frameId, layerId });
  }

  // ---- tag operations ----
  const animArgs = (s, anim) => ({ sheetId: s.id, animationId: anim.id });

  function setDirection(direction) {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatch('sprites.setAnimationDirection', { ...animArgs(s, anim), direction });
  }

  function setColor(color) {
    const s = sheet(), anim = findAnim(colorInput.dataset.animationId) ?? selectedAnim();
    if (s && anim) dispatch('sprites.setAnimationColor', { ...animArgs(s, anim), color });
  }
  // Colour…: the browser's colour picker on a hidden input; its `change`
  // (the picker closed on a colour) is one undo step.
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'anim-tl-color-input';
  colorInput.tabIndex = -1;
  colorInput.addEventListener('change', () => setColor(colorInput.value));
  header.appendChild(colorInput);
  function pickColor() {
    const anim = selectedAnim();
    if (!anim) return;
    colorInput.dataset.animationId = anim.id;
    colorInput.value = anim.color ?? '#4f8cff';
    try { if (colorInput.showPicker) colorInput.showPicker(); else colorInput.click?.(); } catch { colorInput.click?.(); }
  }

  function toggleLoop() {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatch('sprites.toggleAnimationLoop', { ...animArgs(s, anim), loop: !anim.loop });
  }

  function duplicateAnimation() {
    const result = withAuto(selectedAnim(), (s, a) => dispatchLayout('animations.duplicate', animArgs(s, a)));
    if (result?.animationId) pickEntry(findAnim(result.animationId), 0);
  }

  // Selects a just-made animation and opens its tag's rename once rendered.
  function adoptNew(animationId) {
    range = null; anchor = null;
    pendingRename = animationId;
    pickEntry(findAnim(animationId), 0);
    panel.scheduleRender();
  }

  // A new auto animation of one blank frame of the sprite size, named for
  // now -- the rename opens.
  function newAnimation() {
    const s = sheet();
    if (!s) return;
    stopPlaying();
    const result = dispatchLayout('animations.new', { sheetId: s.id });
    if (result?.ok) adoptNew(result.animationId);
  }

  // The selected entries become a new animation right after theirs.
  function newFromFrames() {
    const s = sheet(), r = selectedRange();
    if (!s || !r) return;
    stopPlaying();
    const result = dispatchLayout('animations.splitFrames', rangeArgs(s, r));
    if (result?.ok) adoptNew(result.animationId);
  }

  function autoLayoutSelected() {
    const s = sheet(), anim = selectedAnim();
    if (s && anim && anim.layout !== 'auto') autoLayoutWithSizePrompt(s, anim);
  }

  function makeManualSelected() {
    const s = sheet(), anim = selectedAnim();
    if (s && anim?.layout === 'auto') dispatchLayout('animations.makeManual', animArgs(s, anim));
  }

  function deleteAnimation() {
    const s = sheet(), anim = selectedAnim();
    if (!s || !anim) return;
    const message = anim.layout === 'auto' ? `Delete animation "${anim.name}" and its frames?` : `Delete animation "${anim.name}"?`;
    if (!confirmOrAuto(message)) return;
    stopPlaying();
    dispatchLayout('animations.delete', animArgs(s, anim));
  }

  btnAdd.addEventListener('click', insertBlank);
  btnDuplicate.addEventListener('click', duplicateFrames);

  // A `+` gap: a blank frame at `at`; Alt copies the frame to its left.
  function onGap(e, animationId, at) {
    e.stopPropagation();
    const anim = findAnim(animationId);
    withAuto(anim, (s, a) => insertAt(s, animationId, at, e.altKey ? a.frames[at - 1]?.frameId ?? null : null));
  }

  // ---- frame-number drags (js/components/drag-reorder.js) ----
  // Keys are global column indexes; drops stay inside the dragged column's
  // animation. Plain: move the selected range when the dragged column is in
  // it, else that column (animations.moveFrames, either layout -- a manual
  // animation is offered the auto layout once, and a declined offer still
  // moves the entries by hand). Alt: copies (needs the auto layout). Ctrl:
  // a linked use of the dragged column alone.
  function dragColumns(sourceKey, targetKey) {
    const cols = columns();
    const source = cols[Number(sourceKey)], target = cols[Number(targetKey)];
    return source && target && source.animationId === target.animationId ? { source, target } : null;
  }

  function onFrameDrop({ sourceKey, targetKey, place, modifiers }) {
    const pair = dragColumns(sourceKey, targetKey);
    const s = sheet(), anim = pair && findAnim(pair.source.animationId);
    if (!s || !anim) return;
    const { source, target } = pair;
    const at = target.index + (place === 'after' ? 1 : 0);
    if (modifiers.link) {
      const result = withAuto(anim, (sh, a) => dispatchLayout('animations.linkFrame', { sheetId: sh.id, animationId: a.id, at, frameId: source.frameId }));
      if (result) pickEntry(findAnim(anim.id), at);
      return;
    }
    const r = selectedRange();
    const { from, to } = r && r.anim.id === anim.id && source.index >= r.from && source.index <= r.to ? r : { from: source.index, to: source.index };
    const reselect = result => setRange(findAnim(anim.id), result.from, result.to, result.from + source.index - from);
    if (modifiers.copy) {
      const result = withAuto(anim, (sh, a) => dispatchLayout('animations.copyFrames', { sheetId: sh.id, animationId: a.id, from, to, at }));
      if (result) reselect(result);
      return;
    }
    if (at >= from && at <= to + 1) return; // inside or touching the moved entries
    stopPlaying();
    const offer = ensureAuto(s, anim, { forReorder: true });
    const result = dispatchLayout('animations.moveFrames', { sheetId: s.id, animationId: anim.id, from, to, at });
    settleOffer(offer, !!result?.ok);
    if (result?.ok) reselect(result);
  }

  const disposeDrag = attachDragReorder(numsRow, {
    axis: 'x',
    itemSelector: '.anim-tl-num',
    canDrop: (sourceKey, { targetKey }) => !!dragColumns(sourceKey, targetKey),
    modifiers: e => ({ link: !!(e.ctrlKey || e.metaKey), copy: !!e.altKey && !(e.ctrlKey || e.metaKey) }),
    // A copy or linked use may land right beside its source; a move there is a no-op.
    allowInPlace: m => !!(m.copy || m.link),
    onDrop: onFrameDrop,
  });

  btnRemove.addEventListener('click', deleteFrames);

  // ---- context menus (js/components/context-menu.js) ----
  // What a number, composite cell or cel stands for: { column, layer? }.
  const hits = new WeakMap();

  // A right-click selects what it hits first -- a column inside the current
  // range keeps the range -- and the menu's actions then act on the
  // selection. Anything else in the grid keeps the browser's menu (layer
  // rows bring their own).
  const disposeMenu = attachContextMenu(grid, (e) => {
    const target = e.target;
    const tag = target?.closest?.('.anim-tag');
    if (tag) {
      const anim = findAnim(tag.dataset.animationId);
      if (!anim || renaming) return null;
      if (selectedAnim()?.id !== anim.id) pickEntry(anim, 0);
      return TAG_MENU;
    }
    const el = target?.closest?.('.anim-tl-num, .anim-tl-cell, .anim-tl-cel');
    const hit = el && hits.get(el);
    if (!hit) return null;
    const s = sheet();
    if (hit.layer && s) selectTreeNode(s, hit.layer);
    const r = selectedRange();
    if (r && r.to > r.from && columnInRange(hit.column, { animationId: r.anim.id, from: r.from, to: r.to })) {
      stopPlaying();
      select(hit.column);
      panel.scheduleRender();
    } else {
      pick(hit.column);
    }
    return hit.layer ? CEL_MENU : FRAME_MENU;
  });

  // Keys on the focused grid itself: never from a control inside it (a
  // rename or duration input, a layer row's buttons).
  grid.tabIndex = 0;
  grid.addEventListener('keydown', (e) => {
    if (e.target !== grid) return;
    if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); deleteFrames(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (e.shiftKey) extend(-1); else step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (e.shiftKey) extend(1); else step(1); }
  });

  // ---- render ----
  // A tag: its animation's name and direction glyph, drawn in its colour.
  // A click selects the animation at once but defers the re-render (the
  // layer names' grace window), so a double-click still lands on this tag
  // and renames it inline.
  function buildTag(span) {
    const anim = findAnim(span.animationId);
    const tag = document.createElement('div');
    tag.className = 'anim-tag';
    tag.dataset.animationId = span.animationId;
    tag.textContent = span.name;
    const dir = document.createElement('span');
    dir.className = 'anim-tag-dir';
    dir.textContent = directionGlyph(anim?.direction);
    tag.appendChild(dir);
    tag.title = `${span.name} — double-click to rename`;
    tag.style.width = `${span.length * colW}px`;
    const color = anim?.color ?? 'var(--accent)';
    tag.style.borderColor = color;
    tag.style.background = `color-mix(in srgb, ${color} 30%, var(--bg3))`;
    tag.addEventListener('click', () => {
      if (renaming) return;
      stopPlaying();
      scheduleNameSelect(() => pickEntry(findAnim(span.animationId), 0), () => panel.scheduleRender());
    });
    tag.addEventListener('dblclick', () => {
      const a = findAnim(span.animationId);
      if (a && !renaming) startTagRename(tag, a);
    });
    for (const edge of ['start', 'end']) {
      const handle = document.createElement('span');
      handle.className = `anim-tag-edge ${edge}`;
      handle.title = edge === 'end'
        ? 'Drag to add frames at the end (Alt: copies of the last) or cut them off'
        : 'Drag to add frames at the start (Alt: copies of the first) or cut them off';
      handle.addEventListener('pointerdown', e => startEdgeDrag(e, tag, span.animationId, edge));
      for (const type of ['click', 'dblclick']) handle.addEventListener(type, e => e.stopPropagation());
      tag.appendChild(handle);
    }
    return tag;
  }

  // ---- tag edges: dragging a tag's start or end cuts or adds frames ----
  // The tag previews its new length (and the columns to cut) while the
  // pointer moves; the release runs one command -- animations.deleteFrames
  // inward, animations.addFrame with a count outward (blank, or with Alt
  // copies of the edge frame; a manual animation is offered the auto layout
  // first). Escape cancels. Renders wait while it runs.
  let edgeDrag = null; // { animationId, edge, startX, length, tag, badge, end }
  function startEdgeDrag(e, tag, animationId, edge) {
    const anim = findAnim(animationId);
    if (e.button !== 0 || renaming || edgeDrag || !anim) return;
    e.preventDefault();
    e.stopPropagation();
    stopPlaying();
    const badge = document.createElement('span');
    badge.className = 'anim-tag-delta';
    tag.appendChild(badge);
    tag.classList.add('edge-dragging');
    const onMove = ev => previewEdge(ev.clientX, ev.altKey);
    const onUp = (ev) => { const d = edgeDrag; end(); commitEdge(d, ev.clientX, ev.altKey); };
    const onCancel = () => { end(); panel.scheduleRender(); };
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault(); ev.stopPropagation();
      onCancel();
    };
    function end() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      edgeDrag = null;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    edgeDrag = { animationId, edge, startX: e.clientX, length: anim.frames.length, tag, badge, end };
  }
  const edgePlanAt = (d, clientX) => edgeDragPlan(d.length, d.edge, Math.round((clientX - d.startX) / colW));
  function previewEdge(clientX, alt) {
    const d = edgeDrag;
    if (!d) return;
    const plan = edgePlanAt(d, clientX);
    const cut = plan?.op === 'cut' ? plan.to - plan.from + 1 : 0;
    const length = d.length + (plan?.op === 'add' ? plan.count : 0) - cut;
    d.tag.style.width = `${length * colW}px`;
    d.tag.style.marginLeft = d.edge === 'start' && length !== d.length ? `${(d.length - length) * colW}px` : '';
    d.badge.textContent = !plan ? '' : plan.op === 'cut' ? `−${cut}` : `+${plan.count}${alt ? ' copies' : ''}`;
    for (const num of numsRow.children) {
      const column = hits.get(num)?.column;
      num.classList.toggle('edge-cut', !!column && plan?.op === 'cut'
        && columnInRange(column, { animationId: d.animationId, from: plan.from, to: plan.to }));
    }
  }
  function commitEdge(d, clientX, alt) {
    const s = sheet(), anim = d && findAnim(d.animationId);
    const plan = anim && anim.frames.length === d.length ? edgePlanAt(d, clientX) : null;
    if (!s || !plan) { panel.scheduleRender(); return; }
    if (plan.op === 'cut') {
      const result = dispatchLayout('animations.deleteFrames', { sheetId: s.id, animationId: anim.id, from: plan.from, to: plan.to });
      const a = findAnim(anim.id);
      if (result?.ok && a) { range = null; pickEntry(a, d.edge === 'end' ? a.frames.length - 1 : 0); }
    } else {
      const result = withAuto(anim, (sh, a) => dispatchLayout('animations.addFrame', {
        sheetId: sh.id, animationId: a.id, at: plan.at, count: plan.count,
        copyOf: alt ? a.frames[d.edge === 'end' ? a.frames.length - 1 : 0].frameId : null,
      }));
      if (result) setRange(findAnim(anim.id), plan.at, plan.at + plan.count - 1);
    }
    panel.scheduleRender();
  }

  // Inline rename of a tag (sprites.renameAnimation, one undo step). Renders
  // wait while it is open so the field is not rebuilt under the caret.
  let renaming = false;
  let pendingRename = null; // a new animation whose tag opens for renaming
  function startTagRename(tag, anim) {
    cancelNameClick();
    renaming = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'anim-tag-rename';
    input.value = anim.name;
    tag.innerHTML = '';
    tag.appendChild(input);
    for (const type of ['click', 'dblclick', 'pointerdown']) input.addEventListener(type, e => e.stopPropagation());
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      renaming = false;
      const s = sheet(), name = input.value.trim();
      if (commit && s && name && name !== anim.name) dispatch('sprites.renameAnimation', { sheetId: s.id, animationId: anim.id, name });
      panel.scheduleRender();
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.focus();
    input.select?.();
  }
  // The selected animation's tag, renamed inline (the Rename action).
  function renameSelectedTag() {
    const anim = selectedAnim();
    const tag = anim && Array.from(tagsRow.querySelectorAll('.anim-tag')).find(t => t.dataset.animationId === anim.id);
    if (tag) startTagRename(tag, anim);
  }

  // The tag lane's end: a new animation (the New Animation action).
  function buildTagAdd() {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'anim-tag-add';
    add.textContent = '+';
    add.title = 'New animation';
    add.addEventListener('click', (e) => { e.stopPropagation(); newAnimation(); });
    return add;
  }

  function buildCell(s, column, selected, inRange) {
    const cell = document.createElement('div');
    cell.className = 'anim-tl-cell' + (selected ? ' selected' : '') + (inRange ? ' in-range' : '');
    cell.style.width = cell.style.height = `${colW}px`;
    const thumb = document.createElement('canvas');
    thumb.width = thumb.height = colW - 8;
    thumb.className = 'anim-tl-thumb';
    const paint = () => drawFit(thumb, frameBitmap(s, column.frameId));
    paint();
    pixelViews.push({ frameId: column.frameId, paint });
    cell.appendChild(thumb);
    hits.set(cell, { column });
    cell.addEventListener('click', e => pick(column, e.shiftKey));
    return cell;
  }

  // `edge` is 'start' (an animation's first column) or 'end' (after its
  // last): those gaps stay inside their own number so that, where two tags
  // meet, the end of one and the start of the next do not overlap.
  function gapButton(animationId, at, edge) {
    const gap = document.createElement('button');
    gap.type = 'button';
    gap.className = edge ? `anim-tl-gap ${edge}` : 'anim-tl-gap';
    gap.textContent = '+';
    gap.title = 'Insert a blank frame here (Alt: duplicate the frame to the left)';
    gap.addEventListener('click', (e) => onGap(e, animationId, at));
    return gap;
  }

  function buildNum(column, i, last, inRange) {
    const num = document.createElement('div');
    num.className = inRange ? 'anim-tl-num in-range' : 'anim-tl-num';
    num.style.width = `${colW}px`;
    num.textContent = String(i + 1);
    const anim = findAnim(column.animationId), entry = anim?.frames[column.index];
    const dur = document.createElement('span');
    dur.className = 'anim-tl-dur';
    dur.textContent = entry ? entryDurationLabel(anim, entry) : '';
    num.appendChild(dur);
    if (column.linked) {
      const link = document.createElement('span');
      link.className = 'anim-tl-linked';
      link.textContent = '🔗';
      link.title = 'Repeats an earlier frame';
      num.appendChild(link);
    }
    num.appendChild(gapButton(column.animationId, column.index, column.index === 0 ? 'start' : ''));
    if (last) num.appendChild(gapButton(column.animationId, column.index + 1, 'end'));

    // Dragged through attachDragReorder on the numbers row (onFrameDrop).
    num.dataset.dragKey = String(i);
    hits.set(num, { column });
    num.addEventListener('click', (e) => {
      // The selection before a double-click's first click (detail 1; a
      // keyboard click has 0), for the dblclick handler to restore.
      if ((e.detail ?? 1) <= 1) beforeClick = { range, anchor };
      pick(column, e.shiftKey);
    });
    num.title = 'Click to select (Shift: extend), double-click for its duration; '
      + 'drag to move (Alt: copy, Ctrl: insert a linked use)';
    return num;
  }

  function corner(text = '') {
    const c = document.createElement('div');
    c.className = 'anim-tl-corner';
    c.textContent = text;
    return c;
  }

  // One cel: a layer's dot in that frame, or in expanded mode its pixels
  // there (a folder's cel is blank).
  function buildCel(s, node, column, colSelected, inRange) {
    const cel = document.createElement('div');
    const layerSelected = node.type === 'layer' && node.id === selection().layerId;
    cel.className = 'anim-tl-cel' + (colSelected ? ' col-selected' : '') + (colSelected && layerSelected ? ' selected' : '')
      + (inRange ? ' in-range' : '');
    cel.style.width = `${colW}px`;
    hits.set(cel, { column, layer: node.type === 'layer' ? node : null });
    if (node.type === 'layer') {
      const expanded = colW >= EXPAND_AT;
      const view = document.createElement(expanded ? 'canvas' : 'span');
      if (expanded) { view.className = 'anim-tl-cel-thumb'; view.width = view.height = colW - 8; }
      const paint = expanded
        ? () => {
          const f = s.frames.find(fr => fr.id === column.frameId);
          drawFit(view, f ? copyRegion(node.bitmap, f.x, f.y, f.w, f.h) : null);
        }
        : () => { view.className = 'anim-tl-dot ' + (celFilled(s, node, column.frameId) ? 'filled' : 'empty'); };
      paint();
      pixelViews.push({ frameId: column.frameId, paint });
      cel.appendChild(view);
    }
    cel.addEventListener('click', (e) => {
      stopPlaying();
      if (node.type === 'layer') selectTreeNode(s, node);
      pick(column, e.shiftKey);
    });
    return cel;
  }

  function buildLayerLine(s, node, depth, cols, selectedIndex, rangeFlags) {
    const line = document.createElement('div');
    line.className = 'anim-tl-row anim-tl-layer';
    const head = document.createElement('div');
    head.className = 'anim-tl-head';
    head.appendChild(buildLayerRow(node, depth, { thumbs: null, onChange: () => panel.scheduleRender() }));
    line.appendChild(head);
    cols.forEach((column, i) => line.appendChild(buildCel(s, node, column, i === selectedIndex, rangeFlags[i])));
    return line;
  }

  // Every cel and composite cell drawn from pixels, with its repaint.
  let pixelViews = [];

  // A pixel edit (every pointer move of a stroke) only changes the frame on
  // the canvas: repaint its cels, composite cells and the preview in place
  // rather than rebuilding the grid. Structural changes arrive through
  // history, the model or the selection, which render in full.
  let pixelsQueued = false;
  function refreshPixels() {
    if (pixelsQueued) return;
    pixelsQueued = true;
    queueMicrotask(() => {
      pixelsQueued = false;
      if (el.hidden) return;
      flatCache.invalidate();
      const frameId = selection().frameId;
      for (const view of pixelViews) if (view.frameId === frameId) view.paint();
      if (!playing) renderPreview();
    });
  }

  // The header's duration control for the selection: the selected column's
  // entry, or with a range every entry in it (one setFrameDurations step;
  // the control's own rule picks ms or an fps hold step).
  let focusDurationOnRender = false;
  function renderDuration(s, sel) {
    durationBox.innerHTML = '';
    const entry = sel?.anim.frames[sel.column.index];
    if (!entry) { focusDurationOnRender = false; return; }
    const { anim, from, to } = sel;
    const label = document.createElement('span');
    label.textContent = from === to ? 'Frame' : `Frames ${from + 1}–${to + 1}`;
    const send = from === to ? dispatch : (id, args) => dispatch('animations.setFrameDurations', {
      sheetId: s.id, animationId: anim.id, from, to,
      ...(id === 'sprites.setAnimationFrameStep' ? { step: args.step } : { duration: args.duration }),
    });
    const controls = buildFrameDurationInput(s, anim, entry, sel.column.index, send);
    durationBox.append(label, ...controls);
    if (focusDurationOnRender) {
      focusDurationOnRender = false;
      controls[0].focus();
      controls[0].select?.();
    }
  }
  // Double-click a frame number (or the Duration… action): after the click's
  // selection has rendered, the header's duration field takes focus.
  function focusDuration() {
    focusDurationOnRender = true;
    panel.scheduleRender();
  }
  // A double-click's first click selected its column alone; one inside the
  // range that click replaced gets that range back, so the duration input
  // sets the whole range (spec §5) with the double-clicked column selected.
  let beforeClick = null;
  numsRow.addEventListener('dblclick', (e) => {
    const num = e.target?.closest?.('.anim-tl-num');
    if (!num || e.target.closest('.anim-tl-gap')) return;
    const saved = beforeClick, column = hits.get(num)?.column;
    beforeClick = null;
    if (saved?.range && column && columnInRange(column, saved.range)) ({ range, anchor } = saved);
    focusDuration();
  });

  function render() {
    if (host.store.getState().session.activeModeId !== 'animations') { el.hidden = true; stopPlaying(); return; }
    el.hidden = false;
    flatCache.invalidate();
    pixelViews = [];
    const s = sheet(), anim = selectedAnim();
    const cols = columns();
    const selectedIndex = selectedColumn(cols, selection());
    if (range && range.animationId !== anim?.id) range = null;
    if (anchor && anchor.animationId !== anim?.id) anchor = null;
    const sel = selectedRange();
    const multi = sel && sel.to > sel.from ? { animationId: sel.anim.id, from: sel.from, to: sel.to } : null;
    const rangeFlags = cols.map(column => columnInRange(column, multi));
    // Rebuilding drops a focused child (a clicked gap or row button); the
    // grid takes focus back so its keys keep working.
    const hadFocus = grid.contains(document.activeElement);
    tagsRow.innerHTML = ''; numsRow.innerHTML = ''; cellsRow.innerHTML = ''; layersBox.innerHTML = '';
    if (s) {
      tagsRow.appendChild(corner());
      numsRow.appendChild(corner());
      const expanded = colW >= EXPAND_AT;
      if (expanded) cellsRow.appendChild(corner('Frame'));
      for (const span of tagSpans(s)) tagsRow.appendChild(buildTag(span));
      tagsRow.appendChild(buildTagAdd());
      cols.forEach((column, i) => {
        numsRow.appendChild(buildNum(column, i, cols[i + 1]?.animationId !== column.animationId, rangeFlags[i]));
        if (expanded) cellsRow.appendChild(buildCell(s, column, i === selectedIndex, rangeFlags[i]));
      });
      for (const { node, depth } of layerTreeRows(s.layerTree)) {
        layersBox.appendChild(buildLayerLine(s, node, depth, cols, selectedIndex, rangeFlags));
      }
      layersBox.appendChild(buildLayerTreeEnd());
    }
    if (hadFocus && !grid.contains(document.activeElement)) grid.focus({ preventScroll: true });
    renderDuration(s, sel);
    empty.hidden = cols.length > 0;
    empty.textContent = !s ? 'No sprite sheet.' : 'No animation frames yet — press + above to add an animation.';

    const hasFrames = !!anim?.frames.length;
    if (playing && playbackStale(anim)) stopPlaying();
    for (const b of [btnPlay, btnFirst, btnLast]) b.disabled = !hasFrames;
    btnPrev.disabled = btnNext.disabled = !cols.length;
    const auto = anim?.layout === 'auto';
    btnAdd.disabled = btnDuplicate.disabled = !auto;
    btnAdd.title = auto ? 'Add a blank frame after this one' : NEEDS_AUTO;
    btnDuplicate.title = auto ? 'Duplicate this frame' : NEEDS_AUTO;
    btnDuplicate.disabled = !auto || selectedIndex === -1;
    btnRemove.disabled = selectedIndex === -1 || cols[selectedIndex].animationId !== anim?.id;
    btnAddLayer.disabled = btnAddFolder.disabled = btnDeleteNode.disabled = !s;
    updatePlayhead();
    if (!playing) renderPreview();
    const toRename = pendingRename && findAnim(pendingRename);
    pendingRename = null;
    const newTag = toRename && Array.from(tagsRow.querySelectorAll('.anim-tag')).find(t => t.dataset.animationId === toRename.id);
    if (newTag) startTagRename(newTag, toRename);
  }

  // A layer-name click selects at once; rebuilding its row before the grace
  // window ends would lose a following double-click (rename). The window's
  // end renders.
  function renderUnlessNameClickPending() {
    if (!nameClickPending() && !renaming && !edgeDrag) render();
  }

  const panel = mountStorePanel(host.store, [
    s => s.project.model,
    s => s.session.activeModeId,
    s => s.session.activeDocument,
    s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; },
  ], renderUnlessNameClickPending, { onDispose: stopPlaying });
  const disposeHistory = host.history.subscribe(() => panel.scheduleRender());
  const disposePixels = host.store.subscribe(s => s.workspace.pixelRevision, refreshPixels);

  // ---- actions and shortcuts (timeline-actions.js) ----
  const selectedLayerNode = () => { const s = sheet(), id = selection().layerId; return s && id ? findLayer(s.layerTree, id) : null; };
  const frameUses = frameId => (sheet()?.animations ?? []).reduce((n, a) => n + a.frames.filter(e => e.frameId === frameId).length, 0);
  const timeline = {
    active: () => host.store.getState().session.activeModeId === 'animations',
    state: () => {
      const range = selectedRange();
      return { sheet: !!sheet(), anim: selectedAnim(), range, layer: selectedLayerNode(), linked: !!range && frameUses(range.column.frameId) > 1, playing };
    },
    togglePlay: () => (playing ? stopPlaying() : startPlaying()),
    step: stepInAnimation,
    focusDuration, insertBlank, insertLinked, deleteFrames, clearCel, setDirection, setColor, pickColor, toggleLoop,
    duplicateAnimation, deleteAnimation, newAnimation, newFromFrames,
    duplicate: duplicateFrames, unlink: unlinkFrame, reverse: reverseFrames, renameTag: renameSelectedTag,
    autoLayout: autoLayoutSelected, makeManual: makeManualSelected,
  };
  defineTimelineActions(timeline);
  const disposeShortcuts = attachTimelineShortcuts(timeline);

  return {
    ...panel,
    dispose() {
      disposeHistory(); disposePixels(); disposeShortcuts(); disposePlaybackStop(); disposeDrag(); disposeLayerDrop(); disposeMenu(); resizer.dispose(); panel.dispose();
    },
  };
}
