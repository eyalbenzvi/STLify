import { describe, expect, it } from "vitest";
import { createRaw } from "../raster";
import { buildHeightField, estimateGridSize, estimateTriangleCount } from "../heightField";

function gradientImage(): ReturnType<typeof createRaw> {
  // 4×1: black → dark → light → white, fully opaque.
  const img = createRaw(4, 1);
  const values = [0, 85, 170, 255];
  values.forEach((v, i) => img.data.set([v, v, v, 255], i * 4));
  return img;
}

const BASE_LAYER = {
  widthMm: 20,
  heightMm: 20,
  resolution: "draft" as const,
  mapping: "darkHigh" as const,
  minHeightMm: 0.4,
  maxHeightMm: 2,
  mode: "raised" as const,
  alphaThreshold: 96,
};

describe("height field sampling", () => {
  it("scales grid size with physical size and caps it", () => {
    const small = estimateGridSize({ widthMm: 10, heightMm: 10, resolution: "draft" });
    const large = estimateGridSize({ widthMm: 200, heightMm: 200, resolution: "draft" });
    expect(large.cols).toBeGreaterThan(small.cols);
    expect(large.cols).toBeLessThanOrEqual(96);
    const fine = estimateGridSize({ widthMm: 200, heightMm: 200, resolution: "fine" });
    expect(fine.cols).toBeLessThanOrEqual(320);
    expect(estimateTriangleCount({ widthMm: 50, heightMm: 50, resolution: "standard" })).toBeGreaterThan(1000);
  });

  it("maps dark to high by default and respects lightHigh", () => {
    const img = gradientImage();
    const dark = buildHeightField(img, BASE_LAYER);
    // Left column (black) should be near max, right (white) near min.
    const firstRow = dark.heights.slice(0, dark.cols);
    expect(firstRow[0]).toBeGreaterThan(firstRow[dark.cols - 1]);
    expect(Math.max(...firstRow)).toBeLessThanOrEqual(2 + 1e-6);
    expect(Math.min(...firstRow)).toBeGreaterThanOrEqual(0.4 - 1e-6);

    const light = buildHeightField(img, { ...BASE_LAYER, mapping: "lightHigh" });
    const lightRow = light.heights.slice(0, light.cols);
    expect(lightRow[0]).toBeLessThan(lightRow[light.cols - 1]);
  });

  it("silhouette mode uses a constant height over opaque pixels", () => {
    const img = gradientImage();
    const field = buildHeightField(img, { ...BASE_LAYER, mode: "silhouette" });
    for (let i = 0; i < field.heights.length; i++) {
      if (field.coverage[i]) expect(field.heights[i]).toBeCloseTo(2, 6);
    }
  });

  it("masks out transparent pixels", () => {
    const img = createRaw(2, 1);
    img.data.set([0, 0, 0, 255, 0, 0, 0, 10]); // opaque, transparent
    const field = buildHeightField(img, BASE_LAYER);
    expect(field.hasMask).toBe(true);
    expect(field.coverageFraction).toBeGreaterThan(0);
    expect(field.coverageFraction).toBeLessThan(1);
    // Left half covered, right half not.
    const firstRow = [...field.coverage.slice(0, field.cols)];
    expect(firstRow[0]).toBe(1);
    expect(firstRow[field.cols - 1]).toBe(0);
  });
});
