import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountApplicationMenu } from '../js/features/shell/menu-controller.js';
import { runAction } from '../js/features/shell/actions.js';

test('About displays the released package version without runtime fetching', async t => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const elements = new Map();
  const createElement = () => ({
    textContent: '',
    classList: { add() {} },
    addEventListener() {},
    append() {},
    appendChild() {},
    showModal() { this.open = true; },
  });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('About must not fetch its version'); });
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement,
    addEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    },
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });

  mountApplicationMenu();
  await runAction('help.about');

  assert.equal(elements.get('dlg-about').open, true);
  assert.equal(elements.get('about-version').textContent, `Version ${manifest.version}`);
});
