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
// Manual mask brush
// ---------------------------------------------------------------------------

/**
 * One painted stroke: the escape hatch for when automatic background removal
 * and the threshold between them get the silhouette wrong.
 *
 * Coordinates are NORMALISED to the source image (0..1, x right, y down) and
 * the radius is a fraction of the image's larger side — not grid pixels. That
 * one choice settles both of the ways strokes could otherwise go stale:
 *
 * - Changing the resolution re-rasterises the same strokes at the new grid
 *   size instead of leaving them pointing at pixels that no longer exist.
 * - Brightness and contrast re-run the decode, and strokes do not depend on
 *   the decode's output at all, so they survive every slider nudge.
 */
export interface MaskStroke {
  /** Path points in normalised image space; a single point is a dab. */
  points: [number, number][];
  /** Brush radius as a fraction of the image's larger side. */
  radius: number;
  /** true = paint solid, false = erase to background. */
  add: boolean;
}

/**
 * Burn painted strokes into a luminance grid as hard solid/background values.
 *
 * Applied AFTER smoothing and BEFORE tracing: a correction the user drew by
 * hand is a statement about the shape, not a measurement to be filtered, so
 * nothing downstream is allowed to soften it back out.
 */
export function applyMaskStrokes(
  grid: LuminanceGrid,
  strokes: readonly MaskStroke[],
  options: Pick<SilhouetteOptions, "threshold" | "invert">
): LuminanceGrid {
  if (strokes.length === 0) return grid;
  const { width, height } = grid;
  const values = new Float32Array(grid.values);
  const solid = options.invert ? 1 : 0;
  const background = options.invert ? 0 : 1;
  const scale = Math.max(width, height);

  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    const value = stroke.add ? solid : background;
    const radiusPx = Math.max(0.5, stroke.radius * scale);
    const r2 = radiusPx * radiusPx;
    const paintSegment = (
      ax: number,
      ay: number,
      bx: number,
      by: number
    ): void => {
      const minX = Math.max(0, Math.floor(Math.min(ax, bx) - radiusPx));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + radiusPx));
      const minY = Math.max(0, Math.floor(Math.min(ay, by) - radiusPx));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by) + radiusPx));
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          let t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ox = px - (ax + dx * t);
          const oy = py - (ay + dy * t);
          if (ox * ox + oy * oy <= r2) values[y * width + x] = value;
        }
      }
    };

    const toPixel = (p: [number, number]): [number, number] => [
      p[0] * width,
      p[1] * height,
    ];
    if (stroke.points.length === 1) {
      const [x, y] = toPixel(stroke.points[0]);
      paintSegment(x, y, x, y);
      continue;
    }
    for (let i = 1; i < stroke.points.length; i++) {
      const [ax, ay] = toPixel(stroke.points[i - 1]);
      const [bx, by] = toPixel(stroke.points[i]);
      paintSegment(ax, ay, bx, by);
    }
  }
  return { width, height, values };
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

/**
 * Traced contours below this area are dropped as specks. Shared with the
 * minimum-feature check on purpose: a measurement that reports a feature the
 * tracer then throws away is a measurement of nothing.
 */
const MIN_CONTOUR_AREA_MM2 = 1;

/**
 * Area in mm² of the solid component each pixel belongs to, 0 for background.
 *
 * 8-connected, which matters: a one-pixel-wide DIAGONAL stroke is a real
 * hairline and is 8-connected but not 4-connected, so labelling it by
 * 4-connectivity would shatter it into single pixels and the check would miss
 * exactly the defect it exists to find.
 */
