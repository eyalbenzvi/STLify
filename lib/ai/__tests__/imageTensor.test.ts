/**
 * Tensor plumbing tests: resampling, normalisation and CHW layout. These are
 * the pure functions the on-device models depend on — everything here runs
 * with plain arrays, no runtime and no network.
 */

import { describe, expect, it } from "vitest";
import {
  bilinearResample,
  minMaxNormalize,
  rgbaToChwTensor,
  type RgbaImage,
} from "../imageTensor";

describe("bilinearResample", () => {
  it("is the identity at equal sizes (and copies, not aliases)", () => {
    const src = new Float32Array([1, 2, 3, 4]);
    const out = bilinearResample(src, 2, 2, 2, 2);
    expect([...out]).toEqual([1, 2, 3, 4]);
    out[0] = 99;
    expect(src[0]).toBe(1);
  });

  it("preserves a constant field at any scale", () => {
    const src = new Float32Array(5 * 7).fill(0.25);
    const out = bilinearResample(src, 5, 7, 13, 3);
    for (const v of out) expect(v).toBeCloseTo(0.25, 6);
  });

  it("interpolates a horizontal ramp monotonically when upsampling", () => {
    const src = new Float32Array([0, 1]);
    const out = bilinearResample(src, 2, 1, 8, 1);
    for (let i = 1; i < 8; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[7]).toBeCloseTo(1, 6);
  });

  it("keeps left/right structure when downsampling (no mirror, no shift)", () => {
    // Left half dark, right half bright — must survive a 2x downsample.
    const src = new Float32Array(8 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 4; x < 8; x++) src[y * 8 + x] = 1;
    }
    const out = bilinearResample(src, 8, 4, 4, 2);
    expect(out[0]).toBeLessThan(0.5);
    expect(out[3]).toBeGreaterThan(0.5);
  });
});

describe("rgbaToChwTensor", () => {
  const mean: [number, number, number] = [0.5, 0.5, 0.5];
  const std: [number, number, number] = [0.5, 0.5, 0.5];

  function solidImage(r: number, g: number, b: number, a = 255): RgbaImage {
    const data = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = a;
    }
    return { width: 4, height: 4, data };
  }

  it("lays channels out CHW with per-channel normalisation", () => {
    const tensor = rgbaToChwTensor(solidImage(255, 0, 128), 2, mean, std);
    expect(tensor.length).toBe(3 * 2 * 2);
    // R = 1 → (1-0.5)/0.5 = 1; G = 0 → -1; B ≈ 0.5 → ≈ 0.
    expect(tensor[0]).toBeCloseTo(1, 5);
    expect(tensor[4]).toBeCloseTo(-1, 5);
    expect(tensor[8]).toBeCloseTo(0, 2);
  });

  it("composites transparency onto white", () => {
    const tensor = rgbaToChwTensor(solidImage(0, 0, 0, 0), 2, mean, std);
    // Fully transparent black = white → (1-0.5)/0.5 = 1 in every channel.
    for (const v of tensor) expect(v).toBeCloseTo(1, 5);
  });

  it("squashes aspect to the square input", () => {
    // 8x2 image, left half black, right half white.
    const data = new Uint8Array(8 * 2 * 4);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 8; x++) {
        const v = x < 4 ? 0 : 255;
        const i = (y * 8 + x) * 4;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    const tensor = rgbaToChwTensor({ width: 8, height: 2, data }, 4, mean, std);
    // Row 0 of channel 0: two dark then two bright samples.
    expect(tensor[0]).toBeLessThan(0);
    expect(tensor[3]).toBeGreaterThan(0);
  });
});

describe("minMaxNormalize", () => {
  it("stretches to 0..1 and reports signal", () => {
    const values = new Float32Array([2, 4, 6]);
    expect(minMaxNormalize(values)).toBe(true);
    expect([...values].map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, 1]);
  });

  it("flattens a constant map to zero and reports no signal", () => {
    const values = new Float32Array([3, 3, 3]);
    expect(minMaxNormalize(values)).toBe(false);
    expect([...values]).toEqual([0, 0, 0]);
  });
});
