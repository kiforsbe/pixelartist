# Smoke checklist

End-to-end manual/Playwright script covering every major feature area
(condensed from the Task 13/16/18/19/20 verification lists). Run against
the local URL printed by `./serve.ps1`, with `?autotest` appended (the
launcher chooses an available port; do not assume 8080). Alternatively,
`python -m http.server 8080` uses `http://localhost:8080/?autotest`.
The `?autotest` query flag
(`js/platform/browser/autotest.js`) suppresses `confirm()`/`beforeunload`
prompts and skips the autosave-restore prompt on boot, so automated runs
don't block on native dialogs.

Each item is marked:

- **[A]** automatable via Playwright MCP (dispatch clicks/keys, read
  `state`/DOM/console — no native OS picker involved)
- **[M]** manual only (native file/folder pickers, requires leaving the
  tab/restoring a real browser session, or involves a pointer drag/resize/
  snap gesture — agents are policy-restricted from simulating drags in this
  repo, so the owner verifies these directly)

Run the **[A]** items in one pass after any change that touches drawing,
layers, palettes, frames, animation, the frame/tile editors, tile mode, or
exports. Check the browser console after every step — zero errors/warnings
is a pass condition for the whole run, not just the final step.

Where an **[A]** item needs existing artwork, a grid, or a floating selection,
prepare a disposable fixture through the model/command APIs or use
owner-prepared state; do not synthesize drag gestures to set it up. The
**[M]** items remain separate owner-run release gates, not covered by an
automated pass. This checklist is procedure, not a record of completed checks.

## 1. Launch

Focused startup/panel regressions are also executable in
`tests/browser/workbench-regressions.mjs`. With an isolated Playwright `page`
and a local server already running, set `PIXELARTIST_URL` to its printed
local URL and invoke these from a Node session at the repository root
(these browser checks are separate from `npm test`):

```js
const checks = await import('./tests/browser/workbench-regressions.mjs');
const appUrl = new URL('?autotest', process.env.PIXELARTIST_URL).href;
await checks.verifyInitialSheet(page, appUrl);
await checks.verifySheetSwitchSizing(page);
await checks.verifyModePanelVisibility(page);
```

They check the rendered checkerboard before any mode switch, differently sized
sheets through the document dropdown, and outer panel visibility across modes.
They use a disposable project and no native pickers or pointer drags.

1. [A] Open the server's printed local URL with `?autotest`. Page loads, no console
   errors, a demo project is created automatically (no autosave-restore
   prompt).
2. [A] Sprite Sheets tab is active by default; canvas shows the demo
   sprite sheet.
3. [A] Status bar shows a tool name, position, and zoom level.

## 2. Draw (pencil / shapes / fill / eraser) + undo

4. [M] Select Pencil (`B` or click). Draw a short stroke on the canvas.
   Pixels change; Undo button becomes enabled.
5. [A] Select Eraser (`E`). Click a painted pixel to erase it. Undo restores it.
6. [M] Select Line (`L`), drag a line. Select Rect (`U`), drag a
   rectangle (toggle "Filled" once). Select Ellipse (`O`), drag an
   ellipse (toggle "Filled" once).
7. [A] Select Fill (`G`), click inside a closed shape. Toggle
   "Contiguous" and fill again.
7a. [A] Select Soft flood (`K`). Set a nonzero tolerance and feather, then
   left-click a shaded region to softly fill it; right-click a matching region
   to softly erase it. Verify one undo/redo step per click. Repeat from the
   tile sheet and the focused tile editor; pixels outside the active tile do
   not change.
8. [A] Press `Ctrl+Z` repeatedly back to the empty canvas; press
   `Ctrl+Y` (and `Ctrl+Shift+Z`) to redo forward again. Undo/redo
   buttons disable at the ends of the stack.
9. [A] Eyedropper (`I`): click a drawn pixel, primary color swatch
   updates to match.
10. [M] Select tool (`M`): drag a marquee; dragging from inside it moves the
    RECTANGLE only (contents stay put — verify pixels unchanged); `Escape`
    clears the marquee. Corner/edge handles (8) resize the marquee; while
    dragging, CAD dimension lines (extension lines, arrows, value pills)
    show origin, W×H, and Δ; idle selection shows the quiet variant.

## 3. Layers

11. [A] Layers panel: "Add" creates a new layer, becomes active. Undo
    removes it.
12. [A] Reorder with the ↑/↓ buttons; undo restores prior order.
13. [M] Drag the opacity slider; layer visibly fades; releasing commits
    one undo step (not one per drag tick).
14. [A] "Merge Down" combines the active layer into the one below; undo
    restores both layers and pixels.
15. [A] Toggle a layer's visibility (👁/🚫); canvas updates immediately.

## 4. Palettes

16. [A] Colors panel: open "System…", clone a system palette. It becomes
    active and its swatches render in the strip.
