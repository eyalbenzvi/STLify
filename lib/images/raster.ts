/**
 * Pure raster-image operations used by the image-relief pipeline.
 *
 * Everything here works on plain RGBA byte buffers (no Canvas / DOM), so it
 * runs identically on the main thread, in a Web Worker, and in node tests.
 */

import type { ImageAdjustments } from "@/types/design";

export interface RawImage {
  width: number;
  height: number;
  /** RGBA, row-major, row 0 = top. */
  data: Uint8ClampedArray;
}

export function createRaw(width: number, height: number): RawImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneRaw(image: RawImage): RawImage {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
}

// ---------------------------------------------------------------------------
// Geometric operations
// ---------------------------------------------------------------------------

export function crop(
  image: RawImage,
  leftFrac: number,
  rightFrac: number,
  topFrac: number,
  bottomFrac: number
): RawImage {
  const l = Math.round(image.width * clamp01(leftFrac));
  const r = Math.round(image.width * clamp01(rightFrac));
  const t = Math.round(image.height * clamp01(topFrac));
  const b = Math.round(image.height * clamp01(bottomFrac));
  const w = Math.max(1, image.width - l - r);
  const h = Math.max(1, image.height - t - b);
  const out = createRaw(w, h);
  for (let y = 0; y < h; y++) {
    const srcStart = ((y + t) * image.width + l) * 4;
    out.data.set(image.data.subarray(srcStart, srcStart + w * 4), y * w * 4);
  }
  return out;
}

/** Rotate by `turns` clockwise quarter-turns (0..3). */
export function rotate90(image: RawImage, turns: number): RawImage {
  const n = ((turns % 4) + 4) % 4;
  if (n === 0) return image;
  const { width: w, height: h } = image;
  const out = n === 2 ? createRaw(w, h) : createRaw(h, w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      let dst: number;
      if (n === 1) dst = (x * h + (h - 1 - y)) * 4; // 90° CW
      else if (n === 2) dst = ((h - 1 - y) * w + (w - 1 - x)) * 4;
      else dst = ((w - 1 - x) * h + y) * 4; // 270° CW
      out.data[dst] = image.data[src];
      out.data[dst + 1] = image.data[src + 1];
      out.data[dst + 2] = image.data[src + 2];
      out.data[dst + 3] = image.data[src + 3];
    }
  }
  return out;
}

export function flip(image: RawImage, horizontal: boolean, vertical: boolean): RawImage {
  if (!horizontal && !vertical) return image;
  const { width: w, height: h } = image;
  const out = createRaw(w, h);
  for (let y = 0; y < h; y++) {
    const sy = vertical ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const sx = horizontal ? w - 1 - x : x;
      const src = (sy * w + sx) * 4;
      const dst = (y * w + x) * 4;
      out.data[dst] = image.data[src];
      out.data[dst + 1] = image.data[src + 1];
      out.data[dst + 2] = image.data[src + 2];
      out.data[dst + 3] = image.data[src + 3];
    }
  }
  return out;
}

/** Free rotation (degrees, CCW) with bilinear sampling; grows the canvas. */
export function rotateFree(image: RawImage, degrees: number): RawImage {
  const rad = (degrees * Math.PI) / 180;
  if (Math.abs(rad) < 1e-6) return image;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const { width: w, height: h } = image;
  const outW = Math.max(1, Math.ceil(Math.abs(w * cos) + Math.abs(h * sin)));
  const outH = Math.max(1, Math.ceil(Math.abs(w * sin) + Math.abs(h * cos)));
  const out = createRaw(outW, outH);
  const cx = w / 2;
  const cy = h / 2;
  const ox = outW / 2;
  const oy = outH / 2;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      // Inverse mapping (rotate destination back into the source frame).
      const dx = x + 0.5 - ox;
      const dy = y + 0.5 - oy;
      const sx = dx * cos + dy * sin + cx - 0.5;
      const sy = -dx * sin + dy * cos + cy - 0.5;
      const dst = (y * outW + x) * 4;
      bilinearSample(image, sx, sy, out.data, dst);
    }
  }
  return out;
}

function bilinearSample(
  image: RawImage,
  sx: number,
  sy: number,
  outData: Uint8ClampedArray,
  outOffset: number
): void {
  const { width: w, height: h, data } = image;
  if (sx < -1 || sy < -1 || sx > w || sy > h) return; // fully outside → transparent
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const fx = sx - x0;
  const fy = sy - y0;
  let racc = 0;
  let gacc = 0;
  let bacc = 0;
  let aacc = 0;
  for (let j = 0; j <= 1; j++) {
    for (let i = 0; i <= 1; i++) {
      const px = x0 + i;
      const py = y0 + j;
      const weight = (i === 0 ? 1 - fx : fx) * (j === 0 ? 1 - fy : fy);
      if (px < 0 || py < 0 || px >= w || py >= h || weight === 0) continue;
      const idx = (py * w + px) * 4;
      const a = data[idx + 3] / 255;
      racc += data[idx] * a * weight;
      gacc += data[idx + 1] * a * weight;
      bacc += data[idx + 2] * a * weight;
      aacc += data[idx + 3] * weight;
    }
  }
  const alpha = aacc / 255;
  outData[outOffset] = alpha > 0 ? racc / alpha : 0;
  outData[outOffset + 1] = alpha > 0 ? gacc / alpha : 0;
  outData[outOffset + 2] = alpha > 0 ? bacc / alpha : 0;
  outData[outOffset + 3] = aacc;
}

