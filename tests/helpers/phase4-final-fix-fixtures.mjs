import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

function runIsolated(script) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

const panelDom = String.raw`
const allEls=[];
class El {
  constructor(tag='div') { this.tag=tag; this.children=[]; this.style={}; this.dataset={}; this.handlers={}; this.className=''; this.classList={add(){},remove(){},toggle(){}}; allEls.push(this); }
  set innerHTML(value) { this.children=[]; }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
  addEventListener(name, handler) { this.handlers[name]=handler; }
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  replaceWith(item) { this.replacement=item; }
  getContext() { return { clearRect(){}, drawImage(){}, putImageData(){}, fillRect(){}, fillText(){} }; }
  focus() {} select() {} setAttribute() {}
}
`;

export function verifyLayerSelectionRecovery() {
  runIsolated(String.raw`
import assert from 'node:assert/strict';
import { EditorHost } from './js/host/editor-host.js';
import { setEditorHost } from './js/host/runtime.js';
import { createProject, createSheet, sheetLayers } from './js/core/model.js';
import { spriteMode } from './js/modes/sprites/index.js';
import { mountLayersPanel } from './js/components/panels/layers-panel.js';
import { runAction } from './js/features/shell/actions.js';
import { activeLayer } from './js/host/document-helpers.js';
${panelDom}
globalThis.document={createElement:tag=>new El(tag)}; globalThis.ImageData=class {}; globalThis.confirm=()=>true;
const host=new EditorHost(); setEditorHost(host); host.registerMode(spriteMode); host.start('sprites');
const project=createProject('test'); const sheet=createSheet(project,{name:'Sprite',kind:'sprite',width:1,height:1}); host.setProject(project);
mountLayersPanel(new El()); runAction('layer.add'); await Promise.resolve();
const added=host.selections.get().layerId; runAction('layer.delete'); await Promise.resolve();
assert.notEqual(host.selections.get().layerId, added); assert.ok(activeLayer());
host.history.undo(); await Promise.resolve(); host.history.undo(); await Promise.resolve();
assert.ok(sheetLayers(sheet).some(layer=>layer.id===host.selections.get().layerId)); assert.ok(activeLayer());
host.selections.patch({layerId:null}); await Promise.resolve(); assert.equal(host.selections.get().layerId,null);
`);
}

export function verifyMapRenamePanelCallback() {
  runIsolated(String.raw`
import assert from 'node:assert/strict';
import { EditorHost } from './js/host/editor-host.js';
import { setEditorHost } from './js/host/runtime.js';
import { createProject, createMap } from './js/core/model.js';
import { mapMode } from './js/modes/maps/index.js';
import { mountLayersPanel } from './js/components/panels/layers-panel.js';
${panelDom}
globalThis.document={createElement:tag=>new El(tag)}; globalThis.ImageData=class {}; globalThis.confirm=()=>true;
const host=new EditorHost(); setEditorHost(host); host.registerMode(mapMode); host.start('maps');
const project=createProject('test'); const map=createMap(project,{name:'Map'}); host.setProject(project); mountLayersPanel(new El()); await Promise.resolve();
const name=allEls.filter(element=>element.className==='layer-name').at(-1); name.handlers.dblclick({stopPropagation(){}}); name.replacement.value='Renamed'; name.replacement.handlers.blur();
assert.equal(map.layers.at(-1).name,'Renamed'); host.history.undo(); assert.notEqual(map.layers.at(-1).name,'Renamed'); host.history.redo(); assert.equal(map.layers.at(-1).name,'Renamed');
`);
}

export function verifyTerrainToolbarRefresh() {
  runIsolated(String.raw`
import assert from 'node:assert/strict';
import { EditorHost } from './js/host/editor-host.js';
import { setEditorHost } from './js/host/runtime.js';
import { createProject, createSheet } from './js/core/model.js';
import { createTerrainSet } from './js/core/terrainsets.js';
import { tileMode } from './js/modes/tiles/index.js';
import { mountAutotilesPanel } from './js/modes/tiles/presentation/terrain-set-panel.js';
import { startAutotilePaint, stopAutotilePaint } from './js/modes/tiles/presentation/autotile-paint-presenter.js';
${panelDom}
globalThis.document={body:new El(),createElement:tag=>new El(tag)};
const host=new EditorHost(); setEditorHost(host); host.registerMode(tileMode); host.start('tiles');
const project=createProject('test'); const sheet=createSheet(project,{name:'tile',kind:'tile',width:1,height:1}); const terrain=createTerrainSet(sheet,{tileW:1,tileH:1,name:'Terrain'}); host.setProject(project);
host.selections.patch({terrainSetId:terrain.id}); host.store.updateSession({activeToolId:'tiletool'});
const element=new El(); const panel=mountAutotilesPanel(element);
const texts=node=>[node.textContent,...(node.children??[]).flatMap(texts)].filter(Boolean);
const toolbar=()=>texts(element).filter(value=>['🧩 Paint terrain','Paint','Erase','Done'].includes(value));
startAutotilePaint(sheet,terrain); await Promise.resolve(); assert.deepEqual(toolbar(),['Paint','Erase','Done']);
stopAutotilePaint(); await Promise.resolve(); assert.deepEqual(toolbar(),['🧩 Paint terrain']);
startAutotilePaint(sheet,terrain); await Promise.resolve(); assert.deepEqual(toolbar(),['Paint','Erase','Done']); panel.dispose();
`);
}

export function verifyTileGestureCancellationAndCompletion() {
  runIsolated(String.raw`
import assert from 'node:assert/strict';
import { EditorHost } from './js/host/editor-host.js';
import { setEditorHost } from './js/host/runtime.js';
import { createProject, createSheet } from './js/core/model.js';
import { tileMode } from './js/modes/tiles/index.js';
import { bindTileTool } from './js/modes/tiles/presentation/tile-tool-presenter.js';
const host=new EditorHost(); setEditorHost(host); host.registerMode(tileMode); host.start('tiles');
const project=createProject('test'); const sheet=createSheet(project,{name:'Tile',kind:'tile',width:64,height:64}); host.setProject(project); host.store.updateSession({activeToolId:'tiletool'});
const dispatch=(id,args)=>host.registries.commands.execute(id,{modeId:'tiles'},args);
const view={onPointer(){},onOverlay(){},requestRender(){},zoom:10,imageToScreen(x,y){return{x:x*10,y:y*10}}}; bindTileTool(view);
dispatch('tiles.createTile',{sheetId:sheet.id,rect:{x:0,y:0,w:16,h:16}}); const deleted=host.selections.get().tileId;
view.onPointer({type:'down',x:8,y:8,sx:80,sy:80,buttons:1}); dispatch('tiles.deleteTile',{sheetId:sheet.id,tileId:deleted});
view.onPointer({type:'up',x:12,y:8,sx:120,sy:80,buttons:0}); assert.equal(sheet.tiles.length,0);
dispatch('tiles.createTile',{sheetId:sheet.id,rect:{x:0,y:0,w:16,h:16}}); const tile=sheet.tiles[0];
view.onPointer({type:'down',x:8,y:8,sx:80,sy:80,buttons:1}); host.store.updateSession({activeDocument:null});
view.onPointer({type:'up',x:12,y:8,sx:120,sy:80,buttons:0}); assert.equal(tile.x,0);
host.store.updateSession({activeDocument:{kind:'tile-sheet',id:sheet.id}});
view.onPointer({type:'down',x:8,y:8,sx:80,sy:80,buttons:1}); view.onPointer({type:'up',x:12,y:8,sx:120,sy:80,buttons:0}); assert.equal(tile.x,4);
`);
}
