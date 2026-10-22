/**
 * zlib inflation for the compressed region of an HSF stream.
 *
 * HSF marks compression in-stream: a `Z` opcode, then a zlib stream, and
 * whatever the stream writes after the zlib trailer (in practice a single
 * termination byte). The platform's `DecompressionStream` refuses trailing
 * bytes after the end of a zlib stream, and does not say where the stream
 * ended — so the tail is trimmed a byte at a time until it inflates cleanly.
 * Real files need one retry; the cap on attempts keeps a corrupt file from
 * costing more than a handful of passes.
 */

import { EDrawingsError } from "./errors";

const MAX_TRAILING_BYTES = 8;

class TooLargeError extends Error {}

async function inflateOnce(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });
  const reader = (
    source.pipeThrough(new DecompressionStream("deflate")) as ReadableStream<Uint8Array>
  ).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError();
    }
    chunks.push(value);
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
 * Inflate the zlib stream at the start of `data`, tolerating up to a few
 * trailing bytes after it. Throws a Hebrew error when nothing inflates or the
 * output passes `maxBytes`.
 */
export async function inflateZlibPrefix(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  for (let trim = 0; trim <= MAX_TRAILING_BYTES && trim < data.length; trim++) {
    try {
      return await inflateOnce(data.subarray(0, data.length - trim), maxBytes);
    } catch (error) {
      if (error instanceof TooLargeError) {
        throw new EDrawingsError("תוכן המודל מתרחב לגודל בלתי סביר — ייתכן שהקובץ פגום או זדוני");
      }
      // Trailing bytes or corruption — try a shorter tail.
    }
  }
  throw new EDrawingsError("לא ניתן לפרוס את תוכן המודל הדחוס — ייתכן שהקובץ פגום");
}
