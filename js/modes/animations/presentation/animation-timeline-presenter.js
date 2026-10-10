// js/modes/animations/presentation/animation-timeline-presenter.js
// The Animations workbench's timeline dock: the sheet's layer tree and its
// frame sequence in one grid. Header: playback (first, previous, play/stop,
// next, last, loop), + Frame / Duplicate / remove for the selected column,
// and add layer / add folder / delete. Grid: tags, frame numbers, a row of
// composite thumbnails, then one row per visible layer-tree node -- the
// shared layer row (layer-tree.js) and one cel per column, a filled dot
// where that layer has pixels in that frame. Clicking a cel selects its
// frame and layer; a tag selects its animation. Within an animation's tag,
// `+` between columns inserts a blank frame (Alt: a copy of the frame to its
// left), dragging a frame number reorders (Ctrl: inserts a linked use), and
// Delete / Left / Right on the focused grid remove or step the selected
// column. A manual animation is offered an auto-layout first. Playback plays
// the selected animation into the Preview panel.
import { flattenSheetLayers } from '../../../core/model.js';
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
import { layerTreeRows, buildLayerRow, attachLayerTreeDrop, selectTreeNode, addSheetLayer, addSheetGroup, deleteSheetNode, nameClickPending } from '../../../components/panels/layer-tree.js';
import { timelineColumns, tagSpans, selectedColumn, celFilled } from '../application/timeline-model.js';

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
  sizeInput.addEventListener('input', () => {
    colW = Math.max(COL_MIN, Math.min(COL_MAX, Number(sizeInput.value) || COL_DEFAULT));
    try { localStorage.setItem(COL_KEY, String(colW)); } catch { /* per-browser convenience only */ }
    panel.scheduleRender();
  });
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
  attachLayerTreeDrop(layersBox, { emptyDropsToRoot: false });
  const empty = document.createElement('div');
  empty.className = 'anim-tl-empty';
  grid.append(tagsRow, numsRow, cellsRow, layersBox, empty);

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

  // ---- playback (drives the Preview panel only) ----
  let playing = false, rafId = null, lastTs = null, acc = 0, position = 0;
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
    setPlayButton();
    updatePlayhead();
  }
  function tick(ts) {
    const anim = selectedAnim();
    if (!playing || playbackStale(anim)) { stopPlaying(); return; }
    if (lastTs == null) lastTs = ts;
    const result = advancePlayback(anim, position, acc, ts - lastTs, loopCheckbox.checked);
    lastTs = ts;
    position = result.position; acc = result.acc;
    if (result.stopped) stopPlaying();
    renderPreview(); updatePlayhead();
    if (playing) rafId = requestAnimationFrame(tick);
  }
  function startPlaying() {
    const anim = selectedAnim();
    if (!anim?.frames.length) return;
    playing = true;
    playingId = anim.id;
    position = Math.max(0, current()?.animationId === anim.id ? current().index : 0);
    acc = 0; lastTs = null;
    setPlayButton();
    updatePlayhead();
    rafId = requestAnimationFrame(tick);
  }
  btnPlay.addEventListener('click', () => { if (playing) stopPlaying(); else startPlaying(); });

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
    select(cols[index === -1 ? 0 : Math.max(0, Math.min(cols.length - 1, index + delta))]);
  }
  function edge(last) {
    stopPlaying();
    const anim = selectedAnim();
    if (!anim?.frames.length) return;
    const index = last ? anim.frames.length - 1 : 0;
    select({ animationId: anim.id, index, frameId: anim.frames[index].frameId });
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

  // An offer -- { mark } -- once the animation is auto-laid-out, else false.
  // `mark` is the history position before an accepted conversion (null when
  // it already was auto), which settleOffer folds the gesture into. Frames of
  // different sizes or pivots are re-framed at the suggested (largest) size
  // only after a second, explicit yes, since that can crop pixels.
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
    let result = dispatchLayout('animations.autoLayout', { sheetId: s.id, animationId: anim.id });
    if (result?.needsSize) {
      const { w, h } = result.suggested;
      if (!confirmOrAuto(`"${anim.name}" has frames of different sizes or pivots. Lay it out at ${w}×${h}? `
        + 'Each frame is re-framed around its pivot; pixels outside the new frame are cropped.')) {
        if (forReorder) declinedForReorder.add(anim.id);
        return false;
      }
      result = dispatchLayout('animations.autoLayout', { sheetId: s.id, animationId: anim.id, size: result.suggested });
    }
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

  // Inserts a frame at entry `at` of an auto animation -- a copy of copyOf,
  // else blank -- and selects it. True on success.
  function insertAt(s, animationId, at, copyOf) {
    stopPlaying(); // a structural change; playback would index stale entries
    const result = dispatchLayout('animations.addFrame', { sheetId: s.id, animationId, at, copyOf });
    const anim = findAnim(animationId);
    if (result?.ok && anim?.frames[at]) select({ animationId, index: at, frameId: anim.frames[at].frameId });
    return !!result?.ok;
  }

  function insert(copy) {
    const s = sheet(), anim = selectedAnim();
    if (!s || anim?.layout !== 'auto') return;
    const column = current()?.animationId === anim.id ? current() : null;
    const at = column ? column.index + 1 : anim.frames.length;
    insertAt(s, anim.id, at, copy ? column?.frameId ?? null : null);
  }
  btnAdd.addEventListener('click', () => insert(false));
  btnDuplicate.addEventListener('click', () => insert(true));

  // A `+` gap: a blank frame at `at`; Alt copies the frame to its left.
  function onGap(e, animationId, at) {
    e.stopPropagation();
    const s = sheet(), anim = findAnim(animationId);
    if (!s || !anim) return;
    stopPlaying();
    const offer = ensureAuto(s, anim);
    if (!offer) return;
    settleOffer(offer, insertAt(s, animationId, at, e.altKey ? anim.frames[at - 1]?.frameId ?? null : null));
  }

  // A frame number dropped before/after `target` (same animation only):
  // reorder, or with Ctrl a linked use. A manual animation declining the
  // auto-layout offer still reorders; it cannot take a linked use.
  function dropColumn(from, target, before, link) {
    const s = sheet(), anim = findAnim(target.animationId);
    if (!s || !anim || from.animationId !== target.animationId) return;
    stopPlaying();
    const at = target.index + (before ? 0 : 1);
    if (link) {
      const offer = ensureAuto(s, anim);
      if (!offer) return;
      const result = dispatchLayout('animations.linkFrame', { sheetId: s.id, animationId: anim.id, at, frameId: from.frameId });
      settleOffer(offer, !!result?.ok);
      if (result?.ok) select({ animationId: anim.id, index: at, frameId: from.frameId });
      return;
    }
    const to = from.index < at ? at - 1 : at; // removal shifts later entries left
    if (to === from.index) return;
    const offer = ensureAuto(s, anim, { forReorder: true });
    const result = offer
      ? dispatchLayout('animations.moveFrame', { sheetId: s.id, animationId: anim.id, from: from.index, to })
      : dispatch('sprites.reorderAnimationFrame', { sheetId: s.id, animationId: anim.id, fromIndex: from.index, toIndex: to });
    settleOffer(offer, result?.ok !== false);
    if (result?.ok !== false) select({ animationId: anim.id, index: to, frameId: from.frameId });
  }

  function removeSelected() {
    const s = sheet(), anim = selectedAnim(), column = current();
    if (!s || !anim || column?.animationId !== anim.id) return;
    stopPlaying(); // a structural change; playback would index stale entries
    const args = { sheetId: s.id, animationId: anim.id, index: column.index };
    const result = anim.layout === 'auto' ? dispatchLayout('animations.deleteFrame', args) : dispatch('sprites.removeAnimationFrame', args);
    if (!result?.ok) return;
    const next = Math.min(column.index, anim.frames.length - 1);
    if (next >= 0) select({ animationId: anim.id, index: next, frameId: anim.frames[next].frameId });
  }
  btnRemove.addEventListener('click', removeSelected);

  // Keys on the focused grid itself: never from a control inside it (a
  // rename or duration input, a layer row's buttons).
  grid.tabIndex = 0;
  grid.addEventListener('keydown', (e) => {
    if (e.target !== grid) return;
    if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); removeSelected(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });

  // ---- render ----
  function buildTag(span) {
    const tag = document.createElement('div');
    tag.className = 'anim-tag';
    tag.textContent = span.name;
    tag.title = span.name;
    tag.style.width = `${span.length * colW}px`;
    tag.addEventListener('click', () => {
      stopPlaying();
      const anim = sheet()?.animations.find(a => a.id === span.animationId);
      if (anim) select({ animationId: anim.id, index: 0, frameId: anim.frames[0].frameId });
    });
    return tag;
  }

  function buildCell(s, column, selected) {
    const cell = document.createElement('div');
    cell.className = selected ? 'anim-tl-cell selected' : 'anim-tl-cell';
    cell.style.width = cell.style.height = `${colW}px`;
    const thumb = document.createElement('canvas');
    thumb.width = thumb.height = colW - 8;
    thumb.className = 'anim-tl-thumb';
    const paint = () => drawFit(thumb, frameBitmap(s, column.frameId));
    paint();
    pixelViews.push({ frameId: column.frameId, paint });
    cell.appendChild(thumb);
    cell.addEventListener('click', () => { stopPlaying(); select(column); });
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

  // The column being dragged by its number, while a drag is on.
  let dragColumn = null;
  const dropBefore = (num, e) => {
    const rect = num.getBoundingClientRect();
    return (e.clientX - rect.left) < rect.width / 2;
  };

  function buildNum(column, i, last) {
    const num = document.createElement('div');
    num.className = 'anim-tl-num';
    num.style.width = `${colW}px`;
    num.textContent = String(i + 1);
    if (column.linked) {
      const link = document.createElement('span');
      link.className = 'anim-tl-linked';
      link.textContent = '🔗';
      link.title = 'Repeats an earlier frame';
      num.appendChild(link);
    }
    num.appendChild(gapButton(column.animationId, column.index, column.index === 0 ? 'start' : ''));
    if (last) num.appendChild(gapButton(column.animationId, column.index + 1, 'end'));

    num.addEventListener('click', () => { stopPlaying(); select(column); });
    num.draggable = true;
    num.title = 'Click to select; drag to reorder (Ctrl: insert a linked use)';
    num.addEventListener('dragstart', (e) => {
      dragColumn = column;
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', String(column.index));
    });
    num.addEventListener('dragend', () => { dragColumn = null; });
    num.addEventListener('dragover', (e) => {
      if (dragColumn?.animationId !== column.animationId) return; // not across tags
      e.preventDefault();
      e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
      const before = dropBefore(num, e);
      num.classList.toggle('drag-before', before);
      num.classList.toggle('drag-after', !before);
    });
    num.addEventListener('dragleave', () => num.classList.remove('drag-before', 'drag-after'));
    num.addEventListener('drop', (e) => {
      num.classList.remove('drag-before', 'drag-after');
      const from = dragColumn;
      dragColumn = null;
      if (from?.animationId !== column.animationId) return;
      e.preventDefault();
      dropColumn(from, column, dropBefore(num, e), e.ctrlKey);
    });
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
  function buildCel(s, node, column, colSelected) {
    const cel = document.createElement('div');
    const layerSelected = node.type === 'layer' && node.id === selection().layerId;
    cel.className = 'anim-tl-cel' + (colSelected ? ' col-selected' : '') + (colSelected && layerSelected ? ' selected' : '');
    cel.style.width = `${colW}px`;
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
    cel.addEventListener('click', () => {
      stopPlaying();
      if (node.type === 'layer') selectTreeNode(s, node);
      select(column);
    });
    return cel;
  }

  function buildLayerLine(s, node, depth, cols, selectedIndex) {
    const line = document.createElement('div');
    line.className = 'anim-tl-row anim-tl-layer';
    const head = document.createElement('div');
    head.className = 'anim-tl-head';
    head.appendChild(buildLayerRow(node, depth, { thumbs: null, onChange: () => panel.scheduleRender() }));
    line.appendChild(head);
    cols.forEach((column, i) => line.appendChild(buildCel(s, node, column, i === selectedIndex)));
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

  function render() {
    if (host.store.getState().session.activeModeId !== 'animations') { el.hidden = true; stopPlaying(); return; }
    el.hidden = false;
    flatCache.invalidate();
    pixelViews = [];
    const s = sheet(), anim = selectedAnim();
    const cols = columns();
    const selectedIndex = selectedColumn(cols, selection());
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
      cols.forEach((column, i) => {
        numsRow.appendChild(buildNum(column, i, cols[i + 1]?.animationId !== column.animationId));
        if (expanded) cellsRow.appendChild(buildCell(s, column, i === selectedIndex));
      });
      for (const { node, depth } of layerTreeRows(s.layerTree)) layersBox.appendChild(buildLayerLine(s, node, depth, cols, selectedIndex));
    }
    if (hadFocus && !grid.contains(document.activeElement)) grid.focus({ preventScroll: true });
    durationBox.innerHTML = '';
    const col = cols[selectedIndex];
    const colAnim = col && s?.animations.find(a => a.id === col.animationId);
    if (colAnim?.frames[col.index]) {
      const label = document.createElement('span');
      label.textContent = 'Frame';
      durationBox.append(label, ...buildFrameDurationInput(s, colAnim, colAnim.frames[col.index], col.index, dispatch));
    }
    empty.hidden = cols.length > 0;
    empty.textContent = !s ? 'No sprite sheet.' : 'No animation frames yet — create an animation in the Animations panel.';

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
  }

  // A layer-name click selects at once; rebuilding its row before the grace
  // window ends would lose a following double-click (rename). The window's
  // end renders.
  function renderUnlessNameClickPending() {
    if (!nameClickPending()) render();
  }

  const panel = mountStorePanel(host.store, [
    s => s.project.model,
    s => s.session.activeModeId,
    s => s.session.activeDocument,
    s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; },
  ], renderUnlessNameClickPending, { onDispose: stopPlaying });
  const disposeHistory = host.history.subscribe(() => panel.scheduleRender());
  const disposePixels = host.store.subscribe(s => s.workspace.pixelRevision, refreshPixels);
  return { ...panel, dispose() { disposeHistory(); disposePixels(); resizer.dispose(); panel.dispose(); } };
}
