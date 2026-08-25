// Test mode (?autotest): automated browser sessions suppress modal dialogs
// (beforeunload guard, autosave-restore prompt, confirm() gates auto-accept).
export const AUTOTEST = typeof location !== 'undefined' ? new URLSearchParams(location.search).has('autotest') : false;
export const confirmOrAuto = (msg) => AUTOTEST || (typeof confirm !== 'undefined' ? confirm(msg) : false);
