import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkItemAgainstPlatform, NES_PALETTE, C64_PALETTE, PLATFORMS } from '../js/core/platforms.js';

function nesColors(n) {
  return NES_PALETTE.slice(0, n).map(c => [...c, 255]);
}

function colors(n) {
  return Array.from({ length: n }, (_, i) => [i, i, i, 255]);
}

test('checkItemAgainstPlatform: "none" (or unknown) platform never warns', () => {
  assert.deepEqual(checkItemAgainstPlatform('none', { colors: colors(999), w: 999, h: 999 }), []);
  assert.deepEqual(checkItemAgainstPlatform('bogus', { colors: colors(999), w: 999, h: 999 }), []);
});

test('checkItemAgainstPlatform: compliant content has no warnings', () => {
  const warnings = checkItemAgainstPlatform('gba', { colors: colors(4), w: 16, h: 16 });
  assert.deepEqual(warnings, []);
});

test('checkItemAgainstPlatform: warns on exceeding maxColorsPerItem', () => {
  const warnings = checkItemAgainstPlatform('nes', { colors: nesColors(6), w: 8, h: 8 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Uses 6 colors/);
  assert.match(warnings[0], /at most 4/);
});

test('checkItemAgainstPlatform: NES flags colors not in the real PPU master palette', () => {
  const realNesColor = [...NES_PALETTE[5], 255]; // a4e4fc, actually in the palette
  const fakeColor = [1, 2, 3, 255]; // not a real NES color
  const warnings = checkItemAgainstPlatform('nes', { colors: [realNesColor, fakeColor], w: 8, h: 8 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /1 color\(s\) aren't in the NES palette/);
});

test('checkItemAgainstPlatform: C64 flags colors not in its fixed 16-color palette', () => {
  const realC64Color = [...C64_PALETTE[2], 255]; // 880000
  const warnings = checkItemAgainstPlatform('c64', { colors: [realC64Color, [9, 9, 9, 255]], w: 8, h: 8 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Commodore 64 palette/);
});

test('checkItemAgainstPlatform: GBA/SNES have no fixed palette, only a color-count cap', () => {
  const warnings = checkItemAgainstPlatform('gba', { colors: [[1, 2, 3, 255]], w: 8, h: 8 });
  assert.deepEqual(warnings, []);
});

test('checkItemAgainstPlatform: warns when a single item exceeds the platform\'s typical single-sprite tile budget', () => {
  const warnings = checkItemAgainstPlatform('gba', { colors: colors(2), w: 72, h: 8 }); // 9 tiles wide, 1 tall = 9 > ok actually need >64
  assert.deepEqual(warnings, []); // 9 tiles, well within 64 -- sanity check the boundary doesn't false-positive
  const big = checkItemAgainstPlatform('gba', { colors: colors(2), w: 8 * 65, h: 8 }); // 65 tiles > 64
  assert.equal(big.length, 1);
  assert.match(big[0], /larger than a typical single Game Boy Advance sprite/);
});

test('checkItemAgainstPlatform: multiple issues all reported together', () => {
  const warnings = checkItemAgainstPlatform('nes', { colors: [...colors(10), [1, 1, 1, 255]], w: 8 * 20, h: 8 });
  assert.equal(warnings.length, 3); // color count, palette membership, tile budget
});

test('PLATFORMS: gba/snes cap matches c99Export.js/platformExport.js MAX_COLORS.gba4/snes4 (16); nes matches MAX_COLORS.nes2 (4)', () => {
  assert.equal(PLATFORMS.gba.maxColorsPerItem, 16);
  assert.equal(PLATFORMS.snes.maxColorsPerItem, 16);
  assert.equal(PLATFORMS.nes.maxColorsPerItem, 4);
});
