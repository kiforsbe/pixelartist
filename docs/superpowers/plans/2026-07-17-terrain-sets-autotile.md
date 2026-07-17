# Terrain sets, blob-47 autotile rules, layers & tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add terrain sets (blob-47 autotiling, with a 16-tile core subset and flip/rotation symmetry reduction, plus layout-preset import), an ordered per-sheet layer list, and free-form per-tile tags — all metadata authoring, exported in `tiles.json` for an external engine to consume.

**Architecture:** Two new pure, DOM-free core modules (`js/core/blob47.js` for the bitmask algorithm, `js/core/terrainsets.js` for terrain-set CRUD/slot mutation, mirroring `js/core/tilegrids.js`'s role) sit under `js/ui/tilemode.js`'s command layer (thin `state.commands.push()` wrappers, exactly like `commitAddGrid` wraps `createTileGrid`) and UI (panel list + slot editor, mirroring the existing grid list). `js/ui/tileeditor.js` gets one new branch (terrain-set tiles resolve their neighbor preview differently). `js/app/exports.js` gains the new top-level shapes.

**Tech Stack:** Same as the rest of the app — vanilla JS ES modules, no build step, `node --test tests/*.mjs` via `npm test`.

**Reference spec:** `docs/superpowers/specs/2026-07-17-terrain-sets-autotile-design.md` — read it for the full rationale (bit-weight source verification, resolution precedence reasoning, why layout presets are pixelartist-defined rather than claiming external parity). This plan implements it task-by-task; where this plan and the spec conflict, this plan's code is authoritative (it has been re-derived and corrected during planning — see Task 2's note on transform inverses).

## Global Constraints

- Blob-47 bit weights are **clockwise from North, alternating edge/corner**: `N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128`. This exact convention is verified against the source blob-tileset reference and must not be changed.
- A tile can occupy **at most one terrain-set slot at a time**, across all terrain sets on the sheet. Assigning it elsewhere clears its previous slot first.
- Terrain-set membership **replaces** the manual neighbor-preset editor for that tile only. Tiles with no `terrainSetId` are completely unaffected by any change in this plan.
- Partial terrain sets are always allowed — an unresolved slot is a valid, expected state, never an error.
- `npm test` must stay green after every task.
- No DOM/`document`/`window` access in `js/core/*.js` files (matches every existing core module).

---

### Task 1: Core data model additions

**Files:**
- Modify: `js/core/model.js` (`createSheet`, `serializeProject`, `deserializeProject`)
- Modify: `js/core/tilegrids.js:19-25` (`makeCellTile`)
- Modify: `js/ui/tilemode.js:192-213` (`commitCreateTile`)
- Test: `tests/model.test.mjs`

**Interfaces:**
- Produces: `sheet.terrainSets` (array), `sheet.terrainLayoutPresets` (array), `sheet.layers` (string array) — all `null` for non-`'tile'`-kind sheets, `[]` for tile sheets, matching the existing `tileGrids`/`tiles` convention. Every tile record gains four optional fields: `terrainSetId`, `blobIndex`, `layer`, `tags`.

- [ ] **Step 1: Write the failing test**

Add to `tests/model.test.mjs` (find the existing `createSheet` test block and add alongside it):

```js
test('createSheet: tile-kind sheet gets empty terrainSets/terrainLayoutPresets/layers, non-tile gets null', () => {
  const p = createProject('t');
  const tileSheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  assert.deepEqual(tileSheet.terrainSets, []);
  assert.deepEqual(tileSheet.terrainLayoutPresets, []);
  assert.deepEqual(tileSheet.layers, []);
  const spriteSheet = createSheet(p, { name: 'Sprites', width: 32, height: 32, kind: 'sprite' });
  assert.equal(spriteSheet.terrainSets, null);
  assert.equal(spriteSheet.terrainLayoutPresets, null);
  assert.equal(spriteSheet.layers, null);
});

test('serializeProject/deserializeProject round-trips terrainSets/terrainLayoutPresets/layers and per-tile fields', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  sheet.terrainSets.push({ id: 'ts1', name: 'Grass', tileW: 16, tileH: 16, slots: { 0: 'ti1' }, symmetry: { flip: true, rotate: false } });
  sheet.terrainLayoutPresets.push({ id: 'tlp1', name: 'My layout', cols: 4, rows: 4, cells: [{ col: 0, row: 0, blobIndex: 0 }] });
  sheet.layers.push('Ground', 'Props');
  sheet.tiles.push({ id: 'ti1', x: 0, y: 0, w: 16, h: 16, name: 'grass', gridId: null, gridCol: undefined, gridRow: undefined, neighbors: undefined, terrainSetId: 'ts1', blobIndex: 0, layer: 'Ground', tags: ['nature', 'walkable'] });

  const { json, images } = serializeProject(p);
  const imagesByPath = new Map(images.map(i => [i.path, i.bitmap]));
  const reloaded = deserializeProject(json, imagesByPath);
  const rt = reloaded.sheets.find(s => s.name === 'Tiles');

  assert.deepEqual(rt.terrainSets, [{ id: 'ts1', name: 'Grass', tileW: 16, tileH: 16, slots: { 0: 'ti1' }, symmetry: { flip: true, rotate: false } }]);
  assert.deepEqual(rt.terrainLayoutPresets, [{ id: 'tlp1', name: 'My layout', cols: 4, rows: 4, cells: [{ col: 0, row: 0, blobIndex: 0 }] }]);
  assert.deepEqual(rt.layers, ['Ground', 'Props']);
  const rtTile = rt.tiles.find(t => t.id === 'ti1');
  assert.equal(rtTile.terrainSetId, 'ts1');
  assert.equal(rtTile.blobIndex, 0);
  assert.equal(rtTile.layer, 'Ground');
  assert.deepEqual(rtTile.tags, ['nature', 'walkable']);

  // Mutating the reload must not alias the original sheet's nested objects.
  rt.terrainSets[0].slots[1] = 'ti2';
  rtTile.tags.push('extra');
  assert.deepEqual(sheet.terrainSets[0].slots, { 0: 'ti1' });
  assert.deepEqual(sheet.tiles[0].tags, ['nature', 'walkable']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 "terrainSets"`
Expected: FAIL — `terrainSets` is `undefined` (property doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

In `js/core/model.js`, extend `createSheet` (around line 49-54):

```js
  const sheet = {
    id: newId('sh'), name, width, height, kind,
    layerTree: root, frames: [], animations: [],
    tileGrids: kind === 'tile' ? [] : null,
    tiles: kind === 'tile' ? [] : null,
    terrainSets: kind === 'tile' ? [] : null,
    terrainLayoutPresets: kind === 'tile' ? [] : null,
    layers: kind === 'tile' ? [] : null,
  };
```

Extend `serializeProject`'s sheet-mapping (around line 391-398) to clone the new fields (deep enough that nested objects/arrays aren't aliased with the live sheet) and extend the `tiles` clone to also copy `tags`:

```js
    sheets: project.sheets.map(s => ({
      id: s.id, name: s.name, width: s.width, height: s.height, kind: s.kind,
      tileGrids: s.tileGrids ? s.tileGrids.map(g => ({ ...g })) : null,
      tiles: s.tiles ? s.tiles.map(t => ({
        ...t,
        neighbors: t.neighbors ? { ...t.neighbors } : undefined,
        tags: t.tags ? [...t.tags] : undefined,
      })) : null,
      terrainSets: s.terrainSets ? s.terrainSets.map(ts => ({
        ...ts, slots: { ...ts.slots }, symmetry: { ...ts.symmetry },
      })) : null,
      terrainLayoutPresets: s.terrainLayoutPresets
        ? s.terrainLayoutPresets.map(p => ({ ...p, cells: p.cells.map(c => ({ ...c })) }))
        : null,
      layers: s.layers ? s.layers.slice() : null,
      frames: s.frames.map(f => ({ ...f })),
      animations: s.animations.map(a => ({ ...a, frames: a.frames.map(x => ({ ...x })), breaks: (a.breaks ?? []).slice(), layerGroupId: a.layerGroupId ?? null })),
      layerTree: serializeGroup(s.layerTree, s.id, images),
    })),
```

Extend `deserializeProject`'s sheet-mapping (around line 415-421) — the existing tile-kind IIFE only returns `tileGrids`/`tiles`; extend it to also default the three new fields:

```js
        ...(() => {
          if (s.kind !== 'tile') return { tileGrids: null, tiles: null, terrainSets: null, terrainLayoutPresets: null, layers: null };
          if (!s.tiles && s.tile) return { ...migrateLegacyTile(s), terrainSets: [], terrainLayoutPresets: [], layers: [] };
          return {
            tileGrids: s.tileGrids ?? [], tiles: s.tiles ?? [],
            terrainSets: s.terrainSets ?? [], terrainLayoutPresets: s.terrainLayoutPresets ?? [],
            layers: s.layers ?? [],
          };
        })(),
```

Now extend every tile-construction call site with the four new fields, explicitly `undefined` (matching how `name`/`neighbors` are already listed explicitly), so the tile shape is self-documenting everywhere a tile literal is built:

In `js/core/tilegrids.js`, `makeCellTile` (lines 19-25):

```js
function makeCellTile(grid, col, row) {
  const r = gridCellRect(grid, col, row);
  return {
    id: newId('ti'), x: r.x, y: r.y, w: r.w, h: r.h,
    name: undefined, gridId: grid.id, gridCol: col, gridRow: row, neighbors: undefined,
    terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined,
  };
}
```

In `js/ui/tilemode.js`, `commitCreateTile`'s `do()` (line 198):

```js
        created = { id: newId('ti'), x: rect.x, y: rect.y, w: rect.w, h: rect.h, name: undefined, gridId: null, gridCol: undefined, gridRow: undefined, neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -15`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add js/core/model.js js/core/tilegrids.js js/ui/tilemode.js tests/model.test.mjs
git commit -m "feat: add terrainSets/terrainLayoutPresets/layers to sheet + tile shape"
```

---

### Task 2: `js/core/blob47.js` — bitmask algorithm, 16-tile subset, symmetry, resolution

**Files:**
- Create: `js/core/blob47.js`
- Test: `tests/blob47.test.mjs`

**Interfaces:**
- Consumes: nothing (pure, self-contained).
- Produces: `maskToBlobIndex` (256-entry array), `blobIndexToMask` (47-entry array), `terrainPreviewCells(tile)`, `SIXTEEN_TILE_INDICES` (Set of 16 numbers), `sixteenTileBlobIndex(cardinalMask)`, `resolveTerrainSlot(terrainSet, blobIndex)` returning `{ tileId, flipH, flipV, rotate } | null`. These are what Task 4 (terrainsets.js), Task 8 (tileeditor.js), and Task 9 (exports.js) all consume.

**Note on correctness:** the resolution direction (which transform to apply to a *found* tile to render the *target* orientation) requires the transform's **inverse**, not the transform itself — reusing the same transform in both directions silently produces wrong output for non-self-inverse transforms (the two 90°/270° rotations). This is worked out precisely below; don't re-derive it differently.

- [ ] **Step 1: Write the failing test**

Create `tests/blob47.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskToBlobIndex, blobIndexToMask, terrainPreviewCells,
  SIXTEEN_TILE_INDICES, sixteenTileBlobIndex, resolveTerrainSlot,
} from '../js/core/blob47.js';

