/**
 * Image import tests: marching-squares silhouettes and closed relief
 * height-field solids, verified through the real geometry kernel.
 */

import { describe, expect, it } from "vitest";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import {
  applyMaskStrokes,
  dilateSilhouetteGrid,
  fitClosedContour,
  gridToSilhouetteContours,
  heightFieldToClosedMesh,
  IMAGE_INPUT_ACCEPT,
  isBimodalEnough,
  measureThinnestFeature,
  otsuThreshold,
  smoothGrid,
  stripImageExtension,
  thinFeatureMessageHe,
  validateImageFile,
  type LuminanceGrid,
  type MaskStroke,
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

describe("contour vectorisation", () => {
  /**
   * The Douglas-Peucker decimation V7 replaced, kept here as the reference
   * the curve fitting has to beat. It could only ever KEEP points of the
   * marching-squares staircase, so its output was still on the staircase —
   * which is what the accuracy numbers below are measuring.
   */
  function douglasPeucker(points: [number, number][], tolerance: number): [number, number][] {
    if (points.length <= 4) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack: [number, number][] = [[0, points.length - 1]];
    while (stack.length > 0) {
      const [start, end] = stack.pop()!;
      if (end - start < 2) continue;
      const [x1, y1] = points[start];
      const [x2, y2] = points[end];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy) || 1;
      let worst = -1;
      let worstDistance = tolerance;
      for (let i = start + 1; i < end; i++) {
        const distance =
          Math.abs(dy * (points[i][0] - x1) - dx * (points[i][1] - y1)) / length;
        if (distance > worstDistance) {
          worstDistance = distance;
          worst = i;
        }
      }
      if (worst >= 0) {
        keep[worst] = 1;
        stack.push([start, worst], [worst, end]);
      }
    }
    return points.filter((_, i) => keep[i] === 1);
  }

  /** Worst distance from a true circle, sampled ALONG each edge. */
  function radialError(contour: [number, number][], radius: number): number {
    let cx = 0;
    let cy = 0;
    for (const [x, y] of contour) {
      cx += x;
      cy += y;
    }
    cx /= contour.length;
    cy /= contour.length;
    let worst = 0;
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i];
      const b = contour[(i + 1) % contour.length];
      for (let t = 0; t <= 1; t += 0.02) {
        const x = a[0] + (b[0] - a[0]) * t;
        const y = a[1] + (b[1] - a[1]) * t;
        worst = Math.max(worst, Math.abs(Math.hypot(x - cx, y - cy) - radius));
      }
    }
    return worst;
  }

  function polygonArea(contour: [number, number][]): number {
    let area = 0;
    for (let i = 0; i < contour.length; i++) {
      const [x1, y1] = contour[i];
      const [x2, y2] = contour[(i + 1) % contour.length];
      area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area / 2);
  }

  it("halves the deviation from a true circle, with fewer points", () => {
    // 1 mm pixels, so the numbers below are also pixel counts. Douglas-Peucker
    // was measured on the same traced loops before the change.
    const cases: { radius: number; size: number; maxPoints: number }[] = [
      { radius: 20, size: 64, maxPoints: 45 },
      { radius: 30, size: 96, maxPoints: 73 },
      { radius: 40, size: 128, maxPoints: 73 },
    ];
    for (const { radius, size, maxPoints } of cases) {
      const contour = gridToSilhouetteContours(diskGrid(size, radius), {
        threshold: 0.5,
        invert: false,
        pixelSizeMm: 1,
      })[0] as [number, number][];
      // Deviation from the true circle stays under 0.55 mm where the old
      // decimation ran 0.89–1.01 mm — it could not do better, because it was
      // restricted to points that sit ON the staircase.
      expect(radialError(contour, radius)).toBeLessThan(0.55);
      expect(contour.length).toBeLessThan(maxPoints);
    }
  });

  it("keeps a right-angled corner exactly where the raster put it", () => {
    // Corners are pinned as segment ends rather than fitted through, so the
    // traced area matches what the marching-squares diagonal allows — the
    // same area the old decimation produced, to the last hundredth.
    const size = 40;
    const values = new Float32Array(size * size).fill(1);
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) values[y * size + x] = 0;
    const contour = gridToSilhouetteContours(
      { width: size, height: size, values },
      { threshold: 0.5, invert: false, pixelSizeMm: 1 }
    )[0] as [number, number][];
    expect(polygonArea(contour)).toBeCloseTo(399.5, 2);
    // The apex samples survive; the fit is not free to cut across them.
    const corners = contour.filter(([x, y]) => Math.abs(x) > 9 && Math.abs(y) > 9);
    expect(corners.length).toBeGreaterThanOrEqual(4);
  });

  it("is closer to the truth than Douglas-Peucker on the same staircase", () => {
    // Direct comparison on one input, and an honest one: this synthetic
    // staircase is HARSHER than what the tracer really emits, because
    // marching squares interpolates its crossings sub-pixel. On input this
    // rough, decimation at a coarse tolerance wins on point count — it simply
    // cuts across the steps — and loses on accuracy, which is the trade the
    // change is making. The point-count win is measured on real traced loops
    // in the first case above.
    const staircase: [number, number][] = [];
    const radius = 25;
    for (let y = -radius; y <= radius; y++) {
      const x = Math.round(Math.sqrt(Math.max(0, radius * radius - y * y))) + 0.5;
      staircase.push([x, y - 0.5], [x, y + 0.5]);
    }
    for (let y = radius; y >= -radius; y--) {
      const x = -(Math.round(Math.sqrt(Math.max(0, radius * radius - y * y))) + 0.5);
      staircase.push([x, y + 0.5], [x, y - 0.5]);
    }
    const fitted = fitClosedContour(staircase, 1.2, 2.5);
    const decimated = douglasPeucker(staircase, 1.2);
    expect(radialError(fitted, radius)).toBeLessThan(radialError(decimated, radius) - 0.3);
  });

  it("a shape with a hole still extrudes with the hole open", async () => {
    // The windings survive: the tracer emits outers and holes with OPPOSITE
    // windings and Clipper2's NonZero fill turns that into a hole. Curve
    // fitting only changes how many points there are, never their order — but
    // a genus check is what proves it rather than asserting it.
    const contours = gridToSilhouetteContours(diskGrid(96, 34, 14), {
      threshold: 0.5,
      invert: false,
      pixelSizeMm: 1,
    });
    expect(contours.length).toBeGreaterThanOrEqual(2);
    const kernel = await getGeometryKernel();
    const solid = kernel.extrude(contours, 4);
    expect(solid.genus()).toBe(1);
    const expected = Math.PI * (34 * 34 - 14 * 14) * 4;
    expect(Math.abs(solid.volumeMm3() - expected) / expected).toBeLessThan(0.05);
    solid.dispose();
  });
});

