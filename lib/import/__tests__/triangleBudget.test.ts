/**
 * The import triangle budget: reduce a heavy mesh automatically, say so, and
 * never claim a reduction that did not happen.
 */

import { describe, expect, it } from "vitest";
import { getGeometryKernel, liveSolidCount, type Solid } from "@/lib/geometry/kernel";
import { applyImportTriangleBudget } from "../triangleBudget";

/** A sphere refined until it carries `atLeast` triangles. */
async function heavySphere(atLeast: number) {
  const kernel = await getGeometryKernel();
  let solid = kernel.sphere(20, 64);
  let mesh = solid.toMeshData();
  let length = 2;
  while (mesh.indices.length / 3 < atLeast && length > 0.05) {
    solid = solid.refineToLength(length);
    mesh = solid.toMeshData();
    length /= 2;
  }
  solid.dispose();
  return { kernel, mesh };
}

describe("applyImportTriangleBudget", () => {
  it("leaves a mesh inside the budget completely alone", async () => {
    const kernel = await getGeometryKernel();
    const cube = kernel.box(10, 10, 10, true);
    const mesh = cube.toMeshData();
    cube.dispose();
    const result = await applyImportTriangleBudget(kernel, mesh, 250_000);
    expect(result.mesh).toBe(mesh);
    expect(result.noticeHe).toBeNull();
  });

  it("reduces a mesh over the budget and names both counts", async () => {
    const { kernel, mesh } = await heavySphere(3000);
    const before = mesh.indices.length / 3;
    expect(before).toBeGreaterThan(2000);
    const result = await applyImportTriangleBudget(kernel, mesh, 800);
    const after = result.mesh.indices.length / 3;
    expect(after).toBeLessThan(before);
    expect(result.noticeHe).toContain(before.toLocaleString());
    expect(result.noticeHe).toContain(after.toLocaleString());
    // The honest caveat has to be in the notice, not just in a comment.
    expect(result.noticeHe).toMatch(/מאבד פרטים/);
    // Still a solid the kernel accepts — a reduction that breaks the mesh is
    // worse than no reduction.
    const { solid, status } = kernel.fromMeshData(result.mesh);
    expect(status).toBe("NoError");
    solid.dispose();
  });

  it("frees every kernel handle, including when simplify throws", async () => {
    // The kernel contract says an operation consumes its input and the caller
    // disposes what it abandons; this used to be a manual chain, which leaked
    // the live handle if the kernel threw mid-way. It now runs in a solid
    // scope, so the sweep covers the throwing path too.
    const { kernel, mesh } = await heavySphere(3000);

    const baseline = liveSolidCount();
    await applyImportTriangleBudget(kernel, mesh, 800);
    expect(liveSolidCount(), "happy path").toBe(baseline);

    const broken = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    await applyImportTriangleBudget(kernel, broken, 0);
    expect(liveSolidCount(), "non-manifold early return").toBe(baseline);

    // Make simplify fail on the real handle the budget is holding.
    const failing = {
      ...kernel,
      fromMeshData: (data: typeof mesh) => {
        const made = kernel.fromMeshData(data);
        const solid = made.solid as Solid & { simplify: unknown };
        solid.simplify = () => {
          throw new Error("Manifold: simplify() failed");
        };
        return made;
      },
    };
    await expect(applyImportTriangleBudget(failing, mesh, 800)).rejects.toThrow(/simplify/);
    expect(liveSolidCount(), "throwing simplify").toBe(baseline);
  });

  it("says the reduction did not happen when the mesh is not watertight", async () => {
    const kernel = await getGeometryKernel();
    // One loose triangle: over any budget of 0, and not a manifold.
    const mesh = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const result = await applyImportTriangleBudget(kernel, mesh, 0);
    expect(result.mesh).toBe(mesh);
    expect(result.noticeHe).toMatch(/אינה\s+אטומה/);
  });
});