17. [A] Create a new indexed palette (size preset). Click with Pencil —
    color snaps to the nearest palette entry.
18. [A] Double-click an indexed swatch, change its color: if that color
    is used on the active sheet, a remap confirmation is offered and
    accepted (`confirmOrAuto` auto-accepts under `?autotest`); pixels
    recolor. Undo restores both the palette entry and the pixels.
19. [A] Non-indexed palette: "+ Add current color" appends the primary
    color as a new swatch.

## 5. Frames

20. [M] Switch to frame tool (`F`, sprite mode only). Drag to create a
    frame; it appears as an overlay on the canvas (labels/sequence overlay
    toggles in the top bar affect visibility). The Frames panel shows a
    detail block for the SELECTED frame only (hint text when nothing is
    selected); selecting a strip member shows one strip-wide block instead
    — name renames the animation and every member, X/Y move the whole
    strip rigidly, W/H set the shared frame size (W re-lays each sub-strip
    contiguously), pivots apply to all members; one undo step each. The
    detail block's action row is icon buttons (✎ Edit, 🗑 Delete/Delete
    frame); a standalone frame's row has just those two, while a strip
    member's row adds a third, ✂ Break apart, which flips the animation's
    `strip` flag off (converting it to loose frame entries) as one undo
    step and then disappears from the row since the selection is no longer
    a strip.
21. [M] Drag-move a frame with the frame tool: metadata-only — the frame
    rect moves, pixels stay put (like dragging a marquee); one undo step
    restores the position. Move shows origin (+dx, +dy); create/resize
    drags show W×H pills with Δ on arrowed dimension lines.
21b. [M] Move tool (`V`) on a frame/strip segment (no marquee active):
    starts a translate-only frame-float — frame-style chrome, no scale
    handles or rotation knob — live-previewing the pixels; committing
    (Enter/click outside) moves frame rects and pixels together; Escape
    cancels both. Undo of the commit restores rects and pixels.
22. [M] Drag a corner handle to resize the selected frame; undo restores
    original bounds.
23. [A] Frame tool (`F`) options row: Slice grid… button (▦, alongside
    Snap/grid-size) opens a dialog that creates a full grid of frames
    from cell/margin/spacing settings ("Replace existing frames" tested
    both on and off); undo removes them (and any animation entries that
    referenced them). While the dialog is open, a live ghost grid previews
    the cells with per-column/per-row dimension chains and overall dims;
    the preview updates as inputs change and disappears on Cancel.
24. [A] Select a frame, press `Delete`: frame is removed; undo restores
    it (and any animation frame-entries that referenced it).

## 6. Animation

25. [A] Timeline: "New" creates an animation; select a frame in the
    Frames panel, "Add selected frame" appends it to the timeline strip.
26. [M] Drag-reorder two cells in the strip; undo restores original
    order.
27. [A] Clicking a timeline cell once: scrubs the preview playhead to it,
    sets the active sheet's selected frame (via SelectionService — check
    with `getEditorHost().selections.get({ kind: 'sprite-sheet', id })`,
    so the Frames panel and the sprite-sheet highlight follow), AND opens
    the frame editor on that frame directly — no double-click needed.
28. [A] Edit a cell's duration number input; undo restores the prior
    value.
29. [A] Toggle "Preview Loop"; Play (▶) advances the Preview panel's canvas
    (bottom of the right-hand sidebar, not the timeline dock) through
    frames, wrapping if Preview Loop is on; Pause stops it. First/Last
    transport buttons jump to the ends. Speed selector changes playback
    rate. Preview Loop never touches the animation's export `loop` flag
    (checked via `browser_evaluate`, not visually).
