// Animation timeline dock: header (animation picker + New/Rename/Delete/Loop
// + "Add selected frame" + playback transport) and a horizontal strip of
// frame cells (thumbnail + duration + remove, drag to reorder, click to
// scrub/select/open). The live playhead preview itself renders in the
// right-hand Preview panel (js/ui/previewpanel.js) -- this module still owns
// all playback/scrub timing (position, rAF loop) and just pushes the current
// frame's bitmap over via setPreviewBitmap() on every tick.
//
// Mirrors frames.js's split: a single mount function builds the DOM once and
// re-renders on the app-wide events that can change what it shows. Structural
// edits (add/remove/reorder animation-frame entries, duration edits, and
// new/rename/delete animation) all go through state.commands so they're
// undoable, following the before/after-array-snapshot pattern frames.js uses
// for its own animation-affecting edits (slice grid / delete frame).

import { state, on, emit, activeSheet, markDirty, confirmOrAuto, currentContextLayers } from '../app/state.js';
import { addAnimation, contextLayers, flattenSheetLayers, findParent, renameAnimation, effectiveDuration } from '../core/model.js';
import { copyRegion } from '../core/pixels.js';
import { commitBreakApartStrip } from '../features/animations/commands.js';
import { setPreviewBitmap } from './previewpanel.js';

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
const DOCK_MIN = 100, DOCK_MAX = 400;
const DOCK_HEIGHT_KEY = 'pixelartist.timelineDockHeight';
const SPEEDS = [0.25, 0.5, 1, 2];

// ------------------------------------------------------------- drawing helpers

// Module-level scratch canvas and context, reused across all drawFit() calls
// to avoid allocating a new canvas on every rAF tick during playback.
let scratchCanvas = null;
let scratchCtx = null;

function getScratchCanvas(width, height) {
  if (!scratchCanvas) {
    scratchCanvas = document.createElement('canvas');
    scratchCtx = scratchCanvas.getContext('2d');
  }
  // Only resize if dimensions differ (resize resets context state)
  if (scratchCanvas.width !== width || scratchCanvas.height !== height) {
    scratchCanvas.width = width;
    scratchCanvas.height = height;
    // Restore imageSmoothingEnabled after resize (canvas resize resets context)
    scratchCtx.imageSmoothingEnabled = false;
  }
  return scratchCanvas;
}

// Draws `bmp` into `canvas`, scaled to fit (contain) and centered. Used for
// both 64px strip thumbnails and the 96px preview. Shrinking a large sprite
// down to a tiny thumbnail with nearest-neighbor drops most of its pixels
// and aliases badly; smoothing (project setting, on by default) only kicks
// in for that shrink case -- an upscaled thumbnail stays crisp
// nearest-neighbor or the pixel art would turn to mush.
function drawFit(canvas, bmp) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!bmp || bmp.width === 0 || bmp.height === 0) return;
  const tmp = getScratchCanvas(bmp.width, bmp.height);
  tmp.getContext('2d').putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
  const scale = Math.min(canvas.width / bmp.width, canvas.height / bmp.height);
  const dw = Math.max(1, Math.round(bmp.width * scale));
  const dh = Math.max(1, Math.round(bmp.height * scale));
  const dx = Math.floor((canvas.width - dw) / 2);
  const dy = Math.floor((canvas.height - dh) / 2);
  const smooth = scale < 1 && state.project?.settings?.smoothThumbnails !== false;
  ctx.imageSmoothingEnabled = smooth;
  if (smooth) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, 0, 0, bmp.width, bmp.height, dx, dy, dw, dh);
}

// ------------------------------------------------------------- commands

