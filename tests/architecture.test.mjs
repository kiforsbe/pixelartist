import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1));

async function jsFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? jsFiles(path) : entry.name.endsWith('.js') ? [path] : [];
  }));
  return nested.flat();
}

test('the browser composition root (bootstrap.js) stays small', async () => {
  // Replaces the old js/app/main.js <= 30 line guard, retired along with
  // that file when Task 5 consolidated composition into js/bootstrap.js.
  // Ceiling set above bootstrap.js's current ~50 lines (not a tight rubber
  // stamp) so it can absorb modest future growth without silently regrowing
  // into a god-file that inlines mount-order logic instead of delegating to
  // mount*() functions.
  const source = await readFile(join(root, 'js/bootstrap.js'), 'utf8');
  const lineCount = source.split('\n').length;
  assert.ok(lineCount <= 60, `js/bootstrap.js has grown to ${lineCount} lines (limit 60) -- move logic into a mount*() function instead of inlining it here`);
});

test('nothing in the shell controllers imports the retired legacy setProject/markDirty writers', async () => {
  // Deliberately does NOT ban `on`/`emit`: pixels/selection/tool/view events
  // stay on the legacy bus in several of these files throughout this whole
  // plan (editor-workbench.js's brushSize/colors/pixels/selection wiring,
  // file-controller.js's/filter-controller.js's/float-session.js's own
  // 'pixels' emits) -- banning those names would make this test fail against
  // its own already-correct target state, not just the pre-migration one.
  // setProject()/markDirty() are different: every call site converted to
  // editorHost.setProject()/projects.markDirty() by Tasks 1-5, so these two
  // imports have zero legitimate remaining uses in these 7 files.
  const SHELL_FILES = [
    'js/features/project/document-controller.js',
    'js/features/project/file-controller.js',
    'js/features/project/project-controller.js',
    'js/features/transforms/filter-controller.js',
    'js/features/shell/menu-controller.js',
    'js/features/workbench/editor-workbench.js',
    'js/components/canvas/float-session.js',
  ];
  const offenders = [];
  for (const relPath of SHELL_FILES) {
    const source = await readFile(join(root, relPath), 'utf8');
    const importMatch = source.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*app\/state\.js['"]/);
    if (!importMatch) continue;
    const names = importMatch[1].split(',').map(n => n.trim()).filter(Boolean);
    const banned = names.filter(n => ['setProject', 'markDirty'].includes(n));
    if (banned.length) offenders.push(`${relPath}: ${banned.join(', ')}`);
  }
  assert.deepStrictEqual(offenders, [], `these shell files still import banned legacy state.js exports:\n${offenders.join('\n')}`);
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

test('sprites mode does not import the legacy app state module', async () => {
  for (const file of await jsFiles(join(root, 'js/modes/sprites'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*app[\\/]state\.js['"]/, file);
  }
});

test('tiles mode does not import the legacy app state module', async () => {
  for (const file of await jsFiles(join(root, 'js/modes/tiles'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*app[\\/]state\.js['"]/, file);
  }
});

test('shared workbench composes mode registries without concrete mode UI imports', async () => {
  const source = await readFile(join(root, 'js/features/workbench/editor-workbench.js'), 'utf8');
  assert.doesNotMatch(source, /from\s+['"][^'"]*modes[\\/]/);
  assert.match(source, /registries\.tools\.list/);
  assert.match(source, /new PanelManager/);
  assert.match(source, /registries\.views\.list/);
});

test('shared preview delegates rendering to mode providers', async () => {
  const source = await readFile(join(root, 'js/components/panels/preview-panel.js'), 'utf8');
  assert.doesNotMatch(source, /(?:mapmode|modes\/maps|renderMapPreviewBitmap)/);
  assert.match(source, /registries\.previews\.list/);
});

test('nothing imports the retired js/ui directory', async () => {
  for (const file of await jsFiles(join(root, 'js'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*[\\/]ui[\\/]/, file);
  }
});

test('mode canvas controllers do not own contribution panels', async () => {
  for (const file of [
    join(root, 'js/modes/sprites/presentation/frame-tool-presenter.js'),
    join(root, 'js/modes/tiles/presentation/tile-tool-presenter.js'),
    join(root, 'js/modes/tiles/presentation/autotile-paint-presenter.js'),
  ]) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /export function mount[A-Za-z]+Panel\s*\(/, file);
  }
});

test('mode pointer controllers do not import contextual panels or terrain UI', async () => {
  const spriteController = await readFile(join(root, 'js/modes/sprites/presentation/frame-tool-presenter.js'), 'utf8');
  assert.doesNotMatch(spriteController, /frames?-panel/);

  const tileController = await readFile(join(root, 'js/modes/tiles/presentation/tile-tool-presenter.js'), 'utf8');
  assert.doesNotMatch(tileController, /(?:tile-panel|terrain-set-panel|tile-layers-panel|terrain-set-editor|tile-tags-field)/);
});

test('mode command modules do not access browser UI globals', async () => {
  for (const file of [
    join(root, 'js/modes/tiles/application/commands/tile-sheet-commands.js'),
    join(root, 'js/modes/tiles/application/commands/terrain-set-commands.js'),
    join(root, 'js/modes/tiles/application/commands/terrain-slot-snapshot.js'),
    join(root, 'js/modes/tiles/application/commands/tile-layer-commands.js'),
    join(root, 'js/modes/tiles/application/commands/autotile-paint-commands.js'),
    join(root, 'js/modes/tiles/application/commands/tile-editor-commands.js'),
  ]) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /\bdocument\.|\b(?:window|prompt|alert|confirm)\b/, file);
  }
});

test('map command modules do not access browser UI globals', async () => {
  for (const file of [
    join(root, 'js/modes/maps/application/commands/map-paint-commands.js'),
    join(root, 'js/modes/maps/application/commands/map-layer-commands.js'),
  ]) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /\bdocument\.|\b(?:window|prompt|alert|confirm)\b/, file);
  }
});

test('sprite command modules do not access browser UI globals', async () => {
  for (const file of [
    join(root, 'js/modes/sprites/application/commands/frame-commands.js'),
    join(root, 'js/modes/sprites/application/commands/strip-commands.js'),
    join(root, 'js/modes/sprites/application/commands/frame-metadata-commands.js'),
    join(root, 'js/modes/sprites/application/commands/animation-commands.js'),
    join(root, 'js/modes/sprites/application/commands/animation-lifecycle-commands.js'),
    join(root, 'js/modes/sprites/application/commands/animation-frame-commands.js'),
  ]) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /\bdocument\.|\b(?:window|prompt|alert|confirm)\b/, file);
  }
});

test('application-layer code (js/host, excluding workbench, and any mode application/ folders) never touches DOM or Canvas rendering', async () => {
  // Matches concrete DOM/Canvas API surface, not the word "document"/"window" used
  // as an ordinary identifier (this file's own domain vocabulary is "documents").
  const bannedGlobals = /document\.(?:getElementById|querySelector|querySelectorAll|createElement|createElementNS|createTextNode|createDocumentFragment|body|documentElement|activeElement|addEventListener|removeEventListener|dispatchEvent)\b|window\.(?:innerWidth|innerHeight|devicePixelRatio|requestAnimationFrame|cancelAnimationFrame|localStorage|sessionStorage|location|navigator|matchMedia|addEventListener|removeEventListener)\b|\balert\(|\bconfirm\(|\bprompt\(|CanvasRenderingContext2D|OffscreenCanvas|\.getContext\(/;

  const hostFiles = (await jsFiles(join(root, 'js/host')))
    .filter(file => !file.includes(`${sep}workbench${sep}`));
  const modeApplicationFiles = (await jsFiles(join(root, 'js/modes')))
    .filter(file => file.includes(`${sep}application${sep}`));

  for (const file of [...hostFiles, ...modeApplicationFiles]) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, bannedGlobals, file);
  }
});

test('presentation-layer mode code dispatches commands by id only, never imports command handlers directly', async () => {
  const presentationFiles = (await jsFiles(join(root, 'js/modes')))
    .filter(file => file.includes(`${sep}presentation${sep}`));

  for (const file of presentationFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*application[\\/]commands[\\/]/, file);
    assert.doesNotMatch(source, /from\s+['"][^'"]*core[\\/]commands\.js['"]/, file);
  }
});

test('only the tracked terrain-preset-art.js exception imports core/commands.js from outside application/presentation', async () => {
  const modeFiles = (await jsFiles(join(root, 'js/modes')))
    .filter(file => !file.includes(`${sep}application${sep}`) && !file.includes(`${sep}presentation${sep}`));

  const offenders = [];
  for (const file of modeFiles) {
    const source = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*core[\\/]commands\.js['"]/.test(source)) {
      offenders.push(relative(root, file).split(sep).join('/'));
    }
  }

  assert.deepEqual(offenders, ['js/modes/tiles/terrain-preset-art.js']);
});
