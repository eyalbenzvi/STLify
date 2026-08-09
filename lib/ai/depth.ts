/**
 * Post-processing for the monocular depth model ("smart relief").
 * Pure and node-testable.
 *
 * The depth map becomes a luminance grid for the EXISTING height-field
 * mesher (heightFieldToClosedMesh): depth 1 = near, and the mesher raises
 * dark pixels, so lum = 1 − depth makes near parts tall. The mesher's own
 * `invert` flag flips that for lithophane-style reliefs.
 */

import type { LuminanceGrid } from "@/lib/import/image";
import { bilinearResample } from "./imageTensor";
import { AI_MASK_THRESHOLD } from "./segmentation";

export interface DepthReliefOptions {
  gridWidth: number;
  gridHeight: number;
  /**
   * Optional saliency map (model resolution). Pixels the model calls
   * background are pushed to depth 0 — the relief floor — so the subject
   * stands alone instead of riding whatever was behind it.
   */
  mask?: { map: Float32Array; width: number; height: number } | null;
}

/**
 * Normalised depth map (0..1, near = 1) → luminance grid for the mesher.
 */
export function depthToReliefGrid(
  depth: Float32Array,
  depthWidth: number,
  depthHeight: number,
  options: DepthReliefOptions
): LuminanceGrid {
  const { gridWidth, gridHeight } = options;
  const resampled = bilinearResample(depth, depthWidth, depthHeight, gridWidth, gridHeight);
  const mask = options.mask
    ? bilinearResample(
        options.mask.map,
        options.mask.width,
        options.mask.height,
        gridWidth,
        gridHeight
      )
    : null;
  const values = new Float32Array(gridWidth * gridHeight);
  for (let i = 0; i < resampled.length; i++) {
    let d = resampled[i] < 0 ? 0 : resampled[i] > 1 ? 1 : resampled[i];
    if (mask && mask[i] < AI_MASK_THRESHOLD) d = 0;
    values[i] = 1 - d;
  }
  return { width: gridWidth, height: gridHeight, values };
}
