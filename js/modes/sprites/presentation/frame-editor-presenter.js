// js/modes/sprites/presentation/frame-editor-presenter.js
// Frame editor: a focused, zoomed-in view of a single frame with configurable
// onion-skinning against its animation neighbors. The canvas itself (frame-
// local coordinates over sheet-global bitmaps, onion ghosts, float/clip
// handling) is the shared components/canvas/frame-canvas.js; this presenter
// adds the strip (back, name, prev/next, onion controls), keyboard Escape,
// and the fallback to the sheet view when the edited frame disappears.
// Lives in its own absolutely-positioned child of #canvas-host, mounted once.

import { commitFloatIfAny } from '../../../components/canvas/float-session.js';
import { createFrameCanvas } from '../../../components/canvas/frame-canvas.js';
import { buildOnionControls } from '../../../components/canvas/onion-controls.js';
import { computeNeighborFrame } from '../application/frame-navigation.js';
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { isTypingTarget } from '../../../components/dom-utils.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

function sheetSelection(sheet) { return getEditorHost().selections.get(sheetDocument(sheet)) ?? {}; }
function activeViewId() { return getEditorHost().store.getState().session.activeViewId; }
function openSheetView() { getEditorHost().store.updateSession({ activeViewId: 'sprites.sheet' }, 'view'); }

export function mountFrameEditor(hostEl) {
  const container = document.createElement('div');
  container.className = 'frame-editor';
  hostEl.appendChild(container);

  // ---- top strip ----
  const strip = document.createElement('div');
  strip.className = 'frame-editor-strip';
  container.appendChild(strip);

  const btnBack = document.createElement('button');
  btnBack.type = 'button'; btnBack.className = 'btn-icon-md'; btnBack.textContent = '⬅'; btnBack.title = 'Back to sheet';

  const nameLabel = document.createElement('span');
  nameLabel.className = 'frame-editor-name';

  const btnPrev = document.createElement('button');
  btnPrev.type = 'button'; btnPrev.textContent = '◀ Prev';
  const btnNext = document.createElement('button');
  btnNext.type = 'button'; btnNext.textContent = 'Next ▶';

  // ---- canvas ----
  const canvasHostDiv = document.createElement('div');
  canvasHostDiv.className = 'frame-editor-canvas';
  container.appendChild(canvasHostDiv);

  function currentFrame() {
    const sheet = activeSheet('sprite');
    if (!sheet) return null;
    return sheet.frames.find(f => f.id === sheetSelection(sheet).editingFrameId) ?? null;
  }

  function currentAnimation() {
    const sheet = activeSheet('sprite');
    return sheet?.animations.find(a => a.id === sheetSelection(sheet).animationId) ?? null;
  }

  const frameCanvas = createFrameCanvas(canvasHostDiv, {
    viewKind: 'frame', getFrame: currentFrame, getOnionAnimation: currentAnimation, onStateChange: () => refresh(),
  });
  const { view } = frameCanvas;
  const onionControls = buildOnionControls({ onChange: () => view.requestRender() });

  strip.append(btnBack, nameLabel, btnPrev, btnNext, onionControls.element);

  // ---- navigation ----

  // Walks the selected animation's order if the current frame belongs to it,
  // else falls back to sheet frame order. Clamped (no wraparound) at the ends.
  function neighborFrame(dir) {
    const sheet = activeSheet('sprite');
    const f = currentFrame();
    if (!sheet || !f) return null;
    return computeNeighborFrame(sheet, f, currentAnimation(), dir);
  }

  function updateStrip() {
    const f = currentFrame();
    nameLabel.textContent = f ? f.name : '';
    onionControls.sync();
    btnPrev.disabled = !neighborFrame(-1);
    btnNext.disabled = !neighborFrame(1);
  }

  // Reloads (recentering) only if the edited frame changed identity or size;
  // otherwise repaints in place, keeping the user's zoom/pan.
  function refresh() {
    if (!frameCanvas.sync()) {
      hide();
      // The frame we were editing is gone (deleted, or a new/opened project
      // no longer has it) — fall back to the sheet view rather than leaving
      // both this editor and the sheet canvas hidden.
      if (activeViewId() === 'sprites.frame') {
        const sheet = activeSheet('sprite');
        if (sheet) getEditorHost().selections.patch({ editingFrameId: null }, sheetDocument(sheet));
        openSheetView();
      }
      return;
    }
    updateStrip();
  }

  function goTo(dir) {
    const nf = neighborFrame(dir);
    if (!nf) return;
    // Settle the old target before navigation; the selection subscription
    // shares the same refresh path with timeline and panel navigation.
    commitFloatIfAny();
    const sheet = activeSheet('sprite');
    if (sheet) getEditorHost().selections.patch({ editingFrameId: nf.id }, sheetDocument(sheet));
  }

  btnBack.addEventListener('click', openSheetView);
  btnPrev.addEventListener('click', () => goTo(-1));
  btnNext.addEventListener('click', () => goTo(1));

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (activeViewId() !== 'sprites.frame') return;
    if (document.querySelector('dialog[open]')) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    openSheetView();
  });

  // ---- visibility ----

  function show() {
    container.style.display = 'flex';
    frameCanvas.shown();
    refresh();
  }
  function hide() {
    frameCanvas.hidden();
    container.style.display = 'none';
  }

  return { show, hide, view };
}
