/**
 * Tests for layer-level geometry operations: booleans, plane cuts, splits,
 * connectors, hollowing, drain holes, thicken, smooth, simplify, repair
 * and placement math.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { DesignDocument, ImportedMeshLayer } from "@/types/design";
import { identityTransform, newId } from "@/types/design";
import { emptyDocument } from "../documentTemplates";
import { getGeometryKernel } from "../kernel";
import { clearMeshStore, getMesh, storeMesh } from "../meshStore";
import { performBoolean } from "../operations/booleans";
import { performPlaneCut, splitDisconnectedParts } from "../operations/cut";
import { addConnectors, computeConnectorPositions, pointInContours } from "../operations/connectors";
import { performDrainHoles, performHollow } from "../operations/hollow";
import { performSimplify, performSmooth, performThicken } from "../operations/meshRefine";
import { OpError } from "../operations/layerOps";
import {
  alignTransforms,
  centerOnPlate,
  distributeTransforms,
  dropToPlate,
  fitToBuildVolumeFactor,
  mirrorTransform,
  placeOnSurface,
  scaleToSize,
  snapToObjectEdge,
} from "../operations/placement";
import { attemptMeshRepair } from "../repair/repair";

beforeEach(() => clearMeshStore());

/** Store a kernel box as an importedMesh layer at the given position. */
async function boxLayer(
  size: [number, number, number],
  position: { x: number; y: number; z: number },
  name = "box"
): Promise<ImportedMeshLayer> {
  const kernel = await getGeometryKernel();
  const solid = kernel.box(size[0], size[1], size[2], true).translate(0, 0, size[2] / 2);
  const mesh = solid.toMeshData();
  solid.dispose();
  const meshId = storeMesh(mesh);
  return {
    id: newId("layer"),
    type: "importedMesh",
    name,
    visible: true,
    locked: false,
    materialSlotId: "slot1",
    transform: { ...identityTransform(), ...position },
    previewOpacity: 1,
    meshId,
    provenance: { kind: "stlImport" },
    originalMeshId: null,
    combine: "standalone",
  };
}

function docWith(layers: ImportedMeshLayer[]): DesignDocument {
  const doc = emptyDocument();
  doc.layers = layers;
  return doc;
}

describe("boolean operations", () => {
  it("union of overlapping boxes yields one merged solid", async () => {
    const a = await boxLayer([10, 10, 10], { x: 0, y: 0, z: 0 });
    const b = await boxLayer([10, 10, 10], { x: 5, y: 0, z: 0 });
    const doc = docWith([a, b]);
    const { layer, warningsHe } = await performBoolean(doc, [a, b], "union");
    expect(warningsHe.length).toBe(0);
    const mesh = getMesh(layer.meshId);
    expect(mesh).not.toBeNull();
    const kernel = await getGeometryKernel();
    const { solid, status } = kernel.fromMeshData(mesh!);
    expect(status).toBe("NoError");
    expect(solid.volumeMm3()).toBeCloseTo(1500, 0);
    solid.dispose();
  });

  it("difference subtracts the second body", async () => {
    const a = await boxLayer([10, 10, 10], { x: 0, y: 0, z: 0 });
    const b = await boxLayer([4, 4, 30], { x: 0, y: 0, z: -10 });
    const doc = docWith([a, b]);
    const { layer } = await performBoolean(doc, [a, b], "difference");
    const kernel = await getGeometryKernel();
    const { solid } = kernel.fromMeshData(getMesh(layer.meshId)!);
    expect(solid.volumeMm3()).toBeCloseTo(1000 - 160, 0);
    solid.dispose();
  });

  it("intersection keeps only the shared volume", async () => {
    const a = await boxLayer([10, 10, 10], { x: 0, y: 0, z: 0 });
    const b = await boxLayer([10, 10, 10], { x: 5, y: 0, z: 0 });
    const doc = docWith([a, b]);
    const { layer } = await performBoolean(doc, [a, b], "intersection");
    const kernel = await getGeometryKernel();
    const { solid } = kernel.fromMeshData(getMesh(layer.meshId)!);
    expect(solid.volumeMm3()).toBeCloseTo(500, 0);
    solid.dispose();
  });

  it("warns when union operands do not overlap", async () => {
    const a = await boxLayer([10, 10, 10], { x: 0, y: 0, z: 0 });
    const b = await boxLayer([10, 10, 10], { x: 50, y: 0, z: 0 });
    const doc = docWith([a, b]);
    const { warningsHe } = await performBoolean(doc, [a, b], "union");
    expect(warningsHe.some((w) => w.includes("אינם חופפים"))).toBe(true);
  });

  it("fails clearly when intersection is empty", async () => {
    const a = await boxLayer([10, 10, 10], { x: 0, y: 0, z: 0 });
    const b = await boxLayer([10, 10, 10], { x: 50, y: 0, z: 0 });
    const doc = docWith([a, b]);
    await expect(performBoolean(doc, [a, b], "intersection")).rejects.toThrow(OpError);
  });
});

