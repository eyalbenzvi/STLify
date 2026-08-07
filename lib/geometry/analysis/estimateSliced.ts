/**
 * Slice-based print time/cost estimation (V6 item 11).
 *
 * The V2-era model assumed time ∝ volume (0.35+0.65·infill at a fixed
 * 8 mm³/s), which is wrong in exactly the cases that matter: FDM time is
 * dominated by perimeters and travel, so a thin wide plate came out wrong
 * by tens of percent, and SLA's fixed seconds-per-layer ignored that lift
 * time depends on the cross-section being peeled.
 *
 * This model MEASURES the geometry through the kernel's slicer: perimeter
 * length, cross-section area and island count per layer (sampled bands for
 * tall models), then prices each printing component separately. It remains
 * a TRANSPARENT HEURISTIC — the speeds are documented workshop constants,
 * every component is reported to the UI in Hebrew, and the "rough estimate,
 * verify in your slicer" labelling stays everywhere it appears.
 */

import type { Solid } from "../kernel";
import {
  type DetailedEstimateInputs,
  type DetailedEstimateResult,
  type EstimateConfidence,
} from "./estimateDetailed";

/** Per-layer geometry integrated over the whole height. */
export interface SliceMetrics {
  layerCount: number;
  /** Σ over layers of the layer's outline length, mm. */
  totalPerimeterMm: number;
  /** Σ over layers of the layer's solid cross-section area, mm². */
  totalAreaMm2: number;
  /** Largest single-layer cross-section, mm². */
  maxAreaMm2: number;
  /** Σ over layers of the island (separate outline) count. */
  totalIslands: number;
  /** How many layers were actually sliced (≤ layerCount; bands scale up). */
  sampledLayers: number;
}

/** Documented workshop constants (same speed class as estimateDetailed). */
export const SLICED_ESTIMATE_CONSTANTS = {
  /** Perimeters print slower than infill for quality. */
  perimeterSpeedMmS: 45,
  infillSpeedMmS: 60,
  wallCount: 3,
  topBottomLayers: 4,
  /** Travel + layer change overhead: base seconds per layer + per island. */
  layerOverheadS: 2,
  islandOverheadS: 0.4,
  /** SLA: fixed exposure per layer. */
  slaExposureS: 2.8,
  /** SLA: lift/peel seconds = base + scale × (area / reference area). */
  slaLiftBaseS: 4,
  slaLiftAreaScaleS: 4,
  slaLiftReferenceAreaMm2: 10_000,
} as const;

/**
 * Measure slice metrics for one solid. Does NOT consume the solid.
 *
 * Tall models are sampled at up to `maxSamples` band centres and each band
 * scales to the layers it represents — an approximation that is exact for
 * prismatic bodies and documented for everything else.
 */
export function measureSliceMetrics(
  solid: Solid,
  layerHeightMm: number,
  maxSamples = 48
): SliceMetrics {
  const bounds = solid.boundingBox();
  const height = Math.max(0, bounds.max.z - bounds.min.z);
  const layerHeight = Math.max(0.01, layerHeightMm);
  const layerCount = Math.max(1, Math.ceil(height / layerHeight));
  const samples = Math.min(maxSamples, layerCount);
  const layersPerSample = layerCount / samples;

  let totalPerimeterMm = 0;
  let totalAreaMm2 = 0;
  let maxAreaMm2 = 0;
  let totalIslands = 0;

  for (let i = 0; i < samples; i++) {
    const z = bounds.min.z + ((i + 0.5) / samples) * height;
    const polygons = solid.slicePolygons(z);
    let perimeter = 0;
    let signedArea = 0;
    let islands = 0;
    for (const poly of polygons) {
      let polySigned = 0;
      for (let k = 0; k < poly.length; k++) {
        const [x1, y1] = poly[k];
        const [x2, y2] = poly[(k + 1) % poly.length];
        perimeter += Math.hypot(x2 - x1, y2 - y1);
        polySigned += x1 * y2 - x2 * y1;
      }
      polySigned /= 2;
      signedArea += polySigned;
      // Holes are wound opposite to outlines; only outlines are islands.
      if (polySigned > 0) islands++;
    }
    const area = Math.abs(signedArea);
    totalPerimeterMm += perimeter * layersPerSample;
    totalAreaMm2 += area * layersPerSample;
    totalIslands += Math.max(1, islands) * layersPerSample;
    maxAreaMm2 = Math.max(maxAreaMm2, area);
  }

  return {
    layerCount,
    totalPerimeterMm,
    totalAreaMm2,
    maxAreaMm2,
    totalIslands,
    sampledLayers: samples,
  };
}

/** Merge metrics of parts printed together on one plate. */
export function mergeSliceMetrics(all: SliceMetrics[]): SliceMetrics | null {
  if (all.length === 0) return null;
  return {
    layerCount: Math.max(...all.map((m) => m.layerCount)),
    totalPerimeterMm: all.reduce((s, m) => s + m.totalPerimeterMm, 0),
    totalAreaMm2: all.reduce((s, m) => s + m.totalAreaMm2, 0),
    maxAreaMm2: Math.max(...all.map((m) => m.maxAreaMm2)),
    totalIslands: all.reduce((s, m) => s + m.totalIslands, 0),
    sampledLayers: Math.min(...all.map((m) => m.sampledLayers)),
  };
}

/** One named component of the estimate, for the UI breakdown. */
export interface EstimateComponent {
  labelHe: string;
  minutes: number;
}

