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

/**
 * `accept` for the image file input.
 *
 * A list of specific MIME types (image/png,image/jpeg,…) makes mobile
 * pickers — Android Chrome in particular — hand the request straight to a
 * photo app such as Google Photos, hiding Files/Downloads and any image the
 * gallery does not index. The generic `image/*` plus explicit extensions
 * keeps every on-device source reachable (gallery, camera, file manager,
 * cloud providers), so the real format check moves to `validateImageFile`
 * after selection.
 */
export const IMAGE_INPUT_ACCEPT =
  "image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.heic,.heif,.avif";

/** Extensions the picker offers; used to name layers and to sanity-check. */
const IMAGE_EXTENSION_RE = /\.(png|jpe?g|webp|gif|bmp|heic|heif|avif|tiff?)$/i;

/** Drop a known image extension from a file name (for layer naming). */
export function stripImageExtension(fileName: string): string {
  return fileName.replace(IMAGE_EXTENSION_RE, "");
}

/**
 * Post-selection check, replacing what a narrow `accept` used to enforce.
 * Deliberately lenient: mobile pickers often hand over a file with an empty
 * `type` and no extension, and those must still be allowed through — decode
 * is the final arbiter. Returns a Hebrew error, or null when acceptable.
 */
export function validateImageFile(file: {
  name: string;
  type: string;
  size: number;
}): string | null {
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) {
    return "זהו קובץ SVG — השתמשו בכפתור ״ייבוא SVG״";
  }
  if (file.type && !file.type.startsWith("image/")) {
    return "הקובץ שנבחר אינו תמונה — בחרו קובץ PNG, JPG או WEBP";
  }
  if (!file.type && /\.[a-z0-9]+$/i.test(file.name) && !IMAGE_EXTENSION_RE.test(file.name)) {
    return "הקובץ שנבחר אינו תמונה — בחרו קובץ PNG, JPG או WEBP";
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return "קובץ התמונה גדול מדי (מקסימום 20MB)";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Grid utilities
// ---------------------------------------------------------------------------

/**
 * How far apart two luminances have to be before the filter stops treating
 * them as the same surface. 0.2 sits well above sensor/JPEG noise and well
 * below the contrast of any edge a silhouette is traced from.
 */
const BILATERAL_RANGE_SIGMA = 0.2;

/** exp(-d²/2σ²) for the 3×3 neighbourhood, σ = 1 pixel. Row-major, centre 4. */
const BILATERAL_SPATIAL = [
  Math.exp(-1), Math.exp(-0.5), Math.exp(-1),
  Math.exp(-0.5), 1, Math.exp(-0.5),
  Math.exp(-1), Math.exp(-0.5), Math.exp(-1),
];

/**
 * Range weights by quantised luminance difference. A lookup table rather than
 * a call to exp per tap: a 512×512 grid at five passes is twelve million
 * taps, and the table makes the filter cost the same as the box blur it
 * replaced.
 */
const BILATERAL_RANGE = (() => {
  const table = new Float64Array(256);
  for (let k = 0; k < 256; k++) {
    const d = k / 255;
    table[k] = Math.exp(-(d * d) / (2 * BILATERAL_RANGE_SIGMA * BILATERAL_RANGE_SIGMA));
  }
  return table;
})();

/**
 * Edge-preserving 3×3 smoothing, `passes` times.
 *
 * This used to be a box blur, which reduced noise by pulling every pixel
 * toward its neighbours — including the pixels ON an edge, whose neighbours
 * are the background. The corner of a letter would drift toward the threshold
 * and the tracer would round it off, so the control labelled "smoothing" was
 * quietly also a control for "lose the corners".
 *
 * A bilateral filter weights each neighbour by BOTH distance and luminance
 * similarity, so a pixel is averaged with its own side of an edge and not
 * across it. Noise still goes; corners stay.
 *
 * The deliberate trade: a full-amplitude 1-bit dither pattern is
 * indistinguishable from real structure by amplitude alone, so this filter
 * preserves it where the box blur merged it. In practice the decode
 * downsamples to at most 512 px first, which turns a scanned halftone into
 * greys before it ever reaches here.
 */
export function smoothGrid(grid: LuminanceGrid, passes: number): LuminanceGrid {
  if (passes <= 0) return grid;
  const { width, height } = grid;
  let src = new Float32Array(grid.values);
  let dst = new Float32Array(src.length);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const centre = src[y * width + x];
        let sum = 0;
        let weight = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const value = src[yy * width + xx];
            const delta = value - centre;
            const bin = Math.min(255, Math.round((delta < 0 ? -delta : delta) * 255));
            const w = BILATERAL_SPATIAL[(dy + 1) * 3 + (dx + 1)] * BILATERAL_RANGE[bin];
            sum += value * w;
            weight += w;
          }
        }
        dst[y * width + x] = weight > 0 ? sum / weight : centre;
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

