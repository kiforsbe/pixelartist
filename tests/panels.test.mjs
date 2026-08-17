import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbaToHex, hexToRgb } from '../js/components/color-utils.js';

test('rgbaToHex: formats RGB as lowercase 6-digit hex, extra/alpha elements ignored', () => {
  assert.equal(rgbaToHex([255, 0, 128, 255]), '#ff0080');
  assert.equal(rgbaToHex([0, 0, 0, 0]), '#000000');
});

test('hexToRgb: parses a 6-digit hex string back to [r, g, b]', () => {
  assert.deepEqual(hexToRgb('#ff0080'), [255, 0, 128]);
  assert.deepEqual(hexToRgb('#000000'), [0, 0, 0]);
});

test('rgbaToHex/hexToRgb round-trip', () => {
  const rgb = [12, 34, 56];
  assert.deepEqual(hexToRgb(rgbaToHex([...rgb, 255])), rgb);
});
