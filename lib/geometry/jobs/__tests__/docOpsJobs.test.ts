/**
 * The remaining heavy operations as registry jobs (V6 item 7).
 *
 * For every job: (1) the job path produces a result identical to calling
 * the operation directly — measured on the geometry (volumes, byte-equal
 * meshes), not on call wiring; (2) cancellation raised at a checkpoint
 * rejects with JobCancelledError and produces nothing.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type {
  DesignDocument,
  ImportedMeshLayer,
} from "@/types/design";
import { identityTransform } from "@/types/design";
import { getGeometryKernel } from "../../kernel";
import { meshDataVolume, type MeshData } from "../../meshData";
import { clearMeshStore, getMesh, storeMesh } from "../../meshStore";
import { performBoolean } from "../../operations/booleans";
import { performHollow } from "../../operations/hollow";
import { performThicken } from "../../operations/meshRefine";
import { analyzeThickness } from "../../analysis/thickness";
import { buildSupports, DEFAULT_SUPPORT_SETTINGS } from "../../analysis/supports";
import { executeJob, JobCancelledError, type JobContext } from "../registry";

let kernel: Awaited<ReturnType<typeof getGeometryKernel>>;

beforeAll(async () => {
  kernel = await getGeometryKernel();
});

function passive(): JobContext {
  return { onProgress: () => undefined, throwIfCancelled: () => undefined };
}

function cancelling(): JobContext {
  return {
    onProgress: () => undefined,
    throwIfCancelled: () => {
      throw new JobCancelledError();
    },
  };
}

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

/** Two overlapping boxes as imported-mesh layers. */
function twoBoxDocument(): { document: DesignDocument; meshes: { id: string; mesh: MeshData }[] } {
  clearMeshStore();
  const a = kernel.box(20, 20, 10, false);
  const meshA = a.toMeshData();
  a.dispose();
  const b = kernel.box(20, 20, 10, false);
  const meshB = b.toMeshData();
  b.dispose();
  storeMesh(meshA, "mesh_a");
  storeMesh(meshB, "mesh_b");
  const document = {
    version: 3,
    baseMode: "baseless",
    layers: [meshLayer("layer_a", "mesh_a", 0), meshLayer("layer_b", "mesh_b", 10)],
    materialSlots: [{ id: "slot1", nameHe: "חומר", colorHex: "#2f6feb" }],
    printabilityProfileId: "fdm-pla",
    usageProfileId: "decor",
  } as unknown as DesignDocument;
  return {
    document,
    meshes: [
      { id: "mesh_a", mesh: meshA },
      { id: "mesh_b", mesh: meshB },
    ],
  };
}

describe("docBoolean job", () => {
  it("matches the direct call and returns the result mesh payload", async () => {
    const { document, meshes } = twoBoxDocument();
    const direct = await performBoolean(
      document,
      [document.layers[0], document.layers[1]] as never,
      "union"
    );
    const directMesh = getMesh(direct.layer.meshId);
    expect(directMesh).not.toBeNull();

    clearMeshStore(); // the job must be able to run from its payload alone
    const job = await executeJob(
      "docBoolean",
      { document, meshes, layerIds: ["layer_a", "layer_b"], kind: "union" },
      passive()
    );

    // Same geometry (ids differ by design — newId per call).
    expect(meshDataVolume(job.resultMesh)).toBeCloseTo(meshDataVolume(directMesh!), 6);
    expect(job.resultMesh.positions).toEqual(directMesh!.positions);
    expect(job.resultMesh.indices).toEqual(directMesh!.indices);
    expect(job.layer.transform).toEqual(direct.layer.transform);
    expect(job.warningsHe).toEqual(direct.warningsHe);
    // Union of two 20x20x10 boxes overlapping by half: 20*30*10 = 6000.
    expect(meshDataVolume(job.resultMesh)).toBeCloseTo(6000, 3);
  }, 60_000);

  it("cancellation stops it before any work", async () => {
    const { document, meshes } = twoBoxDocument();
    await expect(
      executeJob(
        "docBoolean",
        { document, meshes, layerIds: ["layer_a", "layer_b"], kind: "union" },
        cancelling()
      )
    ).rejects.toBeInstanceOf(JobCancelledError);
  }, 60_000);
});

