/**
 * 3MF import.
 *
 * The strongest test available here is a round trip through our own writer:
 * lib/export/threeMF.ts already emits the exact structures the reader has to
 * understand — build transforms, assembly components, and the support wrapper
 * the Core spec forces — so writer → reader → equivalent document exercises
 * all of them against a producer we can also read the source of.
 */

import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildThreeMf, matrixToThreeMfTransform, type ThreeMfPart } from "@/lib/export/threeMF";
import { createZip } from "@/lib/export/zip";
import { parseThreeMf, ThreeMfImportError } from "../threeMF";
import { readZip, ZipReadError } from "../zipRead";

/** Axis-aligned box as an indexed triangle mesh. */
function box(
  sx: number,
  sy: number,
  sz: number,
  origin: [number, number, number] = [0, 0, 0]
): { vertices: Float32Array; triangles: Uint32Array } {
  const [ox, oy, oz] = origin;
  const vertices = new Float32Array([
    ox, oy, oz,
    ox + sx, oy, oz,
    ox + sx, oy + sy, oz,
    ox, oy + sy, oz,
    ox, oy, oz + sz,
    ox + sx, oy, oz + sz,
    ox + sx, oy + sy, oz + sz,
    ox, oy + sy, oz + sz,
  ]);
  const triangles = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom
    4, 5, 6, 4, 6, 7, // top
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ]);
  return { vertices, triangles };
}

async function roundTrip(parts: ThreeMfPart[]) {
  const blob = buildThreeMf(parts, "בדיקה");
  return parseThreeMf(await blob.arrayBuffer());
}

/** Size of a body's bounding box, from its rebased mesh. */
function size(positions: Float32Array): [number, number, number] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

describe("3MF round trip through our own writer", () => {
  it("recovers a single part's geometry, name and colour", async () => {
    const { vertices, triangles } = box(10, 20, 30);
    const result = await roundTrip([
      { name: "קופסה", colorHex: "#3366cc", materialName: "PLA כחול", vertices, triangles },
    ]);
    expect(result.objects.length).toBe(1);
    const object = result.objects[0];
    expect(object.name).toBe("קופסה");
    expect(object.colorHex).toBe("#3366cc");
    expect(object.materialName).toBe("PLA כחול");
    expect(object.role).toBe("model");
    expect(object.mesh.indices).toEqual(triangles);
    expect(size(object.mesh.positions)).toEqual([10, 20, 30]);
  });

  it("places a multi-object build by its build transforms", async () => {
    const a = box(10, 10, 10);
    const b = box(4, 4, 4);
    const result = await roundTrip([
      {
        id: "a",
        name: "A",
        colorHex: "#111111",
        materialName: "A",
        ...a,
        buildTransform: matrixToThreeMfTransform([
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 50, 0, 0, 1,
        ]),
      },
      {
        id: "b",
        name: "B",
        colorHex: "#222222",
        materialName: "B",
        ...b,
        buildTransform: matrixToThreeMfTransform([
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -20, 7, 0, 1,
        ]),
      },
    ]);
    expect(result.objects.length).toBe(2);
    const byName = new Map(result.objects.map((o) => [o.name, o]));
    // Positions are the rebased offsets: box centre in XY, base in Z.
    expect(byName.get("A")!.position.x).toBeCloseTo(55, 4);
    expect(byName.get("A")!.position.y).toBeCloseTo(5, 4);
    expect(byName.get("A")!.position.z).toBeCloseTo(0, 4);
    expect(byName.get("B")!.position.x).toBeCloseTo(-18, 4);
    expect(byName.get("B")!.position.y).toBeCloseTo(9, 4);
    expect(size(byName.get("B")!.mesh.positions)).toEqual([4, 4, 4]);
  });

  it("reads a support through its spec-mandated wrapper, as ONE body", async () => {
    // The Core spec forbids a build item referencing a type="support" object,
    // so the writer wraps it in a model object with a single component. That
    // wrapper is packaging: it must not arrive as a second part.
    const result = await roundTrip([
      { name: "גוף", colorHex: "#888888", materialName: "M", ...box(10, 10, 10) },
      {
        name: "תמיכה",
        colorHex: "#cccccc",
        materialName: "S",
        role: "support",
        ...box(2, 2, 8),
      },
    ]);
    expect(result.objects.length).toBe(2);
    const support = result.objects.find((o) => o.name === "תמיכה");
    expect(support).toBeDefined();
    expect(support!.role).toBe("support");
    expect(size(support!.mesh.positions)).toEqual([2, 2, 8]);
  });

  it("flattens an assembly into one body per mesh, each where it was placed", async () => {
    const result = await roundTrip([
      { id: "p", name: "אב", colorHex: "#111111", materialName: "M", ...box(10, 10, 10) },
      {
        id: "c",
        name: "בן",
        colorHex: "#222222",
        materialName: "M",
        parentId: "p",
        relativeTransform: matrixToThreeMfTransform([
          1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 25, 1,
        ]),
        ...box(4, 4, 4),
      },
    ]);
    // Parent mesh + child mesh — the assembly object itself is not a body.
    expect(result.objects.length).toBe(2);
    const child = result.objects.find((o) => o.name === "בן")!;
    expect(child.position.z).toBeCloseTo(25, 4);
    expect(size(child.mesh.positions)).toEqual([4, 4, 4]);
  });
});

