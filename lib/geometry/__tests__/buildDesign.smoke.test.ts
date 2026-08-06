/**
 * Integration smoke tests for the V2 layer pipeline (buildDesignParts),
 * running the real Manifold kernel and font loading under Node. SVG layers
 * are exercised separately under jsdom (svgGeometry.test.ts) since
 * SVGLoader needs DOMParser.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createBaseLayer,
  createBlankState,
  createHoleLayer,
  createImageReliefLayer,
  createTextLayer,
} from "@/lib/design/defaults";
import { PRODUCT_TEMPLATES } from "@/lib/design/templates";
import type { DesignState } from "@/types/design";
import { createRaw, type RawImage } from "@/lib/images/raster";
import { buildDesignParts, type AssetResolver } from "../buildDesign";

beforeAll(() => {
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

/** Synthetic 16×16 gradient image asset. */
function syntheticImage(): RawImage {
  const img = createRaw(16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = Math.round((x / 15) * 255);
      img.data.set([v, v, v, 255], (y * 16 + x) * 4);
    }
  }
  return img;
}

const assetResolver: AssetResolver = async (id) => (id === "test-asset" ? syntheticImage() : null);

function makeState(layers: DesignState["doc"]["layers"]): DesignState {
  const s = createBlankState();
  s.doc.layers = layers;
  return s;
}

