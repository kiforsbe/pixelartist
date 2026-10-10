# Resizable docks, standard drag-and-drop, Aseprite-style timeline — plan

> Executed with parallel subagents in git worktrees, one branch per task,
> merged by the coordinator after each wave. One whole-branch review at the
> end.

**Spec:** `docs/superpowers/specs/2026-10-10-timeline-dock-dragdrop-design.md`
(read it first; sections are cited as §N).

## Global constraints (every task)

- Vanilla ES modules, no dependencies. Tests: `node --test tests/<file>.mjs`.
  The full suite is `node --test tests/*.mjs` (≈1430 tests, all green at
  the start).
- Windows + **PowerShell**. No bash. Python is available for scripted edits.
- Match the surrounding code: comment density, naming, 2-space indent,
  CRLF/LF as the file already has.
- Menu and context-menu items are `{ action: id }` via
  `js/features/shell/actions.js`'s `defineAction` — never ad-hoc
  `{label, run}` closures.
- Use the existing fake DOM `tests/helpers/sprite-context-dom.mjs`; extend
  it **additively** when needed (never change existing behaviour other tests
  rely on).
- Commit your work on your worktree branch when your task's tests and the
  full suite are green (focused commits, message style `feat: ...` /
  `fix: ...`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
  Never push, never `git stash`, never reset/checkout other branches.
- Only edit the files your task owns (listed per task). If you truly need a
  change elsewhere, make the smallest one and say so in your report.
- Report: files changed, tests added (names), the exact test commands you
  ran and their pass/fail counts, every deviation from this plan with why.

## Waves

| Wave | Tasks (parallel) | Depends on |
|---|---|---|
| 1 | T1 Dock resizer · T2 Drag-reorder module · T3 Model + range commands · T4 Context-menu component | — |
| 2 | T5 Layer tree rows · T6 Animations list + Sprites strip · T7 Animations timeline | wave 1 merged |
| 3 | T8 Docs, architecture test, browser check (coordinator) · final review | wave 2 merged |

---

### T1 — Dock resizer (§1)

**Owns:** `js/components/dock-resizer.js` (new), `tests/dock-resizer.test.mjs`
(new), `css/app.css` (dock/timeline-dock rules only: `#timeline-dock`,
`#anim-timeline-dock`, `.timeline-resize-handle` → `.dock-resizer`,
`.timeline-main`, sticky `.anim-tl-tags`/`.anim-tl-nums`), the resize section
of `js/modes/sprites/presentation/timeline-presenter.js` (≈ lines 55–141),
the mount section of
`js/modes/animations/presentation/animation-timeline-presenter.js` (≈ lines
110–130: only to mount the handle).

- Implement the API in §1 exactly (`createDockResizer`, `clampSize`,
  `keyStep`). Persistence through `host.preferences`
  (`js/platform/browser/preferences.js`, `getEditorHost().preferences`),
  injectable as `prefs` for tests.
- Replace the Sprites inline drag code with the component (keep its
  `onResize` re-render for thumbnails); migrate `timelineDockHeight` as the
  default for `dock.sprites.timeline.height`.
- Animations dock: same component; `measureContent` = handle + header +
  grid `scrollHeight`. Make sure the handle survives the presenter's
  re-render (mount it outside the re-rendered element, or re-prepend).
- Fix `.timeline-main { min-height: 0 }` so the grid scrolls vertically;
  sticky tag and frame-number rows (`top: 0`, opaque background, z-index
  above cels but below the sticky corner).
- Tests: clamp/keyStep pure tests; component on the fake DOM: drag changes
  height and persists on release; keys; double-click fit and restore;
  ARIA values update. Extend the fake DOM additively for attributes if
  needed.

### T2 — Drag-reorder module (§2)

**Owns:** `js/components/drag-reorder.js` (new), `tests/drag-reorder.test.mjs`
(new), `tests/helpers/sprite-context-dom.mjs` (additive), `css/app.css`
(append a new `/* drag-reorder */` block of `.dr-*` rules at the end of the
file only).

- Implement §2: `attachDragReorder` + pure `computePlacement`,
  `slotToFinalIndex`, `isNoOpDrop`, and the tree helper
  `treeDropDestination(tree, rows, sourceId, placement)` that maps a visual
  placement over `layerTreeRows`-ordered rows (last child shown first) to
  `{ destParentId, destIndex }` in the pre-removal-slot convention used by
  `model.moveNode` (`js/core/model.js` ≈ 307–330 — read it). Include the
  regression: dropping *below* row B (which shows child index i) lands the
  node at index i (i.e. visually below B), not i+1.
- Fake DOM additions as needed: settable per-element rect
  (`el.rect = {left, top, width, height}` used by `getBoundingClientRect`),
  `parentElement`, `closest`, bubbling for `fire` (opt-in so existing tests
  keep their behaviour, e.g. `fire(type, detail, { bubbles: true })` or
  `dispatch`), `isConnected`, `remove`, attribute storage
  (`setAttribute/getAttribute/removeAttribute`), `scrollTop/scrollLeft`,
  `document`/`window` keydown listeners, a steppable `requestAnimationFrame`.
- Tests: pure placement for flat x/y and tree (thirds, leaf halves, gaps
  snapping, before/after/into), slot maths, no-op detection, tree
  destination (root, into group, into expanded group first, descendant
  refusal); component: below-threshold is a click, drag + drop calls
  `onDrop` with the right placement, Escape cancels, `canDrop` false marks
  invalid and drops nothing, modifiers reported, the indicator element is
  removed afterwards.
- Do **not** migrate any call site (wave 2 does).

### T3 — Model additions and range commands (§3, §4)

**Owns:** `js/core/model.js` (animation normalisation/serialisation only),
`js/domain/sprites/playback.js`, exporters that play an animation as a
sequence (find them: grep `anim.frames`/`animation` in `js/core`,
`js/features/export*`), `js/modes/sprites/application/commands/animation-lifecycle-commands.js`,
new `js/modes/sprites/application/commands/animation-range-commands.js`,
`js/modes/sprites/contributions.js` (registration lines only), the Preview
panel playback call if it computes order itself, tests (new
`tests/animation-range-commands.test.mjs`, `tests/animation-direction.test.mjs`,
plus additions to existing playback tests).

- `anim.direction`, `anim.color` defaults on load and new animations
  (`newAnimation`, `newAutoAnimation`, `duplicateAnimation` copies them),
  written on save, project round-trip test.
- `playbackSequence(count, direction)`; playback (`advancePlayback` or
  equivalent) follows it; animated exports follow it.
- Commands `sprites.setAnimationDirection`, `sprites.setAnimationColor`
  (validate values; refuse unknown direction / bad colour).
- Range commands from §4, in the new file, reusing
  `animation-layout-commands.js` helpers (`runLayoutCommand`,
  `addAutoFrame`'s copy logic, `isFrameReferenced`, `findAnimation`,
  `frameContent`). Manual animations: entry-list edits only; frame-creating
  commands refuse with the existing message. Each command is **one** history
  step (one `runLayoutCommand` or one history entry), with byte-exact undo.
  Clamp/validate ranges; refuse empty or out-of-range.
- `animations.clearCel` refuses a locked layer; works for any frame.
- Tests for every command: effect, undo, redo, auto and manual, refusals.

### T4 — Context-menu component (§5, E6)

**Owns:** `js/components/context-menu.js` (new), `tests/context-menu.test.mjs`
(new), `css/app.css` (append a `/* context menu */` block at the end).

- `openContextMenu({ x, y, items, anchor? })` → `close()`; `items` is the
  menubar's item format (`{ action }`, `{ separator: true }`,
  `{ label, submenu: [...] }` where submenu items are again actions). Reuse
  the menubar's rendering/labels/shortcut/checked/enabled logic
  (`js/components/menubar.js`, `js/features/shell/actions.js`) — extract a
  shared item renderer if that avoids duplication.
