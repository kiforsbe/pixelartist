// js/modes/animations/presentation/animation-list-panel.js
// The Animations workbench's Animations panel: the active sheet's
// animations (thumbnail bordered in the tag colour, name, layout badge; click
// to select, drag to reorder), then New… / Duplicate / Delete / Sprite size…
// (every frame on a sprite sheet is one size; its form adds a 3×3 anchor).
// The selected animation's details are the separate
// Animation panel (animation-inspector-panel.js). Layout changes go through
// dispatchLayout (settles a float, explains a refusal).
import { flattenSheetLayers } from '../../../core/model.js';
import { copyRegion } from '../../../core/pixels.js';
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet, currentContextLayers } from '../../../host/document-helpers.js';
import { confirmOrAuto } from '../../../platform/browser/autotest.js';
import { activeFloating } from '../../../components/canvas/float-session.js';
import { createRasterCache } from '../../../components/canvas/raster-cache.js';
import { drawFit } from '../../../components/canvas/draw-fit.js';
import { dispatchLayout } from '../../../components/layout-dispatch.js';
import { mountStorePanel } from '../../../components/panel-mount.js';
import { attachDragReorder, slotToFinalIndex } from '../../../components/drag-reorder.js';
import { sheetDocument, textButton, numberInput, labelled } from './panel-controls.js';

const THUMB = 32;
const ANCHORS = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'];

