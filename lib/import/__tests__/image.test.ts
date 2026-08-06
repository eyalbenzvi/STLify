/**
 * Image import tests: marching-squares silhouettes and closed relief
 * height-field solids, verified through the real geometry kernel.
 */

import { describe, expect, it } from "vitest";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import {
  gridToSilhouetteContours,
  heightFieldToClosedMesh,
  smoothGrid,
  type LuminanceGrid,
} from "../image";

/** Grid with a dark disk (luminance 0) on a light background (1). */
function diskGrid(size: number, radius: number, holeRadius = 0): LuminanceGrid {
  const values = new Float32Array(size * size).fill(1);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d <= radius && d >= holeRadius) values[y * size + x] = 0;
    }
  }
  return { width: size, height: size, values };
}

describe("gridToSilhouetteContours", () => {
  it("traces a disk whose extruded volume matches π·r²·h", async () => {
    const grid = diskGrid(64, 20);
    const contours = gridToSilhouetteContours(grid, {
      threshold: 0.5,
      invert: false,
      pixelSizeMm: 1,
    });
    expect(contours.length).toBeGreaterThanOrEqual(1);
    const kernel = await getGeometryKernel();
    const solid = kernel.extrude(contours, 5);
    const expected = Math.PI * 20 * 20 * 5;
    expect(Math.abs(solid.volumeMm3() - expected) / expected).toBeLessThan(0.15);
    solid.dispose();
  });

  it("annulus produces a hole (genus 1 after extrusion)", async () => {
    const grid = diskGrid(64, 24, 10);
    const contours = gridToSilhouetteContours(grid, {
      threshold: 0.5,
      invert: false,
      pixelSizeMm: 1,
    });
    expect(contours.length).toBeGreaterThanOrEqual(2);
    const kernel = await getGeometryKernel();
    const solid = kernel.extrude(contours, 4);
    expect(solid.genus()).toBe(1);
    const expected = Math.PI * (24 * 24 - 10 * 10) * 4;
    expect(Math.abs(solid.volumeMm3() - expected) / expected).toBeLessThan(0.2);
    solid.dispose();
  });

  it("invert flips which region is solid", async () => {
    const grid = diskGrid(48, 14);
    const normal = gridToSilhouetteContours(grid, {
      threshold: 0.5,
      invert: false,
      pixelSizeMm: 1,
    });
    const inverted = gridToSilhouetteContours(grid, {
      threshold: 0.5,
      invert: true,
      pixelSizeMm: 1,
    });
    const kernel = await getGeometryKernel();
    const a = kernel.extrude(normal, 2);
    const b = kernel.extrude(inverted, 2);
    // Inverted region (background square minus disk) is much larger.
    expect(b.volumeMm3()).toBeGreaterThan(a.volumeMm3());
    a.dispose();
    b.dispose();
  });
});

describe("heightFieldToClosedMesh", () => {
  it("builds a manifold solid with the expected height range", async () => {
    // Diagonal ramp.
    const size = 32;
    const values = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) values[y * size + x] = x / (size - 1);
    }
    const mesh = heightFieldToClosedMesh(
      { width: size, height: size, values },
      { pixelSizeMm: 1, minThicknessMm: 1, reliefHeightMm: 4, invert: false }
    );
    const kernel = await getGeometryKernel();
    const { solid, status } = kernel.fromMeshData(mesh);
    expect(status).toBe("NoError");
    expect(solid.volumeMm3()).toBeGreaterThan(0);
    const bounds = solid.boundingBox();
    expect(bounds.min.z).toBeCloseTo(0, 4);
    expect(bounds.max.z).toBeCloseTo(5, 1); // 1 + 4 at the dark end
    solid.dispose();
  });
});

describe("smoothGrid", () => {
  it("reduces variance", () => {
    const size = 16;
    const values = new Float32Array(size * size);
    for (let i = 0; i < values.length; i++) values[i] = i % 2; // checkerboard
    const smoothed = smoothGrid({ width: size, height: size, values }, 2);
    const variance = (arr: Float32Array) => {
      const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
      return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
    };
    expect(variance(smoothed.values)).toBeLessThan(variance(values));
  });
});
