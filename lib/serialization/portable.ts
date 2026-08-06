/**
 * Portable design file (.formadesign.json): manual export/import of the
 * active design. This is the ONLY persistence mechanism in the app — the
 * user explicitly downloads a file and can open it later. Nothing is stored
 * in localStorage / IndexedDB / cookies / servers.
 *
 * Import is strictly validated: unknown formats, bad versions, malformed
 * layers, and oversized payloads are rejected with Hebrew error messages.
 * No code from the file is ever executed; SVG content is re-sanitized by
 * the caller before use.
 */

import {
  DEFAULT_ADJUSTMENTS,
  IDENTITY_TRANSFORM,
  PORTABLE_EXTENSION,
  PORTABLE_FORMAT,
  PORTABLE_FORMAT_VERSION,
  type BaseLayer,
  type DesignDocument,
  type DesignLayer,
  type DesignSettings,
  type DesignState,
  type HoleLayer,
  type ImageAdjustments,
  type ImageReliefLayer,
  type LayerTransform,
  type PortableDesignFile,
  type PortableImageAsset,
  type ProductTemplateId,
  type SvgLayer,
  type TextLayer,
} from "@/types/design";
import { APP_VERSION, defaultSettings } from "@/lib/design/defaults";

export const PORTABLE_MAX_BYTES = 30 * 1024 * 1024; // 30 MB (with embedded images)
/** Above this size the export dialog suggests splitting assets into a ZIP. */
export const PORTABLE_LARGE_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface BuildPortableInput {
  state: DesignState;
  title: string;
  assets: Record<string, PortableImageAsset>;
  /** Injectable for tests. */
  now?: Date;
}

export function buildPortableFile(input: BuildPortableInput): PortableDesignFile {
  return {
    format: PORTABLE_FORMAT,
    formatVersion: PORTABLE_FORMAT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: (input.now ?? new Date()).toISOString(),
    title: input.title.slice(0, 120),
    doc: { ...input.state.doc, title: input.title.slice(0, 120) },
    settings: input.state.settings,
    assets: input.assets,
  };
}

export function serializePortable(file: PortableDesignFile): string {
  return JSON.stringify(file, null, 1);
}

// ---------------------------------------------------------------------------
// Import — validation helpers
// ---------------------------------------------------------------------------

