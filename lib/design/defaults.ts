/**
 * Factories and default values for V2 design documents, layers, colour
 * slots, printer/material profiles and printability profiles.
 */

import {
  DEFAULT_ADJUSTMENTS,
  IDENTITY_TRANSFORM,
  type BaseLayer,
  type ColorMaterial,
  type DesignDocument,
  type DesignSettings,
  type DesignState,
  type EstimateSettings,
  type HoleLayer,
  type ImageReliefLayer,
  type LayerTransform,
  type MaterialProfile,
  type PrintabilityLimitsV2,
  type PrintabilityProfile,
  type PrintabilityProfileId,
  type PrinterProfile,
  type SvgLayer,
  type TextLayer,
} from "@/types/design";

export const APP_VERSION = "2.0.0";
export const APP_NAME = "PrintCraft Product Studio";

/** History depth for in-memory undo/redo. */
export const HISTORY_LIMIT = 50;

let idCounter = 0;

/** Generate a stable, unique layer/asset id (session-scoped). */
export function newId(prefix: string): string {
  idCounter += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.floor(Math.random() * 0xffffffff).toString(16);
  return `${prefix}_${rand}_${idCounter.toString(36)}`;
}

export function cloneTransform(t: LayerTransform = IDENTITY_TRANSFORM): LayerTransform {
  return { ...t };
}

// ---------------------------------------------------------------------------
// Layer factories
// ---------------------------------------------------------------------------

export function createBaseLayer(patch: Partial<BaseLayer> = {}): BaseLayer {
  return {
    id: newId("base"),
    type: "base",
    name: "בסיס",
    visible: true,
    locked: false,
    colorHex: "#2f6feb",
    colorSlot: 0,
    transform: cloneTransform(),
    shape: "roundedRectangle",
    widthMm: 120,
    heightMm: 40,
    thicknessMm: 3,
    cornerRadiusMm: 5,
    rim: { enabled: false, widthMm: 3, heightMm: 1.5 },
    ...patch,
  };
}

export function createTextLayer(patch: Partial<TextLayer> = {}): TextLayer {
  return {
    id: newId("text"),
    type: "text",
    name: "טקסט",
    visible: true,
    locked: false,
    colorHex: "#f5f5f5",
    colorSlot: 1,
    transform: cloneTransform(),
    content: "טקסט חדש",
    fontId: "alef",
    sizeMm: 16,
    bold: true,
    align: "center",
    direction: "auto",
    letterSpacingMm: 0,
    lineSpacing: 1,
    mode: "raised",
    depthMm: 1.5,
    curveRadiusMm: 0,
    mirrored: false,
    ...patch,
  };
}

export function createSvgLayer(patch: Partial<SvgLayer> = {}): SvgLayer {
  return {
    id: newId("svg"),
    type: "svg",
    name: "לוגו SVG",
    visible: true,
    locked: false,
    colorHex: "#f5b53f",
    colorSlot: 2,
    transform: cloneTransform(),
    svgText: "",
    sourceName: "logo.svg",
    targetWidthMm: 30,
    targetHeightMm: 30,
    preserveAspect: true,
    aspectRatio: 1,
    flipH: false,
    flipV: false,
    mode: "raised",
    depthMm: 1.5,
    quality: "standard",
    importWarnings: [],
    ...patch,
  };
}

export function createImageReliefLayer(
  patch: Partial<ImageReliefLayer> = {}
): ImageReliefLayer {
  return {
    id: newId("img"),
    type: "imageRelief",
    name: "תמונה",
    visible: true,
    locked: false,
    colorHex: "#8a8f98",
    colorSlot: 1,
    transform: cloneTransform(),
    assetId: "",
    sourceName: "image.png",
    adjustments: { ...DEFAULT_ADJUSTMENTS },
    mode: "raised",
    minHeightMm: 0.2,
    maxHeightMm: 2,
    mapping: "darkHigh",
    resolution: "standard",
    widthMm: 50,
    heightMm: 50,
    preserveAspect: true,
    aspectRatio: 1,
    alphaThreshold: 96,
    ...patch,
  };
}

