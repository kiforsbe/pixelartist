import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEntries } from '../js/core/bundle.js';
import { DEFAULT_SETTINGS, deserializeProject, flattenSheet, newDefaultProject, serializeProject, validateProjectJson } from '../js/core/model.js';
import { createBitmap } from '../js/core/pixels.js';

const imagePath = 'images/sheet/paint.png';
const basePath = 'images/sheet/base.png';

function projectJson(version = 3) {
  const base = { id: 'base', type: 'layer', name: 'Base', visible: true, opacity: 1, image: basePath };
  const paint = { id: 'paint', type: 'layer', name: 'Paint', visible: true, opacity: 1, image: imagePath };
  const sheet = { id: 'sheet', name: 'Sheet', width: 2, height: 1, kind: 'sprite', frames: [], animations: [] };
  if (version === 2) sheet.layers = [base, paint];
  else sheet.layerTree = { id: 'root', type: 'group', children: [base,
    { id: 'outer', type: 'group', children: [{ id: 'inner', type: 'group', children: [paint] }] },
  ] };
  return { version, name: 'Import', settings: { ...DEFAULT_SETTINGS }, sheets: [sheet] };
}

function images(bitmap = createBitmap(2, 1)) {
  return new Map([[basePath, createBitmap(2, 1)], [imagePath, bitmap]]);
}