test('maskToBlobIndex reduces 256 raw masks to exactly 47 canonical buckets', () => {
  assert.equal(blobIndexToMask.length, 47);
  const seen = new Set(maskToBlobIndex);
  assert.equal(seen.size, 47);
  for (const idx of maskToBlobIndex) assert.ok(idx >= 0 && idx < 47);
});

test('known reference cases', () => {
  // isolated (no neighbors) and full surround are always their own bucket.
  const isolated = maskToBlobIndex[0];
  const full = maskToBlobIndex[255];
  assert.notEqual(isolated, full);
  // a lone diagonal (NE=2) with neither adjacent edge (N=1, E=4) set reduces
  // to the same bucket as "no neighbors at all" (NE gets masked off).
  assert.equal(maskToBlobIndex[2], isolated);
  // N+E+NE (1+4+2=7) is its own distinct bucket from N+E alone (1+4=5).
  assert.notEqual(maskToBlobIndex[7], maskToBlobIndex[5]);
});

test('canonical masks never have an ineligible corner bit set', () => {
  const CORNERS = [[2, 1, 4], [8, 4, 16], [32, 16, 64], [128, 64, 1]];
  for (const m of blobIndexToMask) {
    for (const [corner, a, b] of CORNERS) {
      if (m & corner) assert.ok((m & a) && (m & b), `corner ${corner} set without both ${a},${b} in mask ${m}`);
    }
  }
});

test('sixteenTileBlobIndex produces exactly 16 distinct canonical indices', () => {
  // Valid cardinal-only masks are subset-sums of the actual N/E/S/W bit
  // values {1,4,16,64} -- NOT sequential 0-15 (that range mixes in bits
  // that mean NE/SE/etc in this module's convention).
  const CARDINALS = [1, 4, 16, 64];
  const indices = new Set();
  for (let i = 0; i < 16; i++) {
    let cardinalMask = 0;
    for (let b = 0; b < 4; b++) if (i & (1 << b)) cardinalMask |= CARDINALS[b];
    indices.add(sixteenTileBlobIndex(cardinalMask));
  }
  assert.equal(indices.size, 16);
  assert.deepEqual(SIXTEEN_TILE_INDICES, indices);
});

test('terrainPreviewCells: bit set in own blobIndex -> self, unset -> empty', () => {
  const fullIndex = maskToBlobIndex[255];
  const tile = { id: 'center', blobIndex: fullIndex };
  const cells = terrainPreviewCells(tile);
  assert.equal(cells.length, 8);
  assert.ok(cells.every(c => c.tileId === 'center'));

  const isolatedIndex = maskToBlobIndex[0];
  const cells2 = terrainPreviewCells({ id: 'center', blobIndex: isolatedIndex });
  assert.ok(cells2.every(c => c.tileId === null));
});

test('resolveTerrainSlot: explicit assignment wins, no symmetry needed', () => {
  const ts = { slots: { [maskToBlobIndex[0]]: 'tileA' }, symmetry: { flip: false, rotate: false } };
  const result = resolveTerrainSlot(ts, maskToBlobIndex[0]);
  assert.deepEqual(result, { tileId: 'tileA', flipH: false, flipV: false, rotate: 0 });
});

test('resolveTerrainSlot: unresolved with no reduction enabled', () => {
  const ts = { slots: {}, symmetry: { flip: false, rotate: false } };
  assert.equal(resolveTerrainSlot(ts, maskToBlobIndex[1]), null);
});

test('resolveTerrainSlot: rotation-only resolves a 90-degree-rotated slot with a nonzero rotate', () => {
  // Mask 1 (N only) rotated 90 degrees clockwise becomes NE (2) in bit-position
  // terms is not quite right for a single edge -- use the actual rotate90 of
  // mask 1: bits are rotated left by 2 positions => bit0 -> bit2 => mask 4 (E).
  const nIndex = maskToBlobIndex[1];
  const eIndex = maskToBlobIndex[4];
  assert.notEqual(nIndex, eIndex);
  const ts = { slots: { [nIndex]: 'tileN' }, symmetry: { flip: false, rotate: true } };
  const result = resolveTerrainSlot(ts, eIndex);
  assert.ok(result && result.tileId === 'tileN');
  assert.notEqual(result.rotate, 0); // must use a real rotation, not identity
});

test('resolveTerrainSlot: 16-tile fallback resolves a corner-refinement slot from its core representative', () => {
  const nIndex = maskToBlobIndex[1]; // N only, cardinal-only, IS a core index
  assert.ok(SIXTEEN_TILE_INDICES.has(nIndex));
  const ts = { slots: { [nIndex]: 'coreTile' }, symmetry: { flip: false, rotate: false } };
  // N+NE (1+2=3) is not itself achievable as a canonical mask (NE requires E
  // too), so pick a genuine corner-refinement case instead: full surround (255)
  // is non-core; its core representative is also full surround here since all
  // corners are already maximal, so use a mask where corners aren't maximal.
  // A guaranteed non-core case: N+E with the NE corner ABSENT (mask 5) is its
  // own bucket, distinct from N+E+NE (mask 7, the core "smoothed" variant).
  const nePartial = maskToBlobIndex[5]; // N+E, no corner
  assert.ok(!SIXTEEN_TILE_INDICES.has(nePartial));
  const tsNE = { slots: { [sixteenTileBlobIndex(0b0101)]: 'coreNE' }, symmetry: { flip: false, rotate: false } };
  const result = resolveTerrainSlot(tsNE, nePartial);
  assert.deepEqual(result, { tileId: 'coreNE', flipH: false, flipV: false, rotate: 0 });
});