function componentAreasMm2(
  mask: Uint8Array,
  width: number,
  height: number,
  pixelAreaMm2: number
): Float64Array {
  const label = new Int32Array(mask.length).fill(-1);
  const areas: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || label[start] >= 0) continue;
    const id = areas.length;
    let count = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      count++;
      const x = i % width;
      const y = (i / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const j = yy * width + xx;
          if (mask[j] === 1 && label[j] < 0) {
            label[j] = id;
            stack.push(j);
          }
        }
      }
    }
    areas.push(count * pixelAreaMm2);
  }
  const out = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (label[i] >= 0) out[i] = areas[label[i]];
  }
  return out;
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
  // Specks the tracer is going to discard must not be measured. Without this,
  // ONE dust pixel on a scan reported a 0.3 mm "feature" and thickened the
  // whole artwork — a 60-pixel logo square grew by 5.6% — to fix a mark that
  // never appeared in the output at all, and the notice explaining it named a
  // stroke width the user could not find anywhere in their drawing.
  const componentArea = componentAreasMm2(mask, width, height, px * px);
  let thinnestPx = Infinity;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mask[i] !== 1) continue;
      if (componentArea[i] < MIN_CONTOUR_AREA_MM2) continue;
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

// ---------------------------------------------------------------------------
// Contour vectorisation (curve fitting)
// ---------------------------------------------------------------------------

/**
 * Marching squares walks a grid, so its output is a staircase whichever way
 * you look at it. Douglas-Peucker used to reduce that staircase by KEEPING a
 * subset of its own points — which means the result is still on the staircase,
 * only with the steps further apart. Every letter and every logo edge came out
 * faceted, and the faceting was a property of the tracer, not of the artwork.
 *
 * Fitting cubics instead lets the curve pass BETWEEN the sample points, so the
 * grid quantisation averages out rather than being preserved: the same
 * tolerance buys a shape both closer to the original and described by fewer
 * points. There is no new setting — the tolerance is the one the tracer
 * already derives from the pixel size.
 *
 * Written from scratch: the classic tracer for this job, potrace, is GPL, and
 * this repository is not.
 */

type Point = [number, number];
type Cubic = [Point, Point, Point, Point];

/** How many points ahead a one-sided tangent looks. One step of the grid
 * staircase turns 45°, so a tangent from the immediate neighbour is noise. */
const TANGENT_SPAN = 3;
/** Recursion guard on fit splitting and on flattening. */
const MAX_FIT_DEPTH = 12;
const MAX_FLATTEN_DEPTH = 10;
/**
 * Flattening runs looser than fitting.
 *
 * The two errors do not add up in practice — the fit error is where the curve
 * sits relative to the samples, the flattening error is where the chord sits
 * relative to the curve, and the flatness test itself is conservative by about
 * a third. Measured on traced disks, raising this from 1 to 1.5 drops the
 * point count by a fifth and leaves the deviation from a true circle
 * unchanged; past 2 the deviation starts to climb.
 */
const FLATTEN_SLACK = 1.5;
/** Below this a loop has no curve worth fitting. */
const MIN_FIT_POINTS = 8;
/** Initial cuts of a closed loop; a single cubic cannot describe one. */
const INITIAL_SEGMENTS = 4;
/**
 * A corner is confirmed when the turn over the window reaches CONFIRM
 * somewhere, and the whole run of samples above SHOULDER around it is pinned.
 *
 * Two thresholds because a raster corner is not one sample. Marching squares
 * cuts a right angle into a 45° diagonal, so the 90° of turn arrives spread
 * over three or four samples with no single dominant one — pin only the
 * sharpest and the fit smooths straight across the shoulders, which is the
 * corner-cutting the whole exercise is trying to avoid.
 */
const CORNER_CONFIRM_RAD = (65 * Math.PI) / 180;
const CORNER_SHOULDER_RAD = (30 * Math.PI) / 180;

function subtract(a: Point, b: Point): Point {
  return [a[0] - b[0], a[1] - b[1]];
}

function normalize(v: Point): Point {
  const length = Math.hypot(v[0], v[1]);
  return length > 0 ? [v[0] / length, v[1] / length] : [0, 0];
}

/**
 * Unit direction leaving `points[from]` toward `points[to]`, averaged over the
 * span between them so a staircase step does not become the tangent.
 */
function spanTangent(points: Point[], from: number, to: number): Point {
  const step = to > from ? 1 : -1;
  const limit = Math.min(Math.abs(to - from), TANGENT_SPAN);
  let x = 0;
  let y = 0;
  for (let k = 1; k <= limit; k++) {
    const d = subtract(points[from + step * k], points[from]);
    // Nearer samples weigh more: they say where the curve leaves, the far
    // ones say where it is going.
    const weight = 1 / k;
    x += d[0] * weight;
    y += d[1] * weight;
  }
  return normalize([x, y]);
}

