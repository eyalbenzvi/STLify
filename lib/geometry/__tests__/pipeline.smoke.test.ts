/**
 * Integration smoke test for the full geometry pipeline (buildModel).
 * Font fetches are redirected to the files in /public so the exact
 * client-side code path runs under Node.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { geometryToBinaryStl } from "../../export/stl";
import { buildModel } from "../buildModel";
import { getTemplateParams, TEMPLATES } from "../templates";
import type { DesignParams } from "../types";

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

function expectPrintable(params: DesignParams) {
  return buildModel(params).then((result) => {
    expect(result.status).toBe("ok");
    expect(result.geometry).not.toBeNull();
    expect(result.stats).not.toBeNull();
    expect(result.stats!.watertight).toBe(true);
    expect(result.stats!.triangleCount).toBeGreaterThan(10);
    return result;
  });
}

describe("buildModel pipeline", () => {
  it("builds every template preset as a watertight solid", async () => {
    for (const template of TEMPLATES) {
      const result = await expectPrintable(getTemplateParams(template.id));
      const { x, y, z } = result.stats!.dimensionsMm;
      expect(x).toBeCloseTo(template.params.base.widthMm, 0);
      expect(y).toBeCloseTo(template.params.base.heightMm, 0);
      expect(z).toBeGreaterThanOrEqual(template.params.base.thicknessMm - 0.01);
    }
  }, 60_000);

  it("places the model centred on XY and resting on Z=0", async () => {
    const result = await expectPrintable(getTemplateParams("namePlate"));
    const geometry = result.geometry!;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.min.z).toBeCloseTo(0, 5);
    expect(box.min.x + box.max.x).toBeCloseTo(0, 3);
    expect(box.min.y + box.max.y).toBeCloseTo(0, 3);
  });

  it("raised text increases Z above the base thickness", async () => {
    const params = getTemplateParams("namePlate");
    params.text.mode = "raised";
    params.text.depthMm = 1.5;
    const result = await expectPrintable(params);
    expect(result.stats!.dimensionsMm.z).toBeCloseTo(
      params.base.thicknessMm + 1.5,
      1
    );
  });

  it("engraved text keeps the outer dimensions", async () => {
    const params = getTemplateParams("reliefTile");
    params.text.mode = "engraved";
    params.text.depthMm = 2;
    const result = await expectPrintable(params);
    expect(result.stats!.dimensionsMm.z).toBeCloseTo(params.base.thicknessMm, 1);
  });

  it("keychain hole subtraction stays watertight", async () => {
    const params = getTemplateParams("keychain");
    expect(params.hole.enabled).toBe(true);
    await expectPrintable(params);
  });

  it("returns invalid (no geometry) for out-of-range parameters", async () => {
    const params = getTemplateParams("namePlate");
    params.text.mode = "engraved";
    params.text.depthMm = params.base.thicknessMm + 1;
    const result = await buildModel(params);
    expect(result.status).toBe("invalid");
    expect(result.geometry).toBeNull();
  });

  it("builds a base-only solid for empty text, with a warning", async () => {
    const params = getTemplateParams("namePlate");
    params.text.content = "  ";
    const result = await buildModel(params);
    expect(result.status).toBe("ok");
    expect(result.stats!.watertight).toBe(true);
    expect(result.issues.some((i) => i.code === "text/empty")).toBe(true);
    expect(result.stats!.dimensionsMm.z).toBeCloseTo(
      params.base.thicknessMm,
      2
    );
  });

  it("warns when text overflows the base", async () => {
    const params = getTemplateParams("namePlate");
    params.text.sizeMm = 60; // way larger than the 40mm-high plate
    const result = await buildModel(params);
    expect(result.issues.some((i) => i.code === "text/overflow")).toBe(true);
  });

  it("exports valid binary STL bytes", async () => {
    const result = await expectPrintable(getTemplateParams("keychain"));
    const blob = geometryToBinaryStl(result.geometry!);
    // 84-byte header + 50 bytes per triangle.
    expect(blob.size).toBe(84 + result.stats!.triangleCount * 50);
  });
});
