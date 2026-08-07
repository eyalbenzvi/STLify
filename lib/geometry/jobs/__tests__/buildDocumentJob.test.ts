/**
 * buildDocument as a geometry job (V6 item 5).
 *
 * Three measured claims:
 *
 * 1. IDENTICAL RESULT — the job path (payload → mesh-store seeding → build →
 *    wire form → revival) produces byte-identical meshes, identical world
 *    matrices and identical stats to calling buildDocument directly.
 * 2. CANCELLATION STOPS THE BUILD — a cancel raised at a checkpoint rejects
 *    with JobCancelledError and no result is produced.
 * 3. PROGRESS IS REAL — fractions arrive monotonically non-decreasing and
 *    reach the terminal 1.0.
 *
 * The worker itself cannot exist under vitest; the exact same registry
 * handler runs in the worker, and the real-browser Playwright suite drives
 * the worker path end to end.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { installNodeFontFetch } from "../../nodeFontFetch";
import type { DesignDocument, ImportedMeshLayer } from "@/types/design";
import { buildDocument } from "../../buildDocument";
import { createTemplateDocument } from "../../documentTemplates";
import { getGeometryKernel } from "../../kernel";
import { clearMeshStore, storeMesh } from "../../meshStore";
import type { MeshData } from "../../meshData";
import { executeJob, JobCancelledError, type JobContext } from "../registry";
import { buildDocumentViaJob } from "../buildDocumentClient";

beforeAll(installNodeFontFetch);

function passiveContext(): JobContext {
  return { onProgress: () => undefined, throwIfCancelled: () => undefined };
}

/** A small imported mesh (a kernel box) so mesh-store seeding is exercised. */
async function importedMeshDocument(): Promise<{ document: DesignDocument; mesh: MeshData }> {
  const kernel = await getGeometryKernel();
  const solid = kernel.box(14, 9, 6, false);
  const mesh = solid.toMeshData();
  solid.dispose();
  const meshId = storeMesh(mesh, "job_test_mesh");
  const layer: ImportedMeshLayer = {
    id: "layer_imported",
    type: "importedMesh",
    name: "מיובא",
    visible: true,
    locked: false,
    materialSlotId: "slot1",
    transform: {
      x: 5, y: -3, z: 0,
      rotationX: 0, rotationY: 0, rotationZ: 30,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
    previewOpacity: 1,
    meshId,
    originalMeshId: meshId,
    provenance: { kind: "stlImport", fileName: "test.stl" },
    combine: "standalone",
  };
  const document = createTemplateDocument("namePlate");
  document.layers = [...document.layers, layer];
  return { document, mesh };
}

describe("buildDocument job", () => {
  it("produces a result identical to the direct call", async () => {
    const { document, mesh } = await importedMeshDocument();

    const direct = await buildDocument(document);
    // The job path as the WORKER runs it: fresh mesh store seeded from the
    // payload — clearing first proves the seeding is what supplies the mesh.
    clearMeshStore();
    const wire = await executeJob(
      "buildDocument",
      { document, meshes: [{ id: "job_test_mesh", mesh }] },
      passiveContext()
    );

    expect(wire.status).toBe(direct.status);
    expect(wire.parts.length).toBe(direct.parts.length);
    for (let i = 0; i < direct.parts.length; i++) {
      const d = direct.parts[i];
      const w = wire.parts[i];
      expect(w.id).toBe(d.id);
      expect(w.primaryLayerId).toBe(d.primaryLayerId);
      expect(Array.from(w.worldMatrixElements)).toEqual(d.worldMatrix.toArray());
      expect(w.localMesh.positions).toEqual(d.localMesh.positions);
      expect(w.localMesh.indices).toEqual(d.localMesh.indices);
      expect(w.stats.volumeMm3).toBeCloseTo(d.stats.volumeMm3, 6);
      expect(w.stats.watertight).toBe(d.stats.watertight);
    }
  }, 60_000);

  it("the client wrapper revives matrices and reports the honest path", async () => {
    const { document } = await importedMeshDocument();
    const direct = await buildDocument(document);
    const outcome = await buildDocumentViaJob(document, { forceInProcess: true });

    // vitest has no Worker, so the honest answer is "main".
    expect(outcome.ranOn).toBe("main");
    expect(outcome.result.parts.length).toBe(direct.parts.length);
    for (let i = 0; i < direct.parts.length; i++) {
      expect(outcome.result.parts[i].worldMatrix.toArray()).toEqual(
        direct.parts[i].worldMatrix.toArray()
      );
      expect(outcome.result.parts[i].localMesh.positions).toEqual(
        direct.parts[i].localMesh.positions
      );
    }
  }, 60_000);

  it("cancellation actually stops the build", async () => {
    const { document, mesh } = await importedMeshDocument();
    let progressCalls = 0;
    let resolved = false;
    const context: JobContext = {
      onProgress: () => {
        progressCalls++;
      },
      // Cancel from the very first checkpoint.
      throwIfCancelled: () => {
        throw new JobCancelledError();
      },
    };
    await expect(
      executeJob(
        "buildDocument",
        { document, meshes: [{ id: "job_test_mesh", mesh }] },
        context
      ).then(() => {
        resolved = true;
      })
    ).rejects.toBeInstanceOf(JobCancelledError);
    expect(resolved).toBe(false);
    // The build must have stopped before doing the per-layer work.
    expect(progressCalls).toBeLessThanOrEqual(1);
  }, 60_000);

  it("reports monotonic progress ending at 1", async () => {
    const { document, mesh } = await importedMeshDocument();
    const fractions: number[] = [];
    await executeJob(
      "buildDocument",
      { document, meshes: [{ id: "job_test_mesh", mesh }] },
      {
        onProgress: (fraction) => {
          fractions.push(fraction);
        },
        throwIfCancelled: () => undefined,
      }
    );
    expect(fractions.length).toBeGreaterThan(2);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
    expect(fractions[fractions.length - 1]).toBe(1);
  }, 60_000);
});