29b. [A] The Preview panel is general-purpose, not animation-only: with no
    animation selected, selecting/editing a frame (sprites) or a tile
    (tile mode) shows it there instead — verify by setting the sprite
    sheet's selected frame via `getEditorHost().selections.set({ frameId },
    { kind: 'sprite-sheet', id })` (or `state.selectedTileId` for tile
    mode, still legacy) and checking the panel's canvas updates. Its own
    `−`/`+`/Fit controls (bottom-right
    overlay on the canvas) and mouse wheel step zoom through the same
    table as the main canvas (`js/core/zoom.js`); Fit is the default and
    snaps to contain the content, `−`/`+`/wheel switch to a manual step
    and the readout shows the current percentage. Zoom level persists
    across frame/tile/animation-frame changes (doesn't reset to Fit just
    because the shown content changed). The canvas is sized to exactly
    fill the sidebar's width at 1:1 (its `width`/`height` attributes
    match its rendered CSS size — check via `getBoundingClientRect()`,
    not just visually, since a mismatch there silently breaks 1:1 zoom
    accuracy).
29c. [M] Preview panel: plain click-drag on its canvas pans the content
    (no Space/middle-click gate, unlike the main canvas) — dragging while
    zoomed to Fit freezes the current fit zoom into a manual level first
    so there's room to pan. Panning is a pointer-drag gesture, so this
    item is manual-only per this repo's Playwright policy.

30. [A] Animation panel (below Frames): shows name/Loop/duration for the
    timeline's selected animation, independent of the Frames panel's own
    selection. Renaming via the panel and via the timeline's ✎ button both
    update the same animation name. Loop here is the export flag, distinct
    from the timeline's Preview Loop. Switching the duration control between
    ms and fps+Step changes what the timeline's per-frame cells accept
    (plain ms vs a Frames/step count with a read-only ms caption).
31. [A] Animation selection stays in sync across the timeline's animation
    dropdown, the Layers panel, and the sprite sheet: selecting an
    animation-owned group in the Layers panel selects it in the timeline
    dropdown and vice versa; clicking a frame on the sprite sheet that
    belongs to an animation selects that animation everywhere too.
    Selecting something with no owning animation (a plain layer/group, a
    standalone frame, or empty canvas space) clears the animation selection
    to "(none)" in all three rather than leaving a stale one selected
    (verify via `getEditorHost().selections.get({ kind: 'sprite-sheet', id
    }).animationId`, not just visually).

## 7. Frame editor

32. [A] Click a frame (via its Edit button, or a single click on its
    timeline cell — see item 27) to open the frame editor; canvas
    re-centers on just that frame.
33. [A] Click with Pencil, Eraser, and Fill inside the frame editor;
    edits stay confined to the frame's rect. Dragged strokes/shapes remain
    manual checks (items 4 and 6).
34. [A] Enable Onion skin: defaults to Back 1 / Ahead 0 (no future ghosts
    until Ahead is raised) and Outline on / Mask off. Outline traces a 1px
    edge around each ghost frame's silhouette (hollow interior, not a
    filled tint); enabling Mask too layers a soft filled tint underneath
    the outline — both can be on at once, or either alone, or neither
    (no ghosts drawn). The onion controls are visually grouped into three
    clusters in the toolbar: overall (Onion/Mask/Outline toggles + Current
    fade), Back/past-only, and Ahead/future-only, separated from the
    Prev/Next nav controls by a divider. Set Back/Ahead counts and confirm
    ghosts appear/disappear accordingly.
34b. [A] Mask and Outline each have their OWN opacity slider per direction
    (Back group: ■ Mask α, □ Outline α; Ahead group: same, independent
    values) — use keyboard input, not a drag, to raise Back's Outline α
    without touching Ahead's; this changes
    only past ghosts. The Back/Ahead color swatches in the toolbar set each
    direction's default ghost tint; the ⚙ button opens Project Settings
    (Edit menu > Project Settings…) pre-flipped to its "Onion Steps" tab
    (item 78), a 5-column table (Step # | Back Default | Back Color | Ahead
    Default | Ahead Color, with "Back"/"Ahead" grouping the two sub-headers
    beneath them) listing all 8 possible Back steps and 8 Ahead steps, each
    with its own Default checkbox and Color swatch in SEPARATE columns
    (checked Default = falls back to the toolbar swatch and dims that row's
    Color swatch to show it's not in effect; unchecked = uses that step's
    own Color, shown at full opacity) — out of the box every step is
    pre-seeded with a distinct color from a shared 8-color palette (same
    palette for both directions) so e.g. step 3 back and step 3 ahead are
    both yellow, and neighboring steps never share a color. "Current α"
    (main group, no visible label — check its tooltip) fades the frame
    being edited, only while Onion is checked, so ghosts (especially
    Outline) read more clearly against it; unaffected when Onion is off.
    All of the above (`state.onion` — enabled/back/ahead/mask/outline/
    currentAlpha/back·aheadMaskAlpha/back·aheadOutlineAlpha/back·aheadColor/
    stepColors) lives in `project.settings.onion` and round-trips through
    Save/Open (automate via `serializeProject`/`deserializeProject`, not
    native pickers; real save-reload stays [M], items 72–73), not just an
    in-session preference.
35. [A] Prev/Next step through the animation's frame order (or sheet
    order if the frame isn't in the selected animation).
36. [A] `Escape` returns to the sheet view (also via "← Back to sheet").

## 8. Tile mode

37. [A] Switch to Tile Sheets tab on a fresh tile sheet: Tiles panel shows
    "➕ Autotiles" (tooltip "Add terrain set") and "No tile selected" — no
    Add Grid dialog, grid list, or tile count (selection-driven, like the
    Frames panel).
37b. [A] The Tile Sheets tab shows three separate sidebar panels: "Tiles"
    ("➕ Autotiles" button and selected-tile detail), "Autotiles"
    (terrain sets, view modes, symmetry toggles), and "Tile Layers" (the
    sheet.tileLayerNames name list). On the Sprite Sheets tab, Autotiles and Tile
    Layers are hidden entirely — not just their inner content: the
    `#panel-autotiles`/`#panel-tilelayers` containers themselves have
    `hidden` set (`getComputedStyle(el).display === 'none'`), so no empty
    bordered/padded box is left behind in the sidebar.
