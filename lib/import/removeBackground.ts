/**
 * Automatic background removal — pure algorithm (no DOM), suitable for
 * running inside a Web Worker. Nothing here may reach for canvas or
 * `document`; the raster arrives as bytes and leaves as a mask.
 *
 * Approach: classic border-seeded flood fill. The border pixels are
 * clustered into up to two dominant colours; every pixel reachable from the
 * border whose colour stays within the tolerance of a cluster centre is
 * classified as background. This is fully client-side (no uploads, no ML
 * model download), deterministic, fast, and works well for logos, product
 * shots and scans on roughly uniform backgrounds.
 *
 * Colours are compared in CIELAB, not RGB. RGB distance is not perceptual:
 * it merges saturated colours a person reads as plainly different (yellow and
 * orange sit 75 RGB units apart, closer than the default tolerance) while
 * splitting near-identical dark tones. Both errors show up as holes in the
 * subject or background left behind.
 *
 * When it fails (busy backgrounds), the image dialog offers the threshold
 * controls and a manual mask brush over a live silhouette preview
 * (`MaskBrush` in components/dialogs/ImportDialogs.tsx). Until V7 this
 * paragraph named a brush that did not exist and the dialog had no recourse
 * at all — which is why it now names the component, so the claim can be
 * checked rather than believed.
 */

/** RGBA raster, row-major, row 0 = top. */
export interface RawImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface RemoveBackgroundOptions {
  /** Colour distance tolerance, 0..100 (default 24). */
  tolerance: number;
  /** Progress callback with 0..1. */
  onProgress?: (fraction: number) => void;
}

export interface RemoveBackgroundResult {
  /** Per-pixel mask: 255 = keep (foreground), 0 = remove. */
  mask: Uint8Array;
  /** Fraction of pixels classified as background, 0..1. */
  backgroundFraction: number;
}

/** A colour in CIELAB: lightness 0..100, then the two opponent axes. */
type Lab = [number, number, number];

interface Cluster {
  centre: Lab;
  count: number;
}

