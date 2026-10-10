import { MAX_PALETTE_COLORS } from '../../core/pixelSnapper.js';
import { copyRegion, cloneBitmap, blitRegion } from '../../core/pixels.js';
import { commitFloatIfAny, currentEditRegion } from '../../components/canvas/float-session.js';
import { getEditorHost } from '../../host/runtime.js';
import { activeSheet, activeEditableLayer, activeLayerScope, currentContextLayers } from '../../host/document-helpers.js';
import { medianCutPalette, resolveAlphaForQuantize, findMinimalColorCount } from '../../core/quantize.js';
import { quantizeBitmapToPalette } from '../../core/palettes.js';
import { chromaKeyBitmap, distanceHistogram, percentToRadius } from '../../core/chromakey.js';
import { checkerboardRemoveBitmap, checkerboardObjectHint, detectCheckerboardColors, estimateCheckerCellSize, detectGuideLines, removeGuideLines } from '../../core/checkerboard.js';
import { armColorSample, cancelColorSample } from '../../components/canvas/drawing-engine.js';
import { rgbaToHex, hexToRgb } from '../../components/color-utils.js';
import { SYSTEM_PALETTES } from '../../core/systempalettes.js';
import { previewWithOverride, refreshPreviewPanel } from '../../components/panels/preview-panel.js';
import { defineAction } from '../shell/actions.js';
import { markDefaultAction, makeDialogMovable, centerDialog, closeOnEscape } from '../../components/dialogs.js';

// Overlay used to show which pixels an object hint is protecting. Blended
// rather than painted flat, so the artwork stays readable underneath -- the
// whole question the overlay answers is "did my mark catch the outline",
// which you cannot see if the outline is hidden under solid color. Pixels
// the filter cleared but the mask still covers (a mark dropped on bare
// background) are painted solid, since there is nothing left to blend with.
const PROTECT_OVERLAY_COLOR = [0, 224, 255];
const PROTECT_OVERLAY_STRENGTH = 0.45;
function tintProtectedPixels(bmp, mask) {
  const out = cloneBitmap(bmp);
  if (!mask) return out;
  const [tr, tg, tb] = PROTECT_OVERLAY_COLOR;
  const { data } = out;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (!mask[p]) continue;
    if (data[i + 3] === 0) {
      data[i] = tr; data[i + 1] = tg; data[i + 2] = tb; data[i + 3] = 255;
      continue;
    }
    data[i] = Math.round(data[i] + (tr - data[i]) * PROTECT_OVERLAY_STRENGTH);
    data[i + 1] = Math.round(data[i + 1] + (tg - data[i + 1]) * PROTECT_OVERLAY_STRENGTH);
    data[i + 2] = Math.round(data[i + 2] + (tb - data[i + 2]) * PROTECT_OVERLAY_STRENGTH);
  }
  return out;
}

function project() { return getEditorHost().projects.project; }
function drawingSettings() { return getEditorHost().store.getState().workspace.drawing; }
function notifyPixelsChanged() { getEditorHost().store.notifyPixelsChanged(); }

