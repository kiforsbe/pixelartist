# Phase 4: Shell + Legacy State Retirement — Design

## Status

Implements Phase 4 of the migration roadmap in
[2026-08-08-ddd-target-architecture-design.md](2026-08-08-ddd-target-architecture-design.md).
Phases 0 (foundation), 1 (maps), 2 (sprites), and 3 (tiles, sub-phases
3a-3d) are complete — HEAD `ffb5232` at the start of this phase.

## Goal

Retire the legacy `js/app/state.js` mutable-object + `on()`/`emit()`
event-bus system entirely. `EditorStore` becomes the sole owner of
project/session identity; every consumer — the 6 shell controllers under
`js/features`, and the ~29 files across maps/sprites/tiles that still
import `state.js` despite those modes being nominally "done" — moves onto
`EditorStore.subscribe()` and host services. `js/app/state.js`,
`legacy-state-adapter.js`, and `js/app/main.js` are deleted. `js/ui`'s 10
shared Presentation widgets relocate into the existing `js/components/`
library. `js/app`'s 8 state-free utility/codec files relocate under
`js/core`.

## Scope correction vs. the original roadmap

The roadmap's Phase-1/2/3 rows implicitly assumed the three modes were
already `EditorStore`-only, leaving Phase 4 as "just" the 5 named shell
controllers. A scoping survey (2026-08-10) found this untrue: 29 of 61
mode files still import `js/app/state.js` directly — including maps'
top-level `contributions.js` — and `EditorStore.project.model` is
currently only a pointer aliasing the same object `state.project`
references, kept in sync one-way by `legacy-state-adapter.js`, not a true
sole owner. This design's scope therefore covers both the shell rewrite
and finishing the mode cleanup the earlier phases left behind, plus a
6th shell file (`editor-workbench.js`) the roadmap's phase table omitted.

## Non-goals

- No user-facing behavior change — every mode must work identically
  after this phase, same as prior phases.
- Not a rewrite of `js/core`/`js/domain` (Domain layer, unaffected).
- Phase 5's `sheet.layers` → `sheet.tileLayerNames` rename stays a
  separate, later, unblocked piece of work.
- `project.json` save/load format is unaffected — no version bump.

## Target architecture: state field mapping

| Current `state.js` field/helper | Destination |
|---|---|
| `project` | `EditorStore.project.model`, sole-owned (no more shared pointer) |
| `dirty` | `EditorStore.project.dirty` (already exists; store becomes sole owner) |
| `mode` | `EditorStore.session.activeModeId` (already exists) |
| `view` | `EditorStore.session.activeViewId` (already exists) |
| `activeSheetId` / `activeMapId` | Derived from `host.documents.active` |
| `activeLayerId` | Dropped — production already reads `host.selections`; this was a test-only fallback |
| `tool` | `EditorStore.session.activeToolId` (already exists) |
| `selectedTileId`, `selectedTerrainSetId`, `editingFrameId`, `editingTileId` | `EditorStore.session.selectionsByDocument` via `SelectionService` — extends the mechanism that already covers layer/frame/animation selection |
| `onion` | No new home needed — already an alias into `project.settings.onion`; consumers redirect to read `host.projects.project.settings.onion` directly |
| `maybeSnapPixels()` | Becomes a plain function taking `(project, bitmap)` — already only reads `project.settings.pixelSnapper*` |
| `overlays` (`{labels, sequences}`) | New `EditorStore.workspace` field — session-only, unpersisted display toggles |
| `fileHandle`, `dirHandle`, `saveMode` | Local module state in the rewritten `file-controller.js` — single-consumer |
| `brushSize`, `primary`, `secondary` | Local state in the relocated tool-palette/color-panel widgets — tool config, not identity |
| `floating` (float-selection buffer) | Local module state in the relocated `float-session.js` — ephemeral interaction state |
| `commands` (the `CommandStack`) | Constructed inside `HistoryService`/`EditorHost` itself; `bootstrap.js` no longer hands it a pre-built stack |
| `on()`/`emit()` bus | Fully retired — every consumer moves to `EditorStore.subscribe(selector, listener)` |

## `js/ui/` → `js/components/` relocation

`js/components/` already exists (`canvas/`, `panels/`, `dom-utils.js`,
`panel-mount.js`) — it is the Presentation-layer shared-library location
the original roadmap's layering table already names. No new top-level
directory is created.

| Current file | New location | Notes |
|---|---|---|
| `canvasview.js` | `components/canvas/canvas-view.js` | Groups with existing `canvas/drag-cancel-guard.js`, `canvas/raster-cache.js` |
| `dimlabels.js` | `components/canvas/dim-labels.js` | |
| `overlays.js` | `components/canvas/sheet-overlays.js` | |
| `floatsession.js` | `components/canvas/float-session.js` | **Bonus fix while touching it:** the `isTypingTarget` re-export bug (`export { isTypingTarget } from '../components/dom-utils.js'` creates no local binding, so its use at the old line 452 throws `ReferenceError` on every keydown — pre-existing since commit `b2d5ea5` on 2026-07-16) gets fixed as part of this move |
| `tools.js` (947 lines, two bundled concerns) | Split: `components/tool-palette.js` (`TOOLS`, `registerTool`, `mountToolPalette`) + `components/canvas/drawing-engine.js` (`bindDrawing`) | Tool-palette UI and the shared pointer-drag drawing engine are separate concerns that happened to share a file |
| `panels.js` (1151 lines, color + layers) | Split: `components/panels/color-panel.js` + `components/panels/layers-panel.js` | Joins existing `components/panels/panel-frame.js`. `rgbaToHex`/`hexToRgb` move to `components/color-utils.js` |
| `previewpanel.js` | `components/panels/preview-panel.js` | |
| `baseDurationControl.js` | `components/panels/base-duration-control.js` | |
| `dialogs.js` | `components/dialogs.js` | |
| `menubar.js` | `components/menubar.js` | |