describe("plane cut and split", () => {
  it("cuts a box into two capped halves", async () => {
    const a = await boxLayer([10, 10, 20], { x: 0, y: 0, z: 0 });
    const doc = docWith([a]);
    const { layers } = await performPlaneCut(
      doc,
      a,
      { orientation: "xy", offsetMm: 10, rotationX: 0, rotationY: 0 },
      "both"
    );
    expect(layers.length).toBe(2);
    const kernel = await getGeometryKernel();
    for (const part of layers) {
      const { solid, status } = kernel.fromMeshData(getMesh(part.meshId)!);
      expect(status).toBe("NoError"); // capped, closed
      expect(solid.volumeMm3()).toBeCloseTo(1000, 0);
      solid.dispose();
    }
  });

  it("keep=top returns only the upper part", async () => {
    const a = await boxLayer([10, 10, 20], { x: 0, y: 0, z: 0 });
    const doc = docWith([a]);
    const { layers } = await performPlaneCut(
      doc,
      a,
      { orientation: "xy", offsetMm: 15, rotationX: 0, rotationY: 0 },
      "top"
    );
    expect(layers.length).toBe(1);
    const kernel = await getGeometryKernel();
    const { solid } = kernel.fromMeshData(getMesh(layers[0].meshId)!);
    expect(solid.volumeMm3()).toBeCloseTo(500, 0);
    solid.dispose();
  });

  it("errors when the plane misses the object", async () => {
    const a = await boxLayer([10, 10, 10], { x: 0, y: 0, z: 0 });
    const doc = docWith([a]);
    await expect(
      performPlaneCut(doc, a, { orientation: "xy", offsetMm: 100, rotationX: 0, rotationY: 0 }, "both")
    ).rejects.toThrow(OpError);
  });

  it("splits disconnected components", async () => {
    const kernel = await getGeometryKernel();
    const merged = kernel
      .box(10, 10, 10, true)
      .union(kernel.box(10, 10, 10, true).translate(30, 0, 0));
    const meshId = storeMesh(merged.toMeshData());
    merged.dispose();
    const layer: ImportedMeshLayer = {
      ...(await boxLayer([1, 1, 1], { x: 0, y: 0, z: 0 })),
      meshId,
    };
    const doc = docWith([layer]);
    const { layers } = await splitDisconnectedParts(doc, layer);
    expect(layers.length).toBe(2);
  });
});

