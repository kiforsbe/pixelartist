// js/components/dock-resizer.js
// A drag handle that resizes a bottom dock's height, shared by every bottom
// dock (the Sprites and Animations timelines). The handle is a focusable
// horizontal separator: drag it, use ArrowUp/Down (Shift: bigger steps) and
// Home/End, or double-click / Enter to fit the dock to its content (a second
// fit restores the size from before). Sizes are clamped to [min, max()] --
// re-clamped when the window resizes -- and saved per dock through the
// preferences store on release, never mid-drag.

const STEP = 16, BIG_STEP = 64;

// Rounded and kept inside [min, max]; a max below min yields min (a tiny
// window still keeps a usable dock), anything non-numeric yields min.
export function clampSize(px, min, max) {
  if (!Number.isFinite(px)) return min;
  return Math.max(min, Math.min(max, Math.round(px)));
}

// The size a key press moves to, or null when the key isn't a resize key.
// The handle sits on the dock's top edge, so ArrowUp grows it.
export function keyStep(size, key, shiftKey, { min, max }) {
  const step = shiftKey ? BIG_STEP : STEP;
  switch (key) {
    case 'ArrowUp': return clampSize(size + step, min, max);
    case 'ArrowDown': return clampSize(size - step, min, max);
    case 'Home': return min;
    case 'End': return Number.isFinite(max) ? clampSize(max, min, max) : null; // no bound to jump to
    default: return null;
  }
}

// A dock's max height: its parent (the #workspace grid) less `reserve` px
// kept for the canvas above it. Infinity while the workspace can't be
// measured (not laid out yet, or no parent) so a saved size isn't cut down
// by a bogus bound.
export function workspaceDockMax(target, reserve = 120) {
  const height = target?.parentElement?.clientHeight;
  return height > 0 ? height - reserve : Infinity;
}

// Moves a preference to a new key once: copied only when the new key has no
// value yet, and the old key is dropped either way.
export function migratePreference(prefs, fromKey, toKey) {
  if (!prefs) return;
  const old = prefs.get(fromKey);
  if (old == null) return;
  if (prefs.get(toKey) == null) prefs.set(toKey, old);
  prefs.remove?.(fromKey);
}

export function createDockResizer({ target, edge = 'top', min = 100, max = () => Infinity,
  measureContent = null, prefs = null, prefKey, label = 'Resize panel', onResize = null }) {
  const element = document.createElement('div');
  element.className = 'dock-resizer';
  element.tabIndex = 0;
  element.title = measureContent ? 'Drag to resize; double-click to fit the content' : 'Drag to resize';
  element.setAttribute('role', 'separator');
  element.setAttribute('aria-orientation', 'horizontal');
  element.setAttribute('aria-label', label);

  // Growth per px of pointer travel: a top-edge handle grows the dock upwards.
  const direction = edge === 'bottom' ? -1 : 1;
  let current = null; // px applied by this resizer; null = the CSS default
  let fitted = null;  // { size, previous } after a fit, until another resize

  const clamp = px => clampSize(px, min, max());
  const size = () => current ?? Math.round(target.getBoundingClientRect().height);

  function updateAria() {
    const upper = max();
    element.setAttribute('aria-valuemin', String(min));
    if (Number.isFinite(upper)) element.setAttribute('aria-valuemax', String(Math.max(min, upper)));
    element.setAttribute('aria-valuenow', String(size()));
  }

  function apply(px, notify = true) {
    current = px;
    target.style.height = px + 'px';
    updateAria();
    if (notify) onResize?.(px);
  }
  function persist() { prefs?.set(prefKey, current); }
  function commit(px) { apply(px); persist(); }

  function setSize(px) { fitted = null; commit(clamp(px)); }

  function fit() {
    if (!measureContent) return;
    if (fitted && current === fitted.size) {
      const previous = fitted.previous;
      fitted = null;
      commit(clamp(previous));
      return;
    }
    const previous = size();
    commit(clamp(measureContent()));
    fitted = { size: current, previous };
  }

  // ---- pointer drag ----
  let dragging = false, startY = 0, startH = 0;
  element.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startH = target.getBoundingClientRect().height;
    element.classList.add('dragging');
    element.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  element.addEventListener('pointermove', e => {
    if (!dragging) return;
    const next = clamp(startH + (startY - e.clientY) * direction);
    if (next === current) return;
    fitted = null;
    apply(next);
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    element.classList.remove('dragging');
    if (current != null) persist();
  }
  element.addEventListener('pointerup', endDrag);
  element.addEventListener('pointercancel', endDrag);
  element.addEventListener('lostpointercapture', endDrag);

  // ---- keyboard and fit ----
  element.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); fit(); return; }
    const next = keyStep(size(), e.key, e.shiftKey, { min, max: max() });
    if (next == null) return;
    e.preventDefault();
    fitted = null;
    commit(next);
  });
  element.addEventListener('dblclick', fit);

  // ---- window resize: keep the dock inside the new bound (not saved, so
  // the stored preference survives a temporarily small window) ----
  function onWindowResize() {
    if (current != null && clamp(current) !== current) apply(clamp(current));
    else updateAria();
  }
  globalThis.window?.addEventListener?.('resize', onWindowResize);

  const saved = prefs?.get(prefKey);
  if (Number.isFinite(saved)) apply(clamp(saved), false);
  else updateAria();

  return {
    element,
    setSize,
    size,
    dispose() { globalThis.window?.removeEventListener?.('resize', onWindowResize); },
  };
}
