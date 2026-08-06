/**
 * Portable design file (.formadesign.json): full document + embedded mesh
 * payloads, exported and imported explicitly by the user. This is the ONLY
 * persistence mechanism in the app — nothing is written to localStorage,
 * IndexedDB or any server.
 *
 * Import is strictly validating and never executes anything from the file:
 * JSON.parse → structural validation with per-field type checks → number
 * sanitation → meshes re-registered in the session store under fresh ids.
 * Unknown schema versions fail with a clear Hebrew error; a migration hook
 * is in place for future versions.
 */

import type {
  BaseMode,
  DesignDocument,
  DesignLayer,
  MaterialSlot,
  PortableDesignFile,
  PortableMesh,
  StoredContour,
  Transform3D,
} from "@/types/design";
import { DESIGN_SCHEMA_VERSION, identityTransform, newId } from "@/types/design";
import { decodeMeshData, encodeMeshData } from "@/lib/geometry/meshData";
import { getMesh, storeMesh } from "@/lib/geometry/meshStore";

export const DESIGN_FILE_EXTENSION = ".formadesign.json";
const APP_VERSION = "3.0.0";
/** Mesh payload cap inside a design file (base64-decoded bytes). */
const MAX_MESH_BYTES = 120 * 1024 * 1024;
/** Warn when embedded meshes exceed this many triangles in total. */
const WARN_TOTAL_TRIANGLES = 800_000;

export class DesignFileError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "DesignFileError";
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Mesh ids referenced by a document's layers. */
function referencedMeshIds(document: DesignDocument): string[] {
  const ids: string[] = [];
  for (const layer of document.layers) {
    if (layer.type === "importedMesh") {
      ids.push(layer.meshId);
      if (layer.originalMeshId) ids.push(layer.originalMeshId);
    } else if (layer.type === "imageRelief" && layer.meshId) {
      ids.push(layer.meshId);
    }
  }
  return [...new Set(ids)];
}

export function exportDesignFile(document: DesignDocument): PortableDesignFile {
  const meshes: PortableMesh[] = [];
  for (const meshId of referencedMeshIds(document)) {
    const mesh = getMesh(meshId);
    if (!mesh) {
      throw new DesignFileError(
        "חלק מנתוני הרשת חסרים בהפעלה הנוכחית — לא ניתן לייצא את הקובץ"
      );
    }
    const encoded = encodeMeshData(mesh);
    meshes.push({ id: meshId, positions: encoded.positions, indices: encoded.indices });
  }
  return {
    format: "formadesign",
    schemaVersion: DESIGN_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    document,
    meshes,
  };
}

export function serializeDesignFile(document: DesignDocument): string {
  return JSON.stringify(exportDesignFile(document));
}

// ---------------------------------------------------------------------------
// Import + validation
// ---------------------------------------------------------------------------

export interface DesignFileImportResult {
  document: DesignDocument;
  warningsHe: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedString(value: unknown, fallback: string, maxLength = 500): string {
  if (typeof value !== "string") return fallback;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function sanitizeTransform(value: unknown): Transform3D {
  const t = identityTransform();
  if (!isRecord(value)) return t;
  return {
    x: finiteNumber(value.x, 0),
    y: finiteNumber(value.y, 0),
    z: finiteNumber(value.z, 0),
    rotationX: finiteNumber(value.rotationX, 0),
    rotationY: finiteNumber(value.rotationY, 0),
    rotationZ: finiteNumber(value.rotationZ, 0),
    scaleX: finiteNumber(value.scaleX, 1) || 1,
    scaleY: finiteNumber(value.scaleY, 1) || 1,
    scaleZ: finiteNumber(value.scaleZ, 1) || 1,
  };
}

function sanitizeContours(value: unknown): StoredContour[] {
  if (!Array.isArray(value)) return [];
  const contours: StoredContour[] = [];
  let totalPoints = 0;
  for (const raw of value) {
    if (!Array.isArray(raw)) continue;
    const contour: StoredContour = [];
    for (const point of raw) {
      if (
        Array.isArray(point) &&
        point.length >= 2 &&
        typeof point[0] === "number" &&
        typeof point[1] === "number" &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1])
      ) {
        contour.push([point[0], point[1]]);
      }
    }
    totalPoints += contour.length;
    if (totalPoints > 500_000) {
      throw new DesignFileError("קובץ העיצוב מכיל כמות חריגה של נקודות מתאר");
    }
    if (contour.length >= 3) contours.push(contour);
  }
  return contours;
}

