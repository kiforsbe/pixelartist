# PixelArtist Architecture

Current-state review: **2026-08-28**, runtime baseline **`55602e2`**.
PixelArtist is a browser-only pixel-art editor for sprite sheets, tile sheets,
and reference-based map scenes. It uses native JavaScript ES modules, the DOM,
and Canvas 2D, with no runtime package dependencies or build step.

This document describes the implemented system, including its remaining
coupling and limitations. The [codebase review](reviews/2026-08-28-codebase-review.md)
records confirmed defects and follow-up work; completion of the architecture
migration does **not** mean the application is defect-free.

## Migration status

The [DDD target design](superpowers/specs/2026-08-08-ddd-target-architecture-design.md)
is complete through its agreed Phase 5 scope:

| Phase | Implemented result |
|---|---|
| 0 — Foundation | Host services, registries, and `EditorStore`. |
| 1 — Maps | Map domain model, commands, presenters, and contributions. |
| 2 — Sprites | Sprite commands and presentation separated around host services. |
| 3 — Tiles | Tile/grid/terrain commands and presentation separated. |
| 4 — Shell and legacy retirement | `js/app`, `js/ui`, the compatibility event bus, and the host-to-legacy mirror removed. |
| 5 — Polish | Runtime tile metadata renamed to `sheet.tileLayerNames`; saved/exported `layers` remains compatible. |

The [final Phase 4 plan](superpowers/plans/2026-08-18-phase-4-group-3-5-mode-cleanup.md)
contains a dated closeout superseding its older follow-up notes. The owner
accepted the outstanding manual layer-reorder check; that is an acceptance
decision, not a claim that automation observed the gesture. Phase 5 and the
startup canvas/panel follow-ups were committed in `55602e2`.

Historical plans/specifications preserve the decisions and intermediate states.
Use this document and the dated review for current-state status. New defects
identified by the audit are follow-up work, not unfinished migration tasks.

## Repository structure

There are 164 production JavaScript modules at this snapshot.

```text
index.html                 Static shell, mount points, and most dialogs
css/app.css                Shared desktop workbench and control styling
js/
  bootstrap.js             Browser composition root
  domain/                  5 modules: map model, sprite frames/strips/timing, IDs
  core/                    33 modules: model, pixels, grids, terrain, filters,
                           history primitives, codecs, ZIP, export builders
  host/                    25 modules: store/services, registries, workbench helpers
  platform/browser/        7 modules: browser I/O, adapters, preferences, test mode
  modes/                   66 modules in sprites/, tiles/, maps/
  features/                9 modules: shell/workbench/project/file/filter coordination
  components/              18 shared DOM/canvas/panel modules
assets/                    Blob-47 reference artwork and documentation screenshot
tests/                     75 top-level Node test modules
  helpers/                 Isolated controller/panel fixtures
  browser/                 Focused Playwright workbench regression checks
  smoke.md                 Broader smoke checklist and manual gates
docs/
  ARCHITECTURE.md           This implementation snapshot
  reviews/                 Dated findings and follow-up register
  superpowers/specs/       Design history
  superpowers/plans/       Implementation and acceptance history
package.json               Native-module package and Node test command
serve.ps1 / serve.json     Development server launcher / no-store cache policy
```

There is no backend, database server, bundler, generated application output, or
checked-in CI workflow. IndexedDB is used locally in the browser for recovery.
`.superpowers`, `.playwright-mcp`, `.worktrees`, test output, coverage, and
`node_modules` are ignored scratch/tooling directories, not application layers.

## Runtime composition and lifecycle

[`js/bootstrap.js`](../js/bootstrap.js) is the composition root, capped at
60 lines by an architecture test. Startup runs in this order:

1. Construct `EditorHost` with browser preferences and file/autosave/clipboard/
   image-codec adapters.
2. Register the three built-in modes and their document providers/contributions.
3. Start `sprites`, then publish the host through `host/runtime.js`.
4. Mount workbench, filters, project controls, document controls, menu, and file
   controller, in that order.
5. The file controller asynchronously restores an autosave or creates a default
   project after the other controllers have installed their subscriptions.

The workbench handle supplies canvas-preview, zoom, and navigation operations
to the filter and document controllers. Project replacement notifies project
subscribers **before** `EditorHost.setProject()` activates a document. Canvas
sizing therefore also subscribes to the active document key, rather than
assuming the project-change notification already has the new document.

Mode definitions register contributions once. `activateMode()` updates session
and context keys, invokes a synchronous activation hook, and aborts/disposes the
previous activation result on success. The built-in activation hooks are empty:
their presenters and tools are constructed by the shared workbench and generally
live for the page lifetime. Mode changes mostly hide/show existing views and
persistent panels; they do not remount the whole application.

