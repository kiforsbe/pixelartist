// Ordered perimeter paths for the rect and ellipse tools, and the
// `outline: false` flag that lets the engine draw a filled shape's interior
// without its border.
//
// These exist so rect and ellipse can be STAMPED like the line tool -- so a
// brush's size, spacing, scatter and rotate jitter reach them. The governing
// requirement is that the SHAPE does not change: a size-1 brush with no
// spacing and no scatter must stamp exactly the pixels the old primitives
// drew, or every existing drawing would render differently.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBitmap, getPixel, drawRect, drawEllipse,
  rectOutlinePath, ellipseOutlinePath,
} from '../js/core/pixels.js';
import { stampsAlongPath } from '../js/core/brush-stroke.js';

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

// Every pixel a draw call actually wrote, as a "x,y" key set. Alpha is the
// test: a fresh bitmap is transparent, and both colours below are opaque.
function paintedSet(draw, w = 40, h = 40) {
  const bmp = createBitmap(w, h);
  draw(bmp);
  const out = new Set();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (getPixel(bmp, x, y)[3] > 0) out.add(`${x},${y}`);
  return out;
}

const keysOf = path => new Set(path.map(p => `${p.x},${p.y}`));

// A box list wide enough to exercise odd/even extents, wide/tall aspect
// ratios and the degenerate 1px cases, all of which take different branches.
const BOXES = [
  [2, 2, 2, 2],      // single pixel
  [2, 2, 9, 2],      // one row
  [2, 2, 2, 9],      // one column
  [2, 2, 3, 3],      // 2x2
  [1, 1, 4, 4],
  [1, 1, 5, 5],
  [3, 3, 12, 8],     // wide
  [3, 3, 8, 14],     // tall
  [0, 0, 20, 20],
  [5, 2, 30, 31],
];

test('rectOutlinePath covers exactly the pixels drawRect draws as a border', () => {
  for (const [x0, y0, x1, y1] of BOXES) {
    const drawn = paintedSet(b => drawRect(b, x0, y0, x1, y1, RED, false));
    assert.deepEqual(keysOf(rectOutlinePath(x0, y0, x1, y1)), drawn,
      `rect ${x0},${y0}-${x1},${y1} border set differs`);
  }
});

test('rectOutlinePath emits each pixel once and walks a closed, adjacent loop', () => {
  for (const [x0, y0, x1, y1] of BOXES) {
    const path = rectOutlinePath(x0, y0, x1, y1);
    // A duplicate would double-stamp that pixel -- invisible at opacity 100
    // and a visible bright spot under a dither screen, which skips pixels by
    // POSITION and would let the second stamp through where the first was
    // declined.
    assert.equal(keysOf(path).size, path.length, `rect ${x0},${y0}-${x1},${y1} repeats a pixel`);
    for (let i = 1; i < path.length; i++) {
      const d = Math.max(Math.abs(path[i].x - path[i - 1].x), Math.abs(path[i].y - path[i - 1].y));
      assert.equal(d, 1, `rect path jumps at index ${i}`);
    }
    // Closed: the last pixel is adjacent to the first, so `spacing` does not
    // leave a gap where the walk wrapped around. Only a genuine 2D box is a
    // loop -- a box one pixel wide or tall is a straight line whose ends are
    // its two ends, and closing it would mean emitting a pixel twice.
    if (x0 !== x1 && y0 !== y1) {
      const a = path[0], z = path[path.length - 1];
      assert.equal(Math.max(Math.abs(a.x - z.x), Math.abs(a.y - z.y)), 1,
        `rect ${x0},${y0}-${x1},${y1} path does not close`);
    }
  }
});

test('ellipseOutlinePath covers exactly the pixels drawEllipse draws as a border', () => {
  // This is the no-regression assertion for the whole change: the outline
  // point SET is derived from the same classification the scanline uses, so
  // a stamped border occupies the ellipse the fill was cut to.
  for (const [x0, y0, x1, y1] of BOXES) {
    const drawn = paintedSet(b => drawEllipse(b, x0, y0, x1, y1, RED, false));
    assert.deepEqual(keysOf(ellipseOutlinePath(x0, y0, x1, y1)), drawn,
      `ellipse ${x0},${y0}-${x1},${y1} border set differs`);
  }
});