const invalidPositiveIntegers = [undefined, null, '2', 0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
const invalidDimensions = [...invalidPositiveIntegers, 4097];
for (const key of ['spriteSheetW', 'spriteSheetH', 'tileSheetW', 'tileSheetH']) {
  test(`import rejects invalid settings.${key} dimensions`, () => {
    for (const version of [2, 3]) for (const value of invalidDimensions) {
      const json = projectJson(version);
      json.settings[key] = value;
      assert.equal(validateProjectJson(json).ok, false, `version ${version}: ${key}=${String(value)}`);
      assert.throws(() => deserializeProject(json, images()), /settings\./);
    }
  });
}

for (const key of ['tileW', 'tileH', 'frameW', 'frameH']) {
  test(`import rejects invalid settings.${key} default item sizes`, () => {
    for (const version of [2, 3]) for (const value of invalidPositiveIntegers) {
      const json = projectJson(version);
      json.settings[key] = value;
      assert.equal(validateProjectJson(json).ok, false, `version ${version}: ${key}=${String(value)}`);
      assert.throws(() => deserializeProject(json, images()), /settings\./);
    }
  });

  test(`default project round-trip preserves settings.${key} above canvas size limits`, () => {
    for (const value of [4097, Number.MAX_SAFE_INTEGER]) {
      const original = newDefaultProject({ ...DEFAULT_SETTINGS, [key]: value });
      const { json, images: bitmaps } = serializeProject(original);
      const loaded = deserializeProject(JSON.parse(JSON.stringify(json)), new Map(bitmaps.map(({ path, bitmap }) => [path, bitmap])));
      assert.equal(loaded.settings[key], value);
      assert.deepEqual(loaded.sheets.map(({ width, height }) => ({ width, height })), [
        { width: 256, height: 256 }, { width: 256, height: 256 },
      ]);
    }
  });
}

for (const key of ['width', 'height']) {
  test(`import rejects invalid sheet ${key} dimensions`, () => {
    for (const version of [2, 3]) for (const value of invalidDimensions) {
      const json = projectJson(version);
      json.sheets[0][key] = value;
      assert.equal(validateProjectJson(json).ok, false, `version ${version}: ${key}=${String(value)}`);
      assert.throws(() => deserializeProject(json, images()), /sheet/i);
    }
  });
}

test('import rejects non-finite or non-positive default duration', () => {
  for (const value of [undefined, null, '100', 0, -1, NaN, Infinity, -Infinity]) {
    const json = projectJson();
    json.settings.durationMs = value;
    assert.equal(validateProjectJson(json).ok, false, `durationMs=${String(value)}`);
    assert.throws(() => deserializeProject(json, images()), /durationMs/);
  }
});

test('import accepts boundary dimensions and durations independent of dimension limits', () => {
  for (const version of [2, 3]) for (const dimension of [1, 4096]) {
    const json = projectJson(version);
    for (const key of ['spriteSheetW', 'spriteSheetH', 'tileSheetW', 'tileSheetH', 'tileW', 'tileH', 'frameW', 'frameH']) {
      json.settings[key] = dimension;
    }
    json.sheets[0].width = dimension;
    json.settings.durationMs = dimension === 1 ? 0.5 : 60000;
    const bitmaps = new Map([[basePath, createBitmap(dimension, 1)], [imagePath, createBitmap(dimension, 1)]]);
    const loaded = deserializeProject(json, bitmaps);
    assert.equal(loaded.sheets[0].width, dimension);
    assert.equal(loaded.settings.durationMs, dimension === 1 ? 0.5 : 60000);
  }
});

for (const key of ['tileWidth', 'tileHeight']) {
  test(`legacy tile migration rejects invalid ${key} before generating tiles`, () => {
    for (const version of [2, 3]) for (const value of invalidPositiveIntegers) {
      const json = projectJson(version);
      json.sheets[0].kind = 'tile';
      json.sheets[0].tile = { tileWidth: 1, tileHeight: 1, [key]: value };
      // Validate first: zero would otherwise leave migration in an unbounded loop.
      assert.equal(validateProjectJson(json).ok, false, `version ${version}: ${key}=${String(value)}`);
      assert.throws(() => deserializeProject(json, images()), /tile/i);
    }
  });

  test(`legacy tile ${key} larger than the sheet migrates without allocating cells`, () => {
    for (const version of [2, 3]) for (const value of [4097, Number.MAX_SAFE_INTEGER]) {
      const json = projectJson(version);
      json.sheets[0].kind = 'tile';
      json.sheets[0].tile = { tileWidth: 1, tileHeight: 1, [key]: value };
      const sheet = deserializeProject(json, images()).sheets[0];
      assert.deepEqual(sheet.tiles, []);
      assert.equal(sheet.tileGrids[0].cellW, key === 'tileWidth' ? value : 1);
      assert.equal(sheet.tileGrids[0].cellH, key === 'tileHeight' ? value : 1);
      assert.equal(sheet.tileGrids[0].cols, key === 'tileWidth' ? 0 : 2);
      assert.equal(sheet.tileGrids[0].rows, key === 'tileHeight' ? 0 : 1);
    }
  });
}

test('valid legacy grid dimensions still migrate to explicit tiles', () => {
  const json = projectJson(2);
  json.sheets[0].kind = 'tile';
  json.sheets[0].tile = { tileWidth: 1, tileHeight: 1, names: ['Left', 'Right'] };
  const loaded = deserializeProject(json, images());
  assert.deepEqual(loaded.sheets[0].tiles.map(({ x, y, w, h, name }) => ({ x, y, w, h, name })), [
    { x: 0, y: 0, w: 1, h: 1, name: 'Left' }, { x: 1, y: 0, w: 1, h: 1, name: 'Right' },
  ]);
});

for (const version of [2, 3]) {
  test(`v${version} import rejects a later layer whose decoded dimensions differ from its sheet`, () => {
    for (const bitmap of [createBitmap(1, 1), createBitmap(2, 2), createBitmap(1, 2),
      { width: '2', height: 1, data: new Uint8ClampedArray(8) }]) {
      assert.throws(() => deserializeProject(projectJson(version), images(bitmap)), /image.*dimensions|dimensions.*image/i);
    }
  });

  test(`v${version} import rejects malformed decoded RGBA storage`, () => {
    for (const data of [undefined, null, [], new Array(8).fill(0), { length: 8 },
      new Uint8Array(8), new Uint16Array(8), new Float32Array(8), new DataView(new ArrayBuffer(8)),
      new Uint8ClampedArray(7), new Uint8ClampedArray(9)]) {
      const bitmap = { width: 2, height: 1, data };
      assert.throws(() => deserializeProject(projectJson(version), images(bitmap)), /image.*RGBA|RGBA.*image/i);
    }
  });

  test(`v${version} valid decoded pixels remain renderable after import`, () => {
    const bitmap = { width: 2, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]) };
    const loaded = deserializeProject(projectJson(version), images(bitmap));
    assert.deepEqual([...flattenSheet(loaded.sheets[0]).data], [1, 2, 3, 255, 4, 5, 6, 255]);
  });

  test(`v${version} bundle loading rejects inconsistent decoded images`, async () => {
    const entries = [
      { path: 'project.json', data: new TextEncoder().encode(JSON.stringify(projectJson(version))) },
      { path: basePath, data: new Uint8Array([0]) }, { path: imagePath, data: new Uint8Array([1]) },
    ];
    await assert.rejects(() => loadEntries(entries, async bytes => createBitmap(bytes[0] ? 1 : 2, 1)), /dimensions/i);
  });
}

test('bundle metadata rejects unsafe dimensions before decoding image data', async () => {
  const json = projectJson();
  json.sheets[0].width = -1;
  const entries = [
    { path: 'project.json', data: new TextEncoder().encode(JSON.stringify(json)) },
    { path: imagePath, data: new Uint8Array([0]) },
  ];
  let decoded = 0;
  await assert.rejects(() => loadEntries(entries, async () => { decoded++; return createBitmap(2, 1); }), /sheet/i);
  assert.equal(decoded, 0);
});
