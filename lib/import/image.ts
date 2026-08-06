/**
 * Raster-image import: PNG/JPG → silhouette contours (marching squares
 * over a thresholded luminance grid) or a closed relief solid (height
 * field with walls and a flat floor).
 *
 * The heavy lifting is pure and node-testable (grids in, contours/mesh
 * out); only the thin decode wrapper touches canvas APIs.
 */

import type { StoredContour } from "@/types/design";
import type { MeshData } from "@/lib/geometry/meshData";

export class ImageImportError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "ImageImportError";
  }
}

export interface LuminanceGrid {
  width: number;
  height: number;
  /** Row-major luminance, 0 (dark) .. 1 (light). */
  values: Float32Array;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Grid utilities
// ---------------------------------------------------------------------------

/** 3×3 box blur with clamped edges, `passes` times. */
export function smoothGrid(grid: LuminanceGrid, passes: number): LuminanceGrid {
  if (passes <= 0) return grid;
  const { width, height } = grid;
  let src = new Float32Array(grid.values);
  let dst = new Float32Array(src.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            sum += src[yy * width + xx];
            count++;
          }
        }
        dst[y * width + x] = sum / count;
      }
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  return { width, height, values: src };
}

// ---------------------------------------------------------------------------
// Marching squares silhouette
// ---------------------------------------------------------------------------

interface SilhouetteOptions {
  /** Luminance threshold 0..1; darker-than-threshold is solid. */
  threshold: number;
  invert: boolean;
  /** Physical size of one grid pixel, mm. */
  pixelSizeMm: number;
}