/** sRGB byte → linear light. Table because it runs once per channel per pixel. */
const SRGB_TO_LINEAR = (() => {
  const table = new Float64Array(256);
  for (let v = 0; v < 256; v++) {
    const c = v / 255;
    table[v] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

/** CIE standard illuminant D65, the sRGB white point. */
const WHITE_X = 0.95047;
const WHITE_Y = 1.0;
const WHITE_Z = 1.08883;

function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29;
}

/** sRGB (0..255) → CIELAB, D65, the standard two-step through XYZ. */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const rl = SRGB_TO_LINEAR[r | 0];
  const gl = SRGB_TO_LINEAR[g | 0];
  const bl = SRGB_TO_LINEAR[b | 0];
  const x = labF((0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / WHITE_X);
  const y = labF((0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl) / WHITE_Y);
  const z = labF((0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / WHITE_Z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** Squared CIE76 ΔE — Euclidean distance in CIELAB. */
function deltaE2(a: Lab, b: Lab): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** Cluster border pixels into up to two dominant colours (mini k-means). */
function borderClusters(image: RawImage, lab: Float32Array): Cluster[] {
  const { width: w, height: h, data } = image;
  const samples: Lab[] = [];
  const push = (x: number, y: number): void => {
    const i = y * w + x;
    if (data[i * 4 + 3] < 16) return; // already-transparent border counts as background anyway
    samples.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    push(0, y);
    push(w - 1, y);
  }
  if (samples.length === 0) return [];

  // Initialise two centres from the first and the most-distant sample.
  let c1 = samples[0];
  let far = samples[0];
  let farDist = -1;
  for (const s of samples) {
    const d = deltaE2(s, c1);
    if (d > farDist) {
      farDist = d;
      far = s;
    }
  }
  let c2 = far;

  let assign = new Array<number>(samples.length).fill(0);
  for (let iter = 0; iter < 6; iter++) {
    assign = samples.map((s) => (deltaE2(s, c1) <= deltaE2(s, c2) ? 0 : 1));
    const sums: [Lab, Lab] = [
      [0, 0, 0],
      [0, 0, 0],
    ];
    const counts = [0, 0];
    samples.forEach((s, i) => {
      const c = sums[assign[i]];
      c[0] += s[0];
      c[1] += s[1];
      c[2] += s[2];
      counts[assign[i]]++;
    });
    if (counts[0] > 0) c1 = [sums[0][0] / counts[0], sums[0][1] / counts[0], sums[0][2] / counts[0]];
    if (counts[1] > 0) c2 = [sums[1][0] / counts[1], sums[1][1] / counts[1], sums[1][2] / counts[1]];
  }

  const n0 = assign.filter((a) => a === 0).length;
  const n1 = assign.length - n0;
  const clusters: Cluster[] = [];
  if (n0 > 0) clusters.push({ centre: c1, count: n0 });
  // Keep the second cluster only when it is a meaningful share of the border.
  if (n1 > assign.length * 0.15) clusters.push({ centre: c2, count: n1 });
  return clusters;
}

/**
 * The 0..100 tolerance in ΔE units.
 *
 * The scale is a stored/user-facing number whose meaning was defined by the
 * old squared-RGB mapping (`tolerance × 4.42` RGB units), so the metric could
 * not change without redefining every value already in use. Along the grey
 * axis — where most backgrounds live, and where the two metrics can be
 * compared directly — an RGB distance of `tolerance × 4.42` works out at very
 * nearly `tolerance` ΔE: at the default 24 the old threshold spans RGB 106,
 * which is ΔE 27 at grey 40, 23 at grey 128 and 22 at grey 180. So the
 * mapping is 1:1, and the default keeps doing what it did. Off the grey axis
 * the two deliberately part company — that is the entire point of the change.
 */
const DELTA_E_PER_TOLERANCE_UNIT = 1;

/**
 * Compute a background mask for the image. 255 = foreground (keep).
 */
export function removeBackgroundAuto(
  image: RawImage,
  options: RemoveBackgroundOptions
): RemoveBackgroundResult {
  const { width: w, height: h, data } = image;
  const total = w * h;
  const mask = new Uint8Array(total).fill(255);
  const tolerance = Math.max(1, Math.min(100, options.tolerance));
  const maxDeltaE2 = (tolerance * DELTA_E_PER_TOLERANCE_UNIT) ** 2;

  // One conversion per pixel, held for the whole run: the flood fill retests
  // a rejected pixel once per neighbour that reaches it.
  const lab = new Float32Array(total * 3);
  for (let i = 0; i < total; i++) {
    const [L, a, b] = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    lab[i * 3] = L;
    lab[i * 3 + 1] = a;
    lab[i * 3 + 2] = b;
  }

  const clusters = borderClusters(image, lab);
  options.onProgress?.(0.1);

  const isBackgroundColor = (i: number): boolean => {
    if (data[i * 4 + 3] < 16) return true; // transparent already
    const px: Lab = [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
    for (const c of clusters) {
      if (deltaE2(px, c.centre) <= maxDeltaE2) return true;
    }
    return false;
  };

  // BFS flood fill from every border pixel that matches a background colour.
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const seed = (i: number): void => {
    if (!visited[i] && isBackgroundColor(i)) {
      visited[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }

  let processed = 0;
  const progressStep = Math.max(1, Math.floor(total / 20));
  while (head < tail) {
    const i = queue[head++];
    mask[i] = 0;
    processed++;
    if (options.onProgress && processed % progressStep === 0) {
      options.onProgress(0.1 + 0.8 * Math.min(1, processed / total));
    }
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }

  // Light edge smoothing: shrink jagged single-pixel noise.
  smoothMask(mask, w, h);
  options.onProgress?.(1);

  let bg = 0;
  for (let i = 0; i < total; i++) if (mask[i] === 0) bg++;
  return { mask, backgroundFraction: bg / total };
}

/** Majority filter over the 3×3 neighbourhood (one pass). */
function smoothMask(mask: Uint8Array, w: number, h: number): void {
  const src = new Uint8Array(mask);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let keep = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (src[i + dy * w + dx] === 255) keep++;
        }
      }
      mask[i] = keep >= 5 ? 255 : 0;
    }
  }
}
