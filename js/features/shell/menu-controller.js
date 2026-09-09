import { defineAction } from './actions.js';
import { markDefaultAction } from '../../components/dialogs.js';
import { mountMenuBar } from '../../components/menubar.js';
import { APP_VERSION } from '../../version.js';

export function mountApplicationMenu() {
  // ---- help ----
  const dlgAbout = document.getElementById('dlg-about');
  const aboutOk = document.getElementById('about-ok');
  aboutOk.addEventListener('click', () => dlgAbout.close());
  markDefaultAction(dlgAbout, aboutOk);
  defineAction('help.about', {
    label: 'About PixelArtist',
    run: () => {
      document.getElementById('about-version').textContent = `Version ${APP_VERSION}`;
      document.getElementById('about-license').textContent = '© 2026 Kim Forsberg. All rights reserved.';
      dlgAbout.showModal();
    },
  });
  
  const dlgShortcuts = document.getElementById('dlg-shortcuts');
  const shortcutsList = document.getElementById('shortcuts-list');
  const shortcutsOk = document.getElementById('shortcuts-ok');
  shortcutsOk.addEventListener('click', () => dlgShortcuts.close());
  markDefaultAction(dlgShortcuts, shortcutsOk);
  const SHORTCUTS = [
    ['Ctrl+Z', 'Undo'],
    ['Ctrl+Y / Ctrl+Shift+Z', 'Redo'],
    ['Ctrl+S', 'Save'],
    ['[ / ]', 'Decrease / increase brush size'],
    ['X', 'Swap primary/secondary color'],
    ['B / E / G / K / L / U / O / I / M / V', 'Pencil / Eraser / Fill / Soft flood / Line / Rect / Ellipse / Eyedropper / Select / Move'],
    ['F', 'Frame tool (sprite sheets mode)'],
    ['T', 'Tile tool (tile sheets mode)'],
    ['Escape', 'Clear selection / cancel floating selection / back to sheet'],
    ['Space + drag', 'Pan'],
    ['Mouse wheel', 'Zoom'],
    ['Ctrl+X / Ctrl+C / Ctrl+V', 'Cut / copy / paste selection (hold Alt too = all layers)'],
    ['Enter (while floating)', 'Commit the floating selection'],
    ['Delete', 'Delete the selected frame or tile'],
    ['Arrow Up / Down', 'Reorder the selected layer in the Layers panel'],
  ];
  defineAction('help.shortcuts', {
    label: 'Keyboard Shortcuts',
    run: () => {
      shortcutsList.innerHTML = '';
      for (const [keys, desc] of SHORTCUTS) {
        const row = document.createElement('div');
        row.className = 'shortcut-row';
        const k = document.createElement('span'); k.className = 'shortcut-keys'; k.textContent = keys;
        const d = document.createElement('span'); d.className = 'shortcut-desc'; d.textContent = desc;
        row.append(k, d);
        shortcutsList.appendChild(row);
      }
      dlgShortcuts.showModal();
    },
  });
  
  // ---- menu bar ----
  // Later tasks extend this array (more items per menu, more menus) and add
  // the defineAction calls those items reference — menubar.js skips any item
  // whose action id isn't registered yet, so this can be built up incrementally.
  const MENUS = [
    { label: 'File', items: [
      { action: 'file.new' }, { action: 'file.open' }, { separator: true },
      { action: 'file.save' }, { action: 'file.saveAs' }, { separator: true },
      { action: 'file.export' },
    ] },
    { label: 'Document', items: [
      { action: 'document.newSheet' }, { action: 'document.importSheet' }, { separator: true },
      { action: 'document.renameSheet' }, { action: 'document.deleteSheet' }, { separator: true },
      { action: 'document.exportSheet' }, { action: 'document.exportAnimation' }, { action: 'document.exportMap' },
    ] },
    { label: 'Layer', items: [
      { action: 'layer.add' }, { action: 'layer.addGroup' }, { separator: true },
      { action: 'layer.delete' }, { action: 'layer.mergeDown' },
    ] },
    { label: 'Edit', items: [
      { action: 'edit.undo' }, { action: 'edit.redo' }, { separator: true },
      { action: 'edit.cut' }, { action: 'edit.copy' }, { action: 'edit.paste' }, { separator: true },
      { action: 'edit.filters' }, { action: 'edit.palettes' }, { separator: true },
      { action: 'edit.projectSettings' },
    ] },
    { label: 'View', items: [
      { action: 'view.toggleLabels' }, { action: 'view.toggleSequences' }, { separator: true },
      { action: 'view.zoomIn' }, { action: 'view.zoomOut' }, { action: 'view.actualSize' }, { action: 'view.zoomToFit' },
    ] },
    { label: 'Help', items: [
      { action: 'help.shortcuts' }, { action: 'help.about' },
    ] },
  ];
  mountMenuBar(document.getElementById('menubar'), MENUS);
}