This is a single-host application. `getEditorHost()` is a module singleton used
by shared UI and features. Root mounts do not expose a unified teardown, and
not every listener/controller is scoped to a mode's abort signal. Do not assume
hot reload, multiple simultaneous editors, or dynamic plug-in unloading works.

## Host, state, and commands

[`EditorHost`](../js/host/editor-host.js) owns `EditorStore`, context keys,
document/project/selection/history/export/focus services, and seven registries:
modes, commands, panels, tools, views, menus, and previews.

### State ownership

| Store group | Current contents and use |
|---|---|
| `project` | Mutable project model and a boolean `dirty` flag. |
| `session` | Active mode/document/view/tool, remembered documents by mode, selections keyed by `kind:id`. |
| `interaction` | Available transient-state bucket; not a complete store of gestures. |
| `workspace` | Drawing colors/brush size, overlays, focused surface ID, pixel revision. |

`EditorStore.transaction(reason, mutate)` batches synchronous notifications;
it is not an immutable reducer or a rollback transaction. Selectors use
`Object.is` unless a custom comparator is supplied. In-place domain mutations
do not change the project reference, so a subscription to `project.model`
alone does not observe every edit. Consumers also use history notifications,
selection values, and `workspace.pixelRevision`.

`ProjectService` handles replacement, dirty/saved state, and named mutations.
`DocumentService` resolves `{kind,id}` references through mode providers and
seeds initial selection. `SelectionService` replaces/patches per-document
selection records. The document controller also orchestrates creation,
deletion, mode switching, and selection repair directly; these are not all
routed through the generic document-provider CRUD methods.

`HistoryService` owns one global `CommandStack`, shared across documents.
Commands provide `do()` and `undo()`; history changes increment a revision and
normally mark the project dirty. Dirty state is not a history savepoint:
undoing back to a previously saved state does not automatically mark it clean.

Floating selection/clipboard state lives in
[`components/canvas/float-session.js`](../js/components/canvas/float-session.js).
Marquees, pointer gestures, playback state, raster caches, and some tool options
also live in modules or view closures. The store is the central application
state source, **not** the owner of every transient object.

### Dispatch and mutation

`ContributionRegistry` validates identifiers, tracks owners, filters by
`when(context)`, sorts by order/ID, and returns disposal handles.
`CommandRegistry.execute(id, context, args)` checks availability/enabled
predicates before invoking a handler.

Mode presenters dispatch commands by ID. Registered application handlers use
host services and often `runEntityCommand()`, which resolves the top-level
entity and calls `projects.mutate()` on both do and undo. Some handlers still
capture nested mutable objects or eagerly mutate then snapshot arrays. This is
not a universal immutable-command implementation; snapshot correctness is a
specific audit risk.

[`features/shell/actions.js`](../js/features/shell/actions.js) exposes
`defineAction`, `runAction`, and `bindAction` over the same host command
registry. Buttons refresh from store/history/context changes. Menus use a
static action-ID tree from `menu-controller.js`; the menu contribution
registry is not the active menu-building pipeline.

Shared drawing and filters still submit raw pixel/history commands.
`features/animations/commands.js` is a small ID-dispatch facade used by shared
drawing/layer UI; it is not a resurrected legacy state bus.

Context keys are used chiefly for mode-level panel/preview visibility.
They are not a fully synchronized mirror of every session field: view/tool
changes frequently update the store directly, and the focus service is not
wired to all DOM surfaces.

## Mode slices and shared shell

Each mode has `index.js`, `documents.js`, `contributions.js`, and `preview.js`,
plus `application/` and `presentation/` folders. Modes do not import siblings.

| Mode / document kind | Views | Principal presentation and application work |
|---|---|---|
| `sprites` / `sprite-sheet` | `sprites.sheet`, `sprites.frame` | Frame tool, frames/animations panels, timeline, frame editor; frame/strip geometry and movement, playback/onion skin, animation/frame/layer/palette commands. |
| `tiles` / `tile-sheet` | `tiles.sheet`, `tiles.tile` | Tile tool/panel, tile-layer tags, terrain editor/panel, autotile painter, tile neighbor editor; grid/tile/terrain commands and geometry. |
| `maps` / `map` | `maps.canvas` | `map-tool-presenter.js`, `map-renderer.js`, `map-panel.js`, `map-assets-panel.js`; brush state/geometry, placement/layer/palette commands. |

Sprites use domain modules for frames, strips, and timing, while substantial
layer/model logic remains in `core/model.js`. Tiles use core grids, neighbor
rules, Blob-47 terrain, and slot/back-reference snapshots. Maps reference source
sheets/assets by ID; they do not copy sheet bitmaps into placements. Their
renderer resolves tile, terrain, frame, and animation sources at paint time.
Map coordinates may be signed; the CanvasView work area is a finite 8192-square
surface centered at offset 4096, not an unbounded rendering surface.

