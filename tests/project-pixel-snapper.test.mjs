import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, DEFAULT_SETTINGS } from '../js/core/model.js';
import { snapProjectPixels } from '../js/core/project-pixel-snapper.js';
import { createPalette } from '../js/core/palettes.js';

function bitmap(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return { width, height, data };
}

test('snapProjectPixels returns the original bitmap when the project setting is disabled', () => {
  const project = createProject('disabled');
  const source = bitmap(4, 4, [10, 20, 30, 255]);
  assert.equal(snapProjectPixels(project, source), source);
});

test('snapProjectPixels applies the configured project palette when enabled', () => {
  const project = createProject('enabled', {
    ...DEFAULT_SETTINGS,
    pixelSnapperEnabled: true,
  });
  const palette = createPalette({ name: 'Target' });
  palette.colors.push([255, 0, 0, 255]);
  project.palettes.push(palette);
  project.settings.pixelSnapperPaletteId = palette.id;
  const result = snapProjectPixels(project, bitmap(4, 4, [230, 20, 20, 255]));
  for (let i = 0; i < result.data.length; i += 4) {
    assert.deepEqual([...result.data.slice(i, i + 4)], [255, 0, 0, 255]);
  }
});
