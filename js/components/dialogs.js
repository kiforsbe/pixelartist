// Shared <dialog> UX helper: marks a button as its dialog's default action
// (Windows-standard convention) -- visually highlighted (see .btn-default in
// app.css) and triggered by Enter anywhere in the dialog, so users don't have
// to click OK/Create by hand for every single-field edit.
export function markDefaultAction(dlg, btn) {
  btn.classList.add('btn-default');
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // BUTTON already handles its own Enter natively (would double-fire);
    // TEXTAREA/SELECT need Enter for their own editing/picking interaction,
    // not to submit the whole dialog. Nothing here uses a textarea, but the
    // exclusion costs nothing and guards against one being added later.
    const tag = e.target.tagName;
    if (tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (btn.disabled) return;
    e.preventDefault();
    btn.click();
  });
}

// Non-modal dialogs (shown via .show(), not .showModal()) don't get the
// browser's built-in Escape-to-cancel behavior -- only modal dialogs do.
// This restores the same Escape-closes convention every modal dialog in
// the app already has. stopPropagation so the app's own global Escape
// handlers (clear selection, exit frame editor, etc.) don't ALSO fire --
// they already guard on document.querySelector('dialog[open]'), but this
// keeps the dialog the sole owner of the keystroke regardless of that.
export function closeOnEscape(dlg, onEscape) {
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onEscape();
  });
}

// Makes a non-modal <dialog> draggable by `handle` (typically its <h3>).
// The dialog must already be position: fixed (see .dlg-movable in
// app.css) -- this just updates its left/top from a pointer drag, clamped
// so at least 40px of it stays reachable on every edge (mirrors the
// "clamped to a sane range" convention the timeline dock's own resize
// handle already uses).
export function makeDialogMovable(dlg, handle) {
  let dragStart = null; // { sx, sy, left, top }
  handle.addEventListener('pointerdown', (e) => {
    const rect = dlg.getBoundingClientRect();
    dragStart = { sx: e.clientX, sy: e.clientY, left: rect.left, top: rect.top };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    const left = Math.min(Math.max(dragStart.left + (e.clientX - dragStart.sx), 40 - dlg.offsetWidth), window.innerWidth - 40);
    const top = Math.min(Math.max(dragStart.top + (e.clientY - dragStart.sy), 0), window.innerHeight - 40);
    dlg.style.left = `${left}px`;
    dlg.style.top = `${top}px`;
  });
  const endDrag = (e) => {
    if (!dragStart) return;
    dragStart = null;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
}

// Centers `dlg` (already position: fixed) in the viewport -- meant to be
// called once, the first time a dialog is shown. After that, the user's
// own drag position is left alone across repeated opens (re-centering a
// dialog you deliberately moved out of the way every time you reopen it
// would be annoying); it only resets on a full page reload.
export function centerDialog(dlg) {
  const w = dlg.offsetWidth, h = dlg.offsetHeight;
  dlg.style.left = `${Math.max(0, Math.round((window.innerWidth - w) / 2))}px`;
  dlg.style.top = `${Math.max(0, Math.round((window.innerHeight - h) / 2))}px`;
}
