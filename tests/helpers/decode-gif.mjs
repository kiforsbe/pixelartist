import assert from 'node:assert/strict';

// Independent test consumer for the encoder's GIF89a global-table output.
// The decoder builds strings from numeric codes (not the encoder's map keys).
export function decodeGif(bytes) {
  const word = offset => bytes[offset] | bytes[offset + 1] << 8;
  assert.equal(new TextDecoder().decode(bytes.slice(0, 6)), 'GIF89a');
  const paletteSize = 1 << ((bytes[10] & 7) + 1);
  const palette = Array.from({ length: paletteSize }, (_, i) => [...bytes.slice(13 + i * 3, 16 + i * 3)]);
  let offset = 13 + paletteSize * 3, transparent = -1;
  const frames = [];
  function blocks() {
    const result = [];
    while (bytes[offset]) {
      const length = bytes[offset++];
      for (let i = 0; i < length; i++) result.push(bytes[offset++]);
    }
    offset++;
    return result;
  }
  while (bytes[offset] !== 0x3b) {
    assert.ok(offset < bytes.length, 'GIF must have a trailer');
    if (bytes[offset++] === 0x21) {
      const label = bytes[offset++];
      if (label === 0xf9) transparent = bytes[offset + 1] & 1 ? bytes[offset + 4] : -1;
      blocks(); continue;
    }
    assert.equal(bytes[offset - 1], 0x2c);
    const width = word(offset + 4), height = word(offset + 6);
    assert.equal(bytes[offset + 8], 0, 'test decoder expects no local table/interlace');
    offset += 9;
    const minimum = bytes[offset++], compressed = blocks();
    const clear = 1 << minimum, end = clear + 1;
    let table, codeSize, next, previous = null, bit = 0;
    const indices = [];
    function reset() {
      table = Array.from({ length: clear }, (_, i) => [i]);
      codeSize = minimum + 1; next = end + 1; previous = null;
    }
    reset();
    while (true) {
      assert.ok(bit + codeSize <= compressed.length * 8, 'missing end code');
      let code = 0;
      for (let i = 0; i < codeSize; i++, bit++) code |= (compressed[bit >> 3] >> (bit & 7) & 1) << i;
      if (code === clear) { reset(); continue; }
      if (code === end) break;
      const entry = table[code] ?? (code === next && previous ? [...previous, previous[0]] : null);
      assert.ok(entry, `invalid LZW code ${code}`);
      for (const value of entry) indices.push(value);
      if (previous && next < 4096) {
        table[next++] = [...previous, entry[0]];
        if (next === 1 << codeSize && codeSize < 12) codeSize++;
      }
      previous = entry;
    }
    assert.equal(indices.length, width * height);
    frames.push({ width, height, indices, transparent });
  }
  return { palette, frames };
}
