// js/domain/sprites/playback.js
import { effectiveDuration } from '../../core/model.js';

// The entry indices of one cycle of an animation with `count` entries played
// in `direction` (core/model.js's ANIMATION_DIRECTIONS; anything else plays
// forward). Ping-pong does not repeat the end frames: 4 entries ping-pong as
// 0 1 2 3 2 1, so looping the cycle never shows an end frame twice in a row.
export function playbackSequence(count, direction = 'forward') {
  const forward = Array.from({ length: Math.max(0, count) }, (_, i) => i);
  const reverse = forward.slice().reverse();
  const back = list => list.slice(1, -1).reverse(); // the way back, ends excluded
  switch (direction) {
    case 'reverse': return reverse;
    case 'pingpong': return [...forward, ...back(forward)];
    case 'pingpong-reverse': return [...reverse, ...back(reverse)];
    default: return forward;
  }
}

// The order one pass of `anim` shows its entries in. A looping animation
// repeats its cycle; a one-shot ping-pong closes back on its first frame
// (0 1 2 1 0), so it ends where it started rather than one frame short.
export function playOrder(anim, loop) {
  const direction = anim.direction ?? 'forward';
  const sequence = playbackSequence(anim.frames.length, direction);
  const pingpong = direction === 'pingpong' || direction === 'pingpong-reverse';
  return !loop && pingpong && sequence.length > 1 ? [...sequence, sequence[0]] : sequence;
}

// Pure step function for the timeline's playback loop: given how much time
// elapsed since the last tick (already scaled by the playback-speed
// multiplier), advances `position`/`acc` across as many frame boundaries as
// `elapsedMs` covers -- a slow tab can lag several frames behind in one rAF
// tick, hence the while loop rather than a single step. Mirrors
// timeline-presenter.js's tick behavior, minus the DOM/rAF/preview side
// effects, which stay in the Presenter (js/modes/sprites/presentation/
// timeline-presenter.js).
//
// `position` is an entry index; the order follows the animation's direction
// (playOrder). `cursor` is the index into that order, which a ping-pong needs
// to tell the way out from the way back: pass back the returned cursor on the
// next tick. A missing or stale cursor (one not showing `position`) resumes
// at the entry's first place in the order.
export function advancePlayback(anim, position, acc, elapsedMs, loop, cursor = null) {
  const order = playOrder(anim, loop);
  let at = order[cursor] === position ? cursor : Math.max(0, order.indexOf(position));
  let nextPosition = position;
  let nextAcc = acc + elapsedMs;
  let stopped = false;
  let entry = anim.frames[nextPosition];
  while (entry && nextAcc >= effectiveDuration(anim, entry)) {
    nextAcc -= effectiveDuration(anim, entry);
    at += 1;
    if (at >= order.length) {
      if (loop) {
        at = 0;
      } else {
        at = order.length - 1;
        stopped = true;
        break;
      }
    }
    nextPosition = order[at];
    entry = anim.frames[nextPosition];
  }
  return { position: nextPosition, acc: nextAcc, stopped, cursor: at };
}
