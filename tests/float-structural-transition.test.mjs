import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import {
  createProject, createSheet, createLayerNode, createGroupNode, addFrame, addAnimation,
  acceptAnimation, animationGroup, findNode,
} from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { mountFrameEditor } from '../js/modes/sprites/presentation/frame-editor-presenter.js';
import { mountTimeline } from '../js/modes/sprites/presentation/timeline-presenter.js';
import { mountLayersPanel } from '../js/components/panels/layers-panel.js';
import { initFloatSession, createFloat, activeFloating } from '../js/components/canvas/float-session.js';

const { Element } = installSpriteContextDom();
globalThis.confirm = () => true;
const host = new EditorHost();
setEditorHost(host); host.registerMode(spriteMode); host.start('sprites');
initFloatSession();
const timeline = new Element(), panel = new Element();
const editor = mountFrameEditor(new Element());
mountTimeline(timeline); mountLayersPanel(panel);
const red = [255, 0, 0, 255], blue = [0, 0, 255, 255], clear = [0, 0, 0, 0];

async function reset({ plainGroup = false } = {}) {
  const project = createProject('Structural edits'); project.settings.onion.enabled = false;
  const sheet = createSheet(project, { name: 'Sheet', width: 4, height: 4, kind: 'sprite' });
  const frame = addFrame(sheet, { name: 'Frame', x: 0, y: 0, w: 4, h: 4 });
  const anim = addAnimation(sheet, 'Accepted');
  anim.frames = [{ frameId: frame.id, duration: 100 }]; acceptAnimation(sheet, anim);
  const group = animationGroup(sheet, anim.id), dest = group.children[0];
  const layer = createLayerNode('Top', sheet.width, sheet.height);
  const nestedGroup = plainGroup ? createGroupNode('Plain group') : null;
  if (nestedGroup) { nestedGroup.children.push(layer); group.children.push(nestedGroup); }
  else group.children.push(layer);
  setPixel(layer.bitmap, 0, 0, red); setPixel(dest.bitmap, 2, 0, blue);
  host.setProject(project);
  host.selections.patch({ animationId: anim.id, frameId: frame.id, editingFrameId: frame.id });
  host.store.updateSession({ activeViewId: 'sprites.frame', activeToolId: 'move' });
  editor.show(); await Promise.resolve();
  panel.querySelectorAll('.layer-leaf').find(row => row.dataset.nodeId === layer.id).fire('click');
  host.history.clear();
  return { sheet, anim, group, layer, dest, nestedGroup };
}

function moveFloat(options) {
  assert.equal(createFloat(options), true);
  activeFloating().transform.tx = 1;
}

function clickButton(root, title) {
  const button = root.querySelectorAll('button').find(candidate => candidate.title === title);
  assert.ok(button, `missing button: ${title}`); button.fire('click');
}

function assertSettledLayerRestored(sheet, layer) {
  assert.equal(findNode(sheet.layerTree, layer.id), layer, 'one undo restores the structural edit');
  assert.deepEqual(getPixel(layer.bitmap, 1, 0), red, 'restored content includes the moved float');
  assert.deepEqual(getPixel(layer.bitmap, 0, 0), clear);
  assert.equal(activeFloating(), null, 'undoing structure does not resurrect an empty nested float command');
}

for (const source of ['timeline', 'layers panel']) {
  test(`${source} animation delete settles its accepted-layer float before deleting the group`, async () => {
    const { sheet, anim, group, layer } = await reset();
    if (source === 'layers panel') {
      panel.querySelectorAll('.group-row').find(row => row.dataset.nodeId === group.id).fire('click');
    }
    moveFloat({ allLayers: source === 'layers panel' });
    clickButton(source === 'timeline' ? timeline : panel, source === 'timeline' ? 'Delete animation' : 'Delete Layer');
    assert.equal(sheet.animations.includes(anim), false);
    assert.equal(activeFloating(), null);
    host.history.undo();
    assert.equal(sheet.animations.includes(anim), true);
    assertSettledLayerRestored(sheet, layer);
    host.history.redo();
    assert.equal(sheet.animations.includes(anim), false);
    host.history.undo();
    assertSettledLayerRestored(sheet, layer);
    host.history.undo();
    assert.ok(activeFloating(), 'the preceding history step is the real float settlement');
    assert.deepEqual(getPixel(layer.bitmap, 1, 0), clear);
    host.history.undo();
    assert.deepEqual(getPixel(layer.bitmap, 0, 0), red);
    assert.equal(host.history.canUndo(), false, 'no additional empty command was nested in deletion');
  });
}

test('layer delete settles its float before taking the undo snapshot', async () => {
  const { sheet, layer, dest } = await reset(); moveFloat();
  clickButton(panel, 'Delete Layer');
  assert.equal(findNode(sheet.layerTree, layer.id), null);
  assert.equal(activeFloating(), null);
  host.history.undo();
  assertSettledLayerRestored(sheet, layer);
  assert.deepEqual(getPixel(dest.bitmap, 2, 0), blue);
  host.history.redo();
  assert.equal(findNode(sheet.layerTree, layer.id), null);
  host.history.undo();
  assertSettledLayerRestored(sheet, layer);
});

test('plain group delete settles a multilayer float before removing its source layers', async () => {
  const { sheet, nestedGroup, layer } = await reset({ plainGroup: true });
  panel.querySelectorAll('.group-row').find(row => row.dataset.nodeId === nestedGroup.id).fire('click');
  moveFloat({ allLayers: true });
  clickButton(panel, 'Delete Layer');
  assert.equal(findNode(sheet.layerTree, nestedGroup.id), null);
  assert.equal(activeFloating(), null, 'deletion settles even when the selected layer is already null');
  host.history.undo();
  assertSettledLayerRestored(sheet, layer);
});

test('merge down includes the float in its composite and restores the settled source on undo', async () => {
  const { sheet, layer, dest } = await reset(); moveFloat();
  clickButton(panel, 'Merge Down');
  assert.equal(findNode(sheet.layerTree, layer.id), null);
  assert.deepEqual(getPixel(dest.bitmap, 1, 0), red, 'merged destination includes floating content');
  assert.deepEqual(getPixel(dest.bitmap, 2, 0), blue);
  assert.equal(activeFloating(), null);
  host.history.undo();
  assertSettledLayerRestored(sheet, layer);
  assert.deepEqual(getPixel(dest.bitmap, 1, 0), clear);
  assert.deepEqual(getPixel(dest.bitmap, 2, 0), blue);
  host.history.redo();
  assert.equal(findNode(sheet.layerTree, layer.id), null);
  assert.deepEqual(getPixel(dest.bitmap, 1, 0), red);
});
