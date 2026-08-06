import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildModelXml, buildThreeMf, type ThreeMfPart } from "../threeMF";

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

describe("3MF export", () => {
  it("produces a valid OPC package with the required parts", async () => {
    const blob = buildThreeMf([cubePart("בסיס", "#2f6feb")], "בדיקה");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual([
      "3D/3dmodel.model",
      "[Content_Types].xml",
      "_rels/.rels",
    ]);
    const contentTypes = strFromU8(files["[Content_Types].xml"]);
    expect(contentTypes).toContain("3dmanufacturing-3dmodel+xml");
    const rels = strFromU8(files["_rels/.rels"]);
    expect(rels).toContain("/3D/3dmodel.model");
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