describe("docHollow / docThicken jobs", () => {
  it("hollow matches the direct call", async () => {
    const { document, meshes } = twoBoxDocument();
    const settings = { wallThicknessMm: 2, preserveBaseMm: 0 };
    const direct = await performHollow(document, document.layers[0] as never, settings);
    const directMesh = getMesh(direct.layer.meshId)!;

    clearMeshStore();
    const job = await executeJob(
      "docHollow",
      { document, meshes, layerId: "layer_a", settings },
      passive()
    );
    expect(job.savedFraction).toBeCloseTo(direct.savedFraction, 6);
    expect(job.originalVolumeMm3).toBeCloseTo(direct.originalVolumeMm3, 6);
    expect(job.resultMesh.positions).toEqual(directMesh.positions);
    // Hollowing must actually remove material.
    expect(job.hollowVolumeMm3).toBeLessThan(job.originalVolumeMm3 * 0.95);
  }, 120_000);

  it("thicken matches the direct call and cancellation stops both", async () => {
    const { document, meshes } = twoBoxDocument();
    const direct = await performThicken(document, document.layers[0] as never, 2);
    const directMesh = getMesh(direct.layer.meshId)!;

    clearMeshStore();
    const job = await executeJob(
      "docThicken",
      { document, meshes, layerId: "layer_a", thicknessMm: 2 },
      passive()
    );
    expect(job.resultMesh.positions).toEqual(directMesh.positions);
    expect(meshDataVolume(job.resultMesh)).toBeGreaterThan(20 * 20 * 10);

    await expect(
      executeJob(
        "docHollow",
        { document, meshes, layerId: "layer_a", settings: { wallThicknessMm: 2, preserveBaseMm: 0 } },
        cancelling()
      )
    ).rejects.toBeInstanceOf(JobCancelledError);
    await expect(
      executeJob(
        "docThicken",
        { document, meshes, layerId: "layer_a", thicknessMm: 2 },
        cancelling()
      )
    ).rejects.toBeInstanceOf(JobCancelledError);
  }, 120_000);
});

describe("analyzeThickness job", () => {
  it("matches the direct analysis on a thin-walled body", async () => {
    // A 1mm-walled open box: 20x20x10 minus 18x18x10 raised by 1.
    const outer = kernel.box(20, 20, 10, false);
    const inner = kernel.box(18, 18, 10, false).translate(1, 1, 1);
    const shell = outer.subtract(inner);
    const mesh = shell.toMeshData();

    const direct = analyzeThickness(shell, mesh, { minWallMm: 2, minFeatureMm: 0.8 });
    shell.dispose();

    const job = await executeJob(
      "analyzeThickness",
      { mesh, minWallMm: 2, minFeatureMm: 0.8 },
      passive()
    );
    expect(job.issues).toEqual(direct.issues);
    expect(job.triangleThickness).toEqual(direct.triangleThickness);
    // And it genuinely detects the thin wall.
    expect(job.issues.length).toBeGreaterThan(0);
  }, 60_000);

  it("cancellation stops it", async () => {
    const solid = kernel.box(10, 10, 10, false);
    const mesh = solid.toMeshData();
    solid.dispose();
    await expect(
      executeJob("analyzeThickness", { mesh, minWallMm: 2, minFeatureMm: 0.8 }, cancelling())
    ).rejects.toBeInstanceOf(JobCancelledError);
  }, 60_000);
});

describe("buildSupports job", () => {
  /** A table: a slab on four short legs — the slab underside needs support. */
  function tableMesh(): MeshData {
    const top = kernel.box(40, 40, 4, false).translate(0, 0, 10);
    const leg = () => kernel.box(4, 4, 10, false);
    const solid = top
      .union(leg().translate(0, 0, 0))
      .union(leg().translate(36, 0, 0))
      .union(leg().translate(0, 36, 0))
      .union(leg().translate(36, 36, 0));
    const mesh = solid.toMeshData();
    solid.dispose();
    return mesh;
  }

  it("matches the direct call", async () => {
    const mesh = tableMesh();
    const settings = { ...DEFAULT_SUPPORT_SETTINGS, maxOverhangDeg: 50 };
    const direct = buildSupports(kernel, mesh, settings);
    const directMesh = direct.solid ? direct.solid.toMeshData() : null;
    direct.solid?.dispose();

    const job = await executeJob("buildSupports", { mesh, settings }, passive());
    expect(job.result.summaryHe).toBe(direct.result.summaryHe);
    expect(job.result.pillars.length).toBe(direct.result.pillars.length);
    expect(job.mesh !== null).toBe(directMesh !== null);
    if (job.mesh && directMesh) {
      expect(job.mesh.positions).toEqual(directMesh.positions);
      expect(meshDataVolume(job.mesh)).toBeCloseTo(direct.result.volumeMm3, 3);
    }
    // The table genuinely needs supports under its top.
    expect(job.result.pillars.length).toBeGreaterThan(0);
  }, 60_000);

  it("cancellation stops it", async () => {
    const mesh = tableMesh();
    await expect(
      executeJob(
        "buildSupports",
        { mesh, settings: { ...DEFAULT_SUPPORT_SETTINGS, maxOverhangDeg: 50 } },
        cancelling()
      )
    ).rejects.toBeInstanceOf(JobCancelledError);
  }, 60_000);
});
