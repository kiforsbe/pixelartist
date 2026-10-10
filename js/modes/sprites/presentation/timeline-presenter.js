// Animation timeline dock: header (animation picker + New/Rename/Delete/Loop
// + "Add selected frame" + playback transport) and a horizontal row of
// frame cells (thumbnail + duration + remove, drag to reorder, click to
// scrub/select/open). The live playhead preview itself renders in the
// right-hand Preview panel (components/panels/preview-panel.js) -- this module still owns
// all playback/scrub timing (position, rAF loop) and just pushes the current
// frame's bitmap over via setPreviewBitmap() on every tick.
//
// Mirrors frames-panel.js's split: a single mount function builds the DOM
// once and re-renders on the app-wide events that can change what it shows.
// Structural edits (add/remove/reorder animation-frame entries, duration
// edits, and new/rename/delete animation) all go through dispatched Command
// Handlers (registered in contributions.js) so they're undoable and this
// presentation-layer file never touches state.commands or core/model.js
// mutators directly.

import { flattenSheetLayers } from '../../../core/model.js';
import { copyRegion } from '../../../core/pixels.js';
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet, currentContextLayers } from '../../../host/document-helpers.js';
import { confirmOrAuto } from '../../../platform/browser/autotest.js';
import { activeFloating } from '../../../components/canvas/float-session.js';
import { dispatchLayout } from '../../../components/layout-dispatch.js';
import { advancePlayback } from '../../../domain/sprites/playback.js';
import { setPreviewBitmap } from '../../../components/panels/preview-panel.js';
import { createRasterCache } from '../../../components/canvas/raster-cache.js';
import { drawFit } from '../../../components/canvas/draw-fit.js';
import { mountStorePanel } from '../../../components/panel-mount.js';
import { buildFrameDurationInput } from '../../../components/panels/frame-duration-input.js';
import { createDockResizer, workspaceDockMax, migratePreference } from '../../../components/dock-resizer.js';

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it directly -- this file lives under presentation/, and
// tests/architecture.test.mjs bans presentation-layer code from importing
// anything under application/commands/.
function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

// Thumbnail size tracks the dock's height (see the resize handle in
// mountTimeline) so a taller panel actually redraws sharper thumbnails
// instead of just CSS-stretching a fixed 64px bitmap.
let THUMB_SIZE = 64;
const THUMB_MIN = 32, THUMB_MAX = 200;
// Vertical space every cell spends on things that AREN'T the thumbnail --
// strip padding + cell padding/gap + the duration/step control row --
// subtracted from the strip's available height to size the thumbnail.
// Approximate (not measured live) since the controls row's own height
// depends on THUMB_SIZE only through the cell's width, not its height.
const THUMB_CHROME = 44;
const DOCK_MIN = 100;
const DOCK_HEIGHT_KEY = 'dock.sprites.timeline.height';
const LEGACY_DOCK_HEIGHT_KEY = 'timelineDockHeight'; // the old inline handle's key
const SPEEDS = [0.25, 0.5, 1, 2];

// ------------------------------------------------------------- public API

