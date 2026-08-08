/**
 * Pure raster ↔ tensor plumbing for the on-device models.
 *
 * Everything here is node-testable: plain arrays in, plain arrays out, no
 * canvas and no runtime. The browser decode wrapper lives in imageDecode.ts.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  data: Uint8Array | Uint8ClampedArray;
}

/**
 * Bilinear sample of a single-channel row-major grid, `x`/`y` in destination
 * pixel centres mapped into source space.
 */
export function bilinearResample(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Float32Array {
  if (srcWidth === dstWidth && srcHeight === dstHeight) return new Float32Array(src);
  const out = new Float32Array(dstWidth * dstHeight);
  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;
  for (let y = 0; y < dstHeight; y++) {
    // Pixel-centre mapping keeps the image from shifting by half a pixel.
    const sy = Math.min(srcHeight - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcHeight - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dstWidth; x++) {
      const sx = Math.min(srcWidth - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcWidth - 1, x0 + 1);
      const fx = sx - x0;
      const top = src[y0 * srcWidth + x0] * (1 - fx) + src[y0 * srcWidth + x1] * fx;
      const bottom = src[y1 * srcWidth + x0] * (1 - fx) + src[y1 * srcWidth + x1] * fx;
      out[y * dstWidth + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

/**
 * RGBA image → normalised 1×3×size×size CHW tensor, aspect squashed to the
 * square input exactly as both models were trained to receive it.
 * Transparent pixels composite onto white — the same convention the
 * silhouette decode uses for "background".
 */
export function rgbaToChwTensor(
  image: RgbaImage,
  size: number,
  mean: [number, number, number],
  std: [number, number, number]
): Float32Array {
  const { width, height, data } = image;
  const channelStride = size * size;
  const out = new Float32Array(3 * channelStride);
  const scaleX = width / size;
  const scaleY = height / size;
  for (let y = 0; y < size; y++) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < size; x++) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (y0 * width + x0) * 4;
      const i01 = (y0 * width + x1) * 4;
      const i10 = (y1 * width + x0) * 4;
      const i11 = (y1 * width + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w01 = fx * (1 - fy);
      const w10 = (1 - fx) * fy;
      const w11 = fx * fy;
      const o = y * size + x;
      for (let c = 0; c < 3; c++) {
        // Alpha-composite each sample onto white before interpolating.
        const s00 = data[i00 + c] * (data[i00 + 3] / 255) + 255 * (1 - data[i00 + 3] / 255);
        const s01 = data[i01 + c] * (data[i01 + 3] / 255) + 255 * (1 - data[i01 + 3] / 255);
        const s10 = data[i10 + c] * (data[i10 + 3] / 255) + 255 * (1 - data[i10 + 3] / 255);
        const s11 = data[i11 + c] * (data[i11 + 3] / 255) + 255 * (1 - data[i11 + 3] / 255);
        const value = (s00 * w00 + s01 * w01 + s10 * w10 + s11 * w11) / 255;
        out[c * channelStride + o] = (value - mean[c]) / std[c];
      }
    }
  }
  return out;
}

/**
 * Min-max normalise a map to 0..1 in place. Returns false when the map is
 * flat (max ≈ min) — the caller's signal that the model saw nothing.
 */
export function minMaxNormalize(values: Float32Array): boolean {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (!(range > 1e-6)) {
    values.fill(0);
    return false;
  }
  for (let i = 0; i < values.length; i++) values[i] = (values[i] - min) / range;
  return true;
}