function sanitizeBevel(value: unknown): { enabled: boolean; sizeMm: number; segments: number } {
  if (!isRecord(value)) return { enabled: false, sizeMm: 0.6, segments: 4 };
  return {
    enabled: value.enabled === true,
    sizeMm: Math.max(0, Math.min(finiteNumber(value.sizeMm, 0.6), 20)),
    segments: Math.max(2, Math.min(Math.round(finiteNumber(value.segments, 4)), 8)),
  };
}

const LAYER_TYPES = new Set(["base", "text", "svg", "imageRelief", "importedMesh", "hole"]);
const COMBINE_MODES = new Set(["raised", "engraved", "inlay", "standalone"]);
const FONT_IDS = new Set(["alef", "davidLibre", "suezOne", "varelaRound"]);

function sanitizeLayer(
  raw: unknown,
  meshIdMap: Map<string, string>,
  warningsHe: string[]
): DesignLayer | null {
  if (!isRecord(raw) || typeof raw.type !== "string" || !LAYER_TYPES.has(raw.type)) {
    warningsHe.push("שכבה מסוג לא מוכר דולגה");
    return null;
  }
  const common = {
    id: newId("layer"),
    name: boundedString(raw.name, "שכבה", 120),
    visible: raw.visible !== false,
    locked: raw.locked === true,
    materialSlotId: boundedString(raw.materialSlotId, "slot1", 40),
    transform: sanitizeTransform(raw.transform),
    previewOpacity: Math.max(0.05, Math.min(finiteNumber(raw.previewOpacity, 1), 1)),
  };
  const combine = COMBINE_MODES.has(String(raw.combine))
    ? (String(raw.combine) as "raised" | "engraved" | "inlay" | "standalone")
    : "standalone";

  switch (raw.type) {
    case "base":
      return {
        ...common,
        type: "base",
        shape:
          raw.shape === "roundedRectangle" || raw.shape === "circle"
            ? raw.shape
            : "rectangle",
        widthMm: finiteNumber(raw.widthMm, 100),
        heightMm: finiteNumber(raw.heightMm, 50),
        thicknessMm: finiteNumber(raw.thicknessMm, 3),
        cornerRadiusMm: finiteNumber(raw.cornerRadiusMm, 0),
        rimEnabled: raw.rimEnabled === true,
        rimWidthMm: Math.max(0.5, Math.min(finiteNumber(raw.rimWidthMm, 2.5), 20)),
        rimHeightMm: Math.max(0.2, Math.min(finiteNumber(raw.rimHeightMm, 1.2), 20)),
      };
    case "text":
      return {
        ...common,
        type: "text",
        content: boundedString(raw.content, "", 500),
        fontId: FONT_IDS.has(String(raw.fontId))
          ? (String(raw.fontId) as import("@/lib/geometry/types").FontId)
          : "alef",
        sizeMm: finiteNumber(raw.sizeMm, 20),
        bold: raw.bold === true,
        align:
          raw.align === "left" || raw.align === "right" || raw.align === "center"
            ? raw.align
            : "center",
        lineSpacing: finiteNumber(raw.lineSpacing, 1),
        letterSpacingMm: Math.max(-5, Math.min(finiteNumber(raw.letterSpacingMm, 0), 20)),
        direction: raw.direction === "ltr" ? "ltr" : "auto",
        curveRadiusMm: Math.max(0, Math.min(finiteNumber(raw.curveRadiusMm, 0), 1000)),
        mirrored: raw.mirrored === true,
        extrudeMm: finiteNumber(raw.extrudeMm, 1.5),
        combine,
        bevel: sanitizeBevel(raw.bevel),
      };
    case "svg":
      return {
        ...common,
        type: "svg",
        sourceName: boundedString(raw.sourceName, "svg", 200),
        contours: sanitizeContours(raw.contours),
        extrudeMm: finiteNumber(raw.extrudeMm, 3),
        combine,
        bevel: sanitizeBevel(raw.bevel),
      };
    case "imageRelief": {
      const settings = isRecord(raw.settings) ? raw.settings : {};
      const meshId =
        typeof raw.meshId === "string" ? (meshIdMap.get(raw.meshId) ?? null) : null;
      const mode = raw.mode === "relief" ? "relief" : "silhouette";
      if (mode === "relief" && !meshId) {
        warningsHe.push("שכבת תבליט ללא נתוני גוף דולגה");
        return null;
      }
      return {
        ...common,
        type: "imageRelief",
        sourceName: boundedString(raw.sourceName, "image", 200),
        mode,
        contours: sanitizeContours(raw.contours),
        meshId,
        settings: {
          targetWidthMm: finiteNumber(settings.targetWidthMm, 60),
          threshold: Math.max(0, Math.min(finiteNumber(settings.threshold, 0.5), 1)),
          invert: settings.invert === true,
          reliefHeightMm: finiteNumber(settings.reliefHeightMm, 3),
          minThicknessMm: finiteNumber(settings.minThicknessMm, 1),
          resolution: Math.max(32, Math.min(finiteNumber(settings.resolution, 200), 512)),
          smoothingLevel: Math.max(0, Math.min(finiteNumber(settings.smoothingLevel, 1), 5)),
        },
        extrudeMm: finiteNumber(raw.extrudeMm, 3),
        combine,
        bevel: sanitizeBevel(raw.bevel),
      };
    }
    case "importedMesh": {
      const meshId =
        typeof raw.meshId === "string" ? meshIdMap.get(raw.meshId) : undefined;
      if (!meshId) {
        warningsHe.push(`שכבת רשת "${common.name}" ללא נתוני גוף דולגה`);
        return null;
      }
      const provenance = isRecord(raw.provenance) ? raw.provenance : {};
      const originalMeshId =
        typeof raw.originalMeshId === "string"
          ? (meshIdMap.get(raw.originalMeshId) ?? null)
          : null;
      return {
        ...common,
        type: "importedMesh",
        meshId,
        provenance: {
          kind: "stlImport",
          fileName: boundedString(provenance.fileName, "", 200) || undefined,
          descriptionHe: boundedString(provenance.descriptionHe, "", 300) || undefined,
        },
        originalMeshId,
        combine,
      };
    }
    case "hole":
      return {
        ...common,
        type: "hole",
        diameterMm: finiteNumber(raw.diameterMm, 4),
        depthMode: raw.depthMode === "blind" ? "blind" : "through",
        depthMm: finiteNumber(raw.depthMm, 3),
      };
    default:
      return null;
  }
}

