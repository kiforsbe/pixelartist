import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkItemAgainstPlatform, snapPaletteToHardware, NES_PALETTE, C64_PALETTE, GB_PALETTE, PLATFORMS } from '../js/core/platforms.js';

function nesColors(n) {
  return NES_PALETTE.slice(0, n).map(c => [...c, 255]);
}

function gbColors(n) {
  return GB_PALETTE.slice(0, n).map(c => [...c, 255]);
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
  const warnings = checkItemAgainstPlatform('c64', { colors: [realC64Color, [9, 9, 9, 255]], w: 24, h: 21 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Commodore 64 palette/);
});

test('checkItemAgainstPlatform: GBA/SNES have no fixed palette, only a color-count cap', () => {
  const warnings = checkItemAgainstPlatform('gba', { colors: [[1, 2, 3, 255]], w: 8, h: 8 });
  assert.deepEqual(warnings, []);
});

test('checkItemAgainstPlatform: retro8/16/32 have no fixed palette either -- just a color-count cap, unlike the real NES/C64/GB they\'re "reminiscent of"', () => {
  assert.equal(PLATFORMS.retro8.palette, null);
  assert.equal(PLATFORMS.retro16.palette, null);
  assert.equal(PLATFORMS.retro32.palette, null);
  assert.deepEqual(checkItemAgainstPlatform('retro8', { colors: [[1, 2, 3, 255], [4, 5, 6, 255]], w: 16, h: 16 }), []);
});

test('checkItemAgainstPlatform: warns when a single item exceeds the retro tier\'s typical single-sprite tile budget', () => {
  const warnings = checkItemAgainstPlatform('retro16', { colors: colors(2), w: 72, h: 8 }); // 9 tiles wide, 1 tall
  assert.deepEqual(warnings, []); // 9 tiles, well within 64 -- sanity check the boundary doesn't false-positive
  const big = checkItemAgainstPlatform('retro16', { colors: colors(2), w: 8 * 65, h: 8 }); // 65 tiles > 64
  assert.equal(big.length, 1);
  assert.match(big[0], /larger than a typical single Retro 16-bit sprite/);
});

test('checkItemAgainstPlatform: multiple issues all reported together', () => {
  const warnings = checkItemAgainstPlatform('nes', { colors: [...colors(10), [1, 1, 1, 255]], w: 8 * 20, h: 8 });
  assert.equal(warnings.length, 3); // color count, palette membership, sprite size
});

test('PLATFORMS: gba/snes cap matches c99Export.js/platformExport.js MAX_COLORS.gba4/snes4 (16); nes matches MAX_COLORS.nes2 (4)', () => {
  assert.equal(PLATFORMS.gba.maxColorsPerItem, 16);
  assert.equal(PLATFORMS.snes.maxColorsPerItem, 16);
  assert.equal(PLATFORMS.nes.maxColorsPerItem, 4);
});

test('checkItemAgainstPlatform: GBA sprite must be one of the 12 native OBJ sizes', () => {
  assert.deepEqual(checkItemAgainstPlatform('gba', { colors: colors(2), w: 32, h: 16 }), []); // valid "wide" OBJ size
  const warnings = checkItemAgainstPlatform('gba', { colors: colors(2), w: 24, h: 24 }); // not a real OBJ size
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /24x24 isn't a native Game Boy Advance sprite size/);
  assert.match(warnings[0], /8x8, 16x16, 32x32, 64x64/);
});

