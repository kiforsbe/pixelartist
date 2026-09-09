# Palette Manager — Design

Date: 2026-09-09

## Purpose

Give the app a real palette manager: create palettes, modify them (colors,
order, size), use the built-in system palettes as templates, and import/export
palettes in the formats the pixel-art world actually exchanges.

Today palettes are barely manageable. The Colors panel can create a palette,
adopt a system palette wholesale, append a swatch, and recolor one entry of an
indexed palette. There is no rename, no delete, no duplicate, no reordering,
and no way to remove a swatch other than undoing the add that created it —
`moveSwatch` exists in `js/core/palettes.js` and has never had a caller, and
`removeSwatch`'s only call site is that undo. A palette adopted from a system
template is created `indexed`, and `addSwatch`/`removeSwatch` throw on indexed
palettes, so a template-derived palette cannot be edited at all.

## Current state

Model (`js/core/palettes.js`):

```js
{ id, name, indexed, size, colors: [[r,g,b,a], ...] }
```

- `indexed` currently means two things at once: *snap the brush to these
  colors* (`drawing-engine.js` — the only behavioral use) and *fixed size*
  (`addSwatch`/`removeSwatch` throw).
- `size` is written at creation and serialized, but **no code ever reads it**.
  Every consumer uses `colors.length`.

Consumers of a palette's colors: `nearestColor` / `nearestTwoColors` /
`quantizeBitmapToPalette` (core/palettes.js), `paletteColorsById` and
`activePaletteColors` (core/model.js), the quantize source palette
(core/quantize.js), the export color budget (file-controller.js), the brush
snap (drawing-engine.js), and two dropdown labels (color-panel.js,
filter-controller.js).

System palettes (`js/core/systempalettes.js`): 14 named sets plus EGA (64).
`clonePalette(sys)` produces an indexed palette sized to the template.

Palette edits are currently registered as **three byte-identical per-mode
command modules** (`sprites`/`tiles`/`maps` `palette-commands.js`). Because
maps mode has no active sheet for the remap branch, editing a swatch while in
maps mode is a silent no-op — a known bug noted in `color-panel.js`.

## Model

```js
{
  id, name,
  indexed: boolean,               // snap the brush; quantize/export source
  colors: [[r,g,b,a], ...],       // always real colors, never null
  empty:  [boolean, ...],         // parallel to colors, same length
  emptyColor: [r,g,b,a],          // this palette's "unset" color, default black
  lock: { size: number, reason: string } | null,
}
```

Three concerns that used to be tangled in `indexed` are now independent.

**`indexed`** keeps only its behavioral meaning: snap the brush to these
colors, and act as the quantize/export source. It no longer implies a fixed
size.

**`lock`** pins the entry count. `lock.size` is authoritative and always equals
`colors.length`; `lock.reason` records *why* — "NES", "Game Boy", or free text
for a custom number — so an exported palette is self-evidently a palette for a
particular system. Picking a size from the system-palette list fills both
fields; creating a palette from a system template locks it to that template's
count by default. `lock: null` is a free-growing list.

**`empty`** marks slots the user has not decided on. It is presentational: the
editor renders a flagged slot as unset rather than as a deliberate choice.
Outside the editor an empty slot is an ordinary color and behaves like one —
it is a brush-snap candidate, it counts toward the quantize/export budget, and
it is written to exported files. This matches today's behavior exactly (an
indexed palette of size 4 has always been four black entries).

**`emptyColor`** is the color an empty slot carries, chosen per palette in the
editor, defaulting to opaque black. Clearing slot `i` sets `colors[i] =
emptyColor` and `empty[i] = true`. Changing `emptyColor` re-assigns every slot
still flagged empty, so it remains this palette's unset color rather than a
one-time fill. Assigning any color to a slot clears its flag — including
assigning black, which is precisely the distinction the flag exists to record.

### Why a parallel array, not per-entry objects

Wrapping entries as `{ color, empty }` would force a change at every
`c[0], c[1], c[2]` site in core and in the exporters, for what is a display
concern. Keeping `colors` a plain color array means `nearestColor`,
`quantizeBitmapToPalette`, project serialization and all four export writers
work unchanged.

The cost is a length invariant across two arrays. It is contained by never
mutating them separately: reorder and sort go through one helper that pairs
`(color, empty)`, transforms the pairs, and unpairs. Every command that
changes length (resize, clear, add, remove) goes through helpers in
`core/palettes.js` that maintain both.

### Size rules

- **Locking** a palette with fewer colors than N pads with empty slots; with
  more than N, it drops entries from the end. The command applies the decided
  size; the *confirmation* for a lossy truncate is raised by the manager UI
  before the command runs (`confirmOrAuto`, as `color-panel.js` and
  `layers-panel.js` already do), keeping browser globals out of the command
  layer.
