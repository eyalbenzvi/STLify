/**
 * Curved-surface embossing and isotropic remeshing.
 *
 * The emboss tests check that wrapped artwork actually LANDS on the target
 * surface (its radius matches the cylinder, the boolean succeeds and changes
 * volume in the right direction), because a wrap that silently floats above
 * or buries itself in the body still produces a valid-looking solid.
 */

import { describe, expect, it } from "vitest";
import { getGeometryKernel, type Contour } from "../../kernel";
import { analyzeTopology } from "../../repair/topology";
import { OpError } from "../layerOps";
import {
  applyEmbossToTarget,
  projectContoursOntoSurface,
  wrapContoursOnCylinder,
} from "../emboss";
import { isotropicRemesh, meanEdgeLength } from "../remesh";

/** A rectangle centred on the origin, in the artwork's flat XY plane. */
function rect(width: number, height: number): Contour {
  const w = width / 2;
  const h = height / 2;
  return [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ];
}

describe("cylindrical wrap", () => {
  it("places the artwork at the cylinder's radius", async () => {
    const kernel = await getGeometryKernel();
    const radius = 20;
    const wrapped = wrapContoursOnCylinder(kernel, [rect(30, 10)], {
      radiusMm: radius,
      depthMm: 1,
      mode: "raised",
      axis: "y",
      aroundDeg: 0,
      alongMm: 0,
    });
    const bounds = wrapped.boundingBox();
    // A raised wrap spans radially from just under the surface to radius+depth.
    const maxRadial = Math.max(
      Math.abs(bounds.max.x),
      Math.abs(bounds.min.x),
      Math.abs(bounds.max.z),
      Math.abs(bounds.min.z)
    );
    expect(maxRadial).toBeGreaterThan(radius);
    expect(maxRadial).toBeLessThanOrEqual(radius + 1 + 1e-3);
    // It stays within the artwork's height along the axis.
    expect(bounds.max.y - bounds.min.y).toBeCloseTo(10, 1);
    wrapped.dispose();
  });

  it("curves the artwork rather than leaving it flat", async () => {
    const kernel = await getGeometryKernel();
    // A wide strip on a small cylinder must bend a long way.
    const wrapped = wrapContoursOnCylinder(kernel, [rect(60, 10)], {
      radiusMm: 15,
      depthMm: 1,
      mode: "raised",
      axis: "y",
      aroundDeg: 0,
      alongMm: 0,
    });
    const bounds = wrapped.boundingBox();
    // 60mm of arc on r=15 is 229 degrees, so the strip wraps past a
    // half-turn and its X extent is the full diameter, not 60mm.
    expect(bounds.max.x - bounds.min.x).toBeLessThan(2 * (15 + 1) + 0.1);
    expect(bounds.max.x - bounds.min.x).toBeGreaterThan(15);
    wrapped.dispose();
  });

  it("embosses onto a real cylinder, adding material", async () => {
    const kernel = await getGeometryKernel();
    const radius = 20;
    const target = kernel.cylinder(radius, 40, 128).translate(0, 0, -20).rotate(90, 0, 0);
    const before = target.volumeMm3();
    const artwork = wrapContoursOnCylinder(kernel, [rect(20, 8)], {
      radiusMm: radius,
      depthMm: 1.2,
      mode: "raised",
      axis: "y",
      aroundDeg: 0,
      alongMm: 0,
    });
    const result = applyEmbossToTarget(target, artwork, "raised");
    expect(result.status()).toBe("NoError");
    // Roughly 20 x 8 x 1.2 of relief added.
    const added = result.volumeMm3() - before;
    expect(added).toBeGreaterThan(150);
    expect(added).toBeLessThan(250);
    expect(analyzeTopology(result.toMeshData()).boundaryEdgeCount).toBe(0);
    result.dispose();
  });

  it("engraves into a cylinder, removing material", async () => {
    const kernel = await getGeometryKernel();
    const radius = 20;
    const target = kernel.cylinder(radius, 40, 128).translate(0, 0, -20).rotate(90, 0, 0);
    const before = target.volumeMm3();
    const artwork = wrapContoursOnCylinder(kernel, [rect(20, 8)], {
      radiusMm: radius,
      depthMm: 1.2,
      mode: "engraved",
      axis: "y",
      aroundDeg: 0,
      alongMm: 0,
    });
    const result = applyEmbossToTarget(target, artwork, "engraved");
    expect(result.status()).toBe("NoError");
    const removed = before - result.volumeMm3();
    expect(removed).toBeGreaterThan(150);
    expect(removed).toBeLessThan(250);
    result.dispose();
  });

  it("rotates the artwork around the cylinder", async () => {
    const kernel = await getGeometryKernel();
    const at0 = wrapContoursOnCylinder(kernel, [rect(10, 6)], {
      radiusMm: 20, depthMm: 1, mode: "raised", axis: "y", aroundDeg: 0, alongMm: 0,
    });
    const at90 = wrapContoursOnCylinder(kernel, [rect(10, 6)], {
      radiusMm: 20, depthMm: 1, mode: "raised", axis: "y", aroundDeg: 90, alongMm: 0,
    });
    // At 0 degrees the artwork sits on +Z; at 90 it sits on +X.
    expect(at0.boundingBox().max.z).toBeGreaterThan(19);
    expect(at90.boundingBox().max.x).toBeGreaterThan(19);
    expect(at90.boundingBox().max.z).toBeLessThan(at0.boundingBox().max.z);
    at0.dispose();
    at90.dispose();
  });

  it("slides the artwork along the axis", async () => {
    const kernel = await getGeometryKernel();
    const shifted = wrapContoursOnCylinder(kernel, [rect(10, 6)], {
      radiusMm: 20, depthMm: 1, mode: "raised", axis: "y", aroundDeg: 0, alongMm: 12,
    });
    const bounds = shifted.boundingBox();
    expect((bounds.min.y + bounds.max.y) / 2).toBeCloseTo(12, 1);
    shifted.dispose();
  });

  it("refuses artwork wider than the circumference", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      wrapContoursOnCylinder(kernel, [rect(200, 10)], {
        radiusMm: 5, depthMm: 1, mode: "raised", axis: "y", aroundDeg: 0, alongMm: 0,
      })
    ).toThrow(/רחב מהיקף/);
  });

  it("orients onto the requested world axis", async () => {
    const kernel = await getGeometryKernel();
    const alongZ = wrapContoursOnCylinder(kernel, [rect(10, 20)], {
      radiusMm: 15, depthMm: 1, mode: "raised", axis: "z", aroundDeg: 0, alongMm: 0,
    });
    // With the cylinder axis on Z, the artwork's 20mm height runs along Z.
    const bounds = alongZ.boundingBox();
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(20, 1);
    alongZ.dispose();
  });
});

