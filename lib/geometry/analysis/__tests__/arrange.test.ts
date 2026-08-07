/**
 * Improved plate arrangement (V6 item 15).
 *
 * Measured claims: rotation candidates place elongated parts a no-rotation
 * packer cannot fit at all; the real convex-hull footprint lets a part
 * lying diagonally fit plates its axis-aligned box never could; the
 * placements geometrically fit inside the plate; and determinism (an
 * existing contract) is preserved.
 */

import { describe, expect, it } from "vitest";
import {
  arrangeOnPlate,
  convexHullXY,
  type ArrangeItem,
} from "../collision";

const plate = { plateWidthMm: 250, plateDepthMm: 100, spacingMm: 5 };

/** Rotated-footprint bounding box of a placed item, in plate coordinates. */
function placedBounds(
  item: ArrangeItem,
  placement: { x: number; y: number; rotationDeg: number }
) {
  const hull: [number, number][] =
    item.hull ??
    ([
      [-item.widthMm / 2, -item.depthMm / 2],
      [item.widthMm / 2, -item.depthMm / 2],
      [item.widthMm / 2, item.depthMm / 2],
      [-item.widthMm / 2, item.depthMm / 2],
    ] as [number, number][]);
  const rad = (placement.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of hull) {
    const rx = placement.x + x * cos - y * sin;
    const ry = placement.y + x * sin + y * cos;
    minX = Math.min(minX, rx);
    maxX = Math.max(maxX, rx);
    minY = Math.min(minY, ry);
    maxY = Math.max(maxY, ry);
  }
  return { minX, maxX, minY, maxY };
}

describe("arrangement with rotation candidates", () => {
  const portrait = (i: number): ArrangeItem => ({
    layerId: `rod${i}`,
    widthMm: 20,
    depthMm: 170,
    currentX: 0,
    currentY: 0,
  });

  it("places elongated parts that fit the plate in NO unrotated orientation", () => {
    const items = [portrait(0), portrait(1), portrait(2)];

    // Without rotation the 170mm depth cannot fit a 100mm-deep plate.
    const fixed = arrangeOnPlate(
      items.map((i) => ({ ...i, allowRotation: false })),
      plate
    );
    expect(fixed.placements).toHaveLength(0);
    expect(fixed.unplaced).toHaveLength(3);

    // With rotation, they lie down and fit.
    const rotated = arrangeOnPlate(items, plate);
    expect(rotated.placements.length).toBe(3);
    for (const p of rotated.placements) {
      expect(p.rotationDeg).toBe(90);
      const b = placedBounds(items[0], p);
      expect(b.minX).toBeGreaterThanOrEqual(-125);
      expect(b.maxX).toBeLessThanOrEqual(125);
      expect(b.minY).toBeGreaterThanOrEqual(-50);
      expect(b.maxY).toBeLessThanOrEqual(50);
    }
    // And the placed footprints must not overlap each other.
    for (let i = 0; i < rotated.placements.length; i++) {
      for (let j = i + 1; j < rotated.placements.length; j++) {
        const a = placedBounds(items[0], rotated.placements[i]);
        const b = placedBounds(items[0], rotated.placements[j]);
        const separated =
          a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY;
        expect(separated).toBe(true);
      }
    }
  });

  it("uses the real hull: a diagonal rod fits where its AABB never could", () => {
    // A 120×10 rod lying at 45° in the world: its AABB is ~92×92.
    const rad = Math.PI / 4;
    const corners: [number, number][] = [
      [-60, -5],
      [60, -5],
      [60, 5],
      [-60, 5],
    ];
    const worldHull = convexHullXY(
      corners.map(([x, y]): [number, number] => [
        x * Math.cos(rad) - y * Math.sin(rad),
        x * Math.sin(rad) + y * Math.cos(rad),
      ])
    );
    const aabbSpan = 120 * Math.cos(rad) + 10 * Math.sin(rad); // ≈ 91.9

    const item: ArrangeItem = {
      layerId: "diag",
      widthMm: aabbSpan,
      depthMm: aabbSpan,
      currentX: 0,
      currentY: 0,
      hull: worldHull,
    };
    const narrow = { plateWidthMm: 140, plateDepthMm: 40, spacingMm: 5 };

    // The AABB (~92×92) cannot fit a 30mm usable depth…
    const noHull = arrangeOnPlate([{ ...item, hull: undefined }], narrow);
    expect(noHull.placements).toHaveLength(0);

    // …but the hull knows the true shape: rotated straight, it fits.
    const withHull = arrangeOnPlate([item], narrow);
    expect(withHull.placements).toHaveLength(1);
    expect(withHull.placements[0].rotationDeg).toBe(135);
    const b = placedBounds(item, withHull.placements[0]);
    expect(b.maxX - b.minX).toBeCloseTo(120, 0);
    expect(b.maxY - b.minY).toBeCloseTo(10, 0);
    expect(b.minY).toBeGreaterThanOrEqual(-20);
    expect(b.maxY).toBeLessThanOrEqual(20);
  });

  it("stays deterministic with rotation and hulls in play", () => {
    const items: ArrangeItem[] = [
      portrait(0),
      { layerId: "sq", widthMm: 40, depthMm: 40, currentX: 3, currentY: -2 },
      {
        layerId: "hex",
        widthMm: 30,
        depthMm: 30,
        currentX: 0,
        currentY: 0,
        hull: convexHullXY(
          Array.from({ length: 6 }, (_, k): [number, number] => [
            15 * Math.cos((k / 6) * 2 * Math.PI),
            15 * Math.sin((k / 6) * 2 * Math.PI),
          ])
        ),
      },
    ];
    expect(arrangeOnPlate(items, plate)).toEqual(arrangeOnPlate(items, plate));
  });
});
