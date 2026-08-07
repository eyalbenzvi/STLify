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
  CalibrationSettings,
  DesignDocument,
  DesignLayer,
  FacePaint,
  MaterialSlot,
  PortableDesignFile,
  PortableMesh,
  PrimitiveKind,
  SketchEntity,
  StoredContour,
  Transform3D,
} from "@/types/design";
import {
  DESIGN_SCHEMA_VERSION,
  defaultPrimitive,
  identityTransform,
  newId,
} from "@/types/design";
import { PRINTER_PROFILES, type PrinterProfile } from "@/types/profiles";
import type { Modifier, ModifierKind } from "@/lib/geometry/modifiers";
import { defaultModifier } from "@/lib/geometry/modifiers";
import type { ParameterDefinition } from "@/lib/geometry/expression";
import { decodeMeshData, encodeMeshData } from "@/lib/geometry/meshData";
import { getMesh, storeMesh } from "@/lib/geometry/meshStore";

export const DESIGN_FILE_EXTENSION = ".formadesign.json";
const APP_VERSION = "3.0.0";
/** Mesh payload cap inside a design file (base64-decoded bytes). */
const MAX_MESH_BYTES = 120 * 1024 * 1024;
/** Warn when embedded meshes exceed this many triangles in total. */
const WARN_TOTAL_TRIANGLES = 800_000;
/** Cap on painted-region bookkeeping in one file. */
const MAX_PAINT_REGIONS = 16;
const MAX_PAINT_TRIANGLES = 2_000_000;

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

/** A positive linear dimension, bounded to something a printer could make. */
function clampSize(value: unknown, fallback: number): number {
  const n = finiteNumber(value, fallback);
  return Math.max(0.001, Math.min(n, 5000));
}

/** Cap on total sketch points, mirroring the contour limit. */
const MAX_SKETCH_POINTS = 100_000;

function sanitizeSketchPoints(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  const points: [number, number][] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const x = Number(raw[0]);
    const y = Number(raw[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push([x, y]);
    if (points.length > MAX_SKETCH_POINTS) break;
  }
  return points;
}

function sanitizeSketchEntities(value: unknown, warningsHe: string[]): SketchEntity[] {
  if (!Array.isArray(value)) return [];
  const entities: SketchEntity[] = [];
  let skipped = 0;
  for (const raw of value) {
    if (!isRecord(raw)) {
      skipped++;
      continue;
    }
    switch (raw.kind) {
      case "polyline":
      case "bezier": {
        const points = sanitizeSketchPoints(raw.points);
        if (points.length < 2) {
          skipped++;
          continue;
        }
        entities.push({
          kind: raw.kind,
          points,
          closed: raw.closed === true,
          strokeWidthMm: Math.max(0.01, Math.min(finiteNumber(raw.strokeWidthMm, 1), 100)),
        });
        break;
      }
      case "rectangle":
        entities.push({
          kind: "rectangle",
          x: finiteNumber(raw.x, 0),
          y: finiteNumber(raw.y, 0),
          widthMm: clampSize(raw.widthMm, 20),
          heightMm: clampSize(raw.heightMm, 20),
          cornerRadiusMm: Math.max(0, Math.min(finiteNumber(raw.cornerRadiusMm, 0), 5000)),
          rotationDeg: finiteNumber(raw.rotationDeg, 0),
        });
        break;
      case "circle":
        entities.push({
          kind: "circle",
          x: finiteNumber(raw.x, 0),
          y: finiteNumber(raw.y, 0),
          radiusMm: clampSize(raw.radiusMm, 10),
        });
        break;
      case "ellipse":
        entities.push({
          kind: "ellipse",
          x: finiteNumber(raw.x, 0),
          y: finiteNumber(raw.y, 0),
          radiusXMm: clampSize(raw.radiusXMm, 10),
          radiusYMm: clampSize(raw.radiusYMm, 6),
          rotationDeg: finiteNumber(raw.rotationDeg, 0),
        });
        break;
      case "polygon":
        entities.push({
          kind: "polygon",
          x: finiteNumber(raw.x, 0),
          y: finiteNumber(raw.y, 0),
          radiusMm: clampSize(raw.radiusMm, 10),
          sides: Math.max(3, Math.min(Math.round(finiteNumber(raw.sides, 6)), 256)),
          rotationDeg: finiteNumber(raw.rotationDeg, 0),
        });
        break;
      default:
        skipped++;
    }
  }
  if (skipped > 0) warningsHe.push(`${skipped} ישויות סקיצה לא מוכרות דולגו`);
  return entities;
}

function sanitizePivot(value: unknown): { x: number; y: number; z: number } {
  if (!isRecord(value)) return { x: 0, y: 0, z: 0 };
  return {
    x: finiteNumber(value.x, 0),
    y: finiteNumber(value.y, 0),
    z: finiteNumber(value.z, 0),
  };
}

/** Expressions are plain strings; they are parsed, never executed. */
function sanitizeBindings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [field, expression] of Object.entries(value)) {
    if (typeof expression !== "string") continue;
    if (count++ >= 64) break;
    out[boundedString(field, "", 64)] = boundedString(expression, "", 256);
  }
  return out;
}

