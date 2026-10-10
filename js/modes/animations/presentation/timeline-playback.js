// js/modes/animations/presentation/timeline-playback.js
// The Animations timeline's live playback, shared with the main view
// (animation-canvas-presenter.js): while the timeline plays, the canvas
// shows the playing frame instead of the selected column's. Playback is not
// selection -- moving the selection every tick would rebuild the timeline --
// so the playing frame lives here, set by the timeline and read by the canvas.
let playing = null; // the playing frame's id, or null when stopped
const listeners = new Set();
let stopper = null;

export function playingFrameId() { return playing; }

// Called by the timeline on start, on every advance, and with null on stop.
export function setPlayingFrame(frameId) {
  if (frameId === playing) return;
  playing = frameId ?? null;
  for (const fn of listeners) fn();
}

// fn() after every change. Returns dispose().
export function onPlaybackChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// The timeline's stop, for the canvas: a press there stops playback on the
// frame it shows. Returns dispose().
export function registerPlaybackStop(fn) {
  stopper = fn;
  return () => { if (stopper === fn) stopper = null; };
}

export function stopPlayback() { stopper?.(); }
