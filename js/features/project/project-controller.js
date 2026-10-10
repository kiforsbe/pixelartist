import { DEFAULT_SETTINGS, newDefaultProject } from '../../core/model.js';
import { PLATFORMS } from '../../core/platforms.js';
import { MAX_PALETTE_COLORS } from '../../core/pixelSnapper.js';
import { buildBaseDurationControl } from '../../components/panels/base-duration-control.js';
import { defineAction } from '../shell/actions.js';
import { markDefaultAction } from '../../components/dialogs.js';
import { getEditorHost } from '../../host/runtime.js';
import { PROJECT_SCOPE } from '../../host/history-service.js';
import { confirmOrAuto } from '../../platform/browser/autotest.js';
import { resetFileSession } from './file-session.js';

// Shared field coercion for the New Project / Project Settings dialogs.
function sheetDimField(el) {
  const v = parseInt(el.value, 10);
  return (Number.isNaN(v) || v < 1) ? null : Math.min(4096, v);
}
function positiveIntField(el) {
  const v = parseInt(el.value, 10);
  return (Number.isNaN(v) || v < 1) ? null : v;
}

export function mountProjectController() {
  const dlgNewProject = document.getElementById('dlg-newproject');
  const npSpriteW = document.getElementById('np-sprite-w');
  const npSpriteH = document.getElementById('np-sprite-h');
  const npTileSheetW = document.getElementById('np-tile-sheet-w');
  const npTileSheetH = document.getElementById('np-tile-sheet-h');
  const npTileW = document.getElementById('np-tile-w');
  const npTileH = document.getElementById('np-tile-h');
  const npFrameW = document.getElementById('np-frame-w');
  const npFrameH = document.getElementById('np-frame-h');
  const npDurationMount = document.getElementById('np-duration-control');
  let npDurationValue = { durationMs: DEFAULT_SETTINGS.durationMs, baseFps: undefined, baseStep: undefined };
  const npDurationControl = buildBaseDurationControl({
    getValue: () => npDurationValue,
    setValue: (v) => { npDurationValue = v; },
  });
  npDurationMount.appendChild(npDurationControl.el);
  const npCreate = document.getElementById('np-create');
  const npCancel = document.getElementById('np-cancel');
  markDefaultAction(dlgNewProject, npCreate);

  // ---- file: New ----
  defineAction('file.new', {
    label: 'New',
    run: () => {
      if (getEditorHost().projects.dirty && !confirmOrAuto('Discard unsaved changes and start a new project?')) return;
      npDurationValue = { durationMs: DEFAULT_SETTINGS.durationMs, baseFps: undefined, baseStep: undefined };
      npDurationControl.refresh();
      dlgNewProject.showModal();
    },
  });
  npCancel.addEventListener('click', () => dlgNewProject.close());
  npCreate.addEventListener('click', () => {
    // Sheet dims (sprite/tile sheet W/H) are clamped to the 1..4096 range;
    // everything else (tile size, frame size) just needs to be a positive
    // integer. Any NaN or sub-1 value aborts with an alert rather than
    // silently coercing, so e.g. a blank or 0 sprite width is rejected.
    // Frame time comes from npDurationControl, which always self-coerces to a
    // valid positive value -- it never needs this validation pass.
    const dims = {
      spriteSheetW: sheetDimField(npSpriteW), spriteSheetH: sheetDimField(npSpriteH),
      tileSheetW: sheetDimField(npTileSheetW), tileSheetH: sheetDimField(npTileSheetH),
      tileW: positiveIntField(npTileW), tileH: positiveIntField(npTileH),
      frameW: positiveIntField(npFrameW), frameH: positiveIntField(npFrameH),
    };
    if (Object.values(dims).some(v => v == null)) {
      alert('Please enter valid positive numbers for all fields.');
      return;
    }
    const settings = {
      ...dims, durationMs: npDurationValue.durationMs,
      ...(npDurationValue.baseFps != null ? { baseFps: npDurationValue.baseFps, baseStep: npDurationValue.baseStep } : {}),
    };
    resetFileSession();
    getEditorHost().history.clear({ markDirty: false });
    getEditorHost().setProject(newDefaultProject(settings), { dirty: false });
    dlgNewProject.close();
  });
  
  // ---- Project Settings ----
  const dlgProjectSettings = document.getElementById('dlg-projectsettings');
  const psName = document.getElementById('ps-name');
  const psSpriteW = document.getElementById('ps-sprite-w');
  const psSpriteH = document.getElementById('ps-sprite-h');
  const psSheetMaxW = document.getElementById('ps-sheet-max-w');
  const psTileSheetW = document.getElementById('ps-tile-sheet-w');
  const psTileSheetH = document.getElementById('ps-tile-sheet-h');
  const psTileW = document.getElementById('ps-tile-w');
  const psTileH = document.getElementById('ps-tile-h');
  const psFrameW = document.getElementById('ps-frame-w');
  const psFrameH = document.getElementById('ps-frame-h');
  const psDurationMount = document.getElementById('ps-duration-control');
  const psSmoothThumbnails = document.getElementById('ps-smooth-thumbnails');
  const psPixelSnapper = document.getElementById('ps-pixel-snapper');
  const psPixelSnapperPalette = document.getElementById('ps-pixel-snapper-palette');
  const psPixelSnapperKColors = document.getElementById('ps-pixel-snapper-kcolors');
  const psPixelSnapperPixelSize = document.getElementById('ps-pixel-snapper-pixelsize');
  // Advanced pixel-snapper tuning fields (Project Settings > Import >
  // Advanced): DOM id suffix, project.settings key, human label (used in the
  // out-of-range alert below). All nine are plain numeric inputs sharing the
  // exact same populate/save/validate shape, so they're driven from this
  // table instead of nine repeats of the same few lines.
  const PS_ADVANCED_FIELDS = [
    ['max-iterations', 'pixelSnapperMaxIterations', 'Max iterations'],
    ['peak-threshold', 'pixelSnapperPeakThreshold', 'Peak threshold'],
    ['peak-distance-filter', 'pixelSnapperPeakDistanceFilter', 'Peak distance filter'],
    ['search-window-ratio', 'pixelSnapperSearchWindowRatio', 'Search window ratio'],
    ['min-search-window', 'pixelSnapperMinSearchWindow', 'Min search window'],
    ['strength-threshold', 'pixelSnapperStrengthThreshold', 'Strength threshold'],
    ['min-cuts-per-axis', 'pixelSnapperMinCutsPerAxis', 'Min cuts per axis'],
    ['fallback-segments', 'pixelSnapperFallbackSegments', 'Fallback segments'],
    ['max-step-ratio', 'pixelSnapperMaxStepRatio', 'Max step ratio'],
  ];
  const psAdvancedInputs = Object.fromEntries(
    PS_ADVANCED_FIELDS.map(([id, key]) => [key, document.getElementById(`ps-ps-${id}`)])
  );
  function psAdvancedValue(key) {
    const v = parseFloat(psAdvancedInputs[key].value);
    return Number.isFinite(v) ? v : DEFAULT_SETTINGS[key];
  }
  // Per-field "reset to default" buttons: hidden unless the field's current
  // value differs from its default, click restores it (nothing is saved
  // until OK, same as any other edit in this dialog). `sync()` re-checks
  // visibility on every edit and is also called once after populating each
  // field in openProjectSettings() below, so a freshly-opened dialog starts
  // with the right buttons already hidden.
  function wireFieldReset(input, resetBtn, defaultStr) {
    const sync = () => { resetBtn.style.display = input.value === defaultStr ? 'none' : ''; };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    resetBtn.addEventListener('click', () => { input.value = defaultStr; sync(); });
    sync();
    return sync;
  }
  const syncPaletteReset = wireFieldReset(psPixelSnapperPalette, document.getElementById('ps-pixel-snapper-palette-reset'), '');
  const syncKColorsReset = wireFieldReset(psPixelSnapperKColors, document.getElementById('ps-pixel-snapper-kcolors-reset'), String(DEFAULT_SETTINGS.pixelSnapperKColors));
  const syncPixelSizeReset = wireFieldReset(psPixelSnapperPixelSize, document.getElementById('ps-pixel-snapper-pixelsize-reset'), '');
  const psAdvancedResetSyncs = Object.fromEntries(PS_ADVANCED_FIELDS.map(([id, key]) =>
    [key, wireFieldReset(psAdvancedInputs[key], document.getElementById(`ps-ps-${id}-reset`), String(DEFAULT_SETTINGS[key]))]));
  // Every pixel-snapper numeric field's own min/max/step (native constraint
  // validation) is the single source of truth for what's permissible --
  // out-of-range values get a visible red outline (see app.css's
  // `.dlg-grid input:invalid` rule) live as you type, via the browser's
  // built-in :invalid styling, no JS needed for that part. Pixel size is
  // exempt while blank (that's "auto", not a number to validate).
  const PS_NUMERIC_FIELDS = [
    ['Colors (k)', psPixelSnapperKColors],
    ['Pixel size', psPixelSnapperPixelSize],
    ...PS_ADVANCED_FIELDS.map(([, key, label]) => [label, psAdvancedInputs[key]]),
  ];
  // Returns the label of the first invalid field, or null if all pass. Used
  // to block OK (see psOk below) instead of silently clamping an
  // out-of-range value to its nearest bound -- a typo like 2048 in a
  // 1-65536 field used to clamp to 256 with no feedback at all, which just
  // looked like "my edit didn't save".
  function firstInvalidPsField() {
    for (const [label, input] of PS_NUMERIC_FIELDS) {
      if (input === psPixelSnapperPixelSize && input.value.trim() === '') continue;
      if (!input.checkValidity()) return { label, input };
    }
    return null;
  }
  const psTargetPlatform = document.getElementById('ps-target-platform');
  for (const [id, p] of Object.entries(PLATFORMS)) psTargetPlatform.appendChild(new Option(p.label, id));
  const psExportColorMode = document.getElementById('ps-export-color-mode');
  const psOk = document.getElementById('ps-ok');
  const psCancel = document.getElementById('ps-cancel');
  markDefaultAction(dlgProjectSettings, psOk);
  
  let psDurationValue = { durationMs: DEFAULT_SETTINGS.durationMs, baseFps: undefined, baseStep: undefined };
  const psDurationControl = buildBaseDurationControl({
    getValue: () => psDurationValue,
    setValue: (v) => { psDurationValue = v; },
  });
  psDurationMount.appendChild(psDurationControl.el);
  
  // Width/height ratio lock for each dimension pair -- locked (default) keeps
  // the pair proportional as either field is edited; the ratio snapshots from
  // whatever's currently in the fields whenever the lock is (re)established,
  // so resnap() lets openProjectSettings() re-anchor it to the freshly loaded
  // project values every time the dialog opens (otherwise editing W after
  // opening would scale H against a stale ratio left over from a previous
  // dialog session or the placeholder markup values).
  function makeDimLock(wInput, hInput, lockBtn) {
    let locked = true;
    let ratio = 1; // H per W
  
    function resnap() {
      const w = parseFloat(wInput.value), h = parseFloat(hInput.value);
      if (w > 0 && h > 0) ratio = h / w;
    }
    function updateVisual() {
      lockBtn.classList.toggle('locked', locked);
      lockBtn.title = locked
        ? 'Width/height locked to this ratio (click to unlock)'
        : 'Width/height independent (click to lock)';
    }
    lockBtn.addEventListener('click', () => {
      locked = !locked;
      if (locked) resnap();
      updateVisual();
    });
    wInput.addEventListener('input', () => {
      if (!locked) return;
      const w = parseFloat(wInput.value);
      if (!Number.isFinite(w) || w <= 0) return;
      hInput.value = String(Math.max(1, Math.round(w * ratio)));
    });
    hInput.addEventListener('input', () => {
      if (!locked) return;
      const h = parseFloat(hInput.value);
      if (!Number.isFinite(h) || h <= 0) return;
      wInput.value = String(Math.max(1, Math.round(h / ratio)));
    });
    resnap();
    updateVisual();
    return { resnap };
  }
  const psSpriteLock = makeDimLock(psSpriteW, psSpriteH, document.getElementById('ps-sprite-lock'));
  const psTileSheetLock = makeDimLock(psTileSheetW, psTileSheetH, document.getElementById('ps-tilesheet-lock'));
  const psTileSizeLock = makeDimLock(psTileW, psTileH, document.getElementById('ps-tile-lock'));
  const psFrameLock = makeDimLock(psFrameW, psFrameH, document.getElementById('ps-frame-lock'));
  
  // ---- Project Settings: tabs ----
  // Two pages sharing one OK/Cancel: General (dims/name/duration, an undoable
  // command) and Onion Steps (per-step onion-skin color overrides, moved here
  // from a standalone dialog the frame editor used to own -- see
  // frameeditor.js's btnStepColors). OK commits BOTH pages' current field
  // values regardless of which page is on screen, so flipping tabs before
  // saving never loses an edit made on the other one.
  const psTabGeneral = document.getElementById('ps-tab-general');
  const psTabImport = document.getElementById('ps-tab-import');
  const psTabOnion = document.getElementById('ps-tab-onion');
  const psPageGeneral = document.getElementById('ps-page-general');
  const psPageImport = document.getElementById('ps-page-import');
  const psPageOnion = document.getElementById('ps-page-onion');
  const psOnionGrid = document.getElementById('ps-onion-grid');
  
  function showProjectSettingsTab(tab) {
    psTabGeneral.classList.toggle('active', tab === 'general');
    psTabImport.classList.toggle('active', tab === 'import');
    psTabOnion.classList.toggle('active', tab === 'onion');
    psPageGeneral.hidden = tab !== 'general';
    psPageImport.hidden = tab !== 'import';
    psPageOnion.hidden = tab !== 'onion';
  }
  psTabGeneral.addEventListener('click', () => showProjectSettingsTab('general'));
  psTabImport.addEventListener('click', () => showProjectSettingsTab('import'));
  psTabOnion.addEventListener('click', () => showProjectSettingsTab('onion'));
  
  // Dims a step's color swatch while its "Default" checkbox is checked, so
  // it visibly reads as "not in effect" rather than just an unrelated pair of
  // controls next to each other.
  function syncOnionStepActive(defaultCb, colorInput) {
    colorInput.classList.toggle('onion-steps-color-inactive', defaultCb.checked);
  }
  
  // Builds the 8-row Back/Ahead step-color grid once; returns the per-row
  // field refs used to populate on open and read back on OK. Two header rows
  // (direction, then Default/Color) so it's unambiguous what each checkbox
  // means: checked = "use the toolbar's Back/Ahead color for this step" (the
  // Color swatch beside it is then just a disabled preview of that), unchecked
  // = "use this step's own Color swatch".
  function buildOnionStepsGrid(grid) {
    const backHeader = document.createElement('span');
    backHeader.className = 'onion-steps-header'; backHeader.textContent = 'Back';
    backHeader.style.gridColumn = 'span 2';
    const aheadHeader = document.createElement('span');
    aheadHeader.className = 'onion-steps-header'; aheadHeader.textContent = 'Ahead';
    aheadHeader.style.gridColumn = 'span 2';
    grid.append(document.createElement('span'), backHeader, aheadHeader);
  
    const subHeader = () => {
      const el = document.createElement('span');
      el.className = 'onion-steps-subheader';
      return el;
    };
    const backDefaultHeader = subHeader(); backDefaultHeader.textContent = 'Default';
    const backColorHeader = subHeader(); backColorHeader.textContent = 'Color';
    const aheadDefaultHeader = subHeader(); aheadDefaultHeader.textContent = 'Default';
    const aheadColorHeader = subHeader(); aheadColorHeader.textContent = 'Color';
    grid.append(subHeader(), backDefaultHeader, backColorHeader, aheadDefaultHeader, aheadColorHeader);
  
    const rows = [];
    for (let k = 1; k <= 8; k++) {
      const stepLabel = document.createElement('span');
      stepLabel.className = 'onion-steps-step'; stepLabel.textContent = String(k);
  
      const backDefault = document.createElement('input');
      backDefault.type = 'checkbox';
      backDefault.title = 'Checked: this step uses the Back toolbar color. Unchecked: it uses its own color swatch.';
      const backColor = document.createElement('input');
      backColor.type = 'color';
      backColor.title = "This step's own color (only used while Default is unchecked)";
      backColor.addEventListener('input', () => { backDefault.checked = false; syncOnionStepActive(backDefault, backColor); });
      backDefault.addEventListener('change', () => syncOnionStepActive(backDefault, backColor));
  
      const aheadDefault = document.createElement('input');
      aheadDefault.type = 'checkbox';
      aheadDefault.title = 'Checked: this step uses the Ahead toolbar color. Unchecked: it uses its own color swatch.';
      const aheadColor = document.createElement('input');
      aheadColor.type = 'color';
      aheadColor.title = "This step's own color (only used while Default is unchecked)";
      aheadColor.addEventListener('input', () => { aheadDefault.checked = false; syncOnionStepActive(aheadDefault, aheadColor); });
      aheadDefault.addEventListener('change', () => syncOnionStepActive(aheadDefault, aheadColor));
  
      grid.append(stepLabel, backDefault, backColor, aheadDefault, aheadColor);
      rows.push({ k, backDefault, backColor, aheadDefault, aheadColor });
    }
    return rows;
  }
  const onionStepRows = buildOnionStepsGrid(psOnionGrid);
  
  function openProjectSettings(tab) {
    const project = getEditorHost().projects.project;
    if (!project) return;
    const settings = project.settings;
    psName.value = project.name;
    psSpriteW.value = String(settings.spriteSheetW);
    psSpriteH.value = String(settings.spriteSheetH);
    psSheetMaxW.value = String(settings.sheetMaxWidth ?? settings.spriteSheetW);
    psTileSheetW.value = String(settings.tileSheetW);
    psTileSheetH.value = String(settings.tileSheetH);
    psTileW.value = String(settings.tileW);
    psTileH.value = String(settings.tileH);
    psFrameW.value = String(settings.frameW);
    psFrameH.value = String(settings.frameH);
    psSmoothThumbnails.checked = settings.smoothThumbnails !== false;
    psPixelSnapper.checked = settings.pixelSnapperEnabled === true;
    psPixelSnapperPalette.innerHTML = '';
    psPixelSnapperPalette.appendChild(new Option('(active palette)', ''));
    psPixelSnapperPalette.appendChild(new Option('(none — full RGB)', 'none'));
    for (const p of project.palettes) psPixelSnapperPalette.appendChild(new Option(p.name, p.id));
    psPixelSnapperPalette.value = settings.pixelSnapperPaletteId ?? '';
    syncPaletteReset();
    psPixelSnapperKColors.value = String(settings.pixelSnapperKColors ?? MAX_PALETTE_COLORS);
    syncKColorsReset();
    psPixelSnapperPixelSize.value = settings.pixelSnapperPixelSizeOverride != null ? String(settings.pixelSnapperPixelSizeOverride) : '';
    syncPixelSizeReset();
    for (const [, key] of PS_ADVANCED_FIELDS) {
      psAdvancedInputs[key].value = String(settings[key] ?? DEFAULT_SETTINGS[key]);
      psAdvancedResetSyncs[key]();
    }
    psTargetPlatform.value = settings.targetPlatform ?? 'none';
    psExportColorMode.value = settings.exportColorMode ?? 'strict';
    psSpriteLock.resnap();
    psTileSheetLock.resnap();
    psTileSizeLock.resnap();
    psFrameLock.resnap();
    psDurationValue = { durationMs: settings.durationMs, baseFps: settings.baseFps, baseStep: settings.baseStep };
    psDurationControl.refresh();
    const onion = getEditorHost().projects.project.settings.onion;
    for (const r of onionStepRows) {
      const backOverride = onion.stepColors.back[r.k];
      r.backDefault.checked = backOverride == null;
      r.backColor.value = backOverride ?? onion.backColor;
      syncOnionStepActive(r.backDefault, r.backColor);
      const aheadOverride = onion.stepColors.ahead[r.k];
      r.aheadDefault.checked = aheadOverride == null;
      r.aheadColor.value = aheadOverride ?? onion.aheadColor;
      syncOnionStepActive(r.aheadDefault, r.aheadColor);
    }
    showProjectSettingsTab(tab);
    dlgProjectSettings.showModal();
  }
  
  defineAction('edit.projectSettings', {
    label: 'Project Settings…',
    run: () => openProjectSettings('general'),
    isEnabled: () => !!getEditorHost().projects.project,
  });
  defineAction('edit.onionStepColors', {
    label: 'Onion Step Colors…',
    run: () => openProjectSettings('onion'),
    isEnabled: () => !!getEditorHost().projects.project,
  });
  psCancel.addEventListener('click', () => dlgProjectSettings.close());
  psOk.addEventListener('click', () => {
    const project = getEditorHost().projects.project;
    if (!project) { dlgProjectSettings.close(); return; }
    const name = psName.value.trim();
    if (!name) {
      alert('Please enter a project name.');
      return;
    }
    const dims = {
      spriteSheetW: sheetDimField(psSpriteW), spriteSheetH: sheetDimField(psSpriteH),
      sheetMaxWidth: sheetDimField(psSheetMaxW),
      tileSheetW: sheetDimField(psTileSheetW), tileSheetH: sheetDimField(psTileSheetH),
      tileW: positiveIntField(psTileW), tileH: positiveIntField(psTileH),
      frameW: positiveIntField(psFrameW), frameH: positiveIntField(psFrameH),
    };
    if (Object.values(dims).some(v => v == null)) {
      alert('Please enter valid positive numbers for all fields.');
      return;
    }
    const invalidPs = firstInvalidPsField();
    if (invalidPs) {
      const step = invalidPs.input.step;
      const stepNote = (step && step !== '1' && step !== 'any') ? `, step ${step}` : '';
      alert(`"${invalidPs.label}" is ${invalidPs.input.validationMessage || 'not a valid value'} (allowed: ${invalidPs.input.min}–${invalidPs.input.max}${stepNote}).`);
      invalidPs.input.focus();
      return;
    }
    const beforeName = project.name;
    const beforeSettings = { ...project.settings };
    // Preserve every OTHER settings field (onion, etc.) verbatim -- this dialog
    // only edits dims/duration/name, so starting from a bare `{...dims, ...}`
    // object here would silently drop anything it doesn't know about (bit us
    // once already: onion-skin prefs got wiped on every Project Settings save).
    // baseFps/baseStep are the one exception: they need to be explicitly
    // dropped, not carried over, when switching back to plain ms mode, or a
    // stale fps-mode value would leak back in since the dims spread below
    // never overwrites them with anything absent.
    const { baseFps: _droppedBaseFps, baseStep: _droppedBaseStep, ...restSettings } = project.settings;
    const afterName = name;
    const afterSettings = {
      ...restSettings, ...dims, durationMs: psDurationValue.durationMs,
      ...(psDurationValue.baseFps != null ? { baseFps: psDurationValue.baseFps, baseStep: psDurationValue.baseStep } : {}),
      smoothThumbnails: psSmoothThumbnails.checked,
      pixelSnapperEnabled: psPixelSnapper.checked,
      pixelSnapperPaletteId: psPixelSnapperPalette.value,
      // firstInvalidPsField() already blocked save (above) if either of
      // these were out of range, so a plain parseInt here is exactly what
      // was typed/left -- no silent clamping.
      pixelSnapperKColors: parseInt(psPixelSnapperKColors.value, 10),
      pixelSnapperPixelSizeOverride: psPixelSnapperPixelSize.value.trim() === '' ? null : parseInt(psPixelSnapperPixelSize.value, 10),
      ...Object.fromEntries(PS_ADVANCED_FIELDS.map(([, key]) => [key, psAdvancedValue(key)])),
      targetPlatform: psTargetPlatform.value,
      exportColorMode: psExportColorMode.value,
    };
    getEditorHost().history.execute({
      label: 'edit project settings',
      do() { project.name = afterName; project.settings = { ...afterSettings }; },
      undo() { project.name = beforeName; project.settings = { ...beforeSettings }; },
    }, { scope: PROJECT_SCOPE });
    // Onion step colors are live-mutated project settings (never go through the undo
    // stack, same as every other onion field
    // comment), applied here alongside the undoable dims/name command so one
    // OK commits everything the dialog showed, on whichever tab it's on.
    const stepColors = { back: {}, ahead: {} };
    for (const r of onionStepRows) {
      if (!r.backDefault.checked) stepColors.back[r.k] = r.backColor.value;
      if (!r.aheadDefault.checked) stepColors.ahead[r.k] = r.aheadColor.value;
    }
    getEditorHost().projects.project.settings.onion.stepColors = stepColors;
    getEditorHost().projects.markDirty();
    dlgProjectSettings.close();
  });
}
