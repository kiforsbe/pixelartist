# Codebase and project-structure review — 2026-08-28

Runtime baseline: `55602e2` (`refactor: finish phase 5 polish and workbench follow-ups`).
Status: **review complete; R01–R23 implemented; release checks still required**. The original audit did
not implement the findings or modify the earlier migration's acceptance.
The remediation log below records subsequent changes; the finding descriptions
remain evidence of the original baseline, not claims about fixed behavior.
Current implementation: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Outcome and scope

The agreed architecture migration is complete through Phase 5. The previous
startup/sheet-sizing and empty-panel issues are fixed in the baseline and are
not re-reported here. The remaining plan checkpoint was closed and committed.

The codebase has useful mode boundaries, centralized history/selection services,
and substantial algorithm/command tests. The audited baseline had defects at
mutable-state, view-transition, persistence, and export boundaries. **Do not
interpret the green test suite as a release sign-off.**

This review records **23 findings: 4 P1, 17 P2, and 2 P3**. P1 means prioritize
before release because ordinary operations can lose edits or corrupt state;
P2 means a confirmed functional defect; P3 means lower-risk robustness or
documentation work. These priorities are review judgments, not a claim that
every defect is newly introduced by the baseline commit.

Review coverage:

- Inventory and dependency/test-guard inspection across all 164 production JS
  modules, static HTML/CSS, package/server configuration, assets, and docs.
- Core/domain/platform: model/compositing, bundle/ZIP/load/save boundaries,
  export builders, palettes/quantization/filter and terrain/grid helpers.
- Sprites/shared components: commands, frame/timeline/editor context, canvas
  selection/floating/cache lifecycle, shared panels/dialogs/menus.
- Tiles/maps: command snapshots, terrain ownership, placement ordering,
  snapping, rendering, hit-testing, and contribution boundaries.
- Host/features: store/services/registries, startup, document controls,
  file controller, filters, actions, and project settings.

The structural pass is repository-wide; correctness review is risk-focused,
not a claim of exhaustive line-by-line proof. Numeric/overlay algorithms and
static palette/template tables were inspected, not independently re-derived
or fuzzed. Independent reviewers covered three bounded subsystem groups; the
coordinator checked their source locations and re-ran selected reproductions.

## Remediation log

### First priority batch — 2026-08-28

| Finding | Implemented correction | Retained regression coverage |
|---|---|---|
| R01 | Save/recovery writer queue with project identity, generation, edit revision, and live-pixel revision guards. | Delayed Save/Save As, repeated edits, document mutations, replacement, overlapping saves/recovery, and failed writes. |
| R02 | Marquees belong to a document/editing region; Delete clips to the current target, and float history cannot restore another context's marquee. | Frame/tile/document transitions, overlapping regions, clipping, float undo/redo and normal selections. |
| R03 | Grid commands snapshot mutable geometry/ownership and restore original entity identities. | Promotion, all growth/shrink edges, collapse, repeated undo/redo, terrain ownership and earlier history references. |
| R04 | Terrain asset snapping uses tile dimensions; placement/move commands reject non-finite coordinates. | Real brush/hover consumers, finite negative positions, and invalid coordinates preserving history/dirty state. |

Committed as `e2316b2`. Combined Node verification: **779 passed, 0 failed**, across 78 top-level
test modules. These tests use isolated fixtures, not browser drag/native-picker
automation. Subsequent fixes are recorded below; structural risks remain separate.

### Subsequent remediation — 2026-08-28

