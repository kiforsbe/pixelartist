// js/modes/sprites/application/timeline-playback.js
import { effectiveDuration } from '../../../core/model.js';

// Pure step function for the timeline's playback loop: given how much time
// elapsed since the last tick (already scaled by the playback-speed
// multiplier), advances `position`/`acc` across as many frame boundaries as
// `elapsedMs` covers -- a slow tab can lag several frames behind in one rAF
// tick, hence the while loop rather than a single step. Mirrors
// js/ui/timeline.js's tick() exactly, minus the DOM/rAF/preview side
// effects, which stay in the Presenter (js/modes/sprites/presentation/
// timeline-presenter.js).
export function advancePlayback(anim, position, acc, elapsedMs, loop) {
  let nextPosition = position;
  let nextAcc = acc + elapsedMs;
  let stopped = false;
  let entry = anim.frames[nextPosition];
  while (entry && nextAcc >= effectiveDuration(anim, entry)) {
    nextAcc -= effectiveDuration(anim, entry);
    nextPosition += 1;
    if (nextPosition >= anim.frames.length) {
      if (loop) {
        nextPosition = 0;
      } else {
        nextPosition = anim.frames.length - 1;
        stopped = true;
        break;
      }
    }
    entry = anim.frames[nextPosition];
  }
  return { position: nextPosition, acc: nextAcc, stopped };
}