describe("applyMaskStrokes", () => {
  const options = { threshold: 0.5, invert: false };

  it("erases a region from the silhouette, changing the traced contours", () => {
    // A disk plus a stray mark: the case the brush exists for.
    const grid = diskGrid(64, 14);
    for (let y = 3; y < 9; y++) for (let x = 3; x < 9; x++) grid.values[y * 64 + x] = 0;
    const trace = (g: LuminanceGrid) =>
      gridToSilhouetteContours(g, { ...options, pixelSizeMm: 1 });
    expect(trace(grid).length).toBe(2);

    const cleaned = applyMaskStrokes(
      grid,
      [{ points: [[6 / 64, 6 / 64]], radius: 8 / 64, add: false }],
      options
    );
    expect(trace(cleaned).length).toBe(1);
    // The disk itself is untouched.
    expect(cleaned.values[32 * 64 + 32]).toBe(0);
  });

  it("paints solid where nothing was", () => {
    const values = new Float32Array(64 * 64).fill(1);
    const grid = { width: 64, height: 64, values };
    const painted = applyMaskStrokes(
      grid,
      [
        {
          points: [
            [0.2, 0.5],
            [0.8, 0.5],
          ],
          radius: 0.1,
          add: true,
        },
      ],
      options
    );
    const contours = gridToSilhouetteContours(painted, { ...options, pixelSizeMm: 1 });
    expect(contours.length).toBe(1);
    expect(painted.values[32 * 64 + 32]).toBe(0);
    expect(painted.values[5 * 64 + 5]).toBe(1);
  });

  it("honours invert, so painted solid stays solid either way", () => {
    const dark = new Float32Array(16 * 16).fill(0);
    const painted = applyMaskStrokes(
      { width: 16, height: 16, values: dark },
      [{ points: [[0.5, 0.5]], radius: 0.2, add: true }],
      { threshold: 0.5, invert: true }
    );
    // Inverted: solid is the LIGHT side, so "add" writes 1.
    expect(painted.values[8 * 16 + 8]).toBe(1);
  });

  it("lands the same marks at any resolution — strokes are normalised", () => {
    // The trap: the mask lives at the downsampled grid size, so a stroke
    // stored in pixels would point at nothing once the user changes it.
    const stroke: MaskStroke = { points: [[0.25, 0.25]], radius: 0.1, add: true };
    const covered = (size: number) => {
      const values = new Float32Array(size * size).fill(1);
      const painted = applyMaskStrokes(
        { width: size, height: size, values },
        [stroke],
        options
      );
      let solid = 0;
      for (const v of painted.values) if (v === 0) solid++;
      return solid / (size * size);
    };
    // Same fraction of the image at 64 px and at 256 px, within rasterisation.
    expect(Math.abs(covered(64) - covered(256))).toBeLessThan(0.005);
    // And it is where it should be: the upper-left quadrant.
    const values = new Float32Array(64 * 64).fill(1);
    const painted = applyMaskStrokes({ width: 64, height: 64, values }, [stroke], options);
    expect(painted.values[16 * 64 + 16]).toBe(0);
    expect(painted.values[48 * 64 + 48]).toBe(1);
  });

  it("returns the grid untouched when nothing was painted", () => {
    const grid = diskGrid(16, 5);
    expect(applyMaskStrokes(grid, [], options)).toBe(grid);
  });
});