| Finding | Implemented correction and regression coverage |
|---|---|
| R05 | Animation deletion restores nullable group ownership; accepted/unaccepted undo and redo tested. |
| R06 | Sheet/map opacity input captures its baseline without requiring pointerdown; keyboard input/change, dirty state, and repeated undo tested. |
| R07 | Same-view frame changes refresh size, toolbar, and animation-layer raster context; confined floats settle on transitions and before structural UI mutations. Real timeline/layer controls test deletion/merge undo ordering. |
| R08 | Merge Down bakes effective source/destination opacity and visibility, preserving bitmap identity; both command wrappers restore metadata and pixels. |
| R09 | Tile-size undo restores the complete terrain slot/back-reference snapshot, including populated slots and duplicate markers. |
| R10 | Rejected terrain owners retain their slots before dependent moves finalize; mixed success, blocked chains, input order, and swaps tested. |
| R11 | Placement erase/delete/replacement undo restores the original index and identity; real renderer and overlap hit tests cover stacking. |
| R12 | Removing a tile-layer name clears and restores terrain assignments as well as tile assignments. |
| R13 | Hit-testing checks terrain before ordinary tiles, reversing the renderer's draw order. |
| R19 | Global undo/redo/save respect typing targets, focused controls, dialogs, and default-prevented events; Ctrl and Command variants tested. |
| R20 | Mode switching retains the service-resolved document and per-document selection, with missing-document fallback tests. |
| R21 | New Map uses history; creation in all three modes restores previous selections and preserves another active mode during undo/redo. |
| R14 | Opaque GIF matching excludes the transparency slot; palette-reduced output checked by independent LZW decoding. |
| R15 | Large GIF streams are appended without unbounded argument spread; noisy 512×512 output decodes to exact source pixels. |
| R16 | Validated canvas dimensions and decoded RGBA shape before project publication for legacy/current files. Existing oversized frame/tile defaults remain loadable. |
| R17 | C99 symbols are deterministic, valid, and unique within the export; header references and downloaded filenames agree. |
| R18 | Shared export descriptors align PNG downloads with JSON/TSX references; actual single-download and batch ZIP paths tested. |
| R22 | Failed preference writes/removals override stale storage, with recovery after successful persistence and partial-failure tests. |
| R23 | README/smoke instructions reflect current format/server/grid controls; manual-only gesture labels retained. About uses a shared version with a package-version drift test. |

Verification: **910 passed, 0 failed** across 87 top-level Node test modules.
All 167 production modules passed `node --check`; 44 local architecture/review
links resolved, issue IDs/severity totals and code fences validated, and the
staged diff passed `git diff --cached --check`.
The save fixtures now await explicit writer/recovery signals rather than a fixed
number of event-loop ticks, eliminating a load-sensitive test wait.

Independent reviews caught and resolved two integration issues: floats must
settle before structural source removal, and bounding every item default to
4096 would reject projects the editor itself can create. Actual/default sheet
canvases remain bounded; item defaults/legacy cell sizes remain positive safe
integers to preserve that existing contract.

The final baseline-to-worktree integration review found no actionable issues
and independently passed 195 focused tests across 14 modules (overlapping the
full suite, not additional coverage totals).

These are implemented fixes with automated regression coverage, not a new
manual browser or release sign-off. Rerun the relevant smoke checks before
release. The structural debt and unverified risks below remain follow-up work;
no requirement-led refactor or archive/durability hardening is implied complete.

## Priority fixes (original audit)

### R01 — P1: Save completion can clear newer unsaved edits

