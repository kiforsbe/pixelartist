// js/modes/animations/presentation/animation-list-panel.js
// The Animations workbench's Animations panel: the active sheet's
// animations (thumbnail bordered in the tag colour, name, layout badge; click
// to select, drag to reorder), New / Duplicate / Delete, and the selected
// animation's details -- name, loop, direction, colour, base duration,
// Auto-layout / Make manual and Canvas size…
// (with an anchor grid). Layout changes go through dispatchLayout (settles
// a float, explains a refusal); a needsSize refusal opens the size form.
import { flattenSheetLayers } from '../../../core/model.js';
import { copyRegion } from '../../../core/pixels.js';
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet, currentContextLayers } from '../../../host/document-helpers.js';
import { confirmOrAuto } from '../../../platform/browser/autotest.js';
import { activeFloating } from '../../../components/canvas/float-session.js';
import { createRasterCache } from '../../../components/canvas/raster-cache.js';
import { drawFit } from '../../../components/canvas/draw-fit.js';
import { dispatchLayout } from '../../../components/layout-dispatch.js';
import { buildBaseDurationControl } from '../../../components/panels/base-duration-control.js';
import { mountStorePanel } from '../../../components/panel-mount.js';
import { attachDragReorder, slotToFinalIndex } from '../../../components/drag-reorder.js';

const THUMB = 32;
const ANCHORS = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'];
const DIRECTIONS = [['forward', 'Forward'], ['reverse', 'Reverse'], ['pingpong', 'Ping-pong'], ['pingpong-reverse', 'Ping-pong reverse']];
const DEFAULT_TAG_COLOR = '#4f8cff'; // css/app.css --accent, the tag colour when none is set

function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}

function sheetDocument(sheet) { return { kind: 'sprite-sheet', id: sheet.id }; }