describe("3MF import refuses hostile and malformed input", () => {
  const encoder = new TextEncoder();
  const pack = async (modelXml: string): Promise<ArrayBuffer> =>
    createZip([
      {
        name: "3D/3dmodel.model",
        data: encoder.encode(modelXml),
      },
    ]).arrayBuffer();

  const MODEL_OPEN =
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">';

  it("refuses a DOCTYPE — no entity expansion is even reachable", async () => {
    const billionLaughs =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]>' +
      `${MODEL_OPEN}<resources/><build/></model>`;
    await expect(parseThreeMf(await pack(billionLaughs))).rejects.toBeInstanceOf(
      ThreeMfImportError
    );
    await expect(parseThreeMf(await pack(billionLaughs))).rejects.toThrow(/DOCTYPE|ישויות/);
  });

  it("refuses an undeclared named entity", async () => {
    const xml = `${MODEL_OPEN}<resources><object id="1" name="&evil;"/></resources></model>`;
    await expect(parseThreeMf(await pack(xml))).rejects.toThrow(/ישויות/);
  });

  it("refuses a circular component hierarchy instead of hanging", async () => {
    const xml =
      `${MODEL_OPEN}<resources>` +
      '<object id="1"><components><component objectid="2"/></components></object>' +
      '<object id="2"><components><component objectid="1"/></components></object>' +
      '</resources><build><item objectid="1"/></build></model>';
    await expect(parseThreeMf(await pack(xml))).rejects.toThrow(/מעגלית/);
  });

  it("refuses a triangle pointing outside the vertex list", async () => {
    const xml =
      `${MODEL_OPEN}<resources><object id="1"><mesh>` +
      '<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>' +
      '<vertex x="0" y="1" z="0"/></vertices>' +
      '<triangles><triangle v1="0" v2="1" v3="99"/></triangles>' +
      "</mesh></object></resources><build><item objectid=\"1\"/></build></model>";
    await expect(parseThreeMf(await pack(xml))).rejects.toThrow(/קודקוד שאינו קיים/);
  });

  it("refuses a file that is not a ZIP at all, with a Hebrew message", async () => {
    const notAZip = encoder.encode("this is not a 3mf file, it is a note").buffer;
    const error = await parseThreeMf(notAZip as ArrayBuffer).catch((e) => e);
    expect(error).toBeInstanceOf(ThreeMfImportError);
    expect((error as ThreeMfImportError).messageHe).toMatch(/[֐-׿]/);
  });

  it("refuses a package with no model part", async () => {
    const empty = await createZip([
      { name: "readme.txt", data: encoder.encode("hello") },
    ]).arrayBuffer();
    await expect(parseThreeMf(empty)).rejects.toThrow(/חלק מודל/);
  });
});