/** Unit direction through `index`, taken from both sides of the closed loop. */
function centredTangent(points: Point[], index: number): Point {
  const n = points.length;
  let x = 0;
  let y = 0;
  for (let k = 1; k <= TANGENT_SPAN; k++) {
    const d = subtract(points[(index + k) % n], points[(index - k + n) % n]);
    const weight = 1 / k;
    x += d[0] * weight;
    y += d[1] * weight;
  }
  return normalize([x, y]);
}

/**
 * Indices where the outline genuinely turns a corner.
 *
 * Corners have to be found GEOMETRICALLY and pinned as segment ends, not left
 * to the fit's error-driven splitting. The fit tolerance must be at least the
 * size of the grid quantisation — that is what lets it average the staircase
 * away — and any tolerance-bounded fit is free to cut a sharp corner by that
 * much. Pinning the corner makes it an endpoint, which is exact.
 *
 * The turn is measured across `windowMm` of arc on each side rather than
 * between neighbouring samples: one step of a marching-squares staircase turns
 * 45°, so a per-sample test would call every edge of every shape a corner.
 */
function findCorners(points: Point[], windowMm: number): number[] {
  const n = points.length;
  if (n < MIN_FIT_POINTS || !(windowMm > 0)) return [];
  const maxSteps = Math.max(2, Math.floor(n / 4));
  /** Index reached by walking `dir` from `i` until `windowMm` of arc passes. */
  const walk = (i: number, dir: number): number => {
    let length = 0;
    let j = i;
    for (let s = 0; s < maxSteps; s++) {
      const next = (j + dir + n) % n;
      length += Math.hypot(...subtract(points[next], points[j]));
      j = next;
      if (length >= windowMm) break;
    }
    return j;
  };

  const turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = normalize(subtract(points[i], points[walk(i, -1)]));
    const b = normalize(subtract(points[walk(i, 1)], points[i]));
    if ((a[0] === 0 && a[1] === 0) || (b[0] === 0 && b[1] === 0)) continue;
    turn[i] = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1])));
  }

  // Walk the loop once, collecting maximal runs above the shoulder threshold
  // and keeping only those that peak above the confirm threshold. A gently
  // curving outline sits below the shoulder everywhere; a small circle sits
  // above the shoulder everywhere but never peaks, so it stays smooth too.
  const pinned: number[] = [];
  let start = 0;
  while (start < n && turn[start] >= CORNER_SHOULDER_RAD) start++;
  if (start === n) return []; // above the shoulder all the way round
  for (let offset = 0; offset < n; offset++) {
    const i = (start + offset) % n;
    if (turn[i] < CORNER_SHOULDER_RAD) continue;
    const run: number[] = [];
    let peak = 0;
    let k = offset;
    while (k < n) {
      const index = (start + k) % n;
      if (turn[index] < CORNER_SHOULDER_RAD) break;
      run.push(index);
      peak = Math.max(peak, turn[index]);
      k++;
    }
    if (peak >= CORNER_CONFIRM_RAD) pinned.push(...run);
    offset = k - 1;
  }
  return pinned.sort((p, q) => p - q);
}

function bezierAt(curve: Cubic, t: number): Point {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return [
    curve[0][0] * b0 + curve[1][0] * b1 + curve[2][0] * b2 + curve[3][0] * b3,
    curve[0][1] * b0 + curve[1][1] * b1 + curve[2][1] * b2 + curve[3][1] * b3,
  ];
}

/** Chord-length parameterisation of a point run, normalised to 0..1. */
function chordParameters(points: Point[], start: number, end: number): number[] {
  const u = [0];
  for (let i = start + 1; i <= end; i++) {
    u.push(u[u.length - 1] + Math.hypot(...subtract(points[i], points[i - 1])));
  }
  const total = u[u.length - 1];
  if (!(total > 0)) return u.map((_, i) => i / Math.max(1, u.length - 1));
  return u.map((v) => v / total);
}