const MODIFIER_KINDS = new Set<ModifierKind>([
  "fillet",
  "shell",
  "twist",
  "taper",
  "bend",
  "stretch",
  "lattice",
  "remesh",
  "simplify",
  "smooth",
]);

function sanitizeModifiers(value: unknown): Modifier[] {
  if (!Array.isArray(value)) return [];
  const out: Modifier[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const kind = String(raw.kind) as ModifierKind;
    if (!MODIFIER_KINDS.has(kind)) continue;
    if (out.length >= 32) break;
    // Start from the defaults, then overwrite with whatever the file
    // supplied — an unknown or missing field keeps a usable value instead of
    // producing NaN geometry.
    const base = defaultModifier(kind, newId("mod")) as Modifier & Record<string, unknown>;
    base.enabled = raw.enabled !== false;
    for (const [field, current] of Object.entries(base)) {
      if (field === "id" || field === "kind" || field === "enabled") continue;
      const incoming = raw[field];
      if (typeof current === "number" && typeof incoming === "number") {
        base[field] = finiteNumber(incoming, current);
      } else if (typeof current === "string" && typeof incoming === "string") {
        base[field] = boundedString(incoming, current, 32);
      }
    }
    out.push(base);
  }
  return out;
}

function sanitizeParameters(value: unknown, warningsHe: string[]): ParameterDefinition[] {
  if (!Array.isArray(value)) return [];
  const out: ParameterDefinition[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.name !== "string") {
      skipped++;
      continue;
    }
    const name = boundedString(raw.name, "", 64).trim();
    // Names must be usable as identifiers in an expression.
    if (!/^[A-Za-z_\u0590-\u05FF][A-Za-z0-9_\u0590-\u05FF]*$/.test(name) || seen.has(name)) {
      skipped++;
      continue;
    }
    seen.add(name);
    out.push({
      name,
      value: finiteNumber(raw.value, 0),
      expression: boundedString(raw.expression, "", 256),
      noteHe: boundedString(raw.noteHe, "", 200),
    });
    if (out.length >= 128) break;
  }
  if (skipped > 0) warningsHe.push(`${skipped} פרמטרים לא תקינים דולגו`);
  return out;
}

function sanitizeBevel(value: unknown): { enabled: boolean; sizeMm: number; segments: number } {
  if (!isRecord(value)) return { enabled: false, sizeMm: 0.6, segments: 4 };
  return {
    enabled: value.enabled === true,
    sizeMm: Math.max(0, Math.min(finiteNumber(value.sizeMm, 0.6), 20)),
    segments: Math.max(2, Math.min(Math.round(finiteNumber(value.segments, 4)), 8)),
  };
}

