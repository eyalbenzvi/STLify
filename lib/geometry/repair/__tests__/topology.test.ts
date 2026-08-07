/**
 * Topology analysis and structural repair, driven by deliberately broken
 * meshes: holes, flipped winding, bowtie vertices, duplicate and degenerate
 * triangles. Each test asserts the defect is *detected* and then *fixed*.
 */

import { describe, expect, it } from "vitest";
import type { MeshData } from "../../meshData";
import {
  analyzeTopology,
  countComponents,
  orientConsistently,
  removeDegenerateTriangles,
  removeDuplicateTriangles,
  removeUnusedVertices,
  splitNonManifoldVertices,
} from "../topology";
import { signedMeshVolume } from "../../meshData";
import { fillHoles } from "../holeFill";

/** A welded unit cube of side `s` centred on the origin: 8 verts, 12 tris. */
function cube(s = 10): MeshData {
  const h = s / 2;
  const positions = new Float32Array([
    -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
    -h, -h, h, h, -h, h, h, h, h, -h, h, h,
  ]);
  // Outward-facing (CCW seen from outside).
  const indices = new Uint32Array([
    0, 3, 2, 0, 2, 1, // bottom (z = -h), normal -Z
    4, 5, 6, 4, 6, 7, // top (z = +h), normal +Z
    0, 1, 5, 0, 5, 4, // y = -h
    1, 2, 6, 1, 6, 5, // x = +h
    2, 3, 7, 2, 7, 6, // y = +h
    3, 0, 4, 3, 4, 7, // x = -h
  ]);
  return { positions, indices };
}

function withoutTriangles(mesh: MeshData, count: number): MeshData {
  return {
    positions: mesh.positions,
    indices: mesh.indices.slice(0, mesh.indices.length - count * 3),
  };
}

describe("analyzeTopology", () => {
  it("reports a clean cube as manifold", () => {
    const report = analyzeTopology(cube());
    expect(report.isManifold).toBe(true);
    expect(report.boundaryEdgeCount).toBe(0);
    expect(report.nonManifoldEdgeCount).toBe(0);
    expect(report.inconsistentEdgeCount).toBe(0);
    expect(report.componentCount).toBe(1);
    expect(report.triangleCount).toBe(12);
    expect(report.signedVolumeMm3).toBeCloseTo(1000, 5);
  });

  it("finds a triangular hole left by one deleted face", () => {
    const report = analyzeTopology(withoutTriangles(cube(), 1));
    expect(report.isManifold).toBe(false);
    expect(report.boundaryEdgeCount).toBe(3);
    expect(report.boundaryLoops).toHaveLength(1);
    expect(report.boundaryLoops[0].vertices).toHaveLength(3);
  });

  it("finds a square hole left by a deleted quad face", () => {
    // The last two triangles form the x = -h face.
    const report = analyzeTopology(withoutTriangles(cube(), 2));
    expect(report.boundaryLoops).toHaveLength(1);
    expect(report.boundaryLoops[0].vertices).toHaveLength(4);
    expect(report.boundaryLoops[0].perimeterMm).toBeCloseTo(40, 5);
  });

  it("detects inconsistent winding", () => {
    const mesh = cube();
    const indices = new Uint32Array(mesh.indices);
    // Flip a single triangle.
    const tmp = indices[1];
    indices[1] = indices[2];
    indices[2] = tmp;
    const report = analyzeTopology({ positions: mesh.positions, indices });
    expect(report.inconsistentEdgeCount).toBeGreaterThan(0);
    expect(report.isManifold).toBe(false);
  });

  it("counts separate components", () => {
    const a = cube(10);
    const b = cube(4);
    const positions = new Float32Array(a.positions.length + b.positions.length);
    positions.set(a.positions, 0);
    for (let i = 0; i < b.positions.length; i += 3) {
      positions[a.positions.length + i] = b.positions[i] + 50;
      positions[a.positions.length + i + 1] = b.positions[i + 1];
      positions[a.positions.length + i + 2] = b.positions[i + 2];
    }
    const offset = a.positions.length / 3;
    const indices = new Uint32Array(a.indices.length + b.indices.length);
    indices.set(a.indices, 0);
    for (let i = 0; i < b.indices.length; i++) {
      indices[a.indices.length + i] = b.indices[i] + offset;
    }
    expect(countComponents({ positions, indices })).toBe(2);
  });
});

describe("orientConsistently", () => {
  it("repairs a single flipped triangle", () => {
    const mesh = cube();
    const indices = new Uint32Array(mesh.indices);
    const tmp = indices[1];
    indices[1] = indices[2];
    indices[2] = tmp;
    const broken = { positions: mesh.positions, indices };
    expect(analyzeTopology(broken).inconsistentEdgeCount).toBeGreaterThan(0);

    const { mesh: fixed, flipped } = orientConsistently(broken);
    expect(flipped).toBeGreaterThan(0);
    const report = analyzeTopology(fixed);
    expect(report.inconsistentEdgeCount).toBe(0);
    expect(report.isManifold).toBe(true);
    expect(report.signedVolumeMm3).toBeCloseTo(1000, 5);
  });

  it("turns a fully inside-out mesh outward", () => {
    const mesh = cube();
    const indices = new Uint32Array(mesh.indices.length);
    for (let i = 0; i < mesh.indices.length; i += 3) {
      indices[i] = mesh.indices[i];
      indices[i + 1] = mesh.indices[i + 2];
      indices[i + 2] = mesh.indices[i + 1];
    }
    const inverted = { positions: mesh.positions, indices };
    // Consistently wound, but pointing the wrong way.
    expect(analyzeTopology(inverted).inconsistentEdgeCount).toBe(0);
    expect(signedMeshVolume(inverted)).toBeCloseTo(-1000, 5);

    const { mesh: fixed } = orientConsistently(inverted);
    expect(signedMeshVolume(fixed)).toBeCloseTo(1000, 5);
  });

  it("leaves an already-correct mesh untouched", () => {
    const { flipped } = orientConsistently(cube());
    expect(flipped).toBe(0);
  });
});