describe("buildDesignParts", () => {
  it("builds raised Hebrew text as base + part", async () => {
    const state = makeState([
      createBaseLayer(),
      createTextLayer({ content: "שלום עולם", mode: "raised", depthMm: 1.5 }),
    ]);
    const result = await buildDesignParts(state, { assetResolver });
    expect(result.status).toBe("ok");
    expect(result.parts).toHaveLength(2);
    expect(result.parts[0].kind).toBe("base");
    expect(result.parts[1].kind).toBe("raised");
    expect(result.mesh!.watertight).toBe(true);
    expect(result.mesh!.dimensionsMm.z).toBeCloseTo(3 + 1.5, 1);
  });

  it("engraved text subtracts from the base", async () => {
    const plain = makeState([createBaseLayer()]);
    const engraved = makeState([
      createBaseLayer(),
      createTextLayer({ content: "אבג", mode: "engraved", depthMm: 1.5 }),
    ]);
    const a = await buildDesignParts(plain, { assetResolver });
    const b = await buildDesignParts(engraved, { assetResolver });
    expect(b.status).toBe("ok");
    expect(b.parts).toHaveLength(1);
    expect(b.parts[0].volumeMm3).toBeLessThan(a.parts[0].volumeMm3);
    expect(b.mesh!.dimensionsMm.z).toBeCloseTo(3, 1);
  });

  it("mirrored (stamp) text builds correctly", async () => {
    const state = makeState([
      createBaseLayer(),
      createTextLayer({ content: "חותמת", mirrored: true, depthMm: 1.8 }),
    ]);
    const result = await buildDesignParts(state, { assetResolver });
    expect(result.status).toBe("ok");
    expect(result.parts).toHaveLength(2);
  });

  it("curved text builds correctly", async () => {
    const state = makeState([
      createBaseLayer({ shape: "circle", widthMm: 70 }),
      createTextLayer({ content: "אלוף העולם", curveRadiusMm: 26, sizeMm: 9 }),
    ]);
    const result = await buildDesignParts(state, { assetResolver });
    expect(result.status).toBe("ok");
  });

  it("through holes and bottom pockets subtract", async () => {
    const solid = makeState([createBaseLayer()]);
    const holed = makeState([
      createBaseLayer(),
      createHoleLayer({ diameterMm: 6, through: true, transform: { x: 40, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 } }),
      createHoleLayer({ diameterMm: 10, through: false, depthMm: 1.5, fromBottom: true }),
    ]);
    const a = await buildDesignParts(solid, { assetResolver });
    const b = await buildDesignParts(holed, { assetResolver });
    expect(b.status).toBe("ok");
    expect(b.parts[0].volumeMm3).toBeLessThan(a.parts[0].volumeMm3);
    expect(b.mesh!.watertight).toBe(true);
  });

  it("image relief builds a raised part from a heightmap", async () => {
    const state = makeState([
      createBaseLayer({ widthMm: 60, heightMm: 60 }),
      createImageReliefLayer({
        assetId: "test-asset",
        widthMm: 30,
        heightMm: 30,
        resolution: "draft",
        maxHeightMm: 2,
      }),
    ]);
    const result = await buildDesignParts(state, { assetResolver });
    expect(result.status).toBe("ok");
    expect(result.parts).toHaveLength(2);
    expect(result.parts[1].volumeMm3).toBeGreaterThan(0);
    expect(result.mesh!.dimensionsMm.z).toBeGreaterThan(3);
  }, 30_000);

  it("engraved image relief cuts into the base", async () => {
    const plain = makeState([createBaseLayer({ widthMm: 60, heightMm: 60, thicknessMm: 4 })]);
    const engraved = makeState([
      createBaseLayer({ widthMm: 60, heightMm: 60, thicknessMm: 4 }),
      createImageReliefLayer({
        assetId: "test-asset",
        widthMm: 30,
        heightMm: 30,
        resolution: "draft",
        mode: "engraved",
        minHeightMm: 0.2,
        maxHeightMm: 1.5,
      }),
    ]);
    const a = await buildDesignParts(plain, { assetResolver });
    const b = await buildDesignParts(engraved, { assetResolver });
    expect(b.status).toBe("ok");
    expect(b.parts).toHaveLength(1);
    expect(b.parts[0].volumeMm3).toBeLessThan(a.parts[0].volumeMm3);
    expect(b.mesh!.dimensionsMm.z).toBeCloseTo(4, 1);
  }, 30_000);

  it("warns about floating raised layers", async () => {
    const state = makeState([
      createBaseLayer(),
      createTextLayer({
        content: "מרחף",
        transform: { x: 0, y: 0, z: 10, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
      }),
    ]);
    const result = await buildDesignParts(state, { assetResolver });
    expect(result.status).toBe("ok");
    expect(result.issues.some((i) => i.code === "layer/floating")).toBe(true);
  });

  it("inlay mode cuts a clearance pocket and adds a flush part", async () => {
    const state = makeState([
      createBaseLayer({ thicknessMm: 4 }),
      createTextLayer({ content: "אב", mode: "inlay", depthMm: 1.5 }),
    ]);
    state.settings.multiColor.enabled = true;
    state.settings.multiColor.inlayClearanceMm = 0.2;
    const plain = makeState([createBaseLayer({ thicknessMm: 4 })]);
    const a = await buildDesignParts(plain, { assetResolver });
    const b = await buildDesignParts(state, { assetResolver });
    expect(b.status).toBe("ok");
    expect(b.parts).toHaveLength(2);
    expect(b.parts[1].kind).toBe("inlay");
    // Pocket removes more than the inlay part fills back (clearance).
    expect(b.parts[0].volumeMm3).toBeLessThan(a.parts[0].volumeMm3);
    // Inlay top is flush with the base top.
    expect(b.mesh!.dimensionsMm.z).toBeCloseTo(4, 1);
  });

  it("returns invalid for blocking validation errors", async () => {
    const state = makeState([
      createBaseLayer({ thicknessMm: 2 }),
      createTextLayer({ content: "א", mode: "engraved", depthMm: 5 }),
    ]);
    const result = await buildDesignParts(state, { assetResolver });
    expect(result.status).toBe("invalid");
    expect(result.parts).toHaveLength(0);
  });

  it("builds every non-SVG product template", async () => {
    for (const template of PRODUCT_TEMPLATES) {
      const state = createBlankState();
      state.doc = template.create();
      const result = await buildDesignParts(state, { assetResolver });
      expect(result.status, `template ${template.id}`).toBe("ok");
      expect(result.mesh!.watertight).toBe(true);
      expect(result.parts[0].kind).toBe("base");
    }
  }, 120_000);
});