describe("surface projection", () => {
  it("lands artwork on a sphere's surface", async () => {
    const kernel = await getGeometryKernel();
    const radius = 25;
    const target = kernel.sphere(radius, 64);
    const { solid, hitFraction } = projectContoursOntoSurface(
      kernel,
      [rect(14, 14)],
      target,
      { depthMm: 1.5, mode: "raised", direction: { x: 0, y: 0, z: -1 } }
    );
    // Nearly every vertex should find the sphere.
    expect(hitFraction).toBeGreaterThan(0.9);
    // The projected artwork sits on the top of the sphere, not at z = 0.
    const bounds = solid.boundingBox();
    expect(bounds.max.z).toBeGreaterThan(radius - 1);
    expect(bounds.max.z).toBeLessThan(radius + 2);
    solid.dispose();
    target.dispose();
  });

  it("embosses onto a dome and keeps it watertight", async () => {
    const kernel = await getGeometryKernel();
    const target = kernel.sphere(25, 64);
    const before = target.volumeMm3();
    const { solid } = projectContoursOntoSurface(
      kernel,
      [rect(12, 12)],
      target.duplicate(),
      { depthMm: 1.5, mode: "raised", direction: { x: 0, y: 0, z: -1 } }
    );
    const result = applyEmbossToTarget(target, solid, "raised");
    expect(result.status()).toBe("NoError");
    expect(result.volumeMm3()).toBeGreaterThan(before);
    expect(analyzeTopology(result.toMeshData()).boundaryEdgeCount).toBe(0);
    result.dispose();
  });

  it("reports a low hit fraction when the artwork misses the target", async () => {
    const kernel = await getGeometryKernel();
    // A small target far from the artwork's footprint.
    const target = kernel.sphere(3, 32).translate(200, 0, 0);
    const { solid, hitFraction } = projectContoursOntoSurface(
      kernel,
      [rect(10, 10)],
      target,
      { depthMm: 1, mode: "raised", direction: { x: 0, y: 0, z: -1 } }
    );
    expect(hitFraction).toBe(0);
    solid.dispose();
    target.dispose();
  });

  it("rejects a zero projection direction", async () => {
    const kernel = await getGeometryKernel();
    const target = kernel.sphere(10, 16);
    expect(() =>
      projectContoursOntoSurface(kernel, [rect(5, 5)], target, {
        depthMm: 1, mode: "raised", direction: { x: 0, y: 0, z: 0 },
      })
    ).toThrow(OpError);
    target.dispose();
  });
});