38. [M] Select Tile tool (`T`) and drag empty canvas space to create a
    standalone tile. Select it: four short grips appear at its edge centers.
    Drag one grip outward by whole tile widths/heights to grow a grid;
    repeat on another edge to add rows/columns. Drag inward to shrink it;
    a 1×1 grid collapses to a standalone tile. Undo/redo restores each
    change. This gesture-only workflow replaces the removed Add Grid dialog.
39. [A] Tile tool (`T`, tile mode only): click a tile in the grid to select
    it — the Tiles panel shows a name field, an "Edit tile" icon, the owning
    grid's W/H fields (editing either re-lays-out every tile in that grid),
    "Detach from grid" and "Delete grid" icons, and a Layer dropdown (item 59).
40. [M] Drag a standalone tile onto another SAME-SIZE tile (no Shift) to swap them —
    pixels, names, and neighbor presets swap on all layers; undo restores
    both. Shift-drag instead moves (source clears to transparent, its
    name/neighbors move to the target); undo restores both tiles.
41. [M] Drag a grid-owned tile's body: the whole grid moves, clamped to
    the sheet bounds, even when the pointer lands over another tile. A grid
    cell does not swap or move independently. The grid's origin-corner
    handle also moves the whole grid; undo restores the prior position.
42. [M] Click empty canvas space and drag with the tile tool active: creates
    a new standalone tile there (frame-style create-drag); the panel shows
    W/H fields for it (no "Detach" button, since it isn't grid-owned).
    Dragging a standalone tile to empty space (or a different-size tile)
    repositions it; undo restores its prior position.
43. [A] Select a grid-owned tile, click "Detach from grid" — it becomes a
    standalone tile (W/H fields now edit only this tile; resize handles appear);
    undo restores its grid membership.
44. [A] Selecting a tile in a grid and editing that grid's W/H fields
    (Tiles panel, item 39) re-lays-out every owned tile from the grid's
    origin, preserving each cell's name/neighbor preset; each edit is one
    undo step. Row/column counts change via edge-grip drags, not panel
    fields; verify those separately in manual item 38.
45. [A] "Delete grid" (Tiles panel, item 39) removes the grid and every
    tile it owns; if that empties out a terrain set (no tile references it
    anymore), the terrain set is deleted too and its row disappears from
    the Autotiles panel's list — a DIFFERENT, still-empty terrain set
    created via "(none — add tiles manually)" is untouched. Undo restores
    the grid, its tiles, and any implicitly-deleted terrain set in one
    step. Select a standalone tile and press `Delete`: it's removed; undo
    restores it. Grid-owned tiles have no direct delete (detach first).

## 9. Tile editor

46. [A] Double-click a tile (or "Edit tile") to open the tile editor;
    center tile is outlined, neighbor cells render the live composite.
47. [M] Draw inside the center tile: neighbor cells that mirror it (mode
    `same`) update live as you draw (drag confinement: strokes cannot
    escape the center tile even if the drag leaves it).
48. [A] Click a neighbor slot (outside the center tile, no drag) to open
    the slot config dialog; the "Other tile" field is now a dropdown
    listing every tile on the sheet (`"{index}: {name}"`, or `#index` if
    unnamed) — try each mode (`same tile` / `other tile` + selection /
    `empty`), and Flip H/V; OK commits, undo restores the prior preset for
    that slot.
49. [A] Switch the neighbor radius to 5×5 and back to 3×3; grid resizes
    and recenters, sized from the edited tile's own W/H (not a sheet-wide
    size).

## 9a. Terrain sets, layers & tags

50. [A] Terrain Sets list (Autotiles panel) starts empty; the "➕ Autotiles"
    button in the Tiles panel (tooltip "Add terrain set") opens a
    dialog that defaults Tile W/H from the project's tile size setting;
    creating one adds a row to the Autotiles panel's list with its name and
    size.
51. [A] Clicking a terrain set's row opens its 47-slot editor below,
    grouped in ascending neighbor-count rows; the 16 core slots show a
    distinct (blue, thicker) border.
51b. [A] Terrain-set editor's view-mode dropdown (no "View " label text —
    just the `<select>`: Staircase / Grid 8×6 / Grid 7×7 / 16-tile only)
    rearranges the 47 slots on screen without changing any slot's
    assignment (cosmetic only); "Grid 8×6"/"Grid 7×7" mirror the real
    reference template's row/col layout 1:1 (including its duplicate
    "isolated"/"full surround" cells, which render as two on-screen cells
    bound to the same underlying slot — the first cell in raster order is
    primary; the others show a `.has-duplicates` dashed border (replacing
    the cell's own mandatory/optional border, not an outline outside it --
    an outline there used to overlap neighboring cells in the tight grid)
    + `⧉N` badge).
    Creating a terrain set from the "Blob-47 (7×7)" or "Blob-47 (8×6)"
    preset (Add Terrain Set dialog) seeds that set's view dropdown to the
    matching grid mode on first open, not always "Staircase"; switching
    between two open terrain sets keeps each one's own choice (no leaking
    one set's view into another's). There is no layout-preset import/save
    row in the editor anymore — presets are only applied at terrain-set
    creation time (Add Terrain Set dialog, item 54).
