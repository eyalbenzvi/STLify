/**
 * Exercises the V4 kernel additions against the real Manifold WASM module:
 * new primitives, revolve, twist/taper extrusion, level sets, warping and
 * refinement. Every assertion checks real geometry (volume, bounds, genus),
 * never just "it returned something".
 */

import { describe, expect, it } from "vitest";
import { getGeometryKernel, type Contour } from "../kernel";

const SQUARE: Contour = [
  [-5, -5],
  [5, -5],
  [5, 5],
  [-5, 5],
];

describe("kernel: new primitives", () => {
  it("builds a cone with the analytic frustum volume", async () => {
    const kernel = await getGeometryKernel();
    const solid = kernel.cone(10, 5, 20, 256);
    // V = (pi h / 3)(R^2 + Rr + r^2) = (pi*20/3)(100+50+25)
    const expected = ((Math.PI * 20) / 3) * (100 + 50 + 25);
    expect(solid.volumeMm3()).toBeCloseTo(expected, -1);
    const bounds = solid.boundingBox();
    expect(bounds.min.z).toBeCloseTo(0, 5);
    expect(bounds.max.z).toBeCloseTo(20, 5);
    solid.dispose();
  });

  it("builds a torus with genus 1 and the analytic volume", async () => {
    const kernel = await getGeometryKernel();
    const solid = kernel.torus(20, 5, 128);
    // V = 2 pi^2 R r^2
    const expected = 2 * Math.PI * Math.PI * 20 * 25;
    expect(solid.volumeMm3()).toBeGreaterThan(expected * 0.97);
    expect(solid.volumeMm3()).toBeLessThan(expected * 1.01);
    expect(solid.genus()).toBe(1);
    const bounds = solid.boundingBox();
    expect(bounds.max.x).toBeCloseTo(25, 1);
    expect(bounds.max.z).toBeCloseTo(5, 1);
    solid.dispose();
  });
});

describe("kernel: revolve", () => {
  it("revolves a square profile into an annular ring", async () => {
    const kernel = await getGeometryKernel();
    // A 2x3 rectangle from x=10..12, y=0..3 → a ring of that cross-section.
    const profile: Contour = [
      [10, 0],
      [12, 0],
      [12, 3],
      [10, 3],
    ];
    const solid = kernel.revolve([profile], 360, 256);
    // Pappus: V = 2 pi * centroidRadius * area = 2pi * 11 * 6
    const expected = 2 * Math.PI * 11 * 6;
    expect(solid.volumeMm3()).toBeGreaterThan(expected * 0.97);
    expect(solid.volumeMm3()).toBeLessThan(expected * 1.01);
    expect(solid.genus()).toBe(1);
    solid.dispose();
  });

  it("revolves partially, producing a solid wedge (genus 0)", async () => {
    const kernel = await getGeometryKernel();
    const profile: Contour = [
      [10, 0],
      [12, 0],
      [12, 3],
      [10, 3],
    ];
    const solid = kernel.revolve([profile], 90, 128);
    const full = 2 * Math.PI * 11 * 6;
    expect(solid.volumeMm3()).toBeGreaterThan(full * 0.24);
    expect(solid.volumeMm3()).toBeLessThan(full * 0.26);
    expect(solid.genus()).toBe(0);
    solid.dispose();
  });
});