- Disabled actions shown disabled; `isAvailable` false hides; checked
  actions show a check. Clicking runs `runAction(id, args?)` (items may
  carry `args`) and closes.
- Closes on Escape, outside pointerdown, scroll/resize, or running an item.
  Keyboard: Up/Down move, Enter runs, Right/Left open/close a submenu.
  Positioned at the pointer, clamped inside the viewport.
- `attachContextMenu(el, (event) => items | null)` helper: on
  `contextmenu`, `preventDefault`, call the builder (which may select what
  was hit first), open the menu.
- Tests on the fake DOM.

### T5 — Layer tree rows (§2, §6) — wave 2

**Owns:** `js/components/panels/layer-tree.js`, `js/components/panels/layers-panel.js`,
`tests/layer-tree.test.mjs`, new tests as needed, `css/app.css` (remove the
old `.drop-before/.drop-after/.drop-into/.dragging` layer rules; add eye/lock
paint feedback if any).

- Replace `attachLayerTreeDrop`/`draggedId`/`dropLists` with
  `attachDragReorder` (tree mode) + `treeDropDestination`. Keep the
  exported names the timeline imports working, or update the single
  import in the timeline presenter in coordination (T7 owns that file —
  keep `attachLayerTreeDrop(list, opts)` as the public entry, now built on
  the module).
