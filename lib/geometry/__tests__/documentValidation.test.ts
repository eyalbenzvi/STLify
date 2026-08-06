/**
 * Document-validation tests — the V2 parameter checks (base ranges, text
 * size/depth, engrave floor, hole margins) ported to the layer model, plus
 * V3 checks (baseless thickness, bevel, transforms) and the pure helpers.
 */

import { describe, expect, it } from "vitest";
import { createTemplateDocument, emptyDocument, makeBaseLayer, makeHoleLayer, makeTextLayer } from "../documentTemplates";
import { validateDocument } from "../documentValidation";
import { clampNumber, hasVisibleText, maxCornerRadius, parseNumericInput } from "../validation";

function codes(docLike: ReturnType<typeof createTemplateDocument>): string[] {
  return validateDocument(docLike).issues.map((i) => i.code);
}

describe("numeric helpers (V2 regression)", () => {
  it("clampNumber clamps and falls back on non-finite", () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
    expect(clampNumber(-1, 0, 10)).toBe(0);
    expect(clampNumber(11, 0, 10)).toBe(10);
    expect(clampNumber(Number.NaN, 0, 10, 7)).toBe(7);
  });

  it("parseNumericInput handles commas, blanks and junk", () => {
    expect(parseNumericInput("3,5")).toBe(3.5);
    expect(parseNumericInput(" 42 ")).toBe(42);
    expect(parseNumericInput("")).toBeNull();
    expect(parseNumericInput("abc")).toBeNull();
  });

  it("maxCornerRadius stays inside the rectangle", () => {
    expect(maxCornerRadius(100, 40)).toBeCloseTo(19.99);
    expect(maxCornerRadius(0, 0)).toBe(0);
  });

  it("hasVisibleText", () => {
    expect(hasVisibleText("  ")).toBe(false);
    expect(hasVisibleText("א")).toBe(true);
  });
});

describe("validateDocument", () => {
  it("accepts every template preset", () => {
    for (const id of ["namePlate", "keychain", "logoPlaque", "reliefTile", "baseless"]) {
      const result = validateDocument(createTemplateDocument(id));
      expect(result.ok).toBe(true);
    }
  });

  it("blocks out-of-range base dimensions", () => {
    const doc = createTemplateDocument("namePlate");
    const base = doc.layers.find((l) => l.type === "base");
    if (base?.type === "base") {
      base.widthMm = 5;
      base.thicknessMm = 500;
    }
    const issueCodes = codes(doc);
    expect(issueCodes).toContain("base/width-range");
    expect(issueCodes).toContain("base/thickness-range");
    expect(validateDocument(doc).ok).toBe(false);
  });

  it("warns on thin base and shallow relief", () => {
    const doc = createTemplateDocument("namePlate");
    for (const layer of doc.layers) {
      if (layer.type === "base") layer.thicknessMm = 1; // range-min but < minWall? 1 > 0.8 → adjust
    }
    const doc2 = createTemplateDocument("namePlate");
    for (const layer of doc2.layers) {
      if (layer.type === "text") layer.extrudeMm = 0.3;
    }
    expect(codes(doc2)).toContain("layer/shallow-relief");
  });

  it("warns when engraving pierces the base", () => {
    const doc = createTemplateDocument("reliefTile");
    for (const layer of doc.layers) {
      if (layer.type === "text") layer.extrudeMm = 10; // base is 5mm
    }
    expect(codes(doc)).toContain("layer/engrave-through");
  });

  it("warns on a low engrave floor", () => {
    const doc = createTemplateDocument("reliefTile");
    for (const layer of doc.layers) {
      if (layer.type === "text") layer.extrudeMm = 4.7; // 0.3mm floor
    }
    expect(codes(doc)).toContain("layer/engrave-floor");
  });

  it("blocks too-long text and warns on empty text", () => {
    const doc = createTemplateDocument("namePlate");
    for (const layer of doc.layers) {
      if (layer.type === "text") layer.content = "א".repeat(200);
    }
    expect(codes(doc)).toContain("text/too-long");

    const doc2 = createTemplateDocument("namePlate");
    for (const layer of doc2.layers) {
      if (layer.type === "text") layer.content = "   ";
    }
    expect(codes(doc2)).toContain("text/empty");
    expect(validateDocument(doc2).ok).toBe(true); // warning only
  });

  it("checks hole wall thickness against an axis-aligned base", () => {
    const doc = emptyDocument();
    doc.baseMode = "withBase";
    doc.layers = [
      makeBaseLayer({ widthMm: 60, heightMm: 30 }),
      makeHoleLayer({
        diameterMm: 6,
        transform: {
          x: 29, y: 0, z: 0,
          rotationX: 0, rotationY: 0, rotationZ: 0,
          scaleX: 1, scaleY: 1, scaleZ: 1,
        },
      }),
    ];
    // wall = 30 - 29 - 3 = -2 → overflow
    expect(codes(doc)).toContain("hole/overflow");
  });

  it("blocks zero scale and non-finite transforms", () => {
    const doc = emptyDocument();
    doc.layers = [
      makeTextLayer({
        transform: {
          x: 0, y: 0, z: 0,
          rotationX: 0, rotationY: 0, rotationZ: 0,
          scaleX: 0, scaleY: 1, scaleZ: 1,
        },
      }),
    ];
    expect(codes(doc)).toContain("layer/scale-zero");
    expect(validateDocument(doc).ok).toBe(false);
  });

  it("warns on thin standalone bodies in baseless mode", () => {
    const doc = emptyDocument();
    doc.layers = [makeTextLayer({ extrudeMm: 0.4, combine: "standalone" })];
    expect(codes(doc)).toContain("layer/thin-standalone");
  });

  it("warns when withBase mode has no base layer", () => {
    const doc = emptyDocument();
    doc.baseMode = "withBase";
    doc.layers = [makeTextLayer({})];
    expect(codes(doc)).toContain("document/no-base");
  });
});