describe("otsuThreshold", () => {
  /** Grid whose pixels are `dark` with probability `share`, else `light`. */
  function bimodal(dark: number, light: number, share: number): LuminanceGrid {
    const size = 64;
    const values = new Float32Array(size * size);
    for (let i = 0; i < values.length; i++) {
      values[i] = i % 100 < share * 100 ? dark : light;
    }
    return { width: size, height: size, values };
  }

  it("splits a bimodal image between its two populations", () => {
    // Two clean populations at 0.2 and 0.8: the analytic split is 0.5, and
    // Otsu's between-class variance is flat across the empty gap, so the
    // tolerance is the width of that gap.
    const t = otsuThreshold(bimodal(0.2, 0.8, 0.35));
    expect(t).toBeGreaterThan(0.2);
    expect(t).toBeLessThanOrEqual(0.8);
    // The split must actually separate the populations.
    expect(0.2 < t && 0.8 >= t).toBe(true);
  });

  it("finds the split even when the classes are lopsided", () => {
    // 4% ink on 96% paper — the case a fixed 0.5 threshold handles by luck.
    const t = otsuThreshold(bimodal(0.1, 0.95, 0.04));
    expect(t).toBeGreaterThan(0.1);
    expect(t).toBeLessThanOrEqual(0.95);
  });

  it("beats the old fixed 0.5 on a washed-out scan", () => {
    // Both populations sit above 0.5, so a fixed threshold sees no shape.
    const grid = bimodal(0.62, 0.9, 0.3);
    expect(otsuThreshold(grid)).toBeGreaterThan(0.62);
    const traced = gridToSilhouetteContours(grid, {
      threshold: 0.5,
      invert: false,
      pixelSizeMm: 1,
    });
    expect(traced.length).toBe(0); // what the user used to get
  });

  it("falls back to 0.5 on a flat image, where every split is arbitrary", () => {
    const values = new Float32Array(32 * 32).fill(0.4);
    expect(otsuThreshold({ width: 32, height: 32, values })).toBe(0.5);
  });

  it("stays inside the range the manual control offers", () => {
    for (const [dark, light] of [
      [0, 0.01],
      [0.99, 1],
      [0, 1],
    ]) {
      const t = otsuThreshold(bimodal(dark, light, 0.5));
      expect(t).toBeGreaterThanOrEqual(0.05);
      expect(t).toBeLessThanOrEqual(0.95);
    }
  });

  it("reports when an image has no two populations to split", () => {
    const flat = new Float32Array(32 * 32).fill(0.4);
    const grid = { width: 32, height: 32, values: flat };
    expect(isBimodalEnough(grid, otsuThreshold(grid))).toBe(false);
    const real = bimodal(0.2, 0.8, 0.35);
    expect(isBimodalEnough(real, otsuThreshold(real))).toBe(true);
  });
});

