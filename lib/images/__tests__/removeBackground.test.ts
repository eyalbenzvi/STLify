import { describe, expect, it } from "vitest";
import { createRaw, type RawImage } from "../raster";
import { removeBackgroundAuto } from "../removeBackground";

/** White background with a solid dark square in the centre. */
function logoOnWhite(size = 40): RawImage {
  const img = createRaw(size, size);
  for (let i = 0; i < size * size; i++) {
    img.data.set([245, 245, 245, 255], i * 4);
  }
  const lo = Math.floor(size * 0.3);
  const hi = Math.ceil(size * 0.7);
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      img.data.set([20, 40, 160, 255], (y * size + x) * 4);
    }
  }
  return img;
}

describe("automatic background removal", () => {
  it("removes a uniform background and keeps the subject", () => {
    const img = logoOnWhite();
    const { mask, backgroundFraction } = removeBackgroundAuto(img, { tolerance: 24 });
    // Corners removed, centre kept.
    expect(mask[0]).toBe(0);
    expect(mask[img.width - 1]).toBe(0);
    const centre = Math.floor(img.height / 2) * img.width + Math.floor(img.width / 2);
    expect(mask[centre]).toBe(255);
    expect(backgroundFraction).toBeGreaterThan(0.5);
    expect(backgroundFraction).toBeLessThan(0.95);
  });

  it("does not leak through enclosed subject regions", () => {
    const img = logoOnWhite();
    const { mask } = removeBackgroundAuto(img, { tolerance: 24 });
    // Every kept pixel belongs to the square (with 1px smoothing slack).
    const size = img.width;
    const lo = Math.floor(size * 0.3) - 2;
    const hi = Math.ceil(size * 0.7) + 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (mask[y * size + x] === 255) {
          expect(x).toBeGreaterThanOrEqual(lo);
          expect(x).toBeLessThanOrEqual(hi);
          expect(y).toBeGreaterThanOrEqual(lo);
          expect(y).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it("handles two-tone backgrounds via clustering", () => {
    const img = logoOnWhite(40);
    // Make the left half of the border a different colour.
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 8; x++) {
        img.data.set([200, 220, 230, 255], (y * 40 + x) * 4);
      }
    }
    const { mask } = removeBackgroundAuto(img, { tolerance: 24 });
    expect(mask[0]).toBe(0);
    const centre = 20 * 40 + 20;
    expect(mask[centre]).toBe(255);
  });

  it("reports progress up to 1", () => {
    const values: number[] = [];
    removeBackgroundAuto(logoOnWhite(), {
      tolerance: 24,
      onProgress: (v) => values.push(v),
    });
    expect(values.length).toBeGreaterThan(0);
    expect(values[values.length - 1]).toBe(1);
  });
});
