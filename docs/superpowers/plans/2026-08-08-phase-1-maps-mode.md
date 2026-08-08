# Phase 1 (Maps Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `js/modes/maps` onto the Application/Presentation split defined in `docs/superpowers/specs/2026-08-08-ddd-target-architecture-design.md`, make `SelectionService` (not legacy `state.activeMapLayerId`/`state.selectedMapItemId`) the single source of truth for maps' layer/item selection, and give `js/ui/previewpanel.js` a host-native replacement for the `map-content` legacy event — all without touching sprites/tiles' still-legacy behavior.

**Architecture:** Maps is the pilot mode for the whole target architecture — no other mode has been migrated yet, so this plan establishes the pattern from scratch: pure geometry/hit-testing in `application/`, Command Handlers via `ProjectService.mutate()` + `HistoryService.execute()`, a thin `presentation/` Presenter (pointer handling) + Renderer (Canvas drawing) + panels, wired through `contributions.js`. Shared files (`js/ui/panels.js`, `js/features/project/document-controller.js`, `js/features/project/legacy-state-adapter.js`, `js/ui/previewpanel.js`, `js/app/state.js`) get surgical edits to their maps-specific branches only — sprite/tile code paths in those files are untouched.

**Tech Stack:** Vanilla JS, ES modules, `node --test` (no jsdom — only `application/` code is unit-tested; `presentation/` pointer/Canvas behavior is verified manually per project convention).

## Global Constraints

- No build step, no dependencies, no TypeScript, no UI framework (per `docs/superpowers/specs/2026-08-08-ddd-target-architecture-design.md`).
- Domain never imports upward; Application never touches DOM/Canvas (enforced by `tests/architecture.test.mjs`'s banned-globals scan, which already includes `js/modes/*/application/**`); Presentation dispatches by id only where Commands exist, never imports command-handler modules directly (already enforced for `js/modes/*/presentation/**`); no mode imports another mode's application/presentation (already enforced generically).
- `js/host/*` (`ProjectService.mutate`, `HistoryService.execute`, `SelectionService.get/set/clear`, `getEditorHost()` from `js/host/runtime.js`) already exists from Phase 0 — this plan is the first real consumer.
- Every new Command Handler must dual-write: route the mutation through `ProjectService.mutate()` (host-side dirty flag + transaction) **and** call legacy `markDirty()` from `js/app/state.js` (the title-bar/unsaved-changes guard still reads legacy `state.dirty`, unrelated to this migration, unification deferred to Phase 4) — this exactly matches the existing dual-write precedent already used by `js/modes/tiles/tile-sheet-commands.js`.
- `js/modes/maps/documents.js` is already pure/clean (per the spec's own note) — no changes needed there.
- Tasks are ordered so automated tests stay green after every task. End-to-end maps-mode behavior (paint/erase/select/move/delete-item, layer add/delete, map switch/delete/undo) is only fully correct after Task 12 — flagged explicitly in Task 13's manual-verification checklist, since pointer-drag interactions cannot be simulated in Playwright for this project (per project convention: drag/paint gestures are verified by hand, not scripted).

---

## Behavior-change note (read before Task 10)

Today, `js/features/project/document-controller.js`'s `sheetSelect` "switch to a different map" handler always resets the newly-active map's layer selection to `map.layers[0]?.id`. Sprite/tile sheet switching has the same unconditional-reset behavior for `activeLayerId`. After this plan, maps' layer/item selection becomes keyed per-document in `SelectionService` (exactly like sprite sheets' per-sheet frame/tile selections already are, conceptually) and Task 9's adapter change only **seeds** a default selection the first time a map is visited — revisiting a map you've already opened this session now restores its last-used layer instead of resetting to layer 0. This is an intentional, minor UX improvement that falls out naturally from routing maps through the same per-document selection mechanism already designed for sprites/tiles; it is not a bug. Sprites/tiles are untouched and keep today's reset-on-switch behavior.

---

### Task 1: Pure map geometry + hit-testing (`application/map-geometry.js`)

**Files:**
- Create: `js/modes/maps/application/map-geometry.js`
- Test: `tests/map-geometry.test.mjs`

**Interfaces:**
- Produces: `MAP_ORIGIN`, `MAP_SPAN`, `mapXY(ev)`, `findSheet(project, id)`, `snap(map, p, size)`, `terrainAt(layer, sheet, terrain, x, y)`, `terrainResolution(layer, sheet, terrain, x, y)`, `selectedTile(project, asset)`, `selectedTerrain(project, asset)`, `selectedSprite(project, asset)`, `itemSize(project, item)`, `hitSprite(project, layer, p)`, `hitMapItem(project, layer, p)`, `brushSpacing(map, tool, asset, project)`, `strokeSamples(map, from, to, spacing)`, `claimStrokeCell(stroke, key)`.
- Consumes: nothing from other tasks (this is the leaf application module).

All functions here are pure: they take `project`/`map`/`asset` as explicit parameters instead of reading legacy `state`/module-level singletons, so they're independently unit-testable with plain object literals. `itemSize`/`hitSprite` use each sprite's **first frame** for footprint sizing (not the live-playing frame) — this matches the existing `selectedSprite` precedent (`item.frames?.[0]?.frameId`) and keeps hit-testing deterministic; sprite frames within one animation share a footprint in this app's model, so this is behavior-preserving for real content.

- [ ] **Step 1: Write the failing test**

```js
// tests/map-geometry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapXY, findSheet, snap, terrainAt, terrainResolution,
  selectedTile, selectedTerrain, selectedSprite, itemSize,
  hitSprite, hitMapItem, brushSpacing, strokeSamples, claimStrokeCell, MAP_ORIGIN,
} from '../js/modes/maps/application/map-geometry.js';

test('mapXY offsets an event point by MAP_ORIGIN', () => {
  assert.deepEqual(mapXY({ x: MAP_ORIGIN + 5, y: MAP_ORIGIN - 3 }), { x: 5, y: -3 });
});

test('findSheet looks up a sheet by id within a project', () => {
  const project = { sheets: [{ id: 's1' }, { id: 's2' }] };
  assert.equal(findSheet(project, 's2'), project.sheets[1]);
  assert.equal(findSheet(project, 'missing'), null);
});

test('snap respects map-grid mode', () => {
  const map = { snap: { mode: 'map', gridW: 16, gridH: 16 } };
  assert.deepEqual(snap(map, { x: 20, y: 33 }, { w: 8, h: 8 }), { x: 16, y: 32 });
});

test('snap respects asset-grid mode using the brush size', () => {
  const map = { snap: { mode: 'asset', gridW: 16, gridH: 16 } };
  assert.deepEqual(snap(map, { x: 20, y: 33 }, { w: 8, h: 8 }), { x: 16, y: 32 });
});

test('snap passes through unchanged when off', () => {
  const map = { snap: { mode: 'off', gridW: 16, gridH: 16 } };
  assert.deepEqual(snap(map, { x: 20, y: 33 }, { w: 8, h: 8 }), { x: 20, y: 33 });
});

test('terrainAt finds a matching terrain entry', () => {
  const entry = { sheetId: 's1', terrainSetId: 't1', x: 16, y: 32 };
  const layer = { terrain: [entry] };
  assert.equal(terrainAt(layer, { id: 's1' }, { id: 't1' }, 16, 32), entry);
  assert.equal(terrainAt(layer, { id: 's1' }, { id: 't1' }, 0, 0), undefined);
});

test('selectedTile resolves the brush sheet/tile from asset ids', () => {
  const tile = { id: 'ti1' };
  const project = { sheets: [{ id: 's1', tiles: [tile] }] };
  const asset = { tileSheetId: 's1', tileId: 'ti1' };
  assert.deepEqual(selectedTile(project, asset), { sheet: project.sheets[0], tile });
});

test('selectedSprite resolves an animation brush using its first frame size', () => {
  const frame = { id: 'f1', w: 16, h: 24 };
  const anim = { id: 'a1', frames: [{ frameId: 'f1' }] };
  const project = { sheets: [{ id: 's1', frames: [frame], animations: [anim] }] };
  const asset = { spriteSheetId: 's1', spriteKind: 'animation', spriteId: 'a1' };
  assert.deepEqual(selectedSprite(project, asset), { sheet: project.sheets[0], item: anim, size: { w: 16, h: 24 } });
});

test('itemSize resolves tile, terrain, and first-frame sprite sizes', () => {
  const project = {
    sheets: [{
      id: 's1',
      tiles: [{ id: 'ti1', w: 16, h: 16 }],
      terrainSets: [{ id: 'te1', tileW: 32, tileH: 32 }],
      frames: [{ id: 'f1', w: 8, h: 12 }],
      animations: [{ id: 'a1', frames: [{ frameId: 'f1' }] }],
    }],
  };
  assert.deepEqual(itemSize(project, { sheetId: 's1', tileId: 'ti1' }), { w: 16, h: 16 });
  assert.deepEqual(itemSize(project, { sheetId: 's1', terrainSetId: 'te1' }), { w: 32, h: 32 });
  assert.deepEqual(itemSize(project, { sheetId: 's1', kind: 'animation', assetId: 'a1' }), { w: 8, h: 12 });
});

test('hitMapItem finds tiles, terrain, and sprites by point, topmost first', () => {
  const project = { sheets: [{ id: 's1', tiles: [{ id: 'ti1', w: 16, h: 16 }] }] };
  const under = { id: 'i1', sheetId: 's1', tileId: 'ti1', x: 0, y: 0 };
  const over = { id: 'i2', sheetId: 's1', tileId: 'ti1', x: 0, y: 0 };
  const layer = { type: 'tile', tiles: [under, over], terrain: [] };
  assert.equal(hitMapItem(project, layer, { x: 4, y: 4 }), over);
  assert.equal(hitMapItem(project, layer, { x: 100, y: 100 }), null);
});

test('hitSprite hit-tests using first-frame size', () => {
  const project = { sheets: [{ id: 's1', frames: [{ id: 'f1', w: 20, h: 10 }] }] };
  const entry = { id: 'sp1', sheetId: 's1', kind: 'frame', assetId: 'f1', x: 0, y: 0 };
  const layer = { type: 'sprite', sprites: [entry] };
  assert.equal(hitSprite(project, layer, { x: 5, y: 5 }), entry);
  assert.equal(hitSprite(project, layer, { x: 25, y: 5 }), null);
});

test('brushSpacing uses map grid unless asset-snap picks the brush footprint', () => {
  const project = { sheets: [{ id: 's1', tiles: [{ id: 'ti1', w: 8, h: 8 }] }] };
  const asset = { tileKind: 'tile', tileSheetId: 's1', tileId: 'ti1' };
  const gridMap = { snap: { mode: 'map', gridW: 16, gridH: 16 } };
  assert.deepEqual(brushSpacing(gridMap, 'maptile', asset, project), { w: 16, h: 16 });
  const assetMap = { snap: { mode: 'asset', gridW: 16, gridH: 16 } };
  assert.deepEqual(brushSpacing(assetMap, 'maptile', asset, project), { w: 8, h: 8 });
  const offMap = { snap: { mode: 'off', gridW: 16, gridH: 16 } };
  assert.equal(brushSpacing(offMap, 'maptile', asset, project), null);
});

test('strokeSamples interpolates evenly spaced points between two drag positions', () => {
  const samples = strokeSamples({}, { x: 0, y: 0 }, { x: 20, y: 0 }, { w: 10, h: 10 });
  assert.equal(samples.length, 2);
  assert.deepEqual(samples[1], { x: 20, y: 0 });
});

test('claimStrokeCell only allows a stroke to touch a cell once', () => {
  const stroke = { visited: new Set() };
  assert.equal(claimStrokeCell(stroke, 'a'), true);
  assert.equal(claimStrokeCell(stroke, 'a'), false);
  assert.equal(claimStrokeCell(null, 'a'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/map-geometry.test.mjs`
Expected: FAIL — `js/modes/maps/application/map-geometry.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// js/modes/maps/application/map-geometry.js
import { DIRECTION_OFFSETS, resolveTerrainSlot, maskToBlobIndex } from '../../../core/blob47.js';

// CanvasView needs finite dimensions; this generous, centred work area keeps
// persisted map coordinates naturally signed while remaining effectively
// infinite for normal test scenes.
export const MAP_ORIGIN = 4096, MAP_SPAN = MAP_ORIGIN * 2;

export function mapXY(ev) { return { x: ev.x - MAP_ORIGIN, y: ev.y - MAP_ORIGIN }; }

export function findSheet(project, id) { return project?.sheets.find(s => s.id === id) ?? null; }

export function snap(map, p, size) {
  const mode = map.snap?.mode ?? 'map';
  if (mode === 'off') return p;
  const w = mode === 'asset' ? Math.max(1, size.w) : Math.max(1, map.snap.gridW);
  const h = mode === 'asset' ? Math.max(1, size.h) : Math.max(1, map.snap.gridH);
  return { x: Math.floor(p.x / w) * w, y: Math.floor(p.y / h) * h };
}

export function terrainAt(layer, sheet, terrain, x, y) {
  return layer.terrain.find(t => t.sheetId === sheet.id && t.terrainSetId === terrain.id && t.x === x && t.y === y);
}

export function terrainResolution(layer, sheet, terrain, x, y) {
  if (!layer || !sheet || !terrain) return null;
  let mask = 0;
  for (const { dx, dy, bit } of DIRECTION_OFFSETS) {
    if (terrainAt(layer, sheet, terrain, x + dx * terrain.tileW, y + dy * terrain.tileH)) mask |= bit;
  }
  const slot = resolveTerrainSlot(terrain, maskToBlobIndex[mask]);
  const tile = slot && sheet.tiles.find(candidate => candidate.id === slot.tileId);
  return tile ? { ...slot, tile } : null;
}

export function selectedTile(project, asset) {
  const sheet = findSheet(project, asset.tileSheetId);
  return { sheet, tile: sheet?.tiles?.find(t => t.id === asset.tileId) ?? null };
}

export function selectedTerrain(project, asset) {
  const sheet = findSheet(project, asset.terrainSheetId);
  return { sheet, terrain: sheet?.terrainSets?.find(t => t.id === asset.terrainSetId) ?? null };
}

export function selectedSprite(project, asset) {
  const sheet = findSheet(project, asset.spriteSheetId);
  if (!sheet) return { sheet: null, item: null, size: { w: 16, h: 16 } };
  const item = asset.spriteKind === 'animation'
    ? sheet.animations.find(a => a.id === asset.spriteId)
    : sheet.frames.find(f => f.id === asset.spriteId);
  const frame = asset.spriteKind === 'animation'
    ? sheet.frames.find(f => f.id === item?.frames?.[0]?.frameId)
    : item;
  return { sheet, item, size: { w: frame?.w ?? 16, h: frame?.h ?? 16 } };
}

// First-frame sizing (not the live-playing frame): sprite footprint is
// treated as constant across an animation's frames, matching selectedSprite.
function spriteFirstFrame(project, entry) {
  const sheet = findSheet(project, entry.sheetId);
  if (!sheet) return null;
  if (entry.kind === 'animation') {
    const anim = sheet.animations.find(a => a.id === entry.assetId);
    return sheet.frames.find(f => f.id === anim?.frames?.[0]?.frameId) ?? null;
  }
  return sheet.frames.find(f => f.id === entry.assetId) ?? null;
}

export function itemSize(project, item) {
  if ('tileId' in item) {
    const tile = findSheet(project, item.sheetId)?.tiles.find(t => t.id === item.tileId);
    return { w: tile?.w ?? 16, h: tile?.h ?? 16 };
  }
  if ('terrainSetId' in item) {
    const terrain = findSheet(project, item.sheetId)?.terrainSets.find(t => t.id === item.terrainSetId);
    return { w: terrain?.tileW ?? 16, h: terrain?.tileH ?? 16 };
  }
  const frame = spriteFirstFrame(project, item);
  return { w: frame?.w ?? 16, h: frame?.h ?? 16 };
}

export function hitSprite(project, layer, p) {
  for (let i = layer.sprites.length - 1; i >= 0; i--) {
    const entry = layer.sprites[i];
    const size = itemSize(project, entry);
    if (p.x >= entry.x && p.y >= entry.y && p.x < entry.x + size.w && p.y < entry.y + size.h) return entry;
  }
  return null;
}

export function hitMapItem(project, layer, p) {
  if (layer.type === 'sprite') return hitSprite(project, layer, p);
  for (let i = layer.tiles.length - 1; i >= 0; i--) {
    const item = layer.tiles[i], sheet = findSheet(project, item.sheetId), tile = sheet?.tiles.find(t => t.id === item.tileId);
    if (tile && p.x >= item.x && p.y >= item.y && p.x < item.x + tile.w && p.y < item.y + tile.h) return item;
  }
  for (let i = layer.terrain.length - 1; i >= 0; i--) {
    const item = layer.terrain[i], sheet = findSheet(project, item.sheetId), terrain = sheet?.terrainSets.find(t => t.id === item.terrainSetId);
    if (terrain && p.x >= item.x && p.y >= item.y && p.x < item.x + terrain.tileW && p.y < item.y + terrain.tileH) return item;
  }
  return null;
}

export function brushSpacing(map, tool, asset, project) {
  if (map.snap?.mode === 'off') return null;
  if (map.snap?.mode !== 'asset') return { w: Math.max(1, map.snap.gridW), h: Math.max(1, map.snap.gridH) };
  if (tool === 'maptile' && asset.tileKind === 'terrain') {
    const { terrain } = selectedTerrain(project, asset);
    return terrain ? { w: terrain.tileW, h: terrain.tileH } : null;
  }
  if (tool === 'maptile') {
    const { tile } = selectedTile(project, asset);
    return tile ? { w: tile.w, h: tile.h } : null;
  }
  if (tool === 'mapsprite') return selectedSprite(project, asset).size;
  return null;
}

export function strokeSamples(map, from, to, spacing) {
  if (!from || !spacing) return [to];
  const steps = Math.max(1, Math.ceil(Math.abs(to.x - from.x) / spacing.w), Math.ceil(Math.abs(to.y - from.y) / spacing.h));
  return Array.from({ length: steps }, (_, index) => {
    const amount = (index + 1) / steps;
    return { x: from.x + (to.x - from.x) * amount, y: from.y + (to.y - from.y) * amount };
  });
}

export function claimStrokeCell(stroke, key) {
  if (!stroke || stroke.visited.has(key)) return false;
  stroke.visited.add(key);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/map-geometry.test.mjs`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add js/modes/maps/application/map-geometry.js tests/map-geometry.test.mjs
git commit -m "feat(maps): extract pure map geometry into application layer"
```

---

### Task 2: Brush-pick state (`application/map-brush-state.js`)

**Files:**
- Create: `js/modes/maps/application/map-brush-state.js`

**Interfaces:**
- Produces: `mapBrushState` — a plain mutable object `{ tileKind, tileSheetId, tileId, terrainSheetId, terrainSetId, spriteSheetId, spriteKind, spriteId }`, replacing map-editor.js's module-level `mapAsset`/`asset` singleton. Consumed by Task 1's functions (as the `asset` parameter, passed explicitly by callers — this module itself has no logic, just shared mutable state), Task 5 (renderer), Task 6 (presenter), Task 7 (assets panel).
- No DOM/Canvas coupling; ephemeral UI pick, not persisted with the project (matches current behavior — `mapAsset` was never part of `core/model.js`'s project shape either).

- [ ] **Step 1: Write the implementation** (no test — plain data holder, exercised transitively by later tasks' tests)

```js
// js/modes/maps/application/map-brush-state.js
export const mapBrushState = {
  tileKind: 'tile', tileSheetId: '', tileId: '',
  terrainSheetId: '', terrainSetId: '',
  spriteSheetId: '', spriteKind: 'frame', spriteId: '',
};
```

- [ ] **Step 2: Commit**

```bash
git add js/modes/maps/application/map-brush-state.js
git commit -m "feat(maps): move brush-pick state into application layer"
```

---

### Task 3: Content Command Handlers (`application/commands/map-paint-commands.js`)

**Files:**
- Create: `js/modes/maps/application/commands/map-paint-commands.js`
- Test: `tests/map-paint-commands.test.mjs`

**Interfaces:**
- Consumes: Task 1's `findSheet`, `terrainAt`, `terrainResolution`; `js/host/project-service.js`'s `ProjectService.mutate(reason, mutateFn)` and its read-only `.project` getter (both Phase 0); `js/host/history-service.js`'s `HistoryService.execute(command)`; `js/core/palettes.js`'s `newId`; `js/core/model.js`'s `refreshMapBounds`; `js/app/state.js`'s `markDirty`.
- Produces: `paintMapTile(services, mapId, layerId, sheetId, tileId, at)`, `eraseMapTile(services, mapId, layerId, at)`, `paintMapTerrain(services, mapId, layerId, sheetId, terrainSetId, at)`, `eraseMapTerrain(services, mapId, layerId, sheetId, terrainSetId, at)`, `paintMapSprite(services, mapId, layerId, sheetId, kind, assetId, at)`, `eraseMapSprite(services, mapId, layerId, itemId)`, `moveMapItem(services, mapId, layerId, itemId, before, after)`, `deleteMapItem(services, mapId, layerId, itemId)`. `services` is `{ projects, history }` (the `EditorHost.services` subset). Each function returns nothing meaningful for paint/erase (mirrors current behavior — callers already have the ids they need) except where noted.

Each handler: (1) locates the map inside the live `project` passed to the mutate callback (never captures a stale reference), (2) builds a `{label, do, undo}` command whose `do`/`undo` each re-enter `projects.mutate()` so every history step gets a fresh host transaction + dirty flag, (3) calls `history.execute(command)`, (4) calls legacy `markDirty()` for the title-bar/unsaved-changes guard (per Global Constraints). The erase/delete handlers (`eraseMapTile`, `eraseMapTerrain`, `eraseMapSprite`, `deleteMapItem`) look up the target item **once, synchronously, via `services.projects.project`** before building the command, and close over that found object in `do`/`undo` — mirroring `js/modes/tiles/tile-sheet-commands.js`'s `deleteTile` exactly. They never stash the removed item as a property on `layer`/`map` (e.g. no `layer.__erasedTile`): that would leave dangling `__`-prefixed bookkeeping fields permanently attached to the persisted project model any time an erase/delete is never undone, which would then get serialized into save files.

- [ ] **Step 1: Write the failing test**

```js
// tests/map-paint-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import {
  paintMapTile, eraseMapTile, paintMapTerrain, paintMapSprite, eraseMapSprite,
  moveMapItem, deleteMapItem,
} from '../js/modes/maps/application/commands/map-paint-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject() {
  const map = {
    id: 'map1',
    layers: [{ id: 'layer1', type: 'tile', tiles: [], terrain: [] }, { id: 'layer2', type: 'sprite', sprites: [] }],
    bounds: null,
  };
  const sheet = {
    id: 'sheet1', kind: 'tile',
    tiles: [{ id: 'tile1', w: 16, h: 16 }],
    terrainSets: [{ id: 'terrain1', tileW: 16, tileH: 16 }],
    frames: [{ id: 'frame1', w: 16, h: 16 }],
    animations: [],
  };
  return { sheets: [sheet], maps: [map] };
}

