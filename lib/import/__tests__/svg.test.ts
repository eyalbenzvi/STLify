// @vitest-environment jsdom
/**
 * SVG import tests. jsdom provides the DOMParser that three's SVGLoader
 * needs; the geometry kernel (WASM) runs the same in either environment.
 */

import { describe, expect, it } from "vitest";
import { getGeometryKernel, type Contour } from "@/lib/geometry/kernel";
import { parseSvgToContours, SvgImportError } from "../svg";

const RECT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
  <rect x="0" y="0" width="100" height="50" fill="#000"/>
</svg>`;

const DONUT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill-rule="evenodd" fill="black" d="M50 5 A45 45 0 1 0 50 95 A45 45 0 1 0 50 5 Z M50 30 A20 20 0 1 1 50 70 A20 20 0 1 1 50 30 Z"/>
</svg>`;

const STROKE_ONLY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <path d="M0 0 L10 10" fill="none" stroke="red"/>
</svg>`;

const TOP_SHAPE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="40" y="0" width="20" height="10" fill="#000"/>
  <rect x="40" y="80" width="20" height="20" fill="#000"/>
</svg>`;

function bounds(contours: Contour[]) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const c of contours) {
    for (const [x, y] of c) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, maxX, minY, maxY };
}

describe("parseSvgToContours", () => {
  it("scales a rect to the target width, centred on the origin", () => {
    const result = parseSvgToContours(RECT_SVG, { targetWidthMm: 80 });
    expect(result.contours.length).toBe(1);
    const b = bounds(result.contours);
    expect(b.maxX - b.minX).toBeCloseTo(80, 3);
    expect(b.maxY - b.minY).toBeCloseTo(40, 3);
    expect(b.minX + b.maxX).toBeCloseTo(0, 6);
    expect(b.minY + b.maxY).toBeCloseTo(0, 6);
    expect(result.widthMm).toBeCloseTo(80, 3);
  });

  it("preserves holes through kernel extrusion", async () => {
    const result = parseSvgToContours(DONUT_SVG, { targetWidthMm: 90 });
    expect(result.contours.length).toBeGreaterThanOrEqual(2);
    const kernel = await getGeometryKernel();
    const donut = kernel.extrude(result.contours, 5);
    const donutVolume = donut.volumeMm3();
    expect(donut.genus()).toBe(1); // a real hole, not a visual one
    donut.dispose();
    // Outer disc alone must have more volume than the donut.
    const outerOnly = kernel.extrude([result.contours[0]], 5);
    expect(donutVolume).toBeLessThan(outerOnly.volumeMm3());
    outerOnly.dispose();
  });

  it("rejects stroke-only files", () => {
    expect(() => parseSvgToContours(STROKE_ONLY_SVG, { targetWidthMm: 50 })).toThrow(
      SvgImportError
    );
  });

  it("flips Y so the SVG top lands at positive model Y", () => {
    const result = parseSvgToContours(TOP_SHAPE_SVG, { targetWidthMm: 100 });
    // The small rect at SVG top (y=0..10) must map to the HIGHEST model y.
    const perContourMaxY = result.contours.map((c) => Math.max(...c.map(([, y]) => y)));
    const perContourArea = result.contours.map((c) => {
      let area = 0;
      for (let i = 0; i < c.length; i++) {
        const [x1, y1] = c[i];
        const [x2, y2] = c[(i + 1) % c.length];
        area += x1 * y2 - x2 * y1;
      }
      return Math.abs(area / 2);
    });
    const smallIdx = perContourArea.indexOf(Math.min(...perContourArea));
    expect(perContourMaxY[smallIdx]).toBeCloseTo(bounds(result.contours).maxY, 3);
  });

  it("rejects oversized files", () => {
    expect(() =>
      parseSvgToContours("x".repeat(6 * 1024 * 1024), { targetWidthMm: 50 })
    ).toThrow(SvgImportError);
  });
});
