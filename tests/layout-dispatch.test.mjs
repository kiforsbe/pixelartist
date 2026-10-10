import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { dispatchLayout } from '../js/components/layout-dispatch.js';

installSpriteContextDom();
const alerts = [];
globalThis.alert = message => alerts.push(message);
const host = new EditorHost(); setEditorHost(host);
const results = { refused: { ok: false, reason: 'No room' }, sized: { ok: false, reason: 'Pick a size', needsSize: true } };
host.registries.commands.register({ id: 'test.layout', execute: (_c, { kind }) => results[kind] });

test('a refusal alerts its reason', () => {
  alerts.length = 0;
  assert.equal(dispatchLayout('test.layout', { kind: 'refused' }).ok, false);
  assert.deepEqual(alerts, ['No room']);
});

test('a needsSize refusal is returned without an alert', () => {
  alerts.length = 0;
  assert.equal(dispatchLayout('test.layout', { kind: 'sized' }).needsSize, true);
  assert.deepEqual(alerts, []);
});
