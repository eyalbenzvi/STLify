/**
 * Integration tests for the V3 document pipeline — including the V2
 * regression flows (template presets must keep producing the same
 * watertight solids they produced in V2).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { DesignDocument, TextLayer } from "@/types/design";
import { identityTransform } from "@/types/design";
import { buildDocument } from "../buildDocument";
import {
  createTemplateDocument,
  emptyDocument,
  makeBaseLayer,
  makeHoleLayer,
  makeTextLayer,
  PRODUCT_TEMPLATES,
} from "../documentTemplates";
import { validateDocument } from "../documentValidation";

beforeAll(() => {
  // Serve /fonts/* requests from the public directory.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/fonts/")) {
      const buffer = readFileSync(join(process.cwd(), "public", url));
      return new Response(new Uint8Array(buffer), { status: 200 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

async function buildOk(document: DesignDocument) {
  const result = await buildDocument(document);
  expect(result.status).toBe("ok");
  expect(result.parts.length).toBeGreaterThan(0);
  for (const part of result.parts) {
    expect(part.stats.watertight).toBe(true);
    expect(part.stats.triangleCount).toBeGreaterThan(4);
  }
  return result;
}

describe("V2 regression: classic templates on the layer pipeline", () => {
  it("builds every classic template as a single watertight part", async () => {
    for (const template of PRODUCT_TEMPLATES) {
      if (template.id === "baseless") continue;
      const doc = template.createDocument();
      const result = await buildOk(doc);
      expect(result.parts.length).toBe(1);
      const base = doc.layers.find((l) => l.type === "base");
      expect(base).toBeDefined();
      if (base && base.type === "base") {
        expect(result.parts[0].stats.dimensionsMm.x).toBeCloseTo(base.widthMm, 0);
        expect(result.parts[0].stats.dimensionsMm.y).toBeCloseTo(base.heightMm, 0);
      }
    }
  }, 120_000);

  it("raised text adds height above the base", async () => {
    const doc = createTemplateDocument("namePlate");
    const result = await buildOk(doc);
    expect(result.parts[0].stats.dimensionsMm.z).toBeCloseTo(3 + 1.5, 1);
  });

  it("engraved text keeps the outer dimensions", async () => {
    const doc = createTemplateDocument("reliefTile");
    const result = await buildOk(doc);
    expect(result.parts[0].stats.dimensionsMm.z).toBeCloseTo(5, 1);
  });

  it("keychain hole reduces volume and stays watertight", async () => {
    const withHole = createTemplateDocument("keychain");
    const noHole = createTemplateDocument("keychain");
    noHole.layers = noHole.layers.filter((l) => l.type !== "hole");
    const withHoleResult = await buildOk(withHole);
    const noHoleResult = await buildOk(noHole);
    expect(withHoleResult.parts[0].stats.volumeMm3).toBeLessThan(
      noHoleResult.parts[0].stats.volumeMm3
    );
  });

  it("validation blocks out-of-range base dimensions", () => {
    const doc = createTemplateDocument("namePlate");
    const base = doc.layers.find((l) => l.type === "base");
    if (base && base.type === "base") base.widthMm = 5000;
    const validation = validateDocument(doc);
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === "base/width-range")).toBe(true);
  });
});

describe("baseless mode", () => {
  it("builds standalone text as a closed solid of the exact thickness", async () => {
    const doc = emptyDocument();
    doc.layers = [
      makeTextLayer({ content: "אב", extrudeMm: 5, combine: "standalone" }),
    ];
    const result = await buildOk(doc);
    expect(result.parts.length).toBe(1);
    expect(result.parts[0].stats.dimensionsMm.z).toBeCloseTo(5, 2);
    expect(result.parts[0].stats.bounds.min.z).toBeCloseTo(0, 3);
  });

  it("ignores base layers while in baseless mode", async () => {
    const doc = emptyDocument();
    doc.layers = [
      makeBaseLayer(),
      makeTextLayer({ content: "א", extrudeMm: 4 }),
    ];
    const result = await buildOk(doc);
    expect(result.parts.length).toBe(1);
  });

  it("builds each visible layer as an independent part", async () => {
    const doc = emptyDocument();
    doc.layers = [
      makeTextLayer({ content: "א", extrudeMm: 3 }),
      makeTextLayer({
        content: "ב",
        extrudeMm: 3,
        transform: { ...identityTransform(), x: 40 },
      }),
    ];
    const result = await buildOk(doc);
    expect(result.parts.length).toBe(2);
  });

  it("applies bevel without breaking watertightness", async () => {
    const doc = emptyDocument();
    doc.layers = [
      makeTextLayer({
        content: "או",
        sizeMm: 40,
        extrudeMm: 6,
        bevel: { enabled: true, sizeMm: 1.5, segments: 4 },
      }),
    ];
    const result = await buildOk(doc);
    expect(result.parts[0].stats.dimensionsMm.z).toBeCloseTo(6, 1);
  });

  it("subtracts hole layers from standalone parts", async () => {
    const doc = emptyDocument();
    doc.layers = [
      makeTextLayer({ content: "ו", sizeMm: 40, extrudeMm: 5 }), // vav: solid stroke at centre
      makeHoleLayer({ diameterMm: 3 }),
    ];
    const solidOnly = emptyDocument();
    solidOnly.layers = [doc.layers[0]];
    const withHole = await buildOk(doc);
    const without = await buildOk(solidOnly);
    expect(withHole.parts[0].stats.volumeMm3).toBeLessThan(
      without.parts[0].stats.volumeMm3
    );
  });
});

describe("full 3D transforms through the pipeline", () => {
  it("rotating a text layer 90° about X swaps Y and Z extents", async () => {
    const flat = emptyDocument();
    const layer = makeTextLayer({ content: "אבג", extrudeMm: 4 });
    flat.layers = [layer];
    const flatResult = await buildOk(flat);
    const flatDims = flatResult.parts[0].stats.dimensionsMm;

    const rotated = emptyDocument();
    rotated.layers = [
      {
        ...layer,
        transform: { ...layer.transform, rotationX: 90 },
      } as TextLayer,
    ];
    const rotatedResult = await buildOk(rotated);
    const rotDims = rotatedResult.parts[0].stats.dimensionsMm;
    expect(rotDims.z).toBeCloseTo(flatDims.y, 1);
    expect(rotDims.y).toBeCloseTo(flatDims.z, 1);
  });

  it("scale transforms scale the printable geometry", async () => {
    const doc = emptyDocument();
    const layer = makeTextLayer({ content: "אב", extrudeMm: 2 });
    doc.layers = [layer];
    const base = await buildOk(doc);

    const scaled = emptyDocument();
    scaled.layers = [
      { ...layer, transform: { ...layer.transform, scaleX: 2, scaleY: 2, scaleZ: 3 } } as TextLayer,
    ];
    const scaledResult = await buildOk(scaled);
    expect(scaledResult.parts[0].stats.dimensionsMm.x).toBeCloseTo(
      base.parts[0].stats.dimensionsMm.x * 2,
      0
    );
    expect(scaledResult.parts[0].stats.dimensionsMm.z).toBeCloseTo(
      base.parts[0].stats.dimensionsMm.z * 3,
      1
    );
  });

  it("raised layers ride along with a transformed base", async () => {
    const doc = createTemplateDocument("namePlate");
    for (const layer of doc.layers) {
      if (layer.type === "base") {
        layer.transform = { ...layer.transform, x: 30, y: -10 };
      }
    }
    const result = await buildOk(doc);
    expect(result.parts.length).toBe(1);
    const { bounds } = result.parts[0].stats;
    expect((bounds.min.x + bounds.max.x) / 2).toBeCloseTo(30, 0);
    expect(result.parts[0].stats.dimensionsMm.z).toBeCloseTo(4.5, 1);
  });

  it("returns empty status for a document with no visible shapes", async () => {
    const doc = emptyDocument();
    const result = await buildDocument(doc);
    expect(result.status).toBe("empty");
    expect(result.parts.length).toBe(0);
  });
});
