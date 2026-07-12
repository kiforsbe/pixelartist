// Animation timeline dock: header (animation picker + New/Rename/Delete/Loop
// + "Add selected frame" + playback transport + live preview canvas) and a
// horizontal strip of frame cells (thumbnail + duration + remove, drag to
// reorder, click to scrub, double-click to open the frame editor).
//
// Mirrors frames.js's split: a single mount function builds the DOM once and
// re-renders on the app-wide events that can change what it shows. Structural
// edits (add/remove/reorder animation-frame entries, duration edits, and
// new/rename/delete animation) all go through state.commands so they're
// undoable, following the before/after-array-snapshot pattern frames.js uses
// for its own animation-affecting edits (slice grid / delete frame).

import { state, on, emit, activeSheet, markDirty, confirmOrAuto } from '../app/state.js';
import { addAnimation, flattenSheet } from '../core/model.js';
import { copyRegion } from '../core/pixels.js';

const THUMB_SIZE = 64;
const PREVIEW_SIZE = 96;
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

// Draws `bmp` into `canvas` nearest-neighbor, scaled to fit (contain) and
// centered. Used for both 64px strip thumbnails and the 96px preview.
function drawFit(canvas, bmp) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!bmp || bmp.width === 0 || bmp.height === 0) return;
  const tmp = getScratchCanvas(bmp.width, bmp.height);
  tmp.getContext('2d').putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
  const scale = Math.min(canvas.width / bmp.width, canvas.height / bmp.height);
  const dw = Math.max(1, Math.round(bmp.width * scale));
  const dh = Math.max(1, Math.round(bmp.height * scale));
  const dx = Math.floor((canvas.width - dw) / 2);
  const dy = Math.floor((canvas.height - dh) / 2);
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
  const after = [...before, { frameId, duration: 100 }];
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

