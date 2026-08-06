/**
 * V2 domain model for the Printable Product Studio.
 *
 * A design is a DesignDocument: an ordered list of editable layers on top of
 * a single base layer, plus document-wide settings (multi-color slots,
 * printer / material assumptions, printability profile).
 *
 * All linear dimensions are millimetres — the internal and displayed unit.
 * All state is session-only: nothing here is ever persisted automatically.
 */

// ---------------------------------------------------------------------------
// Layer transforms
// ---------------------------------------------------------------------------

/** Full 3D transform of a layer. Rotations are degrees; scales are factors. */
export interface LayerTransform {
  x: number;
  y: number;
  z: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
}

export const IDENTITY_TRANSFORM: LayerTransform = {
  x: 0,
  y: 0,
  z: 0,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
};

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export type LayerType = "base" | "text" | "svg" | "imageRelief" | "hole";

/** How a layer combines with the base solid. */
export type LayerOperation = "add" | "subtract";

/** Relief style for text / SVG layers. */
export type ReliefMode = "raised" | "engraved" | "inlay";

/** Relief style for image layers. */
export type ImageReliefMode = "raised" | "engraved" | "silhouette";

/** Fields shared by every editable layer. */
export interface LayerCommon {
  /** Stable unique id (session-scoped, serialized in design files). */
  id: string;
  type: LayerType;
  /** User-visible layer name. */
  name: string;
  visible: boolean;
  locked: boolean;
  /** Preview colour (hex). Not stored in STL output. */
  colorHex: string;
  /** Printable colour/material slot index (0..3) for multi-colour mode. */
  colorSlot: number;
  transform: LayerTransform;
}

export type BaseShape = "rectangle" | "roundedRectangle" | "circle";

/**
 * The base plate every design is built on. Exactly one per document, always
 * layers[0]. The rim is an optional raised frame inset from the outline
 * (used by coasters, plaques and sign borders).
 */
export interface BaseLayer extends LayerCommon {
  type: "base";
  shape: BaseShape;
  /** Plate size along X; for circles this is the diameter. */
  widthMm: number;
  /** Plate size along Y; ignored for circles. */
  heightMm: number;
  thicknessMm: number;
  /** Corner radius; used only for roundedRectangle. */
  cornerRadiusMm: number;
  rim: {
    enabled: boolean;
    widthMm: number;
    heightMm: number;
  };
}

export type TextAlign = "right" | "center" | "left";
export type TextDirection = "auto" | "rtl" | "ltr";

export interface TextLayer extends LayerCommon {
  type: "text";
  content: string;
  fontId: string;
  sizeMm: number;
  bold: boolean;
  align: TextAlign;
  direction: TextDirection;
  /** Additional spacing between glyphs, in mm (0 = font default). */
  letterSpacingMm: number;
  /** Line spacing multiplier for multi-line text. */
  lineSpacing: number;
  mode: ReliefMode;
  /** Raised height / engraved depth / inlay depth, in mm. */
  depthMm: number;
  /** Bend the text along a circle of this radius (0 = straight). */
  curveRadiusMm: number;
  /** Mirror horizontally (stamps). Applied to the 2D outlines. */
  mirrored: boolean;
}

export type SvgQuality = "draft" | "standard" | "fine";

export interface SvgLayer extends LayerCommon {
  type: "svg";
  /** Sanitized SVG markup (scripts/handlers/external refs removed). */
  svgText: string;
  /** Original filename, for display. */
  sourceName: string;
  targetWidthMm: number;
  targetHeightMm: number;
  preserveAspect: boolean;
  /** Intrinsic aspect ratio (width / height) captured at import time. */
  aspectRatio: number;
  flipH: boolean;
  flipV: boolean;
  mode: ReliefMode;
  depthMm: number;
  /** Curve tessellation quality. */
  quality: SvgQuality;
  /** Import-time warnings (unsupported features etc.), Hebrew text. */
  importWarnings: string[];
}

export type ImageResolution = "draft" | "standard" | "fine";
export type ReliefMapping = "darkHigh" | "lightHigh";

/** Non-destructive image adjustments, applied in a fixed order. */
export interface ImageAdjustments {
  /** Crop fractions of each edge, 0..0.45. */
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
  /** Number of clockwise 90° rotations (0..3). */
  rotate90: number;
  /** Additional free rotation, degrees. */
  freeRotationDeg: number;
  flipH: boolean;
  flipV: boolean;
  /** -100..100 */
  brightness: number;
  /** -100..100 */
  contrast: number;
  grayscale: boolean;
  invert: boolean;
  /** Box-blur radius in pixels, 0..10. */
  blurPx: number;
  /** Tonal levels 0 (off) or 2..8. */
  posterizeLevels: number;
  /** Black/white threshold: -1 = off, otherwise 0..255. */
  threshold: number;
}

