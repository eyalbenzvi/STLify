/**
 * Minimal ZIP writer for multi-part model packages (e.g. several STL files
 * in one download). Deliberately dependency-free and STORE-only:
 * - STL payloads are binary float data that barely compresses, so DEFLATE
 *   would add code and CPU for negligible size savings.
 * - With STORE the CRC and sizes are known before writing, so no data
 *   descriptors are needed and the layout is a simple single pass.
 * - Timestamps are fixed to a constant valid DOS date (1980-01-01) so the
 *   same inputs always produce byte-identical archives (determinism helps
 *   testing and caching).
 * - General-purpose flag bit 11 marks names as UTF-8, so Hebrew filenames
 *   survive every mainstream unzip tool.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** ZIP version 2.0 — enough for STORE entries. */
const VERSION_NEEDED = 20;
/** General-purpose flag: bit 11 = file name is UTF-8. */
const FLAG_UTF8 = 0x0800;
/** Fixed DOS timestamp: time 00:00:00, date 1980-01-01 (0x0021). */
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

// ---------------------------------------------------------------------------
// CRC-32 (standard reflected polynomial 0xEDB88320), table-based.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a ZIP archive (STORE, no compression) from the given entries. */
export function createZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => ({
    nameBytes: encoder.encode(entry.name),
    data: entry.data,
    crc: crc32(entry.data),
    localHeaderOffset: 0,
  }));

  const localHeadersSize = prepared.reduce(
    (sum, e) => sum + 30 + e.nameBytes.length + e.data.length,
    0
  );
  const centralDirectorySize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const totalSize = localHeadersSize + centralDirectorySize + 22;

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let offset = 0;

  // Local file headers + payloads.
  for (const entry of prepared) {
    entry.localHeaderOffset = offset;
    view.setUint32(offset, LOCAL_HEADER_SIG, true);
    view.setUint16(offset + 4, VERSION_NEEDED, true);
    view.setUint16(offset + 6, FLAG_UTF8, true);
    view.setUint16(offset + 8, 0, true); // method: STORE
    view.setUint16(offset + 10, DOS_TIME, true);
    view.setUint16(offset + 12, DOS_DATE, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true); // compressed size
    view.setUint32(offset + 22, entry.data.length, true); // uncompressed size
    view.setUint16(offset + 26, entry.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true); // extra field length
    offset += 30;
    out.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
    out.set(entry.data, offset);
    offset += entry.data.length;
  }

  // Central directory.
  const centralDirectoryOffset = offset;
  for (const entry of prepared) {
    view.setUint32(offset, CENTRAL_HEADER_SIG, true);
    view.setUint16(offset + 4, VERSION_NEEDED, true); // version made by
    view.setUint16(offset + 6, VERSION_NEEDED, true); // version needed
    view.setUint16(offset + 8, FLAG_UTF8, true);
    view.setUint16(offset + 10, 0, true); // method: STORE
    view.setUint16(offset + 12, DOS_TIME, true);
    view.setUint16(offset + 14, DOS_DATE, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true); // extra field length
    view.setUint16(offset + 32, 0, true); // comment length
    view.setUint16(offset + 34, 0, true); // disk number start
    view.setUint16(offset + 36, 0, true); // internal attributes
    view.setUint32(offset + 38, 0, true); // external attributes
    view.setUint32(offset + 42, entry.localHeaderOffset, true);
    offset += 46;
    out.set(entry.nameBytes, offset);
    offset += entry.nameBytes.length;
  }

  // End of central directory record.
  view.setUint32(offset, EOCD_SIG, true);
  view.setUint16(offset + 4, 0, true); // this disk
  view.setUint16(offset + 6, 0, true); // disk with central directory
  view.setUint16(offset + 8, prepared.length, true); // entries on this disk
  view.setUint16(offset + 10, prepared.length, true); // total entries
  view.setUint32(offset + 12, offset - centralDirectoryOffset, true);
  view.setUint32(offset + 16, centralDirectoryOffset, true);
  view.setUint16(offset + 20, 0, true); // comment length

  return new Blob([out], { type: "application/zip" });
}
