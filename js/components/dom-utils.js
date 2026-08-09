// True when the user is typing into an input, textarea, contenteditable
// element, or has an open dialog focused -- global keyboard shortcuts
// (Delete, Escape, Enter, etc.) should not fire in that case.
export function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('dialog[open]'));
}