function sanitizeMaterialSlots(value: unknown): MaterialSlot[] {
  const fallback: MaterialSlot[] = [
    { id: "slot1", nameHe: "צבע ראשי", colorHex: "#2f6feb" },
    { id: "slot2", nameHe: "צבע משני", colorHex: "#f0f4fa" },
    { id: "slot3", nameHe: "צבע שלישי", colorHex: "#e0483e" },
  ];
  if (!Array.isArray(value) || value.length === 0) return fallback;
  const slots: MaterialSlot[] = [];
  for (const raw of value.slice(0, 8)) {
    if (!isRecord(raw)) continue;
    const colorHex = boundedString(raw.colorHex, "#2f6feb", 9);
    slots.push({
      id: boundedString(raw.id, `slot${slots.length + 1}`, 40),
      nameHe: boundedString(raw.nameHe, `צבע ${slots.length + 1}`, 60),
      colorHex: /^#[0-9a-fA-F]{3,8}$/.test(colorHex) ? colorHex : "#2f6feb",
    });
  }
  return slots.length > 0 ? slots : fallback;
}

/** Hook for future schema migrations (v3 is the first portable schema). */
function migrateRaw(raw: Record<string, unknown>): Record<string, unknown> {
  return raw;
}

/** Parse and validate a design file; registers meshes in the session store. */
export function importDesignFile(jsonText: string): DesignFileImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new DesignFileError("הקובץ אינו קובץ עיצוב תקין (JSON פגום)");
  }
  if (!isRecord(raw) || raw.format !== "formadesign") {
    throw new DesignFileError("הקובץ אינו קובץ עיצוב של האפליקציה");
  }
  const version = finiteNumber(raw.schemaVersion, 0);
  if (version > DESIGN_SCHEMA_VERSION) {
    throw new DesignFileError(
      `קובץ העיצוב נוצר בגרסה חדשה יותר (סכימה ${version}) — עדכנו את האפליקציה`
    );
  }
  if (version < DESIGN_SCHEMA_VERSION) {
    // v3 is the first portable schema; anything lower is unknown.
    throw new DesignFileError("גרסת קובץ העיצוב אינה נתמכת");
  }
  const migrated = migrateRaw(raw);

  const warningsHe: string[] = [];

  // Meshes first (layers reference them through the remap table).
  const meshIdMap = new Map<string, string>();
  let totalTriangles = 0;
  let totalBytes = 0;
  if (Array.isArray(migrated.meshes)) {
    for (const rawMesh of migrated.meshes) {
      if (!isRecord(rawMesh)) continue;
      if (
        typeof rawMesh.id !== "string" ||
        typeof rawMesh.positions !== "string" ||
        typeof rawMesh.indices !== "string"
      ) {
        warningsHe.push("רשומת רשת פגומה דולגה");
        continue;
      }
      totalBytes += rawMesh.positions.length + rawMesh.indices.length;
      if (totalBytes > MAX_MESH_BYTES) {
        throw new DesignFileError("קובץ העיצוב גדול מדי לטעינה בדפדפן");
      }
      try {
        const mesh = decodeMeshData({
          positions: rawMesh.positions,
          indices: rawMesh.indices,
        });
        totalTriangles += mesh.indices.length / 3;
        meshIdMap.set(rawMesh.id, storeMesh(mesh));
      } catch {
        warningsHe.push("נתוני רשת פגומים דולגו — ייתכן שחלק מהשכבות יחסרו");
      }
    }
  }
  if (totalTriangles > WARN_TOTAL_TRIANGLES) {
    warningsHe.push("הקובץ מכיל רשתות גדולות מאוד — ביצועי העריכה עלולים להיות איטיים");
  }

  const rawDoc = isRecord(migrated.document) ? migrated.document : null;
  if (!rawDoc) {
    throw new DesignFileError("קובץ העיצוב חסר את גוף המסמך");
  }

  const rawLayers = Array.isArray(rawDoc.layers) ? rawDoc.layers : [];
  if (rawLayers.length > 200) {
    throw new DesignFileError("קובץ העיצוב מכיל יותר מדי שכבות (מקסימום 200)");
  }
  const layers: DesignLayer[] = [];
  for (const rawLayer of rawLayers) {
    const layer = sanitizeLayer(rawLayer, meshIdMap, warningsHe);
    if (layer) layers.push(layer);
  }

  const baseMode: BaseMode = rawDoc.baseMode === "withBase" ? "withBase" : "baseless";

  const custom = isRecord(rawDoc.customPrintability) ? rawDoc.customPrintability : null;
  const document: DesignDocument = {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    baseMode,
    layers,
    materialSlots: sanitizeMaterialSlots(rawDoc.materialSlots),
    printerProfileId: boundedString(rawDoc.printerProfileId, "genericFdm220", 60),
    printabilityProfileId: boundedString(rawDoc.printabilityProfileId, "fdmPla", 60),
    customPrintability: custom
      ? {
          minWallMm: custom.minWallMm !== undefined ? finiteNumber(custom.minWallMm, 0.8) : undefined,
          minUnsupportedWallMm:
            custom.minUnsupportedWallMm !== undefined
              ? finiteNumber(custom.minUnsupportedWallMm, 1.2)
              : undefined,
          minFeatureMm:
            custom.minFeatureMm !== undefined ? finiteNumber(custom.minFeatureMm, 0.6) : undefined,
          minHoleDiameterMm:
            custom.minHoleDiameterMm !== undefined
              ? finiteNumber(custom.minHoleDiameterMm, 1.5)
              : undefined,
          clearanceMm:
            custom.clearanceMm !== undefined ? finiteNumber(custom.clearanceMm, 0.2) : undefined,
          maxOverhangDeg:
            custom.maxOverhangDeg !== undefined ? finiteNumber(custom.maxOverhangDeg, 50) : undefined,
          nozzleDiameterMm:
            custom.nozzleDiameterMm !== undefined
              ? finiteNumber(custom.nozzleDiameterMm, 0.4)
              : undefined,
          layerHeightMm:
            custom.layerHeightMm !== undefined ? finiteNumber(custom.layerHeightMm, 0.2) : undefined,
        }
      : null,
    usageProfileId:
      typeof rawDoc.usageProfileId === "string"
        ? boundedString(rawDoc.usageProfileId, "", 60) || null
        : null,
    templateId:
      typeof rawDoc.templateId === "string"
        ? boundedString(rawDoc.templateId, "", 60) || null
        : null,
  };

  if (document.layers.length === 0) {
    warningsHe.push("קובץ העיצוב לא הכיל שכבות תקינות");
  }

  return { document, warningsHe };
}