export function createHoleLayer(patch: Partial<HoleLayer> = {}): HoleLayer {
  return {
    id: newId("hole"),
    type: "hole",
    name: "חור",
    visible: true,
    locked: false,
    colorHex: "#555b66",
    colorSlot: 0,
    transform: cloneTransform(),
    shape: "circle",
    diameterMm: 4.5,
    widthMm: 8,
    heightMm: 4,
    cornerRadiusMm: 1,
    through: true,
    depthMm: 2,
    fromBottom: false,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// Colour slots & palette
// ---------------------------------------------------------------------------

export function defaultColorSlots(): ColorMaterial[] {
  return [
    { name: "צבע 1 (בסיס)", colorHex: "#2f6feb", materialType: "PLA", filamentName: "" },
    { name: "צבע 2", colorHex: "#f5f5f5", materialType: "PLA", filamentName: "" },
    { name: "צבע 3", colorHex: "#f5b53f", materialType: "PLA", filamentName: "" },
    { name: "צבע 4", colorHex: "#e0483e", materialType: "PLA", filamentName: "" },
  ];
}

/** A filament-inspired preset palette for the colour picker. */
export const FILAMENT_PALETTE: { name: string; hex: string }[] = [
  { name: "לבן", hex: "#f5f5f5" },
  { name: "שחור", hex: "#1c1c1e" },
  { name: "אפור", hex: "#8a8f98" },
  { name: "כסף", hex: "#c0c6cf" },
  { name: "אדום", hex: "#e0483e" },
  { name: "כתום", hex: "#f07d1a" },
  { name: "צהוב", hex: "#f5c518" },
  { name: "זהב", hex: "#c99b3f" },
  { name: "ירוק", hex: "#4b9b6e" },
  { name: "ירוק בהיר", hex: "#8bc34a" },
  { name: "טורקיז", hex: "#26a69a" },
  { name: "כחול", hex: "#2f6feb" },
  { name: "כחול כהה", hex: "#1a3b8f" },
  { name: "סגול", hex: "#7e57c2" },
  { name: "ורוד", hex: "#ec6a9c" },
  { name: "חום", hex: "#795548" },
];

// ---------------------------------------------------------------------------
// Printer / material profiles
// ---------------------------------------------------------------------------

export const PRINTER_PRESETS: PrinterProfile[] = [
  {
    name: "מדפסת FDM כללית",
    technology: "FDM",
    buildVolumeMm: { x: 220, y: 220, z: 250 },
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    printSpeedMmS: 60,
    infillPercent: 15,
    wallCount: 2,
    topBottomLayers: 4,
    supportsEnabled: false,
    powerWatts: 120,
    electricityPricePerKwh: 0.64,
  },
  {
    name: "מדפסת שרף (Resin) כללית",
    technology: "Resin",
    buildVolumeMm: { x: 143, y: 90, z: 175 },
    nozzleDiameterMm: 0,
    layerHeightMm: 0.05,
    printSpeedMmS: 0,
    infillPercent: 100,
    wallCount: 0,
    topBottomLayers: 0,
    supportsEnabled: true,
    powerWatts: 80,
    electricityPricePerKwh: 0.64,
  },
];

export const MATERIAL_PRESETS: MaterialProfile[] = [
  { name: "PLA", densityGCm3: 1.24, costPerKg: 90, costPerLitre: 0, currency: "ILS", wastePercent: 5, supportMaterialPercent: 0, colorHex: "#2f6feb" },
  { name: "PETG", densityGCm3: 1.27, costPerKg: 100, costPerLitre: 0, currency: "ILS", wastePercent: 6, supportMaterialPercent: 0, colorHex: "#4b9b6e" },
  { name: "TPU", densityGCm3: 1.21, costPerKg: 140, costPerLitre: 0, currency: "ILS", wastePercent: 8, supportMaterialPercent: 0, colorHex: "#ec6a9c" },
  { name: "ABS", densityGCm3: 1.04, costPerKg: 95, costPerLitre: 0, currency: "ILS", wastePercent: 7, supportMaterialPercent: 0, colorHex: "#f07d1a" },
  { name: "Resin", densityGCm3: 1.1, costPerKg: 0, costPerLitre: 160, currency: "ILS", wastePercent: 10, supportMaterialPercent: 15, colorHex: "#8a8f98" },
];

export function defaultEstimateSettings(): EstimateSettings {
  return {
    printer: structuredClone(PRINTER_PRESETS[0]),
    material: structuredClone(MATERIAL_PRESETS[0]),
    machineOverheadPerHour: 2,
    laborCost: 10,
    packagingCost: 2,
    setupMinutes: 10,
    postProcessingMinutes: 10,
    markupPercent: 100,
    targetMarginPercent: 50,
  };
}

// ---------------------------------------------------------------------------
// Printability profiles
// ---------------------------------------------------------------------------

const FDM_PLA_LIMITS: PrintabilityLimitsV2 = {
  minWallMm: 0.8,
  minEmbossHeightMm: 0.4,
  minEngraveDepthMm: 0.4,
  minEngraveFloorMm: 0.6,
  minHoleDiameterMm: 2,
  minHoleEdgeDistanceMm: 1.6,
  recommendedClearanceMm: 0.2,
  safetyMarginMm: 0.2,
  minTextSizeMm: 4,
  minFeatureMm: 0.8,
  maxTriangleCount: 1_000_000,
};

export const PRINTABILITY_PROFILES: PrintabilityProfile[] = [
  {
    id: "fdm-pla",
    nameHe: "FDM כללי / PLA",
    nameEn: "Generic FDM / PLA",
    limits: { ...FDM_PLA_LIMITS },
  },
  {
    id: "fdm-petg",
    nameHe: "FDM כללי / PETG",
    nameEn: "Generic FDM / PETG",
    limits: {
      ...FDM_PLA_LIMITS,
      minWallMm: 1,
      minEngraveFloorMm: 0.8,
      recommendedClearanceMm: 0.25,
    },
  },
  {
    id: "resin-sla",
    nameHe: "שרף כללי / SLA",
    nameEn: "Generic Resin / SLA",
    limits: {
      ...FDM_PLA_LIMITS,
      minWallMm: 0.5,
      minEmbossHeightMm: 0.2,
      minEngraveDepthMm: 0.2,
      minEngraveFloorMm: 0.4,
      minHoleDiameterMm: 1,
      minHoleEdgeDistanceMm: 1,
      recommendedClearanceMm: 0.1,
      minTextSizeMm: 2.5,
      minFeatureMm: 0.4,
    },
  },
];

export function getPrintabilityProfile(id: PrintabilityProfileId): PrintabilityProfile {
  const profile = PRINTABILITY_PROFILES.find((p) => p.id === id);
  return profile ?? PRINTABILITY_PROFILES[0];
}

/** Effective limits for a document: profile values + user overrides. */
export function effectiveLimits(settings: DesignSettings): PrintabilityLimitsV2 {
  const profile = getPrintabilityProfile(settings.printabilityProfileId);
  return { ...profile.limits, ...settings.printabilityOverrides };
}

// ---------------------------------------------------------------------------
// Document factory
// ---------------------------------------------------------------------------

export function defaultSettings(): DesignSettings {
  return {
    multiColor: {
      enabled: false,
      slots: defaultColorSlots(),
      inlayClearanceMm: 0.15,
    },
    estimate: defaultEstimateSettings(),
    printabilityProfileId: "fdm-pla",
    printabilityOverrides: {},
  };
}

export function createBlankDocument(): DesignDocument {
  return {
    version: 2,
    title: "",
    templateId: "blank",
    layers: [createBaseLayer()],
  };
}

export function createBlankState(): DesignState {
  return { doc: createBlankDocument(), settings: defaultSettings() };
}

/** Find the base layer of a document (always layers[0] by invariant). */
export function baseOf(doc: DesignDocument): BaseLayer {
  const base = doc.layers[0];
  if (base?.type !== "base") {
    throw new Error("Document invariant violated: layers[0] must be the base layer");
  }
  return base;
}
