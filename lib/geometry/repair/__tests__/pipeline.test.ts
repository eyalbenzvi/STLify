/**
 * The repair pipeline end to end, plus self-intersection detection, voxel
 * remeshing and component cleanup. These use the real Manifold kernel: the
 * point of the pipeline is that the kernel ACCEPTS the result, so a mocked
 * kernel would prove nothing.
 */

import { describe, expect, it } from "vitest";
import { getGeometryKernel } from "../../kernel";
import { signedMeshVolume, type MeshData } from "../../meshData";
import { cleanupComponents, splitComponents } from "../cleanup";
import { diagnoseMesh, repairMesh } from "../diagnose";
import { findSelfIntersections, trianglesIntersect } from "../selfIntersection";
import { analyzeTopology } from "../topology";
import { voxelRemesh } from "../voxelRemesh";

function cube(s = 10, offset = { x: 0, y: 0, z: 0 }): MeshData {
  const h = s / 2;
  const raw = [
    -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
    -h, -h, h, h, -h, h, h, h, h, -h, h, h,
  ];
  const positions = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    positions[i] = raw[i] + offset.x;
    positions[i + 1] = raw[i + 1] + offset.y;
    positions[i + 2] = raw[i + 2] + offset.z;
  }
  const indices = new Uint32Array([
    0, 3, 2, 0, 2, 1,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ]);
  return { positions, indices };
}

/** An STL-style mesh: every triangle has its own unwelded vertices. */
function unweld(mesh: MeshData): MeshData {
  const positions = new Float32Array(mesh.indices.length * 3);
  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i];
    positions[i * 3] = mesh.positions[v * 3];
    positions[i * 3 + 1] = mesh.positions[v * 3 + 1];
    positions[i * 3 + 2] = mesh.positions[v * 3 + 2];
    indices[i] = i;
  }
  return { positions, indices };
}

function merge(a: MeshData, b: MeshData): MeshData {
  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);
  const offset = a.positions.length / 3;
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < b.indices.length; i++) {
    indices[a.indices.length + i] = b.indices[i] + offset;
  }
  return { positions, indices };
}

describe("diagnoseMesh", () => {
  it("reports a clean cube as healthy", async () => {
    const diagnosis = await diagnoseMesh(cube());
    expect(diagnosis.kernelAccepts).toBe(true);
    expect(diagnosis.issues).toHaveLength(0);
    expect(diagnosis.topology.isManifold).toBe(true);
  });

  it("reports holes with a location to navigate to", async () => {
    const broken = {
      positions: cube().positions,
      indices: cube().indices.slice(0, 33),
    };
    const diagnosis = await diagnoseMesh(broken);
    const holeIssue = diagnosis.issues.find((i) => i.code === "mesh.holes");
    expect(holeIssue).toBeDefined();
    expect(holeIssue?.severity).toBe("critical");
    expect(holeIssue?.location).toBeDefined();
    expect(holeIssue?.actionHe).toBeTruthy();
  });

  it("reports an inside-out model", async () => {
    const mesh = cube();
    const indices = new Uint32Array(mesh.indices.length);
    for (let i = 0; i < mesh.indices.length; i += 3) {
      indices[i] = mesh.indices[i];
      indices[i + 1] = mesh.indices[i + 2];
      indices[i + 2] = mesh.indices[i + 1];
    }
    const diagnosis = await diagnoseMesh({ positions: mesh.positions, indices });
    expect(diagnosis.issues.some((i) => i.code === "mesh.inverted")).toBe(true);
  });

  it("reports separate components", async () => {
    const diagnosis = await diagnoseMesh(merge(cube(10), cube(2, { x: 40, y: 0, z: 0 })));
    expect(diagnosis.issues.some((i) => i.code === "mesh.components")).toBe(true);
  });

  it("writes every message in Hebrew with an action", async () => {
    const broken = {
      positions: cube().positions,
      indices: cube().indices.slice(0, 30),
    };
    const diagnosis = await diagnoseMesh(broken);
    expect(diagnosis.issues.length).toBeGreaterThan(0);
    for (const issue of diagnosis.issues) {
      expect(issue.titleHe).toMatch(/[֐-׿]/);
      expect(issue.detailHe).toMatch(/[֐-׿]/);
    }
  });
});