/**
 * Least-squares cubic through `points[start..end]` with the given unit end
 * tangents, solved for the two control-point distances. The 2×2 normal
 * equations are the standard ones; `t2` points BACK from the end point.
 */
function fitOneCubic(
  points: Point[],
  start: number,
  end: number,
  t1: Point,
  t2: Point,
  u: number[]
): Cubic {
  const first = points[start];
  const last = points[end];
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i <= end - start; i++) {
    const t = u[i];
    const v = 1 - t;
    const b0 = v * v * v;
    const b1 = 3 * v * v * t;
    const b2 = 3 * v * t * t;
    const b3 = t * t * t;
    const a1: Point = [t1[0] * b1, t1[1] * b1];
    const a2: Point = [t2[0] * b2, t2[1] * b2];
    c00 += a1[0] * a1[0] + a1[1] * a1[1];
    c01 += a1[0] * a2[0] + a1[1] * a2[1];
    c11 += a2[0] * a2[0] + a2[1] * a2[1];
    const target: Point = [
      points[start + i][0] - (first[0] * (b0 + b1) + last[0] * (b2 + b3)),
      points[start + i][1] - (first[1] * (b0 + b1) + last[1] * (b2 + b3)),
    ];
    x0 += target[0] * a1[0] + target[1] * a1[1];
    x1 += target[0] * a2[0] + target[1] * a2[1];
  }

  const det = c00 * c11 - c01 * c01;
  const chord = Math.hypot(...subtract(last, first));
  let alpha1 = det !== 0 ? (x0 * c11 - x1 * c01) / det : 0;
  let alpha2 = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0;
  // A degenerate solve means the data does not constrain the handles; the
  // even-thirds fallback is what every implementation of this uses.
  const minimum = chord * 1e-6;
  if (!(alpha1 > minimum) || !(alpha2 > minimum) || !Number.isFinite(alpha1) || !Number.isFinite(alpha2)) {
    alpha1 = chord / 3;
    alpha2 = chord / 3;
  }
  return [
    first,
    [first[0] + t1[0] * alpha1, first[1] + t1[1] * alpha1],
    [last[0] + t2[0] * alpha2, last[1] + t2[1] * alpha2],
    last,
  ];
}

/** Fit `points[start..end]`, splitting at the worst sample until it holds. */
function fitCubics(
  points: Point[],
  start: number,
  end: number,
  t1: Point,
  t2: Point,
  tolerance: number,
  depth: number,
  out: Cubic[]
): void {
  if (end - start < 1) return;
  if (end - start === 1) {
    const a = points[start];
    const b = points[end];
    out.push([a, a, b, b]);
    return;
  }

  const u = chordParameters(points, start, end);
  const curve = fitOneCubic(points, start, end, t1, t2, u);

  let worst = -1;
  let worstError = 0;
  for (let i = 1; i < end - start; i++) {
    const on = bezierAt(curve, u[i]);
    const error = Math.hypot(...subtract(points[start + i], on));
    if (error > worstError) {
      worstError = error;
      worst = start + i;
    }
  }
  if (worstError <= tolerance || depth >= MAX_FIT_DEPTH || worst <= start || worst >= end) {
    out.push(curve);
    return;
  }

  // Split at the worst sample with ONE-SIDED tangents on each side. A corner
  // is exactly where the fit fails, so this both refines a curve and keeps a
  // corner sharp — a centred tangent here would round off every serif.
  fitCubics(points, start, worst, t1, spanTangent(points, worst, start), tolerance, depth + 1, out);
  fitCubics(points, worst, end, spanTangent(points, worst, end), t2, tolerance, depth + 1, out);
}

