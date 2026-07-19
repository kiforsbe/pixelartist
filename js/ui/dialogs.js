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