// New/delete animation follow frames.js's commitCreate/deleteFrame pattern:
// create the object once (outside the command, like addFrame there), then
// let do()/undo() just move it in/out of sheet.animations at a remembered
// index so redo re-adds the SAME object (needed so undo/redo stay coherent
// with anything else that captured a reference to it, e.g. selection).
function commitNewAnimation(sheet) {
  const name = `anim_${sheet.animations.length}`;
  let anim = null;
  let idx = -1;
  const cmd = {
    label: 'new animation',
    do() {
      if (!anim) { anim = addAnimation(sheet, name); idx = sheet.animations.indexOf(anim); }
      else if (!sheet.animations.includes(anim)) sheet.animations.splice(Math.min(idx, sheet.animations.length), 0, anim);
      state.selectedAnimationId = anim.id;
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

function commitDeleteAnimation(sheet, animId) {
  const anim = sheet.animations.find(a => a.id === animId);
  if (!anim) return;
  const idx = sheet.animations.indexOf(anim);
  const wasSelected = state.selectedAnimationId === animId;
  const cmd = {
    label: 'delete animation',
    do() {
      sheet.animations = sheet.animations.filter(a => a.id !== animId);
      if (state.selectedAnimationId === animId) state.selectedAnimationId = null;
    },
    undo() {
      sheet.animations.splice(Math.min(idx, sheet.animations.length), 0, anim);
      if (wasSelected) state.selectedAnimationId = animId;
    },
  };
  state.commands.push(cmd);
  markDirty();
}

function commitRenameAnimation(anim, name) {
  const before = anim.name;
  if (before === name) return;
  state.commands.push({
    label: 'rename animation',
    do() { anim.name = name; },
    undo() { anim.name = before; },
  });
  markDirty();
}

function commitToggleLoop(anim, loop) {
  const before = anim.loop;
  if (before === loop) return;
  state.commands.push({
    label: 'toggle animation loop',
    do() { anim.loop = loop; },
    undo() { anim.loop = before; },
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
  const btnNewAnim = document.createElement('button'); btnNewAnim.type = 'button'; btnNewAnim.textContent = 'New';
  const btnRenameAnim = document.createElement('button'); btnRenameAnim.type = 'button'; btnRenameAnim.textContent = 'Rename';
  const btnDeleteAnim = document.createElement('button'); btnDeleteAnim.type = 'button'; btnDeleteAnim.textContent = 'Delete';
  const loopCheckbox = document.createElement('input'); loopCheckbox.type = 'checkbox';
  const loopLabel = document.createElement('label'); loopLabel.className = 'timeline-loop';
  loopLabel.append(loopCheckbox, document.createTextNode('Loop'));
  const btnAddFrame = document.createElement('button'); btnAddFrame.type = 'button'; btnAddFrame.textContent = 'Add selected frame';

  const btnFirst = document.createElement('button'); btnFirst.type = 'button'; btnFirst.textContent = '⏮';
  const btnPlay = document.createElement('button'); btnPlay.type = 'button'; btnPlay.textContent = '▶';
  const btnLast = document.createElement('button'); btnLast.type = 'button'; btnLast.textContent = '⏭';
  const speedSelect = document.createElement('select');
  for (const s of SPEEDS) {
    const opt = document.createElement('option');
    opt.value = String(s); opt.textContent = `${s}x`;
    if (s === 1) opt.selected = true;
    speedSelect.appendChild(opt);
  }

  header.append(
    animSelect, btnNewAnim, btnRenameAnim, btnDeleteAnim, loopLabel, btnAddFrame,
    btnFirst, btnPlay, btnLast, speedSelect,
  );

  const strip = document.createElement('div');
  strip.className = 'timeline-strip';

  // Header + strip stack in a column that takes the remaining width; the
  // preview lives in its own column so its fixed 96x96 size doesn't force
  // the header row (buttons/selects) to grow to 96px tall and starve the
  // strip of vertical space.
  const main = document.createElement('div');
  main.className = 'timeline-main';
  main.append(header, strip);

  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = PREVIEW_SIZE; previewCanvas.height = PREVIEW_SIZE;
  previewCanvas.className = 'timeline-preview';

  el.append(main, previewCanvas);

  // ---- player state ----
  let playing = false;
  let rafId = null;
  let lastTs = null;
  let acc = 0;
  let position = 0; // index into currentAnim().frames

  // Cached flatten of the active sheet; invalidated at the top of every full
  // render() (triggered by project/history/view/selection) and reused by the
  // rAF tick loop / scrub clicks that happen between full renders, so playback
  // doesn't re-flatten the whole sheet every frame.
  let flatSheet = null;
  let flatBmp = null;
  function getFlat(sheet) {
    if (flatSheet !== sheet || !flatBmp) { flatBmp = flattenSheet(sheet); flatSheet = sheet; }
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

  function renderPreview() {
    const sheet = activeSheet();
    const anim = currentAnim();
    const ctx = previewCanvas.getContext('2d');
    if (!sheet || !anim || !anim.frames.length) { ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height); return; }
    const entry = anim.frames[Math.max(0, Math.min(position, anim.frames.length - 1))];
    const frame = sheet.frames.find(f => f.id === entry.frameId);
    if (!frame) { ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height); return; }
    const region = copyRegion(getFlat(sheet), frame.x, frame.y, frame.w, frame.h);
    drawFit(previewCanvas, region);
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
    while (entry && acc >= entry.duration) {
      acc -= entry.duration;
      position += 1;
      if (position >= anim.frames.length) {
        if (anim.loop) {
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
    state.selectedAnimationId = animSelect.value || null;
    stopPlaying();
    position = 0; acc = 0;
    render();
  });

  btnNewAnim.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) return;
    commitNewAnimation(sheet);
  });

  btnRenameAnim.addEventListener('click', () => {
    const anim = currentAnim();
    if (!anim) return;
    const name = prompt('Animation name', anim.name);
    if (name == null) return;
    const v = name.trim();
    if (v) commitRenameAnimation(anim, v);
  });

  btnDeleteAnim.addEventListener('click', () => {
    const sheet = activeSheet();
    const anim = currentAnim();
    if (!sheet || !anim) return;
    if (!confirmOrAuto(`Delete animation "${anim.name}"?`)) return;
    stopPlaying();
    commitDeleteAnimation(sheet, anim.id);
  });

  loopCheckbox.addEventListener('change', () => {
    const anim = currentAnim();
    if (!anim) return;
    commitToggleLoop(anim, loopCheckbox.checked);
  });

  btnAddFrame.addEventListener('click', () => {
    const anim = currentAnim();
    if (!anim || !state.selectedFrameId) return;
    addFrameToAnimation(anim, state.selectedFrameId);
  });

  // ---- strip cell ----
  function buildCell(anim, entry, index, sheet) {
    const cell = document.createElement('div');
    cell.className = 'timeline-cell';
    cell.draggable = true;

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = THUMB_SIZE; thumbCanvas.height = THUMB_SIZE;
    thumbCanvas.className = 'timeline-thumb';
    const frame = sheet.frames.find(f => f.id === entry.frameId);
    if (frame) drawFit(thumbCanvas, copyRegion(getFlat(sheet), frame.x, frame.y, frame.w, frame.h));

    const durationInput = document.createElement('input');
    durationInput.type = 'number'; durationInput.min = '1';
    durationInput.value = String(entry.duration);
    durationInput.addEventListener('click', (e) => e.stopPropagation());
    durationInput.addEventListener('change', () => {
      let v = parseInt(durationInput.value, 10);
      if (!Number.isFinite(v) || v < 1) v = 1;
      durationInput.value = String(v);
      changeDuration(anim, index, v);
    });

    const btnRemove = document.createElement('button');
    btnRemove.type = 'button'; btnRemove.textContent = '✕'; btnRemove.className = 'timeline-remove';
    btnRemove.addEventListener('click', (e) => { e.stopPropagation(); removeFrameEntry(anim, index); });

    const controls = document.createElement('div');
    controls.className = 'timeline-cell-controls';
    controls.append(durationInput, btnRemove);

    cell.append(thumbCanvas, controls);

    cell.addEventListener('click', () => scrubTo(index));
    cell.addEventListener('dblclick', () => {
      if (!frame) return;
      state.editingFrameId = frame.id;
      state.view = 'frame';
      emit('view');
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
      reorderFrameEntry(anim, fromIndex, toIndex);
    });

    return cell;
  }

  // ---- full render ----
  function renderAnimSelect(sheet) {
    animSelect.innerHTML = '';
    if (!sheet) return;
    for (const a of sheet.animations) {
      const opt = document.createElement('option');
      opt.value = a.id; opt.textContent = a.name;
      animSelect.appendChild(opt);
    }
    if (!sheet.animations.find(a => a.id === state.selectedAnimationId))
      state.selectedAnimationId = sheet.animations[0]?.id ?? null;
    animSelect.value = state.selectedAnimationId ?? '';
  }

  function render() {
    if (state.mode !== 'sprites') { el.hidden = true; stopPlaying(); return; }
    el.hidden = false;
    invalidateFlat();
    const sheet = activeSheet();
    renderAnimSelect(sheet);
    const anim = currentAnim();

    loopCheckbox.checked = !!anim?.loop;
    loopCheckbox.disabled = !anim;
    btnRenameAnim.disabled = !anim;
    btnDeleteAnim.disabled = !anim;
    btnAddFrame.disabled = !anim || !state.selectedFrameId;
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
