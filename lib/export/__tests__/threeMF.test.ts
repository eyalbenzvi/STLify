/**
 * 3MF writer tests (ported from the V2 branch; the fflate unzip check is
 * replaced by a direct STORE-archive walk since our ZIP writer never
 * compresses).
 */

import { describe, expect, it } from "vitest";
import { buildModelXml, buildThreeMf, matrixToThreeMfTransform, type ThreeMfPart } from "../threeMF";

/** A unit cube as indexed mesh arrays (12 triangles). */
function cubePart(name: string, colorHex: string): ThreeMfPart {
  const vertices = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, // bottom
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, // top
  ]);
  const triangles = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom
    4, 5, 6, 4, 6, 7, // top
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ]);
  return { name, colorHex, materialName: "PLA", vertices, triangles };
}

/** Walk a STORE-only ZIP's local headers into a name → text map. */
function readStoreZip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, string>();
  let offset = 0;
  const decoder = new TextDecoder();
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const dataStart = offset + 30 + nameLength + extraLength;
    files.set(name, decoder.decode(bytes.subarray(dataStart, dataStart + compressedSize)));
    offset = dataStart + compressedSize;
  }
  return files;
}

describe("3MF export", () => {
  it("produces a valid OPC package with the required parts", async () => {
    const blob = buildThreeMf([cubePart("בסיס", "#2f6feb")], "בדיקה");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const files = readStoreZip(bytes);
    expect([...files.keys()].sort()).toEqual([
      "3D/3dmodel.model",
      "[Content_Types].xml",
      "_rels/.rels",
    ]);
    expect(files.get("[Content_Types].xml")).toContain("3dmanufacturing-3dmodel+xml");
    expect(files.get("_rels/.rels")).toContain("/3D/3dmodel.model");
    expect(files.get("3D/3dmodel.model")).toContain('unit="millimeter"');
  });

  it("writes millimetre units, per-part colours and correct mesh counts", () => {
    const xml = buildModelXml(
      [cubePart("base", "#2f6feb"), cubePart("text", "#f5f5f5")],
      "my design"
    );
    expect(xml).toContain('unit="millimeter"');
    expect(xml).toContain('displaycolor="#2F6FEBFF"');
    expect(xml).toContain('displaycolor="#F5F5F5FF"');
    expect((xml.match(/<object /g) ?? []).length).toBe(2);
    expect((xml.match(/<vertex /g) ?? []).length).toBe(16);
    expect((xml.match(/<triangle /g) ?? []).length).toBe(24);
    expect((xml.match(/<item /g) ?? []).length).toBe(2);
    // Objects reference their own material group.
    expect(xml).toContain('pid="1" pindex="0"');
    expect(xml).toContain('pid="3" pindex="0"');
  });

  it("escapes XML-sensitive names", () => {
    const part = cubePart('a<b>&"c', "#000000");
    const xml = buildModelXml([part], 'T<&>"');
    expect(xml).not.toMatch(/name="a<b/);
    expect(xml).toContain("a&lt;b&gt;&amp;&quot;c");
  });

  it("rejects empty part lists", () => {
    expect(() => buildThreeMf([], "x")).toThrow();
  });
});

describe("3MF support marking (V6 item 10)", () => {
  it("marks support parts distinct from model parts", () => {
    const model = cubePart("גוף", "#2f6feb");
    const support = { ...cubePart("תמיכות", "#8a8f98"), role: "support" as const };
    const xml = buildModelXml([model, support], "בדיקה");

    // The model part keeps type="model"; the support part is typed as such.
    expect(xml).toContain('<object id="2" type="model" name="גוף"');
    expect(xml).toContain('<object id="4" type="support" name="תמיכות"');

    // The Core spec forbids build items referencing a support object
    // directly — it must arrive through a components wrapper of type model.
    expect(xml).not.toContain('<item objectid="4"/>');
    expect(xml).toContain('<component objectid="4"/>');
    const wrapperMatch = xml.match(
      /<object id="(\d+)" type="model" name="תמיכות">\s*<components>\s*<component objectid="4"\/>/
    );
    expect(wrapperMatch).not.toBeNull();
    expect(xml).toContain(`<item objectid="${wrapperMatch![1]}"/>`);
  });

  it("emits no wrapper and no support types when all parts are models", () => {
    const xml = buildModelXml([cubePart("א", "#2f6feb"), cubePart("ב", "#8a8f98")], "בדיקה");
    expect(xml).not.toContain('type="support"');
    expect(xml).not.toContain("<components>");
    expect(xml).toContain('<item objectid="2"/>');
    expect(xml).toContain('<item objectid="4"/>');
  });
});

describe("3MF production structure (V6 item 13)", () => {
  it("assigns STABLE object ids from part identity, not input order", () => {
    const a = { ...cubePart("א", "#ff0000"), id: "part_layer_a" };
    const b = { ...cubePart("ב", "#00ff00"), id: "part_layer_b" };

    const xmlAB = buildModelXml([a, b], "בדיקה");
    const xmlBA = buildModelXml([b, a], "בדיקה");

    // Same design, different input order → the SAME object gets the same id.
    const idOf = (xml: string, name: string) => {
      const match = xml.match(new RegExp(`<object id="(\\d+)" type="model" name="${name}"`));
      return match?.[1];
    };
    expect(idOf(xmlAB, "א")).toBeDefined();
    expect(idOf(xmlAB, "א")).toBe(idOf(xmlBA, "א"));
    expect(idOf(xmlAB, "ב")).toBe(idOf(xmlBA, "ב"));
  });

  it("places parts via build transforms instead of world-baked geometry", () => {
    const part = {
      ...cubePart("גוף", "#2f6feb"),
      id: "part_1",
      buildTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 25, -10, 3],
    };
    const xml = buildModelXml([part], "בדיקה");
    expect(xml).toContain('transform="1 0 0 0 1 0 0 0 1 25 -10 3"');
    // The geometry itself stays local (the unit cube's own coordinates).
    expect(xml).toContain('<vertex x="0" y="0" z="0"/>');
  });

  it("preserves the layer hierarchy as assembly components", () => {
    const parent = { ...cubePart("הורה", "#2f6feb"), id: "part_parent" };
    const child = {
      ...cubePart("ילד", "#00ff00"),
      id: "part_child",
      parentId: "part_parent",
      relativeTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 12],
    };
    const xml = buildModelXml([parent, child], "בדיקה");

    // The parent grows an assembly object whose components are its own mesh
    // and the child at its relative placement.
    const parentMeshId = xml.match(/<object id="(\d+)" type="model" name="הורה" pid/)?.[1];
    const childMeshId = xml.match(/<object id="(\d+)" type="model" name="ילד" pid/)?.[1];
    expect(parentMeshId).toBeDefined();
    expect(childMeshId).toBeDefined();
    const assembly = xml.match(
      /<object id="(\d+)" type="model" name="הורה">\s*<components>([\s\S]*?)<\/components>/
    );
    expect(assembly).not.toBeNull();
    expect(assembly![2]).toContain(`<component objectid="${parentMeshId}"/>`);
    expect(assembly![2]).toContain(
      `<component objectid="${childMeshId}" transform="1 0 0 0 1 0 0 0 1 0 0 12"/>`
    );

    // The build references ONLY the assembly — the child is not flattened
    // into a loose sibling.
    expect(xml).toContain(`<item objectid="${assembly![1]}"/>`);
    expect(xml).not.toContain(`<item objectid="${childMeshId}"`);
  });

  it("converts a column-major matrix to the 3MF row layout", () => {
    // translate(5,6,7) in column-major THREE layout.
    const elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1];
    expect(matrixToThreeMfTransform(elements)).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7,
    ]);
  });
});