export class PortableImportError extends Error {
  constructor(public messageHe: string) {
    super(messageHe);
    this.name = "PortableImportError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = "", maxLen = 500): string {
  return typeof v === "string" ? v.slice(0, maxLen) : fallback;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function colorHex(v: unknown, fallback: string): string {
  if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  return fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

function transform(v: unknown): LayerTransform {
  if (!isRecord(v)) return { ...IDENTITY_TRANSFORM };
  return {
    x: num(v.x, 0, -500, 500),
    y: num(v.y, 0, -500, 500),
    z: num(v.z, 0, -100, 100),
    rotationX: num(v.rotationX, 0, -360, 360),
    rotationY: num(v.rotationY, 0, -360, 360),
    rotationZ: num(v.rotationZ, 0, -360, 360),
    scaleX: num(v.scaleX, 1, 0.05, 20),
    scaleY: num(v.scaleY, 1, 0.05, 20),
    scaleZ: num(v.scaleZ, 1, 0.05, 20),
  };
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function layerId(v: unknown, index: number): string {
  const s = str(v, "", 64);
  return ID_RE.test(s) ? s : `layer_import_${index}`;
}

function common(v: Record<string, unknown>, index: number) {
  return {
    id: layerId(v.id, index),
    name: str(v.name, `שכבה ${index + 1}`, 80) || `שכבה ${index + 1}`,
    visible: bool(v.visible, true),
    locked: bool(v.locked, false),
    colorHex: colorHex(v.colorHex, "#8a8f98"),
    colorSlot: Math.round(num(v.colorSlot, 0, 0, 3)),
    transform: transform(v.transform),
  };
}

function parseBaseLayer(v: Record<string, unknown>, index: number): BaseLayer {
  const rim = isRecord(v.rim) ? v.rim : {};
  return {
    ...common(v, index),
    type: "base",
    shape: oneOf(v.shape, ["rectangle", "roundedRectangle", "circle"] as const, "rectangle"),
    widthMm: num(v.widthMm, 100, 10, 400),
    heightMm: num(v.heightMm, 60, 10, 400),
    thicknessMm: num(v.thicknessMm, 3, 1, 50),
    cornerRadiusMm: num(v.cornerRadiusMm, 0, 0, 200),
    rim: {
      enabled: bool(rim.enabled, false),
      widthMm: num(rim.widthMm, 3, 0.8, 20),
      heightMm: num(rim.heightMm, 1.5, 0.4, 20),
    },
  };
}

function parseTextLayer(v: Record<string, unknown>, index: number): TextLayer {
  return {
    ...common(v, index),
    type: "text",
    content: str(v.content, "", 200),
    fontId: str(v.fontId, "alef", 40) || "alef",
    sizeMm: num(v.sizeMm, 16, 2, 200),
    bold: bool(v.bold, false),
    align: oneOf(v.align, ["right", "center", "left"] as const, "center"),
    direction: oneOf(v.direction, ["auto", "rtl", "ltr"] as const, "auto"),
    letterSpacingMm: num(v.letterSpacingMm, 0, -2, 20),
    lineSpacing: num(v.lineSpacing, 1, 0.8, 3),
    mode: oneOf(v.mode, ["raised", "engraved", "inlay"] as const, "raised"),
    depthMm: num(v.depthMm, 1.5, 0.2, 50),
    curveRadiusMm: num(v.curveRadiusMm, 0, 0, 500),
    mirrored: bool(v.mirrored, false),
  };
}

function parseSvgLayer(v: Record<string, unknown>, index: number): SvgLayer {
  const svgText = typeof v.svgText === "string" ? v.svgText : "";
  if (svgText.length > 3 * 1024 * 1024) {
    throw new PortableImportError("קובץ העיצוב מכיל SVG גדול מדי");
  }
  const warnings = Array.isArray(v.importWarnings)
    ? v.importWarnings.filter((w): w is string => typeof w === "string").slice(0, 20)
    : [];
  return {
    ...common(v, index),
    type: "svg",
    svgText,
    sourceName: str(v.sourceName, "logo.svg", 120),
    targetWidthMm: num(v.targetWidthMm, 30, 2, 380),
    targetHeightMm: num(v.targetHeightMm, 30, 2, 380),
    preserveAspect: bool(v.preserveAspect, true),
    aspectRatio: num(v.aspectRatio, 1, 0.01, 100),
    flipH: bool(v.flipH, false),
    flipV: bool(v.flipV, false),
    mode: oneOf(v.mode, ["raised", "engraved", "inlay"] as const, "raised"),
    depthMm: num(v.depthMm, 1.5, 0.2, 50),
    quality: oneOf(v.quality, ["draft", "standard", "fine"] as const, "standard"),
    importWarnings: warnings,
  };
}

function parseAdjustments(v: unknown): ImageAdjustments {
  if (!isRecord(v)) return { ...DEFAULT_ADJUSTMENTS };
  return {
    cropLeft: num(v.cropLeft, 0, 0, 0.45),
    cropRight: num(v.cropRight, 0, 0, 0.45),
    cropTop: num(v.cropTop, 0, 0, 0.45),
    cropBottom: num(v.cropBottom, 0, 0, 0.45),
    rotate90: Math.round(num(v.rotate90, 0, 0, 3)),
    freeRotationDeg: num(v.freeRotationDeg, 0, -180, 180),
    flipH: bool(v.flipH, false),
    flipV: bool(v.flipV, false),
    brightness: num(v.brightness, 0, -100, 100),
    contrast: num(v.contrast, 0, -100, 100),
    grayscale: bool(v.grayscale, true),
    invert: bool(v.invert, false),
    blurPx: num(v.blurPx, 0, 0, 10),
    posterizeLevels: Math.round(num(v.posterizeLevels, 0, 0, 8)),
    threshold: num(v.threshold, -1, -1, 255),
  };
}

function parseImageLayer(v: Record<string, unknown>, index: number): ImageReliefLayer {
  return {
    ...common(v, index),
    type: "imageRelief",
    assetId: layerId(v.assetId, index),
    sourceName: str(v.sourceName, "image.png", 120),
    adjustments: parseAdjustments(v.adjustments),
    mode: oneOf(v.mode, ["raised", "engraved", "silhouette"] as const, "raised"),
    minHeightMm: num(v.minHeightMm, 0.2, 0.1, 20),
    maxHeightMm: num(v.maxHeightMm, 2, 0.1, 20),
    mapping: oneOf(v.mapping, ["darkHigh", "lightHigh"] as const, "darkHigh"),
    resolution: oneOf(v.resolution, ["draft", "standard", "fine"] as const, "standard"),
    widthMm: num(v.widthMm, 50, 5, 380),
    heightMm: num(v.heightMm, 50, 5, 380),
    preserveAspect: bool(v.preserveAspect, true),
    aspectRatio: num(v.aspectRatio, 1, 0.01, 100),
    alphaThreshold: num(v.alphaThreshold, 96, 0, 255),
  };
}

function parseHoleLayer(v: Record<string, unknown>, index: number): HoleLayer {
  return {
    ...common(v, index),
    type: "hole",
    shape: oneOf(v.shape, ["circle", "rectangle"] as const, "circle"),
    diameterMm: num(v.diameterMm, 4.5, 0.5, 60),
    widthMm: num(v.widthMm, 8, 1, 200),
    heightMm: num(v.heightMm, 4, 1, 200),
    cornerRadiusMm: num(v.cornerRadiusMm, 1, 0, 100),
    through: bool(v.through, true),
    depthMm: num(v.depthMm, 2, 0.1, 50),
    fromBottom: bool(v.fromBottom, false),
  };
}

function parseLayer(v: unknown, index: number): DesignLayer {
  if (!isRecord(v)) {
    throw new PortableImportError(`שכבה ${index + 1} בקובץ אינה תקינה`);
  }
  switch (v.type) {
    case "base":
      return parseBaseLayer(v, index);
    case "text":
      return parseTextLayer(v, index);
    case "svg":
      return parseSvgLayer(v, index);
    case "imageRelief":
      return parseImageLayer(v, index);
    case "hole":
      return parseHoleLayer(v, index);
    default:
      throw new PortableImportError(
        `שכבה ${index + 1} היא מסוג לא מוכר (${str(v.type, "?", 30)}) — ייתכן שהקובץ נוצר בגרסה חדשה יותר`
      );
  }
}

const TEMPLATE_IDS: readonly ProductTemplateId[] = [
  "namePlate",
  "keychain",
  "medal",
  "nameTag",
  "fridgeMagnet",
  "stamp",
  "coaster",
  "wallPlaque",
  "blank",
];

function parseSettings(v: unknown): DesignSettings {
  const defaults = defaultSettings();
  if (!isRecord(v)) return defaults;

  const mc = isRecord(v.multiColor) ? v.multiColor : {};
  const slotsRaw = Array.isArray(mc.slots) ? mc.slots : [];
  const slots = defaults.multiColor.slots.map((slot, i) => {
    const s = isRecord(slotsRaw[i]) ? (slotsRaw[i] as Record<string, unknown>) : {};
    return {
      name: str(s.name, slot.name, 60) || slot.name,
      colorHex: colorHex(s.colorHex, slot.colorHex),
      materialType: str(s.materialType, slot.materialType, 30) || slot.materialType,
      filamentName: str(s.filamentName, "", 80),
    };
  });

  const est = isRecord(v.estimate) ? v.estimate : {};
  const printerRaw = isRecord(est.printer) ? est.printer : {};
  const materialRaw = isRecord(est.material) ? est.material : {};
  const dp = defaults.estimate.printer;
  const dm = defaults.estimate.material;
  const bv = isRecord(printerRaw.buildVolumeMm) ? printerRaw.buildVolumeMm : {};

  return {
    multiColor: {
      enabled: bool(mc.enabled, false),
      slots,
      inlayClearanceMm: num(mc.inlayClearanceMm, 0.15, 0, 2),
    },
    estimate: {
      printer: {
        name: str(printerRaw.name, dp.name, 80) || dp.name,
        technology: oneOf(printerRaw.technology, ["FDM", "Resin"] as const, dp.technology),
        buildVolumeMm: {
          x: num(bv.x, dp.buildVolumeMm.x, 10, 2000),
          y: num(bv.y, dp.buildVolumeMm.y, 10, 2000),
          z: num(bv.z, dp.buildVolumeMm.z, 10, 2000),
        },
        nozzleDiameterMm: num(printerRaw.nozzleDiameterMm, dp.nozzleDiameterMm, 0, 2),
        layerHeightMm: num(printerRaw.layerHeightMm, dp.layerHeightMm, 0.01, 1),
        printSpeedMmS: num(printerRaw.printSpeedMmS, dp.printSpeedMmS, 0, 1000),
        infillPercent: num(printerRaw.infillPercent, dp.infillPercent, 0, 100),
        wallCount: Math.round(num(printerRaw.wallCount, dp.wallCount, 0, 10)),
        topBottomLayers: Math.round(num(printerRaw.topBottomLayers, dp.topBottomLayers, 0, 20)),
        supportsEnabled: bool(printerRaw.supportsEnabled, dp.supportsEnabled),
        powerWatts: num(printerRaw.powerWatts, dp.powerWatts, 0, 5000),
        electricityPricePerKwh: num(printerRaw.electricityPricePerKwh, dp.electricityPricePerKwh, 0, 100),
      },
      material: {
        name: str(materialRaw.name, dm.name, 40) || dm.name,
        densityGCm3: num(materialRaw.densityGCm3, dm.densityGCm3, 0.5, 25),
        costPerKg: num(materialRaw.costPerKg, dm.costPerKg, 0, 100000),
        costPerLitre: num(materialRaw.costPerLitre, dm.costPerLitre, 0, 100000),
        currency: str(materialRaw.currency, dm.currency, 8) || dm.currency,
        wastePercent: num(materialRaw.wastePercent, dm.wastePercent, 0, 100),
        supportMaterialPercent: num(materialRaw.supportMaterialPercent, dm.supportMaterialPercent, 0, 100),
        colorHex: colorHex(materialRaw.colorHex, dm.colorHex),
      },
      machineOverheadPerHour: num(est.machineOverheadPerHour, 2, 0, 1000),
      laborCost: num(est.laborCost, 10, 0, 100000),
      packagingCost: num(est.packagingCost, 2, 0, 100000),
      setupMinutes: num(est.setupMinutes, 10, 0, 600),
      postProcessingMinutes: num(est.postProcessingMinutes, 10, 0, 600),
      markupPercent: num(est.markupPercent, 100, 0, 1000),
      targetMarginPercent: num(est.targetMarginPercent, 50, 0, 95),
    },
    printabilityProfileId: oneOf(
      v.printabilityProfileId,
      ["fdm-pla", "fdm-petg", "resin-sla"] as const,
      "fdm-pla"
    ),
    printabilityOverrides: {},
  };
}

const DATA_URL_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

function parseAssets(v: unknown): Record<string, PortableImageAsset> {
  if (!isRecord(v)) return {};
  const out: Record<string, PortableImageAsset> = {};
  let total = 0;
  for (const [key, value] of Object.entries(v)) {
    if (!ID_RE.test(key) || !isRecord(value)) continue;
    const dataUrl = typeof value.dataUrl === "string" ? value.dataUrl : "";
    if (!DATA_URL_RE.test(dataUrl)) continue;
    const maskDataUrl =
      typeof value.maskDataUrl === "string" && DATA_URL_RE.test(value.maskDataUrl)
        ? value.maskDataUrl
        : undefined;
    total += dataUrl.length + (maskDataUrl?.length ?? 0);
    if (total > PORTABLE_MAX_BYTES) {
      throw new PortableImportError("קובץ העיצוב מכיל תמונות גדולות מדי");
    }
    out[key] = {
      dataUrl,
      width: num(value.width, 1, 1, 8192),
      height: num(value.height, 1, 1, 8192),
      ...(maskDataUrl ? { maskDataUrl } : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Import — entry point
// ---------------------------------------------------------------------------

export interface ParsedPortable {
  state: DesignState;
  assets: Record<string, PortableImageAsset>;
  title: string;
}

/**
 * Parse and validate portable design JSON. Throws PortableImportError with
 * a Hebrew message on any problem.
 */
export function parsePortableDesign(jsonText: string): ParsedPortable {
  if (jsonText.length > PORTABLE_MAX_BYTES) {
    throw new PortableImportError(
      `קובץ העיצוב גדול מדי (מקסימום ${Math.round(PORTABLE_MAX_BYTES / 1024 / 1024)}MB)`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new PortableImportError("הקובץ אינו JSON תקין — ייתכן שהוא פגום");
  }
  if (!isRecord(parsed)) {
    throw new PortableImportError("מבנה הקובץ אינו תקין");
  }
  if (parsed.format !== PORTABLE_FORMAT) {
    throw new PortableImportError("הקובץ אינו קובץ עיצוב של הכלי (format לא מזוהה)");
  }
  const version = typeof parsed.formatVersion === "number" ? parsed.formatVersion : -1;
  if (version < 1 || version > PORTABLE_FORMAT_VERSION) {
    throw new PortableImportError(
      `גרסת קובץ העיצוב (${version}) אינה נתמכת — ייתכן שנוצר בגרסה חדשה יותר של הכלי`
    );
  }

  const docRaw = parsed.doc;
  if (!isRecord(docRaw) || !Array.isArray(docRaw.layers) || docRaw.layers.length === 0) {
    throw new PortableImportError("קובץ העיצוב אינו מכיל שכבות");
  }
  if (docRaw.layers.length > 60) {
    throw new PortableImportError("קובץ העיצוב מכיל יותר מדי שכבות");
  }

  const layers = docRaw.layers.map((l, i) => parseLayer(l, i));
  if (layers[0].type !== "base") {
    throw new PortableImportError("השכבה הראשונה בקובץ חייבת להיות שכבת בסיס");
  }
  if (layers.slice(1).some((l) => l.type === "base")) {
    throw new PortableImportError("קובץ העיצוב מכיל יותר משכבת בסיס אחת");
  }

  // Ensure unique layer ids.
  const seen = new Set<string>();
  for (const layer of layers) {
    if (seen.has(layer.id)) {
      throw new PortableImportError("קובץ העיצוב מכיל מזהי שכבות כפולים");
    }
    seen.add(layer.id);
  }

  const title = str(parsed.title, "", 120);
  const doc: DesignDocument = {
    version: 2,
    title,
    templateId: oneOf(docRaw.templateId, TEMPLATE_IDS, "blank"),
    layers,
  };

  const assets = parseAssets(parsed.assets);

  // Every image layer must have its asset present.
  for (const layer of layers) {
    if (layer.type === "imageRelief" && !assets[layer.assetId]) {
      throw new PortableImportError(
        `לשכבת התמונה "${layer.name}" חסרים נתוני תמונה בקובץ`
      );
    }
  }

  return {
    state: { doc, settings: parseSettings(parsed.settings) },
    assets,
    title,
  };
}

/** Validate the file name/size before reading. */
export function validatePortableFile(file: { name: string; size: number }): string | null {
  if (!file.name.toLowerCase().endsWith(".json")) {
    return `יש לבחור קובץ עיצוב עם סיומת ${PORTABLE_EXTENSION}`;
  }
  if (file.size === 0) return "הקובץ ריק";
  if (file.size > PORTABLE_MAX_BYTES) {
    return `קובץ העיצוב גדול מדי (מקסימום ${Math.round(PORTABLE_MAX_BYTES / 1024 / 1024)}MB)`;
  }
  return null;
}