describe("measureThinnestFeature", () => {
  /** Light grid with a dark horizontal stroke `thickness` pixels tall. */
  function strokeGrid(size: number, thickness: number): LuminanceGrid {
    const values = new Float32Array(size * size).fill(1);
    const y0 = Math.floor((size - thickness) / 2);
    for (let y = y0; y < y0 + thickness; y++) {
      for (let x = 8; x <= size - 9; x++) values[y * size + x] = 0;
    }
    return { width: size, height: size, values };
  }

  // 0.3 mm pixels against a 0.4 mm nozzle: one pixel is well under the two
  // extrusion widths the machine needs, so the check can actually resolve it.
  const px = 0.3;
  const minimumMm = 0.8;

  it("reports a hairline stroke with its measured width and the machine minimum", () => {
    const report = measureThinnestFeature(strokeGrid(64, 1), {
      threshold: 0.5,
      invert: false,
      pixelSizeMm: px,
      minimumMm,
    });
    expect(report.violates).toBe(true);
    expect(report.thinnestMm).toBeCloseTo(0.3, 6);
    expect(report.minimumMm).toBe(0.8);
    expect(report.suggestedDilationMm).toBeCloseTo(0.25, 6);
    const message = thinFeatureMessageHe(report, true);
    expect(message).toContain("0.30");
    expect(message).toContain("0.80");
  });

  it("stays quiet on a shape the machine can resolve", () => {
    const report = measureThinnestFeature(diskGrid(64, 20), {
      threshold: 0.5,
      invert: false,
      pixelSizeMm: px,
      minimumMm,
    });
    expect(report.violates).toBe(false);
    expect(report.suggestedDilationMm).toBe(0);
    expect(report.thinnestMm).toBeGreaterThan(minimumMm);
  });

  it("ignores a tapering tip — thin by design, thin in every artwork", () => {
    // A 29-pixel-tall bar running to a 45° point. The tip is a single pixel,
    // but no thin STROKE exists anywhere in it — a serif, an arrowhead or a
    // letter terminal all look like this, and flagging them would make the
    // check fire on every piece of artwork.
    const size = 48;
    const values = new Float32Array(size * size).fill(1);
    const cy = size / 2;
    for (let x = 4; x <= 30; x++) {
      const half = Math.min(14, 30 - x);
      for (let y = cy - half; y <= cy + half; y++) values[y * size + x] = 0;
    }
    const report = measureThinnestFeature(
      { width: size, height: size, values },
      { threshold: 0.5, invert: false, pixelSizeMm: px, minimumMm }
    );
    expect(report.violates).toBe(false);
  });

  it("ignores dust the tracer is going to discard anyway", () => {
    // One stray pixel on a scan used to report a 0.30 mm "feature" and thicken
    // the WHOLE artwork — a 60-pixel logo square grew 5.6% — to correct a mark
    // that never reached the output, while the notice named a stroke width the
    // user could not find in their drawing.
    const size = 200;
    const clean = new Float32Array(size * size).fill(1);
    for (let y = 70; y < 130; y++) for (let x = 70; x < 130; x++) clean[y * size + x] = 0;
    const dusty = new Float32Array(clean);
    dusty[20 * size + 20] = 0; // a single dark pixel, far from the logo
    // 60 mm across 200 px, matching the dialog defaults.
    const options = { threshold: 0.5, invert: false, pixelSizeMm: 0.3, minimumMm: 0.8 };

    expect(
      measureThinnestFeature({ width: size, height: size, values: clean }, options).violates
    ).toBe(false);
    expect(
      measureThinnestFeature({ width: size, height: size, values: dusty }, options).violates
    ).toBe(false);

    // And the geometry is genuinely untouched: same contour count, same area.
    const trace = (values: Float32Array) =>
      gridToSilhouetteContours({ width: size, height: size, values }, options);
    const area = (contour: [number, number][]) => {
      let a = 0;
      for (let i = 0; i < contour.length; i++) {
        const [x1, y1] = contour[i];
        const [x2, y2] = contour[(i + 1) % contour.length];
        a += x1 * y2 - x2 * y1;
      }
      return Math.abs(a / 2);
    };
    const before = trace(clean);
    const after = trace(dusty);
    expect(after.length).toBe(before.length);
    expect(area(after[0] as [number, number][])).toBeCloseTo(
      area(before[0] as [number, number][]),
      6
    );
  });

  it("still finds a thin stroke that is large enough to be traced", () => {
    // The speck filter must not silence a real hairline: a 1-pixel stroke long
    // enough to survive the tracer's own area threshold still reports.
    const size = 200;
    const values = new Float32Array(size * size).fill(1);
    for (let x = 20; x < 180; x++) values[100 * size + x] = 0; // 160 px x 1 px
    const report = measureThinnestFeature(
      { width: size, height: size, values },
      { threshold: 0.5, invert: false, pixelSizeMm: 0.3, minimumMm: 0.8 }
    );
    expect(report.violates).toBe(true);
    expect(report.thinnestMm).toBeCloseTo(0.3, 6);
  });

  it("reports nothing when the image has no solid area at all", () => {
    const values = new Float32Array(32 * 32).fill(1);
    const report = measureThinnestFeature(
      { width: 32, height: 32, values },
      { threshold: 0.5, invert: false, pixelSizeMm: px, minimumMm }
    );
    expect(report.thinnestMm).toBeNull();
    expect(report.violates).toBe(false);
  });

  it("thickening lifts the traced contour above the nozzle minimum", () => {
    const grid = strokeGrid(64, 1);
    const options = { threshold: 0.5, invert: false, pixelSizeMm: px };
    const report = measureThinnestFeature(grid, { ...options, minimumMm });

    const strokeHeightMm = (contours: [number, number][][]): number => {
      expect(contours.length).toBe(1);
      const ys = contours[0].map(([, y]) => y);
      return Math.max(...ys) - Math.min(...ys);
    };

    expect(strokeHeightMm(gridToSilhouetteContours(grid, options))).toBeCloseTo(px, 4);

    const thickened = dilateSilhouetteGrid(grid, options, report.suggestedDilationMm);
    const after = gridToSilhouetteContours(thickened, options);
    expect(strokeHeightMm(after)).toBeGreaterThanOrEqual(minimumMm - 1e-6);
    // Re-measuring the thickened grid must also clear the machine minimum.
    expect(
      measureThinnestFeature(thickened, { ...options, minimumMm }).violates
    ).toBe(false);
  });

  it("honours invert when deciding which side is solid", () => {
    // Same stroke, but light-on-dark: only the inverted read finds it thin.
    const grid = strokeGrid(64, 1);
    for (let i = 0; i < grid.values.length; i++) grid.values[i] = 1 - grid.values[i];
    const inverted = measureThinnestFeature(grid, {
      threshold: 0.5,
      invert: true,
      pixelSizeMm: px,
      minimumMm,
    });
    expect(inverted.violates).toBe(true);
    expect(inverted.thinnestMm).toBeCloseTo(0.3, 6);
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
  /**
   * The 3×3 box blur smoothGrid used to be, kept here as the reference the
   * bilateral filter has to beat. The old test asserted only "variance goes
   * down", which the box blur achieved by smearing edges as readily as noise
   * — the exact behaviour V7 replaces — so it could not have caught this.
   */
  function boxBlur(grid: LuminanceGrid, passes: number): LuminanceGrid {
    const { width, height } = grid;
    let src = new Float32Array(grid.values);
    let dst = new Float32Array(src.length);
    for (let pass = 0; pass < passes; pass++) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let sum = 0;
          let count = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= height) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= width) continue;
              sum += src[yy * width + xx];
              count++;
            }
          }
          dst[y * width + x] = sum / count;
        }
      }
      const tmp = src;
      src = dst;
      dst = tmp;
    }
    return { width, height, values: src };
  }

  /** Left half dark, right half light: a vertical step edge at x = size/2. */
  function stepGrid(size: number): LuminanceGrid {
    const values = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) values[y * size + x] = x < size / 2 ? 0 : 1;
    }
    return { width: size, height: size, values };
  }

  it("keeps a step edge the box blur measurably smears", () => {
    const size = 16;
    const grid = stepGrid(size);
    const at = (g: LuminanceGrid, x: number) => g.values[(size / 2) * size + x];
    const bilateral = smoothGrid(grid, 2);
    const box = boxBlur(grid, 2);

    // The dark column touching the edge, and the light column touching it.
    expect(at(box, size / 2 - 1)).toBeGreaterThan(0.3); // pulled toward light
    expect(at(box, size / 2)).toBeLessThan(0.7); // pulled toward dark
    expect(at(bilateral, size / 2 - 1)).toBeLessThan(0.01);
    expect(at(bilateral, size / 2)).toBeGreaterThan(0.99);
  });

  it("still removes noise", () => {
    // A smooth ramp plus deterministic ±0.05 noise. The filter must move the
    // grid back toward the clean ramp, which is what "smoothing" is for.
    const size = 32;
    const clean = new Float32Array(size * size);
    const noisy = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        clean[i] = x / (size - 1);
        const jitter = (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.1;
        noisy[i] = Math.max(0, Math.min(1, clean[i] + jitter));
      }
    }
    const error = (a: Float32Array) => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - clean[i]);
      return sum / a.length;
    };
    const smoothed = smoothGrid({ width: size, height: size, values: noisy }, 2);
    expect(error(smoothed.values)).toBeLessThan(error(noisy) * 0.7);
  });

  it("stops the tracer rounding off a corner", () => {
    // A square's corner: the box blur pulls it toward the background until
    // the traced contour clips it. Measure the traced area against the ideal.
    const size = 40;
    const values = new Float32Array(size * size).fill(1);
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) values[y * size + x] = 0;
    const grid = { width: size, height: size, values };
    const trace = (g: LuminanceGrid) =>
      gridToSilhouetteContours(g, { threshold: 0.5, invert: false, pixelSizeMm: 1 });
    const area = (contour: [number, number][]) => {
      let a = 0;
      for (let i = 0; i < contour.length; i++) {
        const [x1, y1] = contour[i];
        const [x2, y2] = contour[(i + 1) % contour.length];
        a += x1 * y2 - x2 * y1;
      }
      return Math.abs(a / 2);
    };
    const ideal = 20 * 20;
    const bilateralArea = area(trace(smoothGrid(grid, 3))[0]);
    const boxArea = area(trace(boxBlur(grid, 3))[0]);
    // 0.5 mm² of the ideal is the marching-squares corner cell itself, which
    // is a diagonal whatever the filter does; anything beyond that is the
    // smoothing eating the corner.
    expect(ideal - bilateralArea).toBeLessThanOrEqual(0.5);
    expect(ideal - boxArea).toBeGreaterThan(3);
  });

  it("preserves a full-amplitude alternating pattern — the accepted trade", () => {
    // Amplitude alone cannot tell 1-bit dither from real structure, so an
    // edge-preserving filter keeps both. The decode downsamples to at most
    // 512 px first, which turns a scanned halftone into greys before this
    // ever runs; this test exists so the trade is stated, not discovered.
    const size = 16;
    const values = new Float32Array(size * size);
    for (let i = 0; i < values.length; i++) values[i] = i % 2;
    const smoothed = smoothGrid({ width: size, height: size, values }, 2);
    expect(smoothed.values[size * 8 + 8]).toBeCloseTo(values[size * 8 + 8], 3);
  });

  it("returns the grid untouched at zero passes", () => {
    const grid = stepGrid(8);
    expect(smoothGrid(grid, 0)).toBe(grid);
  });
});

