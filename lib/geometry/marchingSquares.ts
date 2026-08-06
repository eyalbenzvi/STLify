/**
 * Marching-squares contour extraction from a binary mask.
 *
 * Used to turn an image's opaque region (alpha / threshold mask) into
 * closed 2D contours that can be extruded (silhouettes) or intersected with
 * a heightmap slab (masked reliefs).
 *
 * The implementation traces cell-boundary edges of the binary grid (pixel-
 * accurate, axis-aligned "staircase" contours) and then simplifies collinear
 * runs. Winding follows the NonZero convention: outer boundaries CCW, holes
 * CW — which the Manifold CrossSection resolves correctly.
 */

import type { Contour } from "./kernel";

export interface MaskGrid {
  /** width in samples */
  width: number;
  /** height in samples */
  height: number;
  /** truthy = inside, row-major, row 0 = top. */
  inside: Uint8Array;
}

/**
 * Extract contours from a binary mask, in mask pixel coordinates with a
 * y-up convention (row 0 of the mask maps to y = height).
 */
export function maskToContours(mask: MaskGrid): Contour[] {
  const { width, height, inside } = mask;
  const at = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    return inside[y * width + x] !== 0;
  };

  // Collect directed boundary edges. Each edge separates an inside pixel
  // from an outside pixel and is directed so the inside is on its LEFT
  // (outer contours become CCW in y-up coordinates).
  // Grid points are pixel corners: (x, y) with y-up flip applied at the end.
  type Point = string;
  const edges = new Map<Point, [number, number][]>(); // from -> list of to

  const addEdge = (x0: number, y0: number, x1: number, y1: number): void => {
    const key = `${x0},${y0}`;
    const list = edges.get(key);
    if (list) list.push([x1, y1]);
    else edges.set(key, [[x1, y1]]);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue;
      // In screen coords (y down): for inside-left direction rules, work in
      // the final y-up frame directly: pixel (x, y) occupies the square
      // [x, x+1] × [H-1-y, H-y] in y-up coordinates.
      const yb = height - 1 - y; // bottom edge coordinate in y-up frame
      const yt = yb + 1;
      // CCW outer boundary (interior on the walking direction's left):
      if (!at(x, y - 1)) addEdge(x + 1, yt, x, yt); // top edge, -X
      if (!at(x, y + 1)) addEdge(x, yb, x + 1, yb); // bottom edge, +X
      if (!at(x - 1, y)) addEdge(x, yt, x, yb); // left edge, -Y
      if (!at(x + 1, y)) addEdge(x + 1, yb, x + 1, yt); // right edge, +Y
    }
  }

  // Chain edges into closed loops.
  const contours: Contour[] = [];
  while (edges.size > 0) {
    const firstEntry = edges.entries().next().value;
    if (!firstEntry) break;
    const [startKey, targets] = firstEntry;
    const [sx, sy] = startKey.split(",").map(Number);
    const loop: Contour = [[sx, sy]];
    let current = targets.pop();
    if (targets.length === 0) edges.delete(startKey);
    let guard = width * height * 8;
    while (current && guard-- > 0) {
      const [cx, cy] = current;
      if (cx === sx && cy === sy) break; // loop closed
      loop.push([cx, cy]);
      const key = `${cx},${cy}`;
      const nextTargets = edges.get(key);
      if (!nextTargets || nextTargets.length === 0) break; // open chain (shouldn't happen)
      current = nextTargets.pop();
      if (nextTargets.length === 0) edges.delete(key);
    }
    if (loop.length >= 4) contours.push(simplifyCollinear(loop));
  }

  return contours.filter((c) => c.length >= 3);
}

/** Remove points that lie on a straight run (axis-aligned staircase merge). */
function simplifyCollinear(contour: Contour): Contour {
  const n = contour.length;
  const out: Contour = [];
  for (let i = 0; i < n; i++) {
    const prev = contour[(i - 1 + n) % n];
    const curr = contour[i];
    const next = contour[(i + 1) % n];
    const cross =
      (curr[0] - prev[0]) * (next[1] - curr[1]) -
      (curr[1] - prev[1]) * (next[0] - curr[0]);
    if (cross !== 0) out.push(curr);
  }
  return out;
}

/**
 * Scale mask-space contours (pixel units, y-up) into physical mm centred on
 * the origin.
 */
export function contoursToMm(
  contours: Contour[],
  maskWidth: number,
  maskHeight: number,
  widthMm: number,
  heightMm: number
): Contour[] {
  const sx = widthMm / maskWidth;
  const sy = heightMm / maskHeight;
  return contours.map((contour) =>
    contour.map(([x, y]): [number, number] => [
      x * sx - widthMm / 2,
      y * sy - heightMm / 2,
    ])
  );
}
