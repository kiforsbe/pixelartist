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

The same ms/fps/step model extends to the **project-level** default duration
(`project.settings.durationMs`, already used as a fallback in several places)
so it can be set in the New Project dialog and edited afterward from a new
Project Settings dialog, reachable from a new Edit-menu entry.

## Data model (`js/core/model.js`)

Two additions to the animation object, both optional / backward compatible
(no `PROJECT_VERSION` bump, same pattern as `breaks` in
`docs/superpowers/specs/2026-07-17-strip-segments-design.md`):

```js
anim.baseDuration      // ms, number
anim.baseFps           // number | undefined — only set once fps-mode is used
anim.baseStep          // number | undefined — "animate on Ns"; only set alongside baseFps
```

Seeded at creation time from the project's own default (see "Project-level
default duration" below) rather than a hardcoded value — `addAnimation`
falls back to `100`/unset only when no project defaults are available.

`baseDuration` is the single canonical value everything (playback, export,
inherited-frame display) reads. `baseFps`/`baseStep` exist purely so the panel
can redisplay "24fps, on 2s" after a reload instead of a raw ms number — they
are not read by anything except the panel itself. Editing either fps or step
recomputes and writes `baseDuration = round(1000 / baseFps * baseStep)`.
Editing ms directly writes `baseDuration` and clears `baseFps`/`baseStep`
(back to plain-ms mode; the panel shows the ms field on next mount).

Per-frame animation entries (`anim.frames[i]`, shape `{frameId, duration}`)
gain a second nullable field, `step`, and the meaning of both fields now
depends on the animation's current primary unit (`anim.baseFps` set = fps
primary, unset = ms primary — same flag the panel uses):

```js
{ frameId, duration, step }
// duration: ms override for this frame. Only read/editable when the
//           animation is ms-primary.
// step:     frame-count override for this frame ("hold for N ticks at
//           anim.baseFps"), overriding anim.baseStep just for this entry.
//           Only read/editable when the animation is fps-primary.
```

Both fields are independent and **non-destructive**: switching the
animation's primary unit does not clear whichever field goes dormant — it
just stops being read or shown as editable until the animation is switched
back. This means a per-frame override set under fps-primary is preserved (but
inert) if the animation is later switched to ms-primary, and vice versa.

`null`/unset on the field that's currently active → inherit from the base
(`anim.baseDuration` under ms-primary, `anim.baseStep` under fps-primary).

`addFrame`'s "add selected frame to animation" path (`frames.js`, the
`{ frameId, duration: 100 }` push noted in prior sessions) changes its default
to `{ frameId, duration: null, step: null }` — new frames inherit by default
regardless of which primary unit the animation is currently using. **Existing
saved frames keep whatever explicit `duration` number they already have** —
no migration, so old projects render identically after loading (they're all
implicitly ms-primary, since `baseFps` is new and starts unset); only
newly-added frames start out inherited.

`serializeProject`/`deserializeProject` need no change beyond what the
nullable fields already imply (plain JSON round-trips `null` fine); add
`baseDuration: a.baseDuration ?? 100` (and pass through `baseFps`/`baseStep`
if present) to both the serialize map and the deserialize defaulting map,
mirroring how `breaks`/`layerGroupId` are handled on those same lines.

### New helper

```js
// js/core/model.js
export function effectiveDuration(anim, entry) {
  if (anim.baseFps) {
    const step = entry.step ?? anim.baseStep ?? 1;
    return Math.round(1000 / anim.baseFps * step);
  }
  return entry.duration ?? anim.baseDuration ?? 100;
}
```

Used by:
- `js/ui/timeline.js`'s playback tick loop (`while (entry && acc >= entry.duration)` →
  `effectiveDuration(anim, entry)`) and the per-cell control's displayed
  value (see Timeline changes below for the ms-vs-frames input switch — no
  "reset to inherit" UI in this iteration either way; YAGNI, can be added
  later if wanted).
