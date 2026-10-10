// js/components/canvas/onion-controls.js
// The onion-skin control cluster shared by the Frame Editor and the
// Animations canvas: enable, current-frame fade, Mask/Outline toggles, and
// per-direction (Back/Ahead) count, colour and alpha, plus the per-step
// colours button. Every control edits project.settings.onion directly --
// a display preference, not editing history (no undo entry), matching the
// brush settings.
import { getEditorHost } from '../../host/runtime.js';
import { runAction } from '../../features/shell/actions.js';

function onionSettings() { return getEditorHost().projects.project?.settings?.onion ?? null; }

// Bare 0..1 alpha slider -- no text label or numeric readout, just the
// slider itself with a tooltip; reused for every onion opacity setting.
// `input` fires live while dragging (no undo tracking needed for this
// ephemeral display preference).
function alphaSlider(title) {
  const input = document.createElement('input');
  input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '0.05';
  input.className = 'frame-editor-alpha';
  input.title = title;
  return input;
}

// A bare alpha slider paired tightly with a small glyph identifying which
// onion mode it controls (■ = Mask's filled silhouette, □ = Outline's edge
// trace), so the Back/Ahead groups' two unlabeled sliders are
// distinguishable at a glance.
function iconSlider(glyph, title) {
  const icon = document.createElement('span');
  icon.className = 'frame-editor-onion-icon';
  icon.textContent = glyph;
  icon.title = title;
  const input = alphaSlider(title);
  const wrap = document.createElement('span');
  wrap.className = 'frame-editor-onion-icon-slider';
  wrap.append(icon, input);
  return { wrap, input };
}

function checkboxLabel(text, title = '') {
  const input = document.createElement('input');
  input.type = 'checkbox';
  const label = document.createElement('label');
  label.className = 'frame-editor-onion';
  if (title) label.title = title;
  label.append(input, document.createTextNode(text));
  return { label, input };
}

