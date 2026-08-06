import { describe, expect, it } from "vitest";
import {
  createBaseLayer,
  createBlankState,
  createHoleLayer,
  createImageReliefLayer,
  createTextLayer,
} from "@/lib/design/defaults";
import type { DesignState } from "@/types/design";
import {
  buildPortableFile,
  parsePortableDesign,
  PortableImportError,
  serializePortable,
  validatePortableFile,
} from "../portable";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function sampleState(): DesignState {
  const state = createBlankState();
  state.doc.layers = [
    createBaseLayer({ id: "base_1" }),
    createTextLayer({ id: "text_1", content: "שלום", mode: "engraved", depthMm: 1.2 }),
    createHoleLayer({ id: "hole_1" }),
  ];
  state.doc.title = "בדיקה";
  return state;
}

describe("portable design export/import", () => {
  it("round-trips a design state", () => {
    const state = sampleState();
    const file = buildPortableFile({
      state,
      title: "בדיקה",
      assets: {},
      now: new Date("2026-08-06T10:00:00Z"),
    });
    const json = serializePortable(file);
    const parsed = parsePortableDesign(json);

    expect(parsed.title).toBe("בדיקה");
    expect(parsed.state.doc.layers).toHaveLength(3);
    const [base, text, hole] = parsed.state.doc.layers;
    expect(base.type).toBe("base");
    expect(text.type).toBe("text");
    expect(text.type === "text" && text.content).toBe("שלום");
    expect(text.type === "text" && text.mode).toBe("engraved");
    expect(hole.type).toBe("hole");
    expect(parsed.state.settings.multiColor.slots).toHaveLength(4);
  });

  it("round-trips image layers with assets", () => {
    const state = createBlankState();
    state.doc.layers = [
      createBaseLayer({ id: "b" }),
      createImageReliefLayer({ id: "img_1", assetId: "asset_1" }),
    ];
    const file = buildPortableFile({
      state,
      title: "",
      assets: { asset_1: { dataUrl: TINY_PNG, width: 1, height: 1 } },
    });
    const parsed = parsePortableDesign(serializePortable(file));
    expect(parsed.assets.asset_1.dataUrl).toBe(TINY_PNG);
  });

  it("rejects non-JSON input", () => {
    expect(() => parsePortableDesign("not json {")).toThrow(PortableImportError);
  });

  it("rejects unknown formats and versions", () => {
    expect(() => parsePortableDesign(JSON.stringify({ format: "other" }))).toThrow(
      PortableImportError
    );
    expect(() =>
      parsePortableDesign(
        JSON.stringify({ format: "formadesign", formatVersion: 999, doc: { layers: [{}] } })
      )
    ).toThrow(/גרסת/);
  });

  it("rejects documents without a base layer first", () => {
    const json = JSON.stringify({
      format: "formadesign",
      formatVersion: 1,
      doc: { layers: [{ type: "text", content: "x" }] },
    });
    expect(() => parsePortableDesign(json)).toThrow(/בסיס/);
  });

  it("rejects unknown layer types", () => {
    const json = JSON.stringify({
      format: "formadesign",
      formatVersion: 1,
      doc: { layers: [{ type: "base" }, { type: "evil" }] },
    });
    expect(() => parsePortableDesign(json)).toThrow(PortableImportError);
  });

  it("rejects duplicate base layers and duplicate ids", () => {
    const dupBase = JSON.stringify({
      format: "formadesign",
      formatVersion: 1,
      doc: { layers: [{ type: "base", id: "a" }, { type: "base", id: "b" }] },
    });
    expect(() => parsePortableDesign(dupBase)).toThrow(/בסיס/);

    const dupIds = JSON.stringify({
      format: "formadesign",
      formatVersion: 1,
      doc: { layers: [{ type: "base", id: "a" }, { type: "text", id: "a" }] },
    });
    expect(() => parsePortableDesign(dupIds)).toThrow(/כפולים/);
  });

  it("rejects image layers whose asset is missing", () => {
    const json = JSON.stringify({
      format: "formadesign",
      formatVersion: 1,
      doc: {
        layers: [
          { type: "base", id: "b" },
          { type: "imageRelief", id: "i", assetId: "missing" },
        ],
      },
      assets: {},
    });
    expect(() => parsePortableDesign(json)).toThrow(/נתוני תמונה/);
  });

  it("ignores malformed assets and clamps out-of-range numbers", () => {
    const state = sampleState();
    const file = buildPortableFile({ state, title: "", assets: {} });
    const raw = JSON.parse(serializePortable(file)) as Record<string, unknown>;
    const doc = raw.doc as { layers: Record<string, unknown>[] };
    doc.layers[1].sizeMm = 99999; // way out of range
    doc.layers[1].colorHex = "javascript:alert(1)";
    raw.assets = { "bad id!": { dataUrl: "javascript:evil" } };

    const parsed = parsePortableDesign(JSON.stringify(raw));
    const text = parsed.state.doc.layers[1];
    expect(text.type === "text" && text.sizeMm).toBeLessThanOrEqual(200);
    expect(text.colorHex).toMatch(/^#[0-9a-f]{6}$/);
    expect(Object.keys(parsed.assets)).toHaveLength(0);
  });

  it("validates file facts before reading", () => {
    expect(validatePortableFile({ name: "a.formadesign.json", size: 100 })).toBeNull();
    expect(validatePortableFile({ name: "a.stl", size: 100 })).toMatch(/סיומת/);
    expect(validatePortableFile({ name: "a.json", size: 0 })).toMatch(/ריק/);
    expect(validatePortableFile({ name: "a.json", size: 999_999_999 })).toMatch(/גדול/);
  });
});