test('paintMapTile places a tile and is undoable/redoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;

  paintMapTile(services, 'map1', 'layer1', 'sheet1', 'tile1', { x: 0, y: 0 });
  const layer = project.maps[0].layers[0];
  assert.equal(layer.tiles.length, 1);
  assert.equal(layer.tiles[0].tileId, 'tile1');
  assert.equal(services.store.getState().project.dirty, true);
  assert.equal(state.dirty, true);

  services.history.undo();
  assert.equal(layer.tiles.length, 0);
  services.history.redo();
  assert.equal(layer.tiles.length, 1);
});

test('eraseMapTile removes the tile at a point and undo restores it', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;

  paintMapTile(services, 'map1', 'layer1', 'sheet1', 'tile1', { x: 0, y: 0 });
  eraseMapTile(services, 'map1', 'layer1', { x: 0, y: 0 });
  const layer = project.maps[0].layers[0];
  assert.equal(layer.tiles.length, 0);

  services.history.undo();
  assert.equal(layer.tiles.length, 1);
});

test('paintMapTerrain adds a terrain entry once per cell', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;

  paintMapTerrain(services, 'map1', 'layer1', 'sheet1', 'terrain1', { x: 0, y: 0 });
  const layer = project.maps[0].layers[0];
  assert.equal(layer.terrain.length, 1);
  assert.equal(layer.terrain[0].terrainSetId, 'terrain1');
});

test('paintMapSprite places a sprite entry and eraseMapSprite removes by id', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;

  paintMapSprite(services, 'map1', 'layer2', 'sheet1', 'frame', 'frame1', { x: 4, y: 4 });
  const layer = project.maps[0].layers[1];
  assert.equal(layer.sprites.length, 1);
  const itemId = layer.sprites[0].id;

  eraseMapSprite(services, 'map1', 'layer2', itemId);
  assert.equal(layer.sprites.length, 0);

  services.history.undo();
  assert.equal(layer.sprites.length, 1);
});

test('moveMapItem repositions an item and undo restores the prior position', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;
  paintMapSprite(services, 'map1', 'layer2', 'sheet1', 'frame', 'frame1', { x: 0, y: 0 });
  const item = project.maps[0].layers[1].sprites[0];

  moveMapItem(services, 'map1', 'layer2', item.id, { x: 0, y: 0 }, { x: 32, y: 16 });
  assert.deepEqual({ x: item.x, y: item.y }, { x: 32, y: 16 });

  services.history.undo();
  assert.deepEqual({ x: item.x, y: item.y }, { x: 0, y: 0 });
});

