/**
 * Processed image → height field sampling for the relief pipeline. Pure.
 */

import type { ImageReliefLayer, ImageResolution } from "@/types/design";
import { luminanceAt, resample, type RawImage } from "./raster";

/** Approximate physical sample pitch (mm per sample) per quality level. */
const RESOLUTION_PITCH_MM: Record<ImageResolution, number> = {
  draft: 1.0,
  standard: 0.5,
  fine: 0.25,
};

/** Hard cap on samples per axis, per quality level. */
const RESOLUTION_MAX_SAMPLES: Record<ImageResolution, number> = {
  draft: 96,
  standard: 192,
  fine: 320,
};

export interface HeightField {
  cols: number;
  rows: number;
  /** Height per sample in mm (already mapped), row-major, row 0 = top. */
  heights: Float32Array;
  /** 1 = solid material, 0 = masked out (transparent). */
  coverage: Uint8Array;
  /** True when any sample is masked out. */
  hasMask: boolean;
  /** Fraction of covered samples, 0..1. */
  coverageFraction: number;
}

export function estimateGridSize(
  layer: Pick<ImageReliefLayer, "widthMm" | "heightMm" | "resolution">
): { cols: number; rows: number } {
  const pitch = RESOLUTION_PITCH_MM[layer.resolution];
  const cap = RESOLUTION_MAX_SAMPLES[layer.resolution];
  const cols = Math.min(cap, Math.max(2, Math.round(layer.widthMm / pitch) + 1));
  const rows = Math.min(cap, Math.max(2, Math.round(layer.heightMm / pitch) + 1));
  return { cols, rows };
}

/** Approximate triangle count the relief will generate. */
export function estimateTriangleCount(
  layer: Pick<ImageReliefLayer, "widthMm" | "heightMm" | "resolution">
): number {
  const { cols, rows } = estimateGridSize(layer);
  return (cols - 1) * (rows - 1) * 4 + (2 * (cols - 1) + 2 * (rows - 1)) * 2;
}

/**
 * Sample the processed image into a height field according to the layer's
 * relief settings.
 */
export function buildHeightField(
  processed: RawImage,
  layer: Pick<
    ImageReliefLayer,
    | "widthMm"
    | "heightMm"
    | "resolution"
    | "mapping"
    | "minHeightMm"
    | "maxHeightMm"
    | "mode"
    | "alphaThreshold"
  >
): HeightField {
  const { cols, rows } = estimateGridSize(layer);
  const sampled = resample(processed, cols, rows);

  const heights = new Float32Array(cols * rows);
  const coverage = new Uint8Array(cols * rows);
  const minH = Math.max(0.05, Math.min(layer.minHeightMm, layer.maxHeightMm));
  const maxH = Math.max(minH, Math.max(layer.minHeightMm, layer.maxHeightMm));
  let covered = 0;

  for (let i = 0; i < cols * rows; i++) {
    const alpha = sampled.data[i * 4 + 3];
    if (alpha < layer.alphaThreshold) {
      coverage[i] = 0;
      heights[i] = minH;
      continue;
    }
    coverage[i] = 1;
    covered++;
    if (layer.mode === "silhouette") {
      heights[i] = maxH;
      continue;
    }
    const lum = luminanceAt(sampled, i) / 255;
    const v = layer.mapping === "darkHigh" ? 1 - lum : lum;
    heights[i] = minH + (maxH - minH) * v;
  }

  return {
    cols,
    rows,
    heights,
    coverage,
    hasMask: covered < cols * rows,
    coverageFraction: covered / (cols * rows),
  };
}