export function mountAnimationListPanel(el) {
  el.innerHTML = '';
  const heading = document.createElement('h3');
  heading.textContent = 'Animations';

  const host = getEditorHost();
  const sheet = () => activeSheet('sprite');
  const selection = () => { const s = sheet(); return s ? (host.selections.get(sheetDocument(s)) ?? {}) : {}; };
  const selectedAnim = () => sheet()?.animations.find(a => a.id === selection().animationId) ?? null;

  // A size field's value: a whole number, else NaN, which the layout
  // commands refuse with their bad-size message (never truncated: 12.9 is
  // not 12).
  const sizeValue = input => { const v = Number(input.value); return Number.isInteger(v) ? v : NaN; };

  // ---- list ----
  const list = document.createElement('div');
  list.className = 'anim-list';

  const flatCache = createRasterCache();
  const flat = s => flatCache.getBitmap(s, x => flattenSheetLayers(currentContextLayers(), x.width, x.height, activeFloating(), x.id));

  function selectAnimation(s, anim) {
    host.selections.patch({ animationId: anim.id, frameId: anim.frames[0]?.frameId ?? null, entryIndex: 0 }, sheetDocument(s));
  }

  function buildRow(s, anim, active) {
    const row = document.createElement('div');
    row.className = active ? 'anim-row active' : 'anim-row';
    row.dataset.dragKey = anim.id;
    const thumb = document.createElement('canvas');
    thumb.width = THUMB; thumb.height = THUMB;
    thumb.className = 'anim-thumb';
    // The animation's tag colour borders its thumbnail.
    if (anim.color) { thumb.classList.add('has-color'); thumb.style.borderColor = anim.color; }
    const first = s.frames.find(f => f.id === anim.frames[0]?.frameId);
    if (first) drawFit(thumb, copyRegion(flat(s), first.x, first.y, first.w, first.h));
    const name = document.createElement('span');
    name.className = 'anim-row-name';
    name.textContent = anim.name;
    const badge = document.createElement('span');
    badge.className = 'anim-badge';
    badge.textContent = anim.layout === 'auto' ? 'auto' : 'manual';
    badge.title = anim.layout === 'auto' ? 'Frames are laid out on the sheet automatically' : 'Frames stay where they are on the sheet';
    row.append(thumb, name, badge);
    row.addEventListener('click', () => selectAnimation(s, anim));
    return row;
  }

  // Rows reorder by pointer drag (insertion line between rows). The list
  // element outlives its rows, so the drag is attached once; rows are keyed
  // by animation id and the command takes the final index.
  const disposeDrag = attachDragReorder(list, {
    axis: 'y',
    itemSelector: '.anim-row',
    onDrop: ({ sourceKey, slot }) => {
      const s = sheet();
      const from = s?.animations.findIndex(a => a.id === sourceKey) ?? -1;
      if (from < 0 || slot == null) return;
      const to = slotToFinalIndex(from, slot);
      if (to !== from) dispatchLayout('animations.reorderAnimations', { sheetId: s.id, from, to });
    },
  });

  const hint = document.createElement('div');
  hint.className = 'frame-field';

  // ---- toolbar + New form ----
  const toolbar = document.createElement('div');
  toolbar.className = 'row anim-toolbar';
  const newForm = document.createElement('div');
  newForm.className = 'anim-form anim-new-form';
  newForm.hidden = true;
  const newName = document.createElement('input');
  newName.type = 'text'; newName.placeholder = 'Name';
  newForm.append(newName, textButton('Create', '', () => {
    const s = sheet();
    if (!s) return;
    const name = newName.value.trim() || undefined;
    const result = dispatchLayout('animations.new', { sheetId: s.id, name });
    if (result?.ok) {
      newForm.hidden = true;
      host.selections.patch({ entryIndex: 0 }, sheetDocument(s));
    }
  }), textButton('Cancel', '', () => { newForm.hidden = true; }));

  const btnNew = textButton('New…', 'New animation, one blank frame of the sprite size', () => {
    newName.value = '';
    newForm.hidden = false;
  });
  const btnDuplicate = textButton('Duplicate', 'Duplicate the selected animation and its frames', () => {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatchLayout('animations.duplicate', { sheetId: s.id, animationId: anim.id });
  });
  const btnDelete = textButton('Delete', 'Delete the selected animation', () => {
    const s = sheet(), anim = selectedAnim();
    if (!s || !anim) return;
    const message = anim.layout === 'auto' ? `Delete animation "${anim.name}" and its frames?` : `Delete animation "${anim.name}"?`;
    if (confirmOrAuto(message)) dispatchLayout('animations.delete', { sheetId: s.id, animationId: anim.id });
  });
  const btnSpriteSize = textButton('Sprite size…', 'Resize every frame on this sheet', () => {
    const size = sheet()?.spriteSize;
    if (size) openSizeForm(size);
  });
  toolbar.append(btnNew, btnDuplicate, btnDelete, btnSpriteSize);

  // ---- the sprite size form: the sheet-wide frame size ----
  const sizeForm = document.createElement('div');
  sizeForm.className = 'anim-form anim-size-form';
  sizeForm.hidden = true;
  const sizeTitle = document.createElement('div');
  sizeTitle.className = 'frame-field';
  sizeTitle.textContent = 'Sprite size (every frame on this sheet)';
  const sizeW = numberInput('Sprite width'), sizeH = numberInput('Sprite height');
  const sizeRow = document.createElement('div');
  sizeRow.className = 'row';
  sizeRow.append(labelled('W', sizeW), labelled('H', sizeH));
  const anchorGrid = document.createElement('div');
  anchorGrid.className = 'anchor-grid';
  anchorGrid.title = 'Where the existing pixels sit on the new canvas';
  let anchor = 'c';
  const anchorButtons = ANCHORS.map(id => {
    const b = textButton('', id, () => { anchor = id; syncAnchors(); });
    b.dataset.anchor = id;
    return b;
  });
  function syncAnchors() { for (const b of anchorButtons) b.classList.toggle('active', b.dataset.anchor === anchor); }
  anchorGrid.append(...anchorButtons);
  sizeForm.append(sizeTitle, sizeRow, anchorGrid, textButton('Apply', '', () => {
    const s = sheet();
    if (!s) return;
    const result = dispatchLayout('animations.resizeCanvas', { sheetId: s.id, w: sizeValue(sizeW), h: sizeValue(sizeH), anchor });
    if (result?.ok) sizeForm.hidden = true;
  }), textButton('Cancel', '', () => { sizeForm.hidden = true; }));

  function openSizeForm(size) {
    anchor = 'c';
    syncAnchors();
    sizeW.value = String(size.w);
    sizeH.value = String(size.h);
    sizeForm.hidden = false;
  }

  el.append(heading, list, hint, toolbar, newForm, sizeForm);

  let lastSheetId = null;
  function render() {
    if (host.store.getState().session.activeModeId !== 'animations') { el.hidden = true; return; }
    el.hidden = false;
    flatCache.invalidate();
    const s = sheet();
    const anim = selectedAnim();
    if ((s?.id ?? null) !== lastSheetId) sizeForm.hidden = true;
    lastSheetId = s?.id ?? null;
    list.innerHTML = '';
    s?.animations.forEach(a => list.appendChild(buildRow(s, a, a === anim)));
    hint.hidden = !!s?.animations.length;
    hint.textContent = s ? 'No animations yet — click New….' : 'No sprite sheet.';
    btnDuplicate.disabled = anim?.layout !== 'auto';
    btnDuplicate.title = anim && anim.layout !== 'auto' ? 'Auto-layout this animation first' : 'Duplicate the selected animation and its frames';
    btnDelete.disabled = !anim;
    btnNew.disabled = !s;
    if (!s) newForm.hidden = true;
    btnSpriteSize.disabled = !s?.spriteSize;
    btnSpriteSize.title = s?.spriteSize ? `Every frame on this sheet is ${s.spriteSize.w}×${s.spriteSize.h} — resize them all` : 'Resize every frame on this sheet';
  }

  const panel = mountStorePanel(host.store, [
    s => s.project.model,
    s => s.session.activeModeId,
    s => s.session.activeDocument,
    s => s.workspace.pixelRevision,
    s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; },
  ], render);
  const disposeHistory = host.history.subscribe(() => panel.scheduleRender());
  return { ...panel, dispose() { disposeHistory(); disposeDrag(); panel.dispose(); } };
}