/** Emit `curve` as points, subdividing until the control polygon is flat. */
function flatten(curve: Cubic, tolerance: number, depth: number, out: Point[]): void {
  const [p0, p1, p2, p3] = curve;
  const dx = p3[0] - p0[0];
  const dy = p3[1] - p0[1];
  const chord = Math.hypot(dx, dy);
  if (depth >= MAX_FLATTEN_DEPTH || chord === 0) {
    out.push(p0);
    return;
  }
  const distance = (p: Point) => Math.abs(dy * (p[0] - p0[0]) - dx * (p[1] - p0[1])) / chord;
  if (Math.max(distance(p1), distance(p2)) <= tolerance) {
    out.push(p0);
    return;
  }
  // de Casteljau at t = 1/2.
  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const centre = mid(p012, p123);
  flatten([p0, p01, p012, centre], tolerance, depth + 1, out);
  flatten([centre, p123, p23, p3], tolerance, depth + 1, out);
}

/**
 * Vectorise one closed traced loop: fit cubics through it, then flatten them
 * back to the point list the extruder consumes.
 *
 * Point ORDER is never touched, only how many points there are and where they
 * sit, so the loop's winding survives untouched — which matters more here than
 * it looks: outers and holes come out of the tracer with OPPOSITE windings and
 * Clipper2's NonZero fill is what turns that into a hole. Reverse a loop and
 * the hole fills in.
 */
export function fitClosedContour(
  points: Point[],
  tolerance: number,
  cornerWindowMm = tolerance * 6
): Point[] {
  const n = points.length;
  if (n < MIN_FIT_POINTS) return points;

  // Cut the closed loop into open runs before fitting — one cubic cannot
  // describe a closed curve. Corners are the natural cuts; where a loop has
  // fewer than two, evenly spaced ones stand in, so no single seam carries
  // the whole approximation error.
  const corners = findCorners(points, cornerWindowMm);
  const cuts = new Set(corners);
  if (cuts.size < 2) {
    for (let i = 0; i < INITIAL_SEGMENTS; i++) {
      cuts.add(Math.round((i * n) / INITIAL_SEGMENTS) % n);
    }
  }
  const ordered = [...cuts].sort((p, q) => p - q);
  if (ordered.length < 2) return points;

  // A cut that is not a corner is a place the curve passes STRAIGHT through,
  // so both runs meeting there share one centred tangent and the join stays
  // smooth. At a corner each side keeps its own direction.
  const cornerSet = new Set(corners);
  const smoothTangent = new Map<number, Point>();
  for (const cut of ordered) {
    if (!cornerSet.has(cut)) smoothTangent.set(cut, centredTangent(points, cut));
  }

  const curves: Cubic[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const from = ordered[i];
    const to = ordered[(i + 1) % ordered.length];
    // Unroll the wrap so the run is a plain ascending range.
    const run: Point[] =
      to > from
        ? points.slice(from, to + 1)
        : [...points.slice(from), ...points.slice(0, to + 1)];
    if (run.length < 2) continue;
    const startTangent = smoothTangent.get(from) ?? spanTangent(run, 0, run.length - 1);
    const endSmooth = smoothTangent.get(to);
    const endTangent: Point = endSmooth
      ? [-endSmooth[0], -endSmooth[1]]
      : spanTangent(run, run.length - 1, 0);
    fitCubics(run, 0, run.length - 1, startTangent, endTangent, tolerance, 0, curves);
  }
  if (curves.length === 0) return points;

  const out: Point[] = [];
  for (const curve of curves) flatten(curve, tolerance * FLATTEN_SLACK, 0, out);
  // Fewer than three points is not a polygon; the caller drops it either way,
  // but returning the original keeps the failure visible rather than silent.
  return out.length >= 3 ? out : points;
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
    // The corner window is in pixels, not in tolerance: it has to span the
    // grid's own staircase, which is what makes a bend distinguishable from
    // quantisation in the first place.
    const simplified = fitClosedContour(mm, tolerance, px * 2.5);
    if (simplified.length < 3) continue;
    // Discard specks — the same threshold measureThinnestFeature ignores.
    let area = 0;
    for (let i = 0; i < simplified.length; i++) {
      const [x1, y1] = simplified[i];
      const [x2, y2] = simplified[(i + 1) % simplified.length];
      area += x1 * y2 - x2 * y1;
    }
    if (Math.abs(area / 2) < MIN_CONTOUR_AREA_MM2) continue;
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
