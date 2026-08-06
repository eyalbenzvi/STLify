/**
 * Print-time estimation. Transparent heuristics that return a RANGE, never
 * a falsely-exact number; the UI repeats that slicer verification is
 * required. Confidence reflects how far the model is from the heuristic's
 * sweet spot (flat plates).
 */

import type { EstimateConfidence, EstimateSettings, TimeEstimateResult } from "@/types/design";

export interface TimeInputs {
  /** Solid model volume, mm³. */
  modelVolumeMm3: number;
  /** Estimated deposited material volume, mm³ (waste/support included). */
  materialVolumeMm3: number;
  boundsMm: { x: number; y: number; z: number };
  settings: EstimateSettings;
}

export function estimatePrintTime(inputs: TimeInputs): TimeEstimateResult {
  const { settings, boundsMm } = inputs;
  const { printer } = settings;
  const layerHeight = Math.max(printer.layerHeightMm, 0.01);
  const layerCount = Math.max(1, Math.ceil(boundsMm.z / layerHeight));

  let printMinutes: number;
  let confidence: EstimateConfidence;

  if (printer.technology === "Resin") {
    // MSLA prints whole layers at once: time ≈ layers × (exposure + lift).
    const secondsPerLayer = 9; // typical 2–3s exposure + lift/retract
    printMinutes = (layerCount * secondsPerLayer) / 60 + 10; // + tank warmup
    confidence = "medium";
  } else {
    // FDM: time ≈ extruded volume / volumetric flow, plus per-layer overhead
    // (travel, retraction, z-hops).
    const lineWidth = Math.max(printer.nozzleDiameterMm, 0.2) * 1.15;
    const flowMm3PerS = Math.max(printer.printSpeedMmS, 5) * lineWidth * layerHeight;
    const extrusionMinutes = inputs.materialVolumeMm3 / flowMm3PerS / 60;
    const perLayerOverheadMin = 4 / 60; // ~4s per layer
    printMinutes = extrusionMinutes + layerCount * perLayerOverheadMin;

    // Confidence: flat plate-like parts estimate well; tall/complex less so.
    const aspect = boundsMm.z / Math.max(1, Math.min(boundsMm.x, boundsMm.y));
    confidence = aspect < 0.5 ? "high" : aspect < 2 ? "medium" : "low";
  }

  const spread = confidence === "high" ? 0.15 : confidence === "medium" ? 0.25 : 0.4;
  const printMinutesMin = Math.max(1, Math.round(printMinutes * (1 - spread)));
  const printMinutesMax = Math.max(printMinutesMin + 1, Math.round(printMinutes * (1 + spread)));

  const setupMinutes = Math.max(0, settings.setupMinutes);
  const postProcessingMinutes = Math.max(0, settings.postProcessingMinutes);

  return {
    layerCount,
    printMinutesMin,
    printMinutesMax,
    setupMinutes,
    postProcessingMinutes,
    totalMinutesMin: printMinutesMin + setupMinutes + postProcessingMinutes,
    totalMinutesMax: printMinutesMax + setupMinutes + postProcessingMinutes,
    confidence,
  };
}

/** Format minutes as a Hebrew duration, e.g. "שעתיים ו-10 דקות". */
export function formatMinutesHe(totalMinutes: number): string {
  const minutes = Math.round(totalMinutes);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} דקות`;
  const hoursHe = hours === 1 ? "שעה" : hours === 2 ? "שעתיים" : `${hours} שעות`;
  if (rest === 0) return hoursHe;
  return `${hoursHe} ו-${rest} דקות`;
}
