/**
 * Hostile-input regression tests for the mesh-file importers.
 *
 * Every case here is a defect that a security review actually found in the
 * first version of this code, reduced to the smallest input that demonstrates
 * it. They are grouped by the CLAIM each one falsified, because the claims are
 * what the module headers promise and what a reader is entitled to rely on.
 *
 * Sizes are kept small on purpose: the originals used 40 MB payloads to make
 * the numbers dramatic, but a regression test only needs to cross the limit it
 * is testing, so the limits are lowered per-call instead.
 */

import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseObj, ObjImportError, OBJ_LIMITS } from "../obj";
import { parseThreeMf, ThreeMfImportError, THREE_MF_LIMITS } from "../threeMF";
import { parseXmlLite, XmlLiteError } from "../xmlLite";
import { readZip, ZipReadError } from "../zipRead";

// ---------------------------------------------------------------------------
// A ZIP writer that lies, which is the only kind worth testing against
// ---------------------------------------------------------------------------

interface HostileEntry {
  name: string;
  /** 0 = STORE, 8 = DEFLATE. */
  method: number;
  payload: Uint8Array;
  /** What the archive CLAIMS the entry expands to. */
  declaredUncompressed: number;
}

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

/**
 * Build a ZIP. When `aliasOneLocalEntry` is set, every central-directory
 * record points at the SAME local header — legal enough to parse, and the
 * trick that makes a few kilobytes on disk ask for the same payload N times.
 */
function hostileZip(entries: HostileEntry[], aliasOneLocalEntry = false): ArrayBuffer {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const localOffsets: number[] = [];
  let offset = 0;

  const emitLocal = (entry: HostileEntry): number => {
    const nameBytes = encoder.encode(entry.name);
    const head = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(head.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, entry.method, true);
    view.setUint32(14, crc32(entry.payload), true);
    view.setUint32(18, entry.payload.length, true);
    view.setUint32(22, entry.declaredUncompressed, true);
    view.setUint16(26, nameBytes.length, true);
    head.set(nameBytes, 30);
    const at = offset;
    chunks.push(head, entry.payload);
    offset += head.length + entry.payload.length;
    return at;
  };

  if (aliasOneLocalEntry) {
    const shared = emitLocal(entries[0]);
    for (let i = 0; i < entries.length; i++) localOffsets.push(shared);
  } else {
    for (const entry of entries) localOffsets.push(emitLocal(entry));
  }

  const directoryStart = offset;
  entries.forEach((entry, i) => {
    const nameBytes = encoder.encode(entry.name);
    const record = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(6, 20, true);
    view.setUint16(10, entry.method, true);
    view.setUint32(16, crc32(entry.payload), true);
    view.setUint32(20, entry.payload.length, true);
    view.setUint32(24, entry.declaredUncompressed, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint32(42, localOffsets[i], true);
    record.set(nameBytes, 46);
    chunks.push(record);
    offset += record.length;
  });
  const directorySize = offset - directoryStart;

  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, directoryStart, true);
  chunks.push(eocd);
  offset += 22;

  const out = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out.buffer;
}

/** Wrap a model part in a real 3MF package. */
function threeMfPackage(modelXml: string): ArrayBuffer {
  const raw = new TextEncoder().encode(modelXml);
  return hostileZip([
    {
      name: "3D/3dmodel.model",
      method: 8,
      payload: new Uint8Array(deflateRawSync(Buffer.from(raw))),
      declaredUncompressed: raw.length,
    },
  ]);
}

/** A mesh object with `n` vertices and `n` triangles. */
function meshObject(id: string, n: number, extra = ""): string {
  const vertices: string[] = [];
  const triangles: string[] = [];
  for (let i = 0; i < n; i++) {
    vertices.push(`<vertex x="${i % 10}" y="${(i * 3) % 10}" z="${i % 7}"/>`);
  }
  for (let i = 0; i < n; i++) {
    triangles.push(`<triangle v1="${i}" v2="${(i + 1) % n}" v3="${(i + 2) % n}"/>`);
  }
  return (
    `<object id="${id}" type="model" name="leaf"${extra}><mesh>` +
    `<vertices>${vertices.join("")}</vertices>` +
    `<triangles>${triangles.join("")}</triangles>` +
    `</mesh></object>`
  );
}

