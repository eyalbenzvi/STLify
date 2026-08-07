/**
 * Tests for the features ported from the V2 branch: arc/mirrored/spaced
 * text, inlay combine mode, circle + rimmed bases, the new product
 * templates, and the detailed estimation heuristics.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { installNodeFontFetch } from "../nodeFontFetch";
import { buildDocument } from "../buildDocument";
import {
  createTemplateDocument,
  emptyDocument,
  makeBaseLayer,
  makeTextLayer,
  PRODUCT_TEMPLATES,
} from "../documentTemplates";
import { validateDocument } from "../documentValidation";
import {
  estimateDetailed,
  formatMinutesHe,
} from "../analysis/estimateDetailed";
import type { DesignDocument } from "@/types/design";

beforeAll(installNodeFontFetch);

async function buildOk(document: DesignDocument) {
  const result = await buildDocument(document);
  expect(result.status).toBe("ok");
  for (const part of result.parts) {
    expect(part.stats.watertight).toBe(true);
  }
  return result;
}

describe("text features from V2", () => {
  it("letter spacing widens the text block", async () => {
    const tight = emptyDocument();
    tight.layers = [makeTextLayer({ content: "אבג", extrudeMm: 3 })];
    const spaced = emptyDocument();
    spaced.layers = [makeTextLayer({ content: "אבג", extrudeMm: 3, letterSpacingMm: 4 })];
    const a = await buildOk(tight);
    const b = await buildOk(spaced);
    expect(b.parts[0].stats.dimensionsMm.x).toBeGreaterThan(
      a.parts[0].stats.dimensionsMm.x + 7
    );
  });

  it("mirrored text keeps volume and flips geometry", async () => {
    const plain = emptyDocument();
    plain.layers = [makeTextLayer({ content: "אב", extrudeMm: 3 })];
    const mirrored = emptyDocument();
    mirrored.layers = [makeTextLayer({ content: "אב", extrudeMm: 3, mirrored: true })];
    const a = await buildOk(plain);
    const b = await buildOk(mirrored);
    expect(b.parts[0].stats.volumeMm3).toBeCloseTo(a.parts[0].stats.volumeMm3, 0);
  });

  it("arc text bends the line (taller, narrower bounding box)", async () => {
    const straight = emptyDocument();
    straight.layers = [makeTextLayer({ content: "אבגדהוז", sizeMm: 12, extrudeMm: 3 })];
    const curved = emptyDocument();
    curved.layers = [
      makeTextLayer({ content: "אבגדהוז", sizeMm: 12, extrudeMm: 3, curveRadiusMm: 30 }),
    ];
    const a = await buildOk(straight);
    const b = await buildOk(curved);
    // Bending pushes the line ends downward: the Y extent grows sharply
    // while the X extent stays in the same ballpark (glyph rotation may
    // extend it slightly, so only a loose upper bound is asserted).
    expect(b.parts[0].stats.dimensionsMm.y).toBeGreaterThan(
      a.parts[0].stats.dimensionsMm.y * 1.4
    );
    expect(b.parts[0].stats.dimensionsMm.x).toBeLessThan(
      a.parts[0].stats.dimensionsMm.x * 1.15
    );
  });

  it("validation flags out-of-range curve radius and letter spacing", () => {
    const doc = emptyDocument();
    doc.layers = [makeTextLayer({ curveRadiusMm: 5, letterSpacingMm: 50 })];
    const codes = validateDocument(doc).issues.map((i) => i.code);
    expect(codes).toContain("text/curve-radius-range");
    expect(codes).toContain("text/letter-spacing-range");
  });
});

describe("inlay combine mode", () => {
  it("creates a pocketed base plus a separate flush inlay part", async () => {
    const doc = emptyDocument();
    doc.baseMode = "withBase";
    const base = makeBaseLayer({ widthMm: 80, heightMm: 40, thicknessMm: 4 });
    const inlay = makeTextLayer({
      content: "אב",
      sizeMm: 20,
      extrudeMm: 2,
      combine: "inlay",
      materialSlotId: "slot3",
    });
    doc.layers = [base, inlay];
    const result = await buildOk(doc);
    expect(result.parts.length).toBe(2);

    const basePart = result.parts.find((p) => p.primaryLayerId === base.id)!;
    const inlayPart = result.parts.find((p) => p.primaryLayerId === inlay.id)!;
    // The base lost pocket volume relative to a plain plate.
    const plain = emptyDocument();
    plain.baseMode = "withBase";
    plain.layers = [makeBaseLayer({ widthMm: 80, heightMm: 40, thicknessMm: 4 })];
    const plainResult = await buildOk(plain);
    expect(basePart.stats.volumeMm3).toBeLessThan(plainResult.parts[0].stats.volumeMm3);
    // The inlay sits flush: its top equals the base top (z = 4).
    expect(inlayPart.stats.bounds.max.z).toBeCloseTo(4, 1);
    expect(inlayPart.stats.bounds.min.z).toBeCloseTo(2, 1);
    // Separate material slot preserved for multi-colour export.
    expect(inlayPart.materialSlotId).toBe("slot3");
    // Pocket is larger than the inlay (clearance) — inlay volume < pocket volume.
    const pocketVolume = plainResult.parts[0].stats.volumeMm3 - basePart.stats.volumeMm3;
    expect(pocketVolume).toBeGreaterThan(inlayPart.stats.volumeMm3);
  });
});

describe("circle and rimmed bases", () => {
  it("builds a circular base with the requested diameter", async () => {
    const doc = emptyDocument();
    doc.baseMode = "withBase";
    doc.layers = [
      makeBaseLayer({ shape: "circle", widthMm: 70, heightMm: 70, thicknessMm: 4 }),
    ];
    const result = await buildOk(doc);
    expect(result.parts[0].stats.dimensionsMm.x).toBeCloseTo(70, 0);
    expect(result.parts[0].stats.dimensionsMm.y).toBeCloseTo(70, 0);
    // Circle area ≈ π r² vs the 70×70 square.
    expect(result.parts[0].stats.volumeMm3).toBeLessThan(70 * 70 * 4);
    expect(result.parts[0].stats.volumeMm3).toBeGreaterThan(Math.PI * 35 * 35 * 4 * 0.95);
  });

  it("rim raises the border without changing the footprint", async () => {
    const flat = emptyDocument();
    flat.baseMode = "withBase";
    flat.layers = [makeBaseLayer({ widthMm: 60, heightMm: 60, thicknessMm: 4 })];
    const rimmed = emptyDocument();
    rimmed.baseMode = "withBase";
    rimmed.layers = [
      makeBaseLayer({
        widthMm: 60,
        heightMm: 60,
        thicknessMm: 4,
        rimEnabled: true,
        rimWidthMm: 3,
        rimHeightMm: 2,
      }),
    ];
    const a = await buildOk(flat);
    const b = await buildOk(rimmed);
    expect(b.parts[0].stats.dimensionsMm.z).toBeCloseTo(6, 1);
    expect(b.parts[0].stats.dimensionsMm.x).toBeCloseTo(60, 1);
    expect(b.parts[0].stats.volumeMm3).toBeGreaterThan(a.parts[0].stats.volumeMm3);
  });
});

describe("new product templates", () => {
  it("every template builds watertight and passes validation", async () => {
    const newIds = ["medal", "nameTag", "fridgeMagnet", "stamp", "coaster", "wallPlaque", "blank"];
    for (const id of newIds) {
      expect(PRODUCT_TEMPLATES.some((t) => t.id === id)).toBe(true);
      const doc = createTemplateDocument(id);
      const validation = validateDocument(doc);
      expect(validation.ok, `${id}: ${JSON.stringify(validation.issues)}`).toBe(true);
      await buildOk(doc);
    }
  }, 120_000);

  it("magnet pocket cuts from the bottom, not through", async () => {
    const doc = createTemplateDocument("fridgeMagnet");
    const result = await buildOk(doc);
    const part = result.parts[0];
    // Pocket depth 2.2 of a 4mm plate: top surface stays closed.
    expect(part.stats.dimensionsMm.z).toBeGreaterThan(4);
    const noPocket = createTemplateDocument("fridgeMagnet");
    noPocket.layers = noPocket.layers.filter((l) => l.type !== "hole");
    const noPocketResult = await buildOk(noPocket);
    expect(part.stats.volumeMm3).toBeLessThan(noPocketResult.parts[0].stats.volumeMm3);
  });
});

describe("detailed estimation", () => {
  const base = {
    modelVolumeMm3: 20_000,
    boundsMm: { x: 100, y: 50, z: 6 },
    technology: "fdm" as const,
    layerHeightMm: 0.2,
    nozzleDiameterMm: 0.4,
    infillPercent: 20,
    densityGCm3: 1.24,
    pricePerKgIls: 90,
  };

  it("is infill-aware and returns a sane time range", () => {
    const sparse = estimateDetailed(base);
    const dense = estimateDetailed({ ...base, infillPercent: 90 });
    expect(dense.materialWeightGrams).toBeGreaterThan(sparse.materialWeightGrams);
    expect(sparse.time.printMinutesMin).toBeGreaterThan(0);
    expect(sparse.time.printMinutesMax).toBeGreaterThan(sparse.time.printMinutesMin);
    expect(sparse.time.confidence).toBe("high"); // flat plate
    expect(sparse.totalCostIls).toBeGreaterThan(sparse.materialCostIls);
  });

  it("resin uses per-layer timing", () => {
    const resin = estimateDetailed({ ...base, technology: "sla", layerHeightMm: 0.05 });
    expect(resin.time.layerCount).toBe(120);
    expect(resin.time.confidence).toBe("medium");
  });

  it("formats Hebrew durations", () => {
    expect(formatMinutesHe(45)).toBe("45 דקות");
    expect(formatMinutesHe(130)).toBe("שעתיים ו-10 דקות");
    expect(formatMinutesHe(60)).toBe("שעה");
  });
});