`features/` contains cross-cutting shell orchestration:

- `workbench/editor-workbench.js`: canvases, status, zoom, tool/view/panel composition.
- `project/document-controller.js`: mode tabs, document selector/CRUD, image import, edit shortcuts.
- `project/project-controller.js`: new project and project settings.
- `project/file-controller.js` and `file-session.js`: open/save/export/recovery and native handles.
- `transforms/filter-controller.js`: quantize, chroma-key, checkerboard-removal dialogs and live previews.
- `shell/actions.js` and `shell/menu-controller.js`: shared action facade and menus/help.
- `animations/commands.js`: shared UI's sprite-command dispatch bridge.

The workbench has no concrete mode imports, but still recognizes the built-in
mode/view IDs for routing. Adding a fourth mode is not purely declarative.

### Panels and views

`index.html` defines left, center, right, and bottom workbench regions.
Tools/colors occupy the left; the canvas center; layers, contextual panels,
animations, terrain, preview, and map assets the right; timeline the bottom.

`PanelManager` reconciles registered panels against context keys. Persistent
panels are hidden rather than disposed. It aggregates visibility for shared
fixed mount points, including contributions never mounted in the initial mode,
so hidden tile panels leave no empty padded containers.

`mountStorePanel()` shares microtask-debounced rendering and subscription
disposal. Some components remain page-lifetime mounts. Generic collapsible
panel frames/preferences apply to generated panel chrome; fixed mount-point
contributions do not all use that chrome.

The workbench eagerly creates registered views and explicitly shows/hides the
frame/tile editors. `ViewManager` exists but is not used in this path.
Dialogs are native `<dialog>` elements, mostly static in HTML; the movable
filter dialogs use non-modal `.show()`, while many other dialogs use
`.showModal()`.

## Model and rendering

A project owns settings, palettes, sheets, and maps. Each sheet owns dimensions,
frames/animations, a pixel `layerTree`, and (for tile sheets) explicit tiles,
grids, terrain sets/presets, and tile-layer-name metadata.

```text
sheet.layerTree
  group { type: 'group', children, animationId? }
    group ...
    layer { type: 'layer', visible, opacity, bitmap }
      bitmap { width, height, data: Uint8ClampedArray }  // RGBA bytes

sheet.tileLayerNames = ['Ground', 'Decor', ...]         // tile sheets only
tile.layer = 'Ground'                                  // metadata, not pixels

map.layers = [{ type: 'tile', tiles, terrain }, ...]   // map placements
          or [{ type: 'sprite', sprites }, ...]
```

`sheetLayers()` traverses pixel-layer leaves. `flattenSheet()` composites
sheet layers and accepted animation groups into frame rectangles; floating
buffers and filter override layers can alter the rendered result without
committing the underlying pixels. `ImageData` is created at the canvas
boundary; stored bitmaps are ordinary objects containing typed arrays.

`sheet.tileLayerNames` is an array on tile sheets and `null` on sprite sheets.
It is unrelated to compositing and unrelated to `map.layers`. Tile IDs and
coordinates define tile identity/placement; export array indexes are derived.

`CanvasView` owns device-pixel sizing, camera transforms, checkerboard drawing,
pointer conversion, and scheduled render callbacks. Shared `drawing-engine.js`
handles pixel tools and region selection; frame/tile presenters adapt the same
drawing engine to their editing region. Main, frame, tile, map, thumbnail, and
preview consumers cache their own raster results, invalidating from relevant
project/selection/history/pixel notifications. There is no single global
renderer/cache invalidation service.

Filters compute before/after patches and substitute cloned preview layers.
Accept submits history edits; cancel removes preview overrides. Correct view,
document, selection, and bitmap-identity synchronization remains important;
the audit records cases not covered by the current subscriptions.

## Persistence, browser boundaries, and exports

`.pixelproj` is a ZIP containing `project.json` and PNGs for pixel layers.
`core/model.js` serializes/deserializes metadata; `core/bundle.js` joins that
metadata with encoded layer images; `core/zip.js` handles the archive.
`core/pngcodec.js` uses browser `OffscreenCanvas`, `ImageData`, and
`createImageBitmap`; consequently **not every core module is Node-only or
independent of browser APIs**. Bundle tests can inject codecs.

Current saves use **project version 3**. Loading accepts version 2 and 3, migrates
old flat pixel `layers[]` into `layerTree`, and migrates older uniform tile grids.
For tree-based tile sheets the serialized `layers` property maps to runtime
`tileLayerNames`. Without `layerTree`, `layers` is interpreted as legacy
pixel records, never tile tag names. Tile JSON exports retain `layers` and
omit it when empty. Phase 5 did not bump the file version.

Import validation is limited; it is not a complete schema or integrity check.
Malformed dimensions, decoded bitmap sizes, and entity references need stronger
validation before a project is installed (see review).