test('checkItemAgainstPlatform: GBA/NES/SNES background tiles must be exactly 8x8', () => {
  assert.deepEqual(checkItemAgainstPlatform('gba', { colors: colors(2), w: 8, h: 8, kind: 'tile' }), []);
  const warnings = checkItemAgainstPlatform('snes', { colors: colors(2), w: 16, h: 16, kind: 'tile' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /16x16 isn't a native SNES background tile size \(valid sizes: 8x8\)/);
});

test('checkItemAgainstPlatform: NES sprite is 8x8 or 8x16 only', () => {
  assert.deepEqual(checkItemAgainstPlatform('nes', { colors: nesColors(2), w: 8, h: 16 }), []);
  const warnings = checkItemAgainstPlatform('nes', { colors: nesColors(2), w: 16, h: 16 });
  assert.match(warnings[0], /16x16 isn't a native NES sprite size \(valid sizes: 8x8, 8x16\)/);
});

test('checkItemAgainstPlatform: C64 sprite must match one of the 4 expand combinations, not any 8-multiple', () => {
  assert.deepEqual(checkItemAgainstPlatform('c64', { colors: [[...C64_PALETTE[0], 255]], w: 48, h: 42 }), []);
  const warnings = checkItemAgainstPlatform('c64', { colors: [[...C64_PALETTE[0], 255]], w: 16, h: 16 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /16x16 isn't a native Commodore 64 sprite size/);
});

test('checkItemAgainstPlatform: C64 character-mode tile must be 8x8', () => {
  const warnings = checkItemAgainstPlatform('c64', { colors: [[...C64_PALETTE[0], 255]], w: 24, h: 21, kind: 'tile' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /24x21 isn't a native Commodore 64 background tile size \(valid sizes: 8x8\)/);
});

test('checkItemAgainstPlatform: retro tiers (no validSizes) fall back to the multiple-of-8 tile-alignment check', () => {
  assert.deepEqual(checkItemAgainstPlatform('retro8', { colors: colors(2), w: 16, h: 16 }), []);
  const warnings = checkItemAgainstPlatform('retro32', { colors: colors(2), w: 20, h: 16 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /20x16 isn't a multiple of 8x8/);
});

test('checkItemAgainstPlatform: generic platform has no size constraint at all', () => {
  assert.deepEqual(checkItemAgainstPlatform('generic', { colors: colors(2), w: 13, h: 7 }), []);
});

test('checkItemAgainstPlatform: Game Boy flags colors not in its fixed 4-shade palette', () => {
  const realShade = [...GB_PALETTE[1], 255];
  const warnings = checkItemAgainstPlatform('gb', { colors: [realShade, [9, 9, 9, 255]], w: 8, h: 8 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /1 color\(s\) aren't in the Game Boy palette/);
});

test('checkItemAgainstPlatform: Game Boy Color has no fixed palette, only a color-count cap', () => {
  assert.deepEqual(checkItemAgainstPlatform('gbc', { colors: [[1, 2, 3, 255]], w: 8, h: 8 }), []);
});

test('checkItemAgainstPlatform: Game Boy/Game Boy Color sprite is 8x8 or 8x16 only, background tile always 8x8', () => {
  assert.deepEqual(checkItemAgainstPlatform('gb', { colors: gbColors(2), w: 8, h: 16 }), []);
  const warnings = checkItemAgainstPlatform('gbc', { colors: [[1, 2, 3, 255]], w: 16, h: 16 });
  assert.match(warnings[0], /16x16 isn't a native Game Boy Color sprite size \(valid sizes: 8x8, 8x16\)/);
  const tileWarnings = checkItemAgainstPlatform('gb', { colors: gbColors(2), w: 16, h: 8, kind: 'tile' });
  assert.match(tileWarnings[0], /16x8 isn't a native Game Boy background tile size \(valid sizes: 8x8\)/);
});

test('PLATFORMS: gb/gbc cap matches c99Export.js MAX_COLORS.gb2/gbc2 (4); c64 matches MAX_COLORS.c64mc (4)', () => {
  assert.equal(PLATFORMS.gb.maxColorsPerItem, 4);
  assert.equal(PLATFORMS.gbc.maxColorsPerItem, 4);
  assert.equal(PLATFORMS.c64.maxColorsPerItem, 4);
});

test('snapPaletteToHardware: each color maps to its nearest real hardware match', () => {
  const realBlack = NES_PALETTE.find(c => c[0] === 0 && c[1] === 0 && c[2] === 0);
  const realNearWhite = NES_PALETTE.find(c => c[0] === 236 && c[1] === 236 && c[2] === 236);
  const snapped = snapPaletteToHardware([[3, 3, 3], [250, 250, 253]], NES_PALETTE);
  assert.deepEqual(snapped, [realBlack, realNearWhite]);
});

test('snapPaletteToHardware: two source colors landing on the same hardware match collapse to one entry', () => {
  const realBlack = NES_PALETTE.find(c => c[0] === 0 && c[1] === 0 && c[2] === 0);
  const snapped = snapPaletteToHardware([[1, 1, 1], [2, 2, 2]], NES_PALETTE);
  assert.deepEqual(snapped, [realBlack]);
});

test('snapPaletteToHardware: exact hardware colors round-trip unchanged, in first-occurrence order', () => {
  const snapped = snapPaletteToHardware([C64_PALETTE[5], C64_PALETTE[1]], C64_PALETTE);
  assert.deepEqual(snapped, [C64_PALETTE[5], C64_PALETTE[1]]);
});
