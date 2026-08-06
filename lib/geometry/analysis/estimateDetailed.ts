/**
 * Detailed cost / print-time estimation, ported from the V2 branch
 * (lib/estimation/{cost,time}.ts) and adapted to the V3 profile model.
 *
 * Transparent heuristics that return a time RANGE with a confidence level,
 * never a falsely-exact number — the UI repeats that slicer verification
 * is required. FDM material consumption is infill/shell-aware; resin is
 * priced per litre and timed per layer.
 */

export type EstimateConfidence = "low" | "medium" | "high";

export interface DetailedEstimateInputs {
  /** Solid model volume, mm³ (sum of all parts). */
  modelVolumeMm3: number;
  /** Overall bounding size, mm. */
  boundsMm: { x: number; y: number; z: number };
  technology: "fdm" | "sla";
  layerHeightMm: number;
  nozzleDiameterMm: number;
  infillPercent: number;
  /** Material density, g/cm³. */
  densityGCm3: number;
  /** FDM: price per kg; resin: price per kg is converted via density. */
  pricePerKgIls: number;
}

/** Fixed workshop constants (documented heuristics, ILS). */
const DEFAULTS = {
  wallCount: 3,
  topBottomLayers: 4,
  printSpeedMmS: 60,
  supportPercent: 0,
  wastePercent: 5,
  powerWatts: 120,
  electricityPricePerKwhIls: 0.62,
  machineOverheadPerHourIls: 2,
  setupMinutes: 5,
  postProcessingMinutes: 5,
} as const;

export interface TimeEstimateResult {
  layerCount: number;
  printMinutesMin: number;
  printMinutesMax: number;
  totalMinutesMin: number;
  totalMinutesMax: number;
  confidence: EstimateConfidence;
}

export interface DetailedEstimateResult {
  modelVolumeCm3: number;
  /** Material actually consumed (infill/walls/waste adjusted), cm³. */
  materialVolumeCm3: number;
  materialWeightGrams: number;
  materialCostIls: number;
  electricityCostIls: number;
  machineCostIls: number;
  totalCostIls: number;
  time: TimeEstimateResult;
}

/**
 * Estimate the material volume an FDM print actually consumes: perimeter
 * walls and top/bottom skins print solid, the interior prints at the infill
 * percentage. First-order approximation of slicer behaviour.
 */
export function fdmMaterialVolumeMm3(inputs: DetailedEstimateInputs): number {
  const wallThickness = DEFAULTS.wallCount * Math.max(inputs.nozzleDiameterMm, 0.2);
  const skinThickness = DEFAULTS.topBottomLayers * Math.max(inputs.layerHeightMm, 0.05);
  const minDim = Math.max(
    1,
    Math.min(inputs.boundsMm.x, inputs.boundsMm.y, inputs.boundsMm.z)
  );
  const shellFraction = Math.min(1, (2 * skinThickness + 2 * wallThickness) / minDim);
  const infillFraction = Math.min(Math.max(inputs.infillPercent, 0), 100) / 100;
  const effectiveFraction = shellFraction + (1 - shellFraction) * infillFraction;
  return inputs.modelVolumeMm3 * effectiveFraction;
}

export function estimatePrintTimeDetailed(
  inputs: DetailedEstimateInputs,
  materialVolumeMm3: number
): TimeEstimateResult {
  const layerHeight = Math.max(inputs.layerHeightMm, 0.01);
  const layerCount = Math.max(1, Math.ceil(inputs.boundsMm.z / layerHeight));

  let printMinutes: number;
  let confidence: EstimateConfidence;
  if (inputs.technology === "sla") {
    // MSLA prints whole layers at once: time ≈ layers × (exposure + lift).
    printMinutes = (layerCount * 9) / 60 + 10;
    confidence = "medium";
  } else {
    const lineWidth = Math.max(inputs.nozzleDiameterMm, 0.2) * 1.15;
    const flowMm3PerS = DEFAULTS.printSpeedMmS * lineWidth * layerHeight;
    const extrusionMinutes = materialVolumeMm3 / flowMm3PerS / 60;
    printMinutes = extrusionMinutes + layerCount * (4 / 60);
    const aspect =
      inputs.boundsMm.z / Math.max(1, Math.min(inputs.boundsMm.x, inputs.boundsMm.y));
    confidence = aspect < 0.5 ? "high" : aspect < 2 ? "medium" : "low";
  }

  const spread = confidence === "high" ? 0.15 : confidence === "medium" ? 0.25 : 0.4;
  const printMinutesMin = Math.max(1, Math.round(printMinutes * (1 - spread)));
  const printMinutesMax = Math.max(printMinutesMin + 1, Math.round(printMinutes * (1 + spread)));
  const overhead = DEFAULTS.setupMinutes + DEFAULTS.postProcessingMinutes;
  return {
    layerCount,
    printMinutesMin,
    printMinutesMax,
    totalMinutesMin: printMinutesMin + overhead,
    totalMinutesMax: printMinutesMax + overhead,
    confidence,
  };
}

/** Full cost estimate (material + electricity + machine wear). */
export function estimateDetailed(inputs: DetailedEstimateInputs): DetailedEstimateResult {
  const isResin = inputs.technology === "sla";
  const consumedMm3 = isResin ? inputs.modelVolumeMm3 : fdmMaterialVolumeMm3(inputs);
  const wasteFactor = DEFAULTS.wastePercent / 100;
  const materialVolumeCm3 = (consumedMm3 / 1000) * (1 + wasteFactor);
  const weightGrams = materialVolumeCm3 * inputs.densityGCm3;
  const materialCost = (weightGrams / 1000) * inputs.pricePerKgIls;

  const time = estimatePrintTimeDetailed(inputs, materialVolumeCm3 * 1000);
  const avgPrintHours = (time.printMinutesMin + time.printMinutesMax) / 2 / 60;
  const electricityCost =
    (DEFAULTS.powerWatts / 1000) * avgPrintHours * DEFAULTS.electricityPricePerKwhIls;
  const machineCost = avgPrintHours * DEFAULTS.machineOverheadPerHourIls;

  return {
    modelVolumeCm3: round2(inputs.modelVolumeMm3 / 1000),
    materialVolumeCm3: round2(materialVolumeCm3),
    materialWeightGrams: round2(weightGrams),
    materialCostIls: round2(materialCost),
    electricityCostIls: round2(electricityCost),
    machineCostIls: round2(machineCost),
    totalCostIls: round2(materialCost + electricityCost + machineCost),
    time,
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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