## `js/app/`'s state-free files

8 of 11 files have no coupling to `state.js` or the event bus — pure
relocation, not rewrite. They split by actual DDD layer rather than
moving as one block, since one of them does real I/O and doesn't belong
where the rest do:

- **`io.js`** does File System Access API calls directly (open/save
  pickers, packed/unpacked project bundle I/O) — that's Infrastructure,
  not Domain. Moves to `js/platform/browser/project-io.js`, alongside
  the existing `BrowserFileSystem`/`BrowserAutosave` adapters.
- **`exports.js`, `animationExport.js`, `c99Export.js`,
  `platformExport.js`, `projectExport.js`, `tiledExport.js`** build
  JSON/binary export *payloads* from the project model — pure data
  transformation with no I/O side effects of their own (`io.js` writes
  what they return). This is domain-service-shaped work (a form of
  serialization), matching how `js/core` is described in the DDD spec's
  layering table. Move to `js/core/export/`.
- **`pngcodec.js`** (`encodePng`/`decodePng`) is a pure byte-level codec
  with no I/O or state coupling — genuinely Domain-safe. Moves to
  `js/core/pngcodec.js`. It already has consumers outside
  `js/features` (`js/platform/browser/image-codec.js`, and the relocated
  `components/canvas/float-session.js`), so this location must stay
  importable from both `js/platform` and `js/components` — `js/core` is
  the one layer both of those are already allowed to depend on.

## Foundation group

Host-side groundwork that must land before any shell/mode file changes,
since everything downstream depends on it:

1. **`HistoryService` constructs its own `CommandStack`.** Today
   `bootstrap.js` does `new EditorHost({ historyStack: legacyState.commands,
   ... })`. This flips: the host builds its own stack internally, and
   `bootstrap.js` stops handing it a pre-built one.
2. **`EditorStore.project.model` becomes true sole owner.** Project
   creation/open/import calls directly into `ProjectService` (e.g.
   `host.projects.replace(newModel)`) instead of the legacy `setProject()`
   global. `ProjectService`/`DocumentService` already expose what's
   needed — this removes the legacy detour, it doesn't add new host
   surface.
3. **`activeSheet()`/`activeMap()`/`activeLayer()`-style helpers drop
   their legacy-fallback branch** — they already delegate to
   `host.documents`/`host.selections` when a host exists; the fallback
   path to raw `state.*` is deleted.
4. **`EditorStore.session.selectionsByDocument` extends to cover
   tile/terrain-set/frame/tile-editing selection**, not just
   layer/frame/animation — no schema change, since the per-document
   selection object is already freeform; mode command handlers/presenters
   start writing the new keys directly, replacing the adapter's
   first-seen-only seed workaround.
5. **New `EditorStore.workspace.overlays` field** (`{labels, sequences}`),
   using the workspace slice that already exists for `focusedSurfaceId`.

This group ships with its own test coverage before anything downstream
depends on it — no shell/mode file changes happen in this group.

## Group sequence

1. Foundation (above)
2. `js/ui/` → `js/components/` relocation
3. Per-mode cleanup: maps (6 files) → sprites (11 files) → tiles (12
   files), easiest-first, each an atomic big-bang group
4. Shell rewrite: `document-controller.js`, `file-controller.js`,
   `project-controller.js`, `filter-controller.js`, `menu-controller.js`,
   `editor-workbench.js`
5. Final deletion: `state.js`, `legacy-state-adapter.js`,
   `js/app/main.js`; relocate `js/app`'s 8 state-free files; delete
   `js/app`; delete `js/ui`; `bootstrap.js` absorbs whatever `main.js`
   still did (the 6 `mount*` calls)

Each group is a big-bang unit (matches how maps/sprites/tiles were each
originally done), not a file-by-file strangler-fig — chosen over
incremental per-file conversion because re-touching modes that are
already "done" benefits from being treated as one coherent unit per mode,
same as their original migration.

## Testing

- Full suite (`npm test`) stays green after every group.
- New/updated architecture-test assertions per group — once `js/ui`/
  `state.js` are retired, ban new imports of them the same way
  `tests/architecture.test.mjs` already bans other legacy paths.
- Non-drag Playwright smoke checks, done personally rather than
  delegated (per the established policy that subagent-reported browser
  evidence is unreliable), loaded with `?autotest`.
- Each group gets its own task-review cycle; the whole phase gets one
  final whole-branch review at the end, matching the pattern used for
  tiles' sub-phases.

## Biggest structural risk

The `js/ui` → `js/components` relocation group splits `tools.js`'s
shared `bindDrawing` pointer-drag engine into
`components/canvas/drawing-engine.js`. Every drawing tool in every mode
runs through that engine — a bug introduced there would not fail
cleanly, it would silently propagate into every downstream group's work.
Since drag interactions have no automated coverage (verified by hand, by
established policy — Playwright never simulates drags in this codebase),
this specific split gets the most thorough manual verification pass of
the whole phase, confirmed clean before the per-mode cleanup groups
start.

## Effort estimate

The original roadmap estimated 400K–700K tokens for "Phase 4," assuming
the three modes were already store-only. They are not — real scope spans
60+ files across 3 already-"done" modes plus the shell. Expect a cost
closer to the tiles migration's total (500K–900K) or higher; the
roadmap's stale estimate should not be treated as a ceiling.
