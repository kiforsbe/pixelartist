# Smoke checklist

End-to-end manual/Playwright script covering every major feature area
(condensed from the Task 13/16/18/19/20 verification lists). Run against
`http://localhost:8080/?autotest` — the `?autotest` query flag
(`js/app/state.js`'s `AUTOTEST`) suppresses `confirm()`/`beforeunload`
prompts and skips the autosave-restore prompt on boot, so automated runs
don't block on native dialogs.

Each item is marked:
- **[A]** automatable via Playwright MCP (dispatch clicks/keys, read
  `state`/DOM/console — no native OS picker involved)
- **[M]** manual only (native file/folder pickers, or requires leaving the
  tab/restoring a real browser session)

Run the **[A]** items in one pass after any change that touches drawing,
layers, palettes, frames, animation, the frame/tile editors, tile mode, or
exports. Check the browser console after every step — zero errors/warnings
is a pass condition for the whole run, not just the final step.

## 1. Launch

1. [A] Open `http://localhost:8080/?autotest`. Page loads, no console
   errors, a demo project is created automatically (no autosave-restore
   prompt).
2. [A] Sprite Sheets tab is active by default; canvas shows the demo
   sprite sheet.
3. [A] Status bar shows a tool name, position, and zoom level.

## 2. Draw (pencil / shapes / fill / eraser) + undo

4. [A] Select Pencil (`B` or click). Draw a short stroke on the canvas.
   Pixels change; Undo button becomes enabled.
5. [A] Select Eraser (`E`). Erase part of the stroke. Undo restores it.
6. [A] Select Line (`L`), drag a line. Select Rect (`U`), drag a
   rectangle (toggle "Filled" once). Select Ellipse (`O`), drag an
   ellipse (toggle "Filled" once).
7. [A] Select Fill (`G`), click inside a closed shape. Toggle
   "Contiguous" and fill again.
8. [A] Press `Ctrl+Z` repeatedly back to the empty canvas; press
   `Ctrl+Y` (and `Ctrl+Shift+Z`) to redo forward again. Undo/redo
   buttons disable at the ends of the stack.
9. [A] Eyedropper (`I`): click a drawn pixel, primary color swatch
   updates to match.
10. [A] Select tool (`M`): drag a marquee, drag the marquee content to a
    new position, `Escape` clears the marquee.

## 3. Layers

11. [A] Layers panel: "Add" creates a new layer, becomes active. Undo
    removes it.
12. [A] Reorder with the ↑/↓ buttons; undo restores prior order.
13. [A] Drag the opacity slider; layer visibly fades; releasing commits
    one undo step (not one per drag tick).
14. [A] "Merge Down" combines the active layer into the one below; undo
    restores both layers and pixels.
15. [A] Toggle a layer's visibility (👁/🚫); canvas updates immediately.

## 4. Palettes

16. [A] Colors panel: open "System…", clone a system palette. It becomes
    active and its swatches render in the strip.
17. [A] Create a new indexed palette (size preset). Draw with pencil —
    color snaps to the nearest palette entry.
18. [A] Double-click an indexed swatch, change its color: if that color
    is used on the active sheet, a remap confirmation is offered and
    accepted (`confirmOrAuto` auto-accepts under `?autotest`); pixels
    recolor. Undo restores both the palette entry and the pixels.
19. [A] Non-indexed palette: "+ Add current color" appends the primary
    color as a new swatch.

## 5. Frames

20. [A] Switch to frame tool (`F`, sprite mode only). Drag to create a
    frame; it appears in the Frames panel and as an overlay on the
    canvas (labels/sequence overlay toggles in the top bar affect
    visibility).
21. [A] Drag-move a frame with the frame tool: pixels underneath move
    with it (pixel-carrying move), one undo step restores both frame
    position and pixels.
22. [A] Drag a corner handle to resize the selected frame; undo restores
    original bounds.
23. [A] Frames panel: Slice grid… dialog creates a full grid of frames
    from cell/margin/spacing settings ("Replace existing frames" tested
    both on and off); undo removes them (and any animation entries that
    referenced them).
24. [A] Select a frame, press `Delete`: frame is removed; undo restores
    it (and any animation frame-entries that referenced it).

## 6. Animation

25. [A] Timeline: "New" creates an animation; select a frame in the
    Frames panel, "Add selected frame" appends it to the timeline strip.
26. [A] Drag-reorder two cells in the strip; undo restores original
    order.
27. [A] Edit a cell's duration number input; undo restores the prior
    value.
28. [A] Toggle "Loop"; Play (▶) advances the preview canvas through
    frames, wrapping if looped; Pause stops it. First/Last transport
    buttons jump to the ends. Speed selector changes playback rate.

## 7. Frame editor

29. [A] Double-click a frame (or its Edit button) to open the frame
    editor; canvas re-centers on just that frame.
30. [A] Draw inside the frame editor — same tools as the sheet view,
    confined to the frame's rect.
31. [A] Enable Onion skin, set Back/Ahead counts: past frames tint red,
    future frames tint green, faded by distance.
32. [A] Prev/Next step through the animation's frame order (or sheet
    order if the frame isn't in the selected animation).
33. [A] `Escape` returns to the sheet view (also via "← Back to sheet").

## 8. Tile mode

34. [A] Switch to Tile Sheets tab. Tile panel shows tile W/H and tile
    count; editing W/H recomputes the count.
35. [A] Tile tool (`T`, tile mode only): click a tile to select it (tile
    panel shows `#index` + name field).
36. [A] Drag one tile onto another (no Shift) to swap them — pixels,
    names, and neighbor presets swap on all layers; undo restores both
    tiles.
37. [A] Shift-drag one tile onto another to move it — source tile clears
    to transparent; undo restores both tiles.

## 9. Tile editor

38. [A] Double-click a tile (or "Edit tile") to open the tile editor;
    center tile is outlined, neighbor cells render the live composite.
39. [A] Draw inside the center tile: neighbor cells that mirror it (mode
    `same`) update live as you draw (drag confinement: strokes cannot
    escape the center tile even if the drag leaves it).
40. [A] Click a neighbor slot (outside the center tile, no drag) to open
    the slot config dialog; try each mode (`same tile` / `other tile` +
    index / `empty`), and Flip H/V; OK commits, undo restores the prior
    preset for that slot.
41. [A] Switch the neighbor radius to 5×5 and back to 3×3; grid resizes
    and recenters.

## 10. Exports

42. [A] Export dialog: "Sheet PNG (flattened)" downloads a PNG (verify a
    download/blob was produced — no console error).
43. [A] "Frames JSON" (enabled only for sprite sheets) downloads
    `<sheet>.frames.json`; shape matches README's Export shapes section
    (`sheet`, `width`, `height`, `frames[]`, `animations[]`).
44. [A] "Tiles JSON" (enabled only for tile sheets) downloads
    `<sheet>.tiles.json`; shape matches README (`tiles[]` includes only
    named/preset tiles, with full 8-direction `neighbors`).

## 11. Shortcuts (Task 20)

45. [A] Each tool hotkey (`B E G L U O I M`, plus `F`/`T` in their
    respective modes) selects the matching tool; hotkeys are ignored
    while a text input/checkbox/select has focus or a dialog is open.
46. [A] `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` undo/redo (already covered
    in section 2).
47. [A] `Ctrl+S` on a project with no save target yet opens the Save As
    dialog (same as clicking the Save button); close it via Cancel. (A
    project that already has a save target — packed or unpacked — would
    instead call the native save path directly; that path is [M], see
    section 13.)
48. [A] `[` / `]` decrement/increment `state.brushSize`, clamped to
    1..8, and the Size number input in the tool options row reflects the
    new value.
49. [A] `X` swaps `state.primary` and `state.secondary`; both color
    swatches in the Colors panel visibly swap.
50. [A] `Escape` clears an active marquee selection, or backs out of the
    frame/tile editor to the sheet view (already covered in sections 2,
    7, 9).
51. [A] `Delete` removes the selected frame while the frame tool is
    active (already covered in section 5, item 24).
52. [A] Mouse wheel zooms the canvas centered on the cursor; `Space`+drag
    (or middle-mouse drag) pans.

## 12. Packed save/open round trip [M]

53. [M] Save As → "Packed file (.pixelproj)": pick a location via the
    native save picker (or, on browsers without File System Access API,
    via the download fallback). Reload the app, Open → "Packed file
    (.pixelproj)", pick the saved file: project round-trips (sheets,
    layers, frames, animations, palettes, tile metadata all intact).
    Exempt from automation per project decision (native pickers cannot
    be driven by Playwright without an OS-level automation layer).

