import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet } from '../js/core/model.js';
import { collectProjectExportEntries } from '../js/app/projectExport.js';

test('collectProjectExportEntries: prefixes each builder output with its sheet name, skips missing sheets', async () => {
  const project = createProject('demo');
  const a = createSheet(project, { name: 'Hero', width: 8, height: 8, kind: 'sprite' });
  const b = createSheet(project, { name: 'Ground', width: 8, height: 8, kind: 'tile' });

  const calls = [];
  const buildSheetExport = async (sheet, format) => {
    calls.push([sheet.name, format]);
    return [{ path: `${format}.bin`, data: new Uint8Array([1]) }];
  };

  const entries = await collectProjectExportEntries(project, [
    { sheetId: a.id, format: 'json' },
    { sheetId: b.id, format: 'tsx' },
    { sheetId: 'missing', format: 'json' },
  ], buildSheetExport);

  assert.deepEqual(calls, [['Hero', 'json'], ['Ground', 'tsx']]);
  assert.deepEqual(entries.map(e => e.path), ['Hero/json.bin', 'Ground/tsx.bin']);
});
