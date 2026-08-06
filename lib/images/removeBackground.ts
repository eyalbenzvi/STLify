/**
 * Automatic background removal — pure algorithm (no DOM), suitable for
 * running inside a Web Worker.
 *
 * Approach: classic border-seeded flood fill. The border pixels are
 * clustered into up to two dominant colours; every pixel reachable from the
 * border whose colour stays within the tolerance of a cluster centre is
 * classified as background. This is fully client-side (no uploads, no ML
 * model download), deterministic, fast, and works well for logos, product
 * shots and scans on roughly uniform backgrounds.
 *
 * When it fails (busy backgrounds), the UI offers threshold mode and manual
 * mask brushing as fallbacks — see the image dialog.
 */

import type { RawImage } from "./raster";

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

interface Cluster {
  r: number;
  g: number;
  b: number;
  count: number;
}

/** Cluster border pixels into up to two dominant colours (mini k-means). */
function borderClusters(image: RawImage): Cluster[] {
  const { width: w, height: h, data } = image;
  const samples: [number, number, number][] = [];
  const push = (x: number, y: number): void => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 16) return; // already-transparent border counts as background anyway
    samples.push([data[i], data[i + 1], data[i + 2]]);
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
    const d = dist2(s, c1);
    if (d > farDist) {
      farDist = d;
      far = s;
    }
  }
  let c2 = far;

  let assign = new Array<number>(samples.length).fill(0);
  for (let iter = 0; iter < 6; iter++) {
    assign = samples.map((s) => (dist2(s, c1) <= dist2(s, c2) ? 0 : 1));
    const sums: Cluster[] = [
      { r: 0, g: 0, b: 0, count: 0 },
      { r: 0, g: 0, b: 0, count: 0 },
    ];
    samples.forEach((s, i) => {
      const c = sums[assign[i]];
      c.r += s[0];
      c.g += s[1];
      c.b += s[2];
      c.count++;
    });
    if (sums[0].count > 0) c1 = [sums[0].r / sums[0].count, sums[0].g / sums[0].count, sums[0].b / sums[0].count];
    if (sums[1].count > 0) c2 = [sums[1].r / sums[1].count, sums[1].g / sums[1].count, sums[1].b / sums[1].count];
  }

  const n0 = assign.filter((a) => a === 0).length;
  const n1 = assign.length - n0;
  const clusters: Cluster[] = [];
  if (n0 > 0) clusters.push({ r: c1[0], g: c1[1], b: c1[2], count: n0 });
  // Keep the second cluster only when it is a meaningful share of the border.
  if (n1 > assign.length * 0.15) clusters.push({ r: c2[0], g: c2[1], b: c2[2], count: n1 });
  return clusters;
}

function dist2(a: [number, number, number], b: [number, number, number] | Cluster): number {
  const br = Array.isArray(b) ? b[0] : b.r;
  const bg = Array.isArray(b) ? b[1] : b.g;
  const bb = Array.isArray(b) ? b[2] : b.b;
  return (a[0] - br) ** 2 + (a[1] - bg) ** 2 + (a[2] - bb) ** 2;
}

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
  // Map the 0..100 tolerance to a squared RGB distance.
  const maxDist2 = (tolerance * 4.42) ** 2;

  const clusters = borderClusters(image);
  options.onProgress?.(0.1);

  const isBackgroundColor = (i: number): boolean => {
    if (data[i * 4 + 3] < 16) return true; // transparent already
    const px: [number, number, number] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    for (const c of clusters) {
      if (dist2(px, c) <= maxDist2) return true;
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
