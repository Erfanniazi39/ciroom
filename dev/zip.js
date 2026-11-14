// Small in-process zip reader (no zip64). Replaces the external `unzip`, which Windows lacks
// and which reads "[" "]" in names as a pattern. Sizes come from the central directory, so
// entries written with data descriptors work too.
import zlib from "node:zlib";

const MAX_ENTRY = 16 << 20; // refuse anything that inflates beyond this (zip bombs)

/** @param {Buffer} buf @returns {{ name: string, method: number, csize: number, size: number, offset: number }[]} */
export function listZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Broken zip directory");
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    out.push({ name, method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** @param {Buffer} buf @param {{ name: string, method: number, csize: number, size: number, offset: number }} e @returns {Buffer} */
export function readZipEntry(buf, e) {
  if (e.size > MAX_ENTRY) throw new Error("Zip entry too large");
  const o = e.offset;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new Error("Broken zip entry");
  const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
  throw new Error("Unsupported zip compression");
}
