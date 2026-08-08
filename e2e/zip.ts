/**
 * STORE-only ZIP writer for the mesh-import journey.
 *
 * A 3MF is a ZIP, so the suite cannot build one without this. Kept separate
 * from lib/export/zip.ts on purpose: a test that used the app's own writer
 * would pass just as happily if both writer and reader were wrong together.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(files: { name: string; text: string }[]): Buffer {
  const encoder = new TextEncoder();
  const entries = files.map((file) => ({
    nameBytes: encoder.encode(file.name),
    data: encoder.encode(file.text),
  }));
  const size =
    entries.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.data.length, 0) +
    entries.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0) +
    22;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let at = 0;

  for (const entry of entries) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint32(at + 14, crc32(entry.data), true);
    view.setUint32(at + 18, entry.data.length, true);
    view.setUint32(at + 22, entry.data.length, true);
    view.setUint16(at + 26, entry.nameBytes.length, true);
    out.set(entry.nameBytes, at + 30);
    out.set(entry.data, at + 30 + entry.nameBytes.length);
    at += 30 + entry.nameBytes.length + entry.data.length;
  }

  const central = at;
  entries.forEach((entry, i) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 6, 20, true);
    view.setUint32(at + 16, crc32(entry.data), true);
    view.setUint32(at + 20, entry.data.length, true);
    view.setUint32(at + 24, entry.data.length, true);
    view.setUint16(at + 28, entry.nameBytes.length, true);
    view.setUint32(at + 42, offsets[i], true);
    out.set(entry.nameBytes, at + 46);
    at += 46 + entry.nameBytes.length;
  });

  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - central, true);
  view.setUint32(at + 16, central, true);
  return Buffer.from(out);
}
