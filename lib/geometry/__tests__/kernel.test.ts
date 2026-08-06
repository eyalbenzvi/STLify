/**
 * Kernel extension tests: booleans, transforms, plane cuts, slicing,
 * simplification and mesh round-trips, all against the real Manifold WASM.
 */

import { describe, expect, it } from "vitest";
import { getGeometryKernel, type Contour } from "../kernel";

const SQUARE: Contour[] = [
  [
    [-5, -5],
    [5, -5],
    [5, 5],
    [-5, 5],
  ],
];

describe("geometry kernel", () => {
  it("intersects two boxes", async () => {
    const kernel = await getGeometryKernel();
    const a = kernel.box(10, 10, 10, true);
    const b = kernel.box(10, 10, 10, true).translate(5, 0, 0);
    const result = a.intersect(b);
    expect(result.volumeMm3()).toBeCloseTo(500, 0);
    expect(result.status()).toBe("NoError");
    result.dispose();
  });

  it("splits by a plane into two capped solids", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(10, 10, 10, true);
    const [above, below] = box.splitByPlane(0, 0, 1, 0);
    expect(above.volumeMm3()).toBeCloseTo(500, 0);
    expect(below.volumeMm3()).toBeCloseTo(500, 0);
    expect(above.status()).toBe("NoError");
    expect(below.status()).toBe("NoError");
    above.dispose();
    below.dispose();
  });

  it("slices to polygons without consuming the solid", async () => {
    const kernel = await getGeometryKernel();
    const cylinder = kernel.cylinder(5, 10);
    const polys = cylinder.slicePolygons(5);
    expect(polys.length).toBe(1);
    expect(polys[0].length).toBeGreaterThan(8);
    expect(cylinder.volumeMm3()).toBeGreaterThan(700); // still alive
    cylinder.dispose();
  });

  it("offsets contours inward and outward", async () => {
    const kernel = await getGeometryKernel();
    const inset = kernel.offsetContours(SQUARE, -2);
    expect(inset.length).toBe(1);
    const bounds = inset[0].flat();
    expect(Math.max(...bounds)).toBeCloseTo(3, 1);
    const gone = kernel.offsetContours(SQUARE, -6);
    expect(gone.length).toBe(0);
  });

  it("decomposes disconnected parts", async () => {
    const kernel = await getGeometryKernel();
    const a = kernel.box(5, 5, 5);
    const b = kernel.box(5, 5, 5).translate(20, 0, 0);
    const parts = a.union(b).decompose();
    expect(parts.length).toBe(2);
    parts.forEach((p) => p.dispose());
  });

  it("simplifies a sphere", async () => {
    const kernel = await getGeometryKernel();
    const sphere = kernel.sphere(10, 96);
    const before = sphere.numTriangles();
    const simplified = sphere.simplify(0.5);
    expect(simplified.numTriangles()).toBeLessThan(before / 2);
    expect(simplified.status()).toBe("NoError");
    simplified.dispose();
  });

  it("round-trips mesh data through fromMeshData", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(10, 20, 30, true);
    const mesh = box.toMeshData();
    box.dispose();
    const { solid, status } = kernel.fromMeshData(mesh);
    expect(status).toBe("NoError");
    expect(solid.volumeMm3()).toBeCloseTo(6000, 0);
    solid.dispose();
  });

  it("reports non-manifold input meshes", async () => {
    const kernel = await getGeometryKernel();
    const openTriangle = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const { solid, status } = kernel.fromMeshData(openTriangle);
    expect(status).not.toBe("NoError");
    solid.dispose();
  });

  it("duplicate() keeps a handle across consuming calls", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(10, 10, 10, true);
    const copy = box.duplicate();
    const moved = box.translate(100, 0, 0); // consumes box
    expect(copy.volumeMm3()).toBeCloseTo(1000, 0);
    expect(moved.boundingBox().min.x).toBeGreaterThan(90);
    copy.dispose();
    moved.dispose();
  });

  it("applies mirror and full matrix transforms", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(10, 10, 10).mirror(1, 0, 0);
    const bounds = box.boundingBox();
    expect(bounds.min.x).toBeCloseTo(-10, 5);
    expect(bounds.max.x).toBeCloseTo(0, 5);
    expect(box.status()).toBe("NoError");
    expect(box.volumeMm3()).toBeCloseTo(1000, 0);
    box.dispose();
  });

  it("casts rays and reports hits", async () => {
    const kernel = await getGeometryKernel();
    const sphere = kernel.sphere(5, 32);
    const hits = sphere.rayCast({ x: 0, y: 0, z: -20 }, { x: 0, y: 0, z: 20 });
    expect(hits.length).toBe(2);
    expect(hits[0].position.z).toBeCloseTo(-5, 1);
    sphere.dispose();
  });
});