describe("connectors", () => {
  it("point-in-contours honours holes", () => {
    const outer: [number, number][] = [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ];
    const hole: [number, number][] = [
      [-3, -3],
      [-3, 3],
      [3, 3],
      [3, -3],
    ]; // reversed winding = hole
    expect(pointInContours([outer], 0, 0)).toBe(true);
    expect(pointInContours([outer, hole], 0, 0)).toBe(false);
    expect(pointInContours([outer, hole], 6, 0)).toBe(true);
  });

  it("computes spaced positions inside the section", () => {
    const square: [number, number][][] = [
      [
        [-20, -5],
        [20, -5],
        [20, 5],
        [-20, 5],
      ],
    ];
    const positions = computeConnectorPositions(square, 3, 0);
    expect(positions.length).toBe(3);
    for (const p of positions) {
      expect(Math.abs(p.y)).toBeLessThan(1e-9);
      expect(pointInContours(square, p.x, p.y)).toBe(true);
    }
  });

  it("adds pin/hole pairs that change part volumes correctly", async () => {
    const bottom = await boxLayer([40, 20, 10], { x: 0, y: 0, z: 0 }, "תחתון");
    const top = await boxLayer([40, 20, 10], { x: 0, y: 0, z: 10 }, "עליון");
    const doc = docWith([bottom, top]);
    const def = {
      type: "pin" as const,
      sizeMm: 4,
      depthMm: 3,
      count: 2,
      spacingMm: 0,
      clearanceMm: 0.2,
      edgeMarginMm: 4,
    };
    const plane = { orientation: "xy" as const, offsetMm: 10, rotationX: 0, rotationY: 0 };
    const result = await addConnectors(doc, bottom, top, plane, def);
    expect(result.placedCount).toBe(2);
    const kernel = await getGeometryKernel();
    const male = kernel.fromMeshData(getMesh(result.maleLayer.meshId)!);
    const female = kernel.fromMeshData(getMesh(result.femaleLayer.meshId)!);
    expect(male.status).toBe("NoError");
    expect(female.status).toBe("NoError");
    // Male gains pin volume; female loses hole volume.
    expect(male.solid.volumeMm3()).toBeGreaterThan(8000);
    expect(female.solid.volumeMm3()).toBeLessThan(8000);
    male.solid.dispose();
    female.solid.dispose();
  });

  it("rejects connectors that don't fit the interface", async () => {
    const bottom = await boxLayer([10, 10, 10], { x: 0, y: 0, z: 0 });
    const top = await boxLayer([10, 10, 10], { x: 0, y: 0, z: 10 });
    const doc = docWith([bottom, top]);
    await expect(
      addConnectors(
        doc,
        bottom,
        top,
        { orientation: "xy", offsetMm: 10, rotationX: 0, rotationY: 0 },
        { type: "pin", sizeMm: 8, depthMm: 3, count: 2, spacingMm: 0, clearanceMm: 0.2, edgeMarginMm: 4 }
      )
    ).rejects.toThrow(OpError);
  });
});

describe("hollow / drain / thicken", () => {
  it("hollows a box and reports material saving", async () => {
    const a = await boxLayer([30, 30, 30], { x: 0, y: 0, z: 0 });
    const doc = docWith([a]);
    const result = await performHollow(doc, a, { wallThicknessMm: 2, preserveBaseMm: 0 });
    expect(result.savedFraction).toBeGreaterThan(0.4);
    const kernel = await getGeometryKernel();
    const { solid, status } = kernel.fromMeshData(getMesh(result.layer.meshId)!);
    expect(status).toBe("NoError");
    expect(solid.volumeMm3()).toBeLessThan(result.originalVolumeMm3);
    // genus stays 0, but there must be an internal cavity: 2 components of surface — decompose gives 2 shells? Manifold keeps one solid with internal void → volume check suffices.
    solid.dispose();
  }, 60_000);

  it("preserveBase keeps a solid floor", async () => {
    const a = await boxLayer([30, 30, 30], { x: 0, y: 0, z: 0 });
    const doc = docWith([a]);
    const withFloor = await performHollow(doc, a, { wallThicknessMm: 2, preserveBaseMm: 5 });
    const without = await performHollow(doc, a, { wallThicknessMm: 2, preserveBaseMm: 0 });
    expect(withFloor.hollowVolumeMm3).toBeGreaterThan(without.hollowVolumeMm3);
  }, 60_000);

  it("drain hole reaches the cavity of a hollowed box", async () => {
    const a = await boxLayer([30, 30, 30], { x: 0, y: 0, z: 0 });
    const doc = docWith([a]);
    const hollowed = await performHollow(doc, a, { wallThicknessMm: 2, preserveBaseMm: 0 });
    const doc2 = docWith([hollowed.layer]);
    const drained = await performDrainHoles(doc2, hollowed.layer, [
      {
        diameterMm: 3,
        position: { x: 0, y: 0, z: 30 }, // top centre, drilling down
        direction: { x: 0, y: 0, z: -1 },
        depthMm: 5,
      },
    ]);
    expect(drained.reachedCavity[0]).toBe(true);
    const kernel = await getGeometryKernel();
    const { solid, status } = kernel.fromMeshData(getMesh(drained.layer.meshId)!);
    expect(status).toBe("NoError");
    expect(solid.volumeMm3()).toBeLessThan(hollowed.hollowVolumeMm3);
    solid.dispose();
  }, 60_000);

  it("reports when a drain hole does not reach any cavity", async () => {
    const a = await boxLayer([30, 30, 30], { x: 0, y: 0, z: 0 }); // solid box
    const doc = docWith([a]);
    const drained = await performDrainHoles(doc, a, [
      {
        diameterMm: 3,
        position: { x: 0, y: 0, z: 30 },
        direction: { x: 0, y: 0, z: -1 },
        depthMm: 5,
      },
    ]);
    expect(drained.reachedCavity[0]).toBe(false);
    expect(drained.warningsHe.length).toBeGreaterThan(0);
  }, 60_000);

  it("thicken grows the body", async () => {
    const a = await boxLayer([10, 10, 10], { x: 0, y: 0, z: 0 });
    const doc = docWith([a]);
    const result = await performThicken(doc, a, 2);
    const kernel = await getGeometryKernel();
    const { solid } = kernel.fromMeshData(getMesh(result.layer.meshId)!);
    expect(solid.volumeMm3()).toBeGreaterThan(1000);
    const bounds = solid.boundingBox();
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(14, 0);
    solid.dispose();
  }, 60_000);
});