test('ellipseOutlinePath emits each pixel once and walks around the perimeter', () => {
  for (const [x0, y0, x1, y1] of BOXES) {
    const path = ellipseOutlinePath(x0, y0, x1, y1);
    assert.equal(keysOf(path).size, path.length, `ellipse ${x0},${y0}-${x1},${y1} repeats a pixel`);
  }
  // Angle order is a walk AROUND the border, so consecutive points are
  // neighbours. Scanline order -- the thing this replaces -- would alternate
  // between the left and right sides of the ellipse and make `spacing` read
  // as a vertical comb rather than dashes along the curve. A handful of
  // small steps are allowed where the border is two pixels thick and two
  // points share an angle band.
  const path = ellipseOutlinePath(0, 0, 20, 20);
  let far = 0;
  for (let i = 1; i < path.length; i++) {
    const d = Math.max(Math.abs(path[i].x - path[i - 1].x), Math.abs(path[i].y - path[i - 1].y));
    if (d > 2) far++;
  }
  assert.equal(far, 0, 'angle-ordered ellipse path should not jump across the shape');
  // Anti-vacuity: scanline order over the SAME points fails that check, so
  // the assertion is measuring the ordering and not a property every
  // ordering happens to have.
  const scan = [...path].sort((p, q) => p.y - q.y || p.x - q.x);
  let scanFar = 0;
  for (let i = 1; i < scan.length; i++) {
    const d = Math.max(Math.abs(scan[i].x - scan[i - 1].x), Math.abs(scan[i].y - scan[i - 1].y));
    if (d > 2) scanFar++;
  }
  assert.ok(scanFar > 0, 'the adjacency check cannot distinguish orderings');
});

test('ellipseOutlinePath is deterministic, so a preview does not reshuffle', () => {
  // A shape tool re-rasterizes from its anchor on every pointer move. If the
  // path order varied between calls, each frame would hand `stampsAlongPath`
  // a different ordinal for the same pixel and scatter would crawl under the
  // cursor.
  const a = ellipseOutlinePath(3, 3, 17, 11);
  const b = ellipseOutlinePath(3, 3, 17, 11);
  assert.deepEqual(a, b);
});

test('a degenerate ellipse falls back to the box path, still without duplicates', () => {
  // One pixel wide or tall: the ellipse equation degenerates and drawEllipse
  // has always drawn a filled box there. The path has to agree, or the tool
  // would stamp a different shape than the primitive fills.
  for (const box of [[2, 2, 2, 9], [2, 2, 9, 2], [4, 4, 4, 4]]) {
    const drawn = paintedSet(b => drawEllipse(b, ...box, RED, false));
    const path = ellipseOutlinePath(...box);
    assert.deepEqual(keysOf(path), drawn, `degenerate ${box} differs`);
    assert.equal(keysOf(path).size, path.length);
  }
});

// --- outline: false ------------------------------------------------------

test('drawRect with outline:false fills the interior and leaves the border alone', () => {
  const withBorder = paintedSet(b => drawRect(b, 2, 2, 8, 8, RED, BLUE));
  const interiorOnly = paintedSet(b => drawRect(b, 2, 2, 8, 8, RED, BLUE, null, { outline: false }));
  const border = keysOf(rectOutlinePath(2, 2, 8, 8));

  // Exactly the border is missing -- not one pixel more (which would leave a
  // seam the stamped border might not cover) and not one less (which would
  // leave an unstamped 1px outline under the stamped one).
  assert.deepEqual(new Set([...withBorder].filter(k => !interiorOnly.has(k))), border);
  for (const k of border) assert.ok(!interiorOnly.has(k), `${k} was still drawn`);
  assert.ok(interiorOnly.size > 0, 'interior was not drawn at all');
});