// ---------------------------------------------------------------------------
// "The ZIP reader counts output bytes as they arrive rather than trusting the
//  size the archive declares."
// ---------------------------------------------------------------------------

describe("zipRead spends its budget on real bytes, not declared ones", () => {
  it("refuses an archive whose entries all declare uncompressedSize = 0", async () => {
    // The original defect: the running total was the sum of DECLARED sizes, so
    // declaring 0 everywhere meant the total never moved and every entry was
    // handed the full budget. A 41 KB archive delivered 335 MB past a 256 MB
    // limit. The budget is lowered here so the same shape costs kilobytes.
    const perEntry = 512 * 1024;
    const payload = new Uint8Array(deflateRawSync(Buffer.alloc(perEntry)));
    const entries: HostileEntry[] = Array.from({ length: 8 }, (_, i) => ({
      name: `e${i}.bin`,
      method: 8,
      payload,
      declaredUncompressed: 0,
    }));
    const archive = hostileZip(entries, true);
    expect(archive.byteLength).toBeLessThan(64 * 1024);
    await expect(
      readZip(archive, { maxEntries: 512, maxTotalBytes: 1024 * 1024 })
    ).rejects.toBeInstanceOf(ZipReadError);
  });

  it("counts STORE entries too, even when they declare nothing", async () => {
    // Same lie, uncompressed: several central-directory records aliasing one
    // 256 KB local payload, declaring 0 each.
    const payload = new Uint8Array(256 * 1024);
    const entries: HostileEntry[] = Array.from({ length: 8 }, (_, i) => ({
      name: `s${i}.bin`,
      method: 0,
      payload,
      declaredUncompressed: 0,
    }));
    await expect(
      readZip(hostileZip(entries, true), { maxEntries: 512, maxTotalBytes: 1024 * 1024 })
    ).rejects.toBeInstanceOf(ZipReadError);
  });

  it("still reads an honest archive that fits", async () => {
    const raw = new TextEncoder().encode("hello");
    const entries = await readZip(
      hostileZip([
        { name: "a.txt", method: 0, payload: raw, declaredUncompressed: raw.length },
        {
          name: "b.txt",
          method: 8,
          payload: new Uint8Array(deflateRawSync(Buffer.from(raw))),
          declaredUncompressed: raw.length,
        },
      ])
    );
    expect(entries.size).toBe(2);
    expect(new TextDecoder().decode(entries.get("b.txt")!)).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// "No raw throw escapes to the UI" / "entity expansion is not reachable"
// ---------------------------------------------------------------------------

describe("xmlLite refuses bad characters instead of throwing raw errors", () => {
  it("turns out-of-range numeric references into a Hebrew error", () => {
    // These reached `String.fromCodePoint` and came back as an English
    // RangeError — "Invalid code point 1114112" — straight to the user.
    for (const ref of [
      "&#x110000;",
      "&#1114112;",
      "&#x7fffffff;",
      "&#99999999999999;",
      "&#xfffffffff;",
    ]) {
      let caught: unknown;
      try {
        parseXmlLite(`<model a="${ref}"/>`);
      } catch (error) {
        caught = error;
      }
      expect(caught, ref).toBeInstanceOf(XmlLiteError);
      expect((caught as XmlLiteError).messageHe).toMatch(/[֐-׿]/);
    }
  });

  it("refuses surrogates and control characters rather than carrying them", () => {
    // These are accepted by fromCodePoint but are not legal XML characters,
    // and they end up in layer and material names.
    for (const ref of ["&#xd800;", "&#xdfff;", "&#0;", "&#x1;", "&#xfffe;"]) {
      expect(() => parseXmlLite(`<model a="${ref}"/>`), ref).toThrow(XmlLiteError);
    }
  });

  it("still decodes the legal references", () => {
    const root = parseXmlLite(`<model a="&lt;&amp;&#x5d0;&#9;x"/>`);
    expect(root.attrs.a).toBe("<&א\tx");
  });

  it("scans attributes in linear time", () => {
    // The scan was a global regex whose name pattern backtracked at every
    // start position: 4x the input cost 14.5x the time, and a 200 KB tag body
    // blocked the main thread for 43 seconds.
    const time = (chars: number): number => {
      const document = `<model ${"a".repeat(chars)}></model>`;
      const started = process.hrtime.bigint();
      try {
        parseXmlLite(document);
      } catch {
        /* malformed on purpose; we are timing the scan */
      }
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    time(20_000); // warm up, so JIT compilation is not measured as growth
    const small = Math.max(time(50_000), 0.05);
    const large = time(200_000);
    // Quadratic would be ~16x for a 4x input. Allow generous slack for a
    // loaded CI machine while still failing on a return to backtracking.
    expect(large / small).toBeLessThan(8);
    expect(large).toBeLessThan(1000);
  });

  it("keeps refusing DTDs and unknown entities", () => {
    expect(() => parseXmlLite('<!DOCTYPE m [<!ENTITY x "y">]><m/>')).toThrow(XmlLiteError);
    expect(() => parseXmlLite('<m a="&evil;"/>')).toThrow(XmlLiteError);
  });

  it("does not let an attribute name reach an inherited property", () => {
    const root = parseXmlLite('<m id="7"/>');
    expect(root.attrs.id).toBe("7");
    // A plain object would answer this with Object; the record has no prototype.
    expect((root.attrs as Record<string, unknown>).constructor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// "Object, vertex, triangle, depth and expansion counts are all capped"
// ---------------------------------------------------------------------------

describe("3MF bounds the geometry it produces, not just the geometry it parses", () => {
  it("refuses a component DAG that multiplies one mesh past the cap", async () => {
    // No cycle, depth 2, inside the expansion budget: 140 x 140 placements of
    // a 300-triangle leaf. It produced 19,600 bodies and 5.9 million triangles
    // against a 1 million cap — 141 MB of mesh from a 2.8 KB file — because the
    // cap was spent at parse time, once per object, not per placement.
    const fan = 140;
    const objects = [meshObject("1", 300)];
    objects.push(
      `<object id="2" type="model"><components>${'<component objectid="1"/>'.repeat(fan)}</components></object>`
    );
    objects.push(
      `<object id="3" type="model"><components>${'<component objectid="2"/>'.repeat(fan)}</components></object>`
    );
    const model =
      '<?xml version="1.0"?><model unit="millimeter">' +
      `<resources>${objects.join("")}</resources>` +
      '<build><item objectid="3"/></build></model>';
    const archive = threeMfPackage(model);
    expect(archive.byteLength).toBeLessThan(16 * 1024);
    await expect(parseThreeMf(archive)).rejects.toBeInstanceOf(ThreeMfImportError);
  });

  it("counts object ELEMENTS, so duplicate ids cannot slip the cap", async () => {
    // Duplicate ids overwrote each other in the map, so `objects.size` stayed
    // at 1 while three thousand objects were parsed in full.
    const objects = Array.from({ length: 4 }, () => meshObject("1", 3)).join("");
    const model =
      '<?xml version="1.0"?><model unit="millimeter">' +
      `<resources>${objects}</resources>` +
      '<build><item objectid="1"/></build></model>';
    await expect(parseThreeMf(threeMfPackage(model))).rejects.toThrow(/יותר מפעם אחת/);
  });

  it("refuses more object elements than the cap allows", async () => {
    const objects = Array.from({ length: THREE_MF_LIMITS.maxObjects + 2 }, (_, i) =>
      meshObject(String(i + 1), 3)
    ).join("");
    const model =
      '<?xml version="1.0"?><model unit="millimeter">' +
      `<resources>${objects}</resources>` +
      '<build><item objectid="1"/></build></model>';
    await expect(parseThreeMf(threeMfPackage(model))).rejects.toThrow(/יותר מדי אובייקטים/);
  });
});

describe("3MF unit handling cannot be walked into the prototype chain", () => {
  it("treats an inherited property name as an unknown unit", async () => {
    // `UNIT_SCALE["constructor"]` answered with Object — a truthy function —
    // so the `?? 1` fallback never fired, the scale became a function, and
    // every coordinate came out NaN with no warning at all.
    for (const unit of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const model =
        `<?xml version="1.0"?><model unit="${unit}">` +
        `<resources>${meshObject("1", 4)}</resources>` +
        '<build><item objectid="1"/></build></model>';
      const result = await parseThreeMf(threeMfPackage(model));
      expect(typeof result.unitScale, unit).toBe("number");
      expect(result.unitScale, unit).toBe(1);
      expect(result.warningsHe.join(" "), unit).toMatch(/אינה מוכרת/);
      // The geometry is real numbers, which is the point of all of the above.
      for (const value of result.objects[0].mesh.positions) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(Number.isFinite(result.objects[0].position.x)).toBe(true);
    }
  });

  it("still converts the units it does know", async () => {
    const model =
      '<?xml version="1.0"?><model unit="centimeter">' +
      `<resources>${meshObject("1", 4)}</resources>` +
      '<build><item objectid="1"/></build></model>';
    const result = await parseThreeMf(threeMfPackage(model));
    expect(result.unitScale).toBe(10);
    expect(result.warningsHe.join(" ")).not.toMatch(/אינה מוכרת/);
  });
});

// ---------------------------------------------------------------------------
// "OBJ bounds vertices, triangles, face corners and file size"
// ---------------------------------------------------------------------------

describe("OBJ refuses pathological lines before allocating for them", () => {
  it("refuses an over-long line instead of splitting it first", () => {
    // `maxFaceCorners` was checked AFTER split() had materialised the array,
    // so one `f` line of five million tokens allocated tens of megabytes and
    // burned a second on the way to being refused.
    const line = "f " + "1 ".repeat(OBJ_LIMITS.maxLineChars);
    const text = "v 0 0 0\nv 1 0 0\nv 0 1 0\n" + line + "\n";
    const started = process.hrtime.bigint();
    expect(() => parseObj(text)).toThrow(ObjImportError);
    expect(() => parseObj(text)).toThrow(/ארוכה מדי/);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(2000);
  });

  it("does not materialise one array entry per line", () => {
    // A file of nothing but newlines cost 300 MB of heap through
    // `text.split(/\r?\n/)` before anything looked at a single line.
    const text = "\n".repeat(2_000_000);
    const started = process.hrtime.bigint();
    expect(() => parseObj(text)).toThrow(ObjImportError);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(2000);
  });

  it("still refuses a face with too many corners inside a legal line", () => {
    const corners = OBJ_LIMITS.maxFaceCorners + 5;
    const vertices = Array.from({ length: 3 }, (_, i) => `v ${i} ${i} 0`).join("\n");
    const face = "f " + Array.from({ length: corners }, () => "1").join(" ");
    expect(face.length).toBeLessThan(OBJ_LIMITS.maxLineChars);
    expect(() => parseObj(`${vertices}\n${face}\n`)).toThrow(/יותר מדי קודקודים/);
  });

  it("still parses a normal file across both line endings", () => {
    const crlf = "v 0 0 0\r\nv 10 0 0\r\nv 0 10 0\r\nv 0 0 10\r\nf 1 3 2\r\nf 1 2 4\r\nf 2 3 4\r\nf 3 1 4\r\n";
    expect(parseObj(crlf).triangleCount).toBe(4);
    // And with no trailing newline at all.
    expect(parseObj("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3").triangleCount).toBe(1);
  });
});