describe("smooth / simplify / repair", () => {
  it("smooths a mesh while keeping it manifold", async () => {
    const kernel = await getGeometryKernel();
    const sphere = kernel.sphere(10, 24);
    const meshId = storeMesh(sphere.toMeshData());
    sphere.dispose();
    const layer: ImportedMeshLayer = { ...(await boxLayer([1, 1, 1], { x: 0, y: 0, z: 0 })), meshId };
    const doc = docWith([layer]);
    const result = await performSmooth(doc, layer, {
      strength: "standard",
      iterations: 0,
      preserveFeatures: false,
    });
    expect(result.trianglesAfter).toBeGreaterThan(0);
    const { status } = kernel.fromMeshData(getMesh(result.layer.meshId)!);
    expect(status).toBe("NoError");
  });

  it("simplify reduces triangle count", async () => {
    const kernel = await getGeometryKernel();
    const sphere = kernel.sphere(10, 96);
    const meshId = storeMesh(sphere.toMeshData());
    sphere.dispose();
    const layer: ImportedMeshLayer = { ...(await boxLayer([1, 1, 1], { x: 0, y: 0, z: 0 })), meshId };
    const doc = docWith([layer]);
    const result = await performSimplify(doc, layer, { preset: "standard", toleranceMm: 0.15 });
    expect(result.trianglesAfter).toBeLessThan(result.trianglesBefore);
  });

  it("repairs an unwelded (triangle-soup) cube", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(10, 10, 10, true);
    const mesh = box.toMeshData();
    box.dispose();
    // Explode into triangle soup (duplicate vertices per triangle).
    const soupPositions = new Float32Array(mesh.indices.length * 3);
    const soupIndices = new Uint32Array(mesh.indices.length);
    for (let i = 0; i < mesh.indices.length; i++) {
      const v = mesh.indices[i];
      soupPositions[i * 3] = mesh.positions[v * 3];
      soupPositions[i * 3 + 1] = mesh.positions[v * 3 + 1];
      soupPositions[i * 3 + 2] = mesh.positions[v * 3 + 2];
      soupIndices[i] = i;
    }
    const result = await attemptMeshRepair({ positions: soupPositions, indices: soupIndices });
    expect(result.succeeded).toBe(true);
    expect(result.mesh).not.toBeNull();
  });

  it("honestly fails on an unrepairable mesh", async () => {
    const result = await attemptMeshRepair({
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
      indices: new Uint32Array([0, 1, 2]),
    });
    expect(result.succeeded).toBe(false);
    expect(result.messageHe.length).toBeGreaterThan(0);
  });
});