test('resolveTerrainSlot: both symmetry + 16-tile fallback compose', () => {
  const nIndex = maskToBlobIndex[1]; // core: N only
  const ts = { slots: { [nIndex]: 'tileN' }, symmetry: { flip: false, rotate: true } };
  // E-only (mask 4) is also core; should resolve via rotation from N, not via fallback.
  const eIndex = maskToBlobIndex[4];
  const result = resolveTerrainSlot(ts, eIndex);
  assert.ok(result && result.tileId === 'tileN');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/blob47.test.mjs`
Expected: FAIL — module `../js/core/blob47.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `js/core/blob47.js`:

```js
// Blob-47 autotile bitmask algorithm. Pure, DOM-free — see
// docs/superpowers/specs/2026-07-17-terrain-sets-autotile-design.md for the
// full derivation. Bit weights verified against the source "Wang blob"
// tileset reference: clockwise from North, alternating edge/corner.
export const NEIGHBOR_BITS = { N: 1, NE: 2, E: 4, SE: 8, S: 16, SW: 32, W: 64, NW: 128 };

// [corner, adjacentA, adjacentB] — a corner bit only counts when both its
// flanking cardinal bits are also set (the tie-break rule that collapses
// 256 raw masks down to 47 canonical configurations).
const CORNERS = [
  [NEIGHBOR_BITS.NE, NEIGHBOR_BITS.N, NEIGHBOR_BITS.E],
  [NEIGHBOR_BITS.SE, NEIGHBOR_BITS.E, NEIGHBOR_BITS.S],
  [NEIGHBOR_BITS.SW, NEIGHBOR_BITS.S, NEIGHBOR_BITS.W],
  [NEIGHBOR_BITS.NW, NEIGHBOR_BITS.W, NEIGHBOR_BITS.N],
];

function canonicalize(rawMask) {
  let m = rawMask;
  for (const [corner, a, b] of CORNERS) {
    if ((m & corner) && !((m & a) && (m & b))) m &= ~corner;
  }
  return m;
}

function buildBlobTable() {
  const canonToIndex = new Map();
  const blobIndexToMask = [];
  const maskToBlobIndex = new Array(256);
  for (let raw = 0; raw < 256; raw++) {
    const canon = canonicalize(raw);
    if (!canonToIndex.has(canon)) {
      canonToIndex.set(canon, blobIndexToMask.length);
      blobIndexToMask.push(canon);
    }
    maskToBlobIndex[raw] = canonToIndex.get(canon);
  }
  return { maskToBlobIndex, blobIndexToMask };
}

export const { maskToBlobIndex, blobIndexToMask } = buildBlobTable();

// ---------------------------------------------------------------- preview

export const DIRECTION_OFFSETS = [
  { dx: 0, dy: -1, bit: NEIGHBOR_BITS.N },
  { dx: 1, dy: -1, bit: NEIGHBOR_BITS.NE },
  { dx: 1, dy: 0, bit: NEIGHBOR_BITS.E },
  { dx: 1, dy: 1, bit: NEIGHBOR_BITS.SE },
  { dx: 0, dy: 1, bit: NEIGHBOR_BITS.S },
  { dx: -1, dy: 1, bit: NEIGHBOR_BITS.SW },
  { dx: -1, dy: 0, bit: NEIGHBOR_BITS.W },
  { dx: -1, dy: -1, bit: NEIGHBOR_BITS.NW },
];

// No spatial lookup: a terrain tile's OWN blobIndex already states which
// directions its terrain continues in, so the preview is self-contained.
export function terrainPreviewCells(tile) {
  const mask = blobIndexToMask[tile.blobIndex];
  return DIRECTION_OFFSETS.map(({ dx, dy, bit }) => ({
    dx, dy,
    tileId: (mask & bit) ? tile.id : null,
    flipH: false, flipV: false,
  }));
}

// ---------------------------------------------------------------- 16-tile subset

const CARDINAL_BITS = [NEIGHBOR_BITS.N, NEIGHBOR_BITS.E, NEIGHBOR_BITS.S, NEIGHBOR_BITS.W];
// corner bit sitting between CARDINAL_BITS[i] and CARDINAL_BITS[i+1]
const CORNER_BETWEEN = [NEIGHBOR_BITS.NE, NEIGHBOR_BITS.SE, NEIGHBOR_BITS.SW, NEIGHBOR_BITS.NW];

// The "smoothest" (all geometrically-eligible corners filled) canonical
// index for a given 4-bit cardinal-only mask (0-15, using only N/E/S/W bits).
export function sixteenTileBlobIndex(cardinalMask) {
  let full = cardinalMask;
  for (let i = 0; i < 4; i++) {
    const a = CARDINAL_BITS[i], b = CARDINAL_BITS[(i + 1) % 4];
    if ((cardinalMask & a) && (cardinalMask & b)) full |= CORNER_BETWEEN[i];
  }
  return maskToBlobIndex[full];
}
// NOTE: cardinalMask values are NOT sequential 0-15 -- they're subset-sums
// of the ACTUAL bit values {1,4,16,64} (i.e. 0,1,4,5,16,17,20,21,64,65,68,
// 69,80,81,84,85). Build the 16 valid inputs by testing bit b of a plain
// 0-15 counter and OR-ing in CARDINAL_BITS[b] when set -- passing the
// counter directly (as if 0-15 == the cardinal mask) is wrong and silently
// produces duplicate/incorrect buckets.
export const SIXTEEN_TILE_INDICES = new Set(
  Array.from({ length: 16 }, (_, i) => {
    let cardinalMask = 0;
    for (let b = 0; b < 4; b++) if (i & (1 << b)) cardinalMask |= CARDINAL_BITS[b];
    return sixteenTileBlobIndex(cardinalMask);
  })
);
const CARDINAL_MASK = CARDINAL_BITS.reduce((a, b) => a | b, 0); // 0x55

// ---------------------------------------------------------------- symmetry

function rotateMaskBy(mask, deg) {
  if (deg === 90) return ((mask << 2) | (mask >> 6)) & 0xFF;
  if (deg === 180) return ((mask << 4) | (mask >> 4)) & 0xFF;
  if (deg === 270) return ((mask << 6) | (mask >> 2)) & 0xFF;
  return mask;
}

function swapBits(mask, pairs) {
  let m = mask;
  for (const [a, b] of pairs) {
    const bitA = mask & a, bitB = mask & b;
    m = (m & ~a & ~b) | (bitA ? b : 0) | (bitB ? a : 0);
  }
  return m;
}

// mirror left-right: E<->W, NE<->NW, SE<->SW; N and S unchanged.
function flipHBits(mask) {
  return swapBits(mask, [[NEIGHBOR_BITS.E, NEIGHBOR_BITS.W], [NEIGHBOR_BITS.NE, NEIGHBOR_BITS.NW], [NEIGHBOR_BITS.SE, NEIGHBOR_BITS.SW]]);
}

// A transform is described as { rotate: 0|90|180|270, flipH: bool }, applied
// rotate-then-flipH. This pair alone spans the full 8-element dihedral
// group (4 rotations x flip-or-not) -- a separate flipV is never needed
// internally: e.g. { rotate: 180, flipH: true } already nets out to a
// pure top-bottom mirror (verified: composing a 180-rotation permutation
// with a left-right mirror permutation swaps N<->S/NE<->SE/NW<->SW and
// leaves E/W fixed, which IS the flipV permutation).
function applyDescriptor(mask, { rotate, flipH }) {
  let m = rotateMaskBy(mask, rotate);
  if (flipH) m = flipHBits(m);
  return m;
}

// Only rotate90/rotate270 (with flipH: false) are not self-inverse; every
// other descriptor (identity, rotate180, and any flipH:true reflection) is
// its own inverse.
function inverseOf(t) {
  if (!t.flipH && t.rotate === 90) return { rotate: 270, flipH: false };
  if (!t.flipH && t.rotate === 270) return { rotate: 90, flipH: false };
  return t;
}

function enabledGroup(symmetry) {
  const rotate = symmetry?.rotate;
  const flip = symmetry?.flip;
  const rotates = rotate ? [0, 90, 180, 270] : (flip ? [0, 180] : [0]);
  const flips = flip ? [false, true] : [false];
  const group = [];
  for (const r of rotates) for (const fh of flips) group.push({ rotate: r, flipH: fh });
  return group;
}

// ---------------------------------------------------------------- resolution

// Resolves what should render at `blobIndex` for `terrainSet`: explicit
// assignment, else a symmetry-equivalent explicit assignment, else the
// 16-tile core representative (itself resolved the same way), else null.
export function resolveTerrainSlot(terrainSet, blobIndex) {
  const explicit = terrainSet.slots[blobIndex];
  if (explicit != null) return { tileId: explicit, flipH: false, flipV: false, rotate: 0 };

  const targetMask = blobIndexToMask[blobIndex];
  for (const t of enabledGroup(terrainSet.symmetry)) {
    if (t.rotate === 0 && !t.flipH) continue; // identity already covered above
    // t is the transform to apply to a FOUND source tile to produce the
    // target look, so the source's own mask is t's inverse applied to the
    // target mask (see module comment above `inverseOf`).
    const sourceMask = applyDescriptor(targetMask, inverseOf(t));
    const candidateIndex = maskToBlobIndex[sourceMask];
    const candidateTile = terrainSet.slots[candidateIndex];
    if (candidateTile != null) {
      return { tileId: candidateTile, flipH: t.flipH, flipV: false, rotate: t.rotate };
    }
  }

  if (!SIXTEEN_TILE_INDICES.has(blobIndex)) {
    const coreIndex = sixteenTileBlobIndex(targetMask & CARDINAL_MASK);
    return resolveTerrainSlot(terrainSet, coreIndex);
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/blob47.test.mjs`
Expected: PASS, all cases green. Then run the full suite: `npm test 2>&1 | tail -15` — still green.

- [ ] **Step 5: Commit**

```bash
git add js/core/blob47.js tests/blob47.test.mjs
git commit -m "feat: add blob47.js -- bitmask table, 16-tile subset, symmetry resolution"
```

---

### Task 3: Reference cleanup on tile removal (`scrubTileReferences`)

**Files:**
- Modify: `js/core/model.js` (add `scrubTileReferences`)
- Modify: `js/core/tilegrids.js:51-87` (`resizeGridCols`, `resizeGridRows`)
- Modify: `js/ui/tilemode.js:217-235` (`deleteTile`)
- Test: `tests/model.test.mjs`, `tests/tilegrids.test.mjs`

**Interfaces:**
- Consumes: `NEIGHBOR_DIRS` from `js/core/neighbors.js` (already exported — used today by `exports.js`).
- Produces: `scrubTileReferences(sheet, removedTileId)`, called by every place a tile record is actually dropped from `sheet.tiles`.

- [ ] **Step 1: Write the failing test**

Add to `tests/model.test.mjs`:

```js
import { scrubTileReferences } from '../js/core/model.js';
// (add alongside the existing import line for model.js)

test('scrubTileReferences clears dangling neighbors slots and terrain-set slots pointing at a removed tile', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  const a = { id: 'a', x: 0, y: 0, w: 8, h: 8, name: undefined, gridId: null, neighbors: { n: { mode: 'tile', tileId: 'b', flipH: false, flipV: false } } };
  const b = { id: 'b', x: 8, y: 0, w: 8, h: 8, name: undefined, gridId: null, neighbors: undefined };
  sheet.tiles.push(a, b);
  sheet.terrainSets.push({ id: 'ts1', name: 'Grass', tileW: 8, tileH: 8, slots: { 0: 'b', 1: 'a' }, symmetry: { flip: false, rotate: false } });

  scrubTileReferences(sheet, 'b');

  assert.deepEqual(a.neighbors.n, { mode: 'empty', tileId: null, flipH: false, flipV: false });
  assert.deepEqual(sheet.terrainSets[0].slots, { 1: 'a' });
});
```

Add to `tests/tilegrids.test.mjs`:

```js
test('resizeGridCols shrink scrubs dropped tiles from other tiles\' neighbors and any terrain set\'s slots', () => {
  const s = tileSheet();
  const { grid, tiles } = createTileGrid(s, { x: 0, y: 0, cellW: 8, cellH: 8, cols: 2, rows: 1 });
  const [left, right] = tiles;
  left.neighbors = { e: { mode: 'tile', tileId: right.id, flipH: false, flipV: false } };
  s.terrainSets.push({ id: 'ts1', name: 'T', tileW: 8, tileH: 8, slots: { 5: right.id }, symmetry: { flip: false, rotate: false } });
  resizeGridCols(s, grid, 1);
  assert.deepEqual(left.neighbors.e, { mode: 'empty', tileId: null, flipH: false, flipV: false });
  assert.deepEqual(s.terrainSets[0].slots, {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 scrubTileReferences`
Expected: FAIL — `scrubTileReferences` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `js/core/model.js`, add near the top (after the imports, since it needs `NEIGHBOR_DIRS`):

```js
import { NEIGHBOR_DIRS } from './neighbors.js';
```

Add the function (anywhere after `PROJECT_VERSION`, e.g. right before the serialization section comment):

```js
// Clears any dangling reference to a just-removed tile: other tiles'
// manual neighbor slots, and any terrain set's slot map. Called from every
// place a tile record is actually dropped from sheet.tiles (deleteTile in
// tilemode.js, grid-shrink in resizeGridCols/resizeGridRows).
export function scrubTileReferences(sheet, removedTileId) {
  for (const tile of sheet.tiles) {
    if (!tile.neighbors) continue;
    for (const dir of NEIGHBOR_DIRS) {
      const slot = tile.neighbors[dir];
      if (slot?.mode === 'tile' && slot.tileId === removedTileId) {
        tile.neighbors[dir] = { ...slot, mode: 'empty', tileId: null };
      }
    }
  }
  for (const ts of sheet.terrainSets ?? []) {
    for (const idx of Object.keys(ts.slots)) {
      if (ts.slots[idx] === removedTileId) delete ts.slots[idx];
    }
  }
}
```

In `js/core/tilegrids.js`, import it and call it for each dropped tile in the shrink branches of `resizeGridCols`/`resizeGridRows`:

```js
import { scrubTileReferences } from './model.js';
```

```js
export function resizeGridCols(sheet, grid, cols) {
  const delta = cols - grid.cols;
  const added = [], removed = [];
  if (delta > 0) {
    for (let row = 0; row < grid.rows; row++)
      for (let col = grid.cols; col < cols; col++) {
        const tile = makeCellTile(grid, col, row);
        sheet.tiles.push(tile);
        added.push(tile);
      }
  } else if (delta < 0) {
    const drop = new Set(ownedTiles(sheet, grid.id).filter(t => t.gridCol >= cols));
    removed.push(...drop);
    sheet.tiles = sheet.tiles.filter(t => !drop.has(t));
    for (const t of drop) scrubTileReferences(sheet, t.id);
  }
  grid.cols = cols;
  return { added, removed };
}
```

Apply the identical `for (const t of drop) scrubTileReferences(sheet, t.id);` addition to `resizeGridRows`'s `delta < 0` branch.

In `js/ui/tilemode.js`, import `scrubTileReferences` and call it from `deleteTile`'s `do()` (both the initial delete and — since `do()` must be idempotent/re-callable on redo per this codebase's command idiom — it's safe to call every time `do()` runs, since scrubbing an already-scrubbed reference is a no-op):

```js
import { scrubTileReferences } from '../core/model.js';
```

```js
function deleteTile(sheet, tileId) {
  const tile = sheet.tiles.find(t => t.id === tileId);
  if (!tile || tile.gridId != null) return;
  const idx = sheet.tiles.indexOf(tile);
  const wasSelected = state.selectedTileId === tileId;
  state.commands.push({
    label: 'delete tile',
    do() {
      sheet.tiles = sheet.tiles.filter(t => t !== tile);
      scrubTileReferences(sheet, tile.id);
      if (state.selectedTileId === tile.id) state.selectedTileId = null;
    },
    undo() {
      sheet.tiles.splice(Math.min(idx, sheet.tiles.length), 0, tile);
      if (wasSelected) state.selectedTileId = tile.id;
    },
  });
  markDirty();
  emit('selection');
}
```

Note: `undo()` restores the tile record itself but intentionally does NOT restore whatever got scrubbed from other tiles' `neighbors`/terrain-set `slots` — this mirrors the existing, already-accepted behavior of this codebase's "eager mutate" commands where a destructive side effect on OTHER records isn't independently undo-tracked (the same way `commitSwapTile`'s pixel patches are the only thing snapshotted, not every possible cross-tile metadata implication). This is fine: scrubbing only ever fires when a tile is actually gone, and redoing the delete would scrub it again identically.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -15`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add js/core/model.js js/core/tilegrids.js js/ui/tilemode.js tests/model.test.mjs tests/tilegrids.test.mjs
git commit -m "fix: scrub dangling neighbor/terrain-set references on tile removal"
```

---

### Task 4: `js/core/terrainsets.js` — CRUD + slot mutation

**Files:**
- Create: `js/core/terrainsets.js`
- Test: `tests/terrainsets.test.mjs`

**Interfaces:**
- Consumes: `newId` from `js/core/palettes.js` (existing id-generation helper, same one `tilegrids.js` uses).
- Produces: `createTerrainSet`, `removeTerrainSet`, `assignSlot`, `clearSlot`, `detachFromTerrainSetIfMismatched`, `applyLayoutPreset`, `saveLayoutPreset` — all consumed by Task 5's `tilemode.js` command wrappers.

- [ ] **Step 1: Write the failing test**

Create `tests/terrainsets.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet } from '../js/core/model.js';
import {
  createTerrainSet, removeTerrainSet, assignSlot, clearSlot,
  detachFromTerrainSetIfMismatched, applyLayoutPreset, saveLayoutPreset,
} from '../js/core/terrainsets.js';

function tileSheet() {
  const p = createProject('t');
  return createSheet(p, { name: 'Tiles', width: 64, height: 64, kind: 'tile' });
}

function tile(id, w = 16, h = 16) {
  return { id, x: 0, y: 0, w, h, name: undefined, gridId: null, neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined };
}

test('createTerrainSet pushes a set with empty slots and symmetry off', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  assert.equal(s.terrainSets.length, 1);
  assert.deepEqual(ts.slots, {});
  assert.deepEqual(ts.symmetry, { flip: false, rotate: false });
});

test('assignSlot sets both directions of the reference and enforces exclusivity', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const t = tile('t1');
  s.tiles.push(t);
  assignSlot(s, ts, 5, t);
  assert.equal(ts.slots[5], 't1');
  assert.equal(t.terrainSetId, ts.id);
  assert.equal(t.blobIndex, 5);

  // Reassigning the same tile into a different slot clears the old one.
  assignSlot(s, ts, 9, t);
  assert.equal(ts.slots[5], undefined);
  assert.equal(ts.slots[9], 't1');
  assert.equal(t.blobIndex, 9);
});

test('assignSlot clears the PREVIOUS OCCUPANT\'s back-reference when a different tile takes its slot', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const tileX = tile('tx');
  const tileY = tile('ty');
  s.tiles.push(tileX, tileY);
  assignSlot(s, ts, 5, tileX);
  assignSlot(s, ts, 5, tileY); // tileY takes over slot 5 from tileX
  assert.equal(ts.slots[5], 'ty');
  assert.equal(tileY.terrainSetId, ts.id);
  assert.equal(tileY.blobIndex, 5);
  // tileX must no longer claim slot 5 -- this is the bug this test guards
  // against: assignSlot only clearing the NEW tile's own previous slot,
  // and forgetting to clear the slot's PREVIOUS OCCUPANT's back-reference.
  assert.equal(tileX.terrainSetId, undefined);
  assert.equal(tileX.blobIndex, undefined);
});

test('assignSlot clears the tile\'s slot in a DIFFERENT terrain set too', () => {
  const s = tileSheet();
  const tsA = createTerrainSet(s, { name: 'A', tileW: 16, tileH: 16 });
  const tsB = createTerrainSet(s, { name: 'B', tileW: 16, tileH: 16 });
  const t = tile('t1');
  s.tiles.push(t);
  assignSlot(s, tsA, 0, t);
  assignSlot(s, tsB, 0, t);
  assert.deepEqual(tsA.slots, {});
  assert.equal(tsB.slots[0], 't1');
  assert.equal(t.terrainSetId, tsB.id);
});

test('clearSlot removes the assignment and the tile\'s back-reference', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const t = tile('t1');
  s.tiles.push(t);
  assignSlot(s, ts, 5, t);
  clearSlot(ts, 5, t);
  assert.equal(ts.slots[5], undefined);
  assert.equal(t.terrainSetId, undefined);
  assert.equal(t.blobIndex, undefined);
});

test('removeTerrainSet clears every referencing tile\'s back-ref, tiles survive', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const t = tile('t1');
  s.tiles.push(t);
  assignSlot(s, ts, 5, t);
  removeTerrainSet(s, ts.id);
  assert.equal(s.terrainSets.length, 0);
  assert.equal(s.tiles.length, 1);
  assert.equal(t.terrainSetId, undefined);
  assert.equal(t.blobIndex, undefined);
});

test('detachFromTerrainSetIfMismatched clears the slot when tile size no longer matches', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const t = tile('t1');
  s.tiles.push(t);
  assignSlot(s, ts, 5, t);
  t.w = 8; // resized, no longer matches ts.tileW
  detachFromTerrainSetIfMismatched(s, t);
  assert.equal(t.terrainSetId, undefined);
  assert.equal(ts.slots[5], undefined);
});

test('detachFromTerrainSetIfMismatched is a no-op when size still matches', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const t = tile('t1');
  s.tiles.push(t);
  assignSlot(s, ts, 5, t);
  detachFromTerrainSetIfMismatched(s, t);
  assert.equal(t.terrainSetId, ts.id);
});

test('applyLayoutPreset assigns each cell\'s blobIndex to the tile at that col/row', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const grid = [tile('t00'), tile('t10'), tile('t01'), tile('t11')]; // 2x2, row-major
  s.tiles.push(...grid);
  const preset = { id: 'p1', name: 'Test', cols: 2, rows: 2, cells: [{ col: 1, row: 0, blobIndex: 3 }, { col: 0, row: 1, blobIndex: 7 }] };
  applyLayoutPreset(s, ts, preset, grid, 2);
  assert.equal(ts.slots[3], 't10');
  assert.equal(ts.slots[7], 't01');
});

test('applyLayoutPreset skips a source tile whose size doesn\'t match the terrain set', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const grid = [tile('t00', 8, 8)]; // wrong size
  s.tiles.push(...grid);
  const preset = { id: 'p1', name: 'Test', cols: 1, rows: 1, cells: [{ col: 0, row: 0, blobIndex: 0 }] };
  applyLayoutPreset(s, ts, preset, grid, 1);
  assert.deepEqual(ts.slots, {});
});

test('saveLayoutPreset pushes a named preset onto sheet.terrainLayoutPresets', () => {
  const s = tileSheet();
  const preset = saveLayoutPreset(s, 'My layout', 2, 2, [{ col: 0, row: 0, blobIndex: 0 }]);
  assert.equal(s.terrainLayoutPresets.length, 1);
  assert.equal(s.terrainLayoutPresets[0].name, 'My layout');
  assert.equal(preset.id, s.terrainLayoutPresets[0].id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/terrainsets.test.mjs`
Expected: FAIL — module `../js/core/terrainsets.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `js/core/terrainsets.js`:

```js
// Terrain set CRUD + slot mutation helpers. Mirrors js/core/tilegrids.js's
// role: pure, DOM-free, mutates the sheet directly (the eager-mutate half
// of this codebase's do()-then-snapshot command idiom — js/ui/tilemode.js
// wraps these with state.commands.push()).
import { newId } from './palettes.js';

export function createTerrainSet(sheet, { name, tileW, tileH }) {
  const ts = { id: newId('ts'), name, tileW, tileH, slots: {}, symmetry: { flip: false, rotate: false } };
  sheet.terrainSets.push(ts);
  return ts;
}

// Clears the terrainSetId/blobIndex back-reference on every tile that
// pointed at this set (tiles survive — same "metadata goes away, pixels
// don't" convention as removeTileGrid).
export function removeTerrainSet(sheet, terrainSetId) {
  sheet.terrainSets = sheet.terrainSets.filter(ts => ts.id !== terrainSetId);
  for (const tile of sheet.tiles) {
    if (tile.terrainSetId === terrainSetId) {
      tile.terrainSetId = undefined;
      tile.blobIndex = undefined;
    }
  }
}

// Assigns `tile` into `terrainSet`'s `blobIndex` slot, explicitly. Enforces
// exclusivity in BOTH directions: if `tile` currently occupies a different
// slot (this set or another), that slot is vacated first; and if `blobIndex`
// currently holds a DIFFERENT tile, that former occupant's own
// terrainSetId/blobIndex back-reference is cleared too (otherwise it would
// keep claiming a slot the terrain set's `slots` map no longer agrees it
// owns -- a real bug caught during this plan's self-review, not a
// hypothetical: without this, two tiles could each claim the same
// {terrainSet, blobIndex} pair -- see the "assignSlot clears the PREVIOUS
// OCCUPANT's back-reference" test above).
export function assignSlot(sheet, terrainSet, blobIndex, tile) {
  const previousOccupantId = terrainSet.slots[blobIndex];
  if (previousOccupantId != null && previousOccupantId !== tile.id) {
    const previousOccupant = sheet.tiles.find(t => t.id === previousOccupantId);
    if (previousOccupant && previousOccupant.terrainSetId === terrainSet.id && previousOccupant.blobIndex === blobIndex) {
      previousOccupant.terrainSetId = undefined;
      previousOccupant.blobIndex = undefined;
    }
  }
  if (tile.terrainSetId != null) {
    const owner = sheet.terrainSets.find(ts => ts.id === tile.terrainSetId);
    if (owner) {
      for (const idx of Object.keys(owner.slots)) {
        if (owner.slots[idx] === tile.id) delete owner.slots[idx];
      }
    }
  }
  terrainSet.slots[blobIndex] = tile.id;
  tile.terrainSetId = terrainSet.id;
  tile.blobIndex = blobIndex;
}

// Clears an explicit slot assignment. If `tile` is given and still points
// at this exact slot, its back-reference is cleared too (it may already
// have been reassigned elsewhere, in which case leave it alone).
export function clearSlot(terrainSet, blobIndex, tile) {
  delete terrainSet.slots[blobIndex];
  if (tile && tile.terrainSetId === terrainSet.id && tile.blobIndex === blobIndex) {
    tile.terrainSetId = undefined;
    tile.blobIndex = undefined;
  }
}

// Called after a tile's own w/h changes (standalone tile resize) — if it
// no longer matches its terrain set's tileW/tileH, auto-detach it.
export function detachFromTerrainSetIfMismatched(sheet, tile) {
  if (tile.terrainSetId == null) return;
  const ts = sheet.terrainSets.find(t => t.id === tile.terrainSetId);
  if (!ts || (tile.w === ts.tileW && tile.h === ts.tileH)) return;
  clearSlot(ts, tile.blobIndex, tile);
}

// Applies a saved layout preset against a same-shaped source region:
// `sourceTiles` is a flat, row-major array of tiles (`cols` wide) — each
// preset cell's blobIndex is assigned to the tile at that (col, row).
// Silently skips a cell whose source tile is missing or size-mismatched.
export function applyLayoutPreset(sheet, terrainSet, preset, sourceTiles, cols) {
  for (const cell of preset.cells) {
    const t = sourceTiles[cell.row * cols + cell.col];
    if (t && t.w === terrainSet.tileW && t.h === terrainSet.tileH) {
      assignSlot(sheet, terrainSet, cell.blobIndex, t);
    }
  }
}

// Captures a `{col,row} -> blobIndex` mapping as a new named, reusable
// preset. `cells` is built by the caller (it needs grid-specific context —
// which (col,row) each currently-assigned tile sits at within the source
// region the user picked when saving).
export function saveLayoutPreset(sheet, name, cols, rows, cells) {
  const preset = { id: newId('tlp'), name, cols, rows, cells };
  sheet.terrainLayoutPresets.push(preset);
  return preset;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/terrainsets.test.mjs`
Expected: PASS. Then `npm test 2>&1 | tail -15` — full suite still green.

- [ ] **Step 5: Commit**

```bash
git add js/core/terrainsets.js tests/terrainsets.test.mjs
git commit -m "feat: add core/terrainsets.js -- terrain set CRUD + slot mutation"
```

---

### Task 5: Wire terrain-set commands into `tilemode.js`

**Files:**
- Modify: `js/ui/tilemode.js`

**Interfaces:**
- Consumes: everything from Task 4's `js/core/terrainsets.js`, plus `resolveTerrainSlot` from Task 2's `js/core/blob47.js` (used by the "Save current as preset" reverse-mapping, described below).
- Produces: `commitAddTerrainSet`, `commitDeleteTerrainSet`, `commitRenameTerrainSet`, `commitAssignSlot`, `commitClearSlot`, `commitSetSymmetry`, `commitApplyLayoutPreset`, `commitSaveLayoutPreset` — all consumed by Task 6's panel UI. Also wires `detachFromTerrainSetIfMismatched` into the existing `commitTileSize`.

This task has no new automated tests of its own — these are thin `state.commands.push()` wrappers around Task 4's already-tested pure functions, exactly like `commitAddGrid` wraps `createTileGrid` (which also has no dedicated command-level test; the coverage is at the `tilegrids.js` level plus the manual smoke pass in Task 10). Verify by running the full suite (nothing here should break anything) and by the manual smoke items Task 10 adds.

- [ ] **Step 1: Add the command wrappers**

In `js/ui/tilemode.js`, extend the import block:

```js
import {
  gridCellRect, ownedTiles, relayoutGrid, resizeGridCols, resizeGridRows,
  moveGrid, removeTileGrid, createTileGrid, detachTile,
} from '../core/tilegrids.js';
import {
  createTerrainSet, removeTerrainSet, assignSlot, clearSlot,
  detachFromTerrainSetIfMismatched, applyLayoutPreset, saveLayoutPreset,
} from '../core/terrainsets.js';
import { scrubTileReferences } from '../core/model.js';
```

Add the command functions (near the other `commit*` functions, after `commitDetachTile`):

```js
function commitAddTerrainSet(sheet, opts) {
  const before = sheet.terrainSets.slice();
  createTerrainSet(sheet, opts);
  const after = sheet.terrainSets.slice();
  state.commands.push({
    label: 'add terrain set',
    do() { sheet.terrainSets = after.slice(); },
    undo() { sheet.terrainSets = before.slice(); },
  });
  markDirty();
}

function commitDeleteTerrainSet(sheet, terrainSetId) {
  const beforeSets = sheet.terrainSets.slice();
  const beforeTiles = sheet.tiles.map(t => ({ t, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  removeTerrainSet(sheet, terrainSetId);
  const afterSets = sheet.terrainSets.slice();
  state.commands.push({
    label: 'delete terrain set',
    do() {
      sheet.terrainSets = afterSets.slice();
      for (const b of beforeTiles) if (b.terrainSetId === terrainSetId) { b.t.terrainSetId = undefined; b.t.blobIndex = undefined; }
    },
    undo() {
      sheet.terrainSets = beforeSets.slice();
      for (const b of beforeTiles) { b.t.terrainSetId = b.terrainSetId; b.t.blobIndex = b.blobIndex; }
    },
  });
  markDirty();
}

function commitRenameTerrainSet(terrainSet, name) {
  const before = terrainSet.name;
  const after = name || before;
  if (before === after) return;
  state.commands.push({
    label: 'rename terrain set',
    do() { terrainSet.name = after; },
    undo() { terrainSet.name = before; },
  });
  markDirty();
}

function commitAssignSlot(sheet, terrainSet, blobIndex, tile) {
  const beforeTiles = sheet.tiles.map(t => ({ t, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  const beforeSlots = { ...terrainSet.slots };
  assignSlot(sheet, terrainSet, blobIndex, tile);
  const afterSlots = { ...terrainSet.slots };
  const afterTileState = { terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex };
  state.commands.push({
    label: 'assign terrain slot',
    do() {
      terrainSet.slots = { ...afterSlots };
      tile.terrainSetId = afterTileState.terrainSetId;
      tile.blobIndex = afterTileState.blobIndex;
    },
    undo() {
      terrainSet.slots = { ...beforeSlots };
      for (const b of beforeTiles) { b.t.terrainSetId = b.terrainSetId; b.t.blobIndex = b.blobIndex; }
    },
  });
  markDirty();
}

function commitClearSlot(terrainSet, blobIndex, tile) {
  const beforeSlots = { ...terrainSet.slots };
  const before = { terrainSetId: tile?.terrainSetId, blobIndex: tile?.blobIndex };
  clearSlot(terrainSet, blobIndex, tile);
  const afterSlots = { ...terrainSet.slots };
  state.commands.push({
    label: 'clear terrain slot',
    do() {
      terrainSet.slots = { ...afterSlots };
      if (tile) { tile.terrainSetId = undefined; tile.blobIndex = undefined; }
    },
    undo() {
      terrainSet.slots = { ...beforeSlots };
      if (tile) { tile.terrainSetId = before.terrainSetId; tile.blobIndex = before.blobIndex; }
    },
  });
  markDirty();
}

function commitSetSymmetry(terrainSet, key, value) {
  if (terrainSet.symmetry[key] === value) return;
  const before = terrainSet.symmetry[key];
  state.commands.push({
    label: `set terrain symmetry ${key}`,
    do() { terrainSet.symmetry[key] = value; },
    undo() { terrainSet.symmetry[key] = before; },
  });
  markDirty();
}

function commitApplyLayoutPreset(sheet, terrainSet, preset, sourceTiles, cols) {
  const beforeSlots = { ...terrainSet.slots };
  const beforeTiles = sheet.tiles.map(t => ({ t, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  applyLayoutPreset(sheet, terrainSet, preset, sourceTiles, cols);
  const afterSlots = { ...terrainSet.slots };
  const afterTiles = sheet.tiles.map(t => ({ terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  state.commands.push({
    label: 'import terrain layout',
    do() {
      terrainSet.slots = { ...afterSlots };
      sheet.tiles.forEach((t, i) => { t.terrainSetId = afterTiles[i].terrainSetId; t.blobIndex = afterTiles[i].blobIndex; });
    },
    undo() {
      terrainSet.slots = { ...beforeSlots };
      for (const b of beforeTiles) { b.t.terrainSetId = b.terrainSetId; b.t.blobIndex = b.blobIndex; }
    },
  });
  markDirty();
}

// Save-as-preset is metadata-only bookkeeping (terrainLayoutPresets), not
// worth undo tracking on its own -- it doesn't touch tiles/terrainSets.
function commitSaveLayoutPreset(sheet, name, cols, rows, cells) {
  saveLayoutPreset(sheet, name, cols, rows, cells);
  markDirty();
  emit('project');
}
```

- [ ] **Step 2: Wire auto-detach into `commitTileSize`**

Modify the existing `commitTileSize` (around line 350-359) so a standalone tile's W/H edit also auto-detaches it from a terrain set it no longer matches:

```js
function commitTileSize(sheet, tile, key, value) {
  if (tile[key] === value) return;
  const before = { size: tile[key], terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex };
  state.commands.push({
    label: `edit tile ${key}`,
    do() {
      tile[key] = value;
      detachFromTerrainSetIfMismatched(sheet, tile);
    },
    undo() {
      tile[key] = before.size;
      tile.terrainSetId = before.terrainSetId;
      tile.blobIndex = before.blobIndex;
    },
  });
  markDirty();
}
```

This changes `commitTileSize`'s signature (adds a leading `sheet` parameter) — update its two call sites in `mountTilePanel`'s `render()` (lines 754-756, the `sizeField('W', tile.w, ...)` / `sizeField('H', tile.h, ...)` calls) to pass `sheet`:

```js
      selRow.append(
        sizeField('W', tile.w, (v) => commitTileSize(sheet, tile, 'w', v)),
        sizeField('H', tile.h, (v) => commitTileSize(sheet, tile, 'h', v)),
      );
```

- [ ] **Step 3: Run the full suite**

Run: `npm test 2>&1 | tail -15`
Expected: PASS, full suite green (these are new, currently-unused-by-UI functions plus one signature change with both call sites updated — nothing should regress).

- [ ] **Step 4: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "feat: wire terrain-set commands + auto-detach-on-resize into tilemode.js"
```

---

### Task 6: Terrain Sets panel UI

**Files:**
- Modify: `js/ui/tilemode.js` (`mountTilePanel`)
- Modify: `js/app/state.js` (add `selectedTerrainSetId`)
- Modify: `css/app.css`

**Interfaces:**
- Consumes: Task 5's command wrappers, Task 2's `blobIndexToMask`/`SIXTEEN_TILE_INDICES`/`resolveTerrainSlot`/`NEIGHBOR_BITS`.
- Produces: the visible Terrain Sets list + slot editor, and the `state.selectedTerrainSetId` UI-selection field other tasks don't need.

No new automated test — this is DOM construction verified by the manual smoke pass (Task 10) and a live Playwright check at the end of this task (drag gestures excluded, per this project's testing convention — clicking, typing, and checkbox toggles are all fine to verify live).

- [ ] **Step 1: Add `selectedTerrainSetId` to state**

In `js/app/state.js`, add alongside `selectedTileId` (line 21):

```js
  selectedTileId: null,       // tile tool selection (tile mode)
  selectedTerrainSetId: null, // which terrain set's slot editor is open in the panel
```

- [ ] **Step 2: Add CSS**

In `css/app.css`, add near the existing `.tile-grid-list`/`.frame-field` rules:

```css
.terrain-set-list .row { justify-content: space-between; }
.terrain-slot-group { display: flex; gap: 4px; flex-wrap: wrap; margin: 4px 0; }
.terrain-slot { width: 28px; height: 28px; border: 1px solid #444; cursor: pointer; position: relative; background-size: cover; }
.terrain-slot.core { border-color: #4f8cff; border-width: 2px; }
.terrain-slot.derived { border-style: dashed; }
.terrain-slot .badge { position: absolute; bottom: 0; right: 0; font-size: 8px; background: #000a; color: #fff; padding: 0 2px; }
```

- [ ] **Step 3: Build the Terrain Sets list, Add dialog, and slot editor**

In `js/ui/tilemode.js`, import the new pieces (extending the imports from Task 5):

```js
import {
  NEIGHBOR_BITS, blobIndexToMask, SIXTEEN_TILE_INDICES, resolveTerrainSlot,
} from '../core/blob47.js';
```

Add a helper that groups the 47 canonical indices by neighbor-count (the "staircase" grouping), placed near the top of the file's geometry section:

```js
// Groups the 47 canonical blob indices by how many of the 8 bits are set
// in their representative mask (the "staircase" layout: isolated alone,
// then single-edge variants, etc, up to the full 8-neighbor surround).
function blobStaircaseGroups() {
  const groups = new Map();
  blobIndexToMask.forEach((mask, blobIndex) => {
    let count = 0;
    for (let b = 1; b <= 128; b <<= 1) if (mask & b) count++;
    if (!groups.has(count)) groups.set(count, []);
    groups.get(count).push(blobIndex);
  });
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, indices]) => indices);
}

function describeMask(mask) {
  const names = { [NEIGHBOR_BITS.N]: 'N', [NEIGHBOR_BITS.NE]: 'NE', [NEIGHBOR_BITS.E]: 'E', [NEIGHBOR_BITS.SE]: 'SE', [NEIGHBOR_BITS.S]: 'S', [NEIGHBOR_BITS.SW]: 'SW', [NEIGHBOR_BITS.W]: 'W', [NEIGHBOR_BITS.NW]: 'NW' };
  const parts = Object.keys(names).filter(b => mask & Number(b)).map(b => names[b]);
  return parts.length ? parts.join(' + ') : 'isolated';
}
```

Add the Add Terrain Set dialog builder (mirrors `buildAddGridDialog`):

```js
function buildAddTerrainSetDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Add terrain set</h3>
    <div class="row"><label>Name <input type="text" id="ats-name" value="Terrain"></label></div>
    <div class="row"><label>Tile W <input type="number" id="ats-tilew" min="1" value="16"></label></div>
    <div class="row"><label>Tile H <input type="number" id="ats-tileh" min="1" value="16"></label></div>
    <div class="row"><button type="button" id="ats-create">Create</button><button type="button" id="ats-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  $('#ats-cancel').addEventListener('click', () => dlg.close());
  $('#ats-create').addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) { dlg.close(); return; }
    const intVal = (el) => Math.max(1, parseInt(el.value, 10) || 1);
    commitAddTerrainSet(sheet, {
      name: $('#ats-name').value.trim() || 'Terrain',
      tileW: intVal($('#ats-tilew')), tileH: intVal($('#ats-tileh')),
    });
    dlg.close();
  });
  return {
    open() {
      const settings = state.project?.settings ?? {};
      $('#ats-tilew').value = String(settings.tileW ?? 16);
      $('#ats-tileh').value = String(settings.tileH ?? 16);
      dlg.showModal();
    },
  };
}
```

Add a small tile-picker dialog reused for slot assignment (mirrors the `<select>`-based picker already in `tileeditor.js`'s neighbor slot dialog):

```js
function buildTilePickerDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Assign tile</h3>
    <div class="row"><label>Tile <select id="tp-select"></select></label></div>
    <div class="row"><button type="button" id="tp-ok">OK</button><button type="button" id="tp-clear">Clear</button><button type="button" id="tp-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  let onPick = null, onClear = null;
  $('#tp-cancel').addEventListener('click', () => dlg.close());
  $('#tp-ok').addEventListener('click', () => { onPick?.($('#tp-select').value); dlg.close(); });
  $('#tp-clear').addEventListener('click', () => { onClear?.(); dlg.close(); });
  return {
    open(sheet, terrainSet, currentTileId, pick, clear) {
      onPick = pick; onClear = clear;
      const select = $('#tp-select');
      select.innerHTML = '';
      sheet.tiles
        .filter(t => t.w === terrainSet.tileW && t.h === terrainSet.tileH)
        .forEach((t, i) => {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = t.name ? `${i}: ${t.name}` : `#${i}`;
          select.appendChild(opt);
        });
      if (currentTileId) select.value = currentTileId;
      dlg.showModal();
    },
  };
}
```

Add the slot editor renderer (called from the panel's `render()`, replacing the tile-detail section when a terrain set is selected):

```js
function renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog) {
  container.innerHTML = '';

  const symRow = document.createElement('div');
  symRow.className = 'row';
  const flipCb = document.createElement('input'); flipCb.type = 'checkbox'; flipCb.checked = terrainSet.symmetry.flip;
  flipCb.addEventListener('change', () => commitSetSymmetry(terrainSet, 'flip', flipCb.checked));
  const rotCb = document.createElement('input'); rotCb.type = 'checkbox'; rotCb.checked = terrainSet.symmetry.rotate;
  rotCb.addEventListener('change', () => commitSetSymmetry(terrainSet, 'rotate', rotCb.checked));
  const flipLabel = document.createElement('label'); flipLabel.append(flipCb, document.createTextNode(' Allow flip'));
  const rotLabel = document.createElement('label'); rotLabel.append(rotCb, document.createTextNode(' Allow rotation'));
  symRow.append(flipLabel, rotLabel);
  container.appendChild(symRow);

  for (const group of blobStaircaseGroups()) {
    const groupRow = document.createElement('div');
    groupRow.className = 'terrain-slot-group';
    for (const blobIndex of group) {
      const resolved = resolveTerrainSlot(terrainSet, blobIndex);
      const isExplicit = terrainSet.slots[blobIndex] != null;
      const cell = document.createElement('div');
      cell.className = 'terrain-slot';
      if (SIXTEEN_TILE_INDICES.has(blobIndex)) cell.classList.add('core');
      if (resolved && !isExplicit) cell.classList.add('derived');

      const mask = blobIndexToMask[blobIndex];
      let title = describeMask(mask);
      if (resolved && !isExplicit) title += ` (derived: flipH=${resolved.flipH}, rotate=${resolved.rotate})`;
      cell.title = title;

      if (resolved) {
        const tile = sheet.tiles.find(t => t.id === resolved.tileId);
        if (tile) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = (resolved.flipH || resolved.flipV) ? 'F' : (resolved.rotate ? `${resolved.rotate}°` : '');
          cell.appendChild(badge);
        }
      }

      cell.addEventListener('click', () => {
        tilePickerDialog.open(sheet, terrainSet, terrainSet.slots[blobIndex] ?? null,
          (tileId) => {
            const tile = sheet.tiles.find(t => t.id === tileId);
            if (tile) commitAssignSlot(sheet, terrainSet, blobIndex, tile);
          },
          () => {
            const owner = sheet.tiles.find(t => t.id === terrainSet.slots[blobIndex]);
            commitClearSlot(terrainSet, blobIndex, owner);
          });
      });
      groupRow.appendChild(cell);
    }
    container.appendChild(groupRow);
  }
}
```

Now wire it all into `mountTilePanel`. Add the Terrain Sets list section (after the existing grid list / Add Grid button, before `countRow`):

```js
  const addTerrainSetDialog = buildAddTerrainSetDialog();
  const tilePickerDialog = buildTilePickerDialog();

  const terrainSetList = document.createElement('div');
  terrainSetList.className = 'terrain-set-list';
  wrap.appendChild(terrainSetList);

  const btnAddTerrainSet = document.createElement('button');
  btnAddTerrainSet.type = 'button';
  btnAddTerrainSet.textContent = 'Add Terrain Set…';
  btnAddTerrainSet.addEventListener('click', () => { if (activeSheet()) addTerrainSetDialog.open(); });
  wrap.appendChild(btnAddTerrainSet);

  const terrainSetEditor = document.createElement('div');
  terrainSetEditor.className = 'terrain-set-editor';
  wrap.appendChild(terrainSetEditor);
```

In `render()`, after the existing grid-list loop, render the terrain-set rows and (if one is selected) its editor:

```js
    terrainSetList.innerHTML = '';
    for (const ts of sheet.terrainSets) {
      const row = document.createElement('div');
      row.className = 'row terrain-set-row';
      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.textContent = `${ts.name} (${ts.tileW}×${ts.tileH})`;
      nameBtn.addEventListener('click', () => {
        state.selectedTerrainSetId = state.selectedTerrainSetId === ts.id ? null : ts.id;
        schedule();
      });
      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.textContent = 'Delete';
      btnDel.addEventListener('click', () => {
        commitDeleteTerrainSet(sheet, ts.id);
        if (state.selectedTerrainSetId === ts.id) state.selectedTerrainSetId = null;
      });
      row.append(nameBtn, btnDel);
      terrainSetList.appendChild(row);
    }

    const selectedTerrainSet = sheet.terrainSets.find(ts => ts.id === state.selectedTerrainSetId);
    terrainSetEditor.innerHTML = '';
    if (selectedTerrainSet) {
      renderTerrainSetEditor(terrainSetEditor, sheet, selectedTerrainSet, tilePickerDialog);
    }
```

(`schedule` is the existing debounced re-render function already defined at the bottom of `mountTilePanel` — since it's declared with `function schedule()` further down in the same function body, it's hoisted and callable from `render()`'s closures without reordering anything.)

- [ ] **Step 4: Manual verification**

Start the dev server (`./serve.ps1` or `python -m http.server 8080`), load pixelartist with `?autotest` (per this project's convention — suppresses dialogs that would otherwise stall automated checks), switch to the Tiles tab, and verify via Playwright (clicks/typing only, no simulated drags per this project's testing convention):
- "Add Terrain Set…" creates a set, appears in the list.
- Clicking the set's name row opens the slot editor below it with all 47 slots, grouped in ascending neighbor-count rows.
- The 16 core slots show the blue "core" border.
- Clicking an empty slot opens the tile picker; assigning a tile fills that slot's thumbail state (verify via DOM inspection of the cell's class/title, since there's no rendered thumbnail image yet in this task — that's cosmetic polish, not required for this task's functional scope).
- Toggling "Allow rotation" causes other slots in the same cardinal family to gain the `derived` class/title.

- [ ] **Step 5: Commit**

```bash
git add js/ui/tilemode.js js/app/state.js css/app.css
git commit -m "feat: add Terrain Sets panel -- list, Add dialog, 47-slot staircase editor"
```

---

### Task 7: Layout presets (Import / Save as preset) + Layers list + tile detail Layer/Tags fields

**Files:**
- Modify: `js/ui/tilemode.js`

**Interfaces:**
- Consumes: Task 5's `commitApplyLayoutPreset`/`commitSaveLayoutPreset`, Task 4's data shapes.
- Produces: the two built-in layout presets, the import/save UI, the Layers management list, and the tile detail panel's Layer dropdown + Tags input.

- [ ] **Step 1: Define the two built-in presets**

Add near the top of `js/ui/tilemode.js` (module-level constant, not sheet data — these are pixelartist's own deterministic orderings, not tied to any sheet):

```js
// Built-in layout presets: pixelartist's own deterministic ascending-index
// ordering at two common grid shapes (NOT a byte-for-byte reproduction of
// any specific external tool's template image -- see the design spec for
// why that couldn't be reliably verified). "Save current as preset" is the
// supported path for matching a layout the user already has.
const BUILTIN_LAYOUT_PRESETS = [
  {
    name: 'Blob-47 (6×8, ascending)', cols: 6, rows: 8,
    cells: Array.from({ length: 47 }, (_, i) => ({ col: i % 6, row: Math.floor(i / 6), blobIndex: i })),
  },
  {
    name: '16-tile (4×4, ascending)', cols: 4, rows: 4,
    cells: Array.from({ length: 16 }, (_, i) => ({ col: i % 4, row: Math.floor(i / 4), blobIndex: [...SIXTEEN_TILE_INDICES][i] })),
  },
];
```

- [ ] **Step 2: Add Import/Save UI to the terrain-set editor**

Extend `renderTerrainSetEditor` (from Task 6) to prepend an import/save row before the symmetry checkboxes. This needs a way to pick a "source region": for simplicity, the source is always the currently-selected tile grid (via a `<select>` of `sheet.tileGrids` filtered to ones whose `cols*rows` matches the preset's `cols*rows`, or — for saving — any grid at all, using its own `cols`/`rows`):

```js
function renderLayoutPresetRow(container, sheet, terrainSet) {
  const row = document.createElement('div');
  row.className = 'row';

  const presetSelect = document.createElement('select');
  const allPresets = [...BUILTIN_LAYOUT_PRESETS, ...sheet.terrainLayoutPresets];
  allPresets.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${p.name} (${p.cols}×${p.rows})`;
    presetSelect.appendChild(opt);
  });

  const gridSelect = document.createElement('select');
  sheet.tileGrids.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = `Grid ${g.cols}×${g.rows} @ (${g.x},${g.y})`;
    gridSelect.appendChild(opt);
  });

  const btnImport = document.createElement('button');
  btnImport.type = 'button';
  btnImport.textContent = 'Import from layout…';
  btnImport.addEventListener('click', () => {
    const preset = allPresets[Number(presetSelect.value)];
    const grid = sheet.tileGrids.find(g => g.id === gridSelect.value);
    if (!preset || !grid || grid.cols !== preset.cols || grid.rows !== preset.rows) {
      alert(`Selected grid must be exactly ${preset?.cols ?? '?'}×${preset?.rows ?? '?'} to use this layout.`);
      return;
    }
    const sourceTiles = ownedTiles(sheet, grid.id).sort((a, b) => (a.gridRow - b.gridRow) || (a.gridCol - b.gridCol));
    commitApplyLayoutPreset(sheet, terrainSet, preset, sourceTiles, grid.cols);
  });

  const btnSave = document.createElement('button');
  btnSave.type = 'button';
  btnSave.textContent = 'Save current as preset…';
  btnSave.addEventListener('click', () => {
    const grid = sheet.tileGrids.find(g => g.id === gridSelect.value);
    if (!grid) { alert('Select a grid to save its current slot layout as a preset.'); return; }
    const name = prompt('Preset name?');
    if (!name) return;
    const sourceTiles = ownedTiles(sheet, grid.id).sort((a, b) => (a.gridRow - b.gridRow) || (a.gridCol - b.gridCol));
    const cells = [];
    sourceTiles.forEach((t, i) => {
      if (t.terrainSetId === terrainSet.id && t.blobIndex != null) {
        cells.push({ col: i % grid.cols, row: Math.floor(i / grid.cols), blobIndex: t.blobIndex });
      }
    });
    commitSaveLayoutPreset(sheet, name, grid.cols, grid.rows, cells);
  });

  row.append(presetSelect, gridSelect, btnImport, btnSave);
  container.appendChild(row);
}
```

Call it from `renderTerrainSetEditor` (Task 6), right after `container.innerHTML = '';`:

```js
  renderLayoutPresetRow(container, sheet, terrainSet);
```

Import `SIXTEEN_TILE_INDICES` was already added in Task 6's import block, so `BUILTIN_LAYOUT_PRESETS`'s use of it above works as-is (module evaluation order: `BUILTIN_LAYOUT_PRESETS` is declared after the import statements, so `SIXTEEN_TILE_INDICES` is already bound).

- [ ] **Step 3: Add the Layers management list**

Add near the Terrain Sets list in `mountTilePanel` (after `terrainSetEditor`):

```js
  const layerList = document.createElement('div');
  layerList.className = 'layer-list';
  wrap.appendChild(layerList);

  const btnAddLayerName = document.createElement('button');
  btnAddLayerName.type = 'button';
  btnAddLayerName.textContent = 'Add Layer Name…';
  btnAddLayerName.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) return;
    const name = prompt('Layer name?');
    if (!name) return;
    commitAddLayerName(sheet, name);
  });
  wrap.appendChild(btnAddLayerName);
```

Add its commands (near the other `commit*` functions):

```js
function commitAddLayerName(sheet, name) {
  const before = sheet.layers.slice();
  sheet.layers.push(name);
  const after = sheet.layers.slice();
  state.commands.push({
    label: 'add layer name',
    do() { sheet.layers = after.slice(); },
    undo() { sheet.layers = before.slice(); },
  });
  markDirty();
}

function commitRemoveLayerName(sheet, name) {
  const before = sheet.layers.slice();
  sheet.layers = sheet.layers.filter(l => l !== name);
  for (const t of sheet.tiles) if (t.layer === name) t.layer = undefined;
  const after = sheet.layers.slice();
  const affectedTiles = sheet.tiles.filter(t => t.layer === undefined); // approximation not needed: see note below
  state.commands.push({
    label: 'remove layer name',
    do() {
      sheet.layers = after.slice();
      for (const t of sheet.tiles) if (t.layer === name) t.layer = undefined;
    },
    undo() { sheet.layers = before.slice(); }, // tile.layer reassignment is NOT restored, matching this plan's Task 3 note on scrub-on-delete not being undo-tracked
  });
  markDirty();
}

function commitMoveLayerName(sheet, index, delta) {
  const to = index + delta;
  if (to < 0 || to >= sheet.layers.length) return;
  const before = sheet.layers.slice();
  const arr = sheet.layers.slice();
  [arr[index], arr[to]] = [arr[to], arr[index]];
  const after = arr;
  state.commands.push({
    label: 'reorder layer names',
    do() { sheet.layers = after.slice(); },
    undo() { sheet.layers = before.slice(); },
  });
  markDirty();
}
```

Remove the unused `affectedTiles` line above (it's dead code from an earlier draft) — the final `commitRemoveLayerName` body should be:

```js
function commitRemoveLayerName(sheet, name) {
  const before = sheet.layers.slice();
  const beforeTileLayers = sheet.tiles.map(t => ({ t, layer: t.layer }));
  sheet.layers = sheet.layers.filter(l => l !== name);
  for (const t of sheet.tiles) if (t.layer === name) t.layer = undefined;
  const after = sheet.layers.slice();
  state.commands.push({
    label: 'remove layer name',
    do() {
      sheet.layers = after.slice();
      for (const t of sheet.tiles) if (t.layer === name) t.layer = undefined;
    },
    undo() {
      sheet.layers = before.slice();
      for (const b of beforeTileLayers) b.t.layer = b.layer;
    },
  });
  markDirty();
}
```

Render the layer rows in `render()`:

```js
    layerList.innerHTML = '';
    sheet.layers.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.textContent = name;
      const btnUp = document.createElement('button'); btnUp.type = 'button'; btnUp.textContent = '↑';
      btnUp.addEventListener('click', () => commitMoveLayerName(sheet, i, -1));
      const btnDown = document.createElement('button'); btnDown.type = 'button'; btnDown.textContent = '↓';
      btnDown.addEventListener('click', () => commitMoveLayerName(sheet, i, 1));
      const btnDel = document.createElement('button'); btnDel.type = 'button'; btnDel.textContent = 'Delete';
      btnDel.addEventListener('click', () => commitRemoveLayerName(sheet, name));
      row.append(label, btnUp, btnDown, btnDel);
      layerList.appendChild(row);
    });
```

- [ ] **Step 4: Add Layer dropdown + Tags input to the tile detail panel**

Add commands:

```js
function commitTileLayer(tile, layer) {
  const after = layer || undefined;
  if (tile.layer === after) return;
  const before = tile.layer;
  state.commands.push({
    label: 'set tile layer',
    do() { tile.layer = after; },
    undo() { tile.layer = before; },
  });
  markDirty();
}

function commitTileTags(tile, tagsText) {
  const after = tagsText.split(',').map(s => s.trim()).filter(Boolean);
  const before = tile.tags ? [...tile.tags] : undefined;
  const afterVal = after.length ? after : undefined;
  state.commands.push({
    label: 'set tile tags',
    do() { tile.tags = afterVal ? [...afterVal] : undefined; },
    undo() { tile.tags = before ? [...before] : undefined; },
  });
  markDirty();
}
```

In `render()`, extend the tile-selected branch (after the existing `nameInput`/`btnEdit`/Detach-or-W/H block) so Layer/Tags always show regardless of grid/standalone/terrain status:

```js
    const layerSelect = document.createElement('select');
    const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '(none)';
    layerSelect.appendChild(noneOpt);
    sheet.layers.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      layerSelect.appendChild(opt);
    });
    layerSelect.value = tile.layer ?? '';
    layerSelect.addEventListener('change', () => commitTileLayer(tile, layerSelect.value));

    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.placeholder = 'tags, comma, separated';
    tagsInput.value = (tile.tags ?? []).join(', ');
    tagsInput.addEventListener('change', () => commitTileTags(tile, tagsInput.value));

    selRow.append(layerSelect, tagsInput);
```

(This goes at the end of the existing `if (!tile) { ... return; } ... selRow.append(nameInput, btnEdit); if (tile.gridId != null) { ... } else { ... }` block — after that whole if/else, not inside either branch, since Layer/Tags apply regardless of grid/standalone status.)

- [ ] **Step 5: Run the full suite and manually verify**

Run: `npm test 2>&1 | tail -15` — expected green (no core-module changes in this task, only UI).

Manually verify (same `?autotest` + Playwright convention as Task 6, clicks/typing only): built-in presets appear in the dropdown; importing the "16-tile (4×4)" preset against a matching 4×4 grid fills exactly those 16 slots; "Save current as preset" prompts for a name and adds it to the dropdown; Layers list add/reorder/delete works; selecting a tile shows the Layer dropdown (populated from the Layers list) and Tags input, and both persist across a save/reload cycle if time permits (otherwise this is covered by Task 1's serialization test already).

- [ ] **Step 6: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "feat: add layout-preset import/save, Layers list, tile Layer/Tags fields"
```

---

### Task 8: Tile editor integration — terrain-set tiles use `terrainPreviewCells`

**Files:**
- Modify: `js/ui/tileeditor.js`

**Interfaces:**
- Consumes: `terrainPreviewCells` from `js/core/blob47.js`.

- [ ] **Step 1: Write the failing test**

This is DOM-heavy code without an existing dedicated `tileeditor.test.mjs` (there is none in the current test suite — its behavior has been covered by the Playwright smoke pass since Phase A, per this project's established pattern for canvas-editor code). Continue that pattern: no new automated test file; verify via the manual smoke pass in Step 3, added to `tests/smoke.md` in Task 9... — actually Task 10 in this plan owns `smoke.md`, so this task's manual verification step is folded into Task 10's checklist additions. Skip to Step 2.

- [ ] **Step 2: Modify `view.onPaint` to branch on `terrainSetId`**

In `js/ui/tileeditor.js`, extend the import (line 45):

```js
import { getPreset, setSlot, resolveNeighborGrid } from '../core/neighbors.js';
import { terrainPreviewCells } from '../core/blob47.js';
```

Replace the `view.onPaint` body's cell-resolution lines (lines 200-202):

```js
  view.onPaint = (ctx) => {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t) return;
    const tw = t.w, th = t.h;
    const flat = getFlatCanvas(sheet);
    const cells = t.terrainSetId != null ? terrainPreviewCells(t) : resolveNeighborGrid(getPreset(t), t.id, radius);
```

(`radius` only matters for the manual `resolveNeighborGrid` path — `terrainPreviewCells` always returns exactly the 8 immediate neighbors, which is correct: a terrain tile's own `blobIndex` only encodes its immediate 8-neighbor configuration, there's no "5×5" extension of that concept. If `radius === 2` for a terrain-set tile, the extra ring simply shows nothing beyond the 8 immediate cells — acceptable, since the radius selector's main use case, per the existing feature, is for manually-wired presets that might reference further tiles.)

- [ ] **Step 3: Hide the manual slot dialog for terrain-set tiles, show a label instead**

Extend `updateStrip()` (lines 356-363):

```js
  function updateStrip() {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t) { nameLabel.textContent = ''; return; }
    const idx = sheet.tiles.indexOf(t);
    nameLabel.textContent = t.name ? `Tile ${idx} (${t.name})` : `Tile ${idx}`;
    radiusSelect.value = String(radius);
    if (t.terrainSetId != null) {
      const ts = sheet.terrainSets.find(x => x.id === t.terrainSetId);
      terrainLabel.textContent = ts ? `Terrain: ${ts.name} — neighbors follow the terrain set automatically` : '';
      terrainLabel.hidden = !ts;
    } else {
      terrainLabel.hidden = true;
    }
  }
```

Add the `terrainLabel` element to the top strip (near `nameLabel`'s declaration, around line 83-85):

```js
  const terrainLabel = document.createElement('span');
  terrainLabel.className = 'tile-editor-terrain-label';
  terrainLabel.hidden = true;
```

Append it in the `strip.append(...)` call (line 94):

```js
  strip.append(btnBack, nameLabel, terrainLabel, radiusLabel);
```

Guard `openSlotDialog` so clicking a neighbor cell on a terrain-set tile does nothing (the pointer-routing code that calls it is otherwise unchanged — a terrain tile's cells are display-only):

```js
  function openSlotDialog(dir) {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t || t.terrainSetId != null) return;
    ...
```

- [ ] **Step 4: Run the full suite**

Run: `npm test 2>&1 | tail -15`
Expected: PASS — this task touches no core module, only `tileeditor.js`'s DOM code, so nothing in the automated suite should change.

- [ ] **Step 5: Commit**

```bash
git add js/ui/tileeditor.js
git commit -m "feat: tile editor auto-computes neighbor preview for terrain-set tiles"
```

---

### Task 9: Export (`js/app/exports.js`)

**Files:**
- Modify: `js/app/exports.js` (`buildTilesJson`)
- Test: `tests/exports.test.mjs`

**Interfaces:**
- Consumes: `resolveTerrainSlot` from `js/core/blob47.js`.

- [ ] **Step 1: Write the failing test**

Add to `tests/exports.test.mjs` (find the existing `buildTilesJson` test block and extend it):

```js
test('buildTilesJson: terrainSets export resolved {tileIndex,flipH,flipV,rotate} slots, omitted entirely when empty', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  sheet.tiles.push({ id: 't0', x: 0, y: 0, w: 16, h: 16, name: undefined, gridId: null, neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined });
  let json = buildTilesJson(sheet);
  assert.equal(json.terrainSets, undefined);
  assert.equal(json.layers, undefined);

  const ts = createTerrainSet(sheet, { name: 'Grass', tileW: 16, tileH: 16 });
  assignSlot(sheet, ts, 0, sheet.tiles[0]); // blobIndex 0 = isolated/no-neighbors
  json = buildTilesJson(sheet);
  assert.equal(json.terrainSets.length, 1);
  assert.equal(json.terrainSets[0].name, 'Grass');
  assert.deepEqual(json.terrainSets[0].slots['0'], { tileIndex: 0, flipH: false, flipV: false, rotate: 0 });
});

test('buildTilesJson: layers export as an ordered array, per-tile layer/tags included, omitted when unset', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  sheet.layers.push('Ground', 'Props');
  sheet.tiles.push({ id: 't0', x: 0, y: 0, w: 16, h: 16, name: 'grass', gridId: null, neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: 'Ground', tags: ['nature'] });
  const json = buildTilesJson(sheet);
  assert.deepEqual(json.layers, ['Ground', 'Props']);
  assert.equal(json.tiles[0].layer, 'Ground');
  assert.deepEqual(json.tiles[0].tags, ['nature']);
});

test('buildTilesJson: a terrain-set tile omits the manual neighbors block', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  sheet.tiles.push({ id: 't0', x: 0, y: 0, w: 16, h: 16, name: 'grass', gridId: null, neighbors: { n: { mode: 'same', tileId: null, flipH: false, flipV: false } }, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined });
  const ts = createTerrainSet(sheet, { name: 'Grass', tileW: 16, tileH: 16 });
  assignSlot(sheet, ts, 0, sheet.tiles[0]);
  const json = buildTilesJson(sheet);
  assert.equal(json.tiles[0].neighbors, undefined);
});
```

Add the two new imports at the top of `tests/exports.test.mjs` (alongside whatever it already imports from `model.js`):

```js
import { createTerrainSet, assignSlot } from '../js/core/terrainsets.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 terrainSets`
Expected: FAIL — `buildTilesJson` doesn't produce `terrainSets`/`layers` yet.

- [ ] **Step 3: Write minimal implementation**

In `js/app/exports.js`, add the import and rewrite `buildTilesJson`:

```js
import { getPreset, NEIGHBOR_DIRS } from '../core/neighbors.js';
import { blobIndexToMask, resolveTerrainSlot } from '../core/blob47.js';

// ...(buildFramesJson unchanged)...

// { sheet, count,
//   terrainSets: [{ name, tileW, tileH, slots: { blobIndex: {tileIndex,flipH,flipV,rotate} } }], // omitted if empty
//   layers: [name, ...],                                                                          // omitted if empty
//   tiles: [{ index, name: <or null>, x, y, w, h,
//     neighbors: {...},        // omitted once the tile has a terrainSetId
//     layer: <or omitted>, tags: [<...>] <or omitted if empty> }] }
export function buildTilesJson(sheet) {
  const indexById = new Map(sheet.tiles.map((t, i) => [t.id, i]));

  const result = { sheet: `${sheet.name}.png`, count: sheet.tiles.length, tiles: [] };

  if (sheet.terrainSets?.length) {
    result.terrainSets = sheet.terrainSets.map(ts => {
      const slots = {};
      for (let blobIndex = 0; blobIndex < blobIndexToMask.length; blobIndex++) {
        const resolved = resolveTerrainSlot(ts, blobIndex);
        if (!resolved) continue;
        const tileIndex = indexById.get(resolved.tileId);
        if (tileIndex == null) continue;
        slots[blobIndex] = { tileIndex, flipH: resolved.flipH, flipV: resolved.flipV, rotate: resolved.rotate };
      }
      return { name: ts.name, tileW: ts.tileW, tileH: ts.tileH, slots };
    });
  }

  if (sheet.layers?.length) result.layers = sheet.layers.slice();

  sheet.tiles.forEach((tile, index) => {
    if (!tile.name && !tile.neighbors && tile.terrainSetId == null && tile.layer == null && !tile.tags?.length) return;
    const entry = { index, name: tile.name ?? null, x: tile.x, y: tile.y, w: tile.w, h: tile.h };
    if (tile.terrainSetId == null && tile.neighbors) {
      const preset = getPreset(tile);
      const neighbors = {};
      for (const d of NEIGHBOR_DIRS) {
        const slot = preset[d];
        neighbors[d] = {
          mode: slot.mode,
          tileIndex: slot.tileId != null ? (indexById.get(slot.tileId) ?? null) : null,
          flipH: slot.flipH, flipV: slot.flipV,
        };
      }
      entry.neighbors = neighbors;
    }
    if (tile.layer != null) entry.layer = tile.layer;
    if (tile.tags?.length) entry.tags = tile.tags.slice();
    result.tiles.push(entry);
  });

  return result;
}
```

Note the listing condition changed from `if (!tile.name && !tile.neighbors) return;` to also include tiles that only have a `terrainSetId`, `layer`, or `tags` set (previously such a tile — unnamed, no manual neighbors — would have been skipped entirely, which is now wrong since it may still carry meaningful layer/tag/terrain metadata worth exporting).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -15`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add js/app/exports.js tests/exports.test.mjs
git commit -m "feat: export terrainSets/layers/tags, resolved slot transforms, in buildTilesJson"
```

---

### Task 10: `tests/smoke.md` updates

**Files:**
- Modify: `tests/smoke.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add new smoke-test items**

Find the existing "Tile mode" / "Tile editor" sections (added in the Phase A plan) and the "Tiles JSON" export item in the export section. Renumber as needed to keep the sequence gap-free and collision-free (re-check with a quick scan of every `^\d+\. \[` line after edits — Phase A's own final review caught a numbering collision from a careless bulk renumber, so renumber by hand, a few lines at a time, not with a blanket find/replace). Add items covering, in the same `[A]`/`[M]` tagging convention already used (no drag-simulation items, per this project's testing policy):

- `[A]` Terrain Sets list starts empty; "Add Terrain Set…" dialog defaults Tile W/H from project settings; creating one adds a row with name and size.
- `[A]` Clicking a terrain set's row opens its 47-slot editor below, grouped in ascending neighbor-count rows; the 16 core slots show a distinct border.
- `[A]` Clicking an empty slot opens the tile picker (filtered to tiles matching the terrain set's size); assigning a tile updates that slot; "Clear" empties it again.
- `[A]` Toggling "Allow flip" / "Allow rotation" changes which otherwise-empty slots show a derived (dashed-border) state, and the derived badge reflects a real transform.
- `[A]` "Import from layout…" with the built-in 16-tile preset against a matching 4×4 grid fills exactly the 16 core slots; against a mismatched grid, shows an alert instead of silently misapplying.
- `[A]` "Save current as preset…" prompts for a name and adds a new entry to the layout dropdown, usable immediately after.
- `[A]` Deleting a terrain set clears every referencing tile's terrain badge/detail without deleting the tiles themselves.
- `[A]` Tile editor: opening a terrain-set tile shows the "Terrain: `<name>`" label and a live 8-neighbor preview with no clickable slot dialog; opening a non-terrain tile is completely unchanged from before this feature.
- `[A]` Layers list: Add/rename/reorder (↑/↓)/Delete all work; deleting a layer name clears it from any tile that had it selected.
- `[A]` Tile detail panel: Layer dropdown lists the Layers list plus "(none)"; Tags field accepts a comma-separated list and round-trips on reselecting the tile.
- `[A]` Tiles JSON export: a sheet with a filled terrain set and layers produces the new `terrainSets`/`layers` top-level keys, and a terrain-set tile's exported entry has no `neighbors` key.

- [ ] **Step 2: Verify the full numbered sequence is still gap-free and collision-free**

Run a quick scan for the leading item numbers and confirm they run 1..N with no duplicates or gaps (the same check performed at the end of Phase A's Task 10):

`grep -oE '^[0-9]+\. \[' tests/smoke.md` (or equivalent) — visually confirm strictly ascending, no repeats.

- [ ] **Step 3: Commit**

```bash
git add tests/smoke.md
git commit -m "docs: add smoke-test items for terrain sets, layout presets, layers, tags"
```

---

## After all tasks

Run `npm test` one final time to confirm the whole suite is green, then proceed per `superpowers:subagent-driven-development`'s documented process: dispatch the final whole-branch code review (most capable available model), address its findings, and hand off to `superpowers:finishing-a-development-branch`.