## 13. Unpacked folder round trip [M]

54. [M] Save As → "Unpacked folder": pick a folder via the native
    directory picker. Reload, Open → "Folder…", pick the same folder:
    project round-trips, and `images/<sheetId>/<layerId>.png` files
    exist on disk. Same exemption as above (native picker).

## 14. Autosave restore [M]

55. [M] Without `?autotest`, make an edit (so `state.dirty` is true),
    wait ~30s (or trigger `io.autosave()` manually) for the autosave
    interval, then reload the tab (not the `?autotest` URL — that flag
    skips the restore prompt by design). A "restore autosaved project?"
    confirm appears; accepting restores the in-progress project.
    Manual because it requires a real `confirm()` dialog and a plain
    (non-autotest) reload — both deliberately suppressed under
    `?autotest`.

## 15. v2: New Project, sheets, strips, zoom, thumbnails

56. [A] File > New: with unsaved changes, `confirmOrAuto` auto-accepts the
    discard-changes prompt; the New Project dialog opens. Enter custom
    sprite sheet, tile sheet, tile size, frame size, and duration values;
    "Create" lands a project whose sheets/settings match exactly what was
    entered (not the defaults).
57. [A] Dialogs (New Project, New Sheet, New Strip, Open, Save As, Export)
    render centered in the viewport via native `<dialog>`/`showModal()` —
    no custom positioning logic to break.
