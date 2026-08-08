/**
 * Post-processing for the salient-object segmentation model ("smart
 * silhouette"). Pure and node-testable.
 *
 * The model's saliency map becomes the luminance grid the EXISTING
 * silhouette tracer consumes: probability-of-subject p maps to lum = 1 − p,
 * traced at a fixed threshold of 0.5 with invert off. Soft probabilities
 * land the marching-squares boundary BETWEEN pixel centres, so AI edges get
 * the same sub-pixel smoothness the classic threshold path has.
 */

import type { LuminanceGrid } from "@/lib/import/image";
import { bilinearResample } from "./imageTensor";

/** The fixed threshold the AI-mask grid is traced at. */
export const AI_MASK_THRESHOLD = 0.5;

/**
 * Resample a saliency map (model resolution, aspect-squashed) onto the
 * decode grid (image aspect restored) and encode it as a luminance grid.
 */
export function saliencyToMaskGrid(
  map: Float32Array,
  mapWidth: number,
  mapHeight: number,
  gridWidth: number,
  gridHeight: number
): LuminanceGrid {
  const resampled = bilinearResample(map, mapWidth, mapHeight, gridWidth, gridHeight);
  const values = new Float32Array(gridWidth * gridHeight);
  for (let i = 0; i < resampled.length; i++) {
    const p = resampled[i] < 0 ? 0 : resampled[i] > 1 ? 1 : resampled[i];
    values[i] = 1 - p;
  }
  return { width: gridWidth, height: gridHeight, values };
}

/** Fraction of the map the model considers subject, at the trace threshold. */
export function maskCoverage(map: Float32Array): number {
  if (map.length === 0) return 0;
  let solid = 0;
  for (let i = 0; i < map.length; i++) {
    if (map[i] >= AI_MASK_THRESHOLD) solid++;
  }
  return solid / map.length;
}
