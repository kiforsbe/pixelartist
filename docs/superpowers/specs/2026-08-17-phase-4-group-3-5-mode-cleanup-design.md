# Phase 4 Groups 3 + 5: Per-Mode Cleanup + Final Legacy Deletion — Design

## Status

Implements Groups 3 and 5 of
[2026-08-10-phase-4-shell-legacy-retirement-design.md](2026-08-10-phase-4-shell-legacy-retirement-design.md),
combined into one plan per the 2026-08-17 decision below. Foundation, the
`js/ui` → `js/components` relocation (Group 2), and the Shell rewrite
(Group 4) are complete and merged to `main` (HEAD `5d0eabb`).

## Goal

Migrate the last 29 mode files (6 maps, 11 sprites, 12 tiles) off
`js/app/state.js` and the legacy `on()`/`emit()` event bus, fixing a
latent dirty-tracking bug along the way. Once zero files import
`state.js`, delete it — along with the file-controller.js mirror block
that exists only to keep those 29 files working — and relocate `js/app`'s
remaining 8 state-free files to their correct DDD layer, retiring
`js/app` entirely.

## Decision: combine Groups 3 and 5, single big-bang pass

The parent spec originally planned Group 3 as three sequential
easiest-first sub-groups (maps → sprites → tiles), each with its own
task-review cycle, followed later by a separate Group 5. A 2026-08-17
amendment to the parent spec found Group 3 fully blocked pending Group 4;
Group 4 is now done. A follow-up scoping survey (2026-08-17, this design)
confirmed all three original blockers are resolved or narrowly scoped
(see below), and the user explicitly requested a single combined pass
rather than three further phase cycles. Group 5 is folded in because it
has no independent design content — it is mechanically gated on Group 3
reaching zero `state.js` importers, and leaving `state.js` / the mirror
in place after Group 3 finishes would be limbo with no purpose.

## Current-state findings (2026-08-17 scoping survey)

- **`EditorStore.project.model` sole ownership: resolved.** Legacy
  `state.js`'s own `setProject()` (state.js:123) has zero callers.
  `state.project =` is written only by the mirror subscriber in
  `file-controller.js` (host → legacy, one-way) — the host is the true
  writer.
- **Event bus retirement in `document-controller.js`: resolved.** It
  still reads `state`/`activeSheet()`/`activeMap()` for data, but
  contains zero `on()`/`emit()` calls itself.
- **`markDirty()` sole ownership: a real bug, not just incomplete
  migration.** Legacy `markDirty()` (state.js:122) sets `state.dirty`
  (nothing reads this anymore) and does `emit('project')` — it never
  calls `getEditorHost().projects.markDirty()`. This is harmless when it
  follows a `state.commands.push(...)` in the same call (the shared
  `CommandStack` instance already marks the host dirty via `onChange`,
  making the legacy `markDirty()` call redundant-but-harmless there).
  It is a **real correctness bug** for edits that mutate project data
  without going through the command stack — confirmed live at
  `map-panel.js:27` (snap-mode change) and `frame-editor-presenter.js`'s
  onion-settings commit. Those edits currently do not mark the host
  project dirty, so Save/autosave/beforeunload can silently miss them.
  **Fix:** every `markDirty()` call site converts to
  `getEditorHost().projects.markDirty()` as its file is migrated — not a
  separate pre-step, since every affected file is one this plan already
  touches.
- **File count unchanged from the parent spec: 29.** maps (6):
  `contributions.js`, `application/commands/map-paint-commands.js`,
  `presentation/{map-assets-panel,map-panel,map-tool-presenter}.js`,
  `preview.js`. sprites (11) and tiles (12) match the parent spec's table
  verbatim (see that doc's "Full list of currently-legacy-coupled files"
  table — reproduced in the implementation plan for the assigned tasks).
- **`terrain-preset-art.js:56`** still pushes directly onto
  `state.commands`, bypassing Command Handlers, with its own
  out-of-scope comment citing
  `2026-08-10-phase-3c-tiles-terrain-set-editor-design.md`. **Stays out
  of scope** for this plan too — it is a separate, pre-flagged concern
  about command-handler coverage, not a state-access migration.

## Non-goals

