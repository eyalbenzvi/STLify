import { describe, expect, it } from "vitest";
import { heightmapToMeshArrays } from "../heightmapSolid";
import { getGeometryKernel } from "../kernel";

function flatField(cols: number, rows: number, height: number): Float32Array {
  return new Float32Array(cols * rows).fill(height);
}

/** Every edge of a closed 2-manifold is used by exactly two triangles. */
function edgeManifold(triVerts: Uint32Array): boolean {
  const use = new Map<string, number>();
  for (let i = 0; i < triVerts.length; i += 3) {
    const t = [triVerts[i], triVerts[i + 1], triVerts[i + 2]];
    for (let e = 0; e < 3; e++) {
      const a = t[e];
      const b = t[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  }
  return [...use.values()].every((count) => count === 2);
}

describe("heightmap solid construction", () => {
  it("produces an edge-manifold closed mesh", () => {
    const mesh = heightmapToMeshArrays({
      cols: 5,
      rows: 4,
      widthMm: 10,
      heightMm: 8,
      heights: flatField(5, 4, 2),
    });
    expect(mesh.vertProperties.length).toBe(5 * 4 * 2 * 3);
    expect(edgeManifold(mesh.triVerts)).toBe(true);
  });

  it("converts to a Manifold solid with the expected volume", async () => {
    const kernel = await getGeometryKernel();
    const mesh = heightmapToMeshArrays({
      cols: 6,
      rows: 6,
      widthMm: 10,
      heightMm: 10,
      heights: flatField(6, 6, 3),
    });
    const solid = kernel.fromMeshArrays(mesh);
    expect(solid.isEmpty()).toBe(false);
    // 10 × 10 × 3 flat slab.
    expect(solid.volume()).toBeCloseTo(300, 0);
    const box = solid.boundingBox();
    expect(box.min[2]).toBeCloseTo(0, 5);
    expect(box.max[2]).toBeCloseTo(3, 5);
    solid.dispose();
  });

  it("supports varying heights and clamps the floor", async () => {
    const kernel = await getGeometryKernel();
    const cols = 8;
    const rows = 8;
    const heights = new Float32Array(cols * rows);
    for (let i = 0; i < heights.length; i++) heights[i] = (i % cols) / (cols - 1) * 2;
    const mesh = heightmapToMeshArrays({ cols, rows, widthMm: 10, heightMm: 10, heights });
    const solid = kernel.fromMeshArrays(mesh);
    expect(solid.isEmpty()).toBe(false);
    expect(solid.volume()).toBeGreaterThan(0);
    solid.dispose();
  });

  it("rejects malformed input", () => {
    expect(() =>
      heightmapToMeshArrays({ cols: 1, rows: 4, widthMm: 10, heightMm: 8, heights: flatField(1, 4, 1) })
    ).toThrow();
    expect(() =>
      heightmapToMeshArrays({ cols: 3, rows: 3, widthMm: 10, heightMm: 8, heights: flatField(2, 2, 1) })
    ).toThrow();
  });
});