51c. [A] "Allow flip"/"Allow rotation" are icon toggle buttons (↔/↻, not
    checkboxes) — clicking one toggles its pressed state (filled accent
    background, `aria-pressed`) and immediately reclassifies each slot as
    mandatory (solid border) or optional (dashed border) based on symmetry
    alone, independent of whether the slot currently has a tile assigned.
    A filled slot shows the actual tile's cropped pixels as its
    background, with a small ↔/↕/↻ icon overlay only when that fill came
    from symmetry (not an explicit assignment). A slot that's optional AND
    explicitly assigned (art placed there even though it's now derivable)
    additionally shows a muted blue-grey dashed border (same
    replaces-the-cell's-own-border treatment as `.has-duplicates` above)
    + a "✓opt" badge, distinct from the orange duplicate-tile marker — on
    the tile sheet itself, the corresponding tile cell shows a translucent
    blue-grey wash across the whole cell (not just a border) for the same
    condition.
52. [A] Clicking an empty slot opens the tile picker (filtered to tiles
    matching the terrain set's size); assigning a tile fills that slot;
    "Clear" empties it again.
52b. [A] Opening the tile picker for an unfilled slot shows, without
    hovering: the slot's direction description (e.g. "N + E"), a
    Mandatory/Optional label, and a 3×3 diagram shading which neighbor
    cells are filled. The body is a clickable grid of live tile thumbnails
    (not a dropdown); clicking one assigns it immediately and closes the
    dialog. A tile with fully transparent pixels still appears in the grid.
53. [A] Toggling "Allow flip" / "Allow rotation" changes which otherwise-
    empty slots show a derived (dashed-border) state, with a badge/tooltip
    reflecting a real flip or rotation transform (not identity).
54. [A] Add Terrain Set dialog: picking "Blob-47 (7×7)" or "Blob-47 (8×6)"
    from the Layout dropdown shows a live reference-image preview (with a
    dashed "dup" overlay on non-primary duplicate cells); "(none — add
    tiles manually)" hides the preview. Create with a preset selected both
    fills the matching slots and paints the preset's reference art onto the
    active paint layer, on a matching grid it creates for you.
56. [A] Deleting a terrain set clears every referencing tile's terrain
    badge/detail without deleting the tiles themselves.
57. [A] Tile editor: opening a terrain-set tile shows the "Terrain:
    `<name>`" label and a live 8-neighbor preview with no clickable slot
    dialog; opening a non-terrain tile is completely unchanged from
    before this feature.
58. [A] Layers list: Add/rename/reorder (↑/↓)/Delete all work; deleting a
    layer name clears it from any tile that had it selected.
58b. [A] The Tile Layers panel (its own sidebar section below Autotiles)
    reads "Tile Layers", with an icon-only Add button and hover tooltips on
    its add/up/down/delete controls; it is visually and structurally
    independent from the app's real Layers panel and from the Autotiles
    panel's symmetry row (which no longer has a Layer dropdown — that
    control moved to the Tiles panel, item 59).
59. [A] Tiles panel: selecting a standalone tile shows a Layer dropdown
    bound to that tile's own `layer` (lists the Tile Layers list plus
    "(none)"); selecting a tile that belongs to a terrain set shows the
    SAME dropdown bound to `terrainSet.layer` instead — changing it from
    any one member tile updates it for every tile in that terrain set
    (select a different member tile from the same set and confirm the
    dropdown shows the same, now-changed value). Tags field accepts a
    comma-separated list and round-trips on reselecting the tile.
60. [A] Tiles JSON export: a sheet with a filled terrain set and layers
    produces the new `terrainSets`/`layers` top-level keys, and a
    terrain-set tile's exported entry has no `neighbors` key.
60b. [A] Tiles JSON export: a terrain set with a Layer selected includes a
    `layer` key in its `terrainSets[]` entry; omitted when the set has no
    layer selected.

## 10. Exports

61. [A] Export dialog: "Sheet PNG (flattened)" downloads a PNG (verify a
    download/blob was produced — no console error).
62. [A] "Frames JSON" (enabled only for sprite sheets) downloads
    `<sheet>.frames.json`; shape matches README's Export shapes section
    (`sheet`, `width`, `height`, `frames[]`, `animations[]`).