- `js/app/exports.js`'s `buildFramesJson` — `duration: af.duration` becomes
  `duration: effectiveDuration(a, af)`, so exported JSON always carries a
  real ms number regardless of inheritance or which primary unit was used to
  produce it (consumers of the export shouldn't need to know about the
  panel's UI-only fps/step concept).

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
- Per-cell control in the strip now depends on the animation's primary unit
  (`anim.baseFps` set or not), checked once per render pass, not per cell:
  - **ms-primary**: unchanged from today — a numeric ms `<input>`, writes
    `entry.duration` on change. Displayed value is `effectiveDuration(anim,
    entry)` (only matters for newly-added, still-inherited frames — old
    explicit-duration frames are unaffected since `entry.duration ?? ...`
    short-circuits on the existing number).
  - **fps-primary**: the ms input is replaced by a numeric **Frames**
    `<input>` (integer, min 1), writing `entry.step` on change — this is the
    per-frame override of `anim.baseStep` the user asked for ("how many
    frames that frame shall take"). Displayed value is `entry.step ??
    anim.baseStep ?? 1`. A small read-only caption next to it shows the
    computed ms (`effectiveDuration(anim, entry)`), same primary/editable +
    secondary/read-only pairing as the panel's own ms/fps display — ms is
    never directly editable per-frame while fps-primary is active.

## Project-level default duration (New Project dialog, Project Settings dialog, Edit menu)

Today `project.settings.durationMs` (`DEFAULT_SETTINGS.durationMs`,
`js/core/model.js:8-14`) is already a project-wide default, read as a
fallback in several `frames.js` call sites (`commitInsertFrame`,
`commitResizeSegment`, `commitNewStripFromFrame`, the New Strip dialog's
prefill) whenever a brand-new frame entry needs a duration and there's no
neighbor to copy from. It's set once, at project-creation time, via the New
Project dialog's plain "Frame time (ms)" field, with no UI to change it
afterward.

This extends that setting to the same primary-unit ms/fps/step model as the
Animation panel, and adds a way to edit it (and the rest of
`project.settings`) after project creation.

### Data model (`js/core/model.js`)

`settings` gains two optional fields, mirroring `anim.baseFps`/`anim.baseStep`
(same semantics, same "only set once fps-mode is used" rule):

```js
settings.baseFps    // number | undefined
settings.baseStep   // number | undefined
```

`settings.durationMs` remains the canonical ms value and keeps its existing
name (not renamed to `baseDuration`) since it's already referenced by that
name at the call sites listed above — renaming it is out of scope here.
`DEFAULT_SETTINGS` is unchanged (`durationMs: 100`, no `baseFps`/`baseStep`
keys — absent means ms-primary, same convention as the animation level).

`addAnimation(sheet, name, strip = false, defaults = {})` gains an optional
4th parameter (still a pure function, no `state`/DOM coupling): the new
animation's `baseDuration`/`baseFps`/`baseStep` are seeded from
`defaults.durationMs ?? 100`, `defaults.baseFps`, `defaults.baseStep` instead
of a hardcoded value. Every UI call site that creates a new animation
(`frames.js`'s "New strip…" dialog handler, `commitNewStripFromFrame`, any
other `addAnimation(...)` call) passes `state.project?.settings` as that 4th
argument, so new animations start out matching the project's current default
instead of always ms-100. Calling `addAnimation` with no 4th argument (e.g.
existing tests) keeps today's ms-100 behavior.

### Shared control (`js/ui/baseDurationControl.js`)

The ms/fps+step primary-unit control described in the Animation panel section
above (toggle, primary editable field, read-only converted secondary field,
fps-mode Step field) is needed in **three** places: the Animation panel, the
New Project dialog, and the new Project Settings dialog. To avoid three
copies of the same toggle/conversion logic, it's extracted into one small
reusable builder:

```js
// js/ui/baseDurationControl.js
export function buildBaseDurationControl({ getValue, setValue }) {
  // getValue() -> { durationMs, baseFps, baseStep }
  // setValue({ durationMs, baseFps, baseStep }) -> called on every commit
  // returns { el, refresh() } -- el is the DOM fragment to mount, refresh()
  // re-syncs displayed values after an external change (undo/redo, dialog
  // reopen).
}
```

The Animation panel wires `getValue`/`setValue` to the selected animation's
fields, going through `state.commands.push(...)` + `markDirty()` exactly as
already specified above. The two dialogs wire it to a plain local object held
until the dialog's Create/OK button commits it — no undo command mid-edit,
only on final commit, matching how the rest of each dialog's fields already
behave.

### New Project dialog (`index.html` `#dlg-newproject`, `js/app/main.js`)

The existing row:
```html
<span>Frame time</span><input id="np-duration" type="number" min="1" value="100">
<span>ms</span><span></span>
```
is replaced by a mount point (`<div id="np-duration-control" class="dlg-grid-span"></div>`)
that `main.js` fills via `buildBaseDurationControl(...)` at dialog-open time
(`file.new`'s handler, right before `dlgNewProject.showModal()`), seeded from
`DEFAULT_SETTINGS` (there's no existing project to seed from at this point —
same as today's hardcoded `value="100"`).

`npCreate`'s handler reads the control's current value instead of
`positiveInt(npDuration)`, and includes `baseFps`/`baseStep` in the `settings`
object literal only when set (fps-primary was used).

### Project Settings dialog (new `dlg-projectsettings`, `index.html` + `js/app/main.js`)

New dialog, same `dlg-grid` layout as `dlg-newproject` (Sprite sheet W/H, Tile
sheet W/H, Tile size W/H, Frame size W/H, Frame time control), except it
edits the **current** project's `settings` in place rather than creating a
new project:

- Opened via a new Edit-menu action, `edit.projectSettings` (label "Project
  Settings…"), appended to `MENUS`'s `Edit` entry in `main.js`:
  ```js
  { label: 'Edit', items: [
    { action: 'edit.undo' }, { action: 'edit.redo' }, { separator: true },
    { action: 'edit.cut' }, { action: 'edit.copy' }, { action: 'edit.paste' }, { separator: true },
    { action: 'edit.projectSettings' },
  ] },
  ```
- `defineAction('edit.projectSettings', { label: 'Project Settings…', run() {
  ...prefill every field from state.project.settings...; dlgProjectSettings.showModal(); } })`,
  following the same prefill-then-`showModal()` pattern `btnNewStrip`'s click
  handler already uses (`js/ui/frames.js:1583-1594`).
- Sheet-dimension fields (Sprite sheet / Tile sheet / Tile size / Frame size)
  edit the **defaults used for future new sheets/frames only** — the same
  role they already play in `DEFAULT_SETTINGS` — not a retroactive resize of
  existing sheets; changing those fields never touches any existing sheet's
  `width`/`height`. This matches current behavior (`DEFAULT_SETTINGS` is
  already only consulted at creation time) and is called out here so the
  dialog's copy doesn't imply otherwise.
- OK commits one undoable command snapshotting the whole `settings` object
  (before/after), matching the project's existing command idiom; Cancel
  discards all edits made in the dialog.

## Error handling / edge cases

- No animation selected: panel shows the same "no selection" hint style as
  the Frames panel's `hint.textContent = '...'` block, all controls
  disabled/hidden.
- `baseFps`/`baseStep` round-trip is lossy by design if the user only ever
  used ms mode (fields simply stay unset) — no attempt to reverse-derive
  fps/step from an arbitrary ms value.
- Switching a frame's duration/frames input back to exactly the inherited
  value still counts as an explicit override (no auto-detection that "this
  number happens to match the base") — matches the "inherit until edited"
  answer: editing always sets an explicit value; there's no "clear override"
  control in this iteration.
- Switching the animation's primary unit (ms ↔ fps) instantly changes what
  every timeline cell in that animation shows and accepts (ms input ↔ Frames
  input) — this is a display/edit-mode switch only, not a data migration;
  per-frame `duration` and `step` overrides already set are left exactly as
  they are (see "non-destructive" note above) and simply resume being
  read/editable if the animation is switched back.

## Testing

- Unit tests in `tests/model.test.mjs` for `effectiveDuration`:
  - ms-primary (`baseFps` unset): null `duration` falls back to
    `baseDuration`; explicit `duration` wins; missing `baseDuration` falls
    back to `100`.
  - fps-primary (`baseFps` set): null `step` falls back to `baseStep` (e.g.
    24fps + baseStep 2 → ~83ms); explicit per-entry `step` overrides
    `baseStep` (e.g. 24fps + entry `step` 1 → ~42ms even though `baseStep` is
    2); missing `baseStep` falls back to `1`.
  - Dormant-field case: an entry with both `duration` and `step` set only
    honors the one matching the animation's current primary unit.
- `tests/exports.test.mjs`: extend `buildFramesJson`'s existing test with an
  animation that mixes inherited and overridden entries, asserting real
  numbers for both (no `null` ever reaches the JSON).
- Playwright smoke (`?autotest`): open Animation panel for a selected
  animation → rename via panel, confirm timeline's animSelect option label
  updates → toggle Loop in panel, confirm it does NOT affect timeline
  playback wrap behavior (Preview Loop stays independent) → toggle Preview
  Loop in timeline, confirm it does NOT touch `anim.loop` (check via
  `browser_evaluate`, not visually) → set Base Duration via fps+step, confirm
  the timeline cells switch from an ms input to a Frames input → add a new
  frame to the animation, confirm its cell shows the base step count and the
  computed ms caption → override that frame's Frames count directly, change
  the base step again, confirm the overridden frame does NOT change while
  other inherited frames do → switch primary back to ms, confirm cells switch
  back to ms inputs showing `effectiveDuration`. Update `tests/smoke.md` with
  only these new items.
- Unit test: `addAnimation` with a `defaults` argument seeds
  `baseDuration`/`baseFps`/`baseStep` from it; called with no 4th argument (or
  an empty object) falls back to ms-100/unset, so existing direct callers and
  tests are unaffected.
- Playwright smoke (addendum): Edit menu → Project Settings → switch Frame
  time to fps-primary → OK → create a new animation, confirm its Animation
  panel's duration control opens already fps-primary, matching the project
  default (not ms-100) → separately, open the New Project dialog, confirm the
  same ms/fps control is present, create a project with fps-primary set,
  save/reload, confirm `settings.baseFps`/`baseStep` round-trip.