export const DEFAULT_ADJUSTMENTS: ImageAdjustments = {
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
  rotate90: 0,
  freeRotationDeg: 0,
  flipH: false,
  flipV: false,
  brightness: 0,
  contrast: 0,
  grayscale: true,
  invert: false,
  blurPx: 0,
  posterizeLevels: 0,
  threshold: -1,
};

export interface ImageReliefLayer extends LayerCommon {
  type: "imageRelief";
  /** Session asset-store id of the uploaded image (and optional mask). */
  assetId: string;
  sourceName: string;
  adjustments: ImageAdjustments;
  mode: ImageReliefMode;
  /** Relief height range in mm (raised/engraved) or extrusion (silhouette). */
  minHeightMm: number;
  maxHeightMm: number;
  mapping: ReliefMapping;
  resolution: ImageResolution;
  widthMm: number;
  heightMm: number;
  preserveAspect: boolean;
  /** Aspect ratio (width / height) of the processed image. */
  aspectRatio: number;
  /** Alpha cutoff (0..255) below which pixels produce no material. */
  alphaThreshold: number;
}

export type HoleShape = "circle" | "rectangle";

/** A hole / cutout / pocket. Always subtracts from the base. */
export interface HoleLayer extends LayerCommon {
  type: "hole";
  shape: HoleShape;
  diameterMm: number;
  widthMm: number;
  heightMm: number;
  cornerRadiusMm: number;
  /** Through-hole (ignores depth) or blind pocket. */
  through: boolean;
  depthMm: number;
  /** Blind pockets can open from the bottom face (magnet pockets). */
  fromBottom: boolean;
}

export type DesignLayer =
  | BaseLayer
  | TextLayer
  | SvgLayer
  | ImageReliefLayer
  | HoleLayer;

/** Layers that carry a raised/engraved relief mode. */
export type ReliefLayer = TextLayer | SvgLayer | ImageReliefLayer;

/** The boolean role a layer plays in the build pipeline. */
export function layerOperation(layer: DesignLayer): LayerOperation {
  switch (layer.type) {
    case "hole":
      return "subtract";
    case "text":
    case "svg":
      return layer.mode === "engraved" ? "subtract" : "add";
    case "imageRelief":
      return layer.mode === "engraved" ? "subtract" : "add";
    case "base":
      return "add";
  }
}

// ---------------------------------------------------------------------------
// Multi-colour
// ---------------------------------------------------------------------------

export interface ColorMaterial {
  /** Display name, e.g. "צבע 1". */
  name: string;
  colorHex: string;
  /** Material type, e.g. "PLA". */
  materialType: string;
  /** Optional filament product name. */
  filamentName: string;
}

export interface MultiColorSettings {
  enabled: boolean;
  /** Exactly 4 slots. Slot 0 is the base slot by convention. */
  slots: ColorMaterial[];
  /** XY clearance for flush inlay pockets, in mm. */
  inlayClearanceMm: number;
}

// ---------------------------------------------------------------------------
// Printer / material / estimation profiles
// ---------------------------------------------------------------------------

export type PrinterTechnology = "FDM" | "Resin";

export interface PrinterProfile {
  name: string;
  technology: PrinterTechnology;
  buildVolumeMm: { x: number; y: number; z: number };
  nozzleDiameterMm: number;
  layerHeightMm: number;
  /** Average effective print speed, mm/s (FDM) or exposure-driven (resin). */
  printSpeedMmS: number;
  infillPercent: number;
  wallCount: number;
  topBottomLayers: number;
  supportsEnabled: boolean;
  powerWatts: number;
  electricityPricePerKwh: number;
}

export interface MaterialProfile {
  name: string;
  /** g/cm³ */
  densityGCm3: number;
  /** Cost per kg (filament) in the selected currency. */
  costPerKg: number;
  /** Cost per litre (resin) in the selected currency. */
  costPerLitre: number;
  currency: string;
  wastePercent: number;
  supportMaterialPercent: number;
  colorHex: string;
}

export interface EstimateSettings {
  printer: PrinterProfile;
  material: MaterialProfile;
  /** Machine wear + overhead per print hour. */
  machineOverheadPerHour: number;
  laborCost: number;
  packagingCost: number;
  setupMinutes: number;
  postProcessingMinutes: number;
  markupPercent: number;
  targetMarginPercent: number;
}

export interface EstimateResult {
  /** Solid model volume, cm³. */
  modelVolumeCm3: number;
  /** Material actually consumed (infill/walls/waste adjusted), cm³. */
  materialVolumeCm3: number;
  materialWeightGrams: number;
  materialCost: number;
  electricityCost: number;
  machineCost: number;
  laborCost: number;
  packagingCost: number;
  totalCost: number;
  suggestedPriceMarkup: number;
  suggestedPriceMargin: number;
  currency: string;
}