describe("placement math", () => {
  const t = identityTransform();
  const bounds = { min: { x: -5, y: -5, z: 3 }, max: { x: 5, y: 5, z: 13 } };

  it("dropToPlate moves lowest point to z=0 without touching XY", () => {
    const dropped = dropToPlate({ ...t, x: 7, z: 10 }, bounds);
    expect(dropped.z).toBeCloseTo(7);
    expect(dropped.x).toBe(7);
  });

  it("centerOnPlate centres XY only", () => {
    const centred = centerOnPlate({ ...t, x: 2, y: 3, z: 9 }, { min: { x: 10, y: 20, z: 0 }, max: { x: 20, y: 40, z: 5 } });
    expect(centred.x).toBeCloseTo(2 - 15);
    expect(centred.y).toBeCloseTo(3 - 30);
    expect(centred.z).toBe(9);
  });

  it("mirror flips over the object's own centre", () => {
    const mirrored = mirrorTransform({ ...t, x: 10 }, { min: { x: 5, y: -5, z: 0 }, max: { x: 15, y: 5, z: 10 } }, "x");
    expect(mirrored.scaleX * mirrored.scaleY * mirrored.scaleZ).toBeLessThan(0);
    expect(mirrored.x).toBeCloseTo(10, 3); // symmetric bounds around x=10
  });

  it("align to first item's centre", () => {
    const items = [
      { transform: { ...t, x: 0 }, bounds: { min: { x: -5, y: 0, z: 0 }, max: { x: 5, y: 1, z: 1 } } },
      { transform: { ...t, x: 20 }, bounds: { min: { x: 15, y: 0, z: 0 }, max: { x: 25, y: 1, z: 1 } } },
    ];
    const aligned = alignTransforms(items, "x", "center");
    expect(aligned[1].x).toBeCloseTo(0);
  });

  it("distribute spaces centres evenly", () => {
    const mk = (x: number) => ({
      transform: { ...t, x },
      bounds: { min: { x: x - 1, y: 0, z: 0 }, max: { x: x + 1, y: 1, z: 1 } },
    });
    const out = distributeTransforms([mk(0), mk(3), mk(10)], "x");
    expect(out[1].x).toBeCloseTo(5);
  });

  it("placeOnSurface orients +Z to the surface normal", () => {
    const local = { min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 10 } };
    const placed = placeOnSurface(t, local, { x: 20, y: 0, z: 10 }, { x: 1, y: 0, z: 0 }, 0.5);
    expect(placed.rotationY).toBeCloseTo(90, 1);
    expect(placed.x).toBeCloseTo(20.5, 3);
  });

  it("scaleToSize hits the target dimension", () => {
    const scaled = scaleToSize(t, bounds, { axis: "x", targetMm: 20, uniform: false });
    expect(scaled.scaleX).toBeCloseTo(2);
    expect(scaled.scaleY).toBe(1);
    const uniform = scaleToSize(t, bounds, { axis: "longest", targetMm: 5, uniform: true });
    expect(uniform.scaleX).toBeCloseTo(0.5);
    expect(uniform.scaleZ).toBeCloseTo(0.5);
  });

  it("fitToBuildVolumeFactor shrinks oversized models only", () => {
    const big = { min: { x: 0, y: 0, z: 0 }, max: { x: 440, y: 100, z: 100 } };
    const factor = fitToBuildVolumeFactor(big, { x: 220, y: 220, z: 250 });
    expect(factor).toBeLessThan(0.5);
    const small = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
    expect(fitToBuildVolumeFactor(small, { x: 220, y: 220, z: 250 })).toBe(1);
  });

  it("snapToObjectEdge touches the nearest edges", () => {
    const moving = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
    const target = { min: { x: 12, y: 0, z: 0 }, max: { x: 20, y: 10, z: 10 } };
    const snapped = snapToObjectEdge(t, moving, target, "x");
    expect(snapped.x).toBeCloseTo(2); // move min.x(0)+2 → touches target.min 12 with max 12
  });
});
