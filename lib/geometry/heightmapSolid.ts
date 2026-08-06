/**
 * Height-map → watertight mesh construction for image reliefs.
 *
 * The solid is a rectangular slab: a displaced top grid, a flat bottom at
 * z = 0, and stitched side walls. The result is a closed 2-manifold by
 * construction, suitable for Manifold booleans (union for raised reliefs,
 * subtraction for engraved ones).
 *
 * Masked / transparent regions are NOT handled here — the caller intersects
 * the slab with an extruded mask contour, which keeps this mesh simple and
 * guarantees manifoldness.
 */

import type { MeshArrays } from "./kernel";

export interface HeightmapOptions {
  /** Samples along X (>= 2). */
  cols: number;
  /** Samples along Y (>= 2). */
  rows: number;
  /** Physical size in mm. */
  widthMm: number;
  heightMm: number;
  /**
   * Height of the top surface (mm) per sample, row-major with row 0 at the
   * TOP of the image (screen convention). Values must be > 0.
   */
  heights: Float32Array;
  /** Minimum slab height; samples below this are clamped. */
  minHeightMm?: number;
}

/**
 * Build indexed mesh arrays for a heightmap slab spanning
 * x ∈ [-w/2, w/2], y ∈ [-h/2, h/2], z ∈ [0, heights].
 */
export function heightmapToMeshArrays(options: HeightmapOptions): MeshArrays {
  const { cols, rows, widthMm, heightMm, heights } = options;
  const floor = Math.max(options.minHeightMm ?? 0.05, 0.02);
  if (cols < 2 || rows < 2) throw new Error("Heightmap needs at least 2x2 samples");
  if (heights.length !== cols * rows) {
    throw new Error("Heightmap size mismatch");
  }

  const vertexCount = cols * rows * 2; // top grid + bottom grid
  const vertProperties = new Float32Array(vertexCount * 3);

  const stepX = widthMm / (cols - 1);
  const stepY = heightMm / (rows - 1);
  const x0 = -widthMm / 2;
  const y0 = heightMm / 2; // row 0 = top of image = +Y

  // Top vertices [0, cols*rows), bottom vertices [cols*rows, 2*cols*rows).
  const bottomOffset = cols * rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = x0 + c * stepX;
      const y = y0 - r * stepY;
      const z = Math.max(heights[i], floor);
      vertProperties[i * 3] = x;
      vertProperties[i * 3 + 1] = y;
      vertProperties[i * 3 + 2] = z;
      const j = bottomOffset + i;
      vertProperties[j * 3] = x;
      vertProperties[j * 3 + 1] = y;
      vertProperties[j * 3 + 2] = 0;
    }
  }

  const quadCount = (cols - 1) * (rows - 1);
  const wallQuads = 2 * (cols - 1) + 2 * (rows - 1);
  const triCount = quadCount * 4 + wallQuads * 2;
  const triVerts = new Uint32Array(triCount * 3);
  let t = 0;

  const pushTri = (a: number, b: number, c: number): void => {
    triVerts[t++] = a;
    triVerts[t++] = b;
    triVerts[t++] = c;
  };

  // Top surface: +Z normal. In our layout +Y is up and rows grow downward,
  // so CCW (seen from +Z) is (r+1,c) -> (r+1,c+1) -> (r,c) etc.
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = r * cols + c + 1;
      const d = (r + 1) * cols + c;
      const e = (r + 1) * cols + c + 1;
      pushTri(a, d, b);
      pushTri(b, d, e);
      // Bottom surface: -Z normal (reversed winding).
      pushTri(bottomOffset + a, bottomOffset + b, bottomOffset + d);
      pushTri(bottomOffset + b, bottomOffset + e, bottomOffset + d);
    }
  }

  // Side walls: connect top boundary to bottom boundary. For a wall whose
  // top edge runs A -> B, the outward normal is the edge direction rotated
  // +90° CCW, so each boundary is traversed with the slab on its LEFT.
  const wall = (topA: number, topB: number): void => {
    // Quad topA -> topB -> bottomB -> bottomA, outward-facing.
    pushTri(topA, topB, bottomOffset + topB);
    pushTri(topA, bottomOffset + topB, bottomOffset + topA);
  };
  // Top edge (r = 0, y = +h/2): outward +Y, traverse +X.
  for (let c = 0; c < cols - 1; c++) wall(c, c + 1);
  // Bottom edge (r = rows-1, y = -h/2): outward -Y, traverse -X.
  for (let c = 0; c < cols - 1; c++) {
    const r = (rows - 1) * cols;
    wall(r + c + 1, r + c);
  }
  // Left edge (c = 0, x = -w/2): outward -X, traverse +Y (r+1 -> r).
  for (let r = 0; r < rows - 1; r++) wall((r + 1) * cols, r * cols);
  // Right edge (c = cols-1, x = +w/2): outward +X, traverse -Y (r -> r+1).
  for (let r = 0; r < rows - 1; r++) {
    wall(r * cols + cols - 1, (r + 1) * cols + cols - 1);
  }

  return { vertProperties, triVerts };
}