export type EstimateConfidence = "low" | "medium" | "high";

export interface TimeEstimateResult {
  layerCount: number;
  /** Print duration range, minutes. */
  printMinutesMin: number;
  printMinutesMax: number;
  setupMinutes: number;
  postProcessingMinutes: number;
  totalMinutesMin: number;
  totalMinutesMax: number;
  confidence: EstimateConfidence;
}

// ---------------------------------------------------------------------------
// Printability profiles & validation
// ---------------------------------------------------------------------------

export type PrintabilityProfileId = "fdm-pla" | "fdm-petg" | "resin-sla";

/** Editable printability guideline values, in mm. */
export interface PrintabilityLimitsV2 {
  minWallMm: number;
  minEmbossHeightMm: number;
  minEngraveDepthMm: number;
  minEngraveFloorMm: number;
  minHoleDiameterMm: number;
  minHoleEdgeDistanceMm: number;
  recommendedClearanceMm: number;
  safetyMarginMm: number;
  minTextSizeMm: number;
  minFeatureMm: number;
  maxTriangleCount: number;
}

export interface PrintabilityProfile {
  id: PrintabilityProfileId;
  nameHe: string;
  nameEn: string;
  limits: PrintabilityLimitsV2;
}

export type ValidationSeverity = "ok" | "warning" | "error";

export interface DesignIssue {
  code: string;
  severity: Exclude<ValidationSeverity, "ok">;
  /** Simple Hebrew explanation. */
  message: string;
  /** Affected layer id, when attributable. */
  layerId?: string;
  /** Recommended action, Hebrew. */
  recommendation?: string;
  /** Expandable technical details (English values allowed). */
  details?: string;
}

/** Mesh-level statistics gathered from the built model. */
export interface ModelMeshReport {
  triangleCount: number;
  dimensionsMm: { x: number; y: number; z: number };
  volumeCm3: number;
  watertight: boolean;
  openEdgeCount: number;
  nonManifoldEdgeCount: number;
  degenerateTriangleCount: number;
  duplicateVertexCount: number;
  connectedComponents: number;
  partCount: number;
}

export interface ModelValidationResult {
  status: ValidationSeverity;
  issues: DesignIssue[];
  mesh: ModelMeshReport | null;
}

// ---------------------------------------------------------------------------
// Product templates
// ---------------------------------------------------------------------------

export type ProductTemplateId =
  | "namePlate"
  | "keychain"
  | "medal"
  | "nameTag"
  | "fridgeMagnet"
  | "stamp"
  | "coaster"
  | "wallPlaque"
  | "blank";

export interface ProductTemplate {
  id: ProductTemplateId;
  nameHe: string;
  descriptionHe: string;
  icon: string;
  /** Hebrew usage notes shown when the template is selected (e.g. stamp mirroring). */
  noteHe?: string;
  suggestedMaterial: string;
  suggestedFilename: string;
  defaultCameraView: "front" | "top" | "iso";
  /** Builds a fresh document for this template. */
  create: () => DesignDocument;
}

// ---------------------------------------------------------------------------
// Document & settings
// ---------------------------------------------------------------------------

export interface DesignSettings {
  multiColor: MultiColorSettings;
  estimate: EstimateSettings;
  printabilityProfileId: PrintabilityProfileId;
  /** User overrides on top of the selected profile's limits. */
  printabilityOverrides: Partial<PrintabilityLimitsV2>;
}

export interface DesignDocument {
  /** Document schema version (bumped on breaking changes). */
  version: 2;
  title: string;
  templateId: ProductTemplateId;
  /** layers[0] is always the BaseLayer. */
  layers: DesignLayer[];
}

export interface DesignState {
  doc: DesignDocument;
  settings: DesignSettings;
}

// ---------------------------------------------------------------------------
// History (in-memory only)
// ---------------------------------------------------------------------------

export interface EditorHistoryState {
  past: DesignState[];
  future: DesignState[];
  /** Coalescing key of the latest commit (merges rapid slider edits). */
  lastCommitKey: string | null;
  lastCommitAt: number;
}

// ---------------------------------------------------------------------------
// Portable design file
// ---------------------------------------------------------------------------

export interface PortableImageAsset {
  /** data: URL of the (possibly downscaled) source image. */
  dataUrl: string;
  /** Optional grayscale mask as data: URL (white = keep). */
  maskDataUrl?: string;
  width: number;
  height: number;
}

export const PORTABLE_FORMAT = "formadesign";
export const PORTABLE_FORMAT_VERSION = 1;
export const PORTABLE_EXTENSION = ".formadesign.json";

export interface PortableDesignFile {
  format: typeof PORTABLE_FORMAT;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  title: string;
  doc: DesignDocument;
  settings: DesignSettings;
  assets: Record<string, PortableImageAsset>;
}