test('deleteMapItem removes any item kind by id and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;
  paintMapTile(services, 'map1', 'layer1', 'sheet1', 'tile1', { x: 0, y: 0 });
  const item = project.maps[0].layers[0].tiles[0];

  deleteMapItem(services, 'map1', 'layer1', item.id);
  assert.equal(project.maps[0].layers[0].tiles.length, 0);

  services.history.undo();
  assert.equal(project.maps[0].layers[0].tiles.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/map-paint-commands.test.mjs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```js
// js/modes/maps/application/commands/map-paint-commands.js
import { findSheet, terrainAt, terrainResolution } from '../map-geometry.js';
import { refreshMapBounds } from '../../../../core/model.js';
import { newId } from '../../../../core/palettes.js';
import { markDirty } from '../../../../app/state.js';

function findMap(project, mapId) { return project.maps.find(m => m.id === mapId) ?? null; }
function findLayer(map, layerId) { return map?.layers.find(l => l.id === layerId) ?? null; }

function runCommand(services, mapId, label, apply, revert) {
  const command = {
    label,
    do: () => services.projects.mutate(label, project => {
      const map = findMap(project, mapId);
      apply(map, project);
      refreshMapBounds(project, map);
    }),
    undo: () => services.projects.mutate(label, project => {
      const map = findMap(project, mapId);
      revert(map, project);
      refreshMapBounds(project, map);
    }),
  };
  services.history.execute(command);
  markDirty();
}

export function paintMapTile(services, mapId, layerId, sheetId, tileId, at) {
  const entry = { id: newId('mi'), sheetId, tileId, x: at.x, y: at.y };
  runCommand(services, mapId, 'place map tile',
    map => { findLayer(map, layerId).tiles.push(entry); },
    map => { const layer = findLayer(map, layerId); layer.tiles = layer.tiles.filter(t => t.id !== entry.id); });
}

export function eraseMapTile(services, mapId, layerId, at) {
  const layer = findLayer(findMap(services.projects.project, mapId), layerId);
  const found = layer?.tiles.find(t => t.x === at.x && t.y === at.y);
  if (!found) return;
  runCommand(services, mapId, 'erase map tile',
    map => { const layer = findLayer(map, layerId); layer.tiles = layer.tiles.filter(t => t.id !== found.id); },
    map => { const layer = findLayer(map, layerId); if (!layer.tiles.some(t => t.id === found.id)) layer.tiles.push(found); });
}

export function paintMapTerrain(services, mapId, layerId, sheetId, terrainSetId, at) {
  const entry = { id: newId('mt'), sheetId, terrainSetId, x: at.x, y: at.y };
  runCommand(services, mapId, 'paint map terrain',
    (map, project) => {
      const layer = findLayer(map, layerId), sheet = findSheet(project, sheetId), terrain = sheet.terrainSets.find(t => t.id === terrainSetId);
      if (!terrainAt(layer, sheet, terrain, at.x, at.y)) layer.terrain.push(entry);
    },
    map => { const layer = findLayer(map, layerId); layer.terrain = layer.terrain.filter(t => t.id !== entry.id); });
}

export function eraseMapTerrain(services, mapId, layerId, sheetId, terrainSetId, at) {
  const project = services.projects.project;
  const layer = findLayer(findMap(project, mapId), layerId);
  const sheet = findSheet(project, sheetId);
  const terrain = sheet?.terrainSets.find(t => t.id === terrainSetId);
  const found = layer && sheet && terrain ? terrainAt(layer, sheet, terrain, at.x, at.y) : null;
  if (!found) return;
  runCommand(services, mapId, 'erase map terrain',
    map => { const layer = findLayer(map, layerId); layer.terrain = layer.terrain.filter(t => t.id !== found.id); },
    map => { const layer = findLayer(map, layerId); if (!layer.terrain.some(t => t.id === found.id)) layer.terrain.push(found); });
}

export function paintMapSprite(services, mapId, layerId, sheetId, kind, assetId, at) {
  const entry = { id: newId('ms'), sheetId, kind, assetId, x: at.x, y: at.y };
  runCommand(services, mapId, 'place map sprite',
    map => { findLayer(map, layerId).sprites.push(entry); },
    map => { const layer = findLayer(map, layerId); layer.sprites = layer.sprites.filter(s => s.id !== entry.id); });
}

export function eraseMapSprite(services, mapId, layerId, itemId) {
  const layer = findLayer(findMap(services.projects.project, mapId), layerId);
  const found = layer?.sprites.find(s => s.id === itemId);
  if (!found) return;
  runCommand(services, mapId, 'erase map sprite',
    map => { const layer = findLayer(map, layerId); layer.sprites = layer.sprites.filter(s => s.id !== found.id); },
    map => { const layer = findLayer(map, layerId); if (!layer.sprites.some(s => s.id === found.id)) layer.sprites.push(found); });
}

function findItemCollectionKey(layer, itemId) {
  if (layer.tiles?.some(i => i.id === itemId)) return 'tiles';
  if (layer.terrain?.some(i => i.id === itemId)) return 'terrain';
  if (layer.sprites?.some(i => i.id === itemId)) return 'sprites';
  return null;
}

export function moveMapItem(services, mapId, layerId, itemId, before, after) {
  runCommand(services, mapId, 'move map item',
    map => {
      const layer = findLayer(map, layerId);
      const key = findItemCollectionKey(layer, itemId);
      const item = key && layer[key].find(i => i.id === itemId);
      if (item) Object.assign(item, after);
    },
    map => {
      const layer = findLayer(map, layerId);
      const key = findItemCollectionKey(layer, itemId);
      const item = key && layer[key].find(i => i.id === itemId);
      if (item) Object.assign(item, before);
    });
}

export function deleteMapItem(services, mapId, layerId, itemId) {
  const layer = findLayer(findMap(services.projects.project, mapId), layerId);
  const key = layer ? findItemCollectionKey(layer, itemId) : null;
  const found = key ? layer[key].find(i => i.id === itemId) : null;
  if (!found) return;
  runCommand(services, mapId, 'delete map item',
    map => { const layer = findLayer(map, layerId); layer[key] = layer[key].filter(i => i.id !== itemId); },
    map => { const layer = findLayer(map, layerId); if (!layer[key].some(i => i.id === itemId)) layer[key].push(found); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/map-paint-commands.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add js/modes/maps/application/commands/map-paint-commands.js tests/map-paint-commands.test.mjs
git commit -m "feat(maps): add Command Handlers for map content edits"
```

---

### Task 4: Layer Command Handlers (`application/commands/map-layer-commands.js`)

**Files:**
- Create: `js/modes/maps/application/commands/map-layer-commands.js`
- Test: `tests/map-layer-commands.test.mjs`

**Interfaces:**
- Consumes: `js/core/model.js`'s `createMapLayer`, `refreshMapBounds`; `js/host/project-service.js`'s `ProjectService.mutate` and its read-only `.project` getter, `js/host/history-service.js`; `js/app/state.js`'s `markDirty`.
- Produces: `addMapLayer(services, mapId, type)` → returns the created layer's id (matches current non-undoable behavior — see note below), `deleteMapLayer(services, mapId, layerId)` (undoable, matches current behavior).

`addMapLayer` is intentionally **not** wrapped in undo history, preserving today's exact behavior in `js/ui/panels.js`'s `doAddLayer`/`doAddGroup` (neither currently pushes a command for map-layer creation). `deleteMapLayer` **is** undoable, matching today's `doDelete`. Like Task 3's erase/delete handlers, `deleteMapLayer` looks up the target layer once via `services.projects.project` and closes over it for `do`/`undo`, instead of stashing it on `map` (e.g. no `map.__deletedLayer`) — keeps command-undo bookkeeping out of the persisted project model.

- [ ] **Step 1: Write the failing test**

```js
// tests/map-layer-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import { addMapLayer, deleteMapLayer } from '../js/modes/maps/application/commands/map-layer-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject() {
  return { sheets: [], maps: [{ id: 'map1', layers: [{ id: 'l0', type: 'tile', tiles: [], terrain: [] }], bounds: null }] };
}

test('addMapLayer creates a layer of the given type and marks the project dirty', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;

  const layerId = addMapLayer(services, 'map1', 'sprite');
  const map = project.maps[0];
  assert.equal(map.layers.length, 2);
  assert.equal(map.layers[1].id, layerId);
  assert.equal(map.layers[1].type, 'sprite');
  assert.equal(services.store.getState().project.dirty, true);
  assert.equal(state.dirty, true);
});

test('deleteMapLayer removes a layer and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;
  const layerId = addMapLayer(services, 'map1', 'sprite');

  deleteMapLayer(services, 'map1', layerId);
  assert.equal(project.maps[0].layers.length, 1);

  services.history.undo();
  assert.equal(project.maps[0].layers.length, 2);
  assert.equal(project.maps[0].layers[1].id, layerId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/map-layer-commands.test.mjs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```js
// js/modes/maps/application/commands/map-layer-commands.js
import { createMapLayer, refreshMapBounds } from '../../../../core/model.js';
import { markDirty } from '../../../../app/state.js';

function findMap(project, mapId) { return project.maps.find(m => m.id === mapId) ?? null; }

export function addMapLayer(services, mapId, type) {
  let createdId = null;
  services.projects.mutate('add map layer', project => {
    const map = findMap(project, mapId);
    const layer = createMapLayer(map, { type });
    createdId = layer.id;
  });
  markDirty();
  return createdId;
}

export function deleteMapLayer(services, mapId, layerId) {
  const map = findMap(services.projects.project, mapId);
  const layer = map?.layers.find(l => l.id === layerId);
  if (!layer) return;
  const index = map.layers.indexOf(layer);
  const command = {
    label: 'delete map layer',
    do: () => services.projects.mutate('delete map layer', project => {
      const map = findMap(project, mapId);
      map.layers = map.layers.filter(l => l.id !== layerId);
      refreshMapBounds(project, map);
    }),
    undo: () => services.projects.mutate('delete map layer', project => {
      const map = findMap(project, mapId);
      if (!map.layers.some(l => l.id === layerId)) map.layers.splice(index, 0, layer);
      refreshMapBounds(project, map);
    }),
  };
  services.history.execute(command);
  markDirty();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/map-layer-commands.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add js/modes/maps/application/commands/map-layer-commands.js tests/map-layer-commands.test.mjs
git commit -m "feat(maps): add Command Handlers for map layer add/delete"
```

---

### Task 5: Renderer (`presentation/map-renderer.js`)

**Files:**
- Create: `js/modes/maps/presentation/map-renderer.js`

**Interfaces:**
- Consumes: Task 1's `findSheet`, `terrainResolution`, `snap`, `selectedTile`, `selectedTerrain`, `selectedSprite`, `itemSize`; Task 2's `mapBrushState`; `js/core/model.js`'s `flattenSheet`, `effectiveDuration`, `refreshMapBounds`, `DEFAULT_MAP_BOUNDS`; `js/host/runtime.js`'s `getEditorHost`.
- Produces: `flatCanvas(sheet)`, `clearMapRasterCache()`, `isMapPlaying()`, `toggleMapPlayback()`, `paintMap(ctx, map)`, `renderMapPreviewBitmap(map)`, `drawMapOverlay(view, ctx, map, project, tool, selectedItemId)`, `focusMapCanvas(view)`.

This is the only new maps file allowed to touch `document`/`CanvasRenderingContext2D`/`OffscreenCanvas` per the architecture test — it owns Canvas drawing and playback timing (`animationFrame`, which needs `performance.now()` and therefore cannot be pure/application-layer).

- [ ] **Step 1: Write the implementation** (no automated test — Canvas drawing is verified manually per project convention; this is a straight move of `paintMap`/`drawMapOverlay`/`renderMapPreviewBitmap`/`flatCanvas`/`focusMapCanvas` from `map-editor.js` with legacy `state`/`activeMap()` reads replaced by explicit parameters)

```js
// js/modes/maps/presentation/map-renderer.js
import { flattenSheet, effectiveDuration, refreshMapBounds, DEFAULT_MAP_BOUNDS } from '../../../core/model.js';
import { findSheet, snap, selectedTile, selectedTerrain, selectedSprite, itemSize, terrainResolution, MAP_ORIGIN } from '../application/map-geometry.js';
import { mapBrushState as asset } from '../application/map-brush-state.js';

let playing = false, playStarted = 0;
let flatCache = new Map();
let mapPreviewCanvas = null;

export function focusMapCanvas(view) {
  view.setContent({ width: MAP_ORIGIN * 2, height: MAP_ORIGIN * 2 });
  const center = () => {
    view.zoom = 2;
    view.panX = Math.round(view.cssWidth / 2 - MAP_ORIGIN * view.zoom);
    view.panY = Math.round(view.cssHeight / 2 - MAP_ORIGIN * view.zoom);
    view.requestRender();
  };
  center();
  // The dedicated map host is mounted hidden and gets its real dimensions
  // after Maps mode makes it visible.
  requestAnimationFrame(center);
}

export function flatCanvas(sheet, project) {
  if (!sheet) return null;
  const cached = flatCache.get(sheet.id);
  if (cached?.width === sheet.width && cached?.height === sheet.height && cached.gen === project) return cached.canvas;
  const bmp = flattenSheet(sheet);
  const canvas = document.createElement('canvas'); canvas.width = bmp.width; canvas.height = bmp.height;
  canvas.getContext('2d').putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
  flatCache.set(sheet.id, { canvas, width: sheet.width, height: sheet.height, gen: project });
  return canvas;
}

export function clearMapRasterCache() { flatCache.clear(); }
export function isMapPlaying() { return playing; }
export function toggleMapPlayback(onChange) {
  playing = !playing;
  if (playing) playStarted = performance.now();
  onChange?.();
}

function animationFrame(sheet, anim) {
  if (!anim?.frames?.length) return null;
  const elapsed = playing ? performance.now() - playStarted : 0;
  let cursor = anim.frames[0]; let t = elapsed;
  const total = anim.frames.reduce((sum, f) => sum + effectiveDuration(anim, f), 0);
  if (anim.loop && total) t %= total;
  for (const f of anim.frames) { cursor = f; const d = effectiveDuration(anim, f); if (t < d) break; t -= d; }
  return sheet.frames.find(f => f.id === cursor.frameId) ?? null;
}

function drawSource(ctx, project, sheetId, rect, x, y, alpha = 1, transform = null, offsetX = MAP_ORIGIN, offsetY = MAP_ORIGIN) {
  const canvas = flatCanvas(findSheet(project, sheetId), project); if (!canvas || !rect) return;
  ctx.save(); ctx.globalAlpha *= alpha;
  if (transform && (transform.flipH || transform.flipV || transform.rotate)) {
    ctx.translate(x + offsetX + rect.w / 2, y + offsetY + rect.h / 2);
    // Blob descriptors are rotate-then-flip. Canvas transforms are applied
    // in reverse call order, so scale is intentionally installed first.
    ctx.scale(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);
    ctx.rotate((transform.rotate || 0) * Math.PI / 180);
    ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, -rect.w / 2, -rect.h / 2, rect.w, rect.h);
  } else ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, x + offsetX, y + offsetY, rect.w, rect.h);
  ctx.restore();
}

function drawTerrain(ctx, project, layer, entry, offsetX, offsetY) {
  const sheet = findSheet(project, entry.sheetId), terrain = sheet?.terrainSets?.find(t => t.id === entry.terrainSetId); if (!sheet || !terrain) return;
  const resolved = terrainResolution(layer, sheet, terrain, entry.x, entry.y);
  if (resolved) drawSource(ctx, project, sheet.id, resolved.tile, entry.x, entry.y, 1, resolved, offsetX, offsetY);
}

function drawSprite(ctx, project, entry, offsetX, offsetY) {
  const sheet = findSheet(project, entry.sheetId); if (!sheet) return;
  const source = entry.kind === 'animation' ? animationFrame(sheet, sheet.animations.find(a => a.id === entry.assetId)) : sheet.frames.find(f => f.id === entry.assetId);
  if (source) drawSource(ctx, project, sheet.id, source, entry.x, entry.y, 1, null, offsetX, offsetY);
}

function drawMapLayers(ctx, project, map, offsetX = MAP_ORIGIN, offsetY = MAP_ORIGIN) {
  for (const layer of map.layers) {
    if (!layer.visible) continue;
    ctx.save(); ctx.globalAlpha = layer.opacity ?? 1;
    if (layer.type === 'tile') {
      layer.tiles.forEach(entry => { const sheet = findSheet(project, entry.sheetId); drawSource(ctx, project, entry.sheetId, sheet?.tiles?.find(tile => tile.id === entry.tileId), entry.x, entry.y, 1, null, offsetX, offsetY); });
      layer.terrain.forEach(entry => drawTerrain(ctx, project, layer, entry, offsetX, offsetY));
    } else layer.sprites.forEach(entry => drawSprite(ctx, project, entry, offsetX, offsetY));
    ctx.restore();
  }
}

export function paintMap(ctx, project, map, onPlaybackFrame) {
  // CanvasView content is the 0..MAP_SPAN workspace; map records themselves
  // remain centred around (0, 0), translated by MAP_ORIGIN at render time.
  ctx.fillStyle = '#202128'; ctx.fillRect(0, 0, MAP_ORIGIN * 2, MAP_ORIGIN * 2);
  if (!map) return;
  refreshMapBounds(project, map);
  drawMapLayers(ctx, project, map);
  if (playing) requestAnimationFrame(() => onPlaybackFrame?.());
}

export function renderMapPreviewBitmap(project, map) {
  if (!map) return null;
  const bounds = refreshMapBounds(project, map) ?? DEFAULT_MAP_BOUNDS;
  // Keep pathological/imported maps from allocating an enormous preview
  // bitmap. The whole bounds still render; only the preview raster is scaled.
  const scale = Math.min(1, 2048 / Math.max(1, bounds.w), 2048 / Math.max(1, bounds.h));
  const width = Math.max(1, Math.ceil(bounds.w * scale)), height = Math.max(1, Math.ceil(bounds.h * scale));
  if (!mapPreviewCanvas) mapPreviewCanvas = document.createElement('canvas');
  mapPreviewCanvas.width = width; mapPreviewCanvas.height = height;
  const ctx = mapPreviewCanvas.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, width, height);
  ctx.scale(scale, scale);
  drawMapLayers(ctx, project, map, -bounds.x, -bounds.y);
  const image = ctx.getImageData(0, 0, width, height);
  return { width, height, data: new Uint8ClampedArray(image.data) };
}