- No user-facing behavior change, except the markDirty fix itself
  (which corrects a real dirty-flag miss — observably, Save/autosave now
  correctly react to snap-mode and onion-settings edits that previously
  didn't mark the project dirty).
- `terrain-preset-art.js:56`'s command-stack bypass is not touched.
- No change to `project.json` save/load format.
- Group 2's relocations (`js/ui` → `js/components`) are already done;
  not revisited here.

## Target state, per file

For each of the 29 files, the same four mechanical substitutions apply
(exact call sites enumerated per-file in the implementation plan):

| Legacy usage | Replacement |
|---|---|
| `state.mode` / `state.tool` / `state.view` reads | `getEditorHost().store.getState().session.activeModeId` / `.activeToolId` / `.activeViewId`, or a `store.subscribe(selector, ...)` where the file needs to react to changes rather than read once |
| `activeSheet()` / `activeMap()` / `activeLayer()` helper calls | Already delegate to `host.documents` / `host.selections` when a host exists (per the parent spec's Foundation item 3) — call sites are unchanged, only the `import` source changes to confirm no fallback path remains reachable |
| `on(event, handler)` / `emit(event)` | `getEditorHost().store.subscribe(selector, listener, opts)` — selector chosen per what the file actually needs to react to (mirrors the pattern already used in the rewritten shell controllers, e.g. `editor-workbench.js`) |
| `markDirty()` | `getEditorHost().projects.markDirty()` |
| `state.commands.push(...)` (command-file only, not `terrain-preset-art.js`) | Already routes through `runEntityCommand`/host command dispatch in the surveyed representative files — confirm no direct `state.commands` access remains outside `terrain-preset-art.js` |

Once a file's last `state.js` import is removed, delete the import
statement — do not leave a dangling unused import.

## Final deletion (formerly Group 5)

Once `grep -rl "app/state.js" js/modes/` returns zero results:

1. Delete `js/features/project/file-controller.js`'s host→legacy mirror
   block (the subscriptions that write `state.project`,
   `state.activeSheetId`/`activeMapId`, `state.onion`, `state.mode`, the
   history bridge, the overlays mirror, and the `state.view` ↔
   `activeViewId` bidirectional sync) — its sole purpose was keeping the
   29 files working, and they're gone.
2. Delete `js/app/state.js`.
3. Relocate `js/app`'s remaining 8 state-free files, per the parent
   spec's table:
   - `io.js` → `js/platform/browser/project-io.js` (does real File
     System Access API I/O — Infrastructure layer)
   - `exports.js`, `animationExport.js`, `c99Export.js`,
     `platformExport.js`, `projectExport.js`, `tiledExport.js` →
     `js/core/export/` (pure payload construction — Domain-shaped)
   - `pngcodec.js` → `js/core/pngcodec.js` (pure byte-level codec,
     already consumed from both `js/platform` and `js/components`)
4. Delete `js/app` (now empty).
5. Update every import site that referenced the moved files (grep for
   `app/io.js`, `app/exports.js`, `app/animationExport.js`,
   `app/c99Export.js`, `app/platformExport.js`, `app/projectExport.js`,
   `app/tiledExport.js`, `app/pngcodec.js` across the repo).

## Testing

- `tests/architecture.test.mjs` gets a new guard banning any import of
  `js/app/state.js` or `js/app/*` (once step 4 above completes) — mirrors
  the existing pattern used for `legacy-state-adapter.js`/`main.js`.
- Full suite (`npm test`) stays green after every task.
- Manual Playwright smoke pass at the end, `?autotest`, no drag
  simulation (established policy) — exercise mode switching
  (maps/sprites/tiles), save/autosave triggering after a snap-mode edit
  and an onion-settings edit (the two markDirty bug repro cases), and
  undo/redo across all three modes.

## Execution shape

One implementation plan, one SDD run. Tasks batched by mode (maps,
sprites, tiles — each mode's files share the same cleanup shape) plus one
final task for the deletion/relocation sweep above. One whole-branch
final review at the end of the whole plan, not per sub-group.

## Effort estimate

29 files of mostly-mechanical substitution (the command-dispatch pattern
already exists in-file for most of them; only the read/react and
`markDirty()` sites change) plus a small, well-scoped final deletion
sweep. Expect meaningfully less than the tiles migration's 500K–900K
token range — closer to the Shell rewrite group's actual cost, since the
substitution pattern is now proven and repeated, not designed fresh per
file.