- **Unlocking** discards empty slots — they have no meaning in a free list.
- **Add** on a locked palette fills the first empty slot (no-op when full); on
  an unlocked palette it appends.
- **Remove** on a locked palette clears the slot in place, so indices below it
  do not shift; on an unlocked palette it splices.
- `size` is removed from the model. Nothing reads it, and on a resizable
  palette a stored count that disagrees with `colors.length` is a second
  source of truth.

### Loading older projects

Saved projects have `{indexed, size, colors}` and none of the three new
fields, so palettes are normalized once on load:

- `empty` → all `false` (every existing entry was a deliberate color as far as
  the old model could tell), `emptyColor` → opaque black.
- `indexed: true` → `lock: { size: colors.length, reason: '' }`. Those
  palettes were fixed-size under the old rules, so locking them preserves
  exactly the behavior the file was saved with; the empty reason renders as an
  unlabeled lock the user can name or clear.
- `indexed: false` → `lock: null`.
- `size` is dropped.

`colors.length` wins over the stored `size` if they disagree, since every
consumer already reads the array.

## File formats

New pure module `js/core/palette-io.js` — parse/serialize only, no DOM, no
host access, so it is directly unit-testable.

| Format | Parse | Serialize | Notes |
|---|---|---|---|
| `.gpl` | yes | yes | GIMP. Carries `Name:` and `#` comments. |
| `.hex` | yes | yes | One `rrggbb` per line; tolerates `#` prefixes. Reuses `parseHexColors`. |
| `.pal` | yes | yes | JASC-PAL / 0100 / count / `r g b` lines. |
| `.png` | via `pngcodec.js` + `colorFrequency` | swatch strip | Least precise: import order is by frequency, not authored order. |

All four are RGB-only: **export drops alpha, import forces opaque.** This is
worth knowing because non-indexed palettes here can hold alpha from the color
panel's alpha slider.

**Every entry is exported, empty slots included**, so a palette locked to 54
writes 54 entries. Because empty slots only exist in locked palettes, this
needs no special case — "write every entry" is correct for all palettes.

Provenance on export:

- `.gpl` — `Name: <palette name>` plus a `# Locked to <N> entries (<reason>)`
  comment. Standard GIMP syntax, survives round-trip; import reads both back.
- `.pal` — the JASC header's third line *is* the entry count, so the size is
  unmissable; the reason rides on the filename.
- `.hex`, `.png` — no metadata channel; filename only.
- Suggested filename — `My Palette (NES 54).gpl` when locked, `My Palette.gpl`
  when not.

Format is chosen by file extension. **Import always creates a new palette**,
named from the `.gpl` header or the filename — never overwrites the selected
one, so there is no destructive path to design around.

## Commands and undo

New shared module `js/features/palettes/palette-commands.js`. One family, not
three per-mode copies. Every command runs through
`history.execute(cmd, { scope: PROJECT_SCOPE })` so it is undoable from any
sheet or map — palettes are project-level and scoping them to a document would
strand them.

- `createPalette` — blank, from system template, from artwork, or from import
- `duplicatePalette`, `renamePalette`, `deletePalette`
- `addSwatch`, `setSwatchColor`, `remapSwatchColor`, `clearSwatch`,
  `removeSwatch`, `moveSwatch`
- `sortPalette` — by hue, luminance, or usage in the active sheet
- `setPaletteLock` — lock/unlock/resize, including the pad and truncate rules
- `setEmptyColor`, `setIndexed`

