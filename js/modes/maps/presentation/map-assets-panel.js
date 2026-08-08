import { state, on, activeMap } from '../../../app/state.js';
import { flatCanvas } from './map-renderer.js';
import { getEditorHost } from '../../../host/runtime.js';
import { mapBrushState as asset } from '../application/map-brush-state.js';

export function mountMapAssetsPanel(container) {
  const addSelect = (label, items, value, set, fmt = item => item.name) => {
    const row = document.createElement('label'); row.className = 'map-brush-source'; row.textContent = `${label} `;
    const select = document.createElement('select');
    for (const item of items) { const option = document.createElement('option'); option.value = item.id; option.textContent = fmt(item); select.append(option); }
    select.value = value; select.onchange = () => { set(select.value); render(); }; row.append(select); container.append(row);
  };
  const addSwatch = (grid, { selected, title, sourceSheet, rect, choose }) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `map-brush-swatch${selected ? ' active' : ''}`; button.title = title; button.setAttribute('aria-label', title);
    const canvas = document.createElement('canvas'); const scale = Math.max(1, Math.floor(56 / Math.max(rect.w, rect.h))); canvas.width = Math.max(1, rect.w * scale); canvas.height = Math.max(1, rect.h * scale); canvas.className = 'map-brush-thumb';
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false; const source = flatCanvas(sourceSheet, state.project); if (source) ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
    const label = document.createElement('span'); label.textContent = title; button.append(canvas, label); button.onclick = () => { choose(); render(); }; grid.append(button);
  };
  const addBrushGrid = () => { const grid = document.createElement('div'); grid.className = 'map-brush-grid'; container.append(grid); return grid; };
  const activeLayerId = () => (getEditorHost().selections.get({ kind: 'map', id: activeMap()?.id }) ?? {}).layerId;
  const render = () => {
    if (state.mode !== 'maps') { container.hidden = true; return; }
    container.hidden = false; container.innerHTML = '<h3>Brushes</h3>';
    const map = activeMap(), layer = map?.layers.find(l => l.id === activeLayerId());
    if (!map || !layer) { container.append('Create a map first.'); return; }
    const tiles = state.project.sheets.filter(candidate => candidate.kind === 'tile');
    const sprites = state.project.sheets.filter(candidate => candidate.kind === 'sprite');
    if (state.tool === 'maptile') {
      const kindRow = document.createElement('div'); kindRow.className = 'map-brush-kind';
      for (const [value, label] of [['tile', 'Tiles'], ['terrain', 'Autotiles']]) { const button = document.createElement('button'); button.type = 'button'; button.className = `btn-sm${asset.tileKind === value ? ' active' : ''}`; button.textContent = label; button.onclick = () => { asset.tileKind = value; render(); }; kindRow.append(button); }
      container.append(kindRow);
      if (asset.tileKind === 'tile') {
        addSelect('Sheet', tiles, asset.tileSheetId, value => { asset.tileSheetId = value; });
        const sourceSheet = tiles.find(s => s.id === asset.tileSheetId) || tiles[0];
        if (sourceSheet) { asset.tileSheetId = sourceSheet.id; if (!sourceSheet.tiles.some(tile => tile.id === asset.tileId)) asset.tileId = sourceSheet.tiles[0]?.id ?? ''; const grid = addBrushGrid(); for (const tile of sourceSheet.tiles) addSwatch(grid, { selected: asset.tileId === tile.id, title: tile.name ?? `Tile ${sourceSheet.tiles.indexOf(tile) + 1}`, sourceSheet, rect: tile, choose: () => { asset.tileId = tile.id; } }); }
      } else {
        addSelect('Sheet', tiles, asset.terrainSheetId, value => { asset.terrainSheetId = value; });
        const sourceSheet = tiles.find(s => s.id === asset.terrainSheetId) || tiles[0];
        if (sourceSheet) { asset.terrainSheetId = sourceSheet.id; if (!sourceSheet.terrainSets.some(terrain => terrain.id === asset.terrainSetId)) asset.terrainSetId = sourceSheet.terrainSets[0]?.id ?? ''; const grid = addBrushGrid(); for (const terrain of sourceSheet.terrainSets) { const tileId = Object.values(terrain.slots ?? {}).find(Boolean), tile = tileId && sourceSheet.tiles.find(candidate => candidate.id === tileId); if (tile) addSwatch(grid, { selected: asset.terrainSetId === terrain.id, title: terrain.name ?? 'Autotile set', sourceSheet, rect: tile, choose: () => { asset.terrainSetId = terrain.id; } }); } if (!grid.children.length) grid.textContent = 'This sheet has no painted autotile brushes yet.'; }
      }
    } else if (state.tool === 'mapsprite') {
      addSelect('Sheet', sprites, asset.spriteSheetId, value => { asset.spriteSheetId = value; });
      const sourceSheet = sprites.find(s => s.id === asset.spriteSheetId) || sprites[0];
      if (sourceSheet) { asset.spriteSheetId = sourceSheet.id; const kindRow = document.createElement('div'); kindRow.className = 'map-brush-kind'; for (const [value, label] of [['frame', 'Frames'], ['animation', 'Animations']]) { const button = document.createElement('button'); button.type = 'button'; button.className = `btn-sm${asset.spriteKind === value ? ' active' : ''}`; button.textContent = label; button.onclick = () => { asset.spriteKind = value; asset.spriteId = ''; render(); }; kindRow.append(button); } container.append(kindRow); const grid = addBrushGrid(); const items = asset.spriteKind === 'frame' ? sourceSheet.frames : sourceSheet.animations; if (!items.some(item => item.id === asset.spriteId)) asset.spriteId = items[0]?.id ?? ''; for (const item of items) { const frame = asset.spriteKind === 'animation' ? sourceSheet.frames.find(candidate => candidate.id === item.frames?.[0]?.frameId) : item; if (frame) addSwatch(grid, { selected: asset.spriteId === item.id, title: item.name ?? (asset.spriteKind === 'frame' ? `Frame ${sourceSheet.frames.indexOf(item) + 1}` : 'Animation'), sourceSheet, rect: frame, choose: () => { asset.spriteId = item.id; } }); } }
    } else container.append('Select or move placed items on the active layer.');
  };
  on('view', render); on('project', render); on('tool', render); render();
}