// Shared shape for every structural edit to an animation's `frames` array:
// capture cloned before/after arrays of {frameId, duration} entries so
// do()/undo() just swap the whole array (matches frames.js's animSnapshots
// pattern for delete-frame/slice-grid).
function commitFramesChange(anim, label, beforeFrames, afterFrames) {
  const cmd = {
    label,
    do() { anim.frames = afterFrames.map(f => ({ ...f })); },
    undo() { anim.frames = beforeFrames.map(f => ({ ...f })); },
  };
  state.commands.push(cmd);
  markDirty();
}

function addFrameToAnimation(anim, frameId) {
  const before = anim.frames.map(f => ({ ...f }));
  const after = [...before, { frameId, duration: null, step: null }];
  commitFramesChange(anim, 'add frame to animation', before, after);
}

function removeFrameEntry(anim, index) {
  const before = anim.frames.map(f => ({ ...f }));
  const after = before.filter((_, i) => i !== index);
  commitFramesChange(anim, 'remove frame from animation', before, after);
}

function reorderFrameEntry(anim, fromIndex, toIndex) {
  const before = anim.frames.map(f => ({ ...f }));
  const after = before.slice();
  const [item] = after.splice(fromIndex, 1);
  after.splice(Math.max(0, Math.min(after.length, toIndex)), 0, item);
  commitFramesChange(anim, 'reorder animation frame', before, after);
}

function changeDuration(anim, index, newDuration) {
  const before = anim.frames.map(f => ({ ...f }));
  if (before[index].duration === newDuration) return;
  const after = before.map((f, i) => (i === index ? { ...f, duration: newDuration } : f));
  commitFramesChange(anim, 'edit frame duration', before, after);
}

function changeStep(anim, index, newStep) {
  const before = anim.frames.map(f => ({ ...f }));
  if (before[index].step === newStep) return;
  const after = before.map((f, i) => (i === index ? { ...f, step: newStep } : f));
  commitFramesChange(anim, 'edit frame step', before, after);
}

// New/delete animation follow frames.js's commitCreate/deleteFrame pattern:
// create the object once (outside the command, like addFrame there), then
// let do()/undo() just move it in/out of sheet.animations at a remembered
// index so redo re-adds the SAME object (needed so undo/redo stay coherent
// with anything else that captured a reference to it, e.g. selection).
// A new animation starts FLOATING too (see addAnimation/acceptAnimation in
// core/model.js) -- no layer group until accepted. Unlike a strip, a plain
// animation has zero frames at creation, so there's nothing to preview yet;
// acceptance (Enter key or first paint stroke, once frames are assigned)
// just yields a blank layer.
function commitNewAnimation(sheet) {
  const name = `anim_${sheet.animations.length}`;
  let anim = null;
  let idx = -1;
  const cmd = {
    label: 'new animation',
    do() {
      if (!anim) { anim = addAnimation(sheet, name, false, state.project?.settings); idx = sheet.animations.indexOf(anim); }
      else if (!sheet.animations.includes(anim)) sheet.animations.splice(Math.min(idx, sheet.animations.length), 0, anim);
      // state.commands is a single global stack shared by every sheet -- only
      // touch selection state while this command's own sheet is still the
      // one on screen (see frames.js's matching comment on
      // commitNewStripFromFrame).
      if (sheet === activeSheet()) state.selectedAnimationId = anim.id;
    },
    undo() {
      idx = sheet.animations.indexOf(anim);
      sheet.animations = sheet.animations.filter(a => a !== anim);
      if (state.selectedAnimationId === anim.id) state.selectedAnimationId = null;
    },
  };
  state.commands.push(cmd);
  markDirty();
}