describe("3MF from a DEFLATED package", () => {
  /**
   * Our own writer is STORE-only, so the round-trip tests above never touch
   * the inflate path — and every other tool that writes a 3MF deflates it.
   * This builds one the way the rest of the world does.
   */
  function deflatedZip(name: string, data: Uint8Array): ArrayBuffer {
    const compressed = new Uint8Array(deflateRawSync(data));
    const nameBytes = new TextEncoder().encode(name);
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;

    const total = 30 + nameBytes.length + compressed.length + 46 + nameBytes.length + 22;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 8, true); // method: DEFLATE
    view.setUint32(14, crc, true);
    view.setUint32(18, compressed.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    let offset = 30;
    out.set(nameBytes, offset);
    offset += nameBytes.length;
    out.set(compressed, offset);
    offset += compressed.length;

    const central = offset;
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 10, 8, true);
    view.setUint32(offset + 16, crc, true);
    view.setUint32(offset + 20, compressed.length, true);
    view.setUint32(offset + 24, data.length, true);
    view.setUint16(offset + 28, nameBytes.length, true);
    out.set(nameBytes, offset + 46);
    offset += 46 + nameBytes.length;

    view.setUint32(offset, 0x06054b50, true);
    view.setUint16(offset + 8, 1, true);
    view.setUint16(offset + 10, 1, true);
    view.setUint32(offset + 12, offset - central, true);
    view.setUint32(offset + 16, central, true);
    return out.buffer;
  }

  it("inflates a deflated model part", async () => {
    const blob = buildThreeMf(
      [{ name: "דחוס", colorHex: "#123456", materialName: "M", ...box(6, 7, 8) }],
      "z"
    );
    // Pull the model XML back out of our STORE package, then re-pack it
    // deflated so only the inflate path can produce it.
    const stored = await parseThreeMf(await blob.arrayBuffer());
    expect(stored.objects.length).toBe(1);

    const xml =
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
      '<resources><object id="1" name="דחוס"><mesh><vertices>' +
      '<vertex x="0" y="0" z="0"/><vertex x="6" y="0" z="0"/>' +
      '<vertex x="0" y="7" z="0"/><vertex x="0" y="0" z="8"/>' +
      "</vertices><triangles>" +
      '<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>' +
      '<triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/>' +
      "</triangles></mesh></object></resources>" +
      '<build><item objectid="1"/></build></model>';
    const packed = deflatedZip("3D/3dmodel.model", new TextEncoder().encode(xml));
    const result = await parseThreeMf(packed);
    expect(result.objects[0].name).toBe("דחוס");
    expect(size(result.objects[0].mesh.positions)).toEqual([6, 7, 8]);
  });

  it("refuses a package that expands far beyond the limit", async () => {
    // 64 MB of zeros compresses to a few kilobytes: the classic shape of a
    // zip bomb, and the reason the reader counts output bytes as they arrive
    // rather than trusting the size the archive declares.
    const huge = new Uint8Array(64 * 1024 * 1024);
    const packed = deflatedZip("3D/3dmodel.model", huge);
    await expect(
      readZip(packed, { maxEntries: 8, maxTotalBytes: 1024 * 1024 })
    ).rejects.toBeInstanceOf(ZipReadError);
  });
});

describe("3MF units", () => {
  it("converts a non-millimetre file and keeps the geometry honest", async () => {
    const encoder = new TextEncoder();
    const xml =
      '<model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
      '<resources><object id="1" name="cm"><mesh><vertices>' +
      '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>' +
      '<vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>' +
      "</vertices><triangles>" +
      '<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>' +
      '<triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/>' +
      "</triangles></mesh></object></resources>" +
      '<build><item objectid="1"/></build></model>';
    const buffer = await createZip([
      { name: "3D/3dmodel.model", data: encoder.encode(xml) },
    ]).arrayBuffer();
    const result = await parseThreeMf(buffer);
    expect(result.unitScale).toBe(10);
    expect(size(result.objects[0].mesh.positions)).toEqual([10, 10, 10]);
  });
});
