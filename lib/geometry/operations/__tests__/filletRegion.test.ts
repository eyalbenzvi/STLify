/**
 * Local fillet on a selected region (V6 item 20).
 *
 * The DoD, measured: the SELECTED region's edge is rounded (a corner probe
 * point that was solid becomes empty), the edges OUTSIDE the region stay
 * sharp (their corner probes stay solid), and the result passes the
 * manifold gate (kernel status + volume sanity).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getGeometryKernel, type Solid } from "../../kernel";
import type { MeshData } from "../../meshData";
import { filletRegion } from "../filletRegion";
import { OpError } from "../layerOps";

let kernel: Awaited<ReturnType<typeof getGeometryKernel>>;

beforeAll(async () => {
  kernel = await getGeometryKernel();
});

/** Point-in-solid via ray parity (rayCast does not consume). */
function contains(solid: Solid, x: number, y: number, z: number): boolean {
  const hits = solid.rayCast({ x: x - 1000, y: y + 0.001, z: z + 0.002 }, { x, y, z });
  return hits.length % 2 === 1;
}

/** Triangles of a mesh whose centroids satisfy a predicate. */
function trianglesWhere(
  mesh: MeshData,
  predicate: (cx: number, cy: number, cz: number) => boolean
): Set<number> {
  const out = new Set<number>();
  const count = mesh.indices.length / 3;
  for (let t = 0; t < count; t++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k] * 3;
      cx += mesh.positions[v] / 3;
      cy += mesh.positions[v + 1] / 3;
      cz += mesh.positions[v + 2] / 3;
    }
    if (predicate(cx, cy, cz)) out.add(t);
  }
  return out;
}

describe("filletRegion", () => {
  it("rounds ONLY the selected end of a bar and stays watertight", async () => {
    // A 60×20×10 bar, refined so the region has triangles to select.
    const bar = kernel.box(60, 20, 10, false).refineToLength(4);
    const mesh = bar.toMeshData();
    bar.dispose();

    // Select the top face near the +X end (x > 52): the zone will cover the
    // end's edges; the -X end must remain untouched.
    const region = trianglesWhere(mesh, (cx, _cy, cz) => cx > 52 && cz > 9.9);
    expect(region.size).toBeGreaterThan(3);

    const outcome = filletRegion(kernel, mesh, region, {
      sizeMm: 2,
      style: "fillet",
      scope: "convex",
    });
    // The seam caveat must be said out loud, not shipped silently.
    expect(outcome.warningsHe.join(" ")).toContain("מדרגה");

    const { solid: result, status } = kernel.fromMeshData(outcome.mesh);
    // WATERTIGHT: the gate the whole item hangs on.
    expect(status).toBe("NoError");
    expect(result.isEmpty()).toBe(false);

    // The SELECTED end's top edge is rounded: a probe hugging the corner
    // (0.4mm inside each face) was solid and is now air.
    expect(contains(result, 59.6, 10, 9.6)).toBe(false);
    // The UNSELECTED end's corner stays sharp: same probe, still solid.
    expect(contains(result, 0.4, 10, 9.6)).toBe(true);
    // Deep body material is untouched at both ends.
    expect(contains(result, 55, 10, 5)).toBe(true);
    expect(contains(result, 5, 10, 5)).toBe(true);

    // Volume dropped (convex rounding removes material) but only by a
    // fillet-sized amount, not by a body-sized one.
    const volume = result.volumeMm3();
    expect(volume).toBeLessThan(60 * 20 * 10);
    expect(volume).toBeGreaterThan(60 * 20 * 10 - 400);
    result.dispose();
  }, 120_000);

  it("refuses an empty selection and a non-positive radius", async () => {
    const box = kernel.box(10, 10, 10, false);
    const mesh = box.toMeshData();
    box.dispose();
    expect(() =>
      filletRegion(kernel, mesh, new Set(), { sizeMm: 2, style: "fillet", scope: "convex" })
    ).toThrow(OpError);
    expect(() =>
      filletRegion(kernel, mesh, new Set([0]), { sizeMm: 0, style: "fillet", scope: "convex" })
    ).toThrow(OpError);
  });

  it("concave scope adds material only inside the zone", async () => {
    // An L-shape: a step with a concave edge along Y at x=20, z=5.
    const base = kernel.box(40, 20, 5, false);
    const wall = kernel.box(20, 20, 10, false);
    const ell = base.union(wall).refineToLength(3);
    const mesh = ell.toMeshData();
    const originalVolume = ell.volumeMm3();
    ell.dispose();

    // Select faces near the concave corner, on the near-Y part only.
    const region = trianglesWhere(
      mesh,
      (cx, cy, cz) => cx > 15 && cx < 30 && cy < 8 && cz > 4 && cz < 11
    );
    expect(region.size).toBeGreaterThan(0);

    const outcome = filletRegion(kernel, mesh, region, {
      sizeMm: 2,
      style: "fillet",
      scope: "concave",
    });
    const { solid: result, status } = kernel.fromMeshData(outcome.mesh);
    expect(status).toBe("NoError");
    // Concave rounding ADDS a web of material in the corner.
    expect(result.volumeMm3()).toBeGreaterThan(originalVolume);
    // A probe hugging the concave corner (outside the r=2 arc) is now
    // solid inside the selected zone…
    expect(contains(result, 20.3, 5, 5.3)).toBe(true);
    // …while far along the same edge, outside the zone, it is still air.
    expect(contains(result, 20.3, 19.7, 5.3)).toBe(false);
    result.dispose();
  }, 120_000);
});