- Map layers (`layers-panel.js`): draggable via the module, dispatching
  `maps.moveLayer` with the delta (check the command's args).
- Alt-click eye = solo / restore; drag across eyes/locks paints (one
  history step per gesture — read how visibility/lock toggles dispatch).
- Right-click a row → context menu with the existing `layer.*` actions (add
  `layer.rename` and `layer.duplicate` actions only if the commands exist).
- Tests: drop mapping through the presenter (inversion regression), solo,
  paint, context-menu items.

### T6 — Animations list + Sprites strip (§2, §7) — wave 2

**Owns:** `js/modes/animations/presentation/animation-list-panel.js`,
`tests/animation-list-panel.test.mjs`, the frame-strip drag section of
`js/modes/sprites/presentation/timeline-presenter.js`, its tests,
`css/app.css` (remove the old `.drag-before/.drag-after` strip rules once
unused — check T7's usage first; the Animations timeline also uses them).

- Animations list: drag-reorder (insertion line), dispatch
  `animations.reorderAnimations` with `slotToFinalIndex`; direction
  `<select>` and colour swatch (`<input type=color>` + "none") dispatching
  T3's commands; thumbnail border in the animation colour.
- Sprites strip: drag-reorder (axis x, ignore inputs/buttons) dispatching
  `animations.moveFrames` with a one-entry range (works for both layouts
  per T3) — delete the `text/plain` HTML5 code.
- Rewrite the HTML5-drag tests to the new pointer flow.

### T7 — Animations timeline (§5) — wave 2

**Owns:** `js/modes/animations/presentation/animation-timeline-presenter.js`,
`js/modes/animations/application/timeline-model.js`, new
`js/modes/animations/presentation/timeline-actions.js` (actions +
shortcuts), `js/modes/animations/contributions.js` if registration is
needed, `tests/animation-timeline.test.mjs`,
`tests/animation-timeline-model.test.mjs`, new tests, `css/app.css`
(`.anim-tl-*` rules).

- Range selection, durations under numbers, double-click number → duration
  input (range-aware via `animations.setFrameDurations`), tag colour +
  direction glyph, double-click tag rename (`sprites.renameAnimation` or the
  existing rename command), Ctrl+wheel column width.
- Frame-number drags via `attachDragReorder` (axis x): range move
  (`animations.moveFrames`), Alt copy (`animations.copyFrames`), Ctrl link
  (`animations.linkFrame`), keeping the existing `ensureAuto`/`settleOffer`
  offer flow for commands a manual animation refuses (copy, link, and now
  duplicate/unlink). Remove the HTML5 drag code and `.drag-before/after`
  usage.
- `timeline-actions.js`: `defineAction` for every frame/tag/cel operation
  (ids `animations.timeline.*`), shortcuts per §5 in one window keydown
  handler, active only in Animations mode, ignoring typing targets, open
  dialogs, and (for Enter) focused buttons. Check `tool-palette.js` and
  other window handlers for key collisions.
- Context menus via T4's `attachContextMenu` on frame numbers, cels, tags.
- Keep every existing timeline test passing (adapt drag tests to the
  pointer flow).

### T8 — Integration (coordinator)

- Merge wave branches; run the full suite.
- README "Animations workbench" + a "Timeline shortcuts" table; ARCHITECTURE
  module list/counts; architecture test updates for new components.
- Browser check (no drag simulation): dock double-click fit, context menu
  opens and runs Reverse, Alt+N duplicates, Enter plays.
- Fresh whole-branch review (most capable model); fix Critical/Important.