describe("isotropic remesh", () => {
  it("drives the mean edge length towards the target", async () => {
    const kernel = await getGeometryKernel();
    const sphere = kernel.sphere(20, 24);
    const mesh = sphere.toMeshData();
    sphere.dispose();
    const before = meanEdgeLength(mesh);

    const result = isotropicRemesh(mesh, {
      targetEdgeMm: 2,
      iterations: 4,
      featureAngleDeg: 40,
    });
    // The starting mesh is much coarser than 2mm.
    expect(before).toBeGreaterThan(3);
    // Remeshing must move the mean substantially towards the target.
    expect(result.meanEdgeMm).toBeLessThan(before);
    expect(Math.abs(result.meanEdgeMm - 2)).toBeLessThan(Math.abs(before - 2));
    expect(result.trianglesAfter).toBeGreaterThan(result.trianglesBefore);
  });

  it("makes edge lengths more uniform", async () => {
    const kernel = await getGeometryKernel();
    // A stretched box has wildly uneven edges.
    const box = kernel.box(80, 8, 8, true);
    const mesh = box.toMeshData();
    box.dispose();

    const spread = (m: { positions: Float32Array; indices: Uint32Array }) => {
      const lengths: number[] = [];
      for (let t = 0; t < m.indices.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          const a = m.indices[t + k] * 3;
          const b = m.indices[t + ((k + 1) % 3)] * 3;
          lengths.push(
            Math.hypot(
              m.positions[b] - m.positions[a],
              m.positions[b + 1] - m.positions[a + 1],
              m.positions[b + 2] - m.positions[a + 2]
            )
          );
        }
      }
      const mean = lengths.reduce((s, v) => s + v, 0) / lengths.length;
      const variance =
        lengths.reduce((s, v) => s + (v - mean) ** 2, 0) / lengths.length;
      return Math.sqrt(variance) / mean;
    };

    const before = spread(mesh);
    const result = isotropicRemesh(mesh, {
      targetEdgeMm: 4,
      iterations: 4,
      featureAngleDeg: 30,
    });
    expect(spread(result.mesh)).toBeLessThan(before);
  });

  it("keeps a cube's corners sharp", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(20, 20, 20, true);
    const mesh = box.toMeshData();
    box.dispose();

    const result = isotropicRemesh(mesh, {
      targetEdgeMm: 3,
      iterations: 3,
      featureAngleDeg: 30,
    });
    // Feature vertices are pinned, so the box keeps its exact size instead
    // of being rounded off by relaxation.
    const bounds = { min: Infinity, max: -Infinity };
    for (let i = 0; i < result.mesh.positions.length; i += 3) {
      bounds.min = Math.min(bounds.min, result.mesh.positions[i]);
      bounds.max = Math.max(bounds.max, result.mesh.positions[i]);
    }
    expect(bounds.min).toBeCloseTo(-10, 4);
    expect(bounds.max).toBeCloseTo(10, 4);
  });

  it("keeps the surface closed", async () => {
    const kernel = await getGeometryKernel();
    const sphere = kernel.sphere(15, 32);
    const mesh = sphere.toMeshData();
    sphere.dispose();
    const result = isotropicRemesh(mesh, {
      targetEdgeMm: 2.5,
      iterations: 3,
      featureAngleDeg: 45,
    });
    const report = analyzeTopology(result.mesh);
    expect(report.boundaryEdgeCount).toBe(0);
    expect(report.nonManifoldEdgeCount).toBe(0);
  });

  it("refuses a target so fine it would produce millions of triangles", async () => {
    const kernel = await getGeometryKernel();
    const sphere = kernel.sphere(50, 64);
    const mesh = sphere.toMeshData();
    sphere.dispose();
    expect(() =>
      isotropicRemesh(mesh, { targetEdgeMm: 0.01, iterations: 3, featureAngleDeg: 30 })
    ).toThrow(/קטן מדי/);
  });

  it("rejects a non-positive target", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(10, 10, 10, true);
    const mesh = box.toMeshData();
    box.dispose();
    expect(() =>
      isotropicRemesh(mesh, { targetEdgeMm: 0, iterations: 2, featureAngleDeg: 30 })
    ).toThrow(OpError);
  });
});