58. [A] Sheet selector dropdown lists sheets for the active tab (Sprite
    Sheets vs Tile Sheets); "New Sheet…" dialog creates one (name/size, +
    tile size in tile mode) and it becomes active; undo removes it and
    restores the prior active sheet/layer.
59. [A] Frames panel "New strip…" creates a contiguous named animation
    strip (frame size, count, duration); the strip's cells can be
    drag-reordered in the timeline; "Break apart" (visible only while the
    animation is an intact strip) converts it to loose frame entries.
    Each of create/reorder/break-apart is one undo step.
60. [A] Mouse wheel over the canvas steps zoom through the table
    (`0.25, 0.5, 0.75, 1, 2, 3, 4, 6, 8, 12, 16, ...`); repeated
    scroll-in/scroll-out reaches both 0.25x and 16x without sticking at
    any intermediate level, and the status bar zoom readout matches.
61. [A] Pan the canvas (`Space`+drag or middle-mouse drag): the
    checkerboard transparency background scrolls with the content
    (anchored to canvas content, not fixed to the viewport).
62. [A] Layers panel: each row shows a live thumbnail. Draw a stroke on
    layer 1 — its thumbnail updates continuously during the stroke (not
    just on mouse-up). Add layer 2 and draw different pixels on it — the
    two thumbnails show distinct content, both live while drawing.
    Toggling a layer's visibility does not blank its thumbnail (the thumb
    always shows that layer's own bitmap). Thumbnails stay correct after
    undo/redo and after switching the active sheet via the sheet
    selector.

## 16. v3: Import, move tool, rename sheet

63. [A] Import sheet from image: drive the fallback `<input type="file">`
    (used when the File System Access API is unavailable; Playwright can
    also intercept it via its file-chooser hook) with a small generated
    PNG of known pixel values. Click "Import…", supply the file: a new
    sheet is created and becomes active — its name is the file name minus
    extension, its dimensions match the image, and layer 0's pixels match
    the PNG's. Undo removes the sheet and restores the prior active
    sheet/layer.
64. [A] Move tool (✋, `V`) with no marquee selection: drag on the canvas —
    the whole active layer shifts by the drag delta (pixels moved past the
    sheet edge are cropped; the vacated area becomes transparent). One
    undo step restores the layer.
65. [A] Move tool with a marquee selection (draw one with `M` first, then
    switch to `V`): dragging moves only the selected region's pixels, and
    the marquee rect follows the drag. Undo restores both the pixels and
    the rect position.
66. [A] Move tool "All layers" option: with two layers holding distinct
    pixels, check "All layers" in the tool options row and drag — both
    layers shift together; a single undo restores both.
67. [A] Move tool inside the frame editor: the move is confined to the
    frame's rect — dragged pixels cannot escape the frame bounds even if
    the drag leaves it. Undo restores.
68. [A] Rename sheet: with a sheet active, click ✎ — the Rename Sheet
    dialog opens pre-filled with the current name. OK with a new name:
    the sheet selector label updates immediately and Export filenames
    (e.g. the flattened PNG download) use the new name; undo restores the
    old name in the selector. OK with an empty/whitespace name: alert
    "Name cannot be empty." and the dialog stays open. Cancel closes
    without changes.

## Pass criteria

- All **[A]** items complete with no unexpected state and zero console
  errors/warnings across the whole run.
- `npm test` reports 61/61 passing.