export interface SilhouetteOptions {
  /** Luminance threshold 0..1; darker-than-threshold is solid. */
  threshold: number;
  invert: boolean;
  /** Physical size of one grid pixel, mm. */
  pixelSizeMm: number;
}

/** Below this the two classes are the same colour and Otsu has nothing to say. */
const OTSU_MIN_SEPARATION = 1 / 256;

/**
 * Otsu's method: the luminance split that maximises between-class variance.
 *
 * The threshold used to be the first thing the user had to guess, before they
 * had seen a single contour — and the guess governs the whole shape. Otsu
 * answers it from the image itself, deterministically and with no model.
 *
 * IMPORTANT: this runs at IMPORT time only. The silhouette threshold is a
 * stored field, and re-deriving it on a rebuild would change the geometry of
 * every design already saved. The computed value is written into the layer's
 * stored `threshold`; the rebuild keeps reading that value.
 *
 * The grid handed in should be the one that will actually be thresholded
 * (after brightness/contrast and smoothing), so the split lands where the
 * tracer will use it.
 *
 * Returns 0.5 for a flat image, where every split is equally arbitrary. The
 * result is clamped to the same 0.05..0.95 range the manual control offers,
 * so switching to manual afterwards shows a value that control can hold.
 */
export function otsuThreshold(grid: LuminanceGrid): number {
  const bins = 256;
  const histogram = new Float64Array(bins);
  for (let i = 0; i < grid.values.length; i++) {
    const v = grid.values[i];
    const bin = v <= 0 ? 0 : v >= 1 ? bins - 1 : Math.floor(v * bins);
    histogram[bin]++;
  }
  const total = grid.values.length;
  if (total === 0) return 0.5;

  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * histogram[b];

  let weightLow = 0;
  let sumLow = 0;
  let best = -1;
  let bestBin = -1;
  for (let b = 0; b < bins - 1; b++) {
    weightLow += histogram[b];
    if (weightLow === 0) continue;
    const weightHigh = total - weightLow;
    if (weightHigh === 0) break;
    sumLow += b * histogram[b];
    const meanLow = sumLow / weightLow;
    const meanHigh = (sumAll - sumLow) / weightHigh;
    const between = weightLow * weightHigh * (meanLow - meanHigh) ** 2;
    if (between > best) {
      best = between;
      bestBin = b;
    }
  }
  if (bestBin < 0) return 0.5;
  // Split at the upper edge of the darker class, so `lum < threshold`
  // selects exactly the pixels Otsu assigned to it.
  const threshold = (bestBin + 1) / bins;
  if (best <= 0) return 0.5;
  return Math.max(0.05, Math.min(0.95, threshold));
}

/**
 * Whether an image has two distinguishable luminance populations at all. A
 * photo of a wall does not, and an automatic split of it is a coin toss the
 * user should hear about rather than discover in the geometry.
 */
export function isBimodalEnough(grid: LuminanceGrid, threshold: number): boolean {
  let low = 0;
  let lowSum = 0;
  let high = 0;
  let highSum = 0;
  for (let i = 0; i < grid.values.length; i++) {
    const v = grid.values[i];
    if (v < threshold) {
      low++;
      lowSum += v;
    } else {
      high++;
      highSum += v;
    }
  }
  if (low === 0 || high === 0) return false;
  return highSum / high - lowSum / low > OTSU_MIN_SEPARATION * 8;
}

// ---------------------------------------------------------------------------
// Minimum-feature check (thin strokes the nozzle cannot resolve)
// ---------------------------------------------------------------------------

