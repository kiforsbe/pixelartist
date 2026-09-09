import { parseHexColors, createPalette, setEntry } from './palettes.js';

function dedupe(colors) {
  const seen = new Set(), out = [];
  for (const c of colors) { const k = c.join(','); if (!seen.has(k)) { seen.add(k); out.push(c); } }
  return out;
}

// EGA: 64 colors, 2 bits per channel: bit0 = low intensity (0x55), bit1 = high (0xAA)
function egaColors() {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const ch = (hi, lo) => (hi ? 0xAA : 0) + (lo ? 0x55 : 0);
    out.push([ch(i & 4, i & 32), ch(i & 2, i & 16), ch(i & 1, i & 8), 255]);
  }
  return out;
}

const HEX = {
  'Game Boy': '0f380f 306230 8bac0f 9bbc0f',
  'PICO-8': '000000 1d2b53 7e2553 008751 ab5236 5f574f c2c3c7 fff1e8 ff004d ffa300 ffec27 00e436 29adff 83769c ff77a8 ffccaa',
  'Commodore 64': '000000 ffffff 880000 aaffee cc44cc 00cc55 0000aa eeee77 dd8855 664400 ff7777 333333 777777 aaff66 0088ff bbbbbb',
  'CGA': '000000 0000aa 00aa00 00aaaa aa0000 aa00aa aa5500 aaaaaa 555555 5555ff 55ff55 55ffff ff5555 ff55ff ffff55 ffffff',
  'ZX Spectrum': '000000 0000d7 d70000 d700d7 00d700 00d7d7 d7d700 d7d7d7 0000ff ff0000 ff00ff 00ff00 00ffff ffff00 ffffff',
  'MSX': '000000 3eb849 74d07d 5955e0 8076f1 b95e51 65dbef db6559 ff897d ccc35e ded087 3aa241 b766b5 cccccc ffffff',
  'Apple II': '000000 6c2940 403578 d93cf0 135740 808080 2697f0 bfb4f8 404b07 d9680f 808081 f9a8bf 2fb81f b9d060 6fe8bf ffffff',
  'Sega Master System': '000000 555500 aa0000 ffff00 000055 555555 aa00aa ffff55 005500 55aa00 aa5500 ffaa55 0000aa 5555aa aaaaaa ffffff',
  'Atari 2600': '000000 404040 6c6c6c 909090 b0b0b0 c8c8c8 dcdcdc f4f4f4 444400 646410 848424 a0a034 b8b840 d0d050 e8e85c fcfc68',
  'Commodore Amiga (16)': '000000 ffffff 68372b 70a4b2 6f3d86 588d43 352879 b8c76f 6f4f25 433900 9a6759 444444 6c6c6c 9ad284 6c5eb5 959595',
  'TIC-80': '1a1c2c 5d275d b13e53 ef7d57 ffcd75 a7f070 38b764 257179 29366f 3b5dc9 41a6f6 73eff7 f4f4f4 94b0c2 566c86 333c57',
  'Amstrad CPC': '000000 000080 0000ff 800000 800080 8000ff ff0000 ff0080 ff00ff 008000 008080 0080ff 808000 808080 8080ff ff8000',
  'Windows 3.1 (VGA 16)': '000000 800000 008000 808000 000080 800080 008080 c0c0c0 808080 ff0000 00ff00 ffff00 0000ff ff00ff 00ffff ffffff',
  'NES': '545454 001e74 081090 300088 440064 5c0030 540400 3c1800 202a00 083a00 004000 003c00 00323c 989698 084cc4 3032ec 5c1ee4 8814b0 a01464 982220 783c00 545a00 287200 087c00 007628 006678 ececec 4c9aec 787cec b062ec e454ec ec58b4 ec6a64 d48820 a0aa00 74c400 4cd020 38cc6c 38b4cc 3c3c3c a8ccec bcbcec d4b2ec ecaeec ecaed4 ecb4b0 e4c490 ccd278 b4de78 a8e290 98e2b4 a0d6e4 a0a2a0 000000',
};

export const SYSTEM_PALETTES = [
  ...Object.entries(HEX).map(([name, hex]) => ({ name, colors: dedupe(parseHexColors(hex)) })),
  { name: 'EGA (64)', colors: egaColors() },
];

export function clonePalette(sys) {
  const p = createPalette({ name: sys.name, indexed: true, size: sys.colors.length, lockReason: sys.name });
  sys.colors.forEach((c, i) => setEntry(p, i, c));
  return p;
}