function textButton(text, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  if (title) button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function numberInput(title) {
  const input = document.createElement('input');
  input.type = 'number'; input.min = '1'; input.title = title;
  return input;
}

function labelled(text, input) {
  const label = document.createElement('label');
  label.className = 'frame-field';
  label.append(document.createTextNode(text), input);
  return label;
}

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

  // ---- toolbar + New form ----
  const toolbar = document.createElement('div');
  toolbar.className = 'row';
  const newForm = document.createElement('div');
  newForm.className = 'anim-form anim-new-form';
  newForm.hidden = true;
  const newName = document.createElement('input');
  newName.type = 'text'; newName.placeholder = 'Name';
  const newW = numberInput('Canvas width'), newH = numberInput('Canvas height');
  const newRow = document.createElement('div');
  newRow.className = 'row';
  newRow.append(labelled('W', newW), labelled('H', newH));
  newForm.append(newName, newRow, textButton('Create', '', () => {
    const s = sheet();
    if (!s) return;
    const name = newName.value.trim() || undefined;
    const result = dispatchLayout('animations.new', { sheetId: s.id, name, w: sizeValue(newW), h: sizeValue(newH) });
    if (result?.ok) {
      newForm.hidden = true;
      host.selections.patch({ entryIndex: 0 }, sheetDocument(s));
    }
  }), textButton('Cancel', '', () => { newForm.hidden = true; }));

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
  const btnNew = textButton('New…', 'New animation', () => {
    const settings = host.projects.project?.settings;
    newName.value = '';
    newW.value = String(settings?.frameW ?? 16);
    newH.value = String(settings?.frameH ?? 16);
    newForm.hidden = false;
  });
  toolbar.append(btnNew, btnDuplicate, btnDelete);

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

  // ---- details ----
  const details = document.createElement('div');
  details.className = 'frame-row active anim-details';
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'frame-name';
  nameInput.addEventListener('change', () => {
    const s = sheet(), anim = selectedAnim();
    if (!s || !anim) return;
    const v = nameInput.value.trim();
    if (v) dispatch('sprites.renameAnimation', { sheetId: s.id, animationId: anim.id, name: v });
    else nameInput.value = anim.name;
  });
  const loopCheckbox = document.createElement('input');
  loopCheckbox.type = 'checkbox';
  loopCheckbox.addEventListener('change', () => {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatch('sprites.toggleAnimationLoop', { sheetId: s.id, animationId: anim.id, loop: loopCheckbox.checked });
  });
  const loopLabel = document.createElement('label');
  loopLabel.className = 'timeline-loop';
  loopLabel.title = 'Whether the exported animation loops';
  loopLabel.append(loopCheckbox, document.createTextNode('Loop'));
  const nameRow = document.createElement('div');
  nameRow.className = 'row';
  nameRow.append(nameInput, loopLabel);

  // Direction (how playback walks the frames) and tag colour (timeline tag,
  // row thumbnail border). The colour picker cannot show "none", so a null
  // colour shows the accent and marks the picker unset.
  const directionSelect = document.createElement('select');
  directionSelect.title = 'Playback direction';
  for (const [value, text] of DIRECTIONS) {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = text;
    directionSelect.appendChild(opt);
  }
  directionSelect.addEventListener('change', () => {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatch('sprites.setAnimationDirection', { sheetId: s.id, animationId: anim.id, direction: directionSelect.value });
  });
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'anim-color';
  colorInput.title = 'Tag colour';
  colorInput.addEventListener('change', () => {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatch('sprites.setAnimationColor', { sheetId: s.id, animationId: anim.id, color: colorInput.value.toLowerCase() });
  });
  const btnNoColor = textButton('None', 'Use the default tag colour', () => {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatch('sprites.setAnimationColor', { sheetId: s.id, animationId: anim.id, color: null });
  });
  const styleRow = document.createElement('div');
  styleRow.className = 'row';
  styleRow.append(labelled('Direction', directionSelect), labelled('Colour', colorInput), btnNoColor);

  const durationControl = buildBaseDurationControl({
    getValue: () => { const a = selectedAnim(); return { durationMs: a?.baseDuration ?? 100, baseFps: a?.baseFps, baseStep: a?.baseStep }; },
    setValue: (after) => {
      const s = sheet(), anim = selectedAnim();
      if (!s || !anim) return;
      const before = { durationMs: anim.baseDuration, baseFps: anim.baseFps, baseStep: anim.baseStep };
      dispatch('sprites.setAnimationBaseDuration', { sheetId: s.id, animationId: anim.id, before, after });
    },
  });

  const layoutRow = document.createElement('div');
  layoutRow.className = 'row';
  const btnAutoLayout = textButton('Auto-layout', 'Lay this animation\'s frames out on the sheet automatically', () => {
    const s = sheet(), anim = selectedAnim();
    if (!s || !anim) return;
    const result = dispatchLayout('animations.autoLayout', { sheetId: s.id, animationId: anim.id });
    if (result?.needsSize) openSizeForm('autolayout', result.suggested);
  });
  const btnMakeManual = textButton('Make manual', 'Stop auto-laying-out this animation; its frames stay where they are', () => {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatch('animations.makeManual', { sheetId: s.id, animationId: anim.id });
  });
  const btnCanvasSize = textButton('Canvas size…', 'Resize every frame of this animation', () => {
    const anim = selectedAnim();
    if (anim?.cell) openSizeForm('resize', anim.cell);
  });
  layoutRow.append(btnAutoLayout, btnMakeManual, btnCanvasSize);

  // ---- size form (Canvas size…, and Auto-layout when frames differ) ----
  const sizeForm = document.createElement('div');
  sizeForm.className = 'anim-form anim-size-form';
  sizeForm.hidden = true;
  const sizeTitle = document.createElement('div');
  sizeTitle.className = 'frame-field';
  const sizeW = numberInput('Canvas width'), sizeH = numberInput('Canvas height');
  const sizeRow = document.createElement('div');
  sizeRow.className = 'row';
  sizeRow.append(labelled('W', sizeW), labelled('H', sizeH));
  const anchorGrid = document.createElement('div');
  anchorGrid.className = 'anchor-grid';
  anchorGrid.title = 'Where the existing pixels sit on the new canvas';
  let anchor = 'c', sizeMode = null;
  const anchorButtons = ANCHORS.map(id => {
    const b = textButton('', id, () => { anchor = id; syncAnchors(); });
    b.dataset.anchor = id;
    return b;
  });
  function syncAnchors() { for (const b of anchorButtons) b.classList.toggle('active', b.dataset.anchor === anchor); }
  anchorGrid.append(...anchorButtons);
  sizeForm.append(sizeTitle, sizeRow, anchorGrid, textButton('Apply', '', () => {
    const s = sheet(), anim = selectedAnim();
    if (!s || !anim) return;
    const w = sizeValue(sizeW), h = sizeValue(sizeH);
    const result = sizeMode === 'resize'
      ? dispatchLayout('animations.resizeCanvas', { sheetId: s.id, animationId: anim.id, w, h, anchor })
      : dispatchLayout('animations.autoLayout', { sheetId: s.id, animationId: anim.id, size: { w, h } });
    if (result?.ok) sizeForm.hidden = true;
  }), textButton('Cancel', '', () => { sizeForm.hidden = true; }));

  function openSizeForm(mode, size) {
    sizeMode = mode;
    anchor = 'c';
    syncAnchors();
    sizeTitle.textContent = mode === 'resize' ? 'Canvas size' : 'Frames differ: lay them out at this size';
    anchorGrid.hidden = mode !== 'resize';
    sizeW.value = String(size?.w ?? 16);
    sizeH.value = String(size?.h ?? 16);
    sizeForm.hidden = false;
  }

  details.append(nameRow, styleRow, durationControl.el, layoutRow, sizeForm);

  const hint = document.createElement('div');
  hint.className = 'frame-field';
  el.append(heading, toolbar, newForm, list, hint, details);

  let lastAnimationId = null;
  function render() {
    if (host.store.getState().session.activeModeId !== 'animations') { el.hidden = true; return; }
    el.hidden = false;
    flatCache.invalidate();
    const s = sheet();
    const anim = selectedAnim();
    if (anim?.id !== lastAnimationId) { sizeForm.hidden = true; lastAnimationId = anim?.id ?? null; }
    list.innerHTML = '';
    s?.animations.forEach(a => list.appendChild(buildRow(s, a, a === anim)));
    hint.hidden = !!anim;
    hint.textContent = !s ? 'No sprite sheet.' : s.animations.length ? 'Select an animation.' : 'No animations yet — click New….';
    details.hidden = !anim;
    btnDuplicate.disabled = anim?.layout !== 'auto';
    btnDuplicate.title = anim && anim.layout !== 'auto' ? 'Auto-layout this animation first' : 'Duplicate the selected animation and its frames';
    btnDelete.disabled = !anim;
    btnNew.disabled = !s;
    if (!s) newForm.hidden = true;
    if (!anim) return;
    nameInput.value = anim.name;
    loopCheckbox.checked = !!anim.loop;
    directionSelect.value = anim.direction ?? 'forward';
    colorInput.value = anim.color ?? DEFAULT_TAG_COLOR;
    colorInput.classList.toggle('unset', !anim.color);
    btnNoColor.disabled = !anim.color;
    durationControl.refresh();
    const auto = anim.layout === 'auto';
    btnAutoLayout.hidden = auto;
    btnMakeManual.hidden = !auto;
    btnCanvasSize.hidden = !auto;
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
