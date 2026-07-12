const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(data, stream) {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const deflate = d => pipe(d, new CompressionStream('deflate-raw'));
const inflate = d => pipe(d, new DecompressionStream('deflate-raw'));

class ByteWriter {
  constructor() { this.chunks = []; this.length = 0; }
  bytes(u8) { this.chunks.push(u8); this.length += u8.length; }
  u16(v) { this.bytes(new Uint8Array([v & 255, (v >>> 8) & 255])); }
  u32(v) { this.bytes(new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255])); }
  concat() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

export async function zipWrite(entries) {
  const w = new ByteWriter();
  const central = [];
  for (const { path, data } of entries) {
    const name = new TextEncoder().encode(path);
    const crc = crc32(data);
    const comp = await deflate(data);
    const offset = w.length;
    w.u32(0x04034b50); w.u16(20); w.u16(0); w.u16(8); w.u16(0); w.u16(0);
    w.u32(crc); w.u32(comp.length); w.u32(data.length);
    w.u16(name.length); w.u16(0);
    w.bytes(name); w.bytes(comp);
    central.push({ name, crc, compSize: comp.length, size: data.length, offset });
  }
  const cdStart = w.length;
  for (const e of central) {
    w.u32(0x02014b50); w.u16(20); w.u16(20); w.u16(0); w.u16(8); w.u16(0); w.u16(0);
    w.u32(e.crc); w.u32(e.compSize); w.u32(e.size);
    w.u16(e.name.length); w.u16(0); w.u16(0); w.u16(0); w.u16(0); w.u32(0); w.u32(e.offset);
    w.bytes(e.name);
  }
  const cdSize = w.length - cdStart;
  w.u32(0x06054b50); w.u16(0); w.u16(0);
  w.u16(central.length); w.u16(central.length);
  w.u32(cdSize); w.u32(cdStart); w.u16(0);
  return w.concat();
}

export async function zipRead(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // find EOCD (scan back over optional comment)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--)
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file (no end record)');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const path = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // local header: skip its own name/extra lengths
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = new Uint8Array(comp);
    else if (method === 8) data = await inflate(comp);
    else throw new Error(`unsupported compression method ${method}`);
    out.push({ path, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
