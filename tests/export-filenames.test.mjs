import test from 'node:test';
import assert from 'node:assert/strict';
import { mountFileFixture } from './helpers/file-controller-fixture.mjs';
import { spriteMode } from '../js/modes/sprites/index.js';
import { tileMode } from '../js/modes/tiles/index.js';
import { createSheet, addFrame, addAnimation } from '../js/core/model.js';
import { zipRead } from '../js/core/zip.js';

const f = await mountFileFixture();
f.host.registerMode(spriteMode); f.host.registerMode(tileMode); f.host.start('sprites');

for (const [mode, kind, format] of [['sprites', 'sprite', 'frames'], ['tiles', 'tile', 'tiles'], ['tiles', 'tile', 'tsx']]) {
  test(`separate PNG and ${format} downloads agree on the image filename`, async () => {
    const project = f.reset(); project.name = 'Game'; f.host.activateMode(mode);
    const sheet = createSheet(project, { name: 'Hero', kind, width: 2, height: 2 });
    f.host.documents.setActive({ kind: kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id });
    await f.runAction('document.exportSheet.png');
    f.runAction(`document.exportSheet.${format}`);
    assert.equal(f.downloads.length, 2);
    const metadata = await f.downloads[1].blob.text();
    const image = format === 'tsx' ? metadata.match(/<image source="([^"]+)"/)[1] : JSON.parse(metadata).sheet;
    assert.equal(image, f.downloads[0].name);
  });
}

test('animation spritesheet JSON references its downloaded PNG', async () => {
  const project = f.reset(); f.host.activateMode('sprites'); const sheet = project.sheets[0];
  const frame = addFrame(sheet, { name: 'Frame', x: 0, y: 0, w: 1, h: 1 });
  const anim = addAnimation(sheet, 'Run'); anim.frames.push({ frameId: frame.id, duration: 100 });
  f.host.selections.patch({ animationId: anim.id });
  f.runAction('document.exportAnimation.spritesheet'); await f.waitForDownloads(2);
  assert.equal(JSON.parse(await f.downloads[1].blob.text()).sheet, f.downloads[0].name);
});

test('C99 controller downloads the exact header named in the generated include', async () => {
  const project = f.reset(); f.host.activateMode('sprites'); const sheet = project.sheets[0];
  sheet.name = '9 bad"name';
  addFrame(sheet, { name: 'Frame 1', x: 0, y: 0, w: 1, h: 1 });
  f.runAction('document.exportSheet.c99');
  assert.equal(f.downloads.length, 2);
  assert.ok((await f.downloads[1].blob.text()).startsWith(`#include "${f.downloads[0].name}"\n`));
});

for (const [kind, format] of [['sprite', 'json'], ['tile', 'json'], ['tile', 'tsx'], ['sprite', 'c99']]) {
  test(`project ${kind}/${format} export ZIP contains the metadata's companion image/header`, async () => {
    const project = f.reset();
    const sheet = kind === 'sprite' ? project.sheets[0] : createSheet(project, { name: 'Tiles', kind, width: 2, height: 2 });
    if (kind === 'sprite') addFrame(sheet, { name: 'Frame 1', x: 0, y: 0, w: 1, h: 1 });
    f.runAction('file.export');
    for (const candidate of project.sheets) f.elements.get(`ep-sheet-${candidate.id}`).checked = candidate === sheet;
    f.elements.get(`ep-format-${sheet.id}`).value = format;
    await f.elements.get('ep-export').emit('click');
    assert.equal(f.alerts.length, 0);
    assert.equal(f.downloads.length, 1);
    const entries = await zipRead(new Uint8Array(await f.downloads[0].blob.arrayBuffer()));
    const metadata = entries.find(entry => /\.(json|tsx|c)$/.test(entry.path));
    const text = new TextDecoder().decode(metadata.data);
    const companion = format === 'json' ? JSON.parse(text).sheet
      : format === 'tsx' ? text.match(/<image source="([^"]+)"/)[1]
      : text.match(/^#include "([^"]+)"/)[1];
    assert.ok(entries.some(entry => entry.path === `${sheet.name}/${companion}`));
  });
}