function brushPreview(map, project, tool, p) {
  if (tool === 'maptile') {
    if (asset.tileKind === 'terrain') {
      const { sheet, terrain } = selectedTerrain(project, asset); if (!sheet || !terrain) return null;
      const at = snap(map, p, terrain), active = map.layers.find(l => l.id === asset.__activeLayerId);
      const layer = active?.type === 'tile' && !active.locked ? active : map.layers.find(candidate => candidate.type === 'tile' && !candidate.locked);
      const resolved = terrainResolution(layer, sheet, terrain, at.x, at.y);
      return resolved
        ? { sheet, rect: resolved.tile, transform: resolved, x: at.x, y: at.y }
        : { sheet, rect: null, missing: true, w: terrain.tileW, h: terrain.tileH, x: at.x, y: at.y };
    }
    const { sheet, tile } = selectedTile(project, asset); if (!sheet || !tile) return null; const at = snap(map, p, tile); return { sheet, rect: tile, x: at.x, y: at.y };
  }
  if (tool === 'mapsprite') { const { sheet, item } = selectedSprite(project, asset); if (!sheet || !item) return null; const rect = asset.spriteKind === 'animation' ? sheet.frames.find(f => f.id === item.frames?.[0]?.frameId) : item; if (!rect) return null; const at = snap(map, p, rect); return { sheet, rect, x: at.x, y: at.y }; }
  return null;
}