// `onChange` repaints the owning canvas after a control changed a setting.
export function buildOnionControls({ onChange }) {
  const onion = checkboxLabel('Onion');

  // Fades the CURRENTLY EDITED frame's own pixels (only while onion skin is
  // enabled) so ghosts -- especially the Outline trace -- read more clearly
  // against it. 1 = no fade (default).
  const currentAlphaInput = alphaSlider("Opacity of the frame you're editing (fade it to make onion ghosts stand out)");

  // Mask and Outline are independent toggles (both, either, or neither can be
  // on); each direction gets its OWN alpha sliders so past and future ghosts
  // can be dialed independently.
  const mask = checkboxLabel('Mask', 'Tint the ghost frame\'s whole silhouette');
  const outline = checkboxLabel('Outline', 'Trace just the ghost frame\'s edge');

  const backInput = document.createElement('input');
  backInput.type = 'number'; backInput.min = '0'; backInput.max = '8'; backInput.title = 'Frames back';
  // Base color for every "back" (past) ghost step; a step's own color wins
  // when set on Project Settings' Onion Steps page (see resolveStepColor()).
  const backColorInput = document.createElement('input');
  backColorInput.type = 'color';
  backColorInput.title = 'Back (past) ghost color';
  const backMaskAlpha = iconSlider('■', 'Mask opacity for past ghosts');
  const backOutlineAlpha = iconSlider('□', 'Outline opacity for past ghosts');
  const backLabel = document.createElement('label');
  backLabel.className = 'frame-editor-onion';
  backLabel.append(document.createTextNode('Back'), backInput, backColorInput);

  const aheadInput = document.createElement('input');
  aheadInput.type = 'number'; aheadInput.min = '0'; aheadInput.max = '8'; aheadInput.title = 'Frames ahead';
  const aheadColorInput = document.createElement('input');
  aheadColorInput.type = 'color';
  aheadColorInput.title = 'Ahead (future) ghost color';
  const aheadMaskAlpha = iconSlider('■', 'Mask opacity for future ghosts');
  const aheadOutlineAlpha = iconSlider('□', 'Outline opacity for future ghosts');
  const aheadLabel = document.createElement('label');
  aheadLabel.className = 'frame-editor-onion';
  aheadLabel.append(document.createTextNode('Ahead'), aheadInput, aheadColorInput);

  // Opens the per-step (per-distance-k) color overrides on Project
  // Settings' Onion Steps page. Applies to both directions, so it sits after
  // both sub-groups.
  const btnStepColors = document.createElement('button');
  btnStepColors.type = 'button'; btnStepColors.className = 'btn-icon-md';
  btnStepColors.textContent = '⚙';
  btnStepColors.title = 'Per-step onion colors… (Project Settings)';
  btnStepColors.addEventListener('click', () => runAction('edit.onionStepColors'));

  // Three sub-groups so related controls read together: overall settings,
  // then Back/past-only, then Ahead/future-only.
  const element = document.createElement('div');
  element.className = 'frame-editor-onion-group';
  const mainGroup = document.createElement('div');
  mainGroup.className = 'frame-editor-onion-sub';
  mainGroup.append(onion.label, currentAlphaInput, mask.label, outline.label);
  const pastGroup = document.createElement('div');
  pastGroup.className = 'frame-editor-onion-sub frame-editor-onion-past';
  pastGroup.append(backLabel, backMaskAlpha.wrap, backOutlineAlpha.wrap);
  const aheadGroup = document.createElement('div');
  aheadGroup.className = 'frame-editor-onion-sub frame-editor-onion-ahead';
  aheadGroup.append(aheadLabel, aheadMaskAlpha.wrap, aheadOutlineAlpha.wrap);
  element.append(mainGroup, pastGroup, aheadGroup, btnStepColors);

  // The codebase's live-preview/commit split: 'input' updates state +
  // repaints immediately while dragging, while 'change' (release / toggle
  // settle) is the only point that calls markDirty(), so the dirty flag
  // doesn't thrash on every drag tick but the final value still persists.
  function bindField(input, apply, { eager = false } = {}) {
    input.addEventListener(eager ? 'input' : 'change', () => { apply(); onChange(); });
    input.addEventListener('change', () => getEditorHost().projects.markDirty());
  }
  bindField(onion.input, () => { onionSettings().enabled = onion.input.checked; });
  bindField(mask.input, () => { onionSettings().mask = mask.input.checked; });
  bindField(outline.input, () => { onionSettings().outline = outline.input.checked; });

  function bindAlpha(input, key) {
    bindField(input, () => {
      let v = parseFloat(input.value);
      if (!Number.isFinite(v)) v = 1;
      onionSettings()[key] = Math.max(0, Math.min(1, v));
    }, { eager: true });
  }
  bindAlpha(currentAlphaInput, 'currentAlpha');
  bindAlpha(backMaskAlpha.input, 'backMaskAlpha');
  bindAlpha(backOutlineAlpha.input, 'backOutlineAlpha');
  bindAlpha(aheadMaskAlpha.input, 'aheadMaskAlpha');
  bindAlpha(aheadOutlineAlpha.input, 'aheadOutlineAlpha');

  function bindCount(input, key) {
    bindField(input, () => {
      let v = parseInt(input.value, 10);
      if (!Number.isFinite(v)) v = 1;
      v = Math.max(0, Math.min(8, v));
      input.value = String(v);
      onionSettings()[key] = v;
    });
  }
  bindCount(backInput, 'back');
  bindCount(aheadInput, 'ahead');

  bindField(backColorInput, () => { onionSettings().backColor = backColorInput.value; }, { eager: true });
  bindField(aheadColorInput, () => { onionSettings().aheadColor = aheadColorInput.value; }, { eager: true });

  function sync() {
    const settings = onionSettings();
    if (!settings) return;
    onion.input.checked = settings.enabled;
    currentAlphaInput.value = String(settings.currentAlpha);
    mask.input.checked = settings.mask;
    outline.input.checked = settings.outline;
    backInput.value = String(settings.back);
    aheadInput.value = String(settings.ahead);
    backColorInput.value = settings.backColor;
    backMaskAlpha.input.value = String(settings.backMaskAlpha);
    backOutlineAlpha.input.value = String(settings.backOutlineAlpha);
    aheadColorInput.value = settings.aheadColor;
    aheadMaskAlpha.input.value = String(settings.aheadMaskAlpha);
    aheadOutlineAlpha.input.value = String(settings.aheadOutlineAlpha);
  }

  return { element, sync };
}