/**
 * The solid/background mask the silhouette tracer sees, padded by one
 * "outside" pixel on every side exactly as `gridToSilhouetteContours` pads
 * its field. Sharing the padding is what makes a measurement taken here
 * describe the contours that come out of there.
 */
function silhouetteMask(
  grid: LuminanceGrid,
  options: Pick<SilhouetteOptions, "threshold" | "invert">
): { mask: Uint8Array; width: number; height: number } {
  const pw = grid.width + 2;
  const ph = grid.height + 2;
  const mask = new Uint8Array(pw * ph);
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const lum = grid.values[y * grid.width + x];
      const inside = options.invert ? lum > options.threshold : lum < options.threshold;
      if (inside) mask[(y + 1) * pw + (x + 1)] = 1;
    }
  }
  return { mask, width: pw, height: ph };
}

const EDT_INF = 1e20;

/** Felzenszwalb–Huttenlocher lower-envelope transform of one 1D sample row. */
function edt1d(f: Float64Array, n: number, out: Float64Array): void {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -EDT_INF;
  z[1] = EDT_INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = EDT_INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    out[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/**
 * Exact Euclidean distance, in pixels, from every pixel to the nearest pixel
 * whose `mask` value is `target`. Exact rather than a chamfer approximation
 * because a half-pixel error here is a tenth of a millimetre on a typical
 * import, which is the same order as the thing being measured.
 */
function distanceToValue(
  mask: Uint8Array,
  width: number,
  height: number,
  target: 0 | 1
): Float64Array {
  const f = new Float64Array(Math.max(width, height));
  const g = new Float64Array(Math.max(width, height));
  const sq = new Float64Array(width * height);
  for (let i = 0; i < sq.length; i++) sq[i] = mask[i] === target ? 0 : EDT_INF;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = sq[y * width + x];
    edt1d(f, height, g);
    for (let y = 0; y < height; y++) sq[y * width + x] = g[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = sq[y * width + x];
    edt1d(f, width, g);
    for (let x = 0; x < width; x++) sq[y * width + x] = g[x];
  }
  for (let i = 0; i < sq.length; i++) sq[i] = Math.sqrt(sq[i]);
  return sq;
}

/** What the minimum-feature check found on a traced silhouette. */
export interface ThinFeatureReport {
  /** Narrowest stroke found, mm. `null` when the shape has no solid area. */
  thinnestMm: number | null;
  /** Narrowest stroke this machine can lay down, mm (two extrusion widths). */
  minimumMm: number;
  /** One grid pixel in mm — the resolution the measurement itself has. */
  pixelSizeMm: number;
  /** True when a real feature is below what the machine can resolve. */
  violates: boolean;
  /** Outward offset that lifts the thinnest stroke to `minimumMm`, mm. */
  suggestedDilationMm: number;
}

/**
 * Measure the narrowest stroke in the silhouette and compare it with what the
 * machine can actually lay down.
 *
 * Why here and not in the wall-thickness analysis, which finds the same
 * defect: by the time that analysis runs the user has a solid, and the three
 * things that would have fixed it cheaply — the threshold, the resolution and
 * the artwork itself — are all behind them. The cost of the check is the same;
 * only the timing differs, and the timing is the whole point.
 *
 * Method: an exact distance transform of the solid mask, restricted to its
 * ridge (pixels no lower than all eight neighbours). The ridge restriction is
 * deliberate — it measures elongated strokes and ignores the tapering tip of a
 * serif or an arrowhead, which is thin by design and thin in every artwork, so
 * flagging it would make the check fire on everything and mean nothing.
 */
export function measureThinnestFeature(
  grid: LuminanceGrid,
  options: SilhouetteOptions & { minimumMm: number }
): ThinFeatureReport {
  const { mask, width, height } = silhouetteMask(grid, options);
  const px = options.pixelSizeMm;
  const empty: ThinFeatureReport = {
    thinnestMm: null,
    minimumMm: options.minimumMm,
    pixelSizeMm: px,
    violates: false,
    suggestedDilationMm: 0,
  };
  if (!mask.some((v) => v === 1)) return empty;

  const inner = distanceToValue(mask, width, height, 0);
  let thinnestPx = Infinity;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mask[i] !== 1) continue;
      const d = inner[i];
      let isRidge = true;
      for (let dy = -1; dy <= 1 && isRidge; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (inner[i + dy * width + dx] > d) {
            isRidge = false;
            break;
          }
        }
      }
      if (isRidge && d < thinnestPx) thinnestPx = d;
    }
  }
  if (!Number.isFinite(thinnestPx)) return empty;

  // A stroke n pixels wide puts its ridge (n+1)/2 pixel centres from the
  // background, so the width the ridge distance implies is 2d − 1.
  const widthPx = Math.max(1, 2 * thinnestPx - 1);
  const thinnestMm = widthPx * px;
  const violates = thinnestMm < options.minimumMm;
  return {
    thinnestMm,
    minimumMm: options.minimumMm,
    pixelSizeMm: px,
    violates,
    // Dilation adds twice its radius to a stroke's width.
    suggestedDilationMm: violates ? (options.minimumMm - thinnestMm) / 2 : 0,
  };
}