export function drawMapOverlay(view, ctx, project, map, { tool, hover, selectedItemId, activeLayerId }) {
  if (!map) return;
  const bounds = map.bounds ?? DEFAULT_MAP_BOUNDS;
  const bp = view.imageToScreen(bounds.x + MAP_ORIGIN, bounds.y + MAP_ORIGIN);
  ctx.save(); ctx.strokeStyle = '#7583a8'; ctx.lineWidth = 2; ctx.strokeRect(bp.x, bp.y, bounds.w * view.zoom, bounds.h * view.zoom); ctx.restore();
  if (map.snap.mode !== 'off' && view.zoom >= 2) {
    const w = map.snap.gridW, h = map.snap.gridH; ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 1;
    const left = Math.floor((-view.panX / view.zoom - MAP_ORIGIN) / w) * w, top = Math.floor((-view.panY / view.zoom - MAP_ORIGIN) / h) * h;
    const right = Math.ceil(((view.cssWidth - view.panX) / view.zoom - MAP_ORIGIN) / w) * w, bottom = Math.ceil(((view.cssHeight - view.panY) / view.zoom - MAP_ORIGIN) / h) * h;
    const startX = Math.ceil(Math.max(left, bounds.x) / w) * w, endX = Math.min(right, bounds.x + bounds.w);
    const startY = Math.ceil(Math.max(top, bounds.y) / h) * h, endY = Math.min(bottom, bounds.y + bounds.h);
    for (let x = startX; x <= endX; x += w) { const p = view.imageToScreen(x + MAP_ORIGIN, bounds.y + MAP_ORIGIN), q = view.imageToScreen(x + MAP_ORIGIN, bounds.y + bounds.h + MAP_ORIGIN); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
    for (let y = startY; y <= endY; y += h) { const p = view.imageToScreen(bounds.x + MAP_ORIGIN, y + MAP_ORIGIN), q = view.imageToScreen(bounds.x + bounds.w + MAP_ORIGIN, y + MAP_ORIGIN); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
    ctx.restore();
  }
  if (hover && (tool === 'maptile' || tool === 'mapsprite')) {
    asset.__activeLayerId = activeLayerId;
    const preview = brushPreview(map, project, tool, hover);
    if (preview) {
      const source = flatCanvas(preview.sheet, project), screen = view.imageToScreen(preview.x + MAP_ORIGIN, preview.y + MAP_ORIGIN);
      const width = preview.rect?.w ?? preview.w, height = preview.rect?.h ?? preview.h;
      ctx.save(); ctx.imageSmoothingEnabled = false;
      if (source && preview.rect) {
        ctx.globalAlpha = .55;
        if (preview.transform && (preview.transform.flipH || preview.transform.flipV || preview.transform.rotate)) {
          ctx.save();
          ctx.translate(screen.x + width * view.zoom / 2, screen.y + height * view.zoom / 2);
          ctx.scale(preview.transform.flipH ? -1 : 1, preview.transform.flipV ? -1 : 1);
          ctx.rotate((preview.transform.rotate || 0) * Math.PI / 180);
          ctx.drawImage(source, preview.rect.x, preview.rect.y, width, height, -width * view.zoom / 2, -height * view.zoom / 2, width * view.zoom, height * view.zoom);
          ctx.restore();
        } else ctx.drawImage(source, preview.rect.x, preview.rect.y, width, height, screen.x, screen.y, width * view.zoom, height * view.zoom);
      }
      ctx.globalAlpha = 1; ctx.strokeStyle = preview.missing ? '#ff6b6b' : '#65c8ff'; ctx.lineWidth = 2;
      if (preview.missing) ctx.setLineDash([5, 4]);
      ctx.strokeRect(screen.x, screen.y, width * view.zoom, height * view.zoom);
      if (preview.missing) { ctx.setLineDash([]); ctx.fillStyle = '#ffb0b0'; ctx.font = '12px sans-serif'; ctx.fillText('Missing autotile', screen.x + 4, screen.y + 14); }
      ctx.restore();
    }
  }
  if (selectedItemId) {
    const layer = map.layers.find(l => [...(l.tiles ?? []), ...(l.terrain ?? []), ...(l.sprites ?? [])].some(item => item.id === selectedItemId));
    const item = [...(layer?.tiles ?? []), ...(layer?.terrain ?? []), ...(layer?.sprites ?? [])].find(item => item.id === selectedItemId);
    if (item) {
      const p = view.imageToScreen(item.x + MAP_ORIGIN, item.y + MAP_ORIGIN), size = itemSize(project, item);
      ctx.strokeStyle = '#65c8ff'; ctx.lineWidth = 2; ctx.strokeRect(p.x, p.y, size.w * view.zoom, size.h * view.zoom);
    }
  }
}
```

Note: `brushPreview`'s terrain branch needs to know the currently active layer to prefer a compatible one; rather than threading yet another parameter through `drawMapOverlay`'s public signature for an internal-only concern, it's stashed on `asset.__activeLayerId` immediately before the call (same object Task 6's Presenter already updates every frame). This mirrors the original file's own reliance on a single shared mutable `asset`.

- [ ] **Step 2: Commit**

```bash
git add js/modes/maps/presentation/map-renderer.js
git commit -m "feat(maps): add presentation-layer Canvas renderer"
```

---

### Task 6: Presenter (`presentation/map-tool-presenter.js`)

**Files:**
- Create: `js/modes/maps/presentation/map-tool-presenter.js`

**Interfaces:**
- Consumes: Task 1's geometry functions; Task 2's `mapBrushState`; `js/host/runtime.js`'s `getEditorHost`; `js/ui/tools.js`'s `registerTool`. Dispatches Task 3/4's Command Handlers **by id**, via `getEditorHost().registries.commands.execute(id, context, args)` (`js/host/contributions/commands.js`'s `CommandRegistry`, already wired into `EditorHost` as the public `registries.commands` property since Phase 0, but not yet used by any mode) — Task 8's `contributions.js` is what actually imports and registers the Task 3/4 functions under these ids, since `contributions.js` lives outside `presentation/` and isn't subject to the "presentation dispatches by id only" ban. This Presenter file itself has **zero imports from `application/commands/**`**, satisfying `tests/architecture.test.mjs`'s existing rule.
- Produces: `registerMapTool()`, `bindMapMode(view)`. Also produces the exact command-id contract Task 8 must register against: `maps.paintTile({mapId, layerId, sheetId, tileId, at})`, `maps.eraseTile({mapId, layerId, at})`, `maps.paintTerrain({mapId, layerId, sheetId, terrainSetId, at})`, `maps.eraseTerrain({mapId, layerId, sheetId, terrainSetId, at})`, `maps.paintSprite({mapId, layerId, sheetId, kind, assetId, at})`, `maps.eraseSprite({mapId, layerId, itemId})`, `maps.moveItem({mapId, layerId, itemId, before, after})`, `maps.deleteItem({mapId, layerId, itemId})` — each called as `getEditorHost().registries.commands.execute('maps.paintTile', { modeId: state.mode }, { mapId, layerId, sheetId, tileId, at })`, i.e. the `args` shape is a single named-fields object matching the Command Handler's positional parameters in order (minus `services`, which the registrant in Task 8 supplies itself).

Selection (`layerId`, `mapItemId`) now reads/writes exclusively through `getEditorHost().selections`, keyed by `{ kind: 'map', id: map.id }` — no more `state.activeMapLayerId`/`state.selectedMapItemId`.

- [ ] **Step 1: Write the implementation** (pointer/keyboard wiring — verified manually, matching project convention for drag interactions; no automated test)

```js
// js/modes/maps/presentation/map-tool-presenter.js
import { state, emit, activeMap, markDirty } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { registerTool } from '../../../ui/tools.js';
import {
  mapXY, snap, selectedTile, selectedTerrain, selectedSprite, itemSize,
  hitMapItem, brushSpacing, strokeSamples, claimStrokeCell,
} from '../application/map-geometry.js';
import { mapBrushState as asset } from '../application/map-brush-state.js';

let drag = null, brushStroke = null;

function mapDocument(map) { return { kind: 'map', id: map.id }; }
function currentSelection(map) { return getEditorHost().selections.get(mapDocument(map)) ?? {}; }
function setLayer(map, layerId) { getEditorHost().selections.set({ ...currentSelection(map), layerId }, mapDocument(map)); }
function setItem(map, mapItemId) { getEditorHost().selections.set({ ...currentSelection(map), mapItemId }, mapDocument(map)); }

function drawingLayer(map, type) {
  const activeId = currentSelection(map).layerId;
  const active = map?.layers.find(l => l.id === activeId) ?? null;
  if (active?.type === type && !active.locked) return active;
  const compatible = map?.layers.find(layer => layer.type === type && !layer.locked) ?? null;
  if (compatible && activeId !== compatible.id) setLayer(map, compatible.id);
  return compatible;
}

export function registerMapTool() {
  const onlyMaps = () => state.mode === 'maps';
  registerTool({ id: 'maptile', label: 'Tile brush', icon: '🧱', key: 't', isAvailable: onlyMaps });
  registerTool({ id: 'mapsprite', label: 'Sprite brush', icon: '👾', key: 'p', isAvailable: onlyMaps });
}

// Dispatches a Task 3/4 Command Handler by id (registered in contributions.js,
// Task 8) rather than importing it directly — this Presenter lives under
// presentation/, and tests/architecture.test.mjs bans presentation-layer code
// from importing anything under application/commands/.
function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }

function applyMapBrush(map, project, p, button, stroke) {
  const erase = button === 2;
  if (state.tool === 'maptile') {
    const layer = drawingLayer(map, 'tile'); if (!layer) return;
    if (asset.tileKind === 'terrain') {
      const { sheet, terrain } = selectedTerrain(project, asset); if (!sheet || !terrain) return;
      const at = snap(map, p, terrain), key = `terrain:${erase ? 'erase' : terrain.id}:${at.x}:${at.y}`;
      if (!claimStrokeCell(stroke, key)) return;
      if (erase) dispatch('maps.eraseTerrain', { mapId: map.id, layerId: layer.id, sheetId: sheet.id, terrainSetId: terrain.id, at });
      else dispatch('maps.paintTerrain', { mapId: map.id, layerId: layer.id, sheetId: sheet.id, terrainSetId: terrain.id, at });
      return;
    }
    const { sheet, tile } = selectedTile(project, asset); if (!sheet || !tile) return;
    const at = snap(map, p, tile), key = `tile:${erase ? 'erase' : tile.id}:${at.x}:${at.y}`;
    if (!claimStrokeCell(stroke, key)) return;
    if (erase) dispatch('maps.eraseTile', { mapId: map.id, layerId: layer.id, at });
    else dispatch('maps.paintTile', { mapId: map.id, layerId: layer.id, sheetId: sheet.id, tileId: tile.id, at });
    return;
  }
  if (state.tool === 'mapsprite') {
    const layer = drawingLayer(map, 'sprite'); if (!layer) return;
    if (erase) {
      const hit = hitMapItem(project, layer, p), key = hit ? `sprite:erase:${hit.id}` : `sprite:empty:${Math.floor(p.x)}:${Math.floor(p.y)}`;
      if (!claimStrokeCell(stroke, key)) return;
      if (hit) dispatch('maps.eraseSprite', { mapId: map.id, layerId: layer.id, itemId: hit.id });
      return;
    }
    const { sheet, item, size } = selectedSprite(project, asset); if (!sheet || !item) return;
    const at = snap(map, p, size), key = `sprite:${item.id}:${at.x}:${at.y}`;
    if (!claimStrokeCell(stroke, key)) return;
    dispatch('maps.paintSprite', { mapId: map.id, layerId: layer.id, sheetId: sheet.id, kind: asset.spriteKind, assetId: item.id, at });
  }
}

export function bindMapMode(view) {
  const priorPointer = view.onPointer;
  view.onPointer = ev => {
    if (state.mode !== 'maps') return priorPointer(ev);
    const map = activeMap(), project = state.project; if (!map) return;
    const selection = currentSelection(map);
    const activeLayer = map.layers.find(l => l.id === selection.layerId) ?? null;
    const p = mapXY(ev);
    const brushTool = state.tool === 'maptile' || state.tool === 'mapsprite';
    if (ev.type === 'down') {
      if (brushTool) {
        const button = ev.buttons & 2 ? 2 : ev.buttons & 1 ? 1 : 0; if (!button) return;
        brushStroke = { tool: state.tool, button, visited: new Set(), lastPoint: p };
        applyMapBrush(map, project, p, button, brushStroke); view.requestRender(); return;
      }
      if (!activeLayer) return;
      if (state.tool === 'select') { setItem(map, hitMapItem(project, activeLayer, p)?.id ?? null); emit('selection'); return; }
      if (state.tool === 'move') {
        const item = hitMapItem(project, activeLayer, p);
        setItem(map, item?.id ?? null);
        drag = item && !activeLayer.locked ? { item, before: { x: item.x, y: item.y }, size: itemSize(project, item) } : null;
        emit('selection'); return;
      }
    }
    if (ev.type === 'move' && brushTool) {
      if (brushStroke && brushStroke.tool === state.tool && (ev.buttons & brushStroke.button)) {
        const spacing = brushSpacing(map, state.tool, asset, project);
        for (const sample of strokeSamples(map, brushStroke.lastPoint, p, spacing)) applyMapBrush(map, project, sample, brushStroke.button, brushStroke);
        brushStroke.lastPoint = p;
      } else if (brushStroke) brushStroke = null;
      view.requestRender(); return;
    }
    if (ev.type === 'up' && brushTool) { brushStroke = null; view.requestRender(); return; }
    if (!activeLayer) return;
    if (ev.type === 'move' && drag) { const at = snap(map, p, drag.size); drag.item.x = at.x; drag.item.y = at.y; emit('view'); }
    if (ev.type === 'move' && !drag) { view.requestRender(); }
    if (ev.type === 'up' && drag) {
      const { item, before } = drag, after = { x: item.x, y: item.y }; drag = null;
      if (before.x !== after.x || before.y !== after.y) dispatch('maps.moveItem', { mapId: map.id, layerId: activeLayer.id, itemId: item.id, before, after });
    }
  };
  document.addEventListener('keydown', e => {
    if (state.mode !== 'maps' || e.key !== 'Delete') return;
    const map = activeMap(); if (!map) return;
    const selection = currentSelection(map);
    if (!selection.mapItemId) return;
    const layer = map.layers.find(l => [...(l.tiles ?? []), ...(l.terrain ?? []), ...(l.sprites ?? [])].some(x => x.id === selection.mapItemId));
    if (!layer) return;
    dispatch('maps.deleteItem', { mapId: map.id, layerId: layer.id, itemId: selection.mapItemId });
    setItem(map, null);
    emit('selection');
  });
}
```

Note: `addMapLayer` is no longer imported/re-exported from this file — nothing in the original file's `bindMapMode`/`applyMapBrush` actually called it (Task 4's layer commands are only ever invoked from `js/ui/panels.js`, which lives outside `presentation/` and imports `addMapLayer`/`deleteMapLayer` directly from `application/commands/map-layer-commands.js` in Task 9 — that import is architecturally fine there since the "dispatch by id" ban only scopes to `presentation/**`). The original `export { addMapLayer };` was dead re-export; dropping it is not a behavior change.

Behavior note: the original `bindMapMode`'s drag-move path called `refreshBounds(map)` on every pointer-move frame in addition to the final commit; `moveMapItem`'s command already calls `refreshMapBounds` inside `runCommand`, and the live-drag-in-progress visual doesn't need bounds refreshed mid-drag (the overlay just follows `item.x/y` directly) — dropped as dead work, not a behavior change users can observe.

- [ ] **Step 2: Commit**

```bash
git add js/modes/maps/presentation/map-tool-presenter.js
git commit -m "feat(maps): add Presenter routing pointer input through SelectionService and Command Handlers"
```

---

### Task 7: Panels (`presentation/map-panel.js`, `presentation/map-assets-panel.js`)

**Files:**
- Create: `js/modes/maps/presentation/map-panel.js` (renamed from `map-panels.js`'s `mountMapPanel`)
- Create: `js/modes/maps/presentation/map-assets-panel.js` (renamed from `map-panels.js`'s `mountMapAssetsPanel`)

**Interfaces:**
- Consumes: Task 5's `flatCanvas`, `clearMapRasterCache`, `isMapPlaying`, `toggleMapPlayback`; Task 2's `mapBrushState`; `js/host/runtime.js`'s `getEditorHost`.
- Produces: `mountMapPanel(container)`, `mountMapAssetsPanel(container)` — same exported names/signatures as today, registered the same way in `contributions.js` (Task 8).

- [ ] **Step 1: Write the implementation**

```js
// js/modes/maps/presentation/map-panel.js
import { state, on, emit, activeMap, markDirty } from '../../../app/state.js';
import {
  clearMapRasterCache, isMapPlaying, toggleMapPlayback,
} from './map-renderer.js';

export function mountMapPanel(container) {
  const render = () => {
    if (state.mode !== 'maps') { container.hidden = true; return; }
    container.hidden = false;
    const map = activeMap();
    container.innerHTML = '<h3>Map</h3>';
    if (!map) { container.append('Create or select a map in the top bar.'); return; }
    const row = document.createElement('div'); row.className = 'row';
    const play = document.createElement('button'); play.className = 'btn-sm';
    play.textContent = isMapPlaying() ? 'Pause' : 'Play';
    play.onclick = () => toggleMapPlayback(() => emit('view'));
    row.append(play); container.append(row);
    const snapRow = document.createElement('div'); snapRow.className = 'row'; snapRow.innerHTML = 'Snap ';
    const select = document.createElement('select');
    for (const value of ['off', 'map', 'asset']) {
      const option = document.createElement('option'); option.value = value;
      option.textContent = value === 'off' ? 'Off' : value === 'map' ? 'Map grid' : 'Asset grid';
      select.append(option);
    }
    select.value = map.snap.mode;
    select.onchange = () => { map.snap.mode = select.value; markDirty(); };
    snapRow.append(select);
    for (const key of ['gridW', 'gridH']) {
      const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.value = map.snap[key];
      input.onchange = () => { map.snap[key] = Math.max(1, +input.value || 1); markDirty(); emit('view'); };
      snapRow.append(input);
    }
    container.append(snapRow);
  };
  on('view', render);
  on('project', () => { clearMapRasterCache(); render(); });
  on('selection', render);
  render();
}
```

```js
// js/modes/maps/presentation/map-assets-panel.js
import { state, on, activeMap } from '../../../app/state.js';
import { flatCanvas } from './map-renderer.js';
import { getEditorHost } from '../../../host/runtime.js';
import { mapBrushState as asset } from '../application/map-brush-state.js';

export function mountMapAssetsPanel(container) {
  const addSelect = (label, items, value, set, fmt = item => item.name) => {
    const row = document.createElement('label'); row.className = 'map-brush-source'; row.textContent = `${label} `;
    const select = document.createElement('select');
    for (const item of items) { const option = document.createElement('option'); option.value = item.id; option.textContent = fmt(item); select.append(option); }
    select.value = value; select.onchange = () => { set(select.value); render(); }; row.append(select); container.append(row);
  };
  const addSwatch = (grid, { selected, title, sourceSheet, rect, choose }) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `map-brush-swatch${selected ? ' active' : ''}`; button.title = title; button.setAttribute('aria-label', title);
    const canvas = document.createElement('canvas'); const scale = Math.max(1, Math.floor(56 / Math.max(rect.w, rect.h))); canvas.width = Math.max(1, rect.w * scale); canvas.height = Math.max(1, rect.h * scale); canvas.className = 'map-brush-thumb';
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false; const source = flatCanvas(sourceSheet, state.project); if (source) ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
    const label = document.createElement('span'); label.textContent = title; button.append(canvas, label); button.onclick = () => { choose(); render(); }; grid.append(button);
  };
  const addBrushGrid = () => { const grid = document.createElement('div'); grid.className = 'map-brush-grid'; container.append(grid); return grid; };
  const activeLayerId = () => (getEditorHost().selections.get({ kind: 'map', id: activeMap()?.id }) ?? {}).layerId;
  const render = () => {
    if (state.mode !== 'maps') { container.hidden = true; return; }
    container.hidden = false; container.innerHTML = '<h3>Brushes</h3>';
    const map = activeMap(), layer = map?.layers.find(l => l.id === activeLayerId());
    if (!map || !layer) { container.append('Create a map first.'); return; }
    const tiles = state.project.sheets.filter(candidate => candidate.kind === 'tile');
    const sprites = state.project.sheets.filter(candidate => candidate.kind === 'sprite');
    if (state.tool === 'maptile') {
      const kindRow = document.createElement('div'); kindRow.className = 'map-brush-kind';
      for (const [value, label] of [['tile', 'Tiles'], ['terrain', 'Autotiles']]) { const button = document.createElement('button'); button.type = 'button'; button.className = `btn-sm${asset.tileKind === value ? ' active' : ''}`; button.textContent = label; button.onclick = () => { asset.tileKind = value; render(); }; kindRow.append(button); }
      container.append(kindRow);
      if (asset.tileKind === 'tile') {
        addSelect('Sheet', tiles, asset.tileSheetId, value => { asset.tileSheetId = value; });
        const sourceSheet = tiles.find(s => s.id === asset.tileSheetId) || tiles[0];
        if (sourceSheet) { asset.tileSheetId = sourceSheet.id; if (!sourceSheet.tiles.some(tile => tile.id === asset.tileId)) asset.tileId = sourceSheet.tiles[0]?.id ?? ''; const grid = addBrushGrid(); for (const tile of sourceSheet.tiles) addSwatch(grid, { selected: asset.tileId === tile.id, title: tile.name ?? `Tile ${sourceSheet.tiles.indexOf(tile) + 1}`, sourceSheet, rect: tile, choose: () => { asset.tileId = tile.id; } }); }
      } else {
        addSelect('Sheet', tiles, asset.terrainSheetId, value => { asset.terrainSheetId = value; });
        const sourceSheet = tiles.find(s => s.id === asset.terrainSheetId) || tiles[0];
        if (sourceSheet) { asset.terrainSheetId = sourceSheet.id; if (!sourceSheet.terrainSets.some(terrain => terrain.id === asset.terrainSetId)) asset.terrainSetId = sourceSheet.terrainSets[0]?.id ?? ''; const grid = addBrushGrid(); for (const terrain of sourceSheet.terrainSets) { const tileId = Object.values(terrain.slots ?? {}).find(Boolean), tile = tileId && sourceSheet.tiles.find(candidate => candidate.id === tileId); if (tile) addSwatch(grid, { selected: asset.terrainSetId === terrain.id, title: terrain.name ?? 'Autotile set', sourceSheet, rect: tile, choose: () => { asset.terrainSetId = terrain.id; } }); } if (!grid.children.length) grid.textContent = 'This sheet has no painted autotile brushes yet.'; }
      }
    } else if (state.tool === 'mapsprite') {
      addSelect('Sheet', sprites, asset.spriteSheetId, value => { asset.spriteSheetId = value; });
      const sourceSheet = sprites.find(s => s.id === asset.spriteSheetId) || sprites[0];
      if (sourceSheet) { asset.spriteSheetId = sourceSheet.id; const kindRow = document.createElement('div'); kindRow.className = 'map-brush-kind'; for (const [value, label] of [['frame', 'Frames'], ['animation', 'Animations']]) { const button = document.createElement('button'); button.type = 'button'; button.className = `btn-sm${asset.spriteKind === value ? ' active' : ''}`; button.textContent = label; button.onclick = () => { asset.spriteKind = value; asset.spriteId = ''; render(); }; kindRow.append(button); } container.append(kindRow); const grid = addBrushGrid(); const items = asset.spriteKind === 'frame' ? sourceSheet.frames : sourceSheet.animations; if (!items.some(item => item.id === asset.spriteId)) asset.spriteId = items[0]?.id ?? ''; for (const item of items) { const frame = asset.spriteKind === 'animation' ? sourceSheet.frames.find(candidate => candidate.id === item.frames?.[0]?.frameId) : item; if (frame) addSwatch(grid, { selected: asset.spriteId === item.id, title: item.name ?? (asset.spriteKind === 'frame' ? `Frame ${sourceSheet.frames.indexOf(item) + 1}` : 'Animation'), sourceSheet, rect: frame, choose: () => { asset.spriteId = item.id; } }); } }
    } else container.append('Select or move placed items on the active layer.');
  };
  on('view', render); on('project', render); on('tool', render); render();
}
```

- [ ] **Step 2: Commit**

```bash
git add js/modes/maps/presentation/map-panel.js js/modes/maps/presentation/map-assets-panel.js
git commit -m "feat(maps): move panels into presentation layer, read active layer via SelectionService"
```

---

### Task 8: Wire contributions, delete old files

**Files:**
- Modify: `js/modes/maps/contributions.js`
- Modify: `js/modes/maps/preview.js`
- Modify: `js/modes/maps/index.js` (no change expected — confirm after Task's edits)
- Delete: `js/modes/maps/map-editor.js`, `js/modes/maps/map-panels.js`

**Interfaces:**
- Consumes: Task 5 (`focusMapCanvas`, `paintMap`, `drawMapOverlay`, `renderMapPreviewBitmap`, `isMapPlaying`), Task 6 (`registerMapTool`, `bindMapMode`, and the command-id contract it dispatches against), Task 7 (`mountMapPanel`, `mountMapAssetsPanel`), Task 3's 8 Command Handler functions from `application/commands/map-paint-commands.js` (imported here, NOT in `presentation/`, so this is architecturally allowed — see Task 6's note).
- Produces: same public contribution ids as today — `maps.preview`, `maps.placement-tools`, `maps.properties`, `maps.assets`, `maps.canvas` — required by `tests/builtinmodes.test.mjs`, which must keep passing unchanged. Also newly produces 8 `EditorHost` Command contributions (`maps.paintTile`, `maps.eraseTile`, `maps.paintTerrain`, `maps.eraseTerrain`, `maps.paintSprite`, `maps.eraseSprite`, `maps.moveItem`, `maps.deleteItem`) matching the exact id/args contract Task 6's Presenter dispatches against — this is what makes Task 6's `dispatch(id, args)` calls actually do something.

The current `contributions.js` (verified by reading the file directly, not from memory) is:

```js
import {
  registerMapTool, bindMapMode, paintMap, drawMapOverlay,
  focusMapCanvas,
} from './map-editor.js';
import { mountMapPanel, mountMapAssetsPanel } from './map-panels.js';
import { renderMapPreview } from './preview.js';

export function registerMapContributions(api) {
  api.previews.register({ id: 'maps.preview', order: 30, when: keys => keys.modeId === 'maps', render: renderMapPreview });
  api.tools.register({
    id: 'maps.placement-tools', label: 'Map placement tools', order: 30,
    createController({ mapCanvasView }) {
      registerMapTool();
      bindMapMode(mapCanvasView);
      return {};
    },
  });

  const whenMaps = keys => keys.modeId === 'maps';
  api.panels.register({ id: 'maps.properties', title: 'Map', region: 'right', order: 60, mountPoint: 'panel-context', persistent: true, when: whenMaps, create: mountMapPanel });
  api.panels.register({ id: 'maps.assets', title: 'Map Assets', region: 'right', order: 70, mountPoint: 'panel-map-assets', persistent: true, when: whenMaps, create: mountMapAssetsPanel });

  api.views.register({
    id: 'maps.canvas', order: 50,
    create(_host, { mapCanvasView }) {
      mapCanvasView.onPaint = paintMap;
      mapCanvasView.onOverlay = ctx => drawMapOverlay(mapCanvasView, ctx);
      mapCanvasView.canvas.addEventListener('contextmenu', event => event.preventDefault());
      return { view: mapCanvasView, focus: () => focusMapCanvas(mapCanvasView) };
    },
  });
}
```

Key facts this reveals that the earlier draft got wrong: maps uses its own dedicated `mapCanvasView` (from `contributionContext`, set up in `js/features/workbench/editor-workbench.js`), not the shared `canvasView` sprites/tiles use — so there is no `decorateOverlay`/"chain onto prior overlay" pattern here, `onPaint`/`onOverlay` are simple direct assignments. The tools contribution's `createController` receives `{ mapCanvasView }` and does nothing with overlays at all (returns `{}}`); all Canvas wiring lives in the `maps.canvas` view's `create`. The view's `create` returns `{ view, focus }` — `focus` is used by `workbench.focusMap()` (called from `document-controller.js`'s mode-switch/map-switch handlers) to re-center the canvas. There's also a `contextmenu` `preventDefault()` needed so right-click-drag erase doesn't pop the browser menu, and panel registration uses `order: 60`/`70` and title `'Map Assets'` (not `'Brushes'`) — both preserved exactly below since nothing in this plan calls for changing them.

`paintMap`/`drawMapOverlay` (Task 5) take explicit `project`/`map`/options parameters for testability/purity, so `CanvasView`'s single-`ctx`-argument `onPaint`/`onOverlay` callbacks need a thin wrapping arrow function supplying the rest. Since hover tracking (`hover = p` on pointer move) lived inside `bindMapMode` in the old file, `map-tool-presenter.js` needs to also track and expose the current hover point for the overlay to read — add this now.

- [ ] **Step 1: Add hover tracking to the Presenter**

Edit `js/modes/maps/presentation/map-tool-presenter.js`: add a module-level `let hover = null;` alongside `drag`/`brushStroke`, set `hover = p` in the `down`, brush `move`, non-drag `move`, and `up` branches (mirroring the original file's assignments at the equivalent points), and export a `mapHoverPoint()` getter:

```js
// near the top, alongside `let drag = null, brushStroke = null;`
let hover = null;
export function mapHoverPoint() { return hover; }
```

Then in `bindMapMode`'s `view.onPointer`, add `hover = p;` at the start of the `if (ev.type === 'down')` block (right after computing `p`), inside the brush `move` branch (`if (ev.type === 'move' && brushTool) { hover = p; ...`), inside the non-drag `move` branch (`if (ev.type === 'move' && !drag) { hover = p; view.requestRender(); }`), and inside `if (ev.type === 'up' && brushTool) { brushStroke = null; hover = p; view.requestRender(); return; }`.

- [ ] **Step 2: Rewrite contributions.js**

```js
// js/modes/maps/contributions.js
import { state, activeMap } from '../../app/state.js';
import { registerMapTool, bindMapMode, mapHoverPoint } from './presentation/map-tool-presenter.js';
import { paintMap, drawMapOverlay, focusMapCanvas } from './presentation/map-renderer.js';
import { mountMapPanel } from './presentation/map-panel.js';
import { mountMapAssetsPanel } from './presentation/map-assets-panel.js';
import { renderMapPreview } from './preview.js';
import { getEditorHost } from '../../host/runtime.js';
import {
  paintMapTile, eraseMapTile, paintMapTerrain, eraseMapTerrain, paintMapSprite, eraseMapSprite,
  moveMapItem, deleteMapItem,
} from './application/commands/map-paint-commands.js';

function services() { const host = getEditorHost(); return { projects: host.projects, history: host.history }; }

// Registered by id so map-tool-presenter.js (presentation/) can dispatch
// through getEditorHost().registries.commands.execute(id, context, args)
// instead of importing these Command Handlers directly — this file lives
// outside presentation/, so importing application/commands/ here is fine;
// tests/architecture.test.mjs only bans that import from presentation/**.
function registerMapCommands(api) {
  const whenMaps = keys => keys.modeId === 'maps';
  api.commands.register({ id: 'maps.paintTile', when: whenMaps, execute: (_context, { mapId, layerId, sheetId, tileId, at }) => paintMapTile(services(), mapId, layerId, sheetId, tileId, at) });
  api.commands.register({ id: 'maps.eraseTile', when: whenMaps, execute: (_context, { mapId, layerId, at }) => eraseMapTile(services(), mapId, layerId, at) });
  api.commands.register({ id: 'maps.paintTerrain', when: whenMaps, execute: (_context, { mapId, layerId, sheetId, terrainSetId, at }) => paintMapTerrain(services(), mapId, layerId, sheetId, terrainSetId, at) });
  api.commands.register({ id: 'maps.eraseTerrain', when: whenMaps, execute: (_context, { mapId, layerId, sheetId, terrainSetId, at }) => eraseMapTerrain(services(), mapId, layerId, sheetId, terrainSetId, at) });
  api.commands.register({ id: 'maps.paintSprite', when: whenMaps, execute: (_context, { mapId, layerId, sheetId, kind, assetId, at }) => paintMapSprite(services(), mapId, layerId, sheetId, kind, assetId, at) });
  api.commands.register({ id: 'maps.eraseSprite', when: whenMaps, execute: (_context, { mapId, layerId, itemId }) => eraseMapSprite(services(), mapId, layerId, itemId) });
  api.commands.register({ id: 'maps.moveItem', when: whenMaps, execute: (_context, { mapId, layerId, itemId, before, after }) => moveMapItem(services(), mapId, layerId, itemId, before, after) });
  api.commands.register({ id: 'maps.deleteItem', when: whenMaps, execute: (_context, { mapId, layerId, itemId }) => deleteMapItem(services(), mapId, layerId, itemId) });
}

export function registerMapContributions(api) {
  registerMapCommands(api);

  api.previews.register({ id: 'maps.preview', order: 30, when: keys => keys.modeId === 'maps', render: renderMapPreview });

  api.tools.register({
    id: 'maps.placement-tools', label: 'Map placement tools', order: 30,
    createController({ mapCanvasView }) {
      registerMapTool();
      bindMapMode(mapCanvasView);
      return {};
    },
  });

  const whenMaps = keys => keys.modeId === 'maps';
  api.panels.register({ id: 'maps.properties', title: 'Map', region: 'right', order: 60, mountPoint: 'panel-context', persistent: true, when: whenMaps, create: mountMapPanel });
  api.panels.register({ id: 'maps.assets', title: 'Map Assets', region: 'right', order: 70, mountPoint: 'panel-map-assets', persistent: true, when: whenMaps, create: mountMapAssetsPanel });

  api.views.register({
    id: 'maps.canvas', order: 50,
    create(_host, { mapCanvasView }) {
      mapCanvasView.onPaint = ctx => paintMap(ctx, state.project, activeMap(), () => mapCanvasView.requestRender());
      mapCanvasView.onOverlay = ctx => {
        const map = activeMap(); if (!map) return;
        const selection = getEditorHost().selections.get({ kind: 'map', id: map.id }) ?? {};
        drawMapOverlay(mapCanvasView, ctx, state.project, map, {
          tool: state.tool, hover: mapHoverPoint(), selectedItemId: selection.mapItemId, activeLayerId: selection.layerId,
        });
      };
      mapCanvasView.canvas.addEventListener('contextmenu', event => event.preventDefault());
      return { view: mapCanvasView, focus: () => focusMapCanvas(mapCanvasView) };
    },
  });
}
```

This preserves every id, `order`, panel title, the `contextmenu` guard, and the `{ view, focus }` return contract from the current file exactly — only the imports and the internals of `onPaint`/`onOverlay` change, to call through the new renderer/presenter with explicit state instead of the old file's implicit legacy-global reads. The new `registerMapCommands` block is additive — it doesn't touch any of the 5 pre-existing contribution ids `tests/builtinmodes.test.mjs` asserts on.

- [ ] **Step 3: Update preview.js**

The current file (verified by reading it directly) is:

```js
import { state, activeMap } from '../../app/state.js';
import { renderMapPreviewBitmap } from './map-editor.js';

export function renderMapPreview() {
  const bitmap = renderMapPreviewBitmap();
  const map = activeMap();
  const bounds = map?.bounds;
  return {
    bitmap,
    exactFit: true,
    resetKey: `map:${state.activeMapId ?? ''}:${bounds ? `${bounds.x}:${bounds.y}:${bounds.w}:${bounds.h}` : ''}`,
  };
}
```

Only the import and the now-required `project`/`map` arguments to `renderMapPreviewBitmap` (Task 5 made it take explicit parameters instead of reading `activeMap()` internally) change — the `{bitmap, exactFit, resetKey}` return contract is preserved exactly, since `js/host/contributions/previews.js` depends on it:

```js
// js/modes/maps/preview.js
import { state, activeMap } from '../../app/state.js';
import { renderMapPreviewBitmap } from './presentation/map-renderer.js';

export function renderMapPreview() {
  const map = activeMap();
  const bitmap = renderMapPreviewBitmap(state.project, map);
  const bounds = map?.bounds;
  return {
    bitmap,
    exactFit: true,
    resetKey: `map:${state.activeMapId ?? ''}:${bounds ? `${bounds.x}:${bounds.y}:${bounds.w}:${bounds.h}` : ''}`,
  };
}
```

- [ ] **Step 4: Delete old files**

```bash
git rm js/modes/maps/map-editor.js js/modes/maps/map-panels.js
```

- [ ] **Step 5: Run the full suite and fix any import breakage**

Run: `npm test`
Expected: All tests pass, including `tests/builtinmodes.test.mjs`'s exact-id assertions and `tests/contributions.test.mjs`.

- [ ] **Step 6: Commit**

```bash
git add js/modes/maps/contributions.js js/modes/maps/preview.js js/modes/maps/presentation/map-tool-presenter.js
git commit -m "feat(maps): wire contributions to the new application/presentation split, remove old map-editor.js/map-panels.js"
```

---

### Task 9: `js/ui/panels.js` — redirect map-layer branches

**Files:**
- Modify: `js/ui/panels.js:432-437` (`doAddLayer`'s maps branch)
- Modify: `js/ui/panels.js:462-467` (`doAddGroup`'s maps branch)
- Modify: `js/ui/panels.js:492-500` (`doDelete`'s maps branch)
- Modify: `js/ui/panels.js:1010-1015` (`renderMapLayer`)

**Interfaces:**
- Consumes: Task 4's `addMapLayer`, `deleteMapLayer`; `js/host/runtime.js`'s `getEditorHost`.

Only the four `state.mode === 'maps'` branches change; every sprite/tile branch in this file is untouched.

- [ ] **Step 1: Add imports**

At the top of `js/ui/panels.js`, add:

```js
import { getEditorHost } from '../host/runtime.js';
import { addMapLayer, deleteMapLayer } from '../modes/maps/application/commands/map-layer-commands.js';
```

- [ ] **Step 2: Redirect `doAddLayer`'s maps branch**

Replace:

```js
    if (state.mode === 'maps') {
      const map = activeMap(); if (!map) return;
      const layer = createMapLayer(map, { type: 'tile' });
      state.activeMapLayerId = layer.id; markDirty(); emit('view'); return;
    }
```

with:

```js
    if (state.mode === 'maps') {
      const map = activeMap(); if (!map) return;
      const host = getEditorHost(), services = { projects: host.projects, history: host.history };
      const layerId = addMapLayer(services, map.id, 'tile');
      host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId }, { kind: 'map', id: map.id });
      emit('view'); return;
    }
```

- [ ] **Step 3: Redirect `doAddGroup`'s maps branch**

Replace:

```js
    if (state.mode === 'maps') {
      const map = activeMap(); if (!map) return;
      const layer = createMapLayer(map, { type: 'sprite' });
      state.activeMapLayerId = layer.id; markDirty(); emit('view'); return;
    }
```

with:

```js
    if (state.mode === 'maps') {
      const map = activeMap(); if (!map) return;
      const host = getEditorHost(), services = { projects: host.projects, history: host.history };
      const layerId = addMapLayer(services, map.id, 'sprite');
      host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId }, { kind: 'map', id: map.id });
      emit('view'); return;
    }
```

(`createMapLayer` import in `js/ui/panels.js` may now be unused if nothing else in the file calls it — check with a grep for `createMapLayer` before removing the import; leave it if other non-map code paths still use it.)

- [ ] **Step 4: Redirect `doDelete`'s maps branch**

Replace:

```js
    if (state.mode === 'maps') {
      const map = activeMap(), layer = map?.layers.find(l => l.id === state.activeMapLayerId);
      if (!map || !layer || map.layers.length <= 1) return;
      if (!confirmOrAuto(`Delete ${layer.type} layer "${layer.name}"?`)) return;
      const index = map.layers.indexOf(layer);
      state.commands.push({ label: 'delete map layer', do() { map.layers.splice(map.layers.indexOf(layer), 1); state.activeMapLayerId = map.layers[Math.min(index, map.layers.length - 1)]?.id ?? null; refreshMapBounds(state.project, map); markDirty(); }, undo() { map.layers.splice(index, 0, layer); state.activeMapLayerId = layer.id; refreshMapBounds(state.project, map); markDirty(); } });
      return;
    }
```

with:

```js
    if (state.mode === 'maps') {
      const host = getEditorHost();
      const map = activeMap(), layerId = (host.selections.get({ kind: 'map', id: map?.id }) ?? {}).layerId;
      const layer = map?.layers.find(l => l.id === layerId);
      if (!map || !layer || map.layers.length <= 1) return;
      if (!confirmOrAuto(`Delete ${layer.type} layer "${layer.name}"?`)) return;
      deleteMapLayer({ projects: host.projects, history: host.history }, map.id, layer.id);
      return;
    }
```

Note: `deleteMapLayer` (Task 4) doesn't reassign the active layer selection after deletion the way the old inline command did (`state.activeMapLayerId = map.layers[Math.min(index, ...)]`). Add that as an explicit follow-up call so the panel doesn't end up pointing at a deleted layer:

```js
      const remainingIndex = Math.min(map.layers.indexOf(layer), map.layers.length - 2);
      deleteMapLayer({ projects: host.projects, history: host.history }, map.id, layer.id);
      host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId: map.layers[Math.max(0, remainingIndex)]?.id ?? null }, { kind: 'map', id: map.id });
      emit('view');
      return;
```

(Compute `remainingIndex` from `map.layers` **before** calling `deleteMapLayer`, since the array is mutated in place by the command. The `emit('view')` matches `doAddLayer`/`doAddGroup`'s convention in this same file — `deleteMapLayer`'s host-side mutation doesn't itself trigger a legacy re-render, so without this the layer panel would show a stale list until some unrelated legacy event happened to fire.)

- [ ] **Step 5: Redirect `renderMapLayer`**

Replace:

```js
  function renderMapLayer(layer) {
    const row = document.createElement('div');
    row.className = 'layer-row layer-leaf' + (layer.id === state.activeMapLayerId ? ' active' : '');
    row.style.paddingLeft = '4px'; row.tabIndex = 0;
    row.addEventListener('click', () => { state.activeMapLayerId = layer.id; emit('view'); });
```

with:

```js
  function renderMapLayer(layer) {
    const host = getEditorHost();
    const map = activeMap();
    const activeLayerId = (host.selections.get({ kind: 'map', id: map?.id }) ?? {}).layerId;
    const row = document.createElement('div');
    row.className = 'layer-row layer-leaf' + (layer.id === activeLayerId ? ' active' : '');
    row.style.paddingLeft = '4px'; row.tabIndex = 0;
    row.addEventListener('click', () => {
      host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId: layer.id }, { kind: 'map', id: map.id });
      emit('view');
    });
```

- [ ] **Step 6: Run the panels test file**

Run: `node --test tests/panels.test.mjs`
Expected: PASS (confirms no sprite/tile regression; maps-branch behavior isn't covered by this file per the investigation, so this only guards against syntax/import breakage — manual verification covers the maps behavior itself, per Task 13).

- [ ] **Step 7: Commit**

```bash
git add js/ui/panels.js
git commit -m "refactor(panels): route map-layer add/delete through SelectionService and map layer commands"
```

---

### Task 10: `document-controller.js` + `state.js` — drop legacy map-selection writes

**Files:**
- Modify: `js/features/project/document-controller.js:51-58` (`switchMode`'s maps branch)
- Modify: `js/features/project/document-controller.js:132` (`sheetSelect` change handler)
- Modify: `js/features/project/document-controller.js:191` (`document.newSheet` action)
- Modify: `js/features/project/document-controller.js:312-335` (`commitDeleteMap`)
- Modify: `js/app/state.js:24-26` (remove `activeMapLayerId`/`selectedMapItemId` field declarations)
- Modify: `js/app/state.js:124-126` (`setProject`'s map-selection init)

Per the "Behavior-change note" above, these sites simply **stop** writing the two fields — Task 11's adapter change (next) takes over seeding the default selection.

- [ ] **Step 1: Edit `switchMode`**

Replace:

```js
    if (mode === 'maps') {
      const map = state.project?.maps?.[0] ?? null;
      state.activeMapId = map?.id ?? null;
      state.activeMapLayerId = map?.layers[0]?.id ?? null;
      state.activeSheetId = null; state.activeLayerId = null; state.view = 'map';
```

with:

```js
    if (mode === 'maps') {
      const map = state.project?.maps?.[0] ?? null;
      state.activeMapId = map?.id ?? null;
      state.activeSheetId = null; state.activeLayerId = null; state.view = 'map';
```

- [ ] **Step 2: Edit the `sheetSelect` change handler**

Replace:

```js
    if (state.mode === 'maps') { const map = state.project?.maps?.find(m => m.id === sheetSelect.value); if (!map) return; state.activeMapId = map.id; state.activeMapLayerId = map.layers[0]?.id ?? null; state.view = 'map'; emit('view'); workbench.focusMap(); return; }
```

with:

```js
    if (state.mode === 'maps') { const map = state.project?.maps?.find(m => m.id === sheetSelect.value); if (!map) return; state.activeMapId = map.id; state.view = 'map'; emit('view'); workbench.focusMap(); return; }
```

- [ ] **Step 3: Edit `document.newSheet`**

Replace:

```js
      if (state.mode === 'maps') { const map = createMap(state.project, { name: `Map ${state.project.maps.length}`, gridW: state.project.settings.tileW, gridH: state.project.settings.tileH }); state.activeMapId = map.id; state.activeMapLayerId = map.layers[0].id; markDirty(); emit('view'); return; }
```

with:

```js
      if (state.mode === 'maps') { const map = createMap(state.project, { name: `Map ${state.project.maps.length}`, gridW: state.project.settings.tileW, gridH: state.project.settings.tileH }); state.activeMapId = map.id; markDirty(); emit('view'); return; }
```

- [ ] **Step 4: Edit `commitDeleteMap`**

Replace:

```js
  function commitDeleteMap(map) {
    const project = state.project, index = project.maps.indexOf(map);
    if (index === -1) return;
    const wasActive = state.activeMapId === map.id;
    const prev = { activeMapId:state.activeMapId, activeMapLayerId:state.activeMapLayerId, selectedMapItemId:state.selectedMapItemId };
    state.commands.push({
      label: 'delete map',
      do() {
        const current = project.maps.indexOf(map); if (current !== -1) project.maps.splice(current, 1);
        if (wasActive) {
          const next = project.maps[Math.min(index, project.maps.length - 1)] ?? null;
          state.activeMapId = next?.id ?? null;
          state.activeMapLayerId = next?.layers[0]?.id ?? null;
          state.selectedMapItemId = null;
        }
        markDirty(); emit('view');
      },
      undo() {
        if (!project.maps.includes(map)) project.maps.splice(index, 0, map);
        Object.assign(state, prev);
        markDirty(); emit('view');
      },
    });
  }
```

with:

```js
  function commitDeleteMap(map) {
    const project = state.project, index = project.maps.indexOf(map);
    if (index === -1) return;
    const wasActive = state.activeMapId === map.id;
    const prev = { activeMapId: state.activeMapId };
    state.commands.push({
      label: 'delete map',
      do() {
        const current = project.maps.indexOf(map); if (current !== -1) project.maps.splice(current, 1);
        if (wasActive) {
          const next = project.maps[Math.min(index, project.maps.length - 1)] ?? null;
          state.activeMapId = next?.id ?? null;
        }
        markDirty(); emit('view');
      },
      undo() {
        if (!project.maps.includes(map)) project.maps.splice(index, 0, map);
        Object.assign(state, prev);
        markDirty(); emit('view');
      },
    });
  }
```

(This relies on the host's `selectionsByDocument['map:'+map.id]` entry surviving the splice-out/splice-back-in cycle unchanged — verified in this plan's design: nothing clears that entry on map deletion, so undo naturally restores the correct layer/item selection with no extra code, matching the pre-existing per-sheet-selection precedent for sprites/tiles.)

- [ ] **Step 5: Edit `state.js`'s field declarations**

Replace:

```js
  activeMapId: null,
  activeMapLayerId: null,
  selectedMapItemId: null,
```

with:

```js
  activeMapId: null,
```

- [ ] **Step 6: Edit `state.js`'s `setProject`**

Replace:

```js
  const map = project.maps?.[0] ?? null;
  state.activeMapId = map?.id ?? null;
  state.activeMapLayerId = map?.layers[0]?.id ?? null;
```

with:

```js
  const map = project.maps?.[0] ?? null;
  state.activeMapId = map?.id ?? null;
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: Every currently-passing test still passes (none reference the removed fields directly, per this plan's investigation — confirm with a grep for `activeMapLayerId`/`selectedMapItemId` across `tests/` before proceeding to Task 11, since a stray reference would need fixing here rather than surfacing later).

- [ ] **Step 8: Commit**

```bash
git add js/features/project/document-controller.js js/app/state.js
git commit -m "refactor(state): stop writing legacy activeMapLayerId/selectedMapItemId, host selection now authoritative"
```

---

### Task 11: `legacy-state-adapter.js` — stop mirroring, seed defaults instead

**Files:**
- Modify: `js/features/project/legacy-state-adapter.js`

**Interfaces:**
- Consumes: nothing new — same `host`/`legacyState` parameters as today.

By this point (all writers migrated in Tasks 6, 9, 10), the adapter can stop overwriting maps' `selectionsByDocument` entry on every sync tick. It now only **seeds** a default the first time a given map document is seen with no existing selection — this is what makes Task 10's deleted `activeMapLayerId` initializations unnecessary.

- [ ] **Step 1: Edit the transaction block**

Replace:

```js
  host.store.transaction('legacy-session', state => {
    state.session.activeViewId = modeId === 'maps' ? 'maps.canvas'
      : legacyState.view === 'frame' ? 'sprites.frame'
      : legacyState.view === 'tile' ? 'tiles.tile'
      : `${modeId}.sheet`;
    state.session.activeToolId = legacyState.tool;
    if (reference) {
      state.session.selectionsByDocument[`${reference.kind}:${reference.id}`] = {
        layerId: modeId === 'maps' ? legacyState.activeMapLayerId : legacyState.activeLayerId,
        frameId: legacyState.selectedFrameId,
        animationId: legacyState.selectedAnimationId,
        tileId: legacyState.selectedTileId,
        terrainSetId: legacyState.selectedTerrainSetId,
        mapItemId: legacyState.selectedMapItemId,
      };
    }
  });
```

with:

```js
  host.store.transaction('legacy-session', state => {
    state.session.activeViewId = modeId === 'maps' ? 'maps.canvas'
      : legacyState.view === 'frame' ? 'sprites.frame'
      : legacyState.view === 'tile' ? 'tiles.tile'
      : `${modeId}.sheet`;
    state.session.activeToolId = legacyState.tool;
    if (reference && modeId === 'maps') {
      // Maps' layer/item selection is host-authoritative (SelectionService is
      // the sole writer, from the map Presenter and the map-layer panel). Only
      // seed a default the first time this map is seen this session; otherwise
      // an unconditional overwrite here would clobber every SelectionService
      // write on the very next legacy event.
      const key = `${reference.kind}:${reference.id}`;
      if (!state.session.selectionsByDocument[key]) {
        const map = legacyState.project?.maps?.find(m => m.id === reference.id);
        state.session.selectionsByDocument[key] = { layerId: map?.layers[0]?.id ?? null, mapItemId: null };
      }
    } else if (reference) {
      state.session.selectionsByDocument[`${reference.kind}:${reference.id}`] = {
        layerId: legacyState.activeLayerId,
        frameId: legacyState.selectedFrameId,
        animationId: legacyState.selectedAnimationId,
        tileId: legacyState.selectedTileId,
        terrainSetId: legacyState.selectedTerrainSetId,
      };
    }
  });
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add js/features/project/legacy-state-adapter.js
git commit -m "refactor(legacy-adapter): stop overwriting maps' selection every sync, seed defaults only"
```

---

### Task 12: `previewpanel.js` — host-native map-content refresh

**Files:**
- Modify: `js/ui/previewpanel.js`

**Interfaces:**
- Consumes: `js/host/runtime.js`'s `getEditorHost` (already imported in this file).

Replaces the legacy `on('map-content', renderMapContentNow)` listener (fired by the old `map-editor.js`'s `push()` helper, now deleted) with a subscription to `HistoryService`, which already fires on every command execute/undo/redo — including the new map Command Handlers from Tasks 3-4 — regardless of which mode is active.

- [ ] **Step 1: Replace the listener registration**

Replace:

```js
  on('project', requestContextRender);
  on('history', requestContextRender);
  on('view', requestContextRender);
  on('selection', requestContextRender);
  on('pixels', requestContextRender);
  on('map-content', renderMapContentNow);
  render();
}
```

with:

```js
  on('project', requestContextRender);
  on('history', requestContextRender);
  on('view', requestContextRender);
  on('selection', requestContextRender);
  on('pixels', requestContextRender);
  getEditorHost()?.history.subscribe(() => { if (state.mode === 'maps') renderMapContentNow(); });
  render();
}
```

`getEditorHost()` is already imported at the top of this file (line 23, confirmed during investigation). No other change needed — `renderMapContentNow`'s own body already guards on `state.mode !== 'maps'` and needs no edit.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add js/ui/previewpanel.js
git commit -m "refactor(previewpanel): replace legacy map-content event with HistoryService subscription"
```

---

### Task 13: Architecture enforcement + final verification

**Files:**
- Modify: `tests/architecture.test.mjs`

**Interfaces:**
- Consumes: the existing `jsFiles` helper already defined in this file.

The existing generic tests (`application-layer code ... never touches DOM or Canvas rendering`, `presentation-layer mode code dispatches commands by id only`, `modes never import sibling modes`) already scope to `js/modes/*/application/**` and `js/modes/*/presentation/**` — since maps now has both folders, those tests automatically start covering maps with zero edits. Add one maps-specific test mirroring the existing tiles-specific one (`mode command modules do not access browser UI globals`), since maps' command modules live in a nested `commands/` subfolder the generic scan already covers, but an explicit test names them for a clearer failure message.

- [ ] **Step 1: Add the test**

Insert after the existing `'mode command modules do not access browser UI globals'` test (which currently only lists the three tiles command files):

```js
test('map command modules do not access browser UI globals', async () => {
  for (const file of [
    join(root, 'js/modes/maps/application/commands/map-paint-commands.js'),
    join(root, 'js/modes/maps/application/commands/map-layer-commands.js'),
  ]) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /\b(?:document|window|prompt|alert|confirm)\b/, file);
  }
});
```

- [ ] **Step 2: Run the architecture suite**

Run: `node --test tests/architecture.test.mjs`
Expected: PASS. If the pre-existing "application-layer code... never touches DOM" test fails against `js/modes/maps/application/**`, it means a Canvas/DOM call leaked into Task 1/3/4's files — go back and fix the offending file rather than weakening the test.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: 100% pass, no reduction in test count versus the pre-Phase-1 baseline (458 tests + this plan's additions).

- [ ] **Step 4: Commit**

```bash
git add tests/architecture.test.mjs
git commit -m "test(architecture): enforce maps application layer stays free of browser globals"
```

- [ ] **Step 5: Manual verification checklist (report to user, do not attempt to automate)**

Per project convention, pointer-drag interactions are not simulated in Playwright for this app. After all tasks land, ask the user to manually verify in a running instance:
- Switch to Maps mode, create a map, paint tiles/terrain/sprites with the brush tools (click and drag).
- Erase with right-click drag.
- Switch to the Select/Move tool, click an item to select it (blue outline appears), drag to move it, press Delete to remove it.
- Undo/redo across several of the above.
- Add a map layer, delete a map layer, switch between two existing maps and confirm each remembers its own last-selected layer.
- Delete a map, undo the deletion, confirm the map's prior layer/item selection is restored.
- Confirm the Preview panel updates live while painting (not just after releasing the pointer).
- Confirm the title bar's unsaved-changes indicator/guard still reacts to map edits.

---

## Self-Review

**Spec coverage:** Every requirement from the user's "pull in the extra files now" decision is covered — `js/modes/maps` fully split onto application/presentation (Tasks 1-8), `activeMapLayerId`/`selectedMapItemId` migrated to `SelectionService` (Tasks 6, 9-11), `js/ui/panels.js`'s map-layer code redirected (Task 9), `js/ui/previewpanel.js`'s `map-content` listener replaced with a host-native subscription (Task 12), dirty-tracking addressed via the dual-write convention already established in Phase 0/tiles (Global Constraints, Task 3-4).

**Placeholder scan:** No TBD/TODO markers. Task 8's `contributions.js`/`preview.js` wiring and Tasks 3-4's erase/delete Command Handlers were each verified/corrected against the real current files before finalizing this plan (see the quoted "current file" blocks inline) — every task below contains complete, final code, not a stub to be resolved at implementation time.

**Type/signature consistency:** `services` (`{projects, history}`) is used identically across Tasks 3, 4, 9 (constructed inside `registerMapCommands`/`js/ui/panels.js` where the Command Handlers are actually called; Task 6's Presenter no longer constructs it directly, since it dispatches by id instead — see below). `mapDocument`/`{kind:'map', id}` shape matches `legacy-state-adapter.js`'s existing convention (confirmed via investigation). `mapBrushState`/`asset` field names (`tileKind`, `tileSheetId`, `tileId`, `terrainSheetId`, `terrainSetId`, `spriteSheetId`, `spriteKind`, `spriteId`) match the original `mapAsset` object exactly, used consistently in Tasks 5-7.

**Correction during execution (Task 6):** the original draft had Task 6's Presenter import Task 3/4's Command Handler functions directly and call them by reference, arguing the "dispatch by id" architecture rule (enforced by `tests/architecture.test.mjs`'s `presentation-layer mode code dispatches commands by id only, never imports command handlers directly` test) didn't really apply since nothing outside maps mode needed to invoke them by id. That argument doesn't survive contact with the actual test, which bans the import path unconditionally, with no same-mode exception — running the Task 6 implementer surfaced this as a real test failure, not implementer error. Per the user's direction, the plan was corrected (not the test): Task 8's `contributions.js` now registers all 8 Command Handlers as `EditorHost` Commands via `api.commands.register({id, when, execute})` (the existing but previously-unused `js/host/contributions/commands.js` `CommandRegistry`, already wired into `EditorHost` as the public `registries.commands` property since Phase 0), and Task 6's Presenter calls them via `getEditorHost().registries.commands.execute(id, context, args)`. This is the pattern Sprites/Tiles (Phase 2/3) should also follow, since Maps is the pilot mode establishing it. Tasks 3/4/9 (already implemented and reviewed before this was caught) required no changes — only Task 6's Presenter and Task 8's `contributions.js` were affected.

**Scope check:** Every shared-file edit (Tasks 9-12) touches only maps-specific branches/lines; sprite/tile behavior in those files is unmodified, verified by each task's instruction to run the existing full suite before committing.
