/**
 * Mask/depth post-processing: the bridges between model outputs and the
 * EXISTING silhouette tracer and height-field mesher. The depth tests run
 * through the real mesher so the assertion is about geometry, not arrays.
 */

import { describe, expect, it } from "vitest";
import {
  gridToSilhouetteContours,
  heightFieldToClosedMesh,
} from "@/lib/import/image";
import { meshDataBounds } from "@/lib/geometry/meshData";
import { AI_MASK_THRESHOLD, maskCoverage, saliencyToMaskGrid } from "../segmentation";
import { depthToReliefGrid } from "../depth";

/** A saliency map with a solid centred square of probability `p`. */
function squareMap(size: number, half: number, p = 1): Float32Array {
  const map = new Float32Array(size * size);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.abs(x - c) <= half && Math.abs(y - c) <= half) map[y * size + x] = p;
    }
  }
  return map;
}

describe("saliencyToMaskGrid", () => {
  it("encodes subject as dark below the fixed threshold", () => {
    const grid = saliencyToMaskGrid(squareMap(16, 4), 16, 16, 16, 16);
    const centre = grid.values[8 * 16 + 8];
    const corner = grid.values[0];
    expect(centre).toBeLessThan(AI_MASK_THRESHOLD);
    expect(corner).toBeGreaterThan(AI_MASK_THRESHOLD);
  });

  it("restores the image aspect when resampling the square map", () => {
    // Map is square (model input), grid is 2:1 — the subject must survive.
    const grid = saliencyToMaskGrid(squareMap(16, 5), 16, 16, 32, 16);
    expect(grid.width).toBe(32);
    expect(grid.height).toBe(16);
    expect(grid.values[8 * 32 + 16]).toBeLessThan(AI_MASK_THRESHOLD);
  });

  it("traces to a closed contour through the existing silhouette tracer", () => {
    const grid = saliencyToMaskGrid(squareMap(32, 8), 32, 32, 32, 32);
    const contours = gridToSilhouetteContours(grid, {
      threshold: AI_MASK_THRESHOLD,
      invert: false,
      pixelSizeMm: 1,
    });
    expect(contours.length).toBe(1);
    // A ~17px square at 1mm/px → area around 289 mm².
    let area = 0;
    const loop = contours[0];
    for (let i = 0; i < loop.length; i++) {
      const [x1, y1] = loop[i];
      const [x2, y2] = loop[(i + 1) % loop.length];
      area += x1 * y2 - x2 * y1;
    }
    expect(Math.abs(area / 2)).toBeGreaterThan(200);
    expect(Math.abs(area / 2)).toBeLessThan(400);
  });

  it("clamps out-of-range probabilities", () => {
    const map = new Float32Array([-0.5, 1.5, 0.5, 0]);
    const grid = saliencyToMaskGrid(map, 2, 2, 2, 2);
    expect(grid.values[0]).toBe(1);
    expect(grid.values[1]).toBe(0);
  });

  it("maskCoverage reports the solid fraction", () => {
    expect(maskCoverage(new Float32Array([1, 1, 0, 0]))).toBe(0.5);
    expect(maskCoverage(new Float32Array())).toBe(0);
  });
});

describe("depthToReliefGrid", () => {
  it("maps near (depth 1) to dark so the mesher raises it", () => {
    const depth = new Float32Array([1, 0, 0.5, 0]);
    const grid = depthToReliefGrid(depth, 2, 2, { gridWidth: 2, gridHeight: 2 });
    expect(grid.values[0]).toBeCloseTo(0, 6);
    expect(grid.values[1]).toBeCloseTo(1, 6);
    expect(grid.values[2]).toBeCloseTo(0.5, 6);
  });

  it("floors pixels the segmentation calls background", () => {
    const depth = new Float32Array(4).fill(1); // everything near
    const mask = new Float32Array([1, 0, 1, 0]); // half background
    const grid = depthToReliefGrid(depth, 2, 2, {
      gridWidth: 2,
      gridHeight: 2,
      mask: { map: mask, width: 2, height: 2 },
    });
    expect(grid.values[0]).toBeCloseTo(0, 6); // subject: tall (dark)
    expect(grid.values[1]).toBeCloseTo(1, 6); // background: floor (light)
  });

  it("produces the expected heights through the real mesher", () => {
    const size = 24;
    const depth = new Float32Array(size * size);
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - c, y - c);
        depth[y * size + x] = Math.max(0, 1 - d / (size * 0.4));
      }
    }
    const grid = depthToReliefGrid(depth, size, size, {
      gridWidth: size,
      gridHeight: size,
    });
    const mesh = heightFieldToClosedMesh(grid, {
      pixelSizeMm: 1,
      minThicknessMm: 1,
      reliefHeightMm: 2,
      invert: false,
    });
    const bounds = meshDataBounds(mesh);
    // Floor at 0, base 1mm, peak near base + full relief height (the exact
    // grid centre falls between pixel centres, so the peak sits just under).
    expect(bounds.min.z).toBeCloseTo(0, 5);
    expect(bounds.max.z).toBeGreaterThan(2.7);
    expect(bounds.max.z).toBeLessThanOrEqual(3.001);
    // Inverted (lithophane-style): the centre becomes the LOW point.
    const inverted = heightFieldToClosedMesh(grid, {
      pixelSizeMm: 1,
      minThicknessMm: 1,
      reliefHeightMm: 2,
      invert: true,
    });
    const invertedBounds = meshDataBounds(inverted);
    expect(invertedBounds.max.z).toBeCloseTo(3, 1);
  });
});