/**
 * Morphological dilation of the silhouette by `dilationMm`, returned as a
 * luminance grid the caller re-traces with its ORIGINAL threshold and invert.
 *
 * The offset is encoded as a signed distance scaled into luminance around the
 * caller's threshold rather than as a pixel-snapped mask, so the marching
 * squares interpolation still lands the boundary between pixel centres. A
 * pixel-snapped dilation would quantise a 0.15 mm correction up to a whole
 * 0.3 mm pixel and put back the faceting the rest of this module removes.
 */
export function dilateSilhouetteGrid(
  grid: LuminanceGrid,
  options: SilhouetteOptions,
  dilationMm: number
): LuminanceGrid {
  if (!(dilationMm > 0)) return grid;
  const { mask, width, height } = silhouetteMask(grid, options);
  const toOutside = distanceToValue(mask, width, height, 0);
  const toInside = distanceToValue(mask, width, height, 1);
  const radiusPx = dilationMm / options.pixelSizeMm;

  // Keep the encoded luminance inside [0,1] whatever threshold the caller
  // chose; only cells straddling the new boundary matter, and adjacent
  // distance samples differ by at most ~1.42 px, so clamping farther out is
  // harmless.
  const t = options.threshold;
  const scale = Math.max(0.01, Math.min(0.25, t * 0.4, (1 - t) * 0.4));

  const values = new Float32Array(grid.width * grid.height);
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const pi = (y + 1) * width + (x + 1);
      // Signed distance to the original boundary, which sits half a pixel
      // from the centre of the last solid pixel.
      const signed = mask[pi] === 1 ? -(toOutside[pi] - 0.5) : toInside[pi] - 0.5;
      const d = signed - radiusPx;
      const lum = options.invert ? t - scale * d : t + scale * d;
      values[y * grid.width + x] = Math.max(0, Math.min(1, lum));
    }
  }
  return { width: grid.width, height: grid.height, values };
}

/** Hebrew report for the minimum-feature check. `applied` = we thickened. */
export function thinFeatureMessageHe(report: ThinFeatureReport, applied: boolean): string {
  const thin = (report.thinnestMm ?? 0).toFixed(2);
  const min = report.minimumMm.toFixed(2);
  const head =
    `הקו הדק ביותר בצללית הוא כ-${thin} מ״מ, ` +
    `והמדפסת הזו יכולה להדפיס לפחות ${min} מ״מ (שתי רצועות פיה).`;
  if (applied) {
    return (
      `${head} הקווים עובו אוטומטית ב-${report.suggestedDilationMm.toFixed(2)} מ״מ ` +
      `לכל צד כדי שיודפסו. אם זה שינה את הצורה יותר מדי — בטלו את הסימון ` +
      `״עיבוי קווים דקים״ בחלון הייבוא, או השתמשו בציור מקורי עבה יותר.`
    );
  }
  return (
    `${head} קווים דקים מזה ייעלמו או ייצאו גל בהדפסה. סמנו ״עיבוי קווים דקים״ ` +
    `בחלון הייבוא, או עבו את הציור המקורי.`
  );
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
    throw new ImageImportError(
      "לא ניתן לפענח את קובץ התמונה — הדפדפן אינו תומך בפורמט הזה (למשל HEIC מהאייפון). נסו PNG, JPG או WEBP"
    );
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