const LAYER_TYPES = new Set([
  "base",
  "text",
  "svg",
  "imageRelief",
  "importedMesh",
  "primitive",
  "sketch",
  "hole",
]);
const PRIMITIVE_KINDS = new Set([
  "box",
  "cylinder",
  "sphere",
  "cone",
  "torus",
  "wedge",
  "tube",
]);
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
    // parentId is remapped after ALL layers are sanitized: ids are freshly
    // generated here, so the original parent reference is meaningless until
    // the whole id map exists. sanitizeDocument does the second pass.
    parentId: typeof raw.parentId === "string" ? raw.parentId : null,
    pivot: sanitizePivot(raw.pivot),
    modifiers: sanitizeModifiers(raw.modifiers),
    bindings: sanitizeBindings(raw.bindings),
    name: boundedString(raw.name, "שכבה", 120),
    visible: raw.visible !== false,
    locked: raw.locked === true,
    materialSlotId: boundedString(raw.materialSlotId, "slot1", 40),
    transform: sanitizeTransform(raw.transform),
    previewOpacity: Math.max(0.05, Math.min(finiteNumber(raw.previewOpacity, 1), 1)),
    facePaint: sanitizeFacePaint(raw.facePaint),
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
    case "primitive": {
      const kind = PRIMITIVE_KINDS.has(String(raw.kind))
        ? (String(raw.kind) as PrimitiveKind)
        : "box";
      const defaults = defaultPrimitive(kind);
      return {
        ...common,
        type: "primitive",
        kind,
        widthMm: clampSize(raw.widthMm, defaults.widthMm),
        depthMm: clampSize(raw.depthMm, defaults.depthMm),
        heightMm: clampSize(raw.heightMm, defaults.heightMm),
        radiusMm: clampSize(raw.radiusMm, defaults.radiusMm),
        radius2Mm: Math.max(0, Math.min(finiteNumber(raw.radius2Mm, defaults.radius2Mm), 5000)),
        segments: Math.max(3, Math.min(Math.round(finiteNumber(raw.segments, defaults.segments)), 256)),
        combine,
      };
    }
    case "sketch":
      return {
        ...common,
        type: "sketch",
        entities: sanitizeSketchEntities(raw.entities, warningsHe),
        extrudeMm: finiteNumber(raw.extrudeMm, 3),
        combine,
        bevel: sanitizeBevel(raw.bevel),
      };
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

/**
 * Painted regions.
 *
 * Every entry carries the triangle count of the body it was painted on, so a
 * file whose geometry no longer matches simply loses the paint at build time
 * rather than colouring random faces. Malformed indices are dropped here;
 * indices that merely point past the body are handled later, by the same
 * fingerprint check.
 */
function sanitizeFacePaint(value: unknown): FacePaint[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  // One entry per slot, merged: two entries naming the same material would
  // cut the body twice at export and collide as React keys in the overlay.
  const bySlot = new Map<string, FacePaint>();
  let totalIndices = 0;
  for (const raw of value.slice(0, MAX_PAINT_REGIONS)) {
    if (!isRecord(raw) || !Array.isArray(raw.triangles)) continue;
    const meshTriangleCount = Math.max(
      0,
      Math.round(finiteNumber(raw.meshTriangleCount, 0))
    );
    // Without a fingerprint the indices cannot be checked against anything,
    // and an absurd one is a way to smuggle in a huge allocation.
    if (meshTriangleCount === 0 || meshTriangleCount > MAX_PAINT_TRIANGLES) continue;
    const slotId = boundedString(raw.materialSlotId, "slot1", 40);
    const entry = bySlot.get(slotId);
    const seen = new Set<number>(entry?.triangles ?? []);
    const triangles: number[] = entry ? [...entry.triangles] : [];
    for (const value of raw.triangles) {
      const index = typeof value === "number" ? Math.round(value) : NaN;
      if (!Number.isFinite(index) || index < 0 || index >= meshTriangleCount) continue;
      if (seen.has(index)) continue;
      if (++totalIndices > MAX_PAINT_TRIANGLES) {
        throw new DesignFileError("קובץ העיצוב מכיל כמות חריגה של סימוני צבע");
      }
      seen.add(index);
      triangles.push(index);
    }
    if (triangles.length === 0) continue;
    const depthMm = Math.max(0.05, Math.min(finiteNumber(raw.depthMm, 0.8), 100));
    bySlot.set(slotId, {
      materialSlotId: slotId,
      triangles: triangles.sort((a, b) => a - b),
      meshTriangleCount,
      depthMm: entry ? Math.max(entry.depthMm, depthMm) : depthMm,
    });
  }
  return bySlot.size > 0 ? [...bySlot.values()] : undefined;
}

/** Measured printer behaviour. Absent means "not calibrated", not "zero". */
function sanitizeCalibration(value: unknown): CalibrationSettings | undefined {
  if (!isRecord(value)) return undefined;
  // An empty object must NOT materialise a calibration: doing so silently
  // switches the feature on at its defaults, and a calibrated document
  // enlarges every hole cutter. Absence has to survive the round trip.
  const known = [
    "measuredClearanceMm",
    "holeCompensationMm",
    "elephantFootCompensationMm",
    "elephantFootHeightMm",
  ];
  if (!known.some((key) => typeof value[key] === "number")) return undefined;
  return {
    measuredClearanceMm: Math.max(0, Math.min(finiteNumber(value.measuredClearanceMm, 0.2), 5)),
    holeCompensationMm: Math.max(0, Math.min(finiteNumber(value.holeCompensationMm, 0), 5)),
    elephantFootCompensationMm: Math.max(
      0,
      Math.min(finiteNumber(value.elephantFootCompensationMm, 0), 5)
    ),
    elephantFootHeightMm: Math.max(
      0.05,
      Math.min(finiteNumber(value.elephantFootHeightMm, 0.6), 20)
    ),
  };
}