describe("IMAGE_INPUT_ACCEPT", () => {
  it("uses the generic image/* so mobile pickers expose all device sources", () => {
    // A list of only specific MIME types makes Android Chrome route the
    // request to a photo app, hiding Files/Downloads.
    expect(IMAGE_INPUT_ACCEPT.split(",")).toContain("image/*");
    expect(IMAGE_INPUT_ACCEPT).toContain(".jpg");
    expect(IMAGE_INPUT_ACCEPT).toContain(".heic");
  });
});

describe("validateImageFile", () => {
  const file = (name: string, type: string, size = 1000) => ({ name, type, size });

  it("accepts the common raster formats", () => {
    expect(validateImageFile(file("a.png", "image/png"))).toBeNull();
    expect(validateImageFile(file("a.jpg", "image/jpeg"))).toBeNull();
    expect(validateImageFile(file("a.webp", "image/webp"))).toBeNull();
    expect(validateImageFile(file("IMG_0001.HEIC", "image/heic"))).toBeNull();
  });

  it("accepts files a mobile picker hands over without a type or extension", () => {
    expect(validateImageFile(file("image", ""))).toBeNull();
    expect(validateImageFile(file("content://media/external/images/1", ""))).toBeNull();
    expect(validateImageFile(file("photo.jpg", ""))).toBeNull();
  });

  it("rejects non-images and points SVG at its own importer", () => {
    expect(validateImageFile(file("doc.pdf", "application/pdf"))).toMatch(/אינו תמונה/);
    expect(validateImageFile(file("notes.txt", ""))).toMatch(/אינו תמונה/);
    expect(validateImageFile(file("logo.svg", "image/svg+xml"))).toMatch(/SVG/);
    expect(validateImageFile(file("logo.svg", ""))).toMatch(/SVG/);
  });

  it("rejects files over 20MB", () => {
    expect(validateImageFile(file("big.png", "image/png", 21 * 1024 * 1024))).toMatch(/גדול מדי/);
  });
});

describe("stripImageExtension", () => {
  it("drops known image extensions only", () => {
    expect(stripImageExtension("logo.PNG")).toBe("logo");
    expect(stripImageExtension("IMG_1.jpeg")).toBe("IMG_1");
    expect(stripImageExtension("IMG_1.HEIC")).toBe("IMG_1");
    expect(stripImageExtension("v1.2.stl")).toBe("v1.2.stl");
  });
});