export function mountFilterController(workbench) {
  // ---- shared filter-preview plumbing (chroma key + quantize) ----
  
  // Builds a layers array suitable for flattenSheetLayers/previewWithOverride:
  // every layer in currentContextLayers() passes through unchanged EXCEPT
  // layers with a patch, which get a shallow-cloned layer object wrapping a
  // bitmap clone with `after` blitted into `region` -- real layer data is
  // never touched by a preview.
  function buildPreviewLayers(region, patches) {
    const byId = new Map(patches.map(p => [p.layer.id, p]));
    return currentContextLayers().map(l => {
      const p = byId.get(l.id);
      if (!p) return l;
      const bitmap = cloneBitmap(l.bitmap);
      blitRegion(bitmap, p.after, region.x, region.y);
      return { ...l, bitmap };
    });
  }
  
  // result: { region, patches } as returned by computeQuantizePatches/
  // computeChromaKeyPatches, or null. Pushes a live preview of the
  // not-yet-committed edit into BOTH the Preview panel and the main canvas,
  // or drops back to real state in both when there's nothing to preview
  // (e.g. no layer selected).
  function pushLivePreview(result) {
    if (!result || !result.patches.length) { refreshPreviewPanel(); workbench.clearCanvasPreview(); return; }
    const layers = buildPreviewLayers(result.region, result.patches);
    previewWithOverride(layers);
    workbench.pushCanvasPreview(layers);
  }
  
  // ---- quantize to palette ----
  function bitmapsEqual(a, b) {
    if (a.data.length !== b.data.length) return false;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
    return true;
  }
  
  // Pure compute half: resolves the target region/layers and returns
  // { region, patches } with no-op layers filtered out -- shared by the real
  // commit (quantizeToPalette) and the dialog's live preview. Returns null
  // when there's no sheet/region/layer/color to operate on.
  function computeQuantizePatches(mode, param, allLayers, preferOpaque = false, weightExponent = 1, dither = 'none', refine = true) {
    const sheet = activeSheet();
    if (!sheet) return null;
    const rr = currentEditRegion();
    if (!rr) return null;
    const { region } = rr;
    const layers = allLayers ? activeLayerScope() : (activeEditableLayer() ? [activeEditableLayer()] : []);
    if (!layers.length) return null;
    const befores = layers.map(l => copyRegion(l.bitmap, region.x, region.y, region.w, region.h));
    const quantizeSource = (mode === 'count' && preferOpaque) ? resolveAlphaForQuantize(befores, param) : befores;
    const colors = mode === 'count'
      ? medianCutPalette(quantizeSource, param, weightExponent, refine).map(c => [c[0], c[1], c[2], 255])
      : param;
    if (!colors.length) return null;
    const palette = { colors };
    const patches = layers.map((l, i) => {
      const before = befores[i];
      const after = cloneBitmap(quantizeSource[i]);
      quantizeBitmapToPalette(after, palette, dither);
      return { layer: l, before, after };
    }).filter(p => !bitmapsEqual(p.before, p.after));
    return { region, patches, colors };
  }

  // Duplicates computeQuantizePatches's own region/layer resolution (matching
  // computeChromaKeyPatches/computeCheckerboardPatches, which each do the
  // same) so the auto-count search can run before the color count it needs
  // even exists. Falls back to `ceiling` itself whenever there's nothing to
  // search against.
  function findAutoColorCount(ceiling, allLayers, preferOpaque, weightExponent, targetPercent, refine) {
    const sheet = activeSheet();
    if (!sheet) return ceiling;
    const rr = currentEditRegion();
    if (!rr) return ceiling;
    const { region } = rr;
    const layers = allLayers ? activeLayerScope() : (activeEditableLayer() ? [activeEditableLayer()] : []);
    if (!layers.length) return ceiling;
    const befores = layers.map(l => copyRegion(l.bitmap, region.x, region.y, region.w, region.h));
    const quantizeSource = preferOpaque ? resolveAlphaForQuantize(befores, ceiling) : befores;
    return findMinimalColorCount(quantizeSource, ceiling, weightExponent, targetPercent, refine);
  }

  function quantizeToPalette(mode, param, allLayers, preferOpaque = false, weightExponent = 1, dither = 'none', refine = true) {
    commitFloatIfAny();
    const result = computeQuantizePatches(mode, param, allLayers, preferOpaque, weightExponent, dither, refine);
    if (!result || !result.patches.length) return;
    const { region, patches } = result;
    getEditorHost().history.execute({
      label: 'quantize to palette',
      do() { for (const p of patches) blitRegion(p.layer.bitmap, p.after, region.x, region.y); notifyPixelsChanged(); },
      undo() { for (const p of patches) blitRegion(p.layer.bitmap, p.before, region.x, region.y); notifyPixelsChanged(); },
    });
    getEditorHost().projects.markDirty();
  }
  
  const dlgQuantize = document.getElementById('dlg-quantize');
  const qzModePalette = document.getElementById('qz-mode-palette');
  const qzModeCount = document.getElementById('qz-mode-count');
  const qzPaletteRow = document.getElementById('qz-palette-row');
  const qzCountRow = document.getElementById('qz-count-row');
  const qzAutoCount = document.getElementById('qz-auto-count');
  const qzAutoTargetRow = document.getElementById('qz-auto-target-row');
  const qzAutoTarget = document.getElementById('qz-auto-target');
  const qzAutoTargetVal = document.getElementById('qz-auto-target-val');
  const qzBalanceRow = document.getElementById('qz-balance-row');
  const qzBalance = document.getElementById('qz-balance');
  const qzPerceptualRow = document.getElementById('qz-perceptual-row');
  const qzPerceptual = document.getElementById('qz-perceptual');
  const qzCountPreviewRow = document.getElementById('qz-count-preview-row');
  const qzCountPreview = document.getElementById('qz-count-preview');
  const qzPreferOpaqueRow = document.getElementById('qz-prefer-opaque-row');
  const qzPalette = document.getElementById('qz-palette');
  const qzCount = document.getElementById('qz-count');
  const qzPreferOpaque = document.getElementById('qz-prefer-opaque');
  const qzDither = document.getElementById('qz-dither');
  const qzAllLayers = document.getElementById('qz-alllayers');
  const qzOk = document.getElementById('qz-ok');
  const qzCancel = document.getElementById('qz-cancel');
  markDefaultAction(dlgQuantize, qzOk);
  makeDialogMovable(dlgQuantize, dlgQuantize.querySelector('h3'));
  
  function updateQuantizeModeUI() {
    const isCount = qzModeCount.checked;
    qzPaletteRow.hidden = isCount;
    qzCountRow.hidden = !isCount;
    qzBalanceRow.hidden = !isCount;
    qzPerceptualRow.hidden = !isCount;
    qzCountPreviewRow.hidden = !isCount;
    qzPreferOpaqueRow.hidden = !isCount;
    qzAutoTargetRow.hidden = !(isCount && qzAutoCount.checked);
    // Auto and a fixed count are mutually exclusive, not "manual count as a
    // ceiling for the search" -- the field just becomes a read-only readout
    // of whatever count the search settled on.
    qzCount.disabled = isCount && qzAutoCount.checked;
  }
  // Auto mode searches all the way up to MAX_PALETTE_COLORS on its own; the
  // Colors field plays no part in the search, it only displays the result
  // afterwards (see previewQuantize).
  function resolveQuantizeCount() {
    if (qzAutoCount.checked) {
      return findAutoColorCount(MAX_PALETTE_COLORS, qzAllLayers.checked, qzPreferOpaque.checked, Number(qzBalance.value), Number(qzAutoTarget.value), qzPerceptual.checked);
    }
    return Math.max(1, Math.min(256, parseInt(qzCount.value, 10) || 16));
  }
  // Smallest power-of-two column count (capped at 32) whose square covers
  // `n` cells -- i.e. the grid is never more than twice as wide as it is
  // tall. Since cols is the first power of two >= sqrt(n), rows (=
  // ceil(n/cols)) always lands in (cols/4, cols], so the grid normally comes
  // out square (rows == cols) or a 2:1 rectangle (rows == cols/2).
  function maxCellsPerRow(n) {
    let cols = 1;
    while (cols < 32 && cols < Math.sqrt(n)) cols *= 2;
    return cols;
  }
  // Renders the median-cut result as a grid of color chips -- in Count mode
  // the palette is computed on the fly and otherwise invisible until commit,
  // unlike Palette mode where the user already picked a known, inspectable
  // palette.
  function renderQuantizeCountSwatches(colors) {
    qzCountPreview.innerHTML = '';
    qzCountPreview.style.gridTemplateColumns = `repeat(${maxCellsPerRow(colors.length)}, 14px)`;
    for (const c of colors) {
      const sw = document.createElement('span');
      sw.className = 'sys-palette-swatch';
      const hex = rgbaToHex(c);
      sw.style.background = hex;
      sw.title = hex;
      qzCountPreview.appendChild(sw);
    }
  }
  function previewQuantize() {
    let result;
    if (qzModeCount.checked) {
      const n = resolveQuantizeCount();
      // The Colors field plays no part in the auto search -- once it
      // resolves, write the count back in so the field (disabled in this
      // mode) shows what was actually found instead of a stale number.
      if (qzAutoCount.checked) qzCount.value = n;
      result = computeQuantizePatches('count', n, qzAllLayers.checked, qzPreferOpaque.checked, Number(qzBalance.value), qzDither.value, qzPerceptual.checked);
      renderQuantizeCountSwatches(result?.colors ?? []);
    } else {
      const pal = resolveQuantizePalette(qzPalette.value);
      result = pal && pal.colors.length ? computeQuantizePatches('palette', pal.colors, qzAllLayers.checked, false, 1, qzDither.value) : null;
    }
    pushLivePreview(result);
  }
  qzModePalette.addEventListener('change', () => { updateQuantizeModeUI(); previewQuantize(); });
  qzModeCount.addEventListener('change', () => { updateQuantizeModeUI(); previewQuantize(); });
  qzPalette.addEventListener('change', previewQuantize);
  qzCount.addEventListener('input', previewQuantize);
  qzAutoCount.addEventListener('change', () => { updateQuantizeModeUI(); previewQuantize(); });
  qzAutoTarget.addEventListener('input', () => { qzAutoTargetVal.textContent = `${qzAutoTarget.value}%`; previewQuantize(); });
  qzBalance.addEventListener('change', previewQuantize);
  qzPerceptual.addEventListener('change', previewQuantize);
  qzPreferOpaque.addEventListener('change', previewQuantize);
  qzDither.addEventListener('change', previewQuantize);
  qzAllLayers.addEventListener('change', previewQuantize);
  
  function refreshQuantizePaletteOptions() {
    qzPalette.innerHTML = '';
    const projGroup = document.createElement('optgroup');
    projGroup.label = 'Project Palettes';
    for (const p of project()?.palettes ?? []) {
      if (!p.colors.length) continue;
      const o = document.createElement('option');
      o.value = `proj:${p.id}`;
      o.textContent = p.indexed ? `${p.name} (${p.colors.length})` : p.name;
      projGroup.appendChild(o);
    }
    if (projGroup.children.length) qzPalette.appendChild(projGroup);
  
    const sysGroup = document.createElement('optgroup');
    sysGroup.label = 'System Palettes';
    for (const sys of SYSTEM_PALETTES) {
      const o = document.createElement('option');
      o.value = `sys:${sys.name}`;
      o.textContent = `${sys.name} (${sys.colors.length})`;
      sysGroup.appendChild(o);
    }
    qzPalette.appendChild(sysGroup);
  
    const activeOpt = project()?.activePaletteId ? `proj:${project().activePaletteId}` : null;
    if (activeOpt && [...qzPalette.options].some(o => o.value === activeOpt)) qzPalette.value = activeOpt;
    else if (qzPalette.options.length) qzPalette.selectedIndex = 0;
  }
  
  function resolveQuantizePalette(value) {
    if (value.startsWith('proj:')) return project()?.palettes.find(p => p.id === value.slice(5)) ?? null;
    if (value.startsWith('sys:')) return SYSTEM_PALETTES.find(s => s.name === value.slice(4)) ?? null;
    return null;
  }
  
  defineAction('edit.filters', {
    label: 'Filters',
    submenu: [
      { action: 'edit.filters.quantizeToPalette' },
      { action: 'edit.filters.chromaKey' },
      { action: 'edit.filters.checkerboard' },
    ],
    isEnabled: () => !!activeSheet(),
  });
  defineAction('edit.filters.quantizeToPalette', {
    label: 'Quantize to Palette…',
    run: () => {
      refreshQuantizePaletteOptions();
      qzModePalette.checked = true;
      qzBalance.value = '0.5';
      qzPerceptual.checked = true;
      qzAllLayers.checked = false;
      qzPreferOpaque.checked = false;
      qzAutoCount.checked = false;
      qzAutoTarget.value = '97';
      qzAutoTargetVal.textContent = '97%';
      qzDither.value = 'none';
      updateQuantizeModeUI();
      // All filter dialogs are non-modal and share the Preview panel --
      // having more than one open at once would be confusing (whichever
      // dialog's control was touched last "wins" the preview), so opening
      // one closes the others.
      if (dlgChromaKey.open) dlgChromaKey.close();
      if (dlgCheckerboard.open) dlgCheckerboard.close();
      previewQuantize();
      dlgQuantize.show();
      if (!dlgQuantize.style.left) centerDialog(dlgQuantize);
    },
    isEnabled: () => !!activeEditableLayer(),
  });
  function cancelQuantizeDialog() { refreshPreviewPanel(); workbench.clearCanvasPreview(); dlgQuantize.close(); }
  qzCancel.addEventListener('click', cancelQuantizeDialog);
  closeOnEscape(dlgQuantize, cancelQuantizeDialog);
  qzOk.addEventListener('click', () => {
    refreshPreviewPanel();
    workbench.clearCanvasPreview();
    if (qzModeCount.checked) {
      const n = resolveQuantizeCount();
      dlgQuantize.close();
      quantizeToPalette('count', n, qzAllLayers.checked, qzPreferOpaque.checked, Number(qzBalance.value), qzDither.value, qzPerceptual.checked);
    } else {
      const pal = resolveQuantizePalette(qzPalette.value);
      dlgQuantize.close();
      if (!pal || !pal.colors.length) return;
      quantizeToPalette('palette', pal.colors, qzAllLayers.checked, false, 1, qzDither.value);
    }
  });
  
  // ---- chroma key ----
  
  // Pure compute half, mirroring computeQuantizePatches -- shared by the
  // real commit (commitChromaKey), the dialog's live preview, AND its
  // distance histograms (via `befores`, the per-layer region content BEFORE
  // any patch is applied -- kept even for layers whose patch got filtered
  // out below, since a histogram wants the whole region's actual color
  // distribution regardless of which layers the current settings affect).
  function computeChromaKeyPatches(params, allLayers) {
    const sheet = activeSheet();
    if (!sheet) return null;
    const rr = currentEditRegion();
    if (!rr) return null;
    const { region } = rr;
    const layers = allLayers ? activeLayerScope() : (activeEditableLayer() ? [activeEditableLayer()] : []);
    if (!layers.length) return null;
    const befores = layers.map(l => copyRegion(l.bitmap, region.x, region.y, region.w, region.h));
    const patches = layers.map((l, i) => ({ layer: l, before: befores[i], after: chromaKeyBitmap(befores[i], params) }))
      .filter(p => !bitmapsEqual(p.before, p.after));
    return { region, patches, befores };
  }
  
  function commitChromaKey(params, allLayers) {
    commitFloatIfAny();
    const result = computeChromaKeyPatches(params, allLayers);
    if (!result || !result.patches.length) return;
    const { region, patches } = result;
    getEditorHost().history.execute({
      label: 'chroma key',
      do() { for (const p of patches) blitRegion(p.layer.bitmap, p.after, region.x, region.y); notifyPixelsChanged(); },
      undo() { for (const p of patches) blitRegion(p.layer.bitmap, p.before, region.x, region.y); notifyPixelsChanged(); },
    });
    getEditorHost().projects.markDirty();
  }
  
  const dlgChromaKey = document.getElementById('dlg-chromakey');
  const ckColor = document.getElementById('ck-color');
  const ckColorHex = document.getElementById('ck-color-hex');
  const ckColorPrimary = document.getElementById('ck-color-primary');
  const ckColorSecondary = document.getElementById('ck-color-secondary');
  const ckModeTransparent = document.getElementById('ck-mode-transparent');
  const ckModeReplace = document.getElementById('ck-mode-replace');
  const ckModeDespill = document.getElementById('ck-mode-despill');
  const ckReplaceRow = document.getElementById('ck-replace-row');
  const ckReplaceColor = document.getElementById('ck-replace-color');
  const ckReplaceHex = document.getElementById('ck-replace-hex');
  const ckReplacePrimary = document.getElementById('ck-replace-primary');
  const ckReplaceSecondary = document.getElementById('ck-replace-secondary');
  const ckTolerance = document.getElementById('ck-tolerance');
  const ckToleranceVal = document.getElementById('ck-tolerance-val');
  const ckSoftness = document.getElementById('ck-softness');
  const ckSoftnessVal = document.getElementById('ck-softness-val');
  const ckKeyHistogramCanvas = document.getElementById('ck-key-histogram');
  const ckBackgroundOnly = document.getElementById('ck-background-only');
  const ckPreserveSoftShadows = document.getElementById('ck-preserve-soft-shadows');
  const ckProtectEnabled = document.getElementById('ck-protect-enabled');
  const ckProtectRow = document.getElementById('ck-protect-row');
  const ckProtectColor = document.getElementById('ck-protect-color');
  const ckProtectHex = document.getElementById('ck-protect-hex');
  const ckProtectPrimary = document.getElementById('ck-protect-primary');
  const ckProtectSecondary = document.getElementById('ck-protect-secondary');
  const ckProtectTolerance = document.getElementById('ck-protect-tolerance');
  const ckProtectToleranceVal = document.getElementById('ck-protect-tolerance-val');
  const ckProtectSoftness = document.getElementById('ck-protect-softness');
  const ckProtectSoftnessVal = document.getElementById('ck-protect-softness-val');
  const ckProtectHistogramCanvas = document.getElementById('ck-protect-histogram');
  const ckAllLayers = document.getElementById('ck-alllayers');
  const ckOk = document.getElementById('ck-ok');
  const ckCancel = document.getElementById('ck-cancel');
  markDefaultAction(dlgChromaKey, ckOk);
  makeDialogMovable(dlgChromaKey, dlgChromaKey.querySelector('h3'));
  
  function setColorInputs(colorEl, hexEl, rgb) {
    hexEl.value = rgbaToHex(rgb);
    colorEl.value = hexEl.value;
  }
  
  // Reads from the native color inputs (ckColor/ckReplaceColor), not the
  // free-text hex fields -- a <input type="color"> value is ALWAYS a valid
  // lowercase 6-digit hex per spec, whereas the hex text field can be
  // mid-edit and invalid (e.g. OK clicked while it reads "#ff"), which would
  // otherwise feed garbage into hexToRgb.
  function currentChromaKeyParams() {
    return {
      keyColor: hexToRgb(ckColor.value),
      tolerance: Number(ckTolerance.value),
      softness: Number(ckSoftness.value),
      mode: ckModeReplace.checked ? 'replace' : (ckModeDespill.checked ? 'despill' : 'transparent'),
      replacementColor: hexToRgb(ckReplaceColor.value),
      backgroundOnly: ckBackgroundOnly.checked,
      preserveSoftShadows: ckPreserveSoftShadows.checked,
      protectColor: ckProtectEnabled.checked ? hexToRgb(ckProtectColor.value) : null,
      protectTolerance: Number(ckProtectTolerance.value),
      protectSoftness: Number(ckProtectSoftness.value),
    };
  }
  
  function previewChromaKey() {
    pushLivePreview(computeChromaKeyPatches(currentChromaKeyParams(), ckAllLayers.checked));
  }
  
  // Cached per-layer "before" bitmaps for the region/scope the histograms
  // are currently showing, plus their bucketed distance data -- recomputed
  // only when the underlying pixel SAMPLE or reference color could have
  // changed (color pickers, All layers, opening the dialog), not on every
  // tolerance/softness tick: re-walking the whole region on every slider
  // tick would be wasted work the bucket counts don't actually depend on.
  let ckHistogramBefores = [];
  let ckKeyHistogramData = null;
  let ckProtectHistogramData = null;
  
  const CK_HISTOGRAM_TINT_REMOVE = { band: 'rgba(255,90,90,.22)', bar: 'rgba(225,227,235,.85)' };
  const CK_HISTOGRAM_TINT_PROTECT = { band: 'rgba(90,200,140,.25)', bar: 'rgba(225,227,235,.85)' };
  
  // Draws one distance histogram: a solid shaded band from 0..matchDist,
  // fading out from matchDist..edge (the same hard-cutoff/feather split
  // matchStrength itself uses internally), with the region's actual pixel-
  // count-by-distance distribution as bars on top. Bar heights are log-
  // scaled since a background color's own bucket is typically orders of
  // magnitude taller than everything else, which would otherwise flatten
  // every other bucket down to invisible.
  function drawChromaKeyHistogram(canvas, histogram, matchDist, edge, tint) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!histogram) return;
    const { counts, maxDistance } = histogram;
    const matchX = Math.min(w, (matchDist / maxDistance) * w);
    const edgeX = Math.min(w, (edge / maxDistance) * w);
    ctx.fillStyle = tint.band;
    ctx.fillRect(0, 0, matchX, h);
    if (edgeX > matchX) {
      const grad = ctx.createLinearGradient(matchX, 0, edgeX, 0);
      grad.addColorStop(0, tint.band);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(matchX, 0, edgeX - matchX, h);
    }
    const maxCount = Math.max(1, ...counts);
    const barW = w / counts.length;
    ctx.fillStyle = tint.bar;
    for (let i = 0; i < counts.length; i++) {
      if (!counts[i]) continue;
      const barH = Math.round((Math.log(counts[i] + 1) / Math.log(maxCount + 1)) * (h - 2));
      ctx.fillRect(i * barW, h - barH, Math.max(1, barW - 1), barH);
    }
  }
  
  // Redraws both histogram canvases from the CACHED bucket data -- cheap,
  // since tolerance/softness only move the overlay band, not the
  // underlying distribution. Wired to every tolerance/softness input.
  function drawChromaKeyHistograms() {
    const params = currentChromaKeyParams();
    drawChromaKeyHistogram(ckKeyHistogramCanvas, ckKeyHistogramData,
      percentToRadius(params.tolerance), percentToRadius(params.tolerance) + percentToRadius(params.softness), CK_HISTOGRAM_TINT_REMOVE);
    if (ckProtectEnabled.checked) {
      drawChromaKeyHistogram(ckProtectHistogramCanvas, ckProtectHistogramData,
        percentToRadius(params.protectTolerance), percentToRadius(params.protectTolerance) + percentToRadius(params.protectSoftness), CK_HISTOGRAM_TINT_PROTECT);
    }
  }
  
  // Re-walks the current region (via computeChromaKeyPatches's `befores`)
  // to rebuild both histograms' bucket data, then redraws. Wired to
  // whatever can change WHICH pixels are being sampled or WHICH color
  // they're measured against: color pickers, All layers, opening the
  // dialog -- not tolerance/softness, see drawChromaKeyHistograms.
  function refreshChromaKeyHistograms() {
    const params = currentChromaKeyParams();
    const result = computeChromaKeyPatches(params, ckAllLayers.checked);
    ckHistogramBefores = result?.befores ?? [];
    ckKeyHistogramData = ckHistogramBefores.length ? distanceHistogram(ckHistogramBefores, params.keyColor) : null;
    ckProtectHistogramData = (ckProtectEnabled.checked && ckHistogramBefores.length)
      ? distanceHistogram(ckHistogramBefores, params.protectColor) : null;
    drawChromaKeyHistograms();
  }
  
  ckColor.addEventListener('input', () => { ckColorHex.value = ckColor.value; previewChromaKey(); refreshChromaKeyHistograms(); });
  ckColorHex.addEventListener('input', () => {
    if (!/^#[0-9a-fA-F]{6}$/.test(ckColorHex.value)) return;
    // <input type="color">.value must be lowercase per the HTML "simple color"
    // spec -- assigning mixed-/upper-case hex silently resets it to black in
    // strict implementations, so normalize before assigning.
    ckColor.value = ckColorHex.value.toLowerCase();
    previewChromaKey();
    refreshChromaKeyHistograms();
  });
  ckColorPrimary.addEventListener('click', () => { setColorInputs(ckColor, ckColorHex, drawingSettings().primary); previewChromaKey(); refreshChromaKeyHistograms(); });
  ckColorSecondary.addEventListener('click', () => { setColorInputs(ckColor, ckColorHex, drawingSettings().secondary); previewChromaKey(); refreshChromaKeyHistograms(); });
  
  ckReplaceColor.addEventListener('input', () => { ckReplaceHex.value = ckReplaceColor.value; previewChromaKey(); });
  ckReplaceHex.addEventListener('input', () => {
    if (!/^#[0-9a-fA-F]{6}$/.test(ckReplaceHex.value)) return;
    ckReplaceColor.value = ckReplaceHex.value.toLowerCase();
    previewChromaKey();
  });
  ckReplacePrimary.addEventListener('click', () => { setColorInputs(ckReplaceColor, ckReplaceHex, drawingSettings().primary); previewChromaKey(); });
  ckReplaceSecondary.addEventListener('click', () => { setColorInputs(ckReplaceColor, ckReplaceHex, drawingSettings().secondary); previewChromaKey(); });
  
  function updateChromaKeyModeUI() {
    ckReplaceRow.hidden = !ckModeReplace.checked;
  }
  ckModeTransparent.addEventListener('change', () => { updateChromaKeyModeUI(); previewChromaKey(); });
  ckModeReplace.addEventListener('change', () => { updateChromaKeyModeUI(); previewChromaKey(); });
  ckModeDespill.addEventListener('change', () => { updateChromaKeyModeUI(); previewChromaKey(); });
  
  ckTolerance.addEventListener('input', () => { ckToleranceVal.textContent = ckTolerance.value; previewChromaKey(); drawChromaKeyHistograms(); });
  ckSoftness.addEventListener('input', () => { ckSoftnessVal.textContent = ckSoftness.value; previewChromaKey(); drawChromaKeyHistograms(); });
  ckBackgroundOnly.addEventListener('change', previewChromaKey);
  ckPreserveSoftShadows.addEventListener('change', previewChromaKey);
  
  function updateChromaKeyProtectUI() {
    ckProtectRow.hidden = !ckProtectEnabled.checked;
  }
  ckProtectEnabled.addEventListener('change', () => { updateChromaKeyProtectUI(); previewChromaKey(); refreshChromaKeyHistograms(); });
  ckProtectColor.addEventListener('input', () => { ckProtectHex.value = ckProtectColor.value; previewChromaKey(); refreshChromaKeyHistograms(); });
  ckProtectHex.addEventListener('input', () => {
    if (!/^#[0-9a-fA-F]{6}$/.test(ckProtectHex.value)) return;
    ckProtectColor.value = ckProtectHex.value.toLowerCase();
    previewChromaKey();
    refreshChromaKeyHistograms();
  });
  ckProtectPrimary.addEventListener('click', () => { setColorInputs(ckProtectColor, ckProtectHex, drawingSettings().primary); previewChromaKey(); refreshChromaKeyHistograms(); });
  ckProtectSecondary.addEventListener('click', () => { setColorInputs(ckProtectColor, ckProtectHex, drawingSettings().secondary); previewChromaKey(); refreshChromaKeyHistograms(); });
  ckProtectTolerance.addEventListener('input', () => { ckProtectToleranceVal.textContent = ckProtectTolerance.value; previewChromaKey(); drawChromaKeyHistograms(); });
  ckProtectSoftness.addEventListener('input', () => { ckProtectSoftnessVal.textContent = ckProtectSoftness.value; previewChromaKey(); drawChromaKeyHistograms(); });
  
  ckAllLayers.addEventListener('change', () => { previewChromaKey(); refreshChromaKeyHistograms(); });
  
  defineAction('edit.filters.chromaKey', {
    label: 'Chroma Key…',
    run: () => {
      setColorInputs(ckColor, ckColorHex, drawingSettings().primary);
      ckModeTransparent.checked = true;
      updateChromaKeyModeUI();
      setColorInputs(ckReplaceColor, ckReplaceHex, drawingSettings().secondary);
      ckTolerance.value = '15'; ckToleranceVal.textContent = '15';
      ckSoftness.value = '10'; ckSoftnessVal.textContent = '10';
      ckBackgroundOnly.checked = true;
      ckPreserveSoftShadows.checked = true;
      ckProtectEnabled.checked = false;
      updateChromaKeyProtectUI();
      setColorInputs(ckProtectColor, ckProtectHex, [0, 0, 0]);
      ckProtectTolerance.value = '15'; ckProtectToleranceVal.textContent = '15';
      ckProtectSoftness.value = '20'; ckProtectSoftnessVal.textContent = '20';
      ckAllLayers.checked = false;
      if (dlgQuantize.open) dlgQuantize.close();
      if (dlgCheckerboard.open) dlgCheckerboard.close();
      previewChromaKey();
      refreshChromaKeyHistograms();
      dlgChromaKey.show();
      if (!dlgChromaKey.style.left) centerDialog(dlgChromaKey);
    },
    isEnabled: () => !!activeEditableLayer(),
  });
  function cancelChromaKeyDialog() { refreshPreviewPanel(); workbench.clearCanvasPreview(); dlgChromaKey.close(); }
  ckCancel.addEventListener('click', cancelChromaKeyDialog);
  closeOnEscape(dlgChromaKey, cancelChromaKeyDialog);
  ckOk.addEventListener('click', () => {
    refreshPreviewPanel();
    workbench.clearCanvasPreview();
    const params = currentChromaKeyParams();
    dlgChromaKey.close();
    commitChromaKey(params, ckAllLayers.checked);
  });
  
  // ---- checkerboard remover ----
  
  // Resolves the region + target layers for the current filter scope, or
  // null when there's nothing to operate on -- shared by
  // computeCheckerboardPatches and the Auto-detect button (which needs the
  // region's raw pixels but not a checkerboardRemoveBitmap call).
  function checkerboardRegionAndLayers(allLayers) {
    const sheet = activeSheet();
    if (!sheet) return null;
    const rr = currentEditRegion();
    if (!rr) return null;
    const layers = allLayers ? activeLayerScope() : (activeEditableLayer() ? [activeEditableLayer()] : []);
    if (!layers.length) return null;
    return { region: rr.region, layers };
  }
  
  // Pure compute half, mirroring computeChromaKeyPatches -- shared by the
  // real commit (commitCheckerboard) and the dialog's live preview.
  //
  // When params.guideLines is set, a second pass runs after the main
  // checkerboard removal: detectGuideLines looks for thin design-grid lines
  // that recur at a regular pixel interval (see js/core/checkerboard.js's
  // own note on why these need positional, not color, detection), using the
  // ORIGINAL (pre-removal) pixels -- once the main pass has already turned
  // checker cells transparent, the "is this near-neutral and NOT
  // colorA/colorB" comparison detection depends on no longer means anything.
  // removeGuideLines then only touches pixels inside the confirmed bands.
  //
  // params.objectHints holds the user's object marks (see checkerboardObjectHint).
  // Its seeds arrive in SHEET coordinates, because that's what a canvas click
  // gives, and every bitmap here is a region crop -- so they're rebased onto
  // the region before use, and marks outside it are simply dropped. The mask
  // is built per layer from that layer's own pixels: an object only exists on
  // the layer it was drawn on, and a mark that lands on empty space elsewhere
  // should protect nothing there rather than guess.
  function computeCheckerboardPatches(params, allLayers) {
    const rl = checkerboardRegionAndLayers(allLayers);
    if (!rl) return null;
    const { region, layers } = rl;
    const befores = layers.map(l => copyRegion(l.bitmap, region.x, region.y, region.w, region.h));
    let rowBands = [], colBands = [];
    if (params.guideLines && befores.length) {
      ({ rowBands, colBands } = detectGuideLines(befores, params.colorA, params.colorB, { threshold: params.guideLines.threshold }));
    }
    const hintSeeds = (params.objectHints?.seeds ?? [])
      .map(s => ({ x: s.x - region.x, y: s.y - region.y }))
      .filter(s => s.x >= 0 && s.y >= 0 && s.x < region.w && s.y < region.h);
    const protectMasks = befores.map(before => (hintSeeds.length ? checkerboardObjectHint(before, hintSeeds, {
      colorA: params.colorA,
      colorB: params.colorB,
      tolerance: params.tolerance,
      latticeCellSize: params.windowRadius,
      outlineWidth: params.objectHints.outlineWidth,
      fillHoles: params.objectHints.fillHoles,
    }) : null));
    const afters = befores.map((before, i) => {
      const after = checkerboardRemoveBitmap(before, { ...params, protectMask: protectMasks[i] });
      if (!rowBands.length && !colBands.length) return after;
      return removeGuideLines(after, {
        rowBands, colBands, action: params.guideLines.action, healStrength: params.guideLines.healStrength, mode: params.mode, replacementColor: params.replacementColor,
        protectColor: params.protectColor, protectTolerance: params.protectTolerance, protectSoftness: params.protectSoftness,
      });
    });
    const patches = layers.map((l, i) => ({ layer: l, before: befores[i], after: afters[i] }))
      .filter(p => !bitmapsEqual(p.before, p.after));
    return { region, layers, patches, befores, protectMasks, guideLineBands: { rowBands, colBands } };
  }

  // Preview-only view of a result: the protected pixels tinted so the user can
  // SEE what their marks actually caught, rather than inferring it from what
  // survived. Deliberately built as a separate result rather than folded into
  // computeCheckerboardPatches -- commitCheckerboard calls that same function,
  // and a tint that reached it would be written into the layer.
  //
  // A layer with a mask but no pixel change still gets a patch here (nothing
  // was removed, but there is still something to show); those synthetic
  // patches exist only for the duration of this preview, so they can't turn
  // into a no-op history entry.
  function withProtectOverlay(result) {
    if (!result) return result;
    const changed = new Map(result.patches.map(p => [p.layer.id, p]));
    const patches = [];
    result.layers.forEach((layer, i) => {
      const mask = result.protectMasks[i];
      const patch = changed.get(layer.id);
      if (!patch && !(mask && mask.some(Boolean))) return;
      patches.push({
        layer,
        before: result.befores[i],
        after: tintProtectedPixels(patch ? patch.after : result.befores[i], mask),
      });
    });
    return { ...result, patches };
  }
  
  function commitCheckerboard(params, allLayers) {
    commitFloatIfAny();
    const result = computeCheckerboardPatches(params, allLayers);
    if (!result || !result.patches.length) return;
    const { region, patches } = result;
    getEditorHost().history.execute({
      label: 'remove checkerboard',
      do() { for (const p of patches) blitRegion(p.layer.bitmap, p.after, region.x, region.y); notifyPixelsChanged(); },
      undo() { for (const p of patches) blitRegion(p.layer.bitmap, p.before, region.x, region.y); notifyPixelsChanged(); },
    });
    getEditorHost().projects.markDirty();
  }
  
  const dlgCheckerboard = document.getElementById('dlg-checkerboard');
  const cbAutodetect = document.getElementById('cb-autodetect');
  const cbColorAPick = document.getElementById('cb-colora-pick');
  const cbColorASwatches = document.getElementById('cb-colora-swatches');
  const cbColorBPick = document.getElementById('cb-colorb-pick');
  const cbColorBSwatches = document.getElementById('cb-colorb-swatches');
  const cbModeTransparent = document.getElementById('cb-mode-transparent');
  const cbModeReplace = document.getElementById('cb-mode-replace');
  const cbReplaceRow = document.getElementById('cb-replace-row');
  const cbReplaceColor = document.getElementById('cb-replace-color');
  const cbReplaceHex = document.getElementById('cb-replace-hex');
  const cbReplacePrimary = document.getElementById('cb-replace-primary');
  const cbReplaceSecondary = document.getElementById('cb-replace-secondary');
  const cbTolerance = document.getElementById('cb-tolerance');
  const cbToleranceVal = document.getElementById('cb-tolerance-val');
  const cbSoftness = document.getElementById('cb-softness');
  const cbSoftnessVal = document.getElementById('cb-softness-val');
  const cbCellSize = document.getElementById('cb-cellsize');
  const cbCellSizeVal = document.getElementById('cb-cellsize-val');
  const cbMinMix = document.getElementById('cb-minmix');
  const cbMinMixVal = document.getElementById('cb-minmix-val');
  const cbProtectEnabled = document.getElementById('cb-protect-enabled');
  const cbProtectRow = document.getElementById('cb-protect-row');
  const cbProtectColor = document.getElementById('cb-protect-color');
  const cbProtectHex = document.getElementById('cb-protect-hex');
  const cbProtectPrimary = document.getElementById('cb-protect-primary');
  const cbProtectSecondary = document.getElementById('cb-protect-secondary');
  const cbProtectTolerance = document.getElementById('cb-protect-tolerance');
  const cbProtectToleranceVal = document.getElementById('cb-protect-tolerance-val');
  const cbProtectSoftness = document.getElementById('cb-protect-softness');
  const cbProtectSoftnessVal = document.getElementById('cb-protect-softness-val');
  const cbProtectObjectsEnabled = document.getElementById('cb-protect-objects-enabled');
  const cbProtectObjectsRow = document.getElementById('cb-protect-objects-row');
  const cbObjectsPick = document.getElementById('cb-objects-pick');
  const cbObjectsClear = document.getElementById('cb-objects-clear');
  const cbObjectsStatus = document.getElementById('cb-objects-status');
  const cbObjectsOutline = document.getElementById('cb-objects-outline');
  const cbObjectsOutlineVal = document.getElementById('cb-objects-outline-val');
  const cbObjectsFillHoles = document.getElementById('cb-objects-fillholes');
  const cbObjectsShowMask = document.getElementById('cb-objects-showmask');
  const cbGridLinesEnabled = document.getElementById('cb-gridlines-enabled');
  const cbGridLinesRow = document.getElementById('cb-gridlines-row');
  const cbGridLinesThreshold = document.getElementById('cb-gridlines-threshold');
  const cbGridLinesThresholdVal = document.getElementById('cb-gridlines-threshold-val');
  const cbGridLinesAction = document.getElementById('cb-gridlines-action');
  const cbGridLinesHealStrengthRow = document.getElementById('cb-gridlines-healstrength-row');
  const cbGridLinesHealStrength = document.getElementById('cb-gridlines-healstrength');
  const cbGridLinesHealStrengthVal = document.getElementById('cb-gridlines-healstrength-val');
  const cbGridLinesStatus = document.getElementById('cb-gridlines-status');
  const cbAllLayers = document.getElementById('cb-alllayers');
  const cbOk = document.getElementById('cb-ok');
  const cbCancel = document.getElementById('cb-cancel');
  markDefaultAction(dlgCheckerboard, cbOk);
  makeDialogMovable(dlgCheckerboard, dlgCheckerboard.querySelector('h3'));

  // Each checker color role (A/B) is just a list of sampled shades -- one
  // representation, not a single color+hex field alongside a separate
  // additive list. Auto-detect seeds one swatch per role; "Pick from canvas"
  // (armColorSample, see its own note in drawing-engine.js) samples the
  // sheet directly, in-dialog, without routing through the main toolbar's
  // Eyedropper tool/drawingSettings; clicking an existing swatch removes it.
  // At least one swatch per role is kept -- checkerboardRemoveBitmap treats
  // an empty role as "never matches", which would silently no-op the filter
  // rather than error, but that's a confusing dead end so the UI never lets
  // a role go empty.
  let cbSamplesA = [];
  let cbSamplesB = [];
  function renderCbSwatches(listEl, colors, onRemove) {
    listEl.innerHTML = '';
    colors.forEach((c, idx) => {
      const sw = document.createElement('span');
      sw.className = 'sys-palette-swatch';
      const hex = rgbaToHex(c);
      sw.style.background = hex;
      sw.title = colors.length > 1 ? `${hex} (click to remove)` : hex;
      if (colors.length > 1) sw.addEventListener('click', () => onRemove(idx));
      listEl.appendChild(sw);
    });
  }
  function renderCbSwatchLists() {
    renderCbSwatches(cbColorASwatches, cbSamplesA, (idx) => { cbSamplesA.splice(idx, 1); renderCbSwatchLists(); previewCheckerboard(); });
    renderCbSwatches(cbColorBSwatches, cbSamplesB, (idx) => { cbSamplesB.splice(idx, 1); renderCbSwatchLists(); previewCheckerboard(); });
  }
  function addCbSample(samples, rgb) {
    const c = [rgb[0], rgb[1], rgb[2]];
    if (!samples.some(s => s[0] === c[0] && s[1] === c[1] && s[2] === c[2])) samples.push(c);
    renderCbSwatchLists();
    previewCheckerboard();
  }
  function armCbPick(button, samples) {
    const label = button.textContent;
    button.textContent = 'Click on canvas…';
    button.classList.add('active');
    const restore = () => { button.textContent = label; button.classList.remove('active'); };
    armColorSample((rgba) => { addCbSample(samples, rgba); restore(); }, restore);
  }
  cbColorAPick.addEventListener('click', () => armCbPick(cbColorAPick, cbSamplesA));
  cbColorBPick.addEventListener('click', () => armCbPick(cbColorBPick, cbSamplesB));

  // Object marks: sheet-space points, one per object the user wants kept.
  // Unlike the color pickers this arm REPEATS -- marking objects is a
  // several-clicks job, and having to re-press the button between each one
  // is the kind of friction that makes people give up and widen tolerance
  // instead. Clicking near an existing mark removes it, so a misclick costs
  // one click rather than a Clear and a fresh start.
  const OBJECT_MARK_HIT_RADIUS = 4;
  let cbObjectSeeds = [];
  let cbObjectsArmed = false;
  function renderCbObjectsStatus() {
    const n = cbObjectSeeds.length;
    cbObjectsStatus.textContent = n === 0
      ? (cbObjectsArmed ? 'Click objects on the canvas to keep them.' : 'No objects marked.')
      : `${n} object${n === 1 ? '' : 's'} marked${cbObjectsArmed ? ' -- click a mark again to remove it' : ''}.`;
  }
  function toggleCbObjectSeed(x, y) {
    const hit = cbObjectSeeds.findIndex(s => Math.abs(s.x - x) <= OBJECT_MARK_HIT_RADIUS && Math.abs(s.y - y) <= OBJECT_MARK_HIT_RADIUS);
    if (hit >= 0) cbObjectSeeds.splice(hit, 1); else cbObjectSeeds.push({ x, y });
    renderCbObjectsStatus();
    previewCheckerboard();
  }
  function disarmCbObjects() {
    cbObjectsArmed = false;
    cbObjectsPick.textContent = '🎯 Mark objects on canvas';
    cbObjectsPick.classList.remove('active');
    renderCbObjectsStatus();
  }
  cbObjectsPick.addEventListener('click', () => {
    if (cbObjectsArmed) { cancelColorSample(); return; }
    cbObjectsArmed = true;
    cbObjectsPick.textContent = 'Marking… (Esc to stop)';
    cbObjectsPick.classList.add('active');
    renderCbObjectsStatus();
    armColorSample((_rgba, at) => toggleCbObjectSeed(at.x, at.y), disarmCbObjects, { repeat: true });
  });
  cbObjectsClear.addEventListener('click', () => {
    if (!cbObjectSeeds.length) return;
    cbObjectSeeds = [];
    renderCbObjectsStatus();
    previewCheckerboard();
  });

  function currentCheckerboardParams() {
    return {
      colorA: cbSamplesA.slice(),
      colorB: cbSamplesB.slice(),
      tolerance: Number(cbTolerance.value),
      softness: Number(cbSoftness.value),
      windowRadius: Number(cbCellSize.value),
      minMixFraction: Number(cbMinMix.value) / 100,
      mode: cbModeReplace.checked ? 'replace' : 'transparent',
      replacementColor: hexToRgb(cbReplaceColor.value),
      protectColor: cbProtectEnabled.checked ? hexToRgb(cbProtectColor.value) : null,
      protectTolerance: Number(cbProtectTolerance.value),
      protectSoftness: Number(cbProtectSoftness.value),
      objectHints: cbProtectObjectsEnabled.checked ? {
        seeds: cbObjectSeeds.map(s => ({ ...s })),
        outlineWidth: Number(cbObjectsOutline.value),
        fillHoles: cbObjectsFillHoles.checked,
      } : null,
      guideLines: cbGridLinesEnabled.checked ? { threshold: Number(cbGridLinesThreshold.value) / 100, action: cbGridLinesAction.value, healStrength: Number(cbGridLinesHealStrength.value) / 100 } : null,
    };
  }
  
  function previewCheckerboard() {
    const result = computeCheckerboardPatches(currentCheckerboardParams(), cbAllLayers.checked);
    const showMask = cbProtectObjectsEnabled.checked && cbObjectsShowMask.checked;
    pushLivePreview(showMask ? withProtectOverlay(result) : result);
    if (cbGridLinesEnabled.checked) {
      const { rowBands, colBands } = result?.guideLineBands ?? { rowBands: [], colBands: [] };
      cbGridLinesStatus.textContent = (rowBands.length || colBands.length)
        ? `Found ${rowBands.length} horizontal, ${colBands.length} vertical guide line(s).`
        : 'No regularly-spaced guide lines found.';
    } else {
      cbGridLinesStatus.textContent = '';
    }
  }
  
  // Re-samples the current region's pixels and re-runs detectCheckerboardColors
  // / estimateCheckerCellSize, filling colorA/colorB/cell size from the actual
  // image instead of requiring the user to eyedropper both checker shades and
  // guess a cell size by hand. Silently no-ops (mirrors the rest of this
  // dialog's error handling) when there's no region or no confident color
  // pair -- the user's existing manual values are left alone either way.
  // (Guide-line detection needs no manual color input at all -- it's purely
  // positional, see computeCheckerboardPatches/detectGuideLines -- so there's
  // nothing for Auto-detect to fill in for it beyond re-running the preview.)
  cbAutodetect.addEventListener('click', () => {
    cancelColorSample();
    const rl = checkerboardRegionAndLayers(cbAllLayers.checked);
    if (!rl) return;
    const befores = rl.layers.map(l => copyRegion(l.bitmap, rl.region.x, rl.region.y, rl.region.w, rl.region.h));
    const detected = detectCheckerboardColors(befores);
    if (!detected) return;
    cbSamplesA = [detected.colorA]; cbSamplesB = [detected.colorB]; renderCbSwatchLists();
    const cellSize = estimateCheckerCellSize(befores, detected.colorA, detected.colorB, { tolerance: Number(cbTolerance.value) });
    if (cellSize) { cbCellSize.value = String(Math.min(128, Math.max(2, cellSize))); cbCellSizeVal.textContent = cbCellSize.value; }
    previewCheckerboard();
  });
  
  cbReplaceColor.addEventListener('input', () => { cbReplaceHex.value = cbReplaceColor.value; previewCheckerboard(); });
  cbReplaceHex.addEventListener('input', () => {
    if (!/^#[0-9a-fA-F]{6}$/.test(cbReplaceHex.value)) return;
    cbReplaceColor.value = cbReplaceHex.value.toLowerCase();
    previewCheckerboard();
  });
  cbReplacePrimary.addEventListener('click', () => { setColorInputs(cbReplaceColor, cbReplaceHex, drawingSettings().primary); previewCheckerboard(); });
  cbReplaceSecondary.addEventListener('click', () => { setColorInputs(cbReplaceColor, cbReplaceHex, drawingSettings().secondary); previewCheckerboard(); });
  
  function updateCheckerboardModeUI() {
    cbReplaceRow.hidden = !cbModeReplace.checked;
  }
  cbModeTransparent.addEventListener('change', () => { updateCheckerboardModeUI(); previewCheckerboard(); });
  cbModeReplace.addEventListener('change', () => { updateCheckerboardModeUI(); previewCheckerboard(); });
  
  cbTolerance.addEventListener('input', () => { cbToleranceVal.textContent = cbTolerance.value; previewCheckerboard(); });
  cbSoftness.addEventListener('input', () => { cbSoftnessVal.textContent = cbSoftness.value; previewCheckerboard(); });
  cbCellSize.addEventListener('input', () => { cbCellSizeVal.textContent = cbCellSize.value; previewCheckerboard(); });
  cbMinMix.addEventListener('input', () => { cbMinMixVal.textContent = cbMinMix.value; previewCheckerboard(); });
  
  function updateCheckerboardProtectUI() {
    cbProtectRow.hidden = !cbProtectEnabled.checked;
  }
  cbProtectEnabled.addEventListener('change', () => { updateCheckerboardProtectUI(); previewCheckerboard(); });
  cbProtectColor.addEventListener('input', () => { cbProtectHex.value = cbProtectColor.value; previewCheckerboard(); });
  cbProtectHex.addEventListener('input', () => {
    if (!/^#[0-9a-fA-F]{6}$/.test(cbProtectHex.value)) return;
    cbProtectColor.value = cbProtectHex.value.toLowerCase();
    previewCheckerboard();
  });
  cbProtectPrimary.addEventListener('click', () => { setColorInputs(cbProtectColor, cbProtectHex, drawingSettings().primary); previewCheckerboard(); });
  cbProtectSecondary.addEventListener('click', () => { setColorInputs(cbProtectColor, cbProtectHex, drawingSettings().secondary); previewCheckerboard(); });
  cbProtectTolerance.addEventListener('input', () => { cbProtectToleranceVal.textContent = cbProtectTolerance.value; previewCheckerboard(); });
  cbProtectSoftness.addEventListener('input', () => { cbProtectSoftnessVal.textContent = cbProtectSoftness.value; previewCheckerboard(); });
  
  function updateCheckerboardObjectsUI() {
    cbProtectObjectsRow.hidden = !cbProtectObjectsEnabled.checked;
    if (!cbProtectObjectsEnabled.checked && cbObjectsArmed) cancelColorSample();
  }
  cbProtectObjectsEnabled.addEventListener('change', () => { updateCheckerboardObjectsUI(); previewCheckerboard(); });
  cbObjectsOutline.addEventListener('input', () => { cbObjectsOutlineVal.textContent = cbObjectsOutline.value; previewCheckerboard(); });
  cbObjectsFillHoles.addEventListener('change', previewCheckerboard);
  cbObjectsShowMask.addEventListener('change', previewCheckerboard);

  function updateCheckerboardGridLinesUI() {
    cbGridLinesRow.hidden = !cbGridLinesEnabled.checked;
    cbGridLinesHealStrengthRow.hidden = cbGridLinesAction.value !== 'heal';
  }
  cbGridLinesEnabled.addEventListener('change', () => { updateCheckerboardGridLinesUI(); previewCheckerboard(); });
  cbGridLinesThreshold.addEventListener('input', () => { cbGridLinesThresholdVal.textContent = cbGridLinesThreshold.value; previewCheckerboard(); });
  cbGridLinesAction.addEventListener('change', () => { updateCheckerboardGridLinesUI(); previewCheckerboard(); });
  cbGridLinesHealStrength.addEventListener('input', () => { cbGridLinesHealStrengthVal.textContent = cbGridLinesHealStrength.value; previewCheckerboard(); });
  
  cbAllLayers.addEventListener('change', previewCheckerboard);
  
  defineAction('edit.filters.checkerboard', {
    label: 'Remove Checkerboard…',
    run: () => {
      cancelColorSample();
      cbSamplesA = [[255, 255, 255]]; cbSamplesB = [[192, 192, 192]]; renderCbSwatchLists();
      cbModeTransparent.checked = true;
      updateCheckerboardModeUI();
      setColorInputs(cbReplaceColor, cbReplaceHex, drawingSettings().secondary);
      cbTolerance.value = '18'; cbToleranceVal.textContent = '18';
      cbSoftness.value = '0'; cbSoftnessVal.textContent = '0';
      cbCellSize.value = '12'; cbCellSizeVal.textContent = '12';
      cbMinMix.value = '12'; cbMinMixVal.textContent = '12';
      cbProtectEnabled.checked = false;
      updateCheckerboardProtectUI();
      setColorInputs(cbProtectColor, cbProtectHex, [0, 0, 0]);
      cbProtectTolerance.value = '15'; cbProtectToleranceVal.textContent = '15';
      cbProtectSoftness.value = '20'; cbProtectSoftnessVal.textContent = '20';
      cbProtectObjectsEnabled.checked = false;
      cbObjectSeeds = [];
      disarmCbObjects();
      updateCheckerboardObjectsUI();
      cbObjectsOutline.value = '1'; cbObjectsOutlineVal.textContent = '1';
      cbObjectsFillHoles.checked = false;
      cbObjectsShowMask.checked = false;
      cbGridLinesEnabled.checked = false;
      cbGridLinesThreshold.value = '70'; cbGridLinesThresholdVal.textContent = '70';
      cbGridLinesAction.value = 'heal';
      cbGridLinesHealStrength.value = '100'; cbGridLinesHealStrengthVal.textContent = '100';
      updateCheckerboardGridLinesUI();
      cbGridLinesStatus.textContent = '';
      cbAllLayers.checked = false;
      if (dlgQuantize.open) dlgQuantize.close();
      if (dlgChromaKey.open) dlgChromaKey.close();
      dlgCheckerboard.show();
      if (!dlgCheckerboard.style.left) centerDialog(dlgCheckerboard);
      // Auto-detect on open -- the whole point of this filter is to save the
      // user from hand-picking checker colors/cell size, so start from a
      // real guess instead of the flat [255]/[192] fallback above.
      cbAutodetect.click();
    },
    isEnabled: () => !!activeEditableLayer(),
  });
  function cancelCheckerboardDialog() { cancelColorSample(); refreshPreviewPanel(); workbench.clearCanvasPreview(); dlgCheckerboard.close(); }
  cbCancel.addEventListener('click', cancelCheckerboardDialog);
  closeOnEscape(dlgCheckerboard, cancelCheckerboardDialog);
  cbOk.addEventListener('click', () => {
    cancelColorSample();
    refreshPreviewPanel();
    workbench.clearCanvasPreview();
    const params = currentCheckerboardParams();
    dlgCheckerboard.close();
    commitCheckerboard(params, cbAllLayers.checked);
  });

  // These dialogs are non-modal on purpose (sample colors, mark objects, keep
  // painting while they're up), so an undo/redo can land while one is open --
  // and every preview above is computed from the LIVE layer bitmaps. Without
  // this the canvas would keep showing the pre-undo preview override and the
  // undo would look like it did nothing. Recompute whichever dialog is open;
  // the commit itself is a history change too, but by then the dialog is
  // already closed, so this never fights an in-flight commit.
  getEditorHost().history.subscribe(() => {
    if (dlgQuantize.open) previewQuantize();
    else if (dlgChromaKey.open) { previewChromaKey(); refreshChromaKeyHistograms(); }
    else if (dlgCheckerboard.open) previewCheckerboard();
  });
}
