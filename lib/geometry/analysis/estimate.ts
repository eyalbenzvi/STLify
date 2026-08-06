/**
 * Rough print time / weight / cost estimates. Transparent heuristic:
 * - effective solid fraction = 0.35 (shells+top/bottom) + 0.65·infill%,
 *   capped at 1 — approximates how much of the volume becomes plastic.
 * - weight = volume(cm³) · density · fraction
 * - time = layer count · 6s handling + extruded volume / flow rate
 *   (FDM flow ≈ 8 mm³/s, resin exposure dominated by layer count)
 * These are ballpark numbers for comparing designs, not slicer output —
 * the UI labels them "הערכה גסה".
 */

import type { MaterialProfile } from "@/types/profiles";

export interface PrintEstimate {
  volumeMm3: number;
  weightGrams: number;
  timeMinutes: number;
  costIls: number;
}

export function estimatePrint(
  volumeMm3: number,
  heightMm: number,
  material: MaterialProfile,
  layerHeightMm: number,
  infillPct: number
): PrintEstimate {
  const fraction = Math.min(1, 0.35 + 0.65 * (Math.max(0, Math.min(infillPct, 100)) / 100));
  const effectiveVolume = volumeMm3 * fraction;
  const weightGrams = (effectiveVolume / 1000) * material.densityGCm3;

  const layers = Math.max(1, Math.ceil(heightMm / Math.max(layerHeightMm, 0.01)));
  let timeSeconds: number;
  if (material.technology === "sla") {
    // Resin: per-layer exposure+lift dominates (~8s per layer).
    timeSeconds = layers * 8;
  } else {
    timeSeconds = layers * 6 + effectiveVolume / 8;
  }

  const costIls = (weightGrams / 1000) * material.pricePerKgIls;
  return {
    volumeMm3,
    weightGrams: Math.round(weightGrams * 10) / 10,
    timeMinutes: Math.max(1, Math.round(timeSeconds / 60)),
    costIls: Math.round(costIls * 10) / 10,
  };
}
