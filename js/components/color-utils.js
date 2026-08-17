// Pure RGB <-> hex color conversion helpers, shared by the color panel and
// the filter controller (and covered directly by tests/panels.test.mjs).

export function rgbaToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
