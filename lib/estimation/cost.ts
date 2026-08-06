/**
 * Material / cost estimation. Pure, transparent heuristics — the UI states
 * explicitly that slicer verification is required before final pricing.
 */

import type { EstimateResult, EstimateSettings } from "@/types/design";
import { estimatePrintTime } from "./time";

export interface CostInputs {
  /** Solid model volume, mm³ (sum of all parts). */
  modelVolumeMm3: number;
  /** Overall bounding box, mm. */
  boundsMm: { x: number; y: number; z: number };
  settings: EstimateSettings;
}

/**
 * Estimate the material volume an FDM print actually consumes: perimeter
 * walls and top/bottom skins print solid, the interior prints at the infill
 * percentage. This is a first-order approximation of slicer behaviour.
 */
export function fdmMaterialVolumeMm3(
  modelVolumeMm3: number,
  boundsMm: { x: number; y: number; z: number },
  settings: EstimateSettings
): number {
  const { printer } = settings;
  const wallThickness = Math.max(printer.wallCount, 1) * Math.max(printer.nozzleDiameterMm, 0.2);
  const skinThickness = Math.max(printer.topBottomLayers, 1) * Math.max(printer.layerHeightMm, 0.05);

  // Approximate the shell fraction from the bounding dimensions: thin flat
  // parts (our plates) are mostly skin, tall parts are mostly wall.
  const minDim = Math.max(1, Math.min(boundsMm.x, boundsMm.y, boundsMm.z));
  const shellFraction = Math.min(
    1,
    (2 * skinThickness + 2 * wallThickness) / minDim
  );
  const infillFraction = Math.min(Math.max(printer.infillPercent, 0), 100) / 100;
  const effectiveFraction = shellFraction + (1 - shellFraction) * infillFraction;
  return modelVolumeMm3 * effectiveFraction;
}

/** Full cost estimate. */
export function estimateCost(inputs: CostInputs): EstimateResult {
  const { settings } = inputs;
  const { printer, material } = settings;
  const modelVolumeCm3 = inputs.modelVolumeMm3 / 1000;

  const isResin = printer.technology === "Resin";
  const consumedMm3 = isResin
    ? inputs.modelVolumeMm3
    : fdmMaterialVolumeMm3(inputs.modelVolumeMm3, inputs.boundsMm, settings);

  const supportFactor =
    (printer.supportsEnabled ? material.supportMaterialPercent : 0) / 100;
  const wasteFactor = Math.max(material.wastePercent, 0) / 100;
  const materialVolumeCm3 = (consumedMm3 / 1000) * (1 + supportFactor + wasteFactor);

  const weightGrams = materialVolumeCm3 * material.densityGCm3;

  let materialCost: number;
  if (isResin) {
    // Resin is priced per litre.
    materialCost = (materialVolumeCm3 / 1000) * material.costPerLitre;
  } else {
    materialCost = (weightGrams / 1000) * material.costPerKg;
  }

  const time = estimatePrintTime({
    modelVolumeMm3: inputs.modelVolumeMm3,
    materialVolumeMm3: materialVolumeCm3 * 1000,
    boundsMm: inputs.boundsMm,
    settings,
  });
  const avgPrintHours = (time.printMinutesMin + time.printMinutesMax) / 2 / 60;

  const electricityCost =
    (printer.powerWatts / 1000) * avgPrintHours * printer.electricityPricePerKwh;
  const machineCost = avgPrintHours * settings.machineOverheadPerHour;

  const totalCost =
    materialCost +
    electricityCost +
    machineCost +
    settings.laborCost +
    settings.packagingCost;

  const markup = Math.max(settings.markupPercent, 0) / 100;
  const margin = Math.min(Math.max(settings.targetMarginPercent, 0), 95) / 100;

  return {
    modelVolumeCm3: round2(modelVolumeCm3),
    materialVolumeCm3: round2(materialVolumeCm3),
    materialWeightGrams: round2(weightGrams),
    materialCost: round2(materialCost),
    electricityCost: round2(electricityCost),
    machineCost: round2(machineCost),
    laborCost: round2(settings.laborCost),
    packagingCost: round2(settings.packagingCost),
    totalCost: round2(totalCost),
    suggestedPriceMarkup: round2(totalCost * (1 + markup)),
    suggestedPriceMargin: round2(margin < 1 ? totalCost / (1 - margin) : totalCost),
    currency: material.currency,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