export function commitDeleteAnimation(sheet, animId) {
  const anim = sheet.animations.find(a => a.id === animId);
  if (!anim) return;
  const idx = sheet.animations.indexOf(anim);
  const wasSelected = state.selectedAnimationId === animId;
  const groupLoc = anim.layerGroupId ? findParent(sheet.layerTree, anim.layerGroupId) : null;
  const group = groupLoc ? groupLoc.parent.children[groupLoc.index] : null;
  const groupParent = groupLoc ? groupLoc.parent : null;
  const groupIdx = groupLoc ? groupLoc.index : -1;
  const cmd = {
    label: 'delete animation',
    do() {
      sheet.animations = sheet.animations.filter(a => a.id !== animId);
      if (groupParent) groupParent.children = groupParent.children.filter(c => c.id !== anim.layerGroupId);
      anim.layerGroupId = null;
      if (state.selectedAnimationId === animId) state.selectedAnimationId = null;
    },
    undo() {
      sheet.animations.splice(Math.min(idx, sheet.animations.length), 0, anim);
      if (groupParent) groupParent.children.splice(Math.min(groupIdx, groupParent.children.length), 0, group);
      anim.layerGroupId = group.id;
      if (wasSelected) state.selectedAnimationId = animId;
    },
  };
  state.commands.push(cmd);
  markDirty();
}

