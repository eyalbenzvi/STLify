import { describe, expect, it } from "vitest";
import { contoursToMm, maskToContours } from "../marchingSquares";
import type { Contour } from "../kernel";

function signedArea(contour: Contour): number {
  let area = 0;
  for (let i = 0; i < contour.length; i++) {
    const [x0, y0] = contour[i];
    const [x1, y1] = contour[(i + 1) % contour.length];
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

describe("marching squares", () => {
  it("extracts a CCW rectangle for a solid block", () => {
    const width = 6;
    const height = 4;
    const inside = new Uint8Array(width * height).fill(1);
    const contours = maskToContours({ width, height, inside });
    expect(contours).toHaveLength(1);
    // Simplified to the 4 rectangle corners, CCW (positive area).
    expect(contours[0]).toHaveLength(4);
    expect(signedArea(contours[0])).toBeCloseTo(width * height, 5);
  });

  it("extracts holes with opposite winding", () => {
    const size = 8;
    const inside = new Uint8Array(size * size).fill(1);
    // 2×2 hole in the middle.
    for (let y = 3; y < 5; y++) for (let x = 3; x < 5; x++) inside[y * size + x] = 0;
    const contours = maskToContours({ width: size, height: size, inside });
    expect(contours).toHaveLength(2);
    const areas = contours.map(signedArea).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(-4, 5); // hole, CW
    expect(areas[1]).toBeCloseTo(64, 5); // outer, CCW
  });

  it("separates disconnected blobs", () => {
    const width = 9;
    const height = 3;
    const inside = new Uint8Array(width * height);
    for (let y = 0; y < 3; y++) {
      inside[y * width + 1] = 1;
      inside[y * width + 7] = 1;
    }
    const contours = maskToContours({ width, height, inside });
    expect(contours).toHaveLength(2);
  });

  it("returns nothing for an empty mask", () => {
    expect(maskToContours({ width: 4, height: 4, inside: new Uint8Array(16) })).toHaveLength(0);
  });

  it("scales contours to millimetres centred on the origin", () => {
    const contours: Contour[] = [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
    ];
    const mm = contoursToMm(contours, 4, 4, 20, 10);
    expect(mm[0]).toEqual([
      [-10, -5],
      [10, -5],
      [10, 5],
      [-10, 5],
    ]);
  });
});