Browser `project-io.js` implements packed open/save, download fallbacks,
image picking, folder export, and IndexedDB recovery. Unpacked project
open/save helpers exist but are not connected to the current Open/Save UI.
File handles and save mode live in `features/project/file-session.js`, outside
serialized project data.

Recovery runs every 30 seconds when dirty and no floating selection is active.
Save clears the recovery slot after writing. The current asynchronous save path
has no revision/identity guard; its confirmed race is a release follow-up.
Restore/new-project boot and before-unload behavior are controlled partly by
`?autotest`, which disables recovery restoration and confirmation gates for
test sessions. Do not use that mode as evidence for real recovery/picker UX.

The platform adapter objects are injected into the host, but the current
controllers mostly call `project-io.js`, codecs, and browser clipboard APIs
directly. Preferences are actively injected/used; the wider port abstraction
is incomplete, not a fully isolated I/O boundary.

Export builders under `core/export/` produce frame/tile/map JSON, Tiled TSX,
animation sheets/sequences/GIF frames, C99, and retro-platform binaries.
`core/gif.js` encodes GIF bytes. The file controller chooses formats,
quantization/compatibility checks, filenames, and download/folder destinations.
Project batch export selects sheets; maps have a separate JSON action.
`ExportService` is scaffolding, not the live exporter dispatch path.

## Dependency boundaries and known structural debt

[`tests/architecture.test.mjs`](../tests/architecture.test.mjs) uses source
scans to guard the migration: retired imports, sibling-mode imports, selected
DOM-free application files, command dispatch separation, and registry-based
workbench composition. These are useful targeted checks, **not** a complete
dependency graph or proof of purity. In particular, host `workbench/` is
excluded from the DOM ban, and core's import regex does not cover every upper
layer name or browser global.

Actual boundaries and exceptions:

- `domain/` contains small browser-independent modules; core imports it.
- Host services depend on core, while host workbench helpers may use DOM/shared UI.
- Mode application code uses core/domain/host; presentation uses shared controls,
  geometry, and ID-based command dispatch.
- Shared components reach host/core and some feature/platform helpers, so the
  folders do not form a strict acyclic clean-architecture stack.
- `modes/tiles/terrain-preset-art.js` is the explicitly tracked exception:
  browser artwork import and a raw pixel-patch command outside
  `application/`/`presentation/`. Its exact import exception is test-pinned.
- Large mixed-responsibility modules remain: layer panel, drawing engine,
  model, filters, frame editor, timeline, and file controller. Splitting folders
  did not remove all state/lifecycle coupling.
- `ViewManager`, `ExportService`, menu registry, focus plumbing, and portions
  of the platform ports are unused or partially wired extension mechanisms.
  Integrate or remove them only for a concrete requirement, not to reopen a
  completed migration phase.

## Verification and development

`package.json` requires Node >=18 and runs:

```sh
npm test
```

The closeout baseline passed **723 tests across 75 top-level test modules**.
Tests cover domain/core algorithms, commands, host/store/registries, boundary
scans, and isolated DOM/controller fixtures. They do not establish complete
browser integration coverage.

`tests/browser/workbench-regressions.mjs` exports three focused checks:
startup checkerboard, sheet-switch canvas sizing, and mode-panel visibility.
It requires a caller-provided Playwright page/server and is **not run by
`npm test`**. Prior closeout checks passed at 1600×900 and 1280×800, including
a pencil click and undo/redo; this audit's isolated diagnostics are not a fresh
full browser smoke pass.

Serve the repository over HTTP. `serve.ps1` runs unpinned `npx --yes serve`
on an ephemeral port (use the URL it prints); it can need network access.
`serve.json` disables caching for that server. A separately available static
server is also sufficient. Native module loading is not supported by opening
`index.html` directly with `file://`.

Before release, rerun automated tests, the focused browser checks, and the
owner-operated manual cases. [`tests/smoke.md`](../tests/smoke.md) contains
outdated Add Grid instructions and inconsistent automation labels; its stated
manual-only rule takes precedence for pointer drags/native pickers. Correct
those instructions before treating the checklist as an executable release gate.

## Extending the implementation

For new mode behavior, follow the existing document provider/contribution/
application/presentation shape, dispatch commands by ID, and test undo after
mutations that replace or reshape nested entities. Check shell mode/view
routing as well as registration.

For a new menu/button action, register one action and consume its ID from both
surfaces. For a panel, define its region, predicate, mount point and lifetime;
test inactive startup and shared-container visibility. For any asynchronous
file work, preserve project identity/revision across awaits and verify that
completion cannot overwrite newer session state.

The [review and issue register](reviews/2026-08-28-codebase-review.md) is the
next-work list: prioritize data integrity, selection/undo correctness, and
export contracts before additional architectural abstraction.