describe("repairMesh", () => {
  it("passes through an already-valid mesh without changing it", async () => {
    const report = await repairMesh(cube());
    expect(report.succeeded).toBe(true);
    expect(report.stages).toHaveLength(0);
    expect(report.messageHe).toContain("תקינה");
  });

  it("accepts an unwelded STL-style mesh without running any stage", async () => {
    // Documents a real kernel behaviour: `fromMeshData` calls Mesh.merge()
    // itself, so loose STL triangles are already handled and the pipeline
    // must not claim credit for a repair it did not perform.
    const report = await repairMesh(unweld(cube()));
    expect(report.succeeded).toBe(true);
    expect(report.stages).toHaveLength(0);
    expect(report.messageHe).toContain("תקינה");
  });

  it("closes a hole and reaches a kernel-valid solid", async () => {
    const base = cube();
    const broken = unweld({
      positions: base.positions,
      indices: base.indices.slice(0, 30), // two faces missing
    });
    const report = await repairMesh(broken);
    expect(report.succeeded).toBe(true);
    const fixed = report.mesh as MeshData;
    expect(analyzeTopology(fixed).boundaryEdgeCount).toBe(0);
    expect(report.stages.some((s) => s.stage === "fillHoles" && s.changed)).toBe(true);
    // The repaired cube must still be a 10mm cube.
    expect(Math.abs(signedMeshVolume(fixed))).toBeCloseTo(1000, 1);
  });

  it("fixes mixed winding", async () => {
    const mesh = cube();
    const indices = new Uint32Array(mesh.indices);
    for (const t of [0, 4, 9]) {
      const tmp = indices[t * 3 + 1];
      indices[t * 3 + 1] = indices[t * 3 + 2];
      indices[t * 3 + 2] = tmp;
    }
    const report = await repairMesh({ positions: mesh.positions, indices });
    expect(report.succeeded).toBe(true);
    expect(signedMeshVolume(report.mesh as MeshData)).toBeGreaterThan(0);
  });

  it("reports honestly when every stage is disabled and repair is impossible", async () => {
    const base = cube();
    const broken = {
      positions: base.positions,
      indices: base.indices.slice(0, 30),
    };
    const report = await repairMesh(broken, {
      fillHoles: false,
      removeShells: false,
      allowVoxelRemesh: false,
    });
    expect(report.succeeded).toBe(false);
    expect(report.mesh).toBeNull();
    expect(report.messageHe).toMatch(/[֐-׿]/);
  });

  it("lists the stages it ran, in escalating order", async () => {
    const base = cube();
    const broken = {
      positions: base.positions,
      indices: base.indices.slice(0, 30),
    };
    const report = await repairMesh(broken);
    expect(report.succeeded).toBe(true);
    // Cheap lossless stages are attempted before geometry is invented.
    const order = report.stages.map((s) => s.stage);
    expect(order).toEqual(["weld", "cleanTriangles", "splitVertices", "orient", "fillHoles"]);
    // Only the stage that did the work is marked as having changed anything.
    expect(report.stages.find((s) => s.stage === "fillHoles")?.changed).toBe(true);
    expect(report.stages.find((s) => s.stage === "orient")?.changed).toBe(false);
    // It never reached the destructive rebuild.
    expect(order).not.toContain("voxelRemesh");
  });
});

describe("findSelfIntersections", () => {
  it("finds none in a clean cube", () => {
    const result = findSelfIntersections(cube());
    expect(result.pairCount).toBe(0);
  });

  it("detects two interpenetrating cubes in one mesh", () => {
    // Overlapping by half their width — a classic broken boolean result.
    const result = findSelfIntersections(merge(cube(10), cube(10, { x: 5, y: 0, z: 0 })));
    expect(result.pairCount).toBeGreaterThan(0);
    expect(result.locations.length).toBeGreaterThan(0);
  });

  it("does not flag cubes that merely sit next to each other", () => {
    const result = findSelfIntersections(merge(cube(10), cube(10, { x: 20, y: 0, z: 0 })));
    expect(result.pairCount).toBe(0);
  });

  it("detects a crossing triangle pair directly", () => {
    // Two triangles forming an X.
    const positions = new Float32Array([
      -5, 0, -5, 5, 0, -5, 0, 0, 5,
      0, -5, -5, 0, 5, -5, 0, 0, 5,
    ]);
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    expect(trianglesIntersect({ positions, indices }, 0, 1)).toBe(true);
  });

  it("does not flag coplanar triangles", () => {
    const positions = new Float32Array([
      0, 0, 0, 10, 0, 0, 0, 10, 0,
      1, 1, 0, 5, 1, 0, 1, 5, 0,
    ]);
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    expect(trianglesIntersect({ positions, indices }, 0, 1)).toBe(false);
  });
});

