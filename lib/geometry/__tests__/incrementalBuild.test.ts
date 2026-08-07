/**
 * Incremental document builds via the per-layer solid cache (V6 item 6).
 *
 * Measured claims:
 *  - a 10-layer document that changes ONE layer rebuilds exactly one layer
 *    (the counter counts real buildShapeLayerSolid work, not calls to some
 *    wrapper), the other nine come from cache;
 *  - a transform-only change rebuilds ZERO layers (placement is not
 *    geometry);
 *  - the final result is byte-identical to a cache-disabled full build;
 *  - the withBase assembly (booleans over the base) still re-runs and stays
 *    correct when one anchored layer changes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultPrimitive,
  identityTransform,
  type DesignDocument,
  type PrimitiveLayer,
  type TextLayer,
} from "@/types/design";
import {
  buildDocument,
  clearLayerSolidCache,
  type BuildStats,
} from "../buildDocument";
import { createTemplateDocument, emptyDocument } from "../documentTemplates";

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

beforeEach(() => clearLayerSolidCache());

function boxLayer(id: string, index: number): PrimitiveLayer {
  return {
    id,
    type: "primitive",
    name: `תיבה ${index}`,
    visible: true,
    locked: false,
    materialSlotId: "slot1",
    transform: { ...identityTransform(), x: index * 30 },
    previewOpacity: 1,
    ...defaultPrimitive("box"),
    widthMm: 10 + index,
    depthMm: 8,
    heightMm: 5,
  };
}

function tenLayerDocument(): DesignDocument {
  const doc = emptyDocument();
  doc.baseMode = "baseless";
  doc.layers = Array.from({ length: 10 }, (_, i) => boxLayer(`box_${i}`, i));
  return doc;
}

function freshStats(): BuildStats {
  return { layersBuilt: 0, layersFromCache: 0 };
}

describe("incremental per-layer build cache", () => {
  it("rebuilds exactly one layer when one layer changes", async () => {
    const doc = tenLayerDocument();

    const cold = freshStats();
    const first = await buildDocument(doc, { stats: cold });
    expect(first.status).toBe("ok");
    expect(cold.layersBuilt).toBe(10);
    expect(cold.layersFromCache).toBe(0);

    // Change ONE layer's geometry.
    const edited: DesignDocument = {
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === "box_4" ? { ...l, widthMm: 25 } : l
      ),
    };
    const warm = freshStats();
    const second = await buildDocument(edited, { stats: warm });
    expect(second.status).toBe("ok");
    expect(warm.layersBuilt).toBe(1);
    expect(warm.layersFromCache).toBe(9);

    // And the incremental result is identical to a full, cache-less build.
    const reference = await buildDocument(edited, { useLayerCache: false });
    expect(second.parts.length).toBe(reference.parts.length);
    for (let i = 0; i < reference.parts.length; i++) {
      expect(second.parts[i].localMesh.positions).toEqual(
        reference.parts[i].localMesh.positions
      );
      expect(second.parts[i].localMesh.indices).toEqual(
        reference.parts[i].localMesh.indices
      );
      expect(second.parts[i].stats.volumeMm3).toBeCloseTo(
        reference.parts[i].stats.volumeMm3,
        6
      );
    }
  }, 60_000);

  it("rebuilds zero layers for a transform-only change", async () => {
    const doc = tenLayerDocument();
    await buildDocument(doc, { stats: freshStats() });

    const moved: DesignDocument = {
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === "box_7" ? { ...l, transform: { ...l.transform, x: 500, rotationZ: 45 } } : l
      ),
    };
    const stats = freshStats();
    const result = await buildDocument(moved, { stats });
    expect(result.status).toBe("ok");
    expect(stats.layersBuilt).toBe(0);
    expect(stats.layersFromCache).toBe(10);

    // The moved part must actually be placed at its new position.
    const part = result.parts.find((p) => p.primaryLayerId === "box_7");
    expect(part).toBeDefined();
    expect(part!.stats.bounds.min.x).toBeGreaterThan(400);
  }, 60_000);

  it("keeps a withBase assembly correct when one anchored layer changes", async () => {
    const doc = createTemplateDocument("namePlate");
    await buildDocument(doc, { stats: freshStats() });

    const text = doc.layers.find((l): l is TextLayer => l.type === "text");
    expect(text).toBeDefined();
    const edited: DesignDocument = {
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === text!.id ? ({ ...l, content: "אחר" } as TextLayer) : l
      ),
    };

    const stats = freshStats();
    const incremental = await buildDocument(edited, { stats });
    // Only the text layer rebuilt; the base came from cache.
    expect(stats.layersBuilt).toBe(1);
    expect(stats.layersFromCache).toBeGreaterThanOrEqual(1);

    const reference = await buildDocument(edited, { useLayerCache: false });
    expect(incremental.status).toBe(reference.status);
    expect(incremental.parts.length).toBe(reference.parts.length);
    expect(incremental.parts[0].stats.volumeMm3).toBeCloseTo(
      reference.parts[0].stats.volumeMm3,
      4
    );
    expect(incremental.parts[0].localMesh.positions).toEqual(
      reference.parts[0].localMesh.positions
    );
  }, 120_000);
});
