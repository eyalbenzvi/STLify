/**
 * Sub-object selection and the direct-modelling operations built on it.
 *
 * The cube fixture is deliberately the awkward case: every logical face is
 * two triangles, so "select the top of the box" only works if coplanar
 * growth is right, and push/pull only works if the boundary loop of those
 * two triangles is traced correctly.
 */

import { describe, expect, it } from "vitest";
import { getGeometryKernel } from "../../kernel";
import { signedMeshVolume, type MeshData } from "../../meshData";
import { analyzeTopology } from "../../repair/topology";
import {
  buildAdjacency,
  growSelection,
  isSelectionPlanar,
  selectionArea,
  selectionBoundaryLoops,
  selectionCenter,
  selectionNormal,
} from "../meshAdjacency";
import {
  deleteRegion,
  pushPullRegion,
  smoothRegion,
  splitByRegion,
  summarizeRegion,
} from "../regionOps";

/** Welded cube of side `s`, sitting with its centre on the origin. */
function cube(s = 20): MeshData {
  const h = s / 2;
  return {
    positions: new Float32Array([
      -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
      -h, -h, h, h, -h, h, h, h, h, -h, h, h,
    ]),
    indices: new Uint32Array([
      0, 3, 2, 0, 2, 1, // bottom, -Z   (triangles 0,1)
      4, 5, 6, 4, 6, 7, // top,    +Z   (triangles 2,3)
      0, 1, 5, 0, 5, 4, // -Y           (triangles 4,5)
      1, 2, 6, 1, 6, 5, // +X           (triangles 6,7)
      2, 3, 7, 2, 7, 6, // +Y           (triangles 8,9)
      3, 0, 4, 3, 4, 7, // -X           (triangles 10,11)
    ]),
  };
}

