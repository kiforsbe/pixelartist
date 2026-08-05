import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1));

async function jsFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? jsFiles(path) : entry.name.endsWith('.js') ? [path] : [];
  }));
  return nested.flat();
}

test('the browser composition root stays small', async () => {
  const source = await readFile(join(root, 'js/app/main.js'), 'utf8');
  assert.ok(source.split(/\r?\n/).length <= 30, 'main.js must remain a composition layer');
});

test('pure core modules do not depend on application, UI, host, platform, or modes', async () => {
  for (const file of await jsFiles(join(root, 'js/core'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:app|ui|host|platform|modes)\//, file);
  }
});

test('domain modules do not depend on application, browser, host, UI, or modes', async () => {
  for (const file of await jsFiles(join(root, 'js/domain'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:application|app|platform|host|ui|components|features|modes)\//, file);
  }
});

test('modes never import sibling modes', async () => {
  for (const mode of ['sprites', 'tiles', 'maps']) {
    for (const file of await jsFiles(join(root, `js/modes/${mode}`))) {
      const source = await readFile(file, 'utf8');
      for (const sibling of ['sprites', 'tiles', 'maps'].filter(value => value !== mode)) {
        assert.doesNotMatch(source, new RegExp(`modes[\\\\/]${sibling}|[.][.][\\\\/]${sibling}[\\\\/]`), file);
      }
    }
  }
});

test('shared workbench composes mode registries without concrete mode UI imports', async () => {
  const source = await readFile(join(root, 'js/features/workbench/editor-workbench.js'), 'utf8');
  assert.doesNotMatch(source, /ui\/(?:frames|tilemode|mapmode|frameeditor|tileeditor)\.js/);
  assert.match(source, /registries\.tools\.list/);
  assert.match(source, /new PanelManager/);
  assert.match(source, /registries\.views\.list/);
});

test('shared preview delegates rendering to mode providers', async () => {
  const source = await readFile(join(root, 'js/ui/previewpanel.js'), 'utf8');
  assert.doesNotMatch(source, /(?:mapmode|modes\/maps|renderMapPreviewBitmap)/);
  assert.match(source, /registries\.previews\.list/);
});

test('mode canvas controllers do not own contribution panels', async () => {
  for (const file of [
    join(root, 'js/modes/sprites/sprite-sheet-controller.js'),
    join(root, 'js/modes/tiles/tile-editor-controller.js'),
    join(root, 'js/modes/tiles/autotile-paint-controller.js'),
  ]) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /export function mount[A-Za-z]+Panel\s*\(/, file);
  }
});
