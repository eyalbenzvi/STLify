/**
 * WASM memory enforcement (V6 item 8).
 *
 * The kernel contract — "an operation consumes its inputs; dispose what you
 * abandon" — is now measurable: `liveSolidCount()` counts live WASM handles,
 * and these tests assert ZERO leaks across long pipelines, error paths and
 * cancellations. The per-layer build cache retains solids BY DESIGN; the
 * tests account for it explicitly and prove the accounting by clearing it.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { testBoxRow } from "@/lib/testing/fixtures";
import {
  identityTransform,
  type DesignDocument,
  type ImportedMeshLayer,
} from "@/types/design";
import { getGeometryKernel, liveSolidCount } from "../kernel";
import { withSolidScope } from "../solidScope";
import { buildDocument, clearLayerSolidCache } from "../buildDocument";
import { emptyDocument } from "../documentTemplates";
import { clearMeshStore, storeMesh } from "../meshStore";
import { performBoolean } from "../operations/booleans";
import { performHollow } from "../operations/hollow";
import { OpError } from "../operations/layerOps";
import { JobCancelledError } from "../jobs/registry";

let kernel: Awaited<ReturnType<typeof getGeometryKernel>>;

beforeAll(async () => {
  kernel = await getGeometryKernel();
});

function meshLayer(id: string, meshId: string, x = 0): ImportedMeshLayer {
  return {
    id,
    type: "importedMesh",
    name: id,
    visible: true,
    locked: false,
    materialSlotId: "slot1",
    transform: { ...identityTransform(), x },
    previewOpacity: 1,
    meshId,
    originalMeshId: meshId,
    provenance: { kind: "stlImport", fileName: `${id}.stl` },
    combine: "standalone",
  };
}

describe("live-solid accounting", () => {
  it("dispose is idempotent and consumed handles are safe to dispose", () => {
    const baseline = liveSolidCount();
    const a = kernel.box(10, 10, 10, false);
    const b = kernel.box(10, 10, 10, false);
    expect(liveSolidCount()).toBe(baseline + 2);
    const c = a.union(b); // consumes a and b
    expect(liveSolidCount()).toBe(baseline + 1);
    // Disposing consumed handles must be a no-op, not a double-free.
    a.dispose();
    b.dispose();
    expect(liveSolidCount()).toBe(baseline + 1);
    c.dispose();
    c.dispose();
    expect(liveSolidCount()).toBe(baseline);
  });

  it("a 20-boolean pipeline leaks nothing", async () => {
    const baseline = liveSolidCount();
    await withSolidScope((scope) => {
      let acc = scope.track(kernel.box(30, 30, 5, false));
      for (let i = 0; i < 20; i++) {
        const bump = scope.track(
          kernel.cylinder(2, 8, 24).translate(2 + i, 15, 0)
        );
        acc = scope.track(i % 2 === 0 ? acc.union(bump) : acc.subtract(bump));
      }
      expect(acc.status()).toBe("NoError");
    });
    expect(liveSolidCount()).toBe(baseline);
  }, 60_000);

  it("the scope frees everything on a mid-pipeline throw", async () => {
    const baseline = liveSolidCount();
    await expect(
      withSolidScope((scope) => {
        scope.track(kernel.box(10, 10, 10, false));
        scope.track(kernel.sphere(5, 16));
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(liveSolidCount()).toBe(baseline);
  });
});

describe("operation pipelines leak nothing", () => {
  function twoBoxDocument(): DesignDocument {
    clearMeshStore();
    const a = kernel.box(20, 20, 10, false);
    storeMesh(a.toMeshData(), "leak_mesh_a");
    a.dispose();
    const b = kernel.box(20, 20, 10, false);
    storeMesh(b.toMeshData(), "leak_mesh_b");
    b.dispose();
    return {
      ...emptyDocument(),
      baseMode: "baseless",
      layers: [meshLayer("layer_a", "leak_mesh_a", 0), meshLayer("layer_b", "leak_mesh_b", 10)],
    };
  }

  it("performBoolean success and failure paths", async () => {
    const document = twoBoxDocument();
    const baseline = liveSolidCount();
    await performBoolean(
      document,
      [document.layers[0], document.layers[1]] as never,
      "union"
    );
    expect(liveSolidCount()).toBe(baseline);

    // Failure path: an unknown layer id in the middle of materialisation.
    const broken = {
      ...document,
      layers: [
        document.layers[0],
        { ...(document.layers[1] as ImportedMeshLayer), meshId: "missing" },
      ],
    } as DesignDocument;
    await expect(
      performBoolean(broken, broken.layers as never, "union")
    ).rejects.toBeInstanceOf(OpError);
    expect(liveSolidCount()).toBe(baseline);
  }, 60_000);

  it("performHollow success, failure and cancellation paths", async () => {
    const document = twoBoxDocument();
    const baseline = liveSolidCount();

    await performHollow(document, document.layers[0] as never, {
      wallThicknessMm: 2,
      preserveBaseMm: 0,
    });
    expect(liveSolidCount()).toBe(baseline);

    // Failure: wall thicker than the body — no cavity remains.
    await expect(
      performHollow(document, document.layers[0] as never, {
        wallThicknessMm: 9.5,
        preserveBaseMm: 0,
      })
    ).rejects.toBeInstanceOf(OpError);
    expect(liveSolidCount()).toBe(baseline);

    // Cancellation right before the Minkowski stage.
    let calls = 0;
    await expect(
      performHollow(
        document,
        document.layers[0] as never,
        { wallThicknessMm: 2, preserveBaseMm: 0 },
        {
          throwIfCancelled: () => {
            if (++calls >= 2) throw new JobCancelledError();
          },
        }
      )
    ).rejects.toBeInstanceOf(JobCancelledError);
    expect(liveSolidCount()).toBe(baseline);
  }, 120_000);

  it("buildDocument retains exactly the cache and nothing else", async () => {
    clearLayerSolidCache();
    const doc = emptyDocument();
    doc.baseMode = "baseless";
    doc.layers = testBoxRow(5, "leak_box_");

    const baseline = liveSolidCount();
    await buildDocument(doc);
    // The per-layer cache deliberately holds ONE solid per built layer.
    expect(liveSolidCount()).toBe(baseline + 5);
    // Rebuild from cache: no additional retention.
    await buildDocument(doc);
    expect(liveSolidCount()).toBe(baseline + 5);
    // And the accounting is exact: clearing the cache returns to baseline.
    clearLayerSolidCache();
    expect(liveSolidCount()).toBe(baseline);

    // A cache-less build leaks nothing at all.
    await buildDocument(doc, { useLayerCache: false });
    expect(liveSolidCount()).toBe(baseline);
  }, 60_000);

  it("a cancelled buildDocument leaks nothing", async () => {
    clearLayerSolidCache();
    const doc = emptyDocument();
    doc.baseMode = "baseless";
    doc.layers = testBoxRow(5, "cancel_box_");

    const baseline = liveSolidCount();
    let checks = 0;
    await expect(
      buildDocument(doc, {
        useLayerCache: false,
        throwIfCancelled: () => {
          // Let three layers build, then cancel mid-loop.
          if (++checks > 3) throw new JobCancelledError();
        },
      })
    ).rejects.toBeInstanceOf(JobCancelledError);
    expect(liveSolidCount()).toBe(baseline);
  }, 60_000);
});