63. [A] "Tiles JSON" (enabled only for tile sheets) downloads
    `<sheet>.tiles.json`; shape is `{ sheet, count, tiles[] }` — `tiles[]`
    includes tiles with a name, manual neighbors, a terrain-set
    membership, a layer, or tags, each with `index, name, x, y, w, h`. A
    non-terrain tile's full 8-direction `neighbors` block resolves each
    slot's `tileIndex` from the internal tile id to that tile's position
    in the array; a terrain-set tile omits `neighbors` entirely. If any
    terrain sets or layers are defined, top-level `terrainSets[]` /
    `layers[]` keys are present too (see section 9a).

## 11. Shortcuts (Task 20)

64. [A] Each tool hotkey (`B E G L U O I M`, plus `F`/`T` in their
    respective modes) selects the matching tool; hotkeys are ignored
    while an input (including a checkbox), textarea, contenteditable field,
    or control inside an open dialog has focus.
65. [A] `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` undo/redo (already covered
    in section 2). Undo, Redo, and Save must leave input/textarea/
    contenteditable editing alone and do nothing while any dialog is open;
    outside those contexts they operate normally.
66. [A] `Ctrl+S` on a project with no save target yet opens the Save As
    dialog (same as clicking the Save button); close it via Cancel. (A
    project that already has a save target — packed or unpacked — would
    instead call the native save path directly; that path is [M], see
    section 13.)
67. [A] `[` / `]` decrement/increment `state.brushSize`, clamped to
    1..8, and the Size number input in the tool options row reflects the
    new value.
68. [A] `X` swaps `state.primary` and `state.secondary`; both color
    swatches in the Colors panel visibly swap.
69. [A] `Escape` clears an active marquee selection, or backs out of the
    frame/tile editor to the sheet view (already covered in sections 2,
    7, 9).
70. [A] `Delete` removes the selected frame while the frame tool is
    active (already covered in section 5, item 24).
71. [A] Mouse wheel zooms the canvas centered on the cursor.
71b. [M] `Space`+drag (or middle-mouse drag) pans.

## 12. Packed save/open round trip [M]

72. [M] Save As → "Packed file (.pixelproj)": pick a location via the
    native save picker (or, on browsers without File System Access API,
    via the download fallback). Reload the app, Open → "Packed file
    (.pixelproj)", pick the saved file: project round-trips (sheets,
    layers, frames, animations, palettes, tile metadata all intact).
    Exempt from automation per project decision (native pickers cannot
    be driven by Playwright without an OS-level automation layer).

## 13. Unpacked folder round trip [M]

73. [M] Save As → "Unpacked folder": pick a folder via the native
    directory picker. Reload, Open → "Folder…", pick the same folder:
    project round-trips, and `images/<sheetId>/<layerId>.png` files
    exist on disk. Same exemption as above (native picker).

## 14. Autosave restore [M]

74. [M] Without `?autotest`, make an edit (so `state.dirty` is true),
    wait ~30s (or trigger `io.autosave()` manually) for the autosave
    interval, then reload the tab (not the `?autotest` URL — that flag
    skips the restore prompt by design). A "restore autosaved project?"
    confirm appears; accepting restores the in-progress project.
    Manual because it requires a real `confirm()` dialog and a plain
    (non-autotest) reload — both deliberately suppressed under
    `?autotest`.

## 15. v2: New Project, sheets, strips, zoom, thumbnails

75. [A] File > New: with unsaved changes, `confirmOrAuto` auto-accepts the
    discard-changes prompt; the New Project dialog opens. Enter custom
    sprite sheet, tile sheet, tile size, frame size, and duration values;
    "Create" lands a project whose sheets/settings match exactly what was
    entered (not the defaults).
76. [A] Dialogs (New Project, New Sheet, Open, Save As, Export)
    render centered in the viewport via native `<dialog>`/`showModal()` —
    no custom positioning logic to break.
77. [A] Sheet selector dropdown lists sheets for the active tab (Sprite
    Sheets vs Tile Sheets); "New Sheet…" dialog creates one (name/size, +
    tile size in tile mode) and it becomes active; undo removes it and
    restores the prior active sheet/layer.
78. [A] New Project dialog's Frame time field is the shared ms/fps duration
    control (same as the Animation panel); creating a project with fps
    values set round-trips `settings.baseFps`/`baseStep`. Edit menu >
    Project Settings opens the same fields pre-filled from the current
    project (plus a Name field, pre-filled from `project.name` -- the only
    place a project can be renamed; blank name is rejected with an alert
    and the dialog stays open), edits apply as one undoable command
    covering both `project.name` and `project.settings`, and new
    animations created afterward seed their base duration from the
    updated settings. Saving preserves every OTHER settings field verbatim
    (check `state.project.settings.onion` survives a Project Settings save
    unchanged -- it used to get silently wiped, since the dialog rebuilt
    `project.settings` from scratch instead of merging into it) except
    `baseFps`/`baseStep`, which are correctly dropped (not left stale) when
    switching the duration control back from fps to ms mode.
