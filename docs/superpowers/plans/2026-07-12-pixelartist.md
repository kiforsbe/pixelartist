# PixelArtist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dependency-free browser app for pixel-editing packed sprite/tile atlases: layers, frames, animations with timeline + onion skin, and a tile editor with live neighbor previews.

**Architecture:** Pure-logic core modules (`js/core/`) with no DOM dependency, tested via `node --test`. A thin app layer (`js/app/`) handles state, file I/O (File System Access API, ZIP via CompressionStream, IndexedDB autosave). UI modules (`js/ui/`) render to Canvas 2D and plain DOM. Central store + command-stack undo.

**Tech Stack:** Vanilla ES modules, Canvas 2D, Node built-in test runner. Zero runtime dependencies, no build step.

## Global Constraints

- No npm dependencies, no build step. `package.json` exists only for `"type": "module"` and the `test` script.
- All rendering nearest-neighbor: every canvas 2D context sets `imageSmoothingEnabled = false`.
- Core modules (`js/core/**`) must not reference `document`, `window`, `navigator`, or canvas — pure data in/out.
- Project format version constant: `PROJECT_VERSION = 1`; packed project extension `.pixelproj` (a ZIP); metadata file inside bundle: `project.json`; layer images at `images/<sheetId>/<layerId>.png`.
- Spec: `docs/superpowers/specs/2026-07-12-pixelartist-design.md`. When a detail is ambiguous, the spec wins.
- Tests: `node --test tests/` must pass at every commit. Run with `npm test`.
- Commit after every task (conventional commits: `feat:`, `test:`, `chore:`).
- Colors in code are `[r,g,b,a]` arrays of 0–255 integers everywhere (never hex strings, except palette source data which is parsed).
- A "Bitmap" is `{width, height, data: Uint8ClampedArray}` (RGBA, row-major) — mirrors ImageData but constructible in Node.

## File Structure

```
index.html                  app shell (top bar, panels, canvas)
css/app.css                 all styles (dark theme)
serve.ps1                   one-line static server launcher
README.md                   run + usage instructions
package.json                {"type":"module","scripts":{"test":"node --test tests/"}}
js/core/pixels.js           Bitmap ops: draw, fill, flood, copy, flip
js/core/commands.js         CommandStack (undo/redo)
js/core/palettes.js         palette model, indexed logic, remap
js/core/systempalettes.js   built-in system palette data
js/core/model.js            project/sheet/layer/frame/animation model + JSON
js/core/slicing.js          grid slicing -> frames
js/core/neighbors.js        tile neighbor presets + preview grid resolution
js/core/zip.js              ZIP read/write (CompressionStream)
js/core/bundle.js           project <-> file entries (uses injected png codec)
js/app/pngcodec.js          browser PNG encode/decode (OffscreenCanvas)
js/app/io.js                FS Access open/save, fallback, IndexedDB autosave
js/app/state.js             app store: project, selection, tool, events
js/app/main.js              bootstrap, mode tabs, menu wiring, shortcuts
js/ui/canvasview.js         zoom/pan canvas with pixel grid + pointer mapping
js/ui/tools.js              tool implementations bound to canvasview events
js/ui/panels.js             color picker, palette panel, layers panel
js/ui/frames.js             frame tool, slice dialog, pixel-carrying move
js/ui/overlays.js           name/index labels + animation sequence badges
js/ui/timeline.js           animation timeline strip + preview player
js/ui/frameeditor.js        focused frame view + onion skin
js/ui/tilemode.js           tile atlas view, tile move/swap
js/ui/tileeditor.js         focused tile view + neighbor preview/config
tests/*.test.mjs            one test file per core module + bundle
```

---

### Task 1: Scaffold

**Files:**
- Create: `package.json`, `index.html`, `css/app.css`, `js/app/main.js`, `serve.ps1`, `README.md`, `.gitignore`

**Interfaces:**
- Produces: `index.html` element IDs used by ALL later UI tasks:
  `#mode-tabs`, `#tab-sprites`, `#tab-tiles`, `#menu-bar`, `#btn-undo`, `#btn-redo`,
  `#tool-palette`, `#canvas-host`, `#side-panels`, `#panel-colors`, `#panel-layers`,
  `#panel-context` (frames/animations or tile inspector mount point), `#status-bar`,
  `#overlay-toggles`.

- [ ] **Step 1: Write files**

`package.json`:
```json
{
  "name": "pixelartist",
  "version": "0.1.0",
  "type": "module",
  "scripts": { "test": "node --test tests/" }
}
```

`index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PixelArtist</title>
<link rel="stylesheet" href="css/app.css">
</head>
<body>
<header id="top-bar">
  <div id="menu-bar">
    <button id="btn-new">New</button>
    <button id="btn-open">Open</button>
    <button id="btn-save">Save</button>
    <button id="btn-save-as">Save As…</button>
    <button id="btn-export">Export</button>
  </div>
  <nav id="mode-tabs">
    <button id="tab-sprites" class="active">Sprite Sheets</button>
    <button id="tab-tiles">Tile Sheets</button>
  </nav>
  <div id="overlay-toggles">
    <label><input type="checkbox" id="ovl-labels" checked> Labels</label>
    <label><input type="checkbox" id="ovl-seq" checked> Sequences</label>
  </div>
  <div id="history-buttons">
    <button id="btn-undo" disabled>↶</button>
    <button id="btn-redo" disabled>↷</button>
  </div>
</header>
<main id="workspace">
  <aside id="tool-palette"></aside>
  <section id="canvas-host"></section>
  <aside id="side-panels">
    <div id="panel-colors" class="panel"><h3>Colors</h3></div>
    <div id="panel-layers" class="panel"><h3>Layers</h3></div>
    <div id="panel-context" class="panel"></div>
  </aside>
</main>
<footer id="status-bar"><span id="status-pos"></span><span id="status-zoom"></span><span id="status-tool"></span></footer>
<script type="module" src="js/app/main.js"></script>
</body>
</html>
```

`css/app.css` (dark theme, CSS grid layout — complete file):
```css
* { box-sizing: border-box; margin: 0; }
:root {
  --bg: #1e1f24; --bg2: #26272e; --bg3: #2f3038; --fg: #d6d7dc;
  --accent: #4f8cff; --border: #3a3b44;
}
html, body { height: 100%; }
body {
  display: grid; grid-template-rows: auto 1fr auto; height: 100vh;
  background: var(--bg); color: var(--fg);
  font: 13px/1.4 "Segoe UI", system-ui, sans-serif; overflow: hidden;
}
#top-bar { display: flex; gap: 16px; align-items: center; padding: 4px 8px;
  background: var(--bg2); border-bottom: 1px solid var(--border); }
#workspace { display: grid; grid-template-columns: 48px 1fr 280px; min-height: 0; }
#tool-palette { background: var(--bg2); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 2px; padding: 4px; }
#tool-palette button { width: 38px; height: 38px; font-size: 17px; }
#canvas-host { position: relative; overflow: hidden; background: var(--bg); }
#canvas-host canvas { position: absolute; inset: 0; }
#side-panels { background: var(--bg2); border-left: 1px solid var(--border);
  overflow-y: auto; display: flex; flex-direction: column; }
.panel { border-bottom: 1px solid var(--border); padding: 8px; }
.panel h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
  color: #8b8d98; margin-bottom: 6px; }
#status-bar { display: flex; gap: 24px; padding: 3px 10px; background: var(--bg2);
  border-top: 1px solid var(--border); font-size: 12px; color: #9a9ca8; }
button { background: var(--bg3); color: var(--fg); border: 1px solid var(--border);
  border-radius: 4px; padding: 4px 10px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button.active { background: var(--accent); color: #fff; }
button:disabled { opacity: .4; cursor: default; }
input[type="text"], input[type="number"], select {
  background: var(--bg); color: var(--fg); border: 1px solid var(--border);
  border-radius: 3px; padding: 3px 6px; width: 100%; }
dialog { background: var(--bg2); color: var(--fg); border: 1px solid var(--border);
  border-radius: 6px; padding: 16px; }
dialog::backdrop { background: rgba(0,0,0,.5); }
.row { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
```

`js/app/main.js` (placeholder bootstrap; replaced in Task 11):
```js
console.log('PixelArtist loaded');
```

`serve.ps1`:
```powershell
# Serves the app at http://localhost:8080 (ES modules need a server, file:// won't work)
npx --yes serve -l 8080 .
```

`README.md`:
```markdown
# PixelArtist

Browser-based pixel-art editor for packed sprite sheets and tile sheets.
Frames + animations (timeline, onion skin), tiles with live neighbor preview,
layers, indexed/system palettes. No dependencies, no build step.

## Run

ES modules require a static server (file:// will not work):

    ./serve.ps1          # or: python -m http.server 8080

Open http://localhost:8080 in Chrome/Edge (full file-system support) or any
modern browser (packed .pixelproj download/upload fallback).

## Test

    npm test
```

`.gitignore`:
```
node_modules/
```

- [ ] **Step 2: Verify shell loads**

Run `./serve.ps1` in background, open http://localhost:8080 (Playwright MCP or manually). Expected: dark UI with top bar (mode tabs, file buttons), empty tool column, three side panels, status bar. Console shows "PixelArtist loaded", no errors.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold app shell, styles, launcher, README"
```

---

### Task 2: Bitmap operations (`js/core/pixels.js`)

**Files:**
- Create: `js/core/pixels.js`
- Test: `tests/pixels.test.mjs`

**Interfaces:**
- Produces:
  - `createBitmap(width, height) -> Bitmap` (transparent black)
  - `cloneBitmap(bmp) -> Bitmap`
  - `getPixel(bmp, x, y) -> [r,g,b,a]` (out of bounds -> `null`)
  - `setPixel(bmp, x, y, rgba)` (out of bounds -> no-op)
  - `drawLine(bmp, x0, y0, x1, y1, rgba, size=1)` Bresenham; `size` = square brush side
  - `drawRect(bmp, x0, y0, x1, y1, rgba, filled)`
  - `drawEllipse(bmp, x0, y0, x1, y1, rgba, filled)` midpoint ellipse in bounding box
  - `floodFill(bmp, x, y, rgba, contiguous=true) -> dirtyRect|null` replaces target color; non-contiguous replaces everywhere
  - `copyRegion(bmp, x, y, w, h) -> Bitmap`
  - `blitRegion(dst, src, dx, dy)` (opaque copy incl. alpha, clipped)
  - `fillRegion(bmp, x, y, w, h, rgba)`
  - `flipBitmap(bmp, flipH, flipV) -> Bitmap`
  - `colorsEqual(a, b) -> boolean`

- [ ] **Step 1: Write failing tests**

`tests/pixels.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBitmap, cloneBitmap, getPixel, setPixel, drawLine, drawRect,
  drawEllipse, floodFill, copyRegion, blitRegion, fillRegion, flipBitmap,
  colorsEqual,
} from '../js/core/pixels.js';

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], CLEAR = [0, 0, 0, 0];

test('createBitmap is transparent and sized', () => {
  const b = createBitmap(4, 3);
  assert.equal(b.width, 4); assert.equal(b.height, 3);
  assert.equal(b.data.length, 48);
  assert.deepEqual(getPixel(b, 0, 0), CLEAR);
});

test('set/get pixel roundtrip; out of bounds safe', () => {
  const b = createBitmap(4, 4);
  setPixel(b, 2, 1, RED);
  assert.deepEqual(getPixel(b, 2, 1), RED);
  assert.equal(getPixel(b, -1, 0), null);
  assert.equal(getPixel(b, 4, 0), null);
  setPixel(b, 99, 99, RED); // no throw
});

test('drawLine draws inclusive endpoints, brush size grows square', () => {
  const b = createBitmap(8, 8);
  drawLine(b, 1, 1, 5, 1, RED, 1);
  for (let x = 1; x <= 5; x++) assert.deepEqual(getPixel(b, x, 1), RED);
  assert.deepEqual(getPixel(b, 6, 1), CLEAR);
  const b2 = createBitmap(8, 8);
  drawLine(b2, 3, 3, 3, 3, RED, 2); // 2x2 brush anchored at pixel
  assert.deepEqual(getPixel(b2, 3, 3), RED);
  assert.deepEqual(getPixel(b2, 4, 4), RED);
});

test('drawRect outline vs filled', () => {
  const b = createBitmap(8, 8);
  drawRect(b, 1, 1, 4, 4, RED, false);
  assert.deepEqual(getPixel(b, 1, 1), RED);
  assert.deepEqual(getPixel(b, 4, 4), RED);
  assert.deepEqual(getPixel(b, 2, 2), CLEAR);
  drawRect(b, 1, 1, 4, 4, BLUE, true);
  assert.deepEqual(getPixel(b, 2, 2), BLUE);
});

