// Builds spritesheet(PNG+JSON)/image-sequence/GIF-ready-frame output for
// one animation or every animation on a sprite sheet. Actual GIF byte
// encoding lives in js/core/gif.js -- this module only prepares frame data.
import { flattenSheet, effectiveDuration } from '../core/model.js';
import { copyRegion } from '../core/pixels.js';

function animFrameBitmaps(sheet, anim) {
  const flat = flattenSheet(sheet);
  return anim.frames.map(af => {
    const frame = sheet.frames.find(f => f.id === af.frameId);
    return { frame, bitmap: copyRegion(flat, frame.x, frame.y, frame.w, frame.h), delayMs: effectiveDuration(anim, af) };
  });
}

// A specific animation by id, or every animation on the sheet when animId
// is null/undefined.
export function selectAnimations(sheet, animId) {
  return animId ? sheet.animations.filter(a => a.id === animId) : sheet.animations;
}

// One PNG-worth-of-pixel-data per frame, packed left-to-right into a tight
// new image (not the original sheet layout), alongside the same
// Frames-JSON shape scoped to just this animation's own frames.
export function buildAnimationSpritesheet(sheet, anim) {
  const shots = animFrameBitmaps(sheet, anim);
  const width = shots.reduce((sum, s) => sum + s.bitmap.width, 0);
  const height = Math.max(...shots.map(s => s.bitmap.height));
  const packed = { width, height, data: new Uint8ClampedArray(width * height * 4) };

  let x = 0;
  const frames = shots.map((s, index) => {
    const rect = { name: s.frame.name, index, x, y: 0, w: s.bitmap.width, h: s.bitmap.height,
      pivotX: s.frame.pivotX, pivotY: s.frame.pivotY };
    for (let py = 0; py < s.bitmap.height; py++)
      for (let px = 0; px < s.bitmap.width; px++) {
        const si = (py * s.bitmap.width + px) * 4, di = (py * width + (x + px)) * 4;
        packed.data.set(s.bitmap.data.subarray(si, si + 4), di);
      }
    x += s.bitmap.width;
    return rect;
  });

  const json = {
    sheet: `${anim.name}.png`, width, height, frames,
    animations: [{ name: anim.name, loop: anim.loop,
      frames: shots.map((s, i) => ({ frame: frames[i].name, duration: s.delayMs })) }],
  };
  return { bitmap: packed, json };
}

// One { name, bitmap } per frame, named `<anim>_000`, `<anim>_001`, ...
export function buildAnimationImageSequence(sheet, anim) {
  return animFrameBitmaps(sheet, anim).map((s, i) =>
    ({ name: `${anim.name}_${String(i).padStart(3, '0')}`, bitmap: s.bitmap }));
}

// { pixels, width, height, delayMs } per frame, ready for js/core/gif.js's
// encodeGif.
export function buildAnimationGifFrames(sheet, anim) {
  return animFrameBitmaps(sheet, anim).map(s =>
    ({ pixels: s.bitmap.data, width: s.bitmap.width, height: s.bitmap.height, delayMs: s.delayMs }));
}