/**
 * User-defined printers. They travel inside the design so a file opened on
 * another machine still checks against the machine it was made for.
 */
function sanitizeCustomPrinters(value: unknown): PrinterProfile[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: PrinterProfile[] = [];
  const taken = new Set(PRINTER_PROFILES.map((p) => p.id));
  for (const raw of value.slice(0, 20)) {
    if (!isRecord(raw)) continue;
    const volume = isRecord(raw.buildVolumeMm) ? raw.buildVolumeMm : {};
    // Custom printers are looked up BEFORE the built-ins, so a file claiming
    // id "genericFdm220" would quietly redefine a stock profile — including
    // shrinking its build volume to nothing.
    let id = boundedString(raw.id, `custom_${out.length + 1}`, 60);
    while (taken.has(id)) id = `custom_${id}`;
    taken.add(id);
    out.push({
      id,
      nameHe: boundedString(raw.nameHe, `מדפסת ${out.length + 1}`, 80),
      technology: raw.technology === "sla" ? "sla" : "fdm",
      buildVolumeMm: {
        x: Math.max(1, Math.min(finiteNumber(volume.x, 220), 5000)),
        y: Math.max(1, Math.min(finiteNumber(volume.y, 220), 5000)),
        z: Math.max(1, Math.min(finiteNumber(volume.z, 250), 5000)),
      },
      // A resin printer has no nozzle, and clamping null to 0.4 made the
      // lattice check warn about extrusion width on an SLA machine.
      nozzleDiameterMm:
        raw.technology === "sla" && raw.nozzleDiameterMm == null
          ? null
          : Math.max(0.05, Math.min(finiteNumber(raw.nozzleDiameterMm, 0.4), 5)),
      defaultLayerHeightMm: Math.max(
        0.01,
        Math.min(finiteNumber(raw.defaultLayerHeightMm, 0.2), 2)
      ),
    });
  }
  return out.length > 0 ? out : undefined;
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
  /** Original file id -> the fresh id we generated for it. */
  const layerIdMap = new Map<string, string>();
  for (const rawLayer of rawLayers) {
    const layer = sanitizeLayer(rawLayer, meshIdMap, warningsHe);
    if (!layer) continue;
    if (isRecord(rawLayer) && typeof rawLayer.id === "string") {
      layerIdMap.set(rawLayer.id, layer.id);
    }
    layers.push(layer);
  }

  // Second pass: remap parent references onto the freshly generated ids, and
  // drop any that dangle or form a cycle. A cycle would make the world-matrix
  // walk loop, so it is refused here rather than defended against forever.
  const idsInDocument = new Set(layers.map((l) => l.id));
  let droppedParents = 0;
  for (const layer of layers) {
    if (!layer.parentId) continue;
    const mapped = layerIdMap.get(layer.parentId);
    if (!mapped || !idsInDocument.has(mapped) || mapped === layer.id) {
      layer.parentId = null;
      droppedParents++;
      continue;
    }
    layer.parentId = mapped;
  }
  const byId = new Map(layers.map((l) => [l.id, l]));
  for (const layer of layers) {
    const seen = new Set<string>([layer.id]);
    let cursor = layer.parentId ? byId.get(layer.parentId) : undefined;
    while (cursor) {
      if (seen.has(cursor.id)) {
        layer.parentId = null;
        droppedParents++;
        break;
      }
      seen.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }
  if (droppedParents > 0) {
    warningsHe.push(`${droppedParents} קישורי הורה לא תקינים נותקו`);
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
    parameters: sanitizeParameters(rawDoc.parameters, warningsHe),
    calibration: sanitizeCalibration(rawDoc.calibration),
    customPrinters: sanitizeCustomPrinters(rawDoc.customPrinters),
  };

  if (document.layers.length === 0) {
    warningsHe.push("קובץ העיצוב לא הכיל שכבות תקינות");
  }

  return { document, warningsHe };
}