export function mountTimeline(el) {
  el.innerHTML = '';

  // ---- header ----
  const header = document.createElement('div');
  header.className = 'timeline-header';

  const animSelect = document.createElement('select');
  const btnNewAnim = document.createElement('button'); btnNewAnim.type = 'button'; btnNewAnim.className = 'btn-icon-sm'; btnNewAnim.textContent = '➕'; btnNewAnim.title = 'New animation';
  const btnRenameAnim = document.createElement('button'); btnRenameAnim.type = 'button'; btnRenameAnim.className = 'btn-icon-sm'; btnRenameAnim.textContent = '✎'; btnRenameAnim.title = 'Rename animation';
  const btnDeleteAnim = document.createElement('button'); btnDeleteAnim.type = 'button'; btnDeleteAnim.className = 'btn-icon-sm'; btnDeleteAnim.textContent = '🗑'; btnDeleteAnim.title = 'Delete animation';
  const previewLoopCheckbox = document.createElement('input');
  previewLoopCheckbox.type = 'checkbox'; previewLoopCheckbox.checked = true;
  const previewLoopLabel = document.createElement('label'); previewLoopLabel.className = 'timeline-loop';
  previewLoopLabel.title = "Loops the preview playback only -- doesn't affect the exported animation's Loop flag (set that in the Animation panel).";
  previewLoopLabel.append(previewLoopCheckbox, document.createTextNode('Preview Loop'));
  const btnAddFrame = document.createElement('button'); btnAddFrame.type = 'button'; btnAddFrame.textContent = 'Add selected frame';
  // Visible only for an auto-laid-out animation.
  const btnMakeManual = document.createElement('button'); btnMakeManual.type = 'button'; btnMakeManual.textContent = 'Make manual'; btnMakeManual.title = 'Stop auto-laying-out this animation; its frames stay where they are';
  const btnEditInAnimations = document.createElement('button'); btnEditInAnimations.type = 'button'; btnEditInAnimations.textContent = 'Edit in Animations'; btnEditInAnimations.title = 'Open this animation in the Animations workbench';

  const btnFirst = document.createElement('button'); btnFirst.type = 'button'; btnFirst.className = 'btn-icon-sm'; btnFirst.textContent = '⏮';
  const btnPlay = document.createElement('button'); btnPlay.type = 'button'; btnPlay.className = 'btn-icon-sm'; btnPlay.textContent = '▶';
  const btnLast = document.createElement('button'); btnLast.type = 'button'; btnLast.className = 'btn-icon-sm'; btnLast.textContent = '⏭';
  const speedSelect = document.createElement('select');
  for (const s of SPEEDS) {
    const opt = document.createElement('option');
    opt.value = String(s); opt.textContent = `${s}x`;
    if (s === 1) opt.selected = true;
    speedSelect.appendChild(opt);
  }

  header.append(
    animSelect, btnNewAnim, btnRenameAnim, btnDeleteAnim, previewLoopLabel, btnAddFrame, btnMakeManual, btnEditInAnimations,
    btnFirst, btnPlay, btnLast, speedSelect,
  );

  const strip = document.createElement('div');
  strip.className = 'timeline-strip';

  const main = document.createElement('div');
  main.className = 'timeline-main';
  main.append(header, strip);

  // ---- dock resize (height only -- width already spans the fixed gap
  // between the tool palette and side panels). The size from the old inline
  // handle is carried over once as this dock's starting size. A fit sizes
  // the strip for the largest thumbnails. ----
  const prefs = getEditorHost().preferences;
  migratePreference(prefs, LEGACY_DOCK_HEIGHT_KEY, DOCK_HEIGHT_KEY);
  let resizeRaf = null;
  const resizer = createDockResizer({
    target: el, edge: 'top', min: DOCK_MIN, max: () => workspaceDockMax(el),
    measureContent: () => (resizer.element.offsetHeight || 0) + (header.offsetHeight || 0) + THUMB_MAX + THUMB_CHROME,
    prefs, prefKey: DOCK_HEIGHT_KEY, label: 'Resize the timeline panel',
    onResize: () => {
      if (resizeRaf != null) return;
      resizeRaf = requestAnimationFrame(() => { resizeRaf = null; render(); });
    },
  });

  el.append(resizer.element, main);

  // Derives THUMB_SIZE from however much vertical room the strip actually
  // has right now -- called at the top of every render() so both the
  // dock-resize drag and ordinary content changes keep it current.
  function updateThumbSize() {
    const available = strip.clientHeight - THUMB_CHROME;
    THUMB_SIZE = Math.max(THUMB_MIN, Math.min(THUMB_MAX, Math.round(available)));
  }

  // ---- player state ----
  let playing = false;
  let rafId = null;
  let lastTs = null;
  let acc = 0;
  let position = 0; // index into currentAnim().frames
  let previewLoop = true; // session-only UI state -- never read from/written to anim or state

  // Cached flatten of the active sheet; invalidated at the top of every full
  // render() (triggered by project/history/view/selection) and reused by the
  // rAF tick loop / scrub clicks that happen between full renders, so playback
  // doesn't re-flatten the whole sheet every frame.
  const flatCache = createRasterCache();
  function getFlat(sheet) {
    return flatCache.getBitmap(sheet, s => flattenSheetLayers(currentContextLayers(), s.width, s.height, activeFloating(), s.id));
  }
  function invalidateFlat() { flatCache.invalidate(); }

  function currentSelection() {
    const sheet = activeSheet('sprite');
    return sheet ? (getEditorHost().selections.get(sheetDocument(sheet)) ?? {}) : {};
  }
  function setSelection(patch) {
    const sheet = activeSheet('sprite');
    if (sheet) getEditorHost().selections.set({ ...currentSelection(), ...patch }, sheetDocument(sheet));
  }

  function currentAnim() {
    const sheet = activeSheet('sprite');
    if (!sheet) return null;
    return sheet.animations.find(a => a.id === currentSelection().animationId) ?? null;
  }

  function stopPlaying() {
    playing = false;
    btnPlay.textContent = '▶';
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    lastTs = null;
  }

  // Only touches the Preview panel's canvas while an animation is actually
  // selected -- with none selected, previewpanel.js's own context render
  // (frame/tile selection) owns it, and clearing here would just fight that.
  function renderPreview() {
    const anim = currentAnim();
    if (!anim) return;
    const sheet = activeSheet('sprite');
    if (!sheet || !anim.frames.length) { setPreviewBitmap(null); return; }
    const entry = anim.frames[Math.max(0, Math.min(position, anim.frames.length - 1))];
    const frame = sheet.frames.find(f => f.id === entry.frameId);
    if (!frame) { setPreviewBitmap(null); return; }
    const region = copyRegion(getFlat(sheet), frame.x, frame.y, frame.w, frame.h);
    setPreviewBitmap(region);
  }

  function updatePlayheadHighlight() {
    Array.from(strip.children).forEach((cell, i) => cell.classList.toggle('playhead', i === position));
  }

  function scrubTo(index) {
    stopPlaying();
    const anim = currentAnim();
    if (!anim || !anim.frames.length) return;
    position = Math.max(0, Math.min(anim.frames.length - 1, index));
    acc = 0;
    renderPreview();
    updatePlayheadHighlight();
  }

  function tick(ts) {
    if (!playing) return;
    const anim = currentAnim();
    if (!anim || !anim.frames.length) { stopPlaying(); return; }
    if (lastTs == null) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;
    const speed = parseFloat(speedSelect.value) || 1;
    const result = advancePlayback(anim, position, acc, dt * speed, previewLoop);
    position = result.position;
    acc = result.acc;
    if (result.stopped) stopPlaying();
    renderPreview();
    updatePlayheadHighlight();
    if (playing) rafId = requestAnimationFrame(tick);
  }

  function startPlaying() {
    const anim = currentAnim();
    if (!anim || !anim.frames.length) return;
    playing = true;
    btnPlay.textContent = '⏸';
    lastTs = null;
    acc = 0;
    rafId = requestAnimationFrame(tick);
  }

  btnPlay.addEventListener('click', () => { if (playing) stopPlaying(); else startPlaying(); });
  btnFirst.addEventListener('click', () => scrubTo(0));
  btnLast.addEventListener('click', () => { const a = currentAnim(); if (a && a.frames.length) scrubTo(a.frames.length - 1); });

  // ---- header controls ----
  animSelect.addEventListener('change', () => {
    stopPlaying();
    position = 0; acc = 0;
    setSelection({ animationId: animSelect.value || null });
    render();
  });

  btnNewAnim.addEventListener('click', () => {
    const sheet = activeSheet('sprite');
    if (!sheet) return;
    dispatch('sprites.newAnimation', { sheetId: sheet.id });
  });

  btnRenameAnim.addEventListener('click', () => {
    const sheet = activeSheet('sprite');
    const anim = currentAnim();
    if (!sheet || !anim) return;
    const name = prompt('Animation name', anim.name);
    if (name == null) return;
    const v = name.trim();
    if (v) dispatch('sprites.renameAnimation', { sheetId: sheet.id, animationId: anim.id, name: v });
  });

  btnDeleteAnim.addEventListener('click', () => {
    const sheet = activeSheet('sprite');
    const anim = currentAnim();
    if (!sheet || !anim) return;
    const message = anim.layout === 'auto' ? `Delete animation "${anim.name}" and its frames?` : `Delete animation "${anim.name}"?`;
    if (!confirmOrAuto(message)) return;
    stopPlaying();
    // An auto delete clears and moves pixels (dispatchLayout settles floats).
    dispatchLayout('animations.delete', { sheetId: sheet.id, animationId: anim.id });
  });

  previewLoopCheckbox.addEventListener('change', () => {
    previewLoop = previewLoopCheckbox.checked;
  });

  btnAddFrame.addEventListener('click', () => {
    const sheet = activeSheet('sprite');
    const anim = currentAnim();
    const frameId = currentSelection().frameId ?? null;
    if (!sheet || !anim || !frameId) return;
    dispatch('sprites.addAnimationFrame', { sheetId: sheet.id, animationId: anim.id, frameId });
  });

  btnMakeManual.addEventListener('click', () => {
    const sheet = activeSheet('sprite');
    const anim = currentAnim();
    if (!sheet || anim?.layout !== 'auto') return;
    dispatch('animations.makeManual', { sheetId: sheet.id, animationId: anim.id });
  });

  // The Animations workbench opens on the selected frame's column when the
  // animation uses it, else on its first column.
  btnEditInAnimations.addEventListener('click', () => {
    const sheet = activeSheet('sprite');
    const anim = currentAnim();
    if (!sheet || !anim) return;
    stopPlaying();
    const frameId = currentSelection().frameId ?? null;
    const used = anim.frames.findIndex(entry => entry.frameId === frameId);
    const entryIndex = used === -1 ? 0 : used;
    getEditorHost().selections.patch({ frameId: anim.frames[entryIndex]?.frameId ?? null, entryIndex }, sheetDocument(sheet));
    getEditorHost().activateMode('animations');
  });

  // ---- strip cell ----
  function buildCell(anim, entry, index, sheet) {
    const cell = document.createElement('div');
    cell.className = 'timeline-cell';
    cell.draggable = true;
    cell.style.width = THUMB_SIZE + 'px';

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = THUMB_SIZE; thumbCanvas.height = THUMB_SIZE;
    thumbCanvas.style.width = THUMB_SIZE + 'px';
    thumbCanvas.style.height = THUMB_SIZE + 'px';
    thumbCanvas.className = 'timeline-thumb';
    const frame = sheet.frames.find(f => f.id === entry.frameId);
    if (frame) drawFit(thumbCanvas, copyRegion(getFlat(sheet), frame.x, frame.y, frame.w, frame.h));

    const controls = document.createElement('div');
    controls.className = 'timeline-cell-controls';

    controls.append(...buildFrameDurationInput(sheet, anim, entry, index, dispatch));

    const btnRemove = document.createElement('button');
    btnRemove.type = 'button'; btnRemove.textContent = '✕'; btnRemove.className = 'timeline-remove';
    btnRemove.addEventListener('click', (e) => {
      e.stopPropagation();
      stopPlaying(); // a structural change; playback would index stale entries
      if (anim.layout === 'auto') dispatchLayout('animations.deleteFrame', { sheetId: sheet.id, animationId: anim.id, index });
      else dispatch('sprites.removeAnimationFrame', { sheetId: sheet.id, animationId: anim.id, index });
    });
    controls.append(btnRemove);

    cell.append(thumbCanvas, controls);

    cell.addEventListener('click', () => {
      scrubTo(index);
      // Clicking a cell also makes it the app-wide "current frame" (the
      // same selection the sprite sheet/Frames panel use), not just the
      // preview-playhead position -- so e.g. the Frames panel and the
      // sprite-sheet highlight follow along with a single click. It also
      // opens the frame editor directly on that frame (previously required
      // a double-click) -- one click both selects and jumps in.
      if (frame && currentSelection().frameId !== frame.id) {
        setSelection({ frameId: frame.id });
      }
      if (frame) {
        getEditorHost().selections.patch({ editingFrameId: frame.id }, sheetDocument(sheet));
        getEditorHost().store.updateSession({ activeViewId: 'sprites.frame' }, 'view');
      }
    });

    cell.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(index));
      e.dataTransfer.effectAllowed = 'move';
    });
    cell.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = cell.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      cell.classList.toggle('drag-before', before);
      cell.classList.toggle('drag-after', !before);
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-before', 'drag-after'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      const before = cell.classList.contains('drag-before');
      cell.classList.remove('drag-before', 'drag-after');
      const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (!Number.isFinite(fromIndex)) return;
      let toIndex = index + (before ? 0 : 1);
      if (fromIndex < toIndex) toIndex -= 1; // removal shifts everything after it left by one
      if (toIndex === fromIndex) return;
      stopPlaying();
      if (anim.layout === 'auto') dispatchLayout('animations.moveFrame', { sheetId: sheet.id, animationId: anim.id, from: fromIndex, to: toIndex });
      else dispatch('sprites.reorderAnimationFrame', { sheetId: sheet.id, animationId: anim.id, fromIndex, toIndex });
    });

    return cell;
  }

  // ---- full render ----
  function renderAnimSelect(sheet) {
    animSelect.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(none)';
    animSelect.appendChild(noneOpt);
    if (!sheet) return;
    for (const a of sheet.animations) {
      const opt = document.createElement('option');
      opt.value = a.id; opt.textContent = a.name;
      animSelect.appendChild(opt);
    }
    // Only clear a STALE id (pointing at a deleted animation) -- never force
    // a selection just because it's null, or "(none)" could never stick:
    // render() runs after every project/selection event, so forcing a pick
    // here would snap back to animations[0] on the very next render.
    const selectedAnimationId = currentSelection().animationId ?? null;
    if (selectedAnimationId && !sheet.animations.find(a => a.id === selectedAnimationId))
      setSelection({ animationId: null });
    animSelect.value = currentSelection().animationId ?? '';
  }

  function render() {
    if (getEditorHost().store.getState().session.activeModeId !== 'sprites') { el.hidden = true; stopPlaying(); return; }
    el.hidden = false;
    updateThumbSize();
    invalidateFlat();
    const sheet = activeSheet('sprite');
    renderAnimSelect(sheet);
    const anim = currentAnim();

    btnRenameAnim.disabled = !anim;
    btnDeleteAnim.disabled = !anim;
    btnAddFrame.disabled = !anim || !currentSelection().frameId || anim.layout === 'auto';
    btnMakeManual.hidden = anim?.layout !== 'auto';
    btnEditInAnimations.disabled = !anim;
    const hasFrames = !!anim && anim.frames.length > 0;
    btnPlay.disabled = !hasFrames;
    btnFirst.disabled = !hasFrames;
    btnLast.disabled = !hasFrames;

    strip.innerHTML = '';
    if (sheet && anim) {
      if (position >= anim.frames.length) position = Math.max(0, anim.frames.length - 1);
      anim.frames.forEach((entry, index) => strip.appendChild(buildCell(anim, entry, index, sheet)));
    } else {
      position = 0;
    }
    updatePlayheadHighlight();
    renderPreview();
  }

  const host = getEditorHost();
  const panel = mountStorePanel(host.store, [
    s => s.project.model,
    s => s.session.activeModeId,
    s => s.session.activeViewId,
    s => s.session.activeDocument,
    s => s.workspace.pixelRevision,
    s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; },
  ], render, { onDispose: stopPlaying });
  const disposeHistory = host.history.subscribe(() => panel.scheduleRender());
  return { ...panel, dispose() { disposeHistory(); resizer.dispose(); panel.dispose(); } };
}