/** Douglas-Peucker simplification. */
function simplifyPolyline(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length <= 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start < 2) continue;
    const [x1, y1] = points[start];
    const [x2, y2] = points[end];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let worstDist = tolerance;
    for (let i = start + 1; i < end; i++) {
      const [px, py] = points[i];
      const dist = Math.abs(dy * (px - x1) - dx * (py - y1)) / len;
      if (dist > worstDist) {
        worstDist = dist;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([start, worst], [worst, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/**
 * Trace iso-contours of the thresholded field with marching squares.
 * The grid is treated as padded with "outside" on all borders so every
 * contour closes. Output winding follows the marching direction: outers
 * and holes come out with opposite windings, matching NonZero fill.
 */
export function gridToSilhouetteContours(
  grid: LuminanceGrid,
  options: SilhouetteOptions
): StoredContour[] {
  const { width, height } = grid;
  const pw = width + 2;
  const ph = height + 2;
  // Field: >0 inside (solid), <0 outside. Padding is outside.
  const field = new Float32Array(pw * ph).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const lum = grid.values[y * width + x];
      const inside = options.invert ? lum > options.threshold : lum < options.threshold;
      // Signed distance proxy from the threshold for edge interpolation.
      const mag = Math.min(1, Math.abs(lum - options.threshold) / 0.5 + 1e-4);
      field[(y + 1) * pw + (x + 1)] = inside ? mag : -mag;
    }
  }

  // Segments per cell via marching squares with linear interpolation.
  const segments = new Map<string, [number, number, number, number]>();
  const key = (x: number, y: number) => `${Math.round(x * 512)}_${Math.round(y * 512)}`;
  const interp = (
    x1: number,
    y1: number,
    v1: number,
    x2: number,
    y2: number,
    v2: number
  ): [number, number] => {
    const t = v1 / (v1 - v2);
    return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
  };

  const addSegment = (a: [number, number], b: [number, number]) => {
    segments.set(key(a[0], a[1]) + "|" + key(b[0], b[1]), [a[0], a[1], b[0], b[1]]);
  };

  for (let y = 0; y < ph - 1; y++) {
    for (let x = 0; x < pw - 1; x++) {
      const tl = field[y * pw + x];
      const tr = field[y * pw + x + 1];
      const br = field[(y + 1) * pw + x + 1];
      const bl = field[(y + 1) * pw + x];
      let caseIndex = 0;
      if (tl > 0) caseIndex |= 8;
      if (tr > 0) caseIndex |= 4;
      if (br > 0) caseIndex |= 2;
      if (bl > 0) caseIndex |= 1;
      if (caseIndex === 0 || caseIndex === 15) continue;

      const top = () => interp(x, y, tl, x + 1, y, tr);
      const right = () => interp(x + 1, y, tr, x + 1, y + 1, br);
      const bottom = () => interp(x, y + 1, bl, x + 1, y + 1, br);
      const left = () => interp(x, y, tl, x, y + 1, bl);

      // Segments oriented so "inside" is on the LEFT of a→b (consistent
      // winding: outers CCW in grid space after the Y flip below).
      switch (caseIndex) {
        case 1:
          addSegment(left(), bottom());
          break;
        case 2:
          addSegment(bottom(), right());
          break;
        case 3:
          addSegment(left(), right());
          break;
        case 4:
          addSegment(right(), top());
          break;
        case 5: // saddle: resolve by centre sample
          if (tl + tr + br + bl > 0) {
            addSegment(right(), bottom());
            addSegment(left(), top());
          } else {
            addSegment(left(), bottom());
            addSegment(right(), top());
          }
          break;
        case 6:
          addSegment(bottom(), top());
          break;
        case 7:
          addSegment(left(), top());
          break;
        case 8:
          addSegment(top(), left());
          break;
        case 9:
          addSegment(top(), bottom());
          break;
        case 10:
          if (tl + tr + br + bl > 0) {
            addSegment(top(), right());
            addSegment(bottom(), left());
          } else {
            addSegment(top(), left());
            addSegment(bottom(), right());
          }
          break;
        case 11:
          addSegment(top(), right());
          break;
        case 12:
          addSegment(right(), left());
          break;
        case 13:
          addSegment(right(), bottom());
          break;
        case 14:
          addSegment(bottom(), left());
          break;
      }
    }
  }

  // Chain segments into closed loops.
  const startIndex = new Map<string, [number, number, number, number][]>();
  for (const seg of segments.values()) {
    const k = key(seg[0], seg[1]);
    const list = startIndex.get(k);
    if (list) list.push(seg);
    else startIndex.set(k, [seg]);
  }
  const used = new Set<[number, number, number, number]>();
  const loops: [number, number][][] = [];
  for (const seg of segments.values()) {
    if (used.has(seg)) continue;
    const loop: [number, number][] = [[seg[0], seg[1]]];
    let current = seg;
    used.add(current);
    let guard = segments.size + 8;
    while (guard-- > 0) {
      const nextKey = key(current[2], current[3]);
      const candidates = startIndex.get(nextKey)?.filter((s) => !used.has(s)) ?? [];
      if (candidates.length === 0) break;
      current = candidates[0];
      used.add(current);
      loop.push([current[0], current[1]]);
      if (key(current[2], current[3]) === key(loop[0][0], loop[0][1])) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }

  // Convert to mm, flip Y, centre, simplify.
  const px = options.pixelSizeMm;
  const cx = pw / 2;
  const cy = ph / 2;
  const tolerance = Math.max(0.05, px * 0.4);
  const contours: StoredContour[] = [];
  for (const loop of loops) {
    const mm: [number, number][] = loop.map(([x, y]): [number, number] => [
      (x - cx) * px,
      -(y - cy) * px,
    ]);
    const simplified = simplifyPolyline(mm, tolerance);
    if (simplified.length < 3) continue;
    // Discard specks smaller than 1 mm².
    let area = 0;
    for (let i = 0; i < simplified.length; i++) {
      const [x1, y1] = simplified[i];
      const [x2, y2] = simplified[(i + 1) % simplified.length];
      area += x1 * y2 - x2 * y1;
    }
    if (Math.abs(area / 2) < 1) continue;
    contours.push(simplified);
  }
  return contours;
}

// ---------------------------------------------------------------------------
// Height-field relief (closed solid)
// ---------------------------------------------------------------------------

interface ReliefOptions {
  pixelSizeMm: number;
  minThicknessMm: number;
  reliefHeightMm: number;
  invert: boolean;
}

/**
 * Build a closed manifold solid from a height field: relief top surface,
 * flat bottom at z=0, and stitched border walls. The bottom mirrors the
 * top grid 1:1 so all seams share vertices — robustly manifold.
 */
export function heightFieldToClosedMesh(
  grid: LuminanceGrid,
  options: ReliefOptions
): MeshData {
  const { width, height } = grid;
  if (width < 2 || height < 2) {
    throw new ImageImportError("רזולוציית התמונה נמוכה מדי ליצירת תבליט");
  }
  const px = options.pixelSizeMm;
  const cx = ((width - 1) * px) / 2;
  const cy = ((height - 1) * px) / 2;

  const vertexCount = width * height * 2; // top grid + bottom grid
  const positions = new Float32Array(vertexCount * 3);
  const topIndex = (x: number, y: number) => y * width + x;
  const bottomIndex = (x: number, y: number) => width * height + y * width + x;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const lum = grid.values[y * width + x];
      const v = options.invert ? lum : 1 - lum; // dark = high by default
      const z = options.minThicknessMm + v * options.reliefHeightMm;
      const wx = x * px - cx;
      const wy = -(y * px - cy); // image y-down → model y-up
      const ti = topIndex(x, y) * 3;
      positions[ti] = wx;
      positions[ti + 1] = wy;
      positions[ti + 2] = z;
      const bi = bottomIndex(x, y) * 3;
      positions[bi] = wx;
      positions[bi + 1] = wy;
      positions[bi + 2] = 0;
    }
  }

  const indices: number[] = [];
  // Top surface: CCW seen from +Z. With y flipped, grid cell (x,y) has
  // world-space "up" at smaller y; triangle order chosen accordingly.
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const a = topIndex(x, y);
      const b = topIndex(x + 1, y);
      const c = topIndex(x + 1, y + 1);
      const d = topIndex(x, y + 1);
      indices.push(a, c, b, a, d, c);
      // Bottom: reversed (faces -Z).
      const a2 = bottomIndex(x, y);
      const b2 = bottomIndex(x + 1, y);
      const c2 = bottomIndex(x + 1, y + 1);
      const d2 = bottomIndex(x, y + 1);
      indices.push(a2, b2, c2, a2, c2, d2);
    }
  }
  // Walls along the four borders (quads between top and bottom rings).
  const wall = (t1: number, t2: number) => {
    const b1 = t1 + width * height;
    const b2 = t2 + width * height;
    indices.push(t1, b2, b1, t1, t2, b2);
  };
  for (let x = 0; x < width - 1; x++) {
    wall(topIndex(x, 0), topIndex(x + 1, 0)); // north edge (max world y)
    wall(topIndex(x + 1, height - 1), topIndex(x, height - 1)); // south
  }
  for (let y = 0; y < height - 1; y++) {
    wall(topIndex(0, y + 1), topIndex(0, y)); // west
    wall(topIndex(width - 1, y), topIndex(width - 1, y + 1)); // east
  }

  return { positions, indices: new Uint32Array(indices) };
}

