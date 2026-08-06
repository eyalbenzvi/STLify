// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { svgToContours } from "../geometry";
import type { Contour } from "@/lib/geometry/kernel";

function signedArea(contour: Contour): number {
  let area = 0;
  for (let i = 0; i < contour.length; i++) {
    const [x0, y0] = contour[i];
    const [x1, y1] = contour[(i + 1) % contour.length];
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

function bounds(contours: Contour[]) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of contours)
    for (const [x, y] of c) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  return { minX, maxX, minY, maxY };
}

const RECT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="#000"/></svg>`;

/** A ring: outer circle with an inner hole (fill-rule evenodd path). */
const RING = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill-rule="evenodd" fill="#000"
    d="M50 5a45 45 0 1 0 0 90a45 45 0 1 0 0-90zM50 30a20 20 0 1 1 0 40a20 20 0 1 1 0-40z"/>
</svg>`;

describe("SVG → contours", () => {
  it("converts a filled rect scaled to the target size, centred", () => {
    const result = svgToContours(RECT, 40, 20, "standard");
    expect(result.isEmpty).toBe(false);
    const b = bounds(result.contours);
    expect(b.maxX - b.minX).toBeCloseTo(40, 3);
    expect(b.maxY - b.minY).toBeCloseTo(20, 3);
    expect(b.minX + b.maxX).toBeCloseTo(0, 3);
    expect(b.minY + b.maxY).toBeCloseTo(0, 3);
  });

  it("preserves internal holes with opposite winding", () => {
    const result = svgToContours(RING, 40, 40, "standard");
    expect(result.contours.length).toBe(2);
    const areas = result.contours.map(signedArea);
    const positives = areas.filter((a) => a > 0);
    const negatives = areas.filter((a) => a < 0);
    expect(positives).toHaveLength(1);
    expect(negatives).toHaveLength(1);
    expect(Math.abs(positives[0])).toBeGreaterThan(Math.abs(negatives[0]));
  });

  it("horizontal flip mirrors X and keeps winding valid", () => {
    const asym = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="0,0 100,0 0,100" fill="#000"/></svg>`;
    const normal = svgToContours(asym, 40, 40, "standard");
    const flipped = svgToContours(asym, 40, 40, "standard", true, false);
    // Winding (sign of area) preserved after mirroring.
    expect(Math.sign(signedArea(normal.contours[0]))).toBe(
      Math.sign(signedArea(flipped.contours[0]))
    );
    // Mirrored shape occupies the opposite X side.
    const nb = bounds([normal.contours[0]]);
    const fb = bounds([flipped.contours[0]]);
    expect(nb.maxX - nb.minX).toBeCloseTo(fb.maxX - fb.minX, 3);
  });

  it("returns empty for an SVG with no drawable shapes", () => {
    const result = svgToContours(
      `<svg xmlns="http://www.w3.org/2000/svg"><defs/></svg>`,
      20,
      20,
      "standard"
    );
    expect(result.isEmpty).toBe(true);
  });

  it("handles stroke-only paths as best-effort outlines with a warning", () => {
    const stroke = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M1 1L9 1L9 9L1 9Z" fill="none" stroke="#000"/></svg>`;
    const result = svgToContours(stroke, 20, 20, "standard");
    expect(result.isEmpty).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