78a. [A] Every dialog's OK/Create/Close row is right-aligned with the
    affirmative action before Cancel (Windows-standard layout, `.dlg-actions`
    on top of `.row`) -- check a couple, e.g. New Sheet and Slice grid. Each
    dialog also marks one button as its default action (`.btn-default`,
    a highlighted border): pressing Enter anywhere in the dialog (any text/
    number field, checkbox, radio, or color input -- not inside another
    button, textarea, or select, which handle their own Enter) triggers it
    without needing to click. Verify via a real Enter keypress in e.g. New
    Sheet's Name field creating the sheet and closing the dialog, not just
    checking the CSS class.
78b. [A] Project Settings' General page groups its fields under section
    headers (Sprite Sheet / Tile Sheet / Frame), each a divider line above
    it (none above the very first section). Each W/H pair (Sprite sheet,
    Tile sheet, Tile size, Frame size) has a 🔗 lock button after the `×`
    separator, locked by default (full color; unlocked = dim/greyed) --
    while locked, editing either field rescales the other to preserve the
    ratio that was in effect when the dialog opened (or when the button was
    last clicked to re-lock); unlocking lets the two fields move
    independently. Re-opening the dialog re-anchors every lock's ratio to
    the project's current saved dimensions, not whatever was left over from
    a previous edit.
79. [A] Mouse wheel over the canvas steps zoom through the table
    (`0.25, 0.5, 0.75, 1, 2, 3, 4, 6, 8, 12, 16, ...`); repeated
    scroll-in/scroll-out reaches both 0.25x and 16x without sticking at
    any intermediate level, and the status bar zoom readout matches.
80. [M] Pan the canvas (`Space`+drag or middle-mouse drag): the
    checkerboard transparency background scrolls with the content
    (anchored to canvas content, not fixed to the viewport).
81. [M] Layers panel: each row shows a live thumbnail. Draw a stroke on
    layer 1 — its thumbnail updates continuously during the stroke (not
    just on mouse-up). Add layer 2 and draw different pixels on it — the
    two thumbnails show distinct content, both live while drawing.
    Toggling a layer's visibility does not blank its thumbnail (the thumb
    always shows that layer's own bitmap). Thumbnails stay correct after
    undo/redo and after switching the active sheet via the sheet
    selector.

## 16. v3: Import, move tool, rename sheet

82. [A] Import sheet from image: drive the fallback `<input type="file">`
    (used when the File System Access API is unavailable; Playwright can
    also intercept it via its file-chooser hook) with a small generated
    PNG of known pixel values. Click "Import…", supply the file: a new
    sheet is created and becomes active — its name is the file name minus
    extension, its dimensions match the image, and layer 0's pixels match
    the PNG's. Undo removes the sheet and restores the prior active
    sheet/layer.
83. [M] Move tool (✋, `V`), no marquee: drag on the canvas — the whole
    target region floats (source hole appears, outline + handles shown);
    the layer bitmap is NOT modified beyond the source cut until commit.
    `Enter` commits at the new position; stepwise undo: Ctrl+Z undoes the
    commit, then the drag, then the float itself.
84. [M] Move tool with a marquee: only the selected region floats; drag,
    then `Escape` — pixels restored exactly to the original spot.
85. [M] Transform handles: drag a corner handle (scale, incl. pull-through
    flip), drag the rotation knob (free rotate); commit renders the
    nearest-neighbor result; each completed drag is one undo step. Scale
    shows W×H pills with Δ (scaled content size); rotate shows an angle
    pill near the knob.
86. [M] `Alt`+drag floats ALL layers (one buffer per layer); commit writes
    each layer; single-layer default otherwise. In the frame editor a
    committed float is clipped to the frame rect.
87. [A] Rename sheet: with a sheet active, click ✎ — the Rename Sheet
    dialog opens pre-filled with the current name. OK with a new name:
    the sheet selector label updates immediately and Export filenames
    (e.g. the flattened PNG download) use the new name; undo restores the
    old name in the selector. OK with an empty/whitespace name: alert
    "Name cannot be empty." and the dialog stays open. Cancel closes
    without changes.
88. [A] Clipboard: `Ctrl+C` copies the marquee selection, `Ctrl+V` pastes a
    floating copy (source intact) that commits on `Enter` or tool switch.
    `Ctrl+X` cuts (one undo step); `Ctrl+Alt+C`/`Ctrl+Alt+X` capture all
    layers. Paste lands at the source position when visible, else centered.
88a. [A] OS clipboard sync: after `Ctrl+C`/`Ctrl+Alt+C`, `navigator.clipboard
    .read()` has one `image/png` item matching the copied region's size
    (merged/blended pixels for `+Alt`). With the internal clipboard empty
    (fresh reload), writing a PNG to the OS clipboard and dispatching a real
    `Ctrl+V` keydown creates a floating selection on the active layer,
    centered in the target rect, that commits normally. With the internal
    clipboard non-empty, `Ctrl+V` still prefers it (source position,
    per-layer reattachment) over the OS clipboard.