test('drawEllipse filled covers center, stays in bbox', () => {
  const b = createBitmap(10, 10);
  drawEllipse(b, 1, 1, 8, 8, RED, true);
  assert.deepEqual(getPixel(b, 5, 5), RED);
  assert.deepEqual(getPixel(b, 0, 0), CLEAR);
  assert.deepEqual(getPixel(b, 1, 1), CLEAR); // corner of bbox outside ellipse
});

test('floodFill contiguous fills connected region and reports dirty rect', () => {
  const b = createBitmap(6, 6);
  drawLine(b, 0, 3, 5, 3, RED, 1); // wall splits top/bottom
  const rect = floodFill(b, 0, 0, BLUE, true);
  assert.deepEqual(getPixel(b, 5, 2), BLUE);
  assert.deepEqual(getPixel(b, 0, 5), CLEAR); // below wall untouched
  assert.deepEqual(rect, { x: 0, y: 0, w: 6, h: 3 });
  assert.equal(floodFill(b, 0, 0, BLUE, true), null); // same color -> no-op
});

test('floodFill non-contiguous replaces color everywhere', () => {
  const b = createBitmap(4, 4);
  setPixel(b, 0, 0, RED); setPixel(b, 3, 3, RED);
  floodFill(b, 0, 0, BLUE, false);
  assert.deepEqual(getPixel(b, 3, 3), BLUE);
});