// ---------------------------------------------------------------------------
// Browser decode wrapper (not exercised by node tests)
// ---------------------------------------------------------------------------

export interface ImageDecodeResult {
  grid: LuminanceGrid;
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Fraction of pixels removed as background (0 when removal is off). */
  backgroundRemovedFraction: number;
}

export interface ImageDecodeOptions {
  /**
   * Automatic background removal (border-seeded flood fill, fully local).
   * null/undefined = off; otherwise the colour tolerance (0..100).
   */
  removeBackgroundTolerance?: number | null;
  /** Brightness shift, -1..1 (0 = unchanged). */
  brightness?: number;
  /** Contrast gain, -1..1 (0 = unchanged). */
  contrast?: number;
}

/** Decode an image file to a downsampled luminance grid. */
export async function decodeImageToGrid(
  file: Blob,
  resolution: number,
  options: ImageDecodeOptions = {}
): Promise<ImageDecodeResult> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageImportError("קובץ התמונה גדול מדי (מקסימום 20MB)");
  }
  const res = Math.max(32, Math.min(Math.floor(resolution), 512));
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageImportError("לא ניתן לפענח את קובץ התמונה — ודאו שהוא PNG או JPG תקין");
  }
  const scale = res / Math.max(bitmap.width, bitmap.height);
  const w = Math.max(2, Math.round(bitmap.width * scale));
  const h = Math.max(2, Math.round(bitmap.height * scale));

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : (() => {
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          return c;
        })();
  const ctx = canvas.getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new ImageImportError("הדפדפן אינו תומך בעיבוד תמונה");
  ctx.drawImage(bitmap, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const sourceWidthPx = bitmap.width;
  const sourceHeightPx = bitmap.height;
  bitmap.close();

  // Optional client-side background removal before the luminance pass.
  let bgMask: Uint8Array | null = null;
  let backgroundRemovedFraction = 0;
  const tolerance = options.removeBackgroundTolerance;
  if (tolerance !== null && tolerance !== undefined) {
    const { removeBackgroundAuto } = await import("./removeBackground");
    const result = removeBackgroundAuto(
      { width: w, height: h, data },
      { tolerance }
    );
    bgMask = result.mask;
    backgroundRemovedFraction = result.backgroundFraction;
  }

  const brightness = Math.max(-1, Math.min(options.brightness ?? 0, 1));
  const contrast = Math.max(-1, Math.min(options.contrast ?? 0, 1));
  const gain = contrast >= 0 ? 1 + contrast * 2 : 1 + contrast * 0.9;

  const values = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    // Transparent + removed-background pixels count as background (light).
    if (a < 8 || (bgMask && bgMask[i] === 0)) {
      values[i] = 1;
      continue;
    }
    let v = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    v = (v - 0.5) * gain + 0.5 + brightness;
    values[i] = Math.max(0, Math.min(1, v));
  }
  return {
    grid: { width: w, height: h, values },
    sourceWidthPx,
    sourceHeightPx,
    backgroundRemovedFraction,
  };
}
