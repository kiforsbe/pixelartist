// True when the user is typing into an input, textarea, contenteditable
// element, or has an open dialog focused -- global keyboard shortcuts
// (Delete, Escape, Enter, etc.) should not fire in that case.
export function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('dialog[open]'));
}

// Narrower than isTypingTarget, for shortcuts the browser itself also binds
// (Ctrl+Z/Y/S): only TEXT-ENTRY fields, where the browser's own undo stack is
// meaningful and must win. Sliders, checkboxes, radios and color pickers keep
// focus after a click but have no native undo of their own -- treating them as
// "typing" silently swallowed app-level Undo whenever the user had just
// touched, say, a layer-opacity slider.
const TEXT_ENTRY_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'email', 'password', 'tel', 'number',
  'date', 'time', 'datetime-local', 'month', 'week',
]);
export function isTextEntryTarget(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return el.tagName === 'INPUT' && TEXT_ENTRY_INPUT_TYPES.has(el.type);
}
