import { describe, expect, it } from "vitest";
import { DEFAULT_ADJUSTMENTS } from "@/types/design";
import {
  applyAdjustments,
  applyMask,
  applyTonal,
  createRaw,
  crop,
  flip,
  luminanceAt,
  resample,
  rotate90,
  type RawImage,
} from "../raster";

/** 2×2 test image: TL red, TR green, BL blue, BR white (opaque). */
function quad(): RawImage {
  const img = createRaw(2, 2);
  img.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  return img;
}

function px(img: RawImage, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [...img.data.slice(i, i + 4)];
}

describe("raster operations", () => {
  it("rotate90 clockwise moves the top-left to the top-right", () => {
    const out = rotate90(quad(), 1);
    expect(out.width).toBe(2);
    expect(px(out, 1, 0)).toEqual([255, 0, 0, 255]); // red now top-right
    expect(px(out, 0, 0)).toEqual([0, 0, 255, 255]); // blue top-left
  });

  it("rotate90 twice equals 180°", () => {
    const out = rotate90(quad(), 2);
    expect(px(out, 1, 1)).toEqual([255, 0, 0, 255]);
  });

  it("flips horizontally and vertically", () => {
    const h = flip(quad(), true, false);
    expect(px(h, 0, 0)).toEqual([0, 255, 0, 255]);
    const v = flip(quad(), false, true);
    expect(px(v, 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it("crop removes edge fractions", () => {
    const img = createRaw(10, 10);
    const out = crop(img, 0.2, 0.2, 0.1, 0.1);
    expect(out.width).toBe(6);
    expect(out.height).toBe(8);
  });

  it("resample averages areas", () => {
    const out = resample(quad(), 1, 1);
    const [r, g, b] = px(out, 0, 0);
    expect(Math.round(r)).toBe(Math.round((255 + 0 + 0 + 255) / 4));
    expect(Math.round(g)).toBe(Math.round((0 + 255 + 0 + 255) / 4));
    expect(Math.round(b)).toBe(Math.round((0 + 0 + 255 + 255) / 4));
  });

  it("grayscale + invert + threshold behave in order", () => {
    const img = quad();
    const out = applyTonal(img, {
      ...DEFAULT_ADJUSTMENTS,
      grayscale: true,
      invert: false,
      threshold: 128,
    });
    // White pixel stays white after threshold; red (lum≈54) goes black.
    expect(px(out, 1, 1)[0]).toBe(255);
    expect(px(out, 0, 0)[0]).toBe(0);
  });

  it("brightness shifts luminance", () => {
    const img = quad();
    const bright = applyTonal(img, { ...DEFAULT_ADJUSTMENTS, brightness: 100, grayscale: true });
    const dark = applyTonal(img, { ...DEFAULT_ADJUSTMENTS, brightness: -100, grayscale: true });
    expect(luminanceAt(bright, 0)).toBeGreaterThan(luminanceAt(dark, 0));
  });

  it("posterize quantizes channels", () => {
    const img = createRaw(1, 1);
    img.data.set([100, 100, 100, 255]);
    const out = applyTonal(img, { ...DEFAULT_ADJUSTMENTS, grayscale: false, posterizeLevels: 2 });
    expect([0, 255]).toContain(out.data[0]);
  });

  it("applyMask multiplies alpha", () => {
    const out = applyMask(quad(), new Uint8Array([0, 255, 255, 0]));
    expect(px(out, 0, 0)[3]).toBe(0);
    expect(px(out, 1, 0)[3]).toBe(255);
    expect(px(out, 1, 1)[3]).toBe(0);
  });

  it("full pipeline runs without mutating the source", () => {
    const img = quad();
    const before = [...img.data];
    const out = applyAdjustments(img, {
      ...DEFAULT_ADJUSTMENTS,
      cropLeft: 0.1,
      rotate90: 1,
      flipH: true,
      freeRotationDeg: 15,
      brightness: 10,
      blurPx: 1,
    });
    expect(out.width).toBeGreaterThan(0);
    expect([...img.data]).toEqual(before);
  });
});
