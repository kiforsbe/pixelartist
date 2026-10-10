# Agent notes for pixelartist

## Panel command buttons

A side panel's command buttons (add, duplicate, delete, resize, … — the
actions on a panel's list) follow the Layers panel
(`js/components/panels/layers-panel.js`):

- **One row** below the list: `<div class="row layer-actions">`.
- **Pictograms, not words:** each is a `btn-icon-md` button whose text is
  one emoji/symbol, with the command's name in `title` (the tooltip).
  Reuse the icons already in use: ➕ add/new, 📁 add group, ⧉ duplicate,
  🗑 delete, ✎ rename/edit, ⬇ merge down, 📐 size, ⬅ back.
- No text buttons (`New…`, `Duplicate`, …) in that row, no custom padding
  or font sizes, no wrapping: the shared `.btn-icon-md` / `.layer-actions`
  CSS sets the size and spacing.
- In the Animations workbench use `iconButton(icon, title, onClick)` from
  `js/modes/animations/presentation/panel-controls.js`.

Text buttons stay for actions inside a form or a details section (Create,
Apply, Cancel, Auto-layout, Make manual).
