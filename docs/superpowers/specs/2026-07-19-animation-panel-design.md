# Animation Panel — split from Frames panel, base framerate, export-loop UI

Date: 2026-07-19
Status: approved

## Goal

Sprite mode currently mixes two concerns into one place: `js/ui/frames.js`'s
Frames panel shows per-frame geometry AND (when the selected frame belongs to
a strip) the whole animation's name, while the animation's export-loop flag
only has a UI in the timeline dock, tied to the same preview-playback loop.

This adds a dedicated **Animation panel**, mounted below the Frames panel,
scoped to the *whole* animation (not a sub-strip segment):

- Animation name (moved out of the Frames panel's strip-detail block).
- Loop checkbox, bound to the existing `anim.loop` field that `exports.js`
  already reads — currently the only UI for it lives in the timeline, tied to
  preview playback. This panel becomes the "real" (export) loop control.
- Base Duration control, with a new inheritance model so per-frame timeline
  overrides still work: ms or fps input, with an fps-mode "Step" field for
  "target 24fps but animate on 2s" workflows.

The timeline keeps its own **Preview Loop** checkbox, decoupled from
`anim.loop`, so previewing on/off-loop never touches the export setting. The
timeline also keeps its rename (✎) button as a second way to rename — both it
and the panel's name field write the same `anim.name` and stay in sync via the
existing render-on-emit pattern.

## Data model (`js/core/model.js`)

Two additions to the animation object, both optional / backward compatible
(no `PROJECT_VERSION` bump, same pattern as `breaks` in
`docs/superpowers/specs/2026-07-17-strip-segments-design.md`):

```js
anim.baseDuration      // ms, number, default 100 (matches today's hardcoded frame default)
anim.baseFps           // number | undefined — only set once fps-mode is used
anim.baseStep          // number | undefined — "animate on Ns"; only set alongside baseFps
```

`baseDuration` is the single canonical value everything (playback, export,
inherited-frame display) reads. `baseFps`/`baseStep` exist purely so the panel
can redisplay "24fps, on 2s" after a reload instead of a raw ms number — they
are not read by anything except the panel itself. Editing either fps or step
recomputes and writes `baseDuration = round(1000 / baseFps * baseStep)`.
Editing ms directly writes `baseDuration` and clears `baseFps`/`baseStep`
(back to plain-ms mode; the panel shows the ms field on next mount).

Per-frame animation entries (`anim.frames[i]`, shape `{frameId, duration}`)
change `duration` to nullable:

- `null` → inherit `anim.baseDuration`.
- a number → explicit per-frame override, exactly as today.

`addFrame`'s "add selected frame to animation" path (`frames.js`, the
`{ frameId, duration: 100 }` push noted in prior sessions) changes its default
to `duration: null` — new frames inherit by default. **Existing saved frames
keep whatever explicit number they already have** — no migration, so old
projects render identically after loading; only newly-added frames start out
inherited.

`serializeProject`/`deserializeProject` need no change beyond what nullable
`duration` already implies (plain JSON round-trips `null` fine); add
`baseDuration: a.baseDuration ?? 100` (and pass through `baseFps`/`baseStep`
if present) to both the serialize map and the deserialize defaulting map,
mirroring how `breaks`/`layerGroupId` are handled on those same lines.

### New helper

```js
// js/core/model.js
export function effectiveDuration(anim, entry) {
  return entry.duration ?? anim.baseDuration ?? 100;
}
```

Used by:
- `js/ui/timeline.js`'s playback tick loop (`while (entry && acc >= entry.duration)` →
  `effectiveDuration(anim, entry)`) and the per-cell duration `<input>`'s
  displayed value (still writes an explicit override on `change`, exactly like
  today — no "reset to inherit" UI in this iteration; YAGNI, can be added
  later if wanted).
- `js/app/exports.js`'s `buildFramesJson` — `duration: af.duration` becomes
  `duration: effectiveDuration(a, af)`, so exported JSON always carries a
  real number regardless of inheritance (consumers of the export shouldn't
  need to know about the panel's UI-only concept).

## New Animation panel (`js/ui/animpanel.js`)

New file, new `mountAnimationsPanel(el)` export, mirroring the mount pattern
of every other panel (`mountFramesPanel`, `mountLayersPanel`, etc: `el.innerHTML = ''`,
build DOM once, subscribe to the app's render-on-emit events, re-render on
`project`/`selection`/`history`).

Mounted at a new `<div id="panel-animation" class="panel"></div>` in
`index.html`, placed directly after `#panel-context` (the Frames panel) inside
`#side-panels`, so it renders below it. Sprite-mode-only, same visibility
convention as the Frames panel content (hidden when `state.mode !== 'sprites'`
or nothing is selected).

Contents, scoped to `sheet.animations.find(a => a.id === state.selectedAnimationId)`
(the timeline's existing selection, not the Frames panel's per-frame
selection — this panel is about the *animation*, so it should follow
whichever animation the timeline has selected, and stay visible/filled even
when the Frames panel shows "no frame selected"):

- **Name** `<input type="text">`, same commit-on-change + undo command
  pattern as `commitRenameAnimation` (already exported from `model.js`,
  reused as-is — no new command needed).
- **Loop** `<input type="checkbox">`, reusing `commitToggleLoop`'s pattern
  from `timeline.js` (moved here; see Timeline changes below for what stays).
- **Base Duration**: both units are always visible — you set one, the other
  updates live as a read-only conversion for reference. A "ms" / "fps"
  toggle picks which one is currently **primary** (editable); the non-primary
  field becomes a disabled/read-only `<input>` showing the live-converted
  value, not a hidden field.
  - ms primary: the ms `<input>` is editable and writes `anim.baseDuration`
    directly on change (also clears `baseFps`/`baseStep`, since a raw ms
    value has no fps/step decomposition). The fps display recomputes as
    `1000 / baseDuration` (read-only, no Step shown — Step only has meaning
    once fps is the primary, editable value).
  - fps primary: "FPS" and "Step" (label: "animate on Ns") are editable;
    each on change recomputes `baseDuration` per the formula above and writes
    all three fields (`baseDuration`, `baseFps`, `baseStep`) in one undoable
    command. The ms display recomputes from the new `baseDuration` and shows
    read-only alongside it.
  - Toggling primary itself does not change `baseDuration` — it only flips
    which field accepts input; the read-only side simply reflects whatever
    `baseDuration` currently is.
  - Mode shown on (re)mount: fps primary if `anim.baseFps` is set, else ms
    primary.

All edits go through `state.commands.push({label, do, undo})` +
`markDirty()`, matching every other panel's mutation pattern (see
`commitRenameAnimation`/`commitToggleLoop` in the files above for the exact
shape to copy).