test('copy/blit/fill region and flip', () => {
  const b = createBitmap(4, 4);
  setPixel(b, 0, 0, RED); setPixel(b, 1, 0, BLUE);
  const cut = copyRegion(b, 0, 0, 2, 1);
  assert.deepEqual(getPixel(cut, 1, 0), BLUE);
  const dst = createBitmap(4, 4);
  blitRegion(dst, cut, 2, 3);
  assert.deepEqual(getPixel(dst, 3, 3), BLUE);
  fillRegion(b, 0, 0, 2, 2, CLEAR);
  assert.deepEqual(getPixel(b, 0, 0), CLEAR);
  const f = flipBitmap(cut, true, false);
  assert.deepEqual(getPixel(f, 0, 0), BLUE);
  assert.ok(colorsEqual(getPixel(f, 1, 0), RED));
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test` — Expected: FAIL, cannot find module `js/core/pixels.js`.

- [ ] **Step 3: Implement `js/core/pixels.js`**

```js
export function createBitmap(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneBitmap(bmp) {
  return { width: bmp.width, height: bmp.height, data: new Uint8ClampedArray(bmp.data) };
}

export function colorsEqual(a, b) {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function getPixel(bmp, x, y) {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return null;
  const i = (y * bmp.width + x) * 4;
  return [bmp.data[i], bmp.data[i + 1], bmp.data[i + 2], bmp.data[i + 3]];
}

export function setPixel(bmp, x, y, rgba) {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
  const i = (y * bmp.width + x) * 4;
  bmp.data[i] = rgba[0]; bmp.data[i + 1] = rgba[1];
  bmp.data[i + 2] = rgba[2]; bmp.data[i + 3] = rgba[3];
}

function stamp(bmp, x, y, rgba, size) {
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) setPixel(bmp, x + dx, y + dy, rgba);
}

export function drawLine(bmp, x0, y0, x1, y1, rgba, size = 1) {
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    stamp(bmp, x0, y0, rgba, size);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

export function drawRect(bmp, x0, y0, x1, y1, rgba, filled) {
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  for (let y = ya; y <= yb; y++)
    for (let x = xa; x <= xb; x++)
      if (filled || x === xa || x === xb || y === ya || y === yb)
        setPixel(bmp, x, y, rgba);
}

export function drawEllipse(bmp, x0, y0, x1, y1, rgba, filled) {
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  const rx = (xb - xa) / 2, ry = (yb - ya) / 2;
  const cx = xa + rx, cy = ya + ry;
  if (rx < 0.5 || ry < 0.5) { drawRect(bmp, xa, ya, xb, yb, rgba, true); return; }
  // scanline test against ellipse equation; outline = inside but a 1px-shrunk ellipse misses
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const nx = (x + 0.5 - (cx + 0.5)) / (rx + 0.5);
      const ny = (y + 0.5 - (cy + 0.5)) / (ry + 0.5);
      const inside = nx * nx + ny * ny <= 1;
      if (!inside) continue;
      if (filled) { setPixel(bmp, x, y, rgba); continue; }
      const ix = (x + 0.5 - (cx + 0.5)) / Math.max(rx - 0.5, 0.5);
      const iy = (y + 0.5 - (cy + 0.5)) / Math.max(ry - 0.5, 0.5);
      if (ix * ix + iy * iy > 1) setPixel(bmp, x, y, rgba);
    }
  }
}

export function floodFill(bmp, x, y, rgba, contiguous = true) {
  const target = getPixel(bmp, x, y);
  if (!target || colorsEqual(target, rgba)) return null;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  const mark = (px, py) => {
    setPixel(bmp, px, py, rgba);
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  };
  if (!contiguous) {
    for (let py = 0; py < bmp.height; py++)
      for (let px = 0; px < bmp.width; px++)
        if (colorsEqual(getPixel(bmp, px, py), target)) mark(px, py);
  } else {
    const stack = [[x, y]];
    while (stack.length) {
      const [px, py] = stack.pop();
      if (!colorsEqual(getPixel(bmp, px, py), target)) continue;
      mark(px, py);
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function copyRegion(bmp, x, y, w, h) {
  const out = createBitmap(w, h);
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++) {
      const p = getPixel(bmp, x + dx, y + dy);
      if (p) setPixel(out, dx, dy, p);
    }
  return out;
}

export function blitRegion(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++)
      setPixel(dst, dx + x, dy + y, getPixel(src, x, y));
}

export function fillRegion(bmp, x, y, w, h, rgba) {
  for (let py = y; py < y + h; py++)
    for (let px = x; px < x + w; px++) setPixel(bmp, px, py, rgba);
}

export function flipBitmap(bmp, flipH, flipV) {
  const out = createBitmap(bmp.width, bmp.height);
  for (let y = 0; y < bmp.height; y++)
    for (let x = 0; x < bmp.width; x++) {
      const tx = flipH ? bmp.width - 1 - x : x;
      const ty = flipV ? bmp.height - 1 - y : y;
      setPixel(out, tx, ty, getPixel(bmp, x, y));
    }
  return out;
}
```

- [ ] **Step 4: Run tests, verify pass** — `npm test` → all pixels tests PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: bitmap core (draw, flood fill, regions, flip)"`

---

### Task 3: Command stack (`js/core/commands.js`)

**Files:**
- Create: `js/core/commands.js`
- Test: `tests/commands.test.mjs`

**Interfaces:**
- Produces:
  - `class CommandStack { constructor(limit=200); push(cmd); undo(); redo(); canUndo(); canRedo(); onChange (callback prop); clear() }` — `push` runs `cmd.do()` then records; `undo()` runs `cmd.undo()`; a `cmd` is `{label, do(), undo()}`.
  - `makePixelPatch(bitmap, rect, before, after, label) -> cmd` — `before`/`after` are Bitmaps sized `rect.w × rect.h` (from `copyRegion`); do/undo blit them at `rect.x, rect.y`.

- [ ] **Step 1: Write failing tests**

`tests/commands.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandStack, makePixelPatch } from '../js/core/commands.js';
import { createBitmap, setPixel, getPixel, copyRegion } from '../js/core/pixels.js';

test('push executes, undo/redo restore state, flags update', () => {
  let v = 0;
  const s = new CommandStack();
  assert.equal(s.canUndo(), false);
  s.push({ label: 'inc', do: () => v++, undo: () => v-- });
  s.push({ label: 'inc', do: () => v++, undo: () => v-- });
  assert.equal(v, 2);
  s.undo(); assert.equal(v, 1);
  assert.equal(s.canRedo(), true);
  s.redo(); assert.equal(v, 2);
});

test('push clears redo branch; limit drops oldest', () => {
  let v = 0;
  const s = new CommandStack(2);
  const inc = () => ({ label: 'i', do: () => v++, undo: () => v-- });
  s.push(inc()); s.push(inc()); s.push(inc()); // limit 2: first dropped
  s.undo(); s.undo();
  assert.equal(s.canUndo(), false);
  assert.equal(v, 1); // one survives beyond history
  s.push(inc());
  assert.equal(s.canRedo(), false);
});

test('onChange fires on push/undo/redo', () => {
  let n = 0;
  const s = new CommandStack();
  s.onChange = () => n++;
  s.push({ label: 'x', do() {}, undo() {} });
  s.undo(); s.redo();
  assert.equal(n, 3);
});

test('makePixelPatch do/undo blits after/before', () => {
  const bmp = createBitmap(4, 4);
  const before = copyRegion(bmp, 1, 1, 2, 2);
  setPixel(bmp, 1, 1, [9, 9, 9, 255]);
  const after = copyRegion(bmp, 1, 1, 2, 2);
  const cmd = makePixelPatch(bmp, { x: 1, y: 1, w: 2, h: 2 }, before, after, 'paint');
  cmd.undo();
  assert.deepEqual(getPixel(bmp, 1, 1), [0, 0, 0, 0]);
  cmd.do();
  assert.deepEqual(getPixel(bmp, 1, 1), [9, 9, 9, 255]);
});
```

- [ ] **Step 2: Run tests, verify failure** — `npm test` → FAIL (module missing).

- [ ] **Step 3: Implement `js/core/commands.js`**

```js
import { blitRegion } from './pixels.js';

export class CommandStack {
  constructor(limit = 200) {
    this.limit = limit;
    this.done = [];
    this.undone = [];
    this.onChange = null;
  }
  #notify() { if (this.onChange) this.onChange(this); }
  push(cmd) {
    cmd.do();
    this.done.push(cmd);
    if (this.done.length > this.limit) this.done.shift();
    this.undone.length = 0;
    this.#notify();
  }
  undo() {
    const cmd = this.done.pop();
    if (!cmd) return;
    cmd.undo();
    this.undone.push(cmd);
    this.#notify();
  }
  redo() {
    const cmd = this.undone.pop();
    if (!cmd) return;
    cmd.do();
    this.done.push(cmd);
    this.#notify();
  }
  canUndo() { return this.done.length > 0; }
  canRedo() { return this.undone.length > 0; }
  clear() { this.done.length = 0; this.undone.length = 0; this.#notify(); }
}

export function makePixelPatch(bitmap, rect, before, after, label) {
  return {
    label,
    do() { blitRegion(bitmap, after, rect.x, rect.y); },
    undo() { blitRegion(bitmap, before, rect.x, rect.y); },
  };
}
```

- [ ] **Step 4: Run tests, verify pass** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: command stack undo/redo + pixel patch command"`

---

### Task 4: Palettes (`js/core/palettes.js`, `js/core/systempalettes.js`)

**Files:**
- Create: `js/core/palettes.js`, `js/core/systempalettes.js`
- Test: `tests/palettes.test.mjs`

**Interfaces:**
- Produces:
  - `createPalette({name, indexed=false, size=0}) -> {id, name, indexed, size, colors: [[r,g,b,a],...]}` — indexed palettes are pre-filled to `size` with black; non-indexed start empty and grow.
  - `parseHexColors(str) -> [[r,g,b,255],...]` — parses space-separated `rrggbb` hex.
  - `setEntry(palette, index, rgba)`, `addSwatch(palette, rgba)` (non-indexed only; indexed throws), `removeSwatch(palette, index)` (non-indexed only), `moveSwatch(palette, from, to)`
  - `nearestColor(palette, rgba) -> [r,g,b,a]` — Euclidean RGB distance (alpha preserved from input).
  - `remapColor(bitmap, fromRGBA, toRGBA) -> count` — recolor every exactly-matching pixel.
  - `INDEXED_SIZE_PRESETS = [2, 4, 16, 256]`
  - From `systempalettes.js`: `SYSTEM_PALETTES: [{name, colors}]` — read-only presets: Game Boy(4), NES(≤56, duplicates removed at build), C64(16), CGA(16), EGA(64, generated), ZX Spectrum(15), PICO-8(16), MSX(15), Apple II(15). `clonePalette(sys) -> palette` (indexed, size=colors.length).

Note: hex values below are best-known tables; a wrong shade is acceptable — the unit tests assert counts/structure, not exact hues.

- [ ] **Step 1: Write failing tests**

`tests/palettes.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPalette, parseHexColors, setEntry, addSwatch, removeSwatch,
  moveSwatch, nearestColor, remapColor, INDEXED_SIZE_PRESETS,
} from '../js/core/palettes.js';
import { SYSTEM_PALETTES, clonePalette } from '../js/core/systempalettes.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';

test('parseHexColors', () => {
  assert.deepEqual(parseHexColors('ff0000 00ff00'), [[255,0,0,255],[0,255,0,255]]);
});

test('indexed palette pre-filled, addSwatch forbidden', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 4 });
  assert.equal(p.colors.length, 4);
  assert.throws(() => addSwatch(p, [1,2,3,255]));
  setEntry(p, 2, [10,20,30,255]);
  assert.deepEqual(p.colors[2], [10,20,30,255]);
});

test('non-indexed palette grows, remove and move work', () => {
  const p = createPalette({ name: 'free' });
  addSwatch(p, [1,1,1,255]); addSwatch(p, [2,2,2,255]); addSwatch(p, [3,3,3,255]);
  moveSwatch(p, 2, 0);
  assert.deepEqual(p.colors[0], [3,3,3,255]);
  removeSwatch(p, 0);
  assert.equal(p.colors.length, 2);
});

test('nearestColor picks closest, keeps input alpha', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 2 });
  setEntry(p, 0, [0,0,0,255]); setEntry(p, 1, [200,200,200,255]);
  assert.deepEqual(nearestColor(p, [190,190,190,128]), [200,200,200,128]);
});

test('remapColor recolors exact matches only', () => {
  const b = createBitmap(3, 1);
  setPixel(b, 0, 0, [5,5,5,255]); setPixel(b, 1, 0, [5,5,5,254]);
  const n = remapColor(b, [5,5,5,255], [9,9,9,255]);
  assert.equal(n, 1);
  assert.deepEqual(getPixel(b, 0, 0), [9,9,9,255]);
  assert.deepEqual(getPixel(b, 1, 0), [5,5,5,254]);
});

test('system palettes present with expected sizes', () => {
  const names = SYSTEM_PALETTES.map(p => p.name);
  assert.ok(names.includes('Game Boy') && names.includes('PICO-8') && names.includes('NES'));
  const gb = SYSTEM_PALETTES.find(p => p.name === 'Game Boy');
  assert.equal(gb.colors.length, 4);
  const ega = SYSTEM_PALETTES.find(p => p.name === 'EGA (64)');
  assert.equal(ega.colors.length, 64);
  for (const sys of SYSTEM_PALETTES) {
    const seen = new Set(sys.colors.map(c => c.join(',')));
    assert.equal(seen.size, sys.colors.length, `${sys.name} has duplicate colors`);
  }
  const clone = clonePalette(gb);
  assert.equal(clone.indexed, true);
  assert.equal(clone.size, 4);
  assert.ok(clone.id);
});

test('size presets exported', () => {
  assert.deepEqual(INDEXED_SIZE_PRESETS, [2, 4, 16, 256]);
});
```

- [ ] **Step 2: Run tests, verify failure** — `npm test` → FAIL.

- [ ] **Step 3: Implement**

`js/core/palettes.js`:
```js
let nextId = 1;
export const INDEXED_SIZE_PRESETS = [2, 4, 16, 256];

export function newId(prefix) { return `${prefix}${Date.now().toString(36)}${(nextId++).toString(36)}`; }

export function createPalette({ name, indexed = false, size = 0 }) {
  const colors = indexed ? Array.from({ length: size }, () => [0, 0, 0, 255]) : [];
  return { id: newId('pal'), name, indexed, size: indexed ? size : 0, colors };
}

export function parseHexColors(str) {
  return str.trim().split(/\s+/).map(h => [
    parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16), 255,
  ]);
}

export function setEntry(palette, index, rgba) { palette.colors[index] = [...rgba]; }

export function addSwatch(palette, rgba) {
  if (palette.indexed) throw new Error('indexed palette has fixed size');
  palette.colors.push([...rgba]);
}

export function removeSwatch(palette, index) {
  if (palette.indexed) throw new Error('indexed palette has fixed size');
  palette.colors.splice(index, 1);
}

export function moveSwatch(palette, from, to) {
  const [c] = palette.colors.splice(from, 1);
  palette.colors.splice(to, 0, c);
}

export function nearestColor(palette, rgba) {
  let best = null, bestD = Infinity;
  for (const c of palette.colors) {
    const d = (c[0]-rgba[0])**2 + (c[1]-rgba[1])**2 + (c[2]-rgba[2])**2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ? [best[0], best[1], best[2], rgba[3]] : [...rgba];
}

export function remapColor(bitmap, from, to) {
  let count = 0;
  const d = bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] === from[0] && d[i+1] === from[1] && d[i+2] === from[2] && d[i+3] === from[3]) {
      d[i] = to[0]; d[i+1] = to[1]; d[i+2] = to[2]; d[i+3] = to[3];
      count++;
    }
  }
  return count;
}
```

`js/core/systempalettes.js`:
```js
import { parseHexColors, createPalette, setEntry } from './palettes.js';

function dedupe(colors) {
  const seen = new Set(), out = [];
  for (const c of colors) { const k = c.join(','); if (!seen.has(k)) { seen.add(k); out.push(c); } }
  return out;
}

// EGA: 64 colors, 2 bits per channel: bit0 = low intensity (0x55), bit1 = high (0xAA)
function egaColors() {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const ch = (hi, lo) => (hi ? 0xAA : 0) + (lo ? 0x55 : 0);
    out.push([ch(i & 4, i & 32), ch(i & 2, i & 16), ch(i & 1, i & 8), 255]);
  }
  return out;
}

const HEX = {
  'Game Boy': '0f380f 306230 8bac0f 9bbc0f',
  'PICO-8': '000000 1d2b53 7e2553 008751 ab5236 5f574f c2c3c7 fff1e8 ff004d ffa300 ffec27 00e436 29adff 83769c ff77a8 ffccaa',
  'Commodore 64': '000000 ffffff 880000 aaffee cc44cc 00cc55 0000aa eeee77 dd8855 664400 ff7777 333333 777777 aaff66 0088ff bbbbbb',
  'CGA': '000000 0000aa 00aa00 00aaaa aa0000 aa00aa aa5500 aaaaaa 555555 5555ff 55ff55 55ffff ff5555 ff55ff ffff55 ffffff',
  'ZX Spectrum': '000000 0000d7 d70000 d700d7 00d700 00d7d7 d7d700 d7d7d7 0000ff ff0000 ff00ff 00ff00 00ffff ffff00 ffffff',
  'MSX': '000000 3eb849 74d07d 5955e0 8076f1 b95e51 65dbef db6559 ff897d ccc35e ded087 3aa241 b766b5 cccccc ffffff',
  'Apple II': '000000 6c2940 403578 d93cf0 135740 808080 2697f0 bfb4f8 404b07 d9680f 808081 f9a8bf 2fb81f b9d060 6fe8bf ffffff',
  'NES': '545454 001e74 081090 300088 440064 5c0030 540400 3c1800 202a00 083a00 004000 003c00 00323c 989698 084cc4 3032ec 5c1ee4 8814b0 a01464 982220 783c00 545a00 287200 087c00 007628 006678 ececec 4c9aec 787cec b062ec e454ec ec58b4 ec6a64 d48820 a0aa00 74c400 4cd020 38cc6c 38b4cc 3c3c3c a8ccec bcbcec d4b2ec ecaeec ecaed4 ecb4b0 e4c490 ccd278 b4de78 a8e290 98e2b4 a0d6e4 a0a2a0 000000',
};

export const SYSTEM_PALETTES = [
  ...Object.entries(HEX).map(([name, hex]) => ({ name, colors: dedupe(parseHexColors(hex)) })),
  { name: 'EGA (64)', colors: egaColors() },
];

export function clonePalette(sys) {
  const p = createPalette({ name: sys.name, indexed: true, size: sys.colors.length });
  sys.colors.forEach((c, i) => setEntry(p, i, c));
  return p;
}
```

- [ ] **Step 4: Run tests, verify pass** — `npm test` → PASS. (If a system palette has an accidental duplicate hex, fix the data, not the test.)
- [ ] **Step 5: Commit** — `git commit -am "feat: palettes (indexed/free) + system palette presets"`

---

### Task 5: Project model (`js/core/model.js`)

**Files:**
- Create: `js/core/model.js`
- Test: `tests/model.test.mjs`

**Interfaces:**
- Consumes: `createBitmap`, `newId` (from palettes.js).
- Produces:
  - `PROJECT_VERSION = 1`
  - `createProject(name) -> {version, name, sheets: [], palettes: [], activePaletteId: null}`
  - `createSheet(project, {name, width, height, kind}) -> sheet` — kind `'sprite'|'tile'`; sheet = `{id, name, width, height, kind, layers: [], frames: [], animations: [], tile: kind==='tile' ? {tileWidth: 16, tileHeight: 16, names: {}, neighbors: {}} : null}`. Creates one layer named "Layer 1". Throws if width/height not in 1..4096.
  - `addLayer(sheet, name) -> {id, name, visible: true, opacity: 1, bitmap}` (bitmap sized to sheet)
  - `removeLayer(sheet, layerId)`, `moveLayer(sheet, layerId, toIndex)`, `mergeDown(sheet, layerId)` (composites layer onto the one below it with source-over + opacity, removes it; throws if bottom)
  - `addFrame(sheet, {name, x, y, w, h, pivotX=0, pivotY=0}) -> frame {id,...}`
  - `removeFrame(sheet, frameId)` (also removes its animation references)
  - `addAnimation(sheet, name) -> {id, name, loop: true, frames: []}` — anim frames are `{frameId, duration}` (ms)
  - `flattenSheet(sheet) -> Bitmap` — visible layers composited bottom-up with opacity (simple alpha-over).
  - `serializeProject(project) -> {json, images: [{path, bitmap}]}` — json is the `project.json` object with layers referencing `images/<sheetId>/<layerId>.png`; NO bitmap data in json.
  - `deserializeProject(json, imagesByPath /* Map<path, Bitmap> */) -> project`
  - `validateProjectJson(json) -> {ok: boolean, error: string|null}` — checks version === 1, `sheets` array, each layer has `image` path.
  - `tileCount(sheet) -> n`, `tileRect(sheet, index) -> {x,y,w,h}` (row-major grid over sheet size)

- [ ] **Step 1: Write failing tests**

`tests/model.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_VERSION, createProject, createSheet, addLayer, removeLayer,
  moveLayer, mergeDown, addFrame, removeFrame, addAnimation, flattenSheet,
  serializeProject, deserializeProject, validateProjectJson, tileCount, tileRect,
} from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';

function proj() {
  const p = createProject('demo');
  const s = createSheet(p, { name: 'sheet1', width: 32, height: 16, kind: 'sprite' });
  return { p, s };
}

test('createSheet defaults: one layer, bounds enforced', () => {
  const { p, s } = proj();
  assert.equal(s.layers.length, 1);
  assert.equal(s.layers[0].bitmap.width, 32);
  assert.throws(() => createSheet(p, { name: 'x', width: 0, height: 5, kind: 'sprite' }));
  assert.throws(() => createSheet(p, { name: 'x', width: 5000, height: 5, kind: 'sprite' }));
});

test('layer ops: add, move, mergeDown composites with opacity', () => {
  const { s } = proj();
  const top = addLayer(s, 'top');
  top.opacity = 0.5;
  setPixel(s.layers[0].bitmap, 0, 0, [0, 0, 0, 255]);
  setPixel(top.bitmap, 0, 0, [255, 255, 255, 255]);
  mergeDown(s, top.id);
  assert.equal(s.layers.length, 1);
  const px = getPixel(s.layers[0].bitmap, 0, 0);
  assert.ok(px[0] > 100 && px[0] < 155, `blended, got ${px}`);
  assert.throws(() => mergeDown(s, s.layers[0].id)); // bottom layer
  const l2 = addLayer(s, 'b'); moveLayer(s, l2.id, 0);
  assert.equal(s.layers[0].id, l2.id);
  removeLayer(s, l2.id);
  assert.equal(s.layers.length, 1);
});

test('frames and animations; removeFrame cleans references', () => {
  const { s } = proj();
  const f1 = addFrame(s, { name: 'walk0', x: 0, y: 0, w: 16, h: 16 });
  const f2 = addFrame(s, { name: 'walk1', x: 16, y: 0, w: 16, h: 16 });
  const a = addAnimation(s, 'walk');
  a.frames.push({ frameId: f1.id, duration: 100 }, { frameId: f2.id, duration: 150 });
  removeFrame(s, f1.id);
  assert.equal(s.frames.length, 1);
  assert.deepEqual(a.frames.map(x => x.frameId), [f2.id]);
});

test('flattenSheet composites visible layers only', () => {
  const { s } = proj();
  const top = addLayer(s, 'top');
  setPixel(s.layers[0].bitmap, 1, 1, [255, 0, 0, 255]);
  setPixel(top.bitmap, 1, 1, [0, 255, 0, 255]);
  top.visible = false;
  assert.deepEqual(getPixel(flattenSheet(s), 1, 1), [255, 0, 0, 255]);
  top.visible = true;
  assert.deepEqual(getPixel(flattenSheet(s), 1, 1), [0, 255, 0, 255]);
});

test('tile helpers', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'tiles', width: 64, height: 32, kind: 'tile' });
  s.tile.tileWidth = 16; s.tile.tileHeight = 16;
  assert.equal(tileCount(s), 8);
  assert.deepEqual(tileRect(s, 5), { x: 16, y: 16, w: 16, h: 16 });
});

test('serialize/deserialize round-trip preserves pixels and structure', () => {
  const { p, s } = proj();
  setPixel(s.layers[0].bitmap, 3, 2, [1, 2, 3, 255]);
  addFrame(s, { name: 'f', x: 0, y: 0, w: 8, h: 8 });
  const { json, images } = serializeProject(p);
  assert.equal(json.version, PROJECT_VERSION);
  assert.equal(images.length, 1);
  assert.match(images[0].path, /^images\/.+\/.+\.png$/);
  assert.equal(json.sheets[0].layers[0].image, images[0].path);
  const map = new Map(images.map(i => [i.path, i.bitmap]));
  const p2 = deserializeProject(structuredClone(json), map);
  assert.deepEqual(getPixel(p2.sheets[0].layers[0].bitmap, 3, 2), [1, 2, 3, 255]);
  assert.equal(p2.sheets[0].frames.length, 1);
});

test('validateProjectJson rejects bad input', () => {
  assert.equal(validateProjectJson({ version: 99 }).ok, false);
  assert.equal(validateProjectJson(null).ok, false);
  const { p } = proj();
  assert.equal(validateProjectJson(serializeProject(p).json).ok, true);
});
```

- [ ] **Step 2: Run tests, verify failure** — `npm test` → FAIL.

- [ ] **Step 3: Implement `js/core/model.js`**

```js
import { createBitmap, cloneBitmap, getPixel, setPixel } from './pixels.js';
import { newId } from './palettes.js';

export const PROJECT_VERSION = 1;
const MAX_DIM = 4096;

export function createProject(name) {
  return { version: PROJECT_VERSION, name, sheets: [], palettes: [], activePaletteId: null };
}

export function createSheet(project, { name, width, height, kind }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM)
    throw new Error(`sheet size must be 1..${MAX_DIM}`);
  const sheet = {
    id: newId('sh'), name, width, height, kind,
    layers: [], frames: [], animations: [],
    tile: kind === 'tile'
      ? { tileWidth: 16, tileHeight: 16, names: {}, neighbors: {} }
      : null,
  };
  project.sheets.push(sheet);
  addLayer(sheet, 'Layer 1');
  return sheet;
}

export function addLayer(sheet, name) {
  const layer = { id: newId('ly'), name, visible: true, opacity: 1,
    bitmap: createBitmap(sheet.width, sheet.height) };
  sheet.layers.push(layer);
  return layer;
}

export function removeLayer(sheet, layerId) {
  sheet.layers = sheet.layers.filter(l => l.id !== layerId);
}

export function moveLayer(sheet, layerId, toIndex) {
  const i = sheet.layers.findIndex(l => l.id === layerId);
  const [l] = sheet.layers.splice(i, 1);
  sheet.layers.splice(toIndex, 0, l);
}

function compositeOver(dst, src, opacity) {
  for (let y = 0; y < dst.height; y++)
    for (let x = 0; x < dst.width; x++) {
      const s = getPixel(src, x, y);
      const sa = (s[3] / 255) * opacity;
      if (sa === 0) continue;
      const d = getPixel(dst, x, y);
      const da = d[3] / 255;
      const oa = sa + da * (1 - sa);
      const mix = (sc, dc) => oa === 0 ? 0 : Math.round((sc * sa + dc * da * (1 - sa)) / oa);
      setPixel(dst, x, y, [mix(s[0], d[0]), mix(s[1], d[1]), mix(s[2], d[2]), Math.round(oa * 255)]);
    }
}

export function mergeDown(sheet, layerId) {
  const i = sheet.layers.findIndex(l => l.id === layerId);
  if (i <= 0) throw new Error('cannot merge bottom layer');
  compositeOver(sheet.layers[i - 1].bitmap, sheet.layers[i].bitmap, sheet.layers[i].opacity);
  sheet.layers.splice(i, 1);
}

export function flattenSheet(sheet) {
  const out = createBitmap(sheet.width, sheet.height);
  for (const l of sheet.layers) if (l.visible) compositeOver(out, l.bitmap, l.opacity);
  return out;
}

export function addFrame(sheet, { name, x, y, w, h, pivotX = 0, pivotY = 0 }) {
  const frame = { id: newId('fr'), name, x, y, w, h, pivotX, pivotY };
  sheet.frames.push(frame);
  return frame;
}

export function removeFrame(sheet, frameId) {
  sheet.frames = sheet.frames.filter(f => f.id !== frameId);
  for (const a of sheet.animations)
    a.frames = a.frames.filter(af => af.frameId !== frameId);
}

export function addAnimation(sheet, name) {
  const anim = { id: newId('an'), name, loop: true, frames: [] };
  sheet.animations.push(anim);
  return anim;
}

export function tileCount(sheet) {
  const cols = Math.floor(sheet.width / sheet.tile.tileWidth);
  const rows = Math.floor(sheet.height / sheet.tile.tileHeight);
  return cols * rows;
}

export function tileRect(sheet, index) {
  const cols = Math.floor(sheet.width / sheet.tile.tileWidth);
  return {
    x: (index % cols) * sheet.tile.tileWidth,
    y: Math.floor(index / cols) * sheet.tile.tileHeight,
    w: sheet.tile.tileWidth, h: sheet.tile.tileHeight,
  };
}

export function serializeProject(project) {
  const images = [];
  const json = {
    version: PROJECT_VERSION, name: project.name,
    activePaletteId: project.activePaletteId,
    palettes: project.palettes.map(p => ({ ...p, colors: p.colors.map(c => [...c]) })),
    sheets: project.sheets.map(s => ({
      id: s.id, name: s.name, width: s.width, height: s.height, kind: s.kind,
      tile: s.tile ? structuredClone(s.tile) : null,
      frames: s.frames.map(f => ({ ...f })),
      animations: s.animations.map(a => ({ ...a, frames: a.frames.map(x => ({ ...x })) })),
      layers: s.layers.map(l => {
        const path = `images/${s.id}/${l.id}.png`;
        images.push({ path, bitmap: cloneBitmap(l.bitmap) });
        return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, image: path };
      }),
    })),
  };
  return { json, images };
}

export function deserializeProject(json, imagesByPath) {
  const v = validateProjectJson(json);
  if (!v.ok) throw new Error(v.error);
  return {
    version: json.version, name: json.name,
    activePaletteId: json.activePaletteId ?? null,
    palettes: json.palettes ?? [],
    sheets: json.sheets.map(s => ({
      ...s,
      tile: s.tile ?? null,
      frames: s.frames ?? [], animations: s.animations ?? [],
      layers: s.layers.map(l => {
        const bitmap = imagesByPath.get(l.image);
        if (!bitmap) throw new Error(`missing image ${l.image}`);
        return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, bitmap };
      }),
    })),
  };
}

export function validateProjectJson(json) {
  if (!json || typeof json !== 'object') return { ok: false, error: 'not an object' };
  if (json.version !== PROJECT_VERSION)
    return { ok: false, error: `unsupported version ${json.version} (expected ${PROJECT_VERSION})` };
  if (!Array.isArray(json.sheets)) return { ok: false, error: 'missing sheets' };
  for (const s of json.sheets)
    for (const l of s.layers ?? [])
      if (typeof l.image !== 'string') return { ok: false, error: `layer ${l.id} missing image path` };
  return { ok: true, error: null };
}
```

- [ ] **Step 4: Run tests, verify pass** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: project model, layers, frames, animations, serialization"`

---

### Task 6: Grid slicing (`js/core/slicing.js`)

**Files:**
- Create: `js/core/slicing.js`
- Test: `tests/slicing.test.mjs`

**Interfaces:**
- Produces: `sliceGrid({sheetWidth, sheetHeight, cellW, cellH, marginX=0, marginY=0, spacingX=0, spacingY=0, namePrefix='frame'}) -> [{name, x, y, w, h}]` — row-major, only cells fully inside the sheet; names `frame_0, frame_1, …`.

- [ ] **Step 1: Write failing tests**

`tests/slicing.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceGrid } from '../js/core/slicing.js';

test('slices full grid row-major', () => {
  const r = sliceGrid({ sheetWidth: 32, sheetHeight: 16, cellW: 16, cellH: 16 });
  assert.deepEqual(r, [
    { name: 'frame_0', x: 0, y: 0, w: 16, h: 16 },
    { name: 'frame_1', x: 16, y: 0, w: 16, h: 16 },
  ]);
});

test('margin and spacing respected; partial cells dropped', () => {
  const r = sliceGrid({ sheetWidth: 40, sheetHeight: 20, cellW: 16, cellH: 16,
    marginX: 2, marginY: 2, spacingX: 4, spacingY: 4, namePrefix: 's' });
  assert.deepEqual(r, [
    { name: 's_0', x: 2, y: 2, w: 16, h: 16 },
    { name: 's_1', x: 22, y: 2, w: 16, h: 16 },
  ]);
});

test('rejects nonpositive cells', () => {
  assert.throws(() => sliceGrid({ sheetWidth: 8, sheetHeight: 8, cellW: 0, cellH: 8 }));
});
```

- [ ] **Step 2: Run tests, verify failure** — `npm test` → FAIL.

- [ ] **Step 3: Implement `js/core/slicing.js`**

```js
export function sliceGrid({ sheetWidth, sheetHeight, cellW, cellH,
  marginX = 0, marginY = 0, spacingX = 0, spacingY = 0, namePrefix = 'frame' }) {
  if (cellW < 1 || cellH < 1) throw new Error('cell size must be >= 1');
  const out = [];
  let i = 0;
  for (let y = marginY; y + cellH <= sheetHeight; y += cellH + spacingY)
    for (let x = marginX; x + cellW <= sheetWidth; x += cellW + spacingX)
      out.push({ name: `${namePrefix}_${i++}`, x, y, w: cellW, h: cellH });
  return out;
}
```

- [ ] **Step 4: Run tests, verify pass** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: grid slicing"`

---

### Task 7: Neighbor presets (`js/core/neighbors.js`)

**Files:**
- Create: `js/core/neighbors.js`
- Test: `tests/neighbors.test.mjs`

**Interfaces:**
- Consumes: sheet tile config `sheet.tile.neighbors` is `{ [tileIndex]: preset }`.
- Produces:
  - `NEIGHBOR_DIRS = ['nw','n','ne','w','e','sw','s','se']`
  - `defaultPreset() -> { nw: slot, n: slot, ... }` where slot = `{mode: 'same', tileIndex: null, flipH: false, flipV: false}`; modes: `'same' | 'tile' | 'empty'`.
  - `getPreset(sheet, tileIndex) -> preset` (stored or a fresh default; does NOT store).
  - `setSlot(sheet, tileIndex, dir, slot)` (stores a full preset on first write).
  - `resolveNeighborGrid(preset, centerIndex, radius=1) -> cells` — array of `{dx, dy, tileIndex|null, flipH, flipV}` for all cells in `[-radius..radius]²` except (0,0). For radius 2, outer cells reuse the slot of `(sign(dx), sign(dy))` with the same flips. `'same'` resolves to `centerIndex`; `'empty'` -> `tileIndex: null`.

- [ ] **Step 1: Write failing tests**

`tests/neighbors.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEIGHBOR_DIRS, defaultPreset, getPreset, setSlot, resolveNeighborGrid }
  from '../js/core/neighbors.js';

test('default preset: all 8 same, no flips', () => {
  const p = defaultPreset();
  assert.deepEqual(Object.keys(p).sort(), [...NEIGHBOR_DIRS].sort());
  for (const d of NEIGHBOR_DIRS)
    assert.deepEqual(p[d], { mode: 'same', tileIndex: null, flipH: false, flipV: false });
});

test('get/set preset on sheet', () => {
  const sheet = { tile: { neighbors: {} } };
  assert.deepEqual(getPreset(sheet, 3), defaultPreset());
  assert.deepEqual(sheet.tile.neighbors, {}); // get does not store
  setSlot(sheet, 3, 'e', { mode: 'tile', tileIndex: 7, flipH: true, flipV: false });
  assert.equal(getPreset(sheet, 3).e.tileIndex, 7);
  assert.equal(getPreset(sheet, 3).n.mode, 'same'); // rest defaulted
});

test('resolveNeighborGrid radius 1: 8 cells, same->center, empty->null', () => {
  const p = defaultPreset();
  p.n = { mode: 'empty', tileIndex: null, flipH: false, flipV: false };
  p.e = { mode: 'tile', tileIndex: 9, flipH: false, flipV: true };
  const cells = resolveNeighborGrid(p, 4, 1);
  assert.equal(cells.length, 8);
  const at = (dx, dy) => cells.find(c => c.dx === dx && c.dy === dy);
  assert.equal(at(0, -1).tileIndex, null);            // n empty
  assert.deepEqual(at(1, 0), { dx: 1, dy: 0, tileIndex: 9, flipH: false, flipV: true });
  assert.equal(at(-1, -1).tileIndex, 4);              // nw same -> center
});

test('resolveNeighborGrid radius 2: 24 cells, outer ring reuses direction slot', () => {
  const p = defaultPreset();
  p.e = { mode: 'tile', tileIndex: 9, flipH: true, flipV: false };
  const cells = resolveNeighborGrid(p, 4, 2);
  assert.equal(cells.length, 24);
  const at = (dx, dy) => cells.find(c => c.dx === dx && c.dy === dy);
  assert.equal(at(2, 0).tileIndex, 9);
  assert.equal(at(2, 0).flipH, true);
  assert.equal(at(2, 2).tileIndex, 4); // se is 'same'
});
```

- [ ] **Step 2: Run tests, verify failure** — `npm test` → FAIL.

- [ ] **Step 3: Implement `js/core/neighbors.js`**

```js
export const NEIGHBOR_DIRS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

const DIR_BY_DELTA = {
  '-1,-1': 'nw', '0,-1': 'n', '1,-1': 'ne',
  '-1,0': 'w', '1,0': 'e',
  '-1,1': 'sw', '0,1': 's', '1,1': 'se',
};

function emptySlot() { return { mode: 'same', tileIndex: null, flipH: false, flipV: false }; }

export function defaultPreset() {
  const p = {};
  for (const d of NEIGHBOR_DIRS) p[d] = emptySlot();
  return p;
}

export function getPreset(sheet, tileIndex) {
  const stored = sheet.tile.neighbors[tileIndex];
  const p = defaultPreset();
  if (stored) for (const d of NEIGHBOR_DIRS) if (stored[d]) p[d] = { ...stored[d] };
  return p;
}

export function setSlot(sheet, tileIndex, dir, slot) {
  if (!sheet.tile.neighbors[tileIndex])
    sheet.tile.neighbors[tileIndex] = defaultPreset();
  sheet.tile.neighbors[tileIndex][dir] = { ...slot };
}

export function resolveNeighborGrid(preset, centerIndex, radius = 1) {
  const cells = [];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const dir = DIR_BY_DELTA[`${Math.sign(dx)},${Math.sign(dy)}`];
      const slot = preset[dir];
      let tileIndex;
      if (slot.mode === 'empty') tileIndex = null;
      else if (slot.mode === 'tile') tileIndex = slot.tileIndex;
      else tileIndex = centerIndex;
      cells.push({ dx, dy, tileIndex, flipH: slot.flipH, flipV: slot.flipV });
    }
  return cells;
}
```

- [ ] **Step 4: Run tests, verify pass** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: tile neighbor presets + preview grid resolution"`

---

### Task 8: ZIP reader/writer (`js/core/zip.js`)

**Files:**
- Create: `js/core/zip.js`
- Test: `tests/zip.test.mjs`

**Interfaces:**
- Produces:
  - `async zipWrite(entries) -> Uint8Array` — entries `[{path: string, data: Uint8Array}]`; writes deflate (method 8) via `CompressionStream('deflate-raw')`, with correct CRC-32, local headers, central directory, EOCD. No zip64 (fine for < 4 GB).
  - `async zipRead(bytes) -> [{path, data: Uint8Array}]` — supports methods 0 (store) and 8 (deflate, via `DecompressionStream('deflate-raw')`); parses central directory from EOCD.
- Requires Node ≥ 18 (global CompressionStream) — Node 18+ assumed throughout.

- [ ] **Step 1: Write failing tests**

`tests/zip.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipWrite, zipRead } from '../js/core/zip.js';

const enc = new TextEncoder(), dec = new TextDecoder();

test('round-trip multiple entries', async () => {
  const entries = [
    { path: 'project.json', data: enc.encode('{"version":1}') },
    { path: 'images/a/b.png', data: new Uint8Array([1, 2, 3, 250, 251]) },
    { path: 'empty.txt', data: new Uint8Array(0) },
  ];
  const zipped = await zipWrite(entries);
  assert.equal(zipped[0], 0x50); assert.equal(zipped[1], 0x4b); // "PK"
  const out = await zipRead(zipped);
  assert.equal(out.length, 3);
  const byPath = new Map(out.map(e => [e.path, e.data]));
  assert.equal(dec.decode(byPath.get('project.json')), '{"version":1}');
  assert.deepEqual([...byPath.get('images/a/b.png')], [1, 2, 3, 250, 251]);
  assert.equal(byPath.get('empty.txt').length, 0);
});

test('compresses repetitive data', async () => {
  const big = new Uint8Array(100000); // zeros compress well
  const zipped = await zipWrite([{ path: 'big.bin', data: big }]);
  assert.ok(zipped.length < 5000, `expected small zip, got ${zipped.length}`);
  const out = await zipRead(zipped);
  assert.equal(out[0].data.length, 100000);
});

test('rejects garbage', async () => {
  await assert.rejects(() => zipRead(new Uint8Array([1, 2, 3, 4])));
});
```

- [ ] **Step 2: Run tests, verify failure** — `npm test` → FAIL.

- [ ] **Step 3: Implement `js/core/zip.js`**

```js
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(data, stream) {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const deflate = d => pipe(d, new CompressionStream('deflate-raw'));
const inflate = d => pipe(d, new DecompressionStream('deflate-raw'));

class ByteWriter {
  constructor() { this.chunks = []; this.length = 0; }
  bytes(u8) { this.chunks.push(u8); this.length += u8.length; }
  u16(v) { this.bytes(new Uint8Array([v & 255, (v >>> 8) & 255])); }
  u32(v) { this.bytes(new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255])); }
  concat() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

export async function zipWrite(entries) {
  const w = new ByteWriter();
  const central = [];
  for (const { path, data } of entries) {
    const name = new TextEncoder().encode(path);
    const crc = crc32(data);
    const comp = await deflate(data);
    const offset = w.length;
    w.u32(0x04034b50); w.u16(20); w.u16(0); w.u16(8); w.u16(0); w.u16(0);
    w.u32(crc); w.u32(comp.length); w.u32(data.length);
    w.u16(name.length); w.u16(0);
    w.bytes(name); w.bytes(comp);
    central.push({ name, crc, compSize: comp.length, size: data.length, offset });
  }
  const cdStart = w.length;
  for (const e of central) {
    w.u32(0x02014b50); w.u16(20); w.u16(20); w.u16(0); w.u16(8); w.u16(0); w.u16(0);
    w.u32(e.crc); w.u32(e.compSize); w.u32(e.size);
    w.u16(e.name.length); w.u16(0); w.u16(0); w.u16(0); w.u16(0); w.u32(0); w.u32(e.offset);
    w.bytes(e.name);
  }
  const cdSize = w.length - cdStart;
  w.u32(0x06054b50); w.u16(0); w.u16(0);
  w.u16(central.length); w.u16(central.length);
  w.u32(cdSize); w.u32(cdStart); w.u16(0);
  return w.concat();
}

export async function zipRead(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // find EOCD (scan back over optional comment)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--)
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file (no end record)');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // local header: skip its own name/extra lengths
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = new Uint8Array(comp);
    else if (method === 8) data = await inflate(comp);
    else throw new Error(`unsupported compression method ${method}`);
    out.push({ path, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
```

- [ ] **Step 4: Run tests, verify pass** — `npm test` → PASS.
- [ ] **Step 5: Extra verification: external tool reads our zip**

```powershell
node -e "import('./js/core/zip.js').then(async z => { const b = await z.zipWrite([{path:'a.txt', data: new TextEncoder().encode('hello')}]); require('fs').writeFileSync('scratch.zip', b); })" ; Expand-Archive scratch.zip scratch_out ; Get-Content scratch_out/a.txt ; Remove-Item -Recurse -Force scratch.zip, scratch_out
```
(Adapt to an ESM one-liner file if `require` is unavailable: write `tmp-zipcheck.mjs` with the same content using `fs` import, run `node tmp-zipcheck.mjs`, delete it after.) Expected: `hello`.

- [ ] **Step 6: Commit** — `git commit -am "feat: dependency-free zip read/write via CompressionStream"`

---

### Task 9: Bundle assembly (`js/core/bundle.js`)

**Files:**
- Create: `js/core/bundle.js`
- Test: `tests/bundle.test.mjs`

**Interfaces:**
- Consumes: `serializeProject`, `deserializeProject`, `validateProjectJson` (model.js); `zipWrite`, `zipRead` (zip.js).
- Produces:
  - `async buildEntries(project, encodePng) -> [{path, data: Uint8Array}]` — `project.json` (pretty JSON) + one entry per layer image; `encodePng(bitmap) -> Promise<Uint8Array>`.
  - `async loadEntries(entries, decodePng) -> project` — `decodePng(Uint8Array) -> Promise<Bitmap>`; throws with clear message on validation failure.
  - `async packProject(project, encodePng) -> Uint8Array` (zip of entries)
  - `async unpackProject(bytes, decodePng) -> project`
- Note: PNG codec is injected so this module stays Node-testable; tests use a fake codec that serializes Bitmap `{width,height,data}` as JSON bytes.

- [ ] **Step 1: Write failing tests**

`tests/bundle.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntries, loadEntries, packProject, unpackProject } from '../js/core/bundle.js';
import { createProject, createSheet } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const fakeEncode = async bmp =>
  enc.encode(JSON.stringify({ width: bmp.width, height: bmp.height, data: [...bmp.data] }));
const fakeDecode = async bytes => {
  const o = JSON.parse(dec.decode(bytes));
  return { width: o.width, height: o.height, data: new Uint8ClampedArray(o.data) };
};

function demoProject() {
  const p = createProject('demo');
  const s = createSheet(p, { name: 's', width: 8, height: 8, kind: 'sprite' });
  setPixel(s.layers[0].bitmap, 1, 1, [7, 8, 9, 255]);
  return p;
}

test('buildEntries produces project.json + one png per layer', async () => {
  const entries = await buildEntries(demoProject(), fakeEncode);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, 'project.json');
  const json = JSON.parse(dec.decode(entries[0].data));
  assert.equal(json.version, 1);
  assert.match(entries[1].path, /^images\/.+\.png$/);
});

test('entries round-trip preserves pixels', async () => {
  const entries = await buildEntries(demoProject(), fakeEncode);
  const p2 = await loadEntries(entries, fakeDecode);
  assert.deepEqual(getPixel(p2.sheets[0].layers[0].bitmap, 1, 1), [7, 8, 9, 255]);
});

test('packed round-trip via zip', async () => {
  const bytes = await packProject(demoProject(), fakeEncode);
  const p2 = await unpackProject(bytes, fakeDecode);
  assert.equal(p2.name, 'demo');
  assert.deepEqual(getPixel(p2.sheets[0].layers[0].bitmap, 1, 1), [7, 8, 9, 255]);
});

test('loadEntries rejects bad version with clear error', async () => {
  const entries = [{ path: 'project.json', data: enc.encode('{"version": 42, "sheets": []}') }];
  await assert.rejects(() => loadEntries(entries, fakeDecode), /version/);
});

test('loadEntries rejects missing project.json', async () => {
  await assert.rejects(() => loadEntries([], fakeDecode), /project\.json/);
});
```

- [ ] **Step 2: Run tests, verify failure** — `npm test` → FAIL.

- [ ] **Step 3: Implement `js/core/bundle.js`**

```js
import { serializeProject, deserializeProject, validateProjectJson } from './model.js';
import { zipWrite, zipRead } from './zip.js';

export async function buildEntries(project, encodePng) {
  const { json, images } = serializeProject(project);
  const entries = [{
    path: 'project.json',
    data: new TextEncoder().encode(JSON.stringify(json, null, 2)),
  }];
  for (const img of images)
    entries.push({ path: img.path, data: await encodePng(img.bitmap) });
  return entries;
}

export async function loadEntries(entries, decodePng) {
  const meta = entries.find(e => e.path === 'project.json');
  if (!meta) throw new Error('bundle has no project.json');
  let json;
  try { json = JSON.parse(new TextDecoder().decode(meta.data)); }
  catch { throw new Error('project.json is not valid JSON'); }
  const v = validateProjectJson(json);
  if (!v.ok) throw new Error(`invalid project: ${v.error}`);
  const imagesByPath = new Map();
  for (const e of entries)
    if (e.path !== 'project.json') imagesByPath.set(e.path, await decodePng(e.data));
  return deserializeProject(json, imagesByPath);
}

export const packProject = async (project, encodePng) =>
  zipWrite(await buildEntries(project, encodePng));

export const unpackProject = async (bytes, decodePng) =>
  loadEntries(await zipRead(bytes), decodePng);
```

- [ ] **Step 4: Run tests, verify pass** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: project bundle assembly (entries + packed zip)"`

---

### Task 10: Browser I/O (`js/app/pngcodec.js`, `js/app/io.js`)

**Files:**
- Create: `js/app/pngcodec.js`, `js/app/io.js`

**Interfaces:**
- Consumes: `buildEntries`, `loadEntries`, `packProject`, `unpackProject` (bundle.js).
- Produces (io.js):
  - `async encodePng(bitmap) -> Uint8Array`, `async decodePng(bytes) -> Bitmap` (pngcodec.js)
  - `supportsFS() -> boolean` (`'showOpenFilePicker' in window`)
  - `async openPacked() -> {project, handle|null}` — FS picker for `.pixelproj`, else `<input type=file>` fallback.
  - `async savePacked(project, handle|null) -> handle` — FS save picker or download fallback (anchor + Blob).
  - `async openUnpacked() -> {project, dirHandle}` / `async saveUnpacked(project, dirHandle|null) -> dirHandle` — `showDirectoryPicker`, write `project.json` + `images/**` files, read them back on open. Only offered when `supportsFS()`.
  - `async autosave(project)` / `async loadAutosave() -> project|null` / `async clearAutosave()` — IndexedDB db `pixelartist`, store `autosave`, key `latest`, value = packed bytes.
  - `async exportPngBlob(bitmap) -> Blob`, `downloadBlob(blob, filename)`

- [ ] **Step 1: Implement `js/app/pngcodec.js`**

```js
export async function encodePng(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(bitmap.data, bitmap.width, bitmap.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function decodePng(bytes) {
  const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height);
  return { width: d.width, height: d.height, data: d.data };
}
```

- [ ] **Step 2: Implement `js/app/io.js`**

```js
import { buildEntries, loadEntries, packProject, unpackProject } from '../core/bundle.js';
import { encodePng, decodePng } from './pngcodec.js';

export const PACKED_TYPE = {
  description: 'PixelArtist project',
  accept: { 'application/zip': ['.pixelproj'] },
};

export function supportsFS() { return 'showOpenFilePicker' in window; }

export async function savePacked(project, handle = null) {
  const bytes = await packProject(project, encodePng);
  if (supportsFS()) {
    if (!handle)
      handle = await window.showSaveFilePicker({
        suggestedName: `${project.name}.pixelproj`, types: [PACKED_TYPE] });
    const w = await handle.createWritable();
    await w.write(bytes); await w.close();
    return handle;
  }
  downloadBlob(new Blob([bytes]), `${project.name}.pixelproj`);
  return null;
}

export async function openPacked() {
  if (supportsFS()) {
    const [handle] = await window.showOpenFilePicker({ types: [PACKED_TYPE] });
    const file = await handle.getFile();
    const project = await unpackProject(new Uint8Array(await file.arrayBuffer()), decodePng);
    return { project, handle };
  }
  const file = await pickFileFallback('.pixelproj');
  const project = await unpackProject(new Uint8Array(await file.arrayBuffer()), decodePng);
  return { project, handle: null };
}

function pickFileFallback(accept) {
  return new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement('input'),
      { type: 'file', accept });
    input.onchange = () => input.files[0] ? resolve(input.files[0]) : reject(new Error('cancelled'));
    input.click();
  });
}

export async function saveUnpacked(project, dirHandle = null) {
  if (!dirHandle) dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const entries = await buildEntries(project, encodePng);
  for (const { path, data } of entries) {
    const parts = path.split('/');
    let dir = dirHandle;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(parts.at(-1), { create: true });
    const w = await fh.createWritable();
    await w.write(data); await w.close();
  }
  return dirHandle;
}

export async function openUnpacked() {
  const dirHandle = await window.showDirectoryPicker();
  const entries = [];
  async function walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'file') {
        const f = await h.getFile();
        entries.push({ path: prefix + name, data: new Uint8Array(await f.arrayBuffer()) });
      } else await walk(h, `${prefix}${name}/`);
    }
  }
  await walk(dirHandle, '');
  const project = await loadEntries(entries, decodePng);
  return { project, dirHandle };
}

// ---- autosave (IndexedDB) ----
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pixelartist', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('autosave');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbOp(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('autosave', mode);
      const req = fn(tx.objectStore('autosave'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

export async function autosave(project) {
  const bytes = await packProject(project, encodePng);
  await idbOp('readwrite', store => store.put(bytes, 'latest'));
}
export async function loadAutosave() {
  const bytes = await idbOp('readonly', store => store.get('latest'));
  return bytes ? unpackProject(bytes, decodePng) : null;
}
export const clearAutosave = () => idbOp('readwrite', store => store.delete('latest'));

export async function exportPngBlob(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').putImageData(new ImageData(bitmap.data, bitmap.width, bitmap.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

export function downloadBlob(blob, filename) {
  const a = Object.assign(document.createElement('a'),
    { href: URL.createObjectURL(blob), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}
```

- [ ] **Step 3: Verify in browser** — temporary snippet in DevTools console at http://localhost:8080:

```js
const io = await import('./js/app/io.js');
const m = await import('./js/core/model.js');
const p = m.createProject('iotest'); m.createSheet(p, {name:'s', width:8, height:8, kind:'sprite'});
await io.autosave(p);
const back = await io.loadAutosave();
console.log('autosave roundtrip:', back.name === 'iotest' && back.sheets.length === 1);
await io.clearAutosave();
```
Expected: `autosave roundtrip: true`. Also `npm test` still passes.

- [ ] **Step 4: Commit** — `git commit -am "feat: browser io (png codec, fs access, fallback, autosave)"`

---

### Task 11: App state + shell wiring (`js/app/state.js`, `js/app/main.js`)

**Files:**
- Create: `js/app/state.js`
- Modify: `js/app/main.js` (replace placeholder)

**Interfaces:**
- Produces (`state.js`) — the single mutable app store all UI modules import:

```js
import { CommandStack } from '../core/commands.js';
import { createProject, createSheet } from '../core/model.js';

export const state = {
  project: null,
  fileHandle: null, dirHandle: null, saveMode: null, // 'packed'|'unpacked'|null
  dirty: false,
  mode: 'sprites',            // 'sprites' | 'tiles'
  view: 'sheet',              // 'sheet' | 'frame' | 'tile'  (focused editors)
  activeSheetId: null,        // per current mode
  activeLayerId: null,
  tool: 'pencil',
  brushSize: 1,
  primary: [0, 0, 0, 255], secondary: [255, 255, 255, 255],
  selectedFrameId: null, selectedAnimationId: null,
  editingFrameId: null,       // frame editor target
  editingTileIndex: null,     // tile editor target
  onion: { enabled: false, back: 1, ahead: 1 },
  overlays: { labels: true, sequences: true },
  commands: new CommandStack(),
};

const listeners = new Map(); // event -> Set<fn>
export function on(event, fn) { /* subscribe */ }
export function emit(event, payload) { /* notify; '*' listeners always called */ }
// events used app-wide: 'project', 'sheet', 'selection', 'tool', 'view', 'history'
export function activeSheet() { /* project sheet by activeSheetId, filtered to mode kind */ }
export function activeLayer() { /* layer by activeLayerId within activeSheet */ }
export function markDirty() { state.dirty = true; emit('project'); }
export function setProject(project) { /* set, pick first sheet of each kind, reset stacks, emit */ }
export function newDemoProject() { /* createProject('untitled') + one 128x128 sprite sheet + one 128x128 tile sheet, returns it */ }
```

- Produces (`main.js`): boots app: `setProject(newDemoProject())` (or autosave restore prompt via `confirm()` if `loadAutosave()` returns one), binds mode tabs (switch `state.mode`, emit `'view'`), undo/redo buttons + Ctrl+Z/Ctrl+Y/Ctrl+Shift+Z, file buttons calling io.js (Save = re-save to known handle/mode; Save As = `confirm`-style choice dialog `<dialog id="dlg-saveas">` with "Packed file" / "Unpacked folder" buttons, folder option hidden when `!supportsFS()`), Export button (`<dialog id="dlg-export">` with "Sheet PNG (flattened)" / "Frames JSON" / "Tiles JSON" — see Task 19 for JSON shapes; PNG works now via `flattenSheet` + `exportPngBlob` + `downloadBlob`), `beforeunload` guard when `state.dirty`, autosave every 30 s when dirty (`setInterval`), status-bar tool/zoom/pos updates on events, overlay checkboxes writing `state.overlays` and emitting `'view'`.

- [ ] **Step 1: Implement `state.js` exactly per interface above** (fill in the commented bodies: `on` adds to a Set; `emit` calls the event's set plus the `'*'` set; `activeSheet()` returns `state.project?.sheets.find(s => s.id === state.activeSheetId) ?? null`; `setProject` sets `activeSheetId` to first sheet whose kind matches `state.mode==='sprites'?'sprite':'tile'`, sets `activeLayerId` to its first layer, clears `commands`, sets `dirty=false`, emits `'project'` and `'view'`).

- [ ] **Step 2: Implement `main.js` per interface above.** Undo/redo buttons enable/disable from `state.commands.onChange`. Mode tab switch also updates `activeSheetId`/`activeLayerId` to first sheet of the new kind and sets `state.view='sheet'`.

- [ ] **Step 3: Verify in browser** — load app: tabs toggle `.active` class; undo/redo disabled; New creates fresh demo project after a `confirm()` if dirty; no console errors. `npm test` still green.

- [ ] **Step 4: Commit** — `git commit -am "feat: app state store and shell wiring"`

---

### Task 12: Canvas view (`js/ui/canvasview.js`)

**Files:**
- Create: `js/ui/canvasview.js`
- Modify: `js/app/main.js` (instantiate for `#canvas-host`)

**Interfaces:**
- Produces: `class CanvasView` — reusable zoom/pan canvas host also used by frame editor and tile editor.

```js
export class CanvasView {
  constructor(hostEl) // creates <canvas>, ResizeObserver, pointer + wheel handlers
  // public state: zoom (px per image pixel, 1..64), panX, panY (screen px of image origin)
  setContent({ width, height })       // logical image size; also centers + fits on first set
  screenToImage(sx, sy) -> {x, y}     // floor to integer pixel; may be out of bounds
  imageToScreen(x, y) -> {x, y}
  centerFit()                          // zoom to fit content with 24px margin, integer zoom >= 1
  // callbacks assigned by owner:
  onPaint = (ctx2d) => {}             // owner draws content in IMAGE space (ctx pre-transformed)
  onOverlay = (ctx2d) => {}           // owner draws overlays in SCREEN space (identity transform)
  onPointer = (ev) => {}              // {type:'down'|'move'|'up', x, y, sx, sy, buttons, shiftKey}
  requestRender()                      // schedules rAF render
}
```

Render pass: clear; `ctx.setTransform(zoom, 0, 0, zoom, panX, panY)`; `imageSmoothingEnabled = false`; call `onPaint(ctx)`; reset transform; draw pixel grid lines when `zoom >= 8` (0.5px lines, `rgba(128,128,128,.25)`, aligned to image pixels, only over content area); checkerboard background under content (8px screen-space squares, two grays) drawn before `onPaint`; call `onOverlay(ctx)`.

Interaction: wheel zooms ×2^(±0.25) steps (clamped 1..64, rounded to nearest of 1,2,3,4,6,8,12,16,24,32,48,64), keeping the image point under the cursor stationary: `panX = sx - imgX * newZoom`. Space held or middle button = pan drag. Otherwise pointer events are forwarded to `onPointer` with image coords. Pointer capture on down. Status bar: on move, write `#status-pos` = `x,y` (blank when out of bounds) and `#status-zoom` = `${zoom}x`.

- [ ] **Step 1: Implement `canvasview.js` per contract.** Canvas sized to host via ResizeObserver × `devicePixelRatio`.

- [ ] **Step 2: Wire into `main.js` for smoke test**: create `CanvasView` on `#canvas-host`; `onPaint` draws the active sheet's flattened bitmap via a scratch `OffscreenCanvas` (putImageData then drawImage — cache the scratch canvas, invalidate on `'project'` events); re-render on `'project'`/`'view'` events; `setContent` on sheet change.

- [ ] **Step 3: Verify in browser** — demo sheet appears centered on checkerboard; wheel zooms about cursor; space-drag and middle-drag pan; grid appears at zoom ≥ 8; status bar shows position/zoom. No console errors.

- [ ] **Step 4: Commit** — `git commit -am "feat: zoom/pan canvas view with grid and checkerboard"`

---

### Task 13: Drawing tools + color/layers panels (`js/ui/tools.js`, `js/ui/panels.js`)

**Files:**
- Create: `js/ui/tools.js`, `js/ui/panels.js`
- Modify: `js/app/main.js` (mount)

**Interfaces:**
- Consumes: `CanvasView.onPointer`, state store, `pixels.js`, `makePixelPatch`, palettes.
- Produces (`tools.js`):
  - `TOOLS = [{id:'pencil',icon:'✏️',key:'b'},{id:'eraser',icon:'🧽',key:'e'},{id:'fill',icon:'🪣',key:'g'},{id:'line',icon:'📏',key:'l'},{id:'rect',icon:'▭',key:'u'},{id:'ellipse',icon:'◯',key:'o'},{id:'eyedropper',icon:'💉',key:'i'},{id:'select',icon:'⛶',key:'m'}]`
  - `mountToolPalette(el)` — buttons into `#tool-palette`, sets `state.tool`, `.active` class, keyboard shortcuts; plus brush-size `<input type=number min=1 max=8>`; fill tool gets a "contiguous" checkbox; rect/ellipse get a "filled" checkbox.
  - `bindDrawing(view, getTargetRect)` — attaches to a `CanvasView`. `getTargetRect()` returns the editable image-space rect (whole sheet in sheet view; the frame/tile rect in focused editors — drawing outside it is clipped by pre-masking coords). Handles the full stroke lifecycle.
- Produces (`panels.js`): `mountColorPanel(el)`, `mountLayersPanel(el)`.

**Stroke lifecycle (the important algorithm):**
```
pointerdown (pencil/eraser/line/rect/ellipse/fill):
  layer = activeLayer(); strokeBefore = cloneBitmap(layer.bitmap)
  color = ev.buttons & 2 ? state.secondary : state.primary (eraser: [0,0,0,0])
  if indexed active palette: color = nearestColor(activePalette, color)
  pencil/eraser: drawLine(bitmap, x,y,x,y,color,brushSize); track dirty rect
  fill: floodFill(...); finalize immediately
pointermove (buttons down):
  pencil/eraser: drawLine from last pos (continuity); extend dirty rect
  line/rect/ellipse: restore strokeBefore into bitmap, then draw shape
    from anchor to current (preview directly in bitmap); dirty = union
pointerup:
  finalize: rect = clamp(dirty ∪ brush margins, targetRect)
  before = copyRegion(strokeBefore, rect...), after = copyRegion(bitmap, rect...)
  bitmap: blit before back, then commands.push(makePixelPatch(bitmap, rect, before, after, tool))
  (push re-applies after; single undo step per stroke) ; markDirty()
eyedropper: on down, read flattenSheet(sheet) pixel -> primary (or secondary w/ right button)
select: down=anchor marquee; move=update rect overlay; up=store selection rect in module state.
  Drag starting INSIDE existing selection = move mode: copyRegion at anchor, fillRegion clear,
  blit at offset live (restore strokeBefore each move like shapes); finalize as one patch.
  Escape or click outside clears selection. Selection rect drawn in onOverlay (marching ants:
  dashed 1px white/black double stroke).
```

**Panels:**
- Color panel: two swatch buttons (primary/secondary, click to open `<input type=color>` + alpha `<input type=range 0..255>`); palette strip: swatches from `state.project.palettes` active palette (click = set primary; right-click = set secondary); `+` adds current primary as swatch (non-indexed only); select `<select>` to switch active palette; "New palette…" opens `<dialog>`: name, indexed checkbox, size preset select (from `INDEXED_SIZE_PRESETS`) or custom number; "System…" opens `<dialog>` listing `SYSTEM_PALETTES` names with a Clone button each (adds via `clonePalette`). Indexed palette entry edit: double-click swatch → color input; on change, `confirm('Remap N pixels of old color on active sheet?')` — if yes, `remapColor` on every layer of active sheet wrapped in one command (before/after clones per layer via makePixelPatch on full sheet rect).
- Layers panel: list rows (drag handle ↑↓ buttons for reorder via `moveLayer`, name double-click rename, 👁 visibility toggle, opacity range 0..100). Buttons: Add, Delete (confirm if >1 layer, refuse deleting last layer), Merge Down. Every structural change is a command (`{label, do, undo}` capturing the layers array before/after — store `sheet.layers.slice()` copies plus for mergeDown a `cloneBitmap` of the destination). Active row highlighted; click row sets `state.activeLayerId`.

- [ ] **Step 1: Implement `tools.js`** per lifecycle above; export `mountToolPalette`, `bindDrawing`.
- [ ] **Step 2: Implement `panels.js`**; mount both in `main.js` (`mountColorPanel(document.querySelector('#panel-colors'))` etc.), `bindDrawing(view, () => ({x:0, y:0, w: sheet.width, h: sheet.height}))` for sheet view.
- [ ] **Step 3: Verify in browser** — draw with pencil at multiple zooms (no gaps when moving fast); right-click draws secondary; shapes preview while dragging; fill fills; undo/redo restores exact pixels stroke-by-stroke; eraser clears to transparent (checkerboard shows); select-move a region; layers: add second layer, draw, toggle visibility, reorder, merge down, undo each; indexed palette (clone Game Boy) restricts drawn colors to the 4 GB greens; remap flow recolors. `npm test` green.
- [ ] **Step 4: Commit** — `git commit -am "feat: drawing tools, color/palette panel, layers panel"`

---

### Task 14: Frames + overlays (`js/ui/frames.js`, `js/ui/overlays.js`)

**Files:**
- Create: `js/ui/frames.js`, `js/ui/overlays.js`
- Modify: `js/app/main.js` (mount frame tool button, context panel, overlay hook)

**Interfaces:**
- Consumes: state, model (`addFrame`, `removeFrame`, `sliceGrid`), `copyRegion`/`fillRegion`/`blitRegion`, CanvasView overlay callback.
- Produces (`frames.js`):
  - Adds a 9th tool `{id:'frametool', icon:'🖼', key:'f'}` (sprite mode only) — registered by calling `registerFrameTool()` from main.js after `mountToolPalette`.
  - `mountFramesPanel(el)` — into `#panel-context` when `state.mode==='sprites'`: list of frames (name editable, x/y/w/h/pivot number inputs, Delete button, "Edit" button → sets `state.editingFrameId`, `state.view='frame'`, emits `'view'`), "Slice grid…" button → `<dialog>` (cellW/cellH/margin/spacing/prefix + "replace existing frames" checkbox) creating frames via `sliceGrid` as one command.
  - Frame tool pointer behavior on sheet view:
    - drag on empty area → ghost rect → on up: `addFrame` (name `frame_N`) as command; snap all coords to grid when snap checkbox (in tool options row) is on (grid size = value of a number input, default 8).
    - drag inside an existing frame → **pixel-carrying move**: on up, one command that for EVERY layer does `copy = copyRegion(layer.bitmap, f.x, f.y, f.w, f.h); fillRegion(layer.bitmap, f.x, f.y, f.w, f.h, [0,0,0,0]); blitRegion(layer.bitmap, copy, nx, ny)` and updates `f.x=nx, f.y=ny`; undo restores per-layer before-clones (capture `cloneBitmap` of union rect region before/after per layer and frame coords). During drag show ghost outline at offset.
    - drag on a corner handle (6px screen-space hit zone at frame corners) → resize rect (metadata only; min 1×1).
    - click selects frame (`state.selectedFrameId`), Delete key removes (command).
- Produces (`overlays.js`): `drawSheetOverlays(view, ctx)` — called from CanvasView `onOverlay`:
  - sprite mode, `state.overlays.labels`: per frame, `imageToScreen` rect → 1px `#4f8cff` stroke (selected: 2px + fill `rgba(79,140,255,.15)`), label chip top-left: `${index}:${name}` — 11px sans, dark pill background, clamped inside viewport.
  - `state.overlays.sequences`: for each animation, frames used get an extra badge under the label: `${anim.name} ${pos+1}/${len}` (one badge per animation membership).
  - tile mode, `state.overlays.labels`: grid lines per tileRect + index chip per tile (+ name from `sheet.tile.names[index]` if set). (Task 17 flips mode; implement now, it only needs `state.mode`.)

- [ ] **Step 1: Implement `overlays.js`**, hook into the CanvasView `onOverlay` in main.js.
- [ ] **Step 2: Implement `frames.js`** (tool + panel + slice dialog + pixel-carrying move as specified).
- [ ] **Step 3: Verify in browser** — create frames by dragging; labels + indices render and track zoom/pan; resize via handles; move a frame and confirm pixels travel with it across all layers and undo restores both pixels and coords; slice-grid on a 128×128 sheet with 16×16 cells creates 64 named frames (one undo removes all); delete frame works. `npm test` green.
- [ ] **Step 4: Commit** — `git commit -am "feat: frame tool, frames panel, slice dialog, label overlays"`

---

### Task 15: Animation timeline + player (`js/ui/timeline.js`)

**Files:**
- Create: `js/ui/timeline.js`
- Modify: `js/app/main.js`, `index.html` + `css/app.css` (add `<div id="timeline-dock"></div>` between `#workspace` and `#status-bar`; grid-row added; dock ~110px tall, hidden in tile mode)

**Interfaces:**
- Consumes: state, model animations, `copyRegion`, flattenSheet.
- Produces: `mountTimeline(el)`:
  - Header row: animation `<select>` + New/Rename/Delete/Loop-checkbox + "Add selected frame" button (appends `{frameId: state.selectedFrameId, duration: 100}`) + playback controls: ⏮ ▶/⏸ ⏭, speed select (0.25/0.5/1/2), and a live preview `<canvas width=96 height=96>` (nearest-neighbor, frame scaled to fit, drawn from flattened sheet via `copyRegion`).
  - Strip: one cell per animation frame — 64px thumbnail canvas + duration `<input type=number min=1>` (ms) + ✕ remove; drag-to-reorder via HTML5 drag events (`draggable`, dragover computes insert index); double-click a cell opens the frame editor for that frame (`state.editingFrameId`, `state.view='frame'`).
  - Playhead: highlighted cell border; scrubbing = click cell selects position (player paused).
  - Player: `requestAnimationFrame` loop accumulating `dt * speed`; advances when acc ≥ current frame duration; at end: loop ? wrap : stop. Renders into preview canvas AND emits `'playhead'` event with `{animId, position}` (frame editor uses it later — just emit).
  - All structural edits (add/remove/reorder frame entry, duration change on blur, new/delete/rename animation) are commands (capture `a.frames.slice()` before/after; duration: old/new value).

- [ ] **Step 1: Add dock element + CSS** (horizontal flex strip, `overflow-x: auto`).
- [ ] **Step 2: Implement `timeline.js` per contract; mount in main.js; hide dock unless `state.mode==='sprites'`.**
- [ ] **Step 3: Verify in browser** — build a 4-frame walk animation from sliced frames; thumbnails correct; reorder by drag (undoable); durations edit; play loops at correct speed (100ms frames ≈ 10 fps); speed 2 doubles rate; non-loop stops at end; sequence badges (Task 14) update as frames are added. `npm test` green.
- [ ] **Step 4: Commit** — `git commit -am "feat: animation timeline with thumbnails, reorder, preview player"`

---

### Task 16: Frame editor + onion skin (`js/ui/frameeditor.js`)

**Files:**
- Create: `js/ui/frameeditor.js`
- Modify: `js/app/main.js` (view switching)

**Interfaces:**
- Consumes: CanvasView (a second instance owned by this module in `#canvas-host`), `bindDrawing(view, getTargetRect)` from tools.js, state (`editingFrameId`, `onion`), timeline `'playhead'` event.
- Produces: `mountFrameEditor(hostEl)` returning `{show(), hide()}`; main.js swaps sheet view / frame editor / tile editor on `'view'` events (only one visible; each owns its CanvasView; hidden ones `display:none`).

Behavior:
- `show()`: reads frame `f`; `setContent({width: f.w, height: f.h})`; `centerFit()`. Drawing binds with `getTargetRect() -> {x: f.x, y: f.y, w: f.w, h: f.h}` — the SAME sheet layer bitmaps are edited; `onPaint` translates: `ctx.translate(-f.x, -f.y)` then draws each visible layer bitmap (via cached scratch canvases) clipped to `f`; edits in the frame editor are therefore instantly visible back in sheet view. All tools/undo work unchanged.
- Top strip inside the editor (DOM row injected above canvas): frame name label, prev/next frame buttons (within selected animation order if the frame belongs to one, else sheet frame order), onion controls: enable checkbox, back `<input type=number min=0 max=8 value=1>`, ahead (same), and a legend (red=past, green=future).
- **Onion skin render** (in `onPaint`, after the frame's own pixels, only when `state.onion.enabled` and frame is in the selected animation):

```js
// position = index of editingFrame in anim.frames
for (let k = 1; k <= state.onion.back; k++) {
  const idx = pos - k; if (idx < 0 && !anim.loop) break;
  const g = anim.frames[(idx + anim.frames.length) % anim.frames.length];
  drawGhost(ctx, frameById(g.frameId), 'rgba(255,64,64,1)', 0.35 / k);
}
for (let k = 1; k <= state.onion.ahead; k++) { /* same with pos + k, green */ }

function drawGhost(ctx, gf, tintCss, alpha) {
  // scratch canvas gf.w x gf.h: draw flattened frame pixels, then tint:
  // sctx.globalCompositeOperation = 'source-atop'; sctx.fillStyle = tintCss;
  // sctx.globalAlpha = .6; sctx.fillRect(0,0,w,h);
  // then main ctx.globalAlpha = alpha; aligned pivot-aware:
  // dx = (f.pivotX - gf.pivotX), dy = (f.pivotY - gf.pivotY)
  // ctx.drawImage(scratch, -dx, -dy) in frame-local space; restore alpha.
}
```
- Escape or a "Back to sheet" button returns to sheet view (`state.view='sheet'`, emit).

- [ ] **Step 1: Implement per contract; wire view switching in main.js.**
- [ ] **Step 2: Verify in browser** — double-click frame on timeline opens editor; draw → visible in sheet view after Back; onion: with a 3-frame animation, middle frame shows red ghost (prev) and green ghost (next); back/ahead counts add deeper, fainter ghosts; ghosts never saved into pixels (export/flatten unaffected — verify by toggling onion off); prev/next buttons walk the animation; pivot offset shifts ghost alignment. Undo works across editor/sheet transitions. `npm test` green.
- [ ] **Step 3: Commit** — `git commit -am "feat: frame editor with configurable onion skinning"`

---

### Task 17: Tile mode (`js/ui/tilemode.js`)

**Files:**
- Create: `js/ui/tilemode.js`
- Modify: `js/app/main.js` (mode switching mounts tile context panel; overlays already handle tile labels)

**Interfaces:**
- Consumes: state, model (`tileCount`, `tileRect`), pixels region ops, commands.
- Produces: `mountTilePanel(el)` — into `#panel-context` when `state.mode==='tiles'`:
  - Tile size inputs (tileWidth/tileHeight, command on change), tile count readout.
  - Selected tile row: index, name `<input>` (writes `sheet.tile.names[index]`, command), "Edit tile" button → `state.editingTileIndex = selected; state.view='tile'`.
  - All drawing tools remain live on the tile sheet view (it's the same CanvasView + bindDrawing as sprite sheets — whole-sheet target rect).
  - Tile selection: in tile mode, plain click with any tool while `state.tool==='frametool'`? No — instead: add tile-mode tool `{id:'tiletool', icon:'🔲', key:'t'}` (registered like frametool, tile mode only): click selects tile under cursor (`state.selectedTileIndex`, add to state in this task, default null); double-click opens tile editor; drag from tile A to tile B = **swap tiles** (pixel-carrying, all layers: copy both regions, blit swapped; also swaps `names[a]<->names[b]` and `neighbors[a]<->neighbors[b]`) as one command; Shift+drag = **move** (A overwrites B, A cleared; name/neighbors move, B's are dropped).
  - Selected tile highlighted via overlays (reuse `state.selectedTileIndex` in `overlays.js` — extend it here: 2px accent stroke).

- [ ] **Step 1: Implement; mount panel + tool registration in main.js on mode switch.**
- [ ] **Step 2: Verify in browser** — switch to Tile Sheets tab: demo tile sheet shows grid + index chips; set tile size 16×16; draw on atlas; select/swap two tiles by drag (pixels + names travel, undo restores); shift-drag moves; rename a tile, chip shows name. `npm test` green.
- [ ] **Step 3: Commit** — `git commit -am "feat: tile mode (atlas grid, select, swap/move tiles)"`

---

### Task 18: Tile editor + neighbor preview (`js/ui/tileeditor.js`)

**Files:**
- Create: `js/ui/tileeditor.js`
- Modify: `js/app/main.js` (view switching case `'tile'`)

**Interfaces:**
- Consumes: `getPreset`, `setSlot`, `resolveNeighborGrid`, `tileRect`, CanvasView, `bindDrawing`, commands.
- Produces: `mountTileEditor(hostEl) -> {show(), hide()}`.

Behavior:
- `show()`: tile `t = state.editingTileIndex`, rect `r = tileRect(sheet, t)`. Content size = `(2*radius+1) * tileW/H` (radius from a 3×3/5×5 `<select>`, default 1). `centerFit()`.
- `onPaint`: draw the neighbor cells first: `resolveNeighborGrid(getPreset(sheet, t), t, radius)` → for each cell with `tileIndex !== null`, draw that tile's flattened pixels at `(cell.dx+radius)*tw, (cell.dy+radius)*th` with flips via `ctx.save(); ctx.translate(...); ctx.scale(flipH?-1:1, flipV?-1:1); ctx.drawImage(tileScratch, ...); ctx.restore()`; dim neighbors slightly (`globalAlpha = 0.85`); then draw the center tile at full alpha; 1px accent border around center cell (in overlay pass). Tile scratch canvases redrawn every paint from current layer bitmaps → live update while drawing.
- Drawing: `bindDrawing(view, () => ({...}))` — target rect maps editor space to sheet space: the editor view content is virtual; simplest correct approach: `onPointer` coords are in editor space; translate tool input by `(r.x - radius*tw, r.y - radius*th)` so tools write into sheet bitmaps, and `getTargetRect()` returns `r` (clips to center tile). Implement by giving `bindDrawing` an optional `mapPoint(x, y)` third argument (add it in tools.js — 3-line change: apply before tool logic) that returns sheet coords.
- Slot config: clicking any neighbor cell (pointer down outside center rect, no drag) opens a small `<dialog>`: mode radio (Same tile / Other tile / Empty), tile index `<input type=number>` (enabled for Other; live-validated < tileCount), Flip H / Flip V checkboxes, OK/Cancel. OK → command wrapping `setSlot` (undo restores previous slot object).
- Top strip: label `Tile N (name)`, radius select (3×3/5×5), "Back to sheet" button; Escape returns too.

- [ ] **Step 1: Implement per contract (incl. the small `mapPoint` extension in tools.js).**
- [ ] **Step 2: Verify in browser** — edit a tile: all 8 neighbors mirror it live while drawing (default preset); set E slot to another tile with flip-H — renders flipped, updates when that tile is edited too; empty slot shows checkerboard; 5×5 extends pattern outward; slot changes undo/redo; Back returns with atlas updated. `npm test` green.
- [ ] **Step 3: Commit** — `git commit -am "feat: tile editor with live neighbor preview and slot config"`

---

### Task 19: Persistence wiring + exports

**Files:**
- Modify: `js/app/main.js` (complete the file menu handlers started in Task 11)

**Interfaces:**
- Consumes: everything from io.js; `flattenSheet`.
- Produces — exact export JSON shapes (consumed by external engines; documented in README):

```js
// Frames JSON (per sprite sheet): <sheetname>.frames.json
{ "sheet": "<name>.png", "width": W, "height": H,
  "frames": [{ "name", "index", "x", "y", "w", "h", "pivotX", "pivotY" }],
  "animations": [{ "name", "loop", "frames": [{ "frame": "<frame name>", "duration": ms }] }] }
// Tiles JSON (per tile sheet): <sheetname>.tiles.json
{ "sheet": "<name>.png", "tileWidth": tw, "tileHeight": th, "columns": c, "count": n,
  "tiles": [{ "index", "name": "<or null>", "neighbors": { "n": {"mode","tileIndex","flipH","flipV"}, ... } }] }
// only tiles with a name or stored preset are listed
```

- [ ] **Step 1: Implement handlers** — Save: packed→`savePacked(project, fileHandle)`, unpacked→`saveUnpacked(project, dirHandle)`, none yet→behave as Save As. Save As dialog (from Task 11) sets `saveMode` + handle, clears `dirty`, `clearAutosave()`. Open button: dialog with "Packed file…" / "Folder…" (folder hidden without FS API); confirm-discard if dirty; `setProject(...)` on success; `alert(err.message)` on validation failure (must show the version/corruption message from bundle.js). Export dialog: per active sheet — PNG (flattened via `flattenSheet` + `exportPngBlob` + `downloadBlob`), Frames JSON / Tiles JSON per shapes above (`downloadBlob` with `type:'application/json'`). Autosave interval (30s, only when dirty) + startup restore prompt were wired in Task 11 — verify they call the real functions.
- [ ] **Step 2: Verify in browser (Chrome)** — full loop: draw + frames + animation + tile preset → Save As packed → reload page → Open → everything intact (pixels, frames, animations, palettes, neighbor presets, tile names). Save As folder → inspect folder: `project.json` readable, `images/**.png` open in an image viewer. Export PNG opens; export frames JSON matches shape. Corrupt test: edit `project.json` version to 99 in the folder, Open → clear error alert, app keeps prior state. Kill tab while dirty → reopen → autosave restore prompt works.
- [ ] **Step 3: Commit** — `git commit -am "feat: open/save packed+unpacked, exports, autosave restore"`

---

### Task 20: Shortcuts, Playwright smoke, README polish

**Files:**
- Modify: `js/app/main.js`, `README.md`
- Create: `tests/smoke.md` (manual/Playwright checklist)

- [ ] **Step 1: Keyboard shortcuts** (guard: ignore when focus is in input/dialog): tool keys from TOOLS defs, `Ctrl+Z/Y/Shift+Z`, `Ctrl+S` save (preventDefault), `[`/`]` brush size, `X` swap primary/secondary, `Escape` closes focused editor views, `Delete` frame/selection. Document all in README under "Shortcuts" plus a "File format" section describing the bundle layout and export JSON shapes (copy from Task 19).
- [ ] **Step 2: Write `tests/smoke.md`** — numbered end-to-end script (the Task 13/16/18/19 verification lists condensed) so regressions are checkable; run it once fully via Playwright MCP; fix anything found.
- [ ] **Step 3: Final check** — `npm test` green; no console errors during smoke.
- [ ] **Step 4: Commit** — `git commit -am "feat: shortcuts, smoke checklist, README polish"`

---

## Self-Review Notes

- Spec coverage: two modes (T11/T17), packed-sheet basis (all editing on sheet bitmaps), frames freeform+slice (T14), pixel-carrying frame move (T14) and tile swap/move (T17), timeline+player (T15), onion skin configurable back/ahead (T16), neighbor presets 8 slots w/ flips + 3×3/5×5 live preview (T7/T18), overlays labels+sequence badges both modes (T14), layers (T5/T13), undo everywhere (T3 + per-task commands), palettes non-indexed/indexed/system + remap (T4/T13), bundle unpacked/packed via zip (T8/T9/T10/T19), autosave + beforeunload + validation errors (T10/T11/T19), exports PNG/frames JSON/tiles JSON (T19), Node tests for all core modules, README/serve (T1/T20).
- Deferred per spec: level maps, true indexed pixel storage, lasso/wand, terrain rules — not planned.
- Type consistency: Bitmap `{width,height,data}`; colors `[r,g,b,a]`; rects `{x,y,w,h}`; commands `{label,do,undo}` — used consistently in all tasks.