function commitRenameAnimation(sheet, anim, name) {
  const before = anim.name;
  if (before === name) return;
  state.commands.push({
    label: 'rename animation',
    do() { renameAnimation(sheet, anim.id, name); },
    undo() { renameAnimation(sheet, anim.id, before); },
  });
  markDirty();
}

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
  // Visible only when the selected animation is an intact strip (strip === true).
  const btnBreakApart = document.createElement('button'); btnBreakApart.type = 'button'; btnBreakApart.className = 'btn-icon-sm'; btnBreakApart.textContent = '✂'; btnBreakApart.title = 'Break apart';

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
    animSelect, btnNewAnim, btnRenameAnim, btnDeleteAnim, previewLoopLabel, btnAddFrame, btnBreakApart,
    btnFirst, btnPlay, btnLast, speedSelect,
  );

  const strip = document.createElement('div');
  strip.className = 'timeline-strip';

  const main = document.createElement('div');
  main.className = 'timeline-main';
  main.append(header, strip);

  // ---- dock resize (height only -- width already spans the fixed gap
  // between the tool palette and side panels) ----
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'timeline-resize-handle';
  resizeHandle.title = 'Drag to resize the timeline panel';

  const savedHeight = parseInt(localStorage.getItem(DOCK_HEIGHT_KEY), 10);
  if (Number.isFinite(savedHeight)) {
    el.style.height = Math.max(DOCK_MIN, Math.min(DOCK_MAX, savedHeight)) + 'px';
  }

  let dragStartY = 0, dragStartH = 0, dragging = false, resizeRaf = null;
  resizeHandle.addEventListener('pointerdown', (e) => {
    dragging = true;
    dragStartY = e.clientY;
    dragStartH = el.getBoundingClientRect().height;
    resizeHandle.classList.add('dragging');
    resizeHandle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  resizeHandle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const next = Math.max(DOCK_MIN, Math.min(DOCK_MAX, dragStartH + (dragStartY - e.clientY)));
    el.style.height = next + 'px';
    if (resizeRaf != null) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = null; render(); });
  });
  function endResizeDrag() {
    if (!dragging) return;
    dragging = false;
    resizeHandle.classList.remove('dragging');
    localStorage.setItem(DOCK_HEIGHT_KEY, el.getBoundingClientRect().height.toFixed(0));
  }
  resizeHandle.addEventListener('pointerup', endResizeDrag);
  resizeHandle.addEventListener('pointercancel', endResizeDrag);

  el.append(resizeHandle, main);

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
  let flatSheet = null;
  let flatBmp = null;
  function getFlat(sheet) {
    if (flatSheet !== sheet || !flatBmp) { flatBmp = flattenSheetLayers(currentContextLayers(), sheet.width, sheet.height, state.floating, sheet.id); flatSheet = sheet; }
    return flatBmp;
  }
  function invalidateFlat() { flatSheet = null; flatBmp = null; }

  function currentAnim() {
    const sheet = activeSheet();
    if (!sheet) return null;
    return sheet.animations.find(a => a.id === state.selectedAnimationId) ?? null;
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
    const sheet = activeSheet();
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

  function emitPlayhead() {
    const anim = currentAnim();
    if (anim) emit('playhead', { animId: anim.id, position });
  }

  function scrubTo(index) {
    stopPlaying();
    const anim = currentAnim();
    if (!anim || !anim.frames.length) return;
    position = Math.max(0, Math.min(anim.frames.length - 1, index));
    acc = 0;
    renderPreview();
    updatePlayheadHighlight();
    emitPlayhead();
  }

  function tick(ts) {
    if (!playing) return;
    const anim = currentAnim();
    if (!anim || !anim.frames.length) { stopPlaying(); return; }
    if (lastTs == null) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;
    const speed = parseFloat(speedSelect.value) || 1;
    acc += dt * speed;
    let entry = anim.frames[position];
    while (entry && acc >= effectiveDuration(anim, entry)) {
      acc -= effectiveDuration(anim, entry);
      position += 1;
      if (position >= anim.frames.length) {
        if (previewLoop) {
          position = 0;
        } else {
          position = anim.frames.length - 1;
          stopPlaying();
          break;
        }
      }
      entry = anim.frames[position];
    }
    renderPreview();
    updatePlayheadHighlight();
    emitPlayhead();
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
    const sheet = activeSheet();
    state.selectedAnimationId = animSelect.value || null;
    stopPlaying();
    position = 0; acc = 0;
    // Keep the active layer inside whatever context is now on screen -- see
    // commitNewStripFromFrame's matching comment in frames.js. Only reassign
    // when the current active layer doesn't already belong to the newly selected
    // context, so a deliberate in-context choice survives switching away and
    // back. contextLayers(sheet, null) (deselecting to "(none)") returns
    // every layer in the sheet, matching how a null selection is already
    // treated everywhere else -- so an in-context layer stays active rather
    // than being forced back to a root layer.
    if (sheet) {
      const layers = contextLayers(sheet, state.selectedAnimationId);
      if (!layers.some(l => l.id === state.activeLayerId)) state.activeLayerId = layers[0]?.id ?? null;
    }
    render();
    emit('selection');
  });

  btnNewAnim.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) return;
    commitNewAnimation(sheet);
  });

  btnRenameAnim.addEventListener('click', () => {
    const sheet = activeSheet();
    const anim = currentAnim();
    if (!sheet || !anim) return;
    const name = prompt('Animation name', anim.name);
    if (name == null) return;
    const v = name.trim();
    if (v) commitRenameAnimation(sheet, anim, v);
  });

  btnDeleteAnim.addEventListener('click', () => {
    const sheet = activeSheet();
    const anim = currentAnim();
    if (!sheet || !anim) return;
    if (!confirmOrAuto(`Delete animation "${anim.name}"?`)) return;
    stopPlaying();
    commitDeleteAnimation(sheet, anim.id);
  });

  previewLoopCheckbox.addEventListener('change', () => {
    previewLoop = previewLoopCheckbox.checked;
  });

  btnAddFrame.addEventListener('click', () => {
    const anim = currentAnim();
    if (!anim || !state.selectedFrameId) return;
    addFrameToAnimation(anim, state.selectedFrameId);
  });

  btnBreakApart.addEventListener('click', () => {
    const anim = currentAnim();
    if (!anim || !anim.strip) return;
    commitBreakApartStrip(anim);
  });

  // ---- strip cell ----
  function buildCell(anim, entry, index, sheet) {
    const cell = document.createElement('div');
    cell.className = 'timeline-cell';
    cell.draggable = !anim.strip;
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

    if (anim.baseFps != null) {
      // fps-primary: per-frame override is a whole-frame "Frames" (step)
      // count, never a raw ms value -- see the Animation-panel design doc.
      const stepInput = document.createElement('input');
      stepInput.type = 'number'; stepInput.min = '1';
      stepInput.title = "Frames to hold (overrides the animation's base step)";
      stepInput.value = String(entry.step ?? anim.baseStep ?? 1);
      stepInput.addEventListener('click', (e) => e.stopPropagation());
      stepInput.addEventListener('change', () => {
        let v = parseInt(stepInput.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        stepInput.value = String(v);
        changeStep(anim, index, v);
      });
      const msCaption = document.createElement('span');
      msCaption.className = 'timeline-cell-ms-caption';
      msCaption.textContent = `${effectiveDuration(anim, entry)}ms`;
      controls.append(stepInput, msCaption);
    } else {
      const durationInput = document.createElement('input');
      durationInput.type = 'number'; durationInput.min = '1';
      durationInput.value = String(effectiveDuration(anim, entry));
      durationInput.addEventListener('click', (e) => e.stopPropagation());
      durationInput.addEventListener('change', () => {
        let v = parseInt(durationInput.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        durationInput.value = String(v);
        changeDuration(anim, index, v);
      });
      controls.append(durationInput);
    }

    const btnRemove = document.createElement('button');
    btnRemove.type = 'button'; btnRemove.textContent = '✕'; btnRemove.className = 'timeline-remove';
    btnRemove.addEventListener('click', (e) => { e.stopPropagation(); removeFrameEntry(anim, index); });
    if (!anim.strip) controls.append(btnRemove);

    cell.append(thumbCanvas, controls);

    cell.addEventListener('click', () => {
      scrubTo(index);
      // Clicking a cell also makes it the app-wide "current frame" (the
      // same selection the sprite sheet/Frames panel use), not just the
      // preview-playhead position -- so e.g. the Frames panel and the
      // sprite-sheet highlight follow along with a single click. It also
      // opens the frame editor directly on that frame (previously required
      // a double-click) -- one click both selects and jumps in.
      if (frame && state.selectedFrameId !== frame.id) {
        state.selectedFrameId = frame.id;
        emit('selection');
      }
      if (frame) {
        state.editingFrameId = frame.id;
        state.view = 'frame';
        emit('view');
      }
    });

    cell.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(index));
      e.dataTransfer.effectAllowed = 'move';
    });
    cell.addEventListener('dragover', (e) => {
      if (anim.strip) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = cell.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      cell.classList.toggle('drag-before', before);
      cell.classList.toggle('drag-after', !before);
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-before', 'drag-after'));
    cell.addEventListener('drop', (e) => {
      if (anim.strip) return;
      e.preventDefault();
      const before = cell.classList.contains('drag-before');
      cell.classList.remove('drag-before', 'drag-after');
      const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (!Number.isFinite(fromIndex)) return;
      let toIndex = index + (before ? 0 : 1);
      if (fromIndex < toIndex) toIndex -= 1; // removal shifts everything after it left by one
      if (toIndex === fromIndex) return;
      reorderFrameEntry(anim, fromIndex, toIndex);
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
    if (state.selectedAnimationId && !sheet.animations.find(a => a.id === state.selectedAnimationId))
      state.selectedAnimationId = null;
    animSelect.value = state.selectedAnimationId ?? '';
  }

  function render() {
    if (state.mode !== 'sprites') { el.hidden = true; stopPlaying(); return; }
    el.hidden = false;
    updateThumbSize();
    invalidateFlat();
    const sheet = activeSheet();
    renderAnimSelect(sheet);
    const anim = currentAnim();

    btnRenameAnim.disabled = !anim;
    btnDeleteAnim.disabled = !anim;
    btnAddFrame.disabled = !anim || !state.selectedFrameId || !!anim.strip;
    btnBreakApart.hidden = !anim?.strip;
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

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => { renderQueued = false; render(); });
  }

  on('project', scheduleRender);
  on('history', scheduleRender);
  on('view', scheduleRender);
  on('selection', scheduleRender);
  render();
}
