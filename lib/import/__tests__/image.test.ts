/**
 * Image import tests: marching-squares silhouettes and closed relief
 * height-field solids, verified through the real geometry kernel.
 */

import { describe, expect, it } from "vitest";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import {
  dilateSilhouetteGrid,
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