## Frames panel changes (`js/ui/frames.js`)

`renderStripDetail` (the block shown when the selected frame belongs to a
strip) drops its `nameInput` entirely — the title (`Strip · N frames...`) and
the geometry `fields` (X/Y/W/H/PivotX/PivotY) stay; the panel becomes purely
about the selected frame/strip's geometry, matching "frames panel is for the
selected frame."

`commitRenameStrip` (currently renames both the animation and every member
frame's `name`) stops being reachable from this panel; it's now only used
internally if something else needs the "rename members too" behavior — if
nothing else calls it after this change, delete it and have the new panel's
name field call the plain `renameAnimation` from `model.js` instead (frame
member names are cosmetic labels like `walk_0`, `walk_1` and are not required
to track the animation name — confirm no other caller depends on
`commitRenameStrip` before deleting; if the frame-tool's strip name affects
member-name display anywhere, keep `commitRenameStrip` and call it from the
new panel instead of plain rename).

## Timeline changes (`js/ui/timeline.js`)

- Keep `btnRenameAnim` (✎) — still does the existing `prompt()` +
  `commitRenameAnimation` round trip. Both this and the panel's name field
  write the same `anim.name`; the existing re-render-on-emit pattern already
  used across panels keeps them in sync with no new plumbing.
- Remove the existing `loopCheckbox`/`loopLabel` (currently bound to
  `anim.loop` via `commitToggleLoop`) — superseded by the panel's Loop
  checkbox.
- Add a new **Preview Loop** checkbox, local module state only
  (`let previewLoop = true;`, not read from or written to `anim` or `state` —
  session-only, resets to on every reload, per earlier decision). The
  playback tick loop's `if (anim.loop) { ... }` (wrap-to-start-or-stop logic)
  changes to `if (previewLoop) { ... }`.
- Per-cell duration `<input>` in the strip: value becomes
  `effectiveDuration(anim, entry)` instead of `entry.duration` (only matters
  for newly-added, still-inherited frames — old explicit-duration frames are
  unaffected since `entry.duration ?? ...` short-circuits on the existing
  number).

## Error handling / edge cases

- No animation selected: panel shows the same "no selection" hint style as
  the Frames panel's `hint.textContent = '...'` block, all controls
  disabled/hidden.
- `baseFps`/`baseStep` round-trip is lossy by design if the user only ever
  used ms mode (fields simply stay unset) — no attempt to reverse-derive
  fps/step from an arbitrary ms value.
- Switching a frame's duration input back to exactly the inherited value
  still counts as an explicit override (no auto-detection that "this number
  happens to match the base") — matches the "inherit until edited" answer:
  editing always sets an explicit value; there's no "clear override" control
  in this iteration.

## Testing

- Unit tests in `tests/model.test.mjs` for `effectiveDuration`: null entry
  falls back to `baseDuration`; explicit entry wins; missing `baseDuration`
  falls back to `100`.
- Unit test for the fps/step → ms formula (e.g. 24fps + step 2 → ~83ms;
  24fps + step 1 → ~42ms) — lives with the Animation panel's own module test
  if one is added, otherwise alongside `effectiveDuration` in
  `tests/model.test.mjs` if the formula itself moves into `model.js`.
- `tests/exports.test.mjs`: extend `buildFramesJson`'s existing test with an
  animation that mixes inherited and overridden entries, asserting real
  numbers for both (no `null` ever reaches the JSON).
- Playwright smoke (`?autotest`): open Animation panel for a selected
  animation → rename via panel, confirm timeline's animSelect option label
  updates → toggle Loop in panel, confirm it does NOT affect timeline
  playback wrap behavior (Preview Loop stays independent) → toggle Preview
  Loop in timeline, confirm it does NOT touch `anim.loop` (check via
  `browser_evaluate`, not visually) → set Base Duration via fps+step, add a
  new frame to the animation, confirm its timeline duration cell shows the
  computed ms value → override that frame's duration directly, change the
  base again, confirm the overridden frame does NOT change while other
  inherited frames do. Update `tests/smoke.md` with only these new items.