/** Nearest-neighbour + box downsample to fit within maxDim (keeps aspect). */
export function resizeToFit(image: RawImage, maxDim: number): RawImage {
  const { width: w, height: h } = image;
  if (w <= maxDim && h <= maxDim) return image;
  const scale = maxDim / Math.max(w, h);
  return resample(image, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
}

/** Area-average resample to an exact size. */
export function resample(image: RawImage, outW: number, outH: number): RawImage {
  const out = createRaw(outW, outH);
  const { width: w, height: h, data } = image;
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor((y * h) / outH);
    const y1 = Math.max(y0 + 1, Math.ceil(((y + 1) * h) / outH));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor((x * w) / outW);
      const x1 = Math.max(x0 + 1, Math.ceil(((x + 1) * w) / outW));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < h; sy++) {
        for (let sx = x0; sx < x1 && sx < w; sx++) {
          const idx = (sy * w + sx) * 4;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          a += data[idx + 3];
          n++;
        }
      }
      const dst = (y * outW + x) * 4;
      out.data[dst] = r / n;
      out.data[dst + 1] = g / n;
      out.data[dst + 2] = b / n;
      out.data[dst + 3] = a / n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tonal operations (in-place on a copy)
// ---------------------------------------------------------------------------

export function applyTonal(image: RawImage, adj: ImageAdjustments): RawImage {
  const out = cloneRaw(image);
  const { data } = out;
  const brightness = (clampRange(adj.brightness, -100, 100) / 100) * 128;
  const c = clampRange(adj.contrast, -100, 100) / 100;
  const contrastFactor = c >= 0 ? 1 + c * 2 : 1 + c * 0.9;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    r = (r - 128) * contrastFactor + 128 + brightness;
    g = (g - 128) * contrastFactor + 128 + brightness;
    b = (b - 128) * contrastFactor + 128 + brightness;

    if (adj.grayscale) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = g = b = lum;
    }
    if (adj.invert) {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }

  let result = out;
  if (adj.blurPx > 0) result = boxBlur(result, Math.min(10, Math.round(adj.blurPx)));

  if (adj.posterizeLevels >= 2) {
    const levels = Math.min(8, Math.round(adj.posterizeLevels));
    const step = 255 / (levels - 1);
    const d = result.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.round(d[i] / step) * step;
      d[i + 1] = Math.round(d[i + 1] / step) * step;
      d[i + 2] = Math.round(d[i + 2] / step) * step;
    }
  }

  if (adj.threshold >= 0) {
    const t = clampRange(adj.threshold, 0, 255);
    const d = result.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const v = lum >= t ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }

  return result;
}

/** Separable box blur (3 passes ≈ gaussian). */
export function boxBlur(image: RawImage, radius: number): RawImage {
  let current = image;
  for (let pass = 0; pass < 3; pass++) {
    current = boxBlurPass(current, radius, true);
    current = boxBlurPass(current, radius, false);
  }
  return current;
}

function boxBlurPass(image: RawImage, radius: number, horizontal: boolean): RawImage {
  const { width: w, height: h, data } = image;
  const out = createRaw(w, h);
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const window = radius * 2 + 1;
  for (let line = 0; line < lines; line++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    const idxOf = (i: number): number =>
      horizontal ? (line * w + i) * 4 : (i * w + line) * 4;
    for (let i = -radius; i <= radius; i++) {
      const idx = idxOf(clampRange(i, 0, len - 1));
      r += data[idx];
      g += data[idx + 1];
      b += data[idx + 2];
      a += data[idx + 3];
    }
    for (let i = 0; i < len; i++) {
      const dst = idxOf(i);
      out.data[dst] = r / window;
      out.data[dst + 1] = g / window;
      out.data[dst + 2] = b / window;
      out.data[dst + 3] = a / window;
      const removeIdx = idxOf(clampRange(i - radius, 0, len - 1));
      const addIdx = idxOf(clampRange(i + radius + 1, 0, len - 1));
      r += data[addIdx] - data[removeIdx];
      g += data[addIdx + 1] - data[removeIdx + 1];
      b += data[addIdx + 2] - data[removeIdx + 2];
      a += data[addIdx + 3] - data[removeIdx + 3];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full adjustment pipeline
// ---------------------------------------------------------------------------

/** Apply all adjustments in canonical order. Pure. */
export function applyAdjustments(source: RawImage, adj: ImageAdjustments): RawImage {
  let image = source;
  if (adj.cropLeft || adj.cropRight || adj.cropTop || adj.cropBottom) {
    image = crop(image, adj.cropLeft, adj.cropRight, adj.cropTop, adj.cropBottom);
  }
  image = rotate90(image, adj.rotate90);
  image = flip(image, adj.flipH, adj.flipV);
  image = rotateFree(image, adj.freeRotationDeg);
  image = applyTonal(image, adj);
  return image;
}

/** Multiply the image's alpha channel by a mask (255 = keep). */
export function applyMask(image: RawImage, mask: Uint8Array | Uint8ClampedArray): RawImage {
  if (mask.length !== image.width * image.height) return image;
  const out = cloneRaw(image);
  for (let i = 0; i < mask.length; i++) {
    out.data[i * 4 + 3] = (out.data[i * 4 + 3] * mask[i]) / 255;
  }
  return out;
}

export function luminanceAt(image: RawImage, index: number): number {
  const i = index * 4;
  return (
    0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]
  );
}

function clamp01(v: number): number {
  return Math.min(0.45, Math.max(0, v));
}

function clampRange(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