describe("cleanup helpers", () => {
  it("removes degenerate triangles", () => {
    const mesh = cube();
    const indices = new Uint32Array([...mesh.indices, 0, 0, 1, 2, 3, 3]);
    const { mesh: cleaned, removed } = removeDegenerateTriangles({
      positions: mesh.positions,
      indices,
    });
    expect(removed).toBe(2);
    expect(cleaned.indices.length).toBe(mesh.indices.length);
  });

  it("removes zero-area triangles made of distinct collinear vertices", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const { removed } = removeDegenerateTriangles({ positions, indices });
    expect(removed).toBe(1);
  });

  it("removes duplicate triangles regardless of rotation", () => {
    const mesh = cube();
    // Same triple, rotated start point.
    const indices = new Uint32Array([...mesh.indices, 3, 2, 0]);
    const { removed } = removeDuplicateTriangles({ positions: mesh.positions, indices });
    expect(removed).toBe(1);
  });

  it("compacts unused vertices and rewrites indices", () => {
    const mesh = cube();
    const positions = new Float32Array(mesh.positions.length + 3);
    positions.set(mesh.positions, 0);
    positions[mesh.positions.length] = 99; // orphan vertex
    const { mesh: cleaned, removed } = removeUnusedVertices({
      positions,
      indices: mesh.indices,
    });
    expect(removed).toBe(1);
    expect(cleaned.positions.length / 3).toBe(8);
    expect(analyzeTopology(cleaned).isManifold).toBe(true);
  });
});

describe("splitNonManifoldVertices", () => {
  it("separates two cubes joined at a single bowtie vertex", () => {
    // Two tetrahedra sharing exactly one vertex.
    const positions = new Float32Array([
      0, 0, 0, // 0 — the shared vertex
      1, 0, 0, 0, 1, 0, 0, 0, 1,
      -1, 0, 0, 0, -1, 0, 0, 0, -1,
    ]);
    const indices = new Uint32Array([
      0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2,
      0, 5, 4, 0, 6, 5, 0, 4, 6, 4, 5, 6,
    ]);
    const before = { positions, indices };
    expect(countComponents(before)).toBe(1);

    const { mesh: fixed, split } = splitNonManifoldVertices(before);
    expect(split).toBe(1);
    // Now they are two independent closed solids.
    expect(countComponents(fixed)).toBe(2);
    expect(analyzeTopology(fixed).boundaryEdgeCount).toBe(0);
  });

  it("leaves a clean cube untouched", () => {
    const { split } = splitNonManifoldVertices(cube());
    expect(split).toBe(0);
  });
});

describe("fillHoles", () => {
  it("closes a triangular hole and restores the exact volume", () => {
    const broken = withoutTriangles(cube(), 1);
    const result = fillHoles(broken);
    expect(result.filled).toBe(1);
    expect(result.trianglesAdded).toBe(1);
    const report = analyzeTopology(result.mesh);
    expect(report.boundaryEdgeCount).toBe(0);
    expect(report.isManifold).toBe(true);
    // The patch replaces exactly the removed triangle, so volume is restored.
    expect(report.signedVolumeMm3).toBeCloseTo(1000, 4);
  });

  it("closes a square hole with a correctly wound patch", () => {
    const broken = withoutTriangles(cube(), 2);
    const result = fillHoles(broken);
    expect(result.filled).toBe(1);
    const report = analyzeTopology(result.mesh);
    expect(report.isManifold).toBe(true);
    // Positive volume proves the patch faces outward like its neighbours.
    expect(report.signedVolumeMm3).toBeCloseTo(1000, 4);
  });

  it("closes several holes in one pass", () => {
    const mesh = cube();
    // Drop the first triangle of the bottom face and the whole top face.
    const kept: number[] = [];
    for (let t = 0; t < 12; t++) {
      if (t === 0 || t === 2 || t === 3) continue;
      kept.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
    }
    const broken = { positions: mesh.positions, indices: new Uint32Array(kept) };
    expect(analyzeTopology(broken).boundaryLoops.length).toBe(2);

    const result = fillHoles(broken);
    expect(result.filled).toBe(2);
    const report = analyzeTopology(result.mesh);
    expect(report.isManifold).toBe(true);
    expect(report.signedVolumeMm3).toBeCloseTo(1000, 4);
  });

  it("respects the maximum-perimeter limit", () => {
    const broken = withoutTriangles(cube(), 2); // 40 mm perimeter
    const result = fillHoles(broken, { maxPerimeterMm: 10 });
    expect(result.filled).toBe(0);
    expect(result.skipped).toBe(1);
    expect(analyzeTopology(result.mesh).boundaryEdgeCount).toBe(4);
  });

  it("is a no-op on a closed mesh", () => {
    const result = fillHoles(cube());
    expect(result.filled).toBe(0);
    expect(result.trianglesAdded).toBe(0);
  });
});