test('drawEllipse with outline:false fills the interior and leaves the border alone', () => {
  const withBorder = paintedSet(b => drawEllipse(b, 1, 1, 15, 11, RED, BLUE));
  const interiorOnly = paintedSet(b => drawEllipse(b, 1, 1, 15, 11, RED, BLUE, null, { outline: false }));
  const border = keysOf(ellipseOutlinePath(1, 1, 15, 11));

  assert.deepEqual(new Set([...withBorder].filter(k => !interiorOnly.has(k))), border);
  assert.ok(interiorOnly.size > 0, 'interior was not drawn at all');
});

test('outline:false with no fill draws nothing', () => {
  // The unfilled case: the engine skips the primitive entirely and stamps
  // only the path, so this call must not sneak an interior in.
  assert.equal(paintedSet(b => drawRect(b, 2, 2, 8, 8, RED, false, null, { outline: false })).size, 0);
  assert.equal(paintedSet(b => drawEllipse(b, 2, 2, 8, 8, RED, false, null, { outline: false })).size, 0);
});

test('omitting the options argument keeps the original behaviour', () => {
  // Every pre-existing caller passes seven arguments. They must be unaffected.
  const a = paintedSet(b => drawRect(b, 2, 2, 8, 8, RED, BLUE));
  const c = paintedSet(b => drawRect(b, 2, 2, 8, 8, RED, BLUE, null, {}));
  assert.deepEqual(a, c);
  const d = paintedSet(b => drawEllipse(b, 2, 2, 9, 7, RED, true));
  const e = paintedSet(b => drawEllipse(b, 2, 2, 9, 7, RED, true, null, {}));
  assert.deepEqual(d, e);
});

// --- the shape survives stamping -----------------------------------------

test('a size-1 brush stamped along the path reproduces the old outline exactly', () => {
  // The end-to-end no-regression check, at the level the engine works at:
  // default mask (size 1, spacing 1, no scatter) over the perimeter path
  // must hit precisely the pixels the primitive used to draw.
  const mask = { kind: 'square', size: 1, spacing: 1, scatter: 0, rotateJitter: false };
  for (const [x0, y0, x1, y1] of BOXES) {
    for (const [name, path, draw] of [
      ['rect', rectOutlinePath(x0, y0, x1, y1), b => drawRect(b, x0, y0, x1, y1, RED, false)],
      ['ellipse', ellipseOutlinePath(x0, y0, x1, y1), b => drawEllipse(b, x0, y0, x1, y1, RED, false)],
    ]) {
      const stamps = stampsAlongPath(path, mask, 1234);
      assert.deepEqual(keysOf(stamps), paintedSet(draw), `${name} ${x0},${y0}-${x1},${y1}`);
    }
  }
});

test('stampsAlongPath treats its input as final and does not densify it', () => {
  // strokeStamps Bresenham-bridges between points; this one must not. An
  // ellipse's angle-ordered path can place two border pixels non-adjacently,
  // and bridging them would add pixels the ellipse does not contain -- the
  // shape would change, which is the one thing this change may not do.
  const mask = { kind: 'square', size: 1, spacing: 1, scatter: 0, rotateJitter: false };
  const sparse = [{ x: 0, y: 0 }, { x: 9, y: 0 }];
  const stamps = stampsAlongPath(sparse, mask, 1);
  assert.equal(stamps.length, 2);
  assert.deepEqual(stamps.map(s => s.x), [0, 9]);
});

test('spacing thins the path without moving the stamps off it', () => {
  // What stamping buys the shape tools: spacing, scatter and jitter now
  // reach them. Spacing must keep every stamp ON the perimeter -- it selects
  // path points, it does not resample the shape.
  const path = ellipseOutlinePath(0, 0, 20, 20);
  const onPath = keysOf(path);
  const stamps = stampsAlongPath(path, { spacing: 4, scatter: 0 }, 7);
  assert.ok(stamps.length > 0);
  assert.ok(stamps.length < path.length, 'spacing 4 thinned nothing');
  for (const s of stamps) assert.ok(onPath.has(`${s.x},${s.y}`), `stamp ${s.x},${s.y} left the perimeter`);
});