describe("buildAdjacency", () => {
  it("gives every triangle of a closed cube three neighbours", () => {
    const adjacency = buildAdjacency(cube());
    expect(adjacency.triangleCount).toBe(12);
    for (let i = 0; i < adjacency.neighbours.length; i++) {
      expect(adjacency.neighbours[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it("computes correct normals and areas", () => {
    const adjacency = buildAdjacency(cube(20));
    // Triangle 2 is on the top face: normal +Z.
    expect(adjacency.normals[2 * 3 + 2]).toBeCloseTo(1, 5);
    // Each face is 400 mm^2, split into two 200 mm^2 triangles.
    expect(adjacency.areas[2]).toBeCloseTo(200, 4);
  });

  it("leaves boundary edges unlinked on an open mesh", () => {
    const mesh = cube();
    const open = { positions: mesh.positions, indices: mesh.indices.slice(0, 30) };
    const adjacency = buildAdjacency(open);
    let unlinked = 0;
    for (let i = 0; i < adjacency.neighbours.length; i++) {
      if (adjacency.neighbours[i] === -1) unlinked++;
    }
    expect(unlinked).toBeGreaterThan(0);
  });
});

describe("growSelection", () => {
  it("coplanar growth selects exactly one face of a cube", () => {
    const adjacency = buildAdjacency(cube());
    const selected = growSelection(adjacency, 2, {
      mode: "coplanar",
      angleToleranceDeg: 5,
    });
    // The top face is triangles 2 and 3 — and nothing else.
    expect(selected).toEqual(new Set([2, 3]));
  });

  it("connected growth selects the whole shell", () => {
    const adjacency = buildAdjacency(cube());
    const selected = growSelection(adjacency, 0, {
      mode: "connected",
      angleToleranceDeg: 0,
    });
    expect(selected.size).toBe(12);
  });

  it("triangle mode selects only the seed", () => {
    const adjacency = buildAdjacency(cube());
    expect(
      growSelection(adjacency, 7, { mode: "triangle", angleToleranceDeg: 0 })
    ).toEqual(new Set([7]));
  });

  it("a loose tolerance wraps a cylinder, a tight one does not", async () => {
    const kernel = await getGeometryKernel();
    const cylinder = kernel.cylinder(10, 20, 32);
    const mesh = cylinder.toMeshData();
    cylinder.dispose();
    const adjacency = buildAdjacency(mesh);
    // Find a triangle on the curved wall (normal nearly horizontal).
    let wallTriangle = -1;
    for (let t = 0; t < adjacency.triangleCount; t++) {
      if (Math.abs(adjacency.normals[t * 3 + 2]) < 0.1) {
        wallTriangle = t;
        break;
      }
    }
    expect(wallTriangle).toBeGreaterThanOrEqual(0);

    const tight = growSelection(adjacency, wallTriangle, {
      mode: "coplanar",
      angleToleranceDeg: 2,
    });
    const loose = growSelection(adjacency, wallTriangle, {
      mode: "coplanar",
      angleToleranceDeg: 30,
    });
    // A 32-sided cylinder turns 11.25 degrees per facet: 2 degrees stops at
    // the facet, 30 degrees follows the barrel all the way round.
    expect(loose.size).toBeGreaterThan(tight.size);
    expect(tight.size).toBeLessThan(8);
  });

  it("similarNormal bounds total drift, unlike coplanar", async () => {
    const kernel = await getGeometryKernel();
    const cylinder = kernel.cylinder(10, 20, 64);
    const mesh = cylinder.toMeshData();
    cylinder.dispose();
    const adjacency = buildAdjacency(mesh);
    let wallTriangle = -1;
    for (let t = 0; t < adjacency.triangleCount; t++) {
      if (Math.abs(adjacency.normals[t * 3 + 2]) < 0.1) {
        wallTriangle = t;
        break;
      }
    }
    const coplanar = growSelection(adjacency, wallTriangle, {
      mode: "coplanar",
      angleToleranceDeg: 20,
    });
    const similar = growSelection(adjacency, wallTriangle, {
      mode: "similarNormal",
      angleToleranceDeg: 20,
    });
    // Chained tolerance walks the whole barrel; seed-relative tolerance
    // stops after roughly 40 degrees of arc.
    expect(similar.size).toBeLessThan(coplanar.size);
  });
});

describe("selection geometry", () => {
  it("reports the face normal, area and centre", () => {
    const mesh = cube(20);
    const adjacency = buildAdjacency(mesh);
    const top = growSelection(adjacency, 2, { mode: "coplanar", angleToleranceDeg: 5 });
    const normal = selectionNormal(adjacency, top);
    expect(normal.z).toBeCloseTo(1, 5);
    expect(selectionArea(adjacency, top)).toBeCloseTo(400, 3);
    const center = selectionCenter(mesh, adjacency, top);
    expect(center.z).toBeCloseTo(10, 5);
    expect(center.x).toBeCloseTo(0, 5);
  });

  it("traces a four-vertex boundary loop around one cube face", () => {
    const mesh = cube();
    const adjacency = buildAdjacency(mesh);
    const top = growSelection(adjacency, 2, { mode: "coplanar", angleToleranceDeg: 5 });
    const loops = selectionBoundaryLoops(mesh, top);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
  });

  it("recognises planar and non-planar selections", () => {
    const mesh = cube();
    const adjacency = buildAdjacency(mesh);
    const top = growSelection(adjacency, 2, { mode: "coplanar", angleToleranceDeg: 5 });
    expect(isSelectionPlanar(mesh, adjacency, top)).toBe(true);
    // Two adjacent faces are not coplanar.
    expect(isSelectionPlanar(mesh, adjacency, new Set([2, 3, 6, 7]))).toBe(false);
  });
});

describe("push / pull", () => {
  it("pulling the top face outward increases the volume by exactly the prism", async () => {
    const kernel = await getGeometryKernel();
    const mesh = cube(20);
    const { solid } = kernel.fromMeshData(mesh);
    const adjacency = buildAdjacency(mesh);
    const top = growSelection(adjacency, 2, { mode: "coplanar", angleToleranceDeg: 5 });

    const result = pushPullRegion(kernel, solid, mesh, top, { distanceMm: 5 });
    // 20x20x20 plus a 20x20x5 slab.
    expect(result.volumeMm3()).toBeCloseTo(8000 + 2000, 1);
    expect(result.boundingBox().max.z).toBeCloseTo(15, 2);
    expect(result.status()).toBe("NoError");
    result.dispose();
  });

  it("pushing the top face inward removes exactly the prism", async () => {
    const kernel = await getGeometryKernel();
    const mesh = cube(20);
    const { solid } = kernel.fromMeshData(mesh);
    const adjacency = buildAdjacency(mesh);
    const top = growSelection(adjacency, 2, { mode: "coplanar", angleToleranceDeg: 5 });

    const result = pushPullRegion(kernel, solid, mesh, top, { distanceMm: -5 });
    expect(result.volumeMm3()).toBeCloseTo(8000 - 2000, 1);
    expect(result.boundingBox().max.z).toBeCloseTo(5, 2);
    result.dispose();
  });

  it("works on a side face, moving along that face's own normal", async () => {
    const kernel = await getGeometryKernel();
    const mesh = cube(20);
    const { solid } = kernel.fromMeshData(mesh);
    const adjacency = buildAdjacency(mesh);
    // Triangle 6 is on the +X face.
    const side = growSelection(adjacency, 6, { mode: "coplanar", angleToleranceDeg: 5 });
    expect(selectionNormal(adjacency, side).x).toBeCloseTo(1, 5);

    const result = pushPullRegion(kernel, solid, mesh, side, { distanceMm: 4 });
    expect(result.volumeMm3()).toBeCloseTo(8000 + 20 * 20 * 4, 1);
    expect(result.boundingBox().max.x).toBeCloseTo(14, 2);
    result.dispose();
  });

  it("refuses a non-planar selection with a Hebrew explanation", async () => {
    const kernel = await getGeometryKernel();
    const mesh = cube(20);
    const { solid } = kernel.fromMeshData(mesh);
    expect(() =>
      pushPullRegion(kernel, solid, mesh, new Set([2, 3, 6, 7]), { distanceMm: 3 })
    ).toThrow(/מישורית/);
  });
});

describe("local smoothing", () => {
  it("moves only interior vertices, pinning the region boundary", async () => {
    const kernel = await getGeometryKernel();
    // A sphere has enough vertices for a region to have an interior.
    const sphere = kernel.sphere(10, 32);
    const mesh = sphere.toMeshData();
    sphere.dispose();
    const adjacency = buildAdjacency(mesh);
    const cap = growSelection(adjacency, 0, { mode: "similarNormal", angleToleranceDeg: 40 });
    expect(cap.size).toBeGreaterThan(4);

    const smoothed = smoothRegion(mesh, cap, { iterations: 5, strength: 0.6 });
    // Same topology.
    expect(smoothed.indices).toBe(mesh.indices);
    // Something moved...
    let moved = 0;
    for (let i = 0; i < mesh.positions.length; i++) {
      if (Math.abs(smoothed.positions[i] - mesh.positions[i]) > 1e-6) moved++;
    }
    expect(moved).toBeGreaterThan(0);
    // ...but boundary vertices of the region did not.
    const loops = selectionBoundaryLoops(mesh, cap);
    for (const loop of loops) {
      for (const v of loop) {
        expect(smoothed.positions[v * 3]).toBeCloseTo(mesh.positions[v * 3], 9);
        expect(smoothed.positions[v * 3 + 1]).toBeCloseTo(mesh.positions[v * 3 + 1], 9);
        expect(smoothed.positions[v * 3 + 2]).toBeCloseTo(mesh.positions[v * 3 + 2], 9);
      }
    }
  });

  it("leaves the rest of the model untouched", async () => {
    const kernel = await getGeometryKernel();
    const sphere = kernel.sphere(10, 32);
    const mesh = sphere.toMeshData();
    sphere.dispose();
    const adjacency = buildAdjacency(mesh);
    const cap = growSelection(adjacency, 0, { mode: "similarNormal", angleToleranceDeg: 30 });
    const smoothed = smoothRegion(mesh, cap, { iterations: 4, strength: 0.5 });

    // Any vertex not in the region must be identical.
    const inRegion = new Set<number>();
    for (const t of cap) {
      inRegion.add(mesh.indices[t * 3]);
      inRegion.add(mesh.indices[t * 3 + 1]);
      inRegion.add(mesh.indices[t * 3 + 2]);
    }
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      if (inRegion.has(v)) continue;
      expect(smoothed.positions[v * 3]).toBe(mesh.positions[v * 3]);
    }
  });

  it("refuses a selection with no interior", () => {
    const mesh = cube();
    // A single triangle: all three of its vertices are on the boundary.
    expect(() => smoothRegion(mesh, new Set([2]), { iterations: 3, strength: 0.5 })).toThrow(
      /קטנה מדי/
    );
  });
});

describe("delete region", () => {
  it("removes the face and caps the hole, keeping the body closed", () => {
    const mesh = cube(20);
    const adjacency = buildAdjacency(mesh);
    const top = growSelection(adjacency, 2, { mode: "coplanar", angleToleranceDeg: 5 });

    const result = deleteRegion(mesh, top, { cap: true });
    expect(result.trianglesRemoved).toBe(2);
    expect(result.capped).toBe(true);
    const report = analyzeTopology(result.mesh);
    expect(report.boundaryEdgeCount).toBe(0);
    // The cap sits back in the same plane, so the cube is restored.
    expect(Math.abs(signedMeshVolume(result.mesh))).toBeCloseTo(8000, 1);
  });

  it("leaves the hole open when capping is off", () => {
    const mesh = cube(20);
    const adjacency = buildAdjacency(mesh);
    const top = growSelection(adjacency, 2, { mode: "coplanar", angleToleranceDeg: 5 });
    const result = deleteRegion(mesh, top, { cap: false });
    expect(result.capped).toBe(false);
    expect(analyzeTopology(result.mesh).boundaryEdgeCount).toBe(4);
  });

  it("refuses to delete the entire body", () => {
    const mesh = cube();
    const all = new Set(Array.from({ length: 12 }, (_, i) => i));
    expect(() => deleteRegion(mesh, all)).toThrow(/כל הפאות/);
  });
});

describe("split by region", () => {
  it("produces two closed bodies whose volumes sum to the original", () => {
    const mesh = cube(20);
    const adjacency = buildAdjacency(mesh);
    // Take the whole top half: top face plus the upper halves of the sides
    // is awkward, so use a clean cut — the top face alone.
    const top = growSelection(adjacency, 2, { mode: "coplanar", angleToleranceDeg: 5 });

    const { regionMesh, remainderMesh } = splitByRegion(mesh, top);
    // Both halves must be sealed.
    expect(analyzeTopology(regionMesh).boundaryEdgeCount).toBe(0);
    expect(analyzeTopology(remainderMesh).boundaryEdgeCount).toBe(0);
    // The patch is flat, so it encloses no volume; the remainder keeps it all.
    expect(Math.abs(signedMeshVolume(regionMesh))).toBeLessThan(1);
    expect(Math.abs(signedMeshVolume(remainderMesh))).toBeCloseTo(8000, 1);
    // Each half carries only its own vertices.
    expect(regionMesh.positions.length / 3).toBeLessThan(mesh.positions.length / 3);
  });

  it("splits a sphere cap into a real closed body", async () => {
    const kernel = await getGeometryKernel();
    const sphere = kernel.sphere(10, 32);
    const mesh = sphere.toMeshData();
    sphere.dispose();
    const adjacency = buildAdjacency(mesh);
    const cap = growSelection(adjacency, 0, { mode: "similarNormal", angleToleranceDeg: 45 });

    const { regionMesh, remainderMesh } = splitByRegion(mesh, cap);
    expect(analyzeTopology(regionMesh).boundaryEdgeCount).toBe(0);
    expect(analyzeTopology(remainderMesh).boundaryEdgeCount).toBe(0);
    // A curved cap DOES enclose volume once sealed with a flat patch.
    expect(Math.abs(signedMeshVolume(regionMesh))).toBeGreaterThan(0);
    const total =
      Math.abs(signedMeshVolume(regionMesh)) + Math.abs(signedMeshVolume(remainderMesh));
    const original = (4 / 3) * Math.PI * 1000;
    expect(total).toBeGreaterThan(original * 0.9);
    expect(total).toBeLessThan(original * 1.1);
  });

  it("refuses to split off the whole body", () => {
    const mesh = cube();
    const all = new Set(Array.from({ length: 12 }, (_, i) => i));
    expect(() => splitByRegion(mesh, all)).toThrow(/כל הגוף/);
  });
});

describe("summarizeRegion", () => {
  it("reports facts the properties panel needs", () => {
    const mesh = cube(20);
    const adjacency = buildAdjacency(mesh);
    const top = growSelection(adjacency, 2, { mode: "coplanar", angleToleranceDeg: 5 });
    const summary = summarizeRegion(mesh, adjacency, top);
    expect(summary.triangleCount).toBe(2);
    expect(summary.areaMm2).toBeCloseTo(400, 3);
    expect(summary.planar).toBe(true);
    expect(summary.normal.z).toBeCloseTo(1, 5);
    expect(summary.boundaryLoopCount).toBe(1);
    expect(summary.closedAfterRemoval).toBe(true);
  });
});
