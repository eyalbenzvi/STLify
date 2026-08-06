/**
 * ZIP writer tests: structural validity of the archive (signatures, entry
 * counts, verbatim STORE payloads) and CRC-32 correctness.
 */

import { describe, expect, it } from "vitest";
import { createZip } from "../zip";

async function zipBytes(entries: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const blob = createZip(entries);
  return new Uint8Array(await blob.arrayBuffer());
}

function findSignature(bytes: Uint8Array, sig: number): number[] {
  const found: number[] = [];
  for (let i = 0; i + 4 <= bytes.length; i++) {
    const value =
      bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | ((bytes[i + 3] << 24) >>> 0);
    if ((value >>> 0) === sig) found.push(i);
  }
  return found;
}

describe("createZip", () => {
  it("writes a structurally valid two-entry archive", async () => {
    const hello = new TextEncoder().encode("hello");
    const world = new TextEncoder().encode("world data");
    const bytes = await zipBytes([
      { name: "a.txt", data: hello },
      { name: "תיקיה/ב.stl", data: world },
    ]);

    // Local header at offset 0.
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // Exactly two local headers and two central records.
    expect(findSignature(bytes, 0x04034b50).length).toBe(2);
    expect(findSignature(bytes, 0x02014b50).length).toBe(2);
    const eocd = findSignature(bytes, 0x06054b50);
    expect(eocd.length).toBe(1);
    // Entry count in EOCD.
    expect(view.getUint16(eocd[0] + 10, true)).toBe(2);

    // STORE: payload bytes appear verbatim.
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.includes("hello")).toBe(true);
    expect(text.includes("world data")).toBe(true);
  });

  it("computes the standard CRC-32", async () => {
    const bytes = await zipBytes([
      { name: "h", data: new TextEncoder().encode("hello") },
    ]);
    const view = new DataView(bytes.buffer);
    // CRC field of the first local header ("hello" → 0x3610A686).
    expect(view.getUint32(14, true)).toBe(0x3610a686);
  });

  it("handles empty archives", async () => {
    const bytes = await zipBytes([]);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x06054b50);
    expect(view.getUint16(10, true)).toBe(0);
  });
});