describe("cleanupComponents", () => {
  it("removes a tiny loose fragment", () => {
    const combined = merge(cube(20), cube(0.5, { x: 40, y: 0, z: 0 }));
    expect(splitComponents(combined)).toHaveLength(2);
    const result = cleanupComponents(combined);
    expect(result.smallShellsRemoved).toBe(1);
    expect(splitComponents(result.mesh)).toHaveLength(1);
  });

  it("removes a shell trapped inside a bigger one", () => {
    const combined = merge(cube(20), cube(5));
    const result = cleanupComponents(combined);
    expect(result.interiorShellsRemoved).toBe(1);
    expect(result.removedVolumeMm3).toBeCloseTo(125, 1);
  });

  it("keeps genuinely separate parts of similar size", () => {
    const combined = merge(cube(10), cube(10, { x: 30, y: 0, z: 0 }));
    const result = cleanupComponents(combined);
    expect(result.smallShellsRemoved).toBe(0);
    expect(result.interiorShellsRemoved).toBe(0);
    expect(splitComponents(result.mesh)).toHaveLength(2);
  });
});

describe("voxelRemesh", () => {
  it("rebuilds a cube as a watertight solid of the right size", async () => {
    const result = await voxelRemesh(cube(20), { voxelSizeMm: 0.5 });
    const report = analyzeTopology(result.mesh);
    expect(report.isManifold).toBe(true);
    expect(report.boundaryEdgeCount).toBe(0);
    // Voxelisation rounds the edges, so accept a few percent of shrinkage.
    expect(result.volumeAfterMm3).toBeGreaterThan(8000 * 0.9);
    expect(result.volumeAfterMm3).toBeLessThan(8000 * 1.05);
  });

  it("turns a mesh with a hole into a closed solid", async () => {
    const base = cube(20);
    const broken = {
      positions: base.positions,
      indices: base.indices.slice(0, 30),
    };
    const result = await voxelRemesh(broken, { voxelSizeMm: 0.6 });
    expect(analyzeTopology(result.mesh).isManifold).toBe(true);
    const kernel = await getGeometryKernel();
    const { solid, status } = kernel.fromMeshData(result.mesh);
    expect(status).toBe("NoError");
    solid.dispose();
  });

  it("resolves two interpenetrating cubes into one solid", async () => {
    const combined = merge(cube(10), cube(10, { x: 5, y: 0, z: 0 }));
    expect(findSelfIntersections(combined).pairCount).toBeGreaterThan(0);
    const result = await voxelRemesh(combined, { voxelSizeMm: 0.4 });
    expect(analyzeTopology(result.mesh).isManifold).toBe(true);
    // Union of the two overlapping cubes: 10*10*15 = 1500 mm^3.
    expect(result.volumeAfterMm3).toBeGreaterThan(1500 * 0.88);
    expect(result.volumeAfterMm3).toBeLessThan(1500 * 1.08);
  });

  it("applies a positive offset by growing the solid", async () => {
    const plain = await voxelRemesh(cube(20), { voxelSizeMm: 0.6 });
    const grown = await voxelRemesh(cube(20), { voxelSizeMm: 0.6, offsetMm: 1 });
    expect(grown.volumeAfterMm3).toBeGreaterThan(plain.volumeAfterMm3);
  });
});

describe("self-intersection is invisible to the kernel", () => {
  it("Manifold accepts two interpenetrating shells as valid", async () => {
    // The behaviour the pipeline has to work around: `ofMesh` validates
    // topology only. Both cubes are individually closed, so the kernel
    // reports NoError and a volume that double-counts the overlap
    // (2 x 1000 mm^3 instead of the true union of 1500 mm^3).
    const combined = merge(cube(10), cube(10, { x: 5, y: 0, z: 0 }));
    const kernel = await getGeometryKernel();
    const { solid, status } = kernel.fromMeshData(combined);
    expect(status).toBe("NoError");
    expect(solid.volumeMm3()).toBeCloseTo(2000, 1);
    solid.dispose();
    // ...while the mesh genuinely does self-intersect.
    expect(findSelfIntersections(combined).pairCount).toBeGreaterThan(0);
  });

  it("escalates to the voxel rebuild despite kernel acceptance", async () => {
    const combined = merge(cube(10), cube(10, { x: 5, y: 0, z: 0 }));
    const report = await repairMesh(combined, { voxelSizeMm: 0.4 });
    expect(report.succeeded).toBe(true);
    expect(report.stages.some((s) => s.stage === "voxelRemesh" && s.changed)).toBe(true);
    // The report must admit that detail was lost, and say overlaps were fixed.
    const voxelStage = report.stages.find((s) => s.stage === "voxelRemesh");
    expect(voxelStage?.messageHe).toContain("אבדו");
    expect(voxelStage?.messageHe).toContain("חיתוכים העצמיים");
    // The rebuilt solid has the true union volume, not the double count.
    expect(findSelfIntersections(report.mesh as MeshData).pairCount).toBe(0);
  });

  it("can be told to ignore self-intersections", async () => {
    const combined = merge(cube(10), cube(10, { x: 5, y: 0, z: 0 }));
    const report = await repairMesh(combined, { resolveSelfIntersections: false });
    expect(report.succeeded).toBe(true);
    expect(report.stages).toHaveLength(0);
  });
});
