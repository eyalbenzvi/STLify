import { describe, expect, it } from "vitest";
import { removeBackgroundAuto, rgbToLab, type RawImage } from "../removeBackground";

function createRaw(width: number, height: number): RawImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Squared distance the retired RGB metric used, for the counterfactuals. */
function rgbDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** What `tolerance` meant in RGB units before V7: tolerance × 4.42. */
const OLD_RGB_THRESHOLD_AT_24 = 24 * 4.42;

/** Solid background with a solid square in the centre. */
function squareOn(
  background: [number, number, number],
  subject: [number, number, number],
  size = 40
): RawImage {
  const img = createRaw(size, size);
  for (let i = 0; i < size * size; i++) img.data.set([...background, 255], i * 4);
  const lo = Math.floor(size * 0.3);
  const hi = Math.ceil(size * 0.7);
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) img.data.set([...subject, 255], (y * size + x) * 4);
  }
  return img;
}

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

describe("rgbToLab", () => {
  it("lands the sRGB anchors where CIELAB says they are", () => {
    const [lw, aw, bw] = rgbToLab(255, 255, 255);
    expect(lw).toBeCloseTo(100, 3);
    expect(aw).toBeCloseTo(0, 3);
    expect(bw).toBeCloseTo(0, 3);
    expect(rgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 6);
    // Mid sRGB grey is L* ≈ 53.6, not 50 — exactly the non-linearity RGB
    // distance ignores.
    expect(rgbToLab(128, 128, 128)[0]).toBeCloseTo(53.585, 2);
    // Pure blue: dark and strongly negative on the yellow-blue axis.
    const blue = rgbToLab(0, 0, 255);
    expect(blue[0]).toBeCloseTo(32.3, 1);
    expect(blue[2]).toBeLessThan(-100);
  });

  it("keeps the tolerance scale meaning what it meant, on the grey axis", () => {
    // The mapping is 1:1 with ΔE because the old RGB threshold at the default
    // tolerance measures very nearly `tolerance` ΔE for greys.
    const step = OLD_RGB_THRESHOLD_AT_24 / Math.sqrt(3);
    for (const base of [80, 128, 180]) {
      const other = base + step;
      const d = Math.hypot(
        ...rgbToLab(base, base, base).map((v, i) => v - rgbToLab(other, other, other)[i])
      );
      expect(d).toBeGreaterThan(20);
      expect(d).toBeLessThan(27);
    }
  });
});

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

  it("keeps a subject that differs in hue but not in lightness", () => {
    // Mossy green ground, brick-red subject: 3.4 units apart in L*, so the
    // silhouette threshold cannot separate them either — background removal
    // is the only thing standing between the user and one solid blob.
    const background: [number, number, number] = [110, 140, 90];
    const subject: [number, number, number] = [152, 115, 90];

    // The counterfactual: the retired RGB metric put these 49 units apart,
    // less than half its own threshold, so it classified the subject AS the
    // background and flood-filled straight through it.
    expect(rgbDistance(background, subject)).toBeLessThan(OLD_RGB_THRESHOLD_AT_24);

    const img = squareOn(background, subject);
    const { mask, backgroundFraction } = removeBackgroundAuto(img, { tolerance: 24 });
    expect(mask[0]).toBe(0);
    expect(mask[20 * 40 + 20]).toBe(255);
    // Roughly the 16×16 subject survives out of 40×40.
    expect(backgroundFraction).toBeGreaterThan(0.7);
    expect(backgroundFraction).toBeLessThan(0.92);
  });

  it("still merges tones a person reads as the same colour", () => {
    // Off-white paper with a warm cast: perceptually one background, and it
    // has to stay one or every scan comes back with a halo.
    const img = squareOn([248, 246, 240], [30, 30, 40]);
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 6; x++) img.data.set([252, 250, 247, 255], (y * 40 + x) * 4);
    }
    const { mask } = removeBackgroundAuto(img, { tolerance: 24 });
    expect(mask[0]).toBe(0);
    expect(mask[39]).toBe(0);
    expect(mask[20 * 40 + 20]).toBe(255);
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