`setSwatchColor` and `remapSwatchColor` stay two commands, mirroring today's
split: the caller counts pixels of the old color on the active sheet, prompts
when there are any, and runs the remap variant — which rewrites the palette
entry and every affected layer bitmap in one undo step. Deciding *which*
command to run is a UI concern and stays with the caller (the manager, and
`color-panel.js`'s existing double-click path); the commands prompt for
nothing and touch no browser globals, so they stay testable under
`node --test` and consistent with the layering `architecture.test.mjs`
enforces on the mode command modules.

`clonePalette` in `js/core/systempalettes.js` is updated to emit the new shape:
`indexed: true`, `lock: { size: colors.length, reason: <system name> }`, no
`size`.

"New from artwork" reuses the engines that already exist — `colorFrequency`
(core/quantize.js) for every unique color ordered by frequency, and
`medianCutPalette` (core/quantize.js) for a reduction to N.

Selecting a palette in the manager also makes it the project's active palette.
That is a selection, not content, and stays outside the undo stack —
consistent with the existing palette dropdown.

New pure helpers in `js/core/palettes.js`: `sortColors(colors, mode, usage)`
and the paired reorder/resize/clear helpers that keep `colors` and `empty` in
step. Unique-color extraction needs nothing new — `colorFrequency` already
returns it.

## UI

`js/features/palettes/palette-manager.js`, mounted from `js/bootstrap.js`
alongside the other `mount*()` calls. That file is 39 lines against a 60-line
ceiling asserted by `architecture.test.mjs`, so it takes an import plus a
`mountPaletteManager()` line and nothing more — any wiring logic lives in the
feature module.

A non-modal, movable `<dialog id="dlg-palettes" class="dlg-movable dlg-scrolls">`
declared in `index.html` beside the filter dialogs, using the existing
`makeDialogMovable` / `centerDialog` / `closeOnEscape` helpers. Non-modal is
what makes the canvas-eyedropper and draw-to-test flows possible, and undo now
works with a non-modal dialog open.

Contents:

- Palette picker with New (blank / from system template / from artwork),
  Duplicate, Rename, Delete, Import, Export
- Name field; `indexed` checkbox; lock control (size dropdown listing system
  palette counts, the generic 2/4/16/256 presets, and a custom number, plus
  the free-text reason); empty-color picker
- A swatch grid: click to select, edit color, clear, remove, reorder, sort.
  Empty slots render distinctly. A "pick from canvas" button arms
  `armColorSample` — the same one-shot canvas sampler the filter dialogs use —
  and drops the sampled pixel into the selected slot
- A lock badge showing `54 — NES`

Entry points: a new `edit.palettes` action registered with `defineAction` and
added to the Edit menu's item list in `js/features/shell/menu-controller.js`
(as `{ action: 'edit.palettes' }`, the only form that list accepts), and a
**Manage…** button in the Colors panel replacing its `+` (New palette) and `⚙`
(System palettes) buttons, since both flows move into the manager. The panel
keeps its dropdown, its swatch strip and its quick add-current-color button —
the manager manages, the panel stays the fast path.

Two panel behaviors currently keyed off `indexed` move to `lock`, now that the
two are separate:

- the quick add-swatch button is hidden when `!pal.indexed` today; it becomes
  hidden only when the palette is locked *and* has no empty slot to fill
- double-click-to-edit a swatch is `indexed`-only today; it applies to every
  palette, since every palette is now editable

The manager re-renders from `history.subscribe` and store changes, the same way
`color-panel.js` already does, so undo/redo and edits made elsewhere are
reflected live.

## Removed

The three per-mode palette command modules and their registrations:

- `js/modes/sprites/application/commands/palette-commands.js`
- `js/modes/tiles/application/commands/palette-commands.js`
- `js/modes/maps/application/commands/palette-commands.js`
- the `*.editPaletteColor` / `*.remapPaletteColor` registrations in each mode's
  `contributions.js`
- their three test files (`tests/{sprites,tiles,maps}-palette-commands.test.mjs`),
  replaced by tests for the shared family
- the six now-absent command ids in `tests/builtinmodes.test.mjs`, which pins
  each mode's registered command list

They are byte-identical duplicates whose only reason to exist was per-mode
registration, and that triplication is why swatch editing is a silent no-op in
maps mode. The shared family fixes that rather than porting it forward:
`color-panel.js`'s `editIndexedEntry` stops dispatching
`` `${mode}.editPaletteColor` `` through the mode registry and calls the shared
commands directly, so the same double-click works in every mode.

## Testing

Node tests (`node --test tests/*.mjs`) cover the logic:

- `palette-io` round-trips per format, including malformed input, `.gpl`
  name/comment handling, and locked palettes exporting their full entry count
- the new core helpers: sort modes and the paired resize/clear/reorder helpers
  holding the `colors`/`empty` invariant
- every command's do/undo/redo, including the lock pad/truncate rules and the
  `emptyColor` re-sync
- the load-time normalization: an old `{indexed: true, size: 4}` palette comes
  back locked to 4 with an empty reason, an old non-indexed one unlocked, and a
  stored `size` disagreeing with `colors.length` loses
- updates to existing tests that assert behavior being deliberately changed:
  `'indexed palette pre-filled, addSwatch forbidden'` and the `clone.size`
  assertion in `tests/palettes.test.mjs`, plus the command-id list in
  `tests/builtinmodes.test.mjs`

The dialog has no panel test harness in this repo, so its wiring is verified in
the browser against a served build.

## Out of scope

- Gradient/ramp generation, palette merging, and color-harmony tools
- Per-color names (`.gpl` supports them; nothing in this app consumes them)
- Overwriting an existing palette on import
- Making the active-palette selection undoable
- Excluding empty slots from brush snapping (they behave as their color, as
  they do today)
