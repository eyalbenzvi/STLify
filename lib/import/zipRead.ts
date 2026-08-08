/**
 * Minimal ZIP reader for imported packages (3MF is a ZIP/OPC container).
 *
 * The counterpart to lib/export/zip.ts, and deliberately not symmetrical with
 * it: our WRITER is STORE-only because STL payloads barely compress, but a
 * reader has no such freedom — every other tool that writes a 3MF deflates it.
 * Both methods are therefore supported, with inflation done by the platform's
 * `DecompressionStream("deflate-raw")` rather than by adding a dependency.
 *
 * This is untrusted input. The limits below are the whole point of the file:
 * a ZIP declares its own sizes, so a few kilobytes on disk can claim — and, if
 * nobody is counting, deliver — gigabytes in memory.
 */

/** Import failure with a Hebrew user-facing message. */
export class ZipReadError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "ZipReadError";
  }
}

export interface ZipReadLimits {
  /** Entries in the archive. */
  maxEntries: number;
  /** Total bytes after decompression, across all entries. */
  maxTotalBytes: number;
}

export const ZIP_READ_LIMITS: ZipReadLimits = {
  maxEntries: 512,
  maxTotalBytes: 256 * 1024 * 1024,
};

const EOCD_SIG = 0x06054b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const LOCAL_HEADER_SIG = 0x04034b50;
/** The EOCD is last, but a trailing comment can push it up to 64 KB back. */
const EOCD_SEARCH_BYTES = 66 * 1024;
/** A 32-bit size field saturated at this value means the record is ZIP64. */
const ZIP64_MARKER = 0xffffffff;

/** Inflate a raw deflate stream, refusing to produce more than `maxBytes`. */
async function inflateRaw(
  data: Uint8Array<ArrayBuffer>,
  maxBytes: number
): Promise<Uint8Array> {
  if (data.length === 0) return new Uint8Array(0);
  // `DecompressionStream` is typed as accepting BufferSource, which does not
  // unify with ReadableStream<Uint8Array> in pipeThrough's signature; the
  // stream itself is happy with the bytes.
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const reader = (
    source.pipeThrough(new DecompressionStream("deflate-raw")) as ReadableStream<Uint8Array>
  ).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      // Checked per chunk, not against the declared size: the declared size
      // is written by whoever made the file and is not evidence of anything.
      if (total > maxBytes) {
        await reader.cancel();
        throw new ZipReadError("הקובץ מתרחב לגודל בלתי סביר בפתיחה — ייתכן שהוא פגום או זדוני");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ZipReadError) throw error;
    throw new ZipReadError("לא ניתן לפרוס את תוכן הקובץ — ייתכן שהוא פגום");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Read every file entry of a ZIP archive into memory, by name.
 *
 * Names are used only as map keys — nothing is written to disk — so path
 * traversal has nowhere to go; the risks that remain are size and count, and
 * those are what `limits` bounds.
 */
export async function readZip(
  buffer: ArrayBuffer,
  limits: ZipReadLimits = ZIP_READ_LIMITS
): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 22) {
    throw new ZipReadError("הקובץ קטן מכדי להיות ארכיון תקין");
  }

  // Locate the end-of-central-directory record.
  let eocd = -1;
  const searchStart = Math.max(0, bytes.length - EOCD_SEARCH_BYTES);
  for (let i = bytes.length - 22; i >= searchStart; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new ZipReadError("הקובץ אינו ארכיון ZIP תקין (חסר רשומת סיום)");
  }

  const entryCount = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (directoryOffset === ZIP64_MARKER || entryCount === 0xffff) {
    throw new ZipReadError("ארכיוני ZIP64 אינם נתמכים — שמרו את הקובץ מחדש בגודל קטן יותר");
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipReadError(`הארכיון מכיל יותר מדי קבצים (מקסימום ${limits.maxEntries})`);
  }
  if (directoryOffset >= bytes.length) {
    throw new ZipReadError("הארכיון פגום — מפתח התוכן מצביע מחוץ לקובץ");
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries = new Map<string, Uint8Array>();
  let cursor = directoryOffset;
  /** Bytes actually produced. The only number an attacker does not choose. */
  let actualBytes = 0;
  /** Bytes the archive CLAIMS. Useful only to refuse an honest file early. */
  let declaredBytes = 0;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL_HEADER_SIG) {
      throw new ZipReadError("הארכיון פגום — רשומת קובץ אינה תקינה");
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
      throw new ZipReadError("ארכיוני ZIP64 אינם נתמכים — שמרו את הקובץ מחדש בגודל קטן יותר");
    }
    if (name.endsWith("/")) continue; // directory entry, no payload

    // A cheap early refusal for an honest file that is simply too big. It is
    // NOT the budget: `uncompressedSize` is a number the archive chose, and an
    // archive that declares 0 for every entry would sail past any check built
    // on it. The budget below counts what we actually produce.
    declaredBytes += uncompressedSize;
    if (declaredBytes > limits.maxTotalBytes) {
      throw new ZipReadError("תוכן הארכיון גדול מדי — ייתכן שהקובץ פגום או זדוני");
    }

    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_HEADER_SIG) {
      throw new ZipReadError("הארכיון פגום — כותרת קובץ חסרה");
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.length) {
      throw new ZipReadError("הארכיון פגום — תוכן קובץ חורג מגבולות הארכיון");
    }
    const payload = bytes.subarray(dataStart, dataStart + compressedSize);

    // The real budget, spent against what actually comes out. Note that
    // several central-directory records may point at ONE local header, so an
    // archive of a few kilobytes can ask for the same payload many times —
    // counting per entry is not enough, it has to be counted across them.
    const remaining = limits.maxTotalBytes - actualBytes;
    let data: Uint8Array;
    if (method === 0) {
      if (compressedSize > remaining) {
        throw new ZipReadError("תוכן הארכיון גדול מדי — ייתכן שהקובץ פגום או זדוני");
      }
      data = payload.slice();
    } else if (method === 8) {
      data = await inflateRaw(payload, remaining);
    } else {
      throw new ZipReadError(`שיטת דחיסה לא נתמכת בארכיון (${method})`);
    }
    actualBytes += data.length;
    entries.set(name, data);
  }

  return entries;
}