describe("kernel: advanced extrusion", () => {
  it("tapers the top uniformly, matching the square-frustum volume", async () => {
    const kernel = await getGeometryKernel();
    const solid = kernel.extrudeAdvanced([SQUARE], 10, { scaleTop: 0.5 });
    // Square frustum: h/3 * (a^2 + ab + b^2) with a = 10, b = 5.
    const expected = (10 / 3) * (100 + 50 + 25);
    expect(solid.volumeMm3()).toBeCloseTo(expected, 3);
    solid.dispose();
  });

  it("broadcasts a scalar scaleTop to both axes", async () => {
    // Regression guard: Manifold's scalar scaleTop overload collapses Y to
    // zero, so the kernel must expand a number into an explicit [x, y] pair.
    const kernel = await getGeometryKernel();
    const scalar = kernel.extrudeAdvanced([SQUARE], 10, { scaleTop: 0.5 });
    const pair = kernel.extrudeAdvanced([SQUARE], 10, { scaleTop: [0.5, 0.5] });
    expect(scalar.volumeMm3()).toBeCloseTo(pair.volumeMm3(), 6);
    // The top cross-section must be a real 5x5 square, not a degenerate line.
    const top = scalar.slicePolygons(9.999);
    const ys = top.flat().map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(5, 2);
    scalar.dispose();
    pair.dispose();
  });

  it("twists volume-neutrally, converging as divisions increase", async () => {
    const kernel = await getGeometryKernel();
    // A pure twist is rigid per cross-section, so the exact volume is the
    // straight prism's. Ruled side faces are triangulated, so coarse
    // division counts overshoot and must converge downward.
    const straightVolume = 10 * 10 * 10;
    const coarse = kernel.extrudeAdvanced([SQUARE], 10, { divisions: 4, twistDegrees: 90 });
    const fine = kernel.extrudeAdvanced([SQUARE], 10, { divisions: 60, twistDegrees: 90 });
    const coarseError = Math.abs(coarse.volumeMm3() - straightVolume);
    const fineError = Math.abs(fine.volumeMm3() - straightVolume);
    expect(fineError).toBeLessThan(coarseError);
    expect(fineError / straightVolume).toBeLessThan(0.02);
    expect(fine.numTriangles()).toBeGreaterThan(coarse.numTriangles());
    coarse.dispose();
    fine.dispose();
  });
});

describe("kernel: level set", () => {
  it("reproduces a sphere from its signed-distance function", async () => {
    const kernel = await getGeometryKernel();
    const radius = 10;
    const solid = kernel.levelSet(
      (p) => radius - Math.hypot(p.x, p.y, p.z),
      { min: { x: -12, y: -12, z: -12 }, max: { x: 12, y: 12, z: 12 } },
      0.6
    );
    const expected = (4 / 3) * Math.PI * radius ** 3;
    expect(solid.volumeMm3()).toBeGreaterThan(expected * 0.97);
    expect(solid.volumeMm3()).toBeLessThan(expected * 1.03);
    expect(solid.status()).toBe("NoError");
    solid.dispose();
  });
});

describe("kernel: warp, refine, project, split", () => {
  it("warp moves vertices without changing topology", async () => {
    const kernel = await getGeometryKernel();
    const before = kernel.box(10, 10, 10, true);
    const triangles = before.numTriangles();
    // Shear: x grows with z.
    const after = before.warp((p) => ({ x: p.x + p.z * 0.5, y: p.y, z: p.z }));
    expect(after.numTriangles()).toBe(triangles);
    // Shear preserves volume.
    expect(after.volumeMm3()).toBeCloseTo(1000, 3);
    expect(after.boundingBox().max.x).toBeCloseTo(7.5, 3);
    after.dispose();
  });

  it("refineToLength subdivides long edges", async () => {
    const kernel = await getGeometryKernel();
    const coarse = kernel.box(10, 10, 10, true);
    const before = coarse.numTriangles();
    const fine = coarse.refineToLength(2);
    expect(fine.numTriangles()).toBeGreaterThan(before * 4);
    // Refinement of a flat-faced box must not change its volume.
    expect(fine.volumeMm3()).toBeCloseTo(1000, 3);
    fine.dispose();
  });

  it("projectToXY returns the footprint outline", async () => {
    const kernel = await getGeometryKernel();
    const solid = kernel.box(10, 6, 3, true);
    const contours = solid.projectToXY();
    expect(contours.length).toBe(1);
    const xs = contours[0].map((p) => p[0]);
    const ys = contours[0].map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10, 3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(6, 3);
    solid.dispose();
  });

  it("splitBySolid partitions volume exactly", async () => {
    const kernel = await getGeometryKernel();
    const target = kernel.box(10, 10, 10, true);
    // Cutter covers the x > 0 half.
    const cutter = kernel.box(10, 20, 20, true).translate(5, 0, 0);
    const [inside, outside] = target.splitBySolid(cutter);
    expect(inside.volumeMm3()).toBeCloseTo(500, 3);
    expect(outside.volumeMm3()).toBeCloseTo(500, 3);
    inside.dispose();
    outside.dispose();
  });
});
