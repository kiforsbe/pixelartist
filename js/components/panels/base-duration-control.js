// Shared ms/fps(+step) control for a "base duration" value -- reused by the
// Animation panel (js/ui/animpanel.js) and, in the next task, the New
// Project and Project Settings dialogs (js/app/main.js). One unit is
// "primary" (editable) at a time; the other is shown read-only, live-
// converted, for reference. fps-primary additionally shows a "step" field
// (animate on every Nth frame at this fps), inline on the same row as fps. See
// docs/superpowers/specs/2026-07-19-animation-panel-design.md.
import { fpsStepToMs, msToFps } from '../../core/model.js';

// getValue() -> { durationMs, baseFps, baseStep } (baseFps/baseStep may be
//   undefined -- that's what makes ms the primary unit).
// setValue(next) -> called with a full { durationMs, baseFps, baseStep }
//   replacement on every commit; caller decides how to persist it.
export function buildBaseDurationControl({ getValue, setValue }) {
  const wrap = document.createElement('div');
  wrap.className = 'duration-control';

  const toggle = document.createElement('div');
  toggle.className = 'duration-control-toggle';
  const btnMs = document.createElement('button');
  btnMs.type = 'button'; btnMs.textContent = 'ms'; btnMs.className = 'btn-sm';
  const btnFps = document.createElement('button');
  btnFps.type = 'button'; btnFps.textContent = 'fps'; btnFps.className = 'btn-sm';
  toggle.append(btnMs, btnFps);

  const msRow = document.createElement('label');
  msRow.className = 'duration-control-row';
  msRow.append(document.createTextNode('ms/frame'));
  const msInput = document.createElement('input');
  msInput.type = 'number'; msInput.min = '1';
  msRow.appendChild(msInput);

  const fpsRow = document.createElement('div');
  fpsRow.className = 'duration-control-row';

  const fpsField = document.createElement('label');
  fpsField.append(document.createTextNode('fps'));
  const fpsInput = document.createElement('input');
  fpsInput.type = 'number'; fpsInput.min = '0.1'; fpsInput.step = '0.1';
  fpsField.appendChild(fpsInput);

  const stepField = document.createElement('label');
  stepField.title = 'Animate on every Nth frame at this fps';
  stepField.append(document.createTextNode('step'));
  const stepInput = document.createElement('input');
  stepInput.type = 'number'; stepInput.min = '1'; stepInput.step = '1';
  stepField.appendChild(stepInput);

  fpsRow.append(fpsField, stepField);
  wrap.appendChild(toggle);

  function isFpsPrimary() { return getValue().baseFps != null; }

  function refresh() {
    const v = getValue();
    const fpsPrimary = v.baseFps != null;
    // Primary (editable) row on top, the read-only reference row below --
    // .append() on already-attached nodes just reorders them.
    if (fpsPrimary) wrap.append(toggle, fpsRow, msRow);
    else wrap.append(toggle, msRow, fpsRow);
    btnMs.classList.toggle('active', !fpsPrimary);
    btnFps.classList.toggle('active', fpsPrimary);
    stepField.hidden = !fpsPrimary;

    msInput.disabled = fpsPrimary;
    fpsInput.disabled = !fpsPrimary;
    stepInput.disabled = !fpsPrimary;

    msInput.value = String(v.durationMs);
    fpsInput.value = String(fpsPrimary ? v.baseFps : Math.round(msToFps(v.durationMs) * 100) / 100);
    stepInput.value = String(fpsPrimary ? (v.baseStep ?? 1) : 1);
  }

  btnMs.addEventListener('click', () => {
    if (!isFpsPrimary()) return;
    setValue({ durationMs: getValue().durationMs, baseFps: undefined, baseStep: undefined });
    refresh();
  });
  btnFps.addEventListener('click', () => {
    if (isFpsPrimary()) return;
    const fps = Math.round(msToFps(getValue().durationMs) * 100) / 100;
    const step = 1;
    setValue({ durationMs: fpsStepToMs(fps, step), baseFps: fps, baseStep: step });
    refresh();
  });

  msInput.addEventListener('change', () => {
    let v = parseInt(msInput.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    setValue({ durationMs: v, baseFps: undefined, baseStep: undefined });
    refresh();
  });

  function commitFpsStep() {
    let fps = parseFloat(fpsInput.value);
    if (!Number.isFinite(fps) || fps <= 0) fps = 1;
    let step = parseInt(stepInput.value, 10);
    if (!Number.isFinite(step) || step < 1) step = 1;
    setValue({ durationMs: fpsStepToMs(fps, step), baseFps: fps, baseStep: step });
    refresh();
  }
  fpsInput.addEventListener('change', commitFpsStep);
  stepInput.addEventListener('change', commitFpsStep);

  refresh();
  return { el: wrap, refresh };
}