export interface SlicedEstimateResult extends DetailedEstimateResult {
  /** What the print time is made of — shown to the user, never hidden. */
  componentsHe: EstimateComponent[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Estimate from measured slice metrics. Material/cost bookkeeping matches
 * estimateDetailed; the TIME model is what changed.
 */
export function estimateFromSlices(
  inputs: DetailedEstimateInputs,
  metrics: SliceMetrics
): SlicedEstimateResult {
  const C = SLICED_ESTIMATE_CONSTANTS;
  const layerHeight = Math.max(0.01, inputs.layerHeightMm);
  const componentsHe: EstimateComponent[] = [];
  let printMinutes: number;
  let materialVolumeMm3: number;
  let confidence: EstimateConfidence;

  if (inputs.technology === "sla") {
    // Whole layers flash at once; the lift/peel grows with the area being
    // separated from the film. Integrated over measured layer areas.
    const exposureS = metrics.layerCount * C.slaExposureS;
    const meanAreaMm2 = metrics.totalAreaMm2 / metrics.layerCount;
    const liftS =
      metrics.layerCount *
      (C.slaLiftBaseS +
        C.slaLiftAreaScaleS * Math.min(1, meanAreaMm2 / C.slaLiftReferenceAreaMm2));
    printMinutes = (exposureS + liftS) / 60 + 10; // +10: warmup/settle
    componentsHe.push({ labelHe: "חשיפת שכבות", minutes: round2(exposureS / 60) });
    componentsHe.push({ labelHe: "הרמות ופילינג (לפי שטח חתך)", minutes: round2(liftS / 60) });
    materialVolumeMm3 = inputs.modelVolumeMm3;
    confidence = "medium";
  } else {
    const lineWidth = Math.max(inputs.nozzleDiameterMm, 0.2) * 1.15;
    const wallRibbonMm2 = C.wallCount * lineWidth; // wall cross-section per mm of outline

    // Perimeters: measured outline length × wall count at perimeter speed.
    const perimeterPathMm = metrics.totalPerimeterMm * C.wallCount;
    const perimeterS = perimeterPathMm / C.perimeterSpeedMmS;

    // Volumes from the measured areas: walls, solid skins, sparse interior.
    // Skin area excludes the wall band (walls print in skin layers too — the
    // skin fills only what is INSIDE them), so nothing is counted twice.
    const wallVolumeMm3 = metrics.totalPerimeterMm * wallRibbonMm2 * layerHeight;
    const meanAreaMm2 = metrics.totalAreaMm2 / metrics.layerCount;
    const meanPerimeterMm = metrics.totalPerimeterMm / metrics.layerCount;
    const skinLayers = Math.min(metrics.layerCount, C.topBottomLayers * 2);
    const skinAreaMm2 = Math.max(0, meanAreaMm2 - meanPerimeterMm * wallRibbonMm2);
    const skinVolumeMm3 = skinAreaMm2 * skinLayers * layerHeight;
    const infillFraction = Math.min(Math.max(inputs.infillPercent, 0), 100) / 100;
    const interiorVolumeMm3 = Math.max(
      0,
      metrics.totalAreaMm2 * layerHeight - wallVolumeMm3 - skinVolumeMm3
    );
    const infillVolumeMm3 = interiorVolumeMm3 * infillFraction;

    const flowMm3PerS = C.infillSpeedMmS * lineWidth * layerHeight;
    const fillS = (skinVolumeMm3 + infillVolumeMm3) / flowMm3PerS;

    // Travel and layer changes: per layer, plus per island (each separate
    // outline is a hop the head must make).
    const travelS =
      metrics.layerCount * C.layerOverheadS +
      metrics.totalIslands * C.islandOverheadS;

    printMinutes = (perimeterS + fillS + travelS) / 60;
    componentsHe.push({ labelHe: "קווי מתאר (היקפים)", minutes: round2(perimeterS / 60) });
    componentsHe.push({ labelHe: "מילוי ומשטחים", minutes: round2(fillS / 60) });
    componentsHe.push({ labelHe: "מעברים והחלפות שכבה", minutes: round2(travelS / 60) });
    materialVolumeMm3 = wallVolumeMm3 + skinVolumeMm3 + infillVolumeMm3;
    // Every layer measured → high confidence in the geometry (speeds are
    // still workshop constants); sampled bands → medium.
    confidence = metrics.sampledLayers >= metrics.layerCount ? "high" : "medium";
  }

  const spread = confidence === "high" ? 0.15 : confidence === "medium" ? 0.25 : 0.4;
  const printMinutesMin = Math.max(1, Math.round(printMinutes * (1 - spread)));
  const printMinutesMax = Math.max(printMinutesMin + 1, Math.round(printMinutes * (1 + spread)));
  const setupMinutes = 10;

  const wasteFactor = 0.05;
  const materialVolumeCm3 = (materialVolumeMm3 / 1000) * (1 + wasteFactor);
  const weightGrams = materialVolumeCm3 * inputs.densityGCm3;
  const materialCost = (weightGrams / 1000) * inputs.pricePerKgIls;
  const avgPrintHours = (printMinutesMin + printMinutesMax) / 2 / 60;
  const electricityCost = (120 / 1000) * avgPrintHours * 0.62;
  const machineCost = avgPrintHours * 2;

  return {
    modelVolumeCm3: round2(inputs.modelVolumeMm3 / 1000),
    materialVolumeCm3: round2(materialVolumeCm3),
    materialWeightGrams: round2(weightGrams),
    materialCostIls: round2(materialCost),
    electricityCostIls: round2(electricityCost),
    machineCostIls: round2(machineCost),
    totalCostIls: round2(materialCost + electricityCost + machineCost),
    time: {
      layerCount: metrics.layerCount,
      printMinutesMin,
      printMinutesMax,
      totalMinutesMin: printMinutesMin + setupMinutes,
      totalMinutesMax: printMinutesMax + setupMinutes,
      confidence,
    },
    componentsHe,
  };
}