88b. [M] Cross-app clipboard: copy a region in PixelArtist, `Ctrl+V` into
    Word/Paint/another app — the flattened image pastes correctly. Copy an
    image in Windows Photos/Snipping Tool, switch to PixelArtist with the
    internal clipboard empty, `Ctrl+V` — it lands as a floating selection
    centered on the canvas.
89. [A] Auto-commit: with a float pending, pressing `B` (pencil) commits it
    first; switching sheets or opening the frame editor also commits.

## 17. v4: Strip segments

90. [A] With the frame tool, an intact strip's SELECTED segment always
    shows its chrome (topmost, above label overlays): "+" insert call-outs
    above each frame boundary and "✂" split call-outs below each interior
    boundary; hovering a part highlights it; clicking "+" inserts a blank
    frame there (pixel-carrying tail shift), one undo step. Chrome only
    ever appears for the segment containing the active sheet's selected
    frame (per SelectionService) — a non-selected strip shows no chrome
    until a member of it is clicked.
91. [A] Clicking "✂" between two frames of a segment adds a break (a
    dashed separator appears once the two halves are no longer touching);
    one undo step.
92. [M] Dragging a whole segment with the frame tool (grab any member, not
    a grip) moves every member's rect together, metadata-only — pixels stay
    put; undo restores all member positions in one step. Moving the segment
    WITH its pixels is the move tool's frame-float (item 21b).
93. [M] Dragging a segment's end near another segment of the SAME
    animation with matching frame size snaps (green outline) and merges
    the two into one ordered run; undo restores the prior two-segment
    layout.
94. [M] Dragging a segment's end near a segment of a DIFFERENT animation
    snaps and transfers it into that animation (including deleting the
    source animation entirely when it becomes empty); undo restores the
    original animation, its frames, and the deleted animation.
95. [M] Dragging an end-of-segment grip grows (adds blank frames) or
    shrinks (removes frames; pixels remain on the sheet) that end;
    verify both the left and right ends independently; undo restores the
    prior frame count and any removed frames/pixels.
96. [A] Selecting a member frame of a segment and pressing `Delete` removes
    it AND closes the gap (rest of the segment shifts to stay contiguous);
    undo restores the frame, its position, and its pixels.
97. [A] Double-clicking a member frame of a strip (frame tool, two quick
    downs on the same frame) opens the frame editor on that frame; "← Back
    to sheet" returns to the sheet view with the timeline's animation
    picker showing that frame's animation selected.
98. [A] With a strip animation (`strip: true`) selected in the timeline,
    cells have no ✕ remove button and are not draggable (`cell.draggable`
    is `false`); "Add selected frame" is disabled. Editing a cell's
    duration still works and is still one undo step.
99. [M] Save (packed or unpacked), reload, and open the file: segment
    breaks (dashed separators / detached halves) and frame order survive
    the round trip exactly. Same native-picker exemption as sections 12-13.

## 18. v6: thumbnail smoothing, timeline dock resize

100. [A] Project Settings > General > Display has a "Smooth thumbnails"
     checkbox, checked by default. With a sprite sheet much larger than a
     frame, layer thumbnails (Layers panel) and timeline strip thumbnails
     shrink cleanly (no dropped-pixel aliasing); unchecking it and saving
     switches both back to blocky nearest-neighbor. Upscaled thumbnails
     (sprite smaller than the thumbnail box) stay crisp nearest-neighbor
     either way.
101. [M] Drag the thin handle at the top edge of the timeline dock: the
     panel's height follows the cursor (up = taller, down = shorter,
     clamped to a sane range) and the frame thumbnails resize with it —
     taller panel, bigger/sharper thumbnails. Reload the page: the chosen
     height persists (stored in `localStorage`, not the project file).

## 19. Chroma key + live preview

102. [A] Edit > Filters > Quantize to Palette…: opening the dialog
     immediately shows a live preview of the current settings in the
     Preview panel (right sidebar); changing palette/count/prefer-opaque/
     all-layers updates the preview in real time; Cancel reverts the panel
     to the real (unchanged) content; OK commits and the panel matches the
     committed result.
103. [M] Edit > Filters > Chroma Key…: opens pre-filled with the primary
     color as Key color; toggling "Replace with color" reveals the
     Replace-with color row; dragging Tolerance/Softness and editing the
     color/hex fields all update the Preview panel live; "← Primary"/
     "← Secondary" buttons re-seed the corresponding color field; OK
     commits one undo step (Ctrl+Z restores the pre-key pixels), Cancel
     discards the preview and leaves pixels untouched.

## Pass criteria

- All **[A]** items complete with no unexpected state and zero console
  errors/warnings across the whole run.
- `npm test` reports all green (see the suite's own summary line for the
  current total).
- The owner completes **[M]** release gates separately; an automated pass
  does not replace native-picker or pointer-gesture checks.