Source: [file-controller.js:72](../../js/features/project/file-controller.js#L72),
also Save As at line 83; [project-io.js:21](../../js/platform/browser/project-io.js#L21).

Save awaits encoding/writing, then unconditionally calls `markSaved()` and
clears autosave. Edit the project after the bytes are captured but before the
writer finishes: the later edit is not in the file, yet dirty becomes false.
A project switch during the await also has no identity guard. A real-controller
diagnostic with an in-memory delayed writer produced file name `BeforeSave`,
model name `AfterSave`, and `dirty === false`.

Next: capture project identity and an edit revision/save token; only clear dirty
and recovery state for the version actually saved. Test edit-during-save,
project-switch-during-save, and overlapping saves with controlled promises.

### R02 — P1: A stale marquee can delete pixels in the previous frame

Source: [drawing-engine.js:700](../../js/components/canvas/drawing-engine.js#L700),
lifetime reset at line 94.

Marquees use sheet-global coordinates and reset only on project replacement.
Select pixels at (1,1)–(2,2) in frame A, navigate to frame B at x=10, then Delete.
The old selection is applied without intersecting the current target. A real
`bindDrawing` diagnostic cleared A's red pixel to transparent while B stayed
red. The same selection lifetime crosses sheet changes.

Next: scope/reset selection on document and editing-region changes, and enforce
current-region confinement at destructive operations. Test frame/tile/sheet
transitions with an existing marquee, including Delete/cut/move.

### R03 — P1: Grid undo leaves geometry and ownership mutated

Source: [tile-sheet-commands.js:184](../../js/modes/tiles/application/commands/tile-sheet-commands.js#L184),
also `resizeGridAxis` at line 197.

Before/after arrays are shallow copies of objects mutated by core grid helpers.
Grow a standalone tile into a grid and undo: the grid disappears but the tile
retains its removed `gridId`. Resize two columns to three and undo: there are
two tiles but `grid.cols` remains 3. Both cases were reproduced in memory.

Next: snapshot/restore changed grid geometry and tile ownership fields, not
just array membership. Preserve entity identity and test grow/shrink/collapse
through multiple undo/redo cycles. Current tests miss these field invariants.

### R04 — P1: Terrain Asset-grid snapping stores non-finite coordinates

Source: [map-tool-presenter.js:64](../../js/modes/maps/presentation/map-tool-presenter.js#L64),
[map-renderer.js:127](../../js/modes/maps/presentation/map-renderer.js#L127),
and [map-geometry.js:14](../../js/modes/maps/application/map-geometry.js#L14).

Select a terrain brush and Asset-grid snapping. Terrain objects have
`tileW/tileH`, but `snap()` reads `w/h`. Painting produces `NaN` coordinates;
the command accepts them and JSON serializes them as `null`. The same shape
mismatch affects the hover preview. Isolated snapping/command diagnostics
confirmed this; no pointer drag was automated.

Next: normalize asset dimensions before snapping and reject non-finite command
coordinates. Test terrain, ordinary tile, frame, and animation brush inputs.

## Undo, selection, and editing defects

### R05 — P2: Undoing deletion of an unaccepted animation throws

Source: [animation-lifecycle-commands.js:61](../../js/modes/sprites/application/commands/animation-lifecycle-commands.js#L61).

New animations normally have no layer group. Create one, delete it, then Undo:
the command reinserts the animation and dereferences `group.id` while `group`
is null. Real host execution throws `TypeError`, leaving a partially restored
model and no redo entry for the deletion. The existing test covers accepted
animations only.

Next: restore the original nullable ownership ID and conditionally restore its
group; test unaccepted and accepted delete/undo/redo.

### R06 — P2: Keyboard opacity edits bypass history and dirty tracking

Source: [layers-panel.js:574](../../js/components/panels/layers-panel.js#L574),
map-layer equivalent at line 630.

Tab to an opacity range and use an arrow key. Only pointerdown captures the
before value; keyboard input mutates opacity, then change returns without a
command. Actual panel callbacks with input/change but no pointerdown produced
opacity 0.5, `dirty === false`, and `canUndo === false`. Recovery/close warnings
can therefore miss the edit.

Next: use an input-modality-independent preview/commit baseline for both sheet
and map layers. Add keyboard-only control tests.

### R07 — P2: Timeline frame changes leave the open editor on stale context

Source: [frame-editor-presenter.js:561](../../js/modes/sprites/presentation/frame-editor-presenter.js#L561),
[timeline-presenter.js:429](../../js/modes/sprites/presentation/timeline-presenter.js#L429),
[float-session.js:491](../../js/components/canvas/float-session.js#L491).

While a frame editor is open, selecting another timeline frame changes
`editingFrameId` but keeps `activeViewId` unchanged. The selection subscriber
requests paint without refreshing dimensions, toolbar, or context-sensitive
cache; float transition guards also omit editing-frame identity. A real-editor
fixture switching A (4×4) to B (8×8) kept canvas width 4, toolbar name A, and A's
floating source while the target lookup referred to B.

Next: centralize editor-context transitions and observe editing-frame identity;
commit/cancel confined floats before transition. Test same-view timeline changes
with differing dimensions, animation/layer context, and active floating content.

### R08 — P2: Merge Down changes visible opacity

Source: [model.js:337](../../js/core/model.js#L337).

With a blue destination layer at opacity 0.5 and an opaque red source above it,
Merge Down changes the flattened pixel from `[255,0,0,255]` to
`[255,0,0,128]`. The source is baked into the destination bitmap, then the
destination opacity applies to the whole result. Sprite/tile wrappers do not
compensate. This was independently reproduced; existing tests cover source
opacity, not a translucent destination.

Next: preserve the composite appearance while merging both effective opacities,
and restore bitmap plus metadata on undo.

### R09 — P2: Tile-size undo does not restore terrain slots

Source: [tile-sheet-commands.js:335](../../js/modes/tiles/application/commands/tile-sheet-commands.js#L335).

Change an assigned terrain tile's W/H to a mismatched size, then undo.
Detachment deletes the terrain slot; undo restores the tile's size and
back-reference only. The diagnostic restored an 8px tile pointing at its
terrain set while `terrain.slots[3]` stayed absent. Resolution/export loses
that shape. The existing test starts with an empty slots map.

Next: snapshot both sides with the terrain-slot state helper; test populated
slots, duplicates, and undo/redo.

### R10 — P2: Mixed-conflict terrain strokes break slot ownership

Source: [autotile-paint-commands.js:69](../../js/modes/tiles/application/commands/autotile-paint-commands.js#L69).

Start with A assigned North, B North+East, and C isolated. In one erase stroke,
A requests isolated (conflicts with C), while B requests North. The successful
candidate provisionally takes North, then restoring conflicted A overwrites
that slot. Both A/B claim North and B's old slot disappears. The isolated
stroke diagnostic confirmed this bidirectional-reference inconsistency.

Next: resolve rejected candidates before finalizing other assignments, checking
that each canonical slot and tile back-reference agree. Test partial success
with conflicts, not only all-success or all-conflict strokes.

### R11 — P2: Map delete/erase undo changes stacking order

Source: [map-paint-commands.js:105](../../js/modes/maps/application/commands/map-paint-commands.js#L105),
also replacement/erase undo paths at lines 23, 32, 56, and 72.

Undo appends removed placements instead of restoring their original index.
With overlapping sprites `[A,B]`, delete A from an exposed portion and undo:
the collection becomes `[B,A]`. Rendering/hit-testing depend on that order,
so Undo changes the scene. Collection order was reproduced directly.

Next: capture original indexes for removal/replacement and test overlapping
placements through undo/redo.

### R12 — P2: Removing a tile-layer name leaves terrain references dangling

Source: [tile-layer-commands.js:19](../../js/modes/tiles/application/commands/tile-layer-commands.js#L19).

Assign Ground to a terrain set, then remove Ground from Tile Layers. Individual
tile assignments are cleared, but `terrainSet.layer` remains Ground after the
name list is empty. The selector cannot represent it and Tiles JSON still
exports the dangling value. Confirmed with command/export inspection and an
in-memory assignment check.

Next: include terrain-set assignments in removal and undo snapshots.

### R13 — P2: Map hit-testing disagrees with tile/terrain draw order

Source: [map-geometry.js:93](../../js/modes/maps/application/map-geometry.js#L93),
compare [map-renderer.js:90](../../js/modes/maps/presentation/map-renderer.js#L90).

Terrain is painted after ordinary tiles, but ordinary tiles are hit-tested
first. Place both at the same cell: terrain is visually on top while
Select/Move targets the covered tile. A direct `hitMapItem()` check confirmed
the selected ID.

Next: hit-test in reverse rendering order, with an overlap regression test.

## Persistence and export defects

### R14 — P2: GIF palette reduction can make opaque pixels transparent

Source: [gif.js:112](../../js/core/gif.js#L112), reserved palette entry at line 85.

Nearest-color matching for opaque pixels includes the reserved transparent
black entry. Repro image: 257×1, first 255 pixels `[i+1,100,100,255]`, then
opaque black, then transparent. When palette reduction drops opaque black,
both final pixels encode as transparent index 255. An independent in-memory
LZW decode verified the indices. Existing tests do not cover reduced-palette
transparency.

Next: exclude the transparency slot from opaque matching; test >255 colors
with dark opaque pixels and transparency using decoded output.

### R15 — P2: Ordinary large GIF frames exceed the call argument limit

Source: [gif.js:117](../../js/core/gif.js#L117).

The encoder spreads an entire compressed frame into `out.push(...)`.
A 512×512 frame of deterministic 256-gray noise (xorshift seed 123456789)
throws `RangeError: Maximum call stack size exceeded` under Node/V8. The
model permits this frame size. Existing GIF tests use tiny frames.

Next: append bytes/chunks without unbounded argument spreading; cover a
large, incompressible frame and decode the result.

### R16 — P2: Loading accepts inconsistent sheet/image dimensions

Source: [model.js:548](../../js/core/model.js#L548), legacy path at line 563,
validation at line 710.

A project declaring a 2×1 sheet but referencing a decoded 1×1 bitmap passes
validation and deserialization. `flattenSheet()` subsequently throws on a
missing pixel (`null[3]`). Negative sheet width also passes metadata validation.
The mismatch was independently reproduced. This concerns malformed/corrupted
input; it is not evidence that normal saves produce mismatched dimensions.

Next: validate finite, positive, bounded dimensions and decoded bitmap shape
before publishing the loaded project; preserve the current project on failure.

### R17 — P2: C99 export uses display names as invalid C identifiers

Source: [c99Export.js:145](../../js/core/export/c99Export.js#L145).

Sheet `Sprite Sheet` and frame `Frame 1` generate declarations containing
`Sprite Sheet_palette` and `Sprite Sheet_Frame 1`. The controller passes names
unchanged; spaces/hyphens/leading digits are not constrained by the UI. The
generated text was reproduced; no external compiler was invoked.

Next: derive valid, deterministic, collision-safe C identifiers separately
from display/file names. Test punctuation, Unicode, leading digits, collisions,
and optionally compile generated fixtures.

### R18 — P2: Separate PNG exports disagree with metadata filenames

Source: [file-controller.js:111](../../js/features/project/file-controller.js#L111),
animation export at line 150;
[exports.js:33](../../js/core/export/exports.js#L33),
[animationExport.js:44](../../js/core/export/animationExport.js#L44).

For project Game/sheet Hero, separate PNG download is `Game-Hero.png` while
frame/tile JSON and TSX refer to `Hero.png`. Animation Run downloads
`Hero-Run.png` but its JSON refers to `Run.png`. Consumers cannot resolve the
companion image without a manual rename. This is confirmed by builder values
and controller callsites; project batch JSON+PNG uses matching sheet names
and should not be conflated with this defect.

Next: make one export descriptor own both output filename and metadata
reference; add controller-to-builder contract tests for every paired format.

## Shell and lower-priority findings

### R19 — P2: Ctrl+Z/Y in a text field alters project history

Source: [document-controller.js:405](../../js/features/project/document-controller.js#L405).

Undo/redo hotkeys omit the typing/dialog gate used for Save and other editor
shortcuts. With a command on history, typing into a field and pressing Ctrl+Z
prevents native text undo and undoes the project command instead. A real
controller/fake-input event check confirmed both effects. Modal dialog fields
also bubble these key events.

Next: respect focus/default-prevented state and gate global history shortcuts
outside editing controls/dialogs, including contenteditable and platform keys.

### R20 — P2: Switching modes discards the remembered document

Source: [document-controller.js:60](../../js/features/project/document-controller.js#L60),
sheet equivalent at line 69.

DocumentService remembers the active document by mode, but the controller's
mode-change listener overwrites it with the first map/sheet. Select a second
sprite sheet, switch to Tiles, then back: the first sprite sheet is selected.
The real controller/host diagnostic confirmed the ID change.

Next: respect the document already resolved by DocumentService and retain valid
per-document selection; test multi-sheet and multi-map round trips.

### R21 — P2: New Map bypasses the history stack

Source: [document-controller.js:182](../../js/features/project/document-controller.js#L182).

New Sheet is a history command, but the Maps branch calls `createMap()` directly.
After clearing history and creating a map, map count increases while
`canUndo()` stays false; with older history, Undo affects an unrelated edit.
Confirmed through the actual registered `document.newSheet` action.

Next: implement equivalent document-creation history with previous selection
restoration; test create/undo/redo in all three modes.

### R22 — P3: Preference fallback loses writes after a storage quota failure

Source: [preferences.js:21](../../js/platform/browser/preferences.js#L21).

If `setItem` throws while `getItem` still succeeds, `set()` writes the memory
fallback but `get()` reads only storage. A quota-only storage stub gave
`set('x',42)` followed by `get('x','missing') === 'missing'`.

Next: make fallback precedence consistent across get/set/remove and test
partial storage failure, not only total storage unavailability.

### R23 — P3: README, smoke steps, and displayed version have drifted

Sources: [README.md:248](../../README.md#L248),
[smoke.md:253](../../tests/smoke.md#L253),
[menu-controller.js:13](../../js/features/shell/menu-controller.js#L13).

README calls the current format v2 (it is v3), says localhost:8080 after the
random-port server launcher, and promises all shortcuts are focus-gated (R19).
Smoke steps still instruct users to click the removed Add Grid dialog; several
drag steps are labeled automatable despite the checklist's manual-only drag
rule. About reports 0.1.0 while package.json is 0.2.0. These were confirmed by
source comparison. ARCHITECTURE.md was corrected in this audit; the other
sources remain open work, not silently rewritten historical plans.

Next: refresh user/release documentation and centralize the displayed version.
Preserve manual-only drag/native-picker gates when correcting smoke labels.

## Structural debt and unverified risks

These are not additional confirmed runtime findings or reopened migration tasks:

- Domain extraction is partial: model.js still owns construction, layer
  mutation/compositing, serialization/migration, and validation. Shared layer
  and palette handlers duplicate significant sprite/tile logic.
- Store state coexists with singleton/closure state for gestures, float,
  timeline, preview and tools. Root mounts lack comprehensive teardown; host
  activation disposal does not own every built-in UI resource.
- ExportService/ViewManager are scaffolded; menus use a static tree, focus
  integration is partial, and most I/O bypasses the injected platform bundle.
  Adding modes still requires checking built-in shell/view-ID routing.
- Architecture tests are regex-based guardrails, not full import-graph or
  purity checks. Host workbench is deliberately DOM-capable; pngcodec in core
  uses browser imaging globals. The terrain-preset-art exception is deliberate
  and pinned by a test.
- ZIP loading lacks CRC/uncompressed-size verification, decompression bounds,
  and referenced-asset-only decoding. This is a hardening gap; no archive-bomb
  experiment or real user-file corruption incident was attempted.
- IndexedDB operations resolve request success rather than transaction
  completion and do not explicitly handle transaction abort. Durability under
  quota/abort needs a real-browser test; no durability failure was demonstrated.
- Tiled TSX conformance for nonuniform/spaced grids and transformed terrain,
  native binary toolchain/hardware output, and visual filter fidelity need
  dedicated contract/conformance work beyond this audit.
- No checked-in CI workflow or turnkey browser test runner. `npm test` omits
  browser checks; the development server uses unpinned `npx serve`.

## Original audit verification and limitations

- Full Node suite at closeout: **723 passed, 0 failed** (75 top-level modules).
- Final documentation-audit verification reran the full suite: **723 passed,
  0 failed**. All 164 production modules passed `node --check`; 44 local
  documentation links resolved; issue IDs/severity totals and code fences
  validated; `git diff --check` passed.
- Reviewers independently ran 152 core/platform/export tests and 141 tile/map/
  architecture tests; all passed. These overlap the full suite, not additional
  coverage totals.
- Confirmed behavior findings used isolated in-memory Node diagnostics, real
  modules and small DOM/storage/writer boundary stubs where needed. Export
  filenames/C declarations and documentation mismatches also used direct source
  contract checks. GIF transparency was checked with an independent LZW decode.
- Prior closeout browser checks covered startup, differing sheet sizes, panel
  visibility at 1600×900 and 1280×800, and pencil click/undo/redo. They were not
  a complete end-to-end smoke run for this audit.
- No native file/folder picker automation, browser drag/resize simulation,
  hardware-toolchain execution, or release sign-off. Owner acceptance of the
  earlier layer-reorder check does not satisfy unrelated manual release gates.

## Recommended execution order

1. R01–R04: revision-safe saves, confined selection, faithful grid undo, finite
   map placements. Add invariant/controlled-async regression tests first.
2. R05–R13 and R19–R21: complete undo, input-modality and context-transition
   behavior; verify cross-document and same-view interactions.
3. R14–R18: decoded/export-consumer contract tests and import validation.
4. R22–R23 and structural hardening: fallback robustness, accurate release
   instructions, repeatable browser checks, then requirement-led refactoring.

Keep the newly recorded issues separate from the finished migration plan. For
each fix, retain its reproduction as a regression test and rerun the manual
cases appropriate to its input/browser boundary.
