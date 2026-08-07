/**
 * V3 domain model: layer-based design documents.
 *
 * Every linear value is in millimetres; every angle is in degrees.
 * Documents are plain JSON-serializable values (no class instances, no
 * typed arrays) so undo/redo snapshots and the portable design file can
 * share the exact same representation. Heavy mesh payloads live in the
 * session mesh store (lib/geometry/meshStore.ts) and are referenced from
 * layers by `meshId`.
 */

import type { FontId, TextAlign } from "@/lib/geometry/types";

/** Schema version written into portable design files. */
export const DESIGN_SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/**
 * Full TRS transform. Matrix composition matches three.js:
 * M = T · R(euler XYZ, degrees) · S, i.e. scale first, then rotate, then move.
 */
export interface Transform3D {
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

/** Gizmo/numeric-entry coordinate space. World = build-plate axes. */
export type TransformSpace = "world" | "local";

export function identityTransform(): Transform3D {
  return {
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
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export type LayerType =
  | "base"
  | "text"
  | "svg"
  | "imageRelief"
  | "importedMesh"
  | "primitive"
  | "sketch"
  | "hole";

/**
 * How a shape layer participates in the printable result while in
 * "withBase" mode. In "baseless" mode every non-hole layer is standalone.
 * "inlay" = flush insert: the base gets a clearance pocket and the layer
 * becomes a separate printable part (multi-colour inlays).
 */
export type CombineMode = "raised" | "engraved" | "inlay" | "standalone";

/** Optional bevel for extruded (text/SVG/silhouette) layers. */
export interface BevelSettings {
  enabled: boolean;
  /** Bevel inset/height in mm. */
  sizeMm: number;
  /** Number of offset steps used to approximate the chamfer (2–8). */
  segments: number;
}

export interface LayerCommon {
  /** Stable unique id (never re-used within a document). */
  id: string;
  type: LayerType;
  /** User-facing layer name (free text, usually Hebrew). */
  name: string;
  visible: boolean;
  locked: boolean;
  /** Id of the material slot used for preview + multi-part export colors. */
  materialSlotId: string;
  transform: Transform3D;
  /** Preview-only opacity (1 = opaque). Never affects exported geometry. */
  previewOpacity: number;
}

/** The single base plate (only meaningful in "withBase" mode). */
export interface BaseLayer extends LayerCommon {
  type: "base";
  shape: "rectangle" | "roundedRectangle" | "circle";
  /** Plate size along X (for circles: the diameter). */
  widthMm: number;
  heightMm: number;
  thicknessMm: number;
  cornerRadiusMm: number;
  /** Raised border ring on the top face (coasters, medals, plaques). */
  rimEnabled: boolean;
  rimWidthMm: number;
  rimHeightMm: number;
}

export interface TextLayer extends LayerCommon {
  type: "text";
  content: string;
  fontId: FontId;
  sizeMm: number;
  bold: boolean;
  align: TextAlign;
  lineSpacing: number;
  /** Extra spacing between glyphs, in mm (0 = font default). */
  letterSpacingMm: number;
  /** Bidi handling: "auto" = simplified bidi reorder, "ltr" = keep order. */
  direction: "auto" | "ltr";
  /** Arc radius for curved (medal-style) text, mm. 0 = straight. */
  curveRadiusMm: number;
  /** Mirror horizontally — required for stamps. */
  mirrored: boolean;
  /** Extrusion depth (raised height / engrave depth / standalone thickness). */
  extrudeMm: number;
  combine: CombineMode;
  bevel: BevelSettings;
}

/**
 * Closed 2D contours in mm, stored inline (JSON-safe). Winding follows the
 * NonZero fill rule: opposite-winding contours are holes.
 */
export type StoredContour = [number, number][];

export interface SvgLayer extends LayerCommon {
  type: "svg";
  /** Original file name, for display. */
  sourceName: string;
  /** Contours in mm, already scaled/centred at import time. */
  contours: StoredContour[];
  extrudeMm: number;
  combine: CombineMode;
  bevel: BevelSettings;
}

export type ImageReliefMode = "silhouette" | "relief";

/**
 * A layer generated from a raster image. Silhouette mode stores threshold
 * contours (extruded live like SVG); relief mode stores the generated closed
 * solid in the mesh store plus the settings used to build it.
 */
export interface ImageReliefLayer extends LayerCommon {
  type: "imageRelief";
  sourceName: string;
  mode: ImageReliefMode;
  /** Silhouette contours (empty in relief mode). */
  contours: StoredContour[];
  /** Mesh-store id of the generated relief solid (null in silhouette mode). */
  meshId: string | null;
  /** Generation settings, kept for display + regeneration via the dialog. */
  settings: {
    targetWidthMm: number;
    /** Silhouette: luminance threshold 0..1. */
    threshold: number;
    invert: boolean;
    /** Relief: total height above the minimum thickness. */
    reliefHeightMm: number;
    /** Closed-body floor thickness (relief) / extrusion depth (silhouette). */
    minThicknessMm: number;
    /** Grid resolution used along the image's larger axis. */
    resolution: number;
    /** Smoothing passes applied to the height field. */
    smoothingLevel: number;
  };
  extrudeMm: number;
  combine: CombineMode;
  bevel: BevelSettings;
}

/** Provenance of an imported/computed mesh layer. */
export interface MeshProvenance {
  kind:
    | "stlImport"
    | "booleanResult"
    | "cutResult"
    | "splitPart"
    | "hollowResult"
    | "thickenResult"
    | "smoothResult"
    | "simplifyResult"
    | "connectorResult"
    | "imageRelief";
  /** Original file name for stlImport. */
  fileName?: string;
  /** Hebrew description of the producing operation. */
  descriptionHe?: string;
  /** Ids of the source layers for derived results. */
  sourceLayerIds?: string[];
}

export interface ImportedMeshLayer extends LayerCommon {
  type: "importedMesh";
  /** Id of the mesh payload in the session mesh store. */
  meshId: string;
  provenance: MeshProvenance;
  /**
   * Mesh-store id of the untouched original (kept until the user explicitly
   * replaces it via a destructive operation with "replace" semantics).
   */
  originalMeshId: string | null;
  combine: CombineMode;
}

// ---------------------------------------------------------------------------
// Primitive solids
// ---------------------------------------------------------------------------

export type PrimitiveKind =
  | "box"
  | "cylinder"
  | "sphere"
  | "cone"
  | "torus"
  | "wedge"
  | "tube";

/**
 * A parametric primitive solid. Every kind is built from the same parameter
 * set so the properties panel and the design-file validator stay simple; each
 * kind documents which fields it reads and ignores the rest.
 *
 * All primitives are built centred on the local XY origin with z ∈ [0, height]
 * (spheres and tori are centred on z = 0 and then dropped to sit on z = 0),
 * matching the convention every other layer builder follows.
 */
export interface PrimitiveLayer extends LayerCommon {
  type: "primitive";
  kind: PrimitiveKind;
  /** box, wedge: size along X. */
  widthMm: number;
  /** box, wedge: size along Y. */
  depthMm: number;
  /** box, wedge, cylinder, cone, tube: size along Z. */
  heightMm: number;
  /** cylinder/tube outer, sphere, cone bottom, torus major. */
  radiusMm: number;
  /** cone top, tube inner, torus minor. Ignored by the other kinds. */
  radius2Mm: number;
  /** Facets around the axis for curved kinds. */
  segments: number;
  combine: CombineMode;
}

// ---------------------------------------------------------------------------
// Sketches
// ---------------------------------------------------------------------------

/**
 * A 2D sketch entity, in millimetres, in the sketch layer's local XY plane.
 * Entities are resolved together with the NonZero fill rule, so overlapping
 * shapes merge and an opposite-wound shape cuts a hole — the same rule the
 * kernel already applies to font glyphs and SVG artwork.
 */
export type SketchEntity =
  | {
      kind: "polyline";
      points: [number, number][];
      /** Open polylines are stroked to `strokeWidthMm`; closed ones are filled. */
      closed: boolean;
      strokeWidthMm: number;
    }
  | {
      kind: "rectangle";
      x: number;
      y: number;
      widthMm: number;
      heightMm: number;
      cornerRadiusMm: number;
      rotationDeg: number;
    }
  | { kind: "circle"; x: number; y: number; radiusMm: number }
  | {
      kind: "ellipse";
      x: number;
      y: number;
      radiusXMm: number;
      radiusYMm: number;
      rotationDeg: number;
    }
  | {
      kind: "polygon";
      x: number;
      y: number;
      radiusMm: number;
      sides: number;
      rotationDeg: number;
    }
  | {
      /** A quadratic Bezier chain: [start, control, end, control, end, ...]. */
      kind: "bezier";
      points: [number, number][];
      closed: boolean;
      strokeWidthMm: number;
    };

/** A drawn 2D profile, extruded exactly like an imported SVG. */
export interface SketchLayer extends LayerCommon {
  type: "sketch";
  entities: SketchEntity[];
  extrudeMm: number;
  combine: CombineMode;
  bevel: BevelSettings;
}

/** A cylindrical cut. Direction is the layer's local +Z axis. */
export interface HoleLayer extends LayerCommon {
  type: "hole";
  diameterMm: number;
  /** "through" ignores depthMm and cuts the full body. */
  depthMode: "through" | "blind";
  depthMm: number;
}

export type DesignLayer =
  | BaseLayer
  | TextLayer
  | SvgLayer
  | ImageReliefLayer
  | ImportedMeshLayer
  | PrimitiveLayer
  | SketchLayer
  | HoleLayer;

/** Layers that produce a printable body of their own. */
export type ShapeLayer = Exclude<DesignLayer, HoleLayer>;

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export type BaseMode = "withBase" | "baseless";

export interface MaterialSlot {
  id: string;
  nameHe: string;
  colorHex: string;
}

export interface DesignDocument {
  schemaVersion: typeof DESIGN_SCHEMA_VERSION;
  /** Design mode: with a base plate (V2 behaviour) or independent objects. */
  baseMode: BaseMode;
  layers: DesignLayer[];
  materialSlots: MaterialSlot[];
  printerProfileId: string;
  printabilityProfileId: string;
  /** Non-null when the user customised the printability thresholds. */
  customPrintability: CustomPrintabilityOverrides | null;
  usageProfileId: string | null;
  /** Template that seeded the document (display only). */
  templateId: string | null;
}

/** User-editable overrides on top of a printability profile. */
export interface CustomPrintabilityOverrides {
  minWallMm?: number;
  minUnsupportedWallMm?: number;
  minFeatureMm?: number;
  minHoleDiameterMm?: number;
  clearanceMm?: number;
  maxOverhangDeg?: number;
  nozzleDiameterMm?: number;
  layerHeightMm?: number;
}

// ---------------------------------------------------------------------------
// Operations (parameter records — the geometry work happens in lib/geometry)
// ---------------------------------------------------------------------------

export type BooleanOperationKind = "union" | "difference" | "intersection";

export interface BooleanOperation {
  kind: BooleanOperationKind;
  /** Layer ids in operand order (first = target for difference). */
  layerIds: string[];
  /** What happens to the source layers after a successful operation. */
  sources: "keep" | "hide" | "replace";
}

export type CutPlaneOrientation = "xy" | "xz" | "yz" | "custom";

export interface CutPlaneDefinition {
  orientation: CutPlaneOrientation;
  /** Signed offset from the origin along the plane normal, in mm. */
  offsetMm: number;
  /** Custom-plane rotation (applied to the base orientation), degrees. */
  rotationX: number;
  rotationY: number;
}

export interface SplitOperation {
  layerId: string;
  plane: CutPlaneDefinition;
  keep: "top" | "bottom" | "both";
  /** Caps are inherent to manifold cutting; false trims without closing. */
  cap: boolean;
}

export type ConnectorType = "pin" | "key" | "dovetail" | "magnetPocket";

export interface ConnectorDefinition {
  type: ConnectorType;
  /** Pin/pocket diameter or key/dovetail width, mm. */
  sizeMm: number;
  depthMm: number;
  count: number;
  spacingMm: number;
  /** Radial clearance added to the female side, mm. */
  clearanceMm: number;
  edgeMarginMm: number;
}

export interface HollowSettings {
  wallThicknessMm: number;
  /** Keep a solid floor of this thickness (0 = hollow all the way down). */
  preserveBaseMm: number;
}

export interface DrainHoleDefinition {
  diameterMm: number;
  /** Hole entry point in world mm. */
  position: { x: number; y: number; z: number };
  /** Drill direction (unit-ish vector, world space). */
  direction: { x: number; y: number; z: number };
  depthMm: number;
}

export type SmoothingStrength = "light" | "standard" | "strong";

export interface SmoothSettings {
  strength: SmoothingStrength;
  iterations: number;
  preserveFeatures: boolean;
}

export interface SimplifySettings {
  preset: "draft" | "standard" | "aggressive" | "custom";
  /** Simplification tolerance in mm (edge-collapse epsilon). */
  toleranceMm: number;
}

// ---------------------------------------------------------------------------
// Measurements (editor-only, never exported into geometry)
// ---------------------------------------------------------------------------

export type MeasurementKind = "distance" | "distanceX" | "distanceY" | "distanceZ";

export interface Measurement {
  id: string;
  kind: MeasurementKind;
  a: { x: number; y: number; z: number };
  b: { x: number; y: number; z: number };
  /** Computed value in mm. */
  valueMm: number;
}

// ---------------------------------------------------------------------------
// Validation / analysis results
// ---------------------------------------------------------------------------

export type IssueSeverity = "ok" | "warning" | "critical";

export interface ModelIssue {
  code: string;
  severity: IssueSeverity;
  titleHe: string;
  detailHe: string;
  /** Suggested corrective action, Hebrew. */
  actionHe?: string;
  /** World-space location to highlight, when known. */
  location?: { x: number; y: number; z: number };
}

export interface ModelValidationResult {
  ok: boolean;
  watertight: boolean;
  issues: ModelIssue[];
  triangleCount: number;
  volumeMm3: number;
  surfaceAreaMm2: number;
  dimensionsMm: { x: number; y: number; z: number };
}

export interface RepairResult {
  attempted: boolean;
  succeeded: boolean;
  messageHe: string;
  /** Mesh-store id of the repaired mesh when succeeded. */
  meshId: string | null;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface EditorHistoryState {
  past: HistoryEntry[];
  present: HistoryEntry;
  future: HistoryEntry[];
}

export interface HistoryEntry {
  document: DesignDocument;
  /** Hebrew label of the change that produced this state. */
  labelHe: string;
}

// ---------------------------------------------------------------------------
// Portable design file
// ---------------------------------------------------------------------------

/** A mesh payload serialized into the portable file. */
export interface PortableMesh {
  id: string;
  /** Base64-encoded little-endian Float32 xyz triples. */
  positions: string;
  /** Base64-encoded little-endian Uint32 triangle indices. */
  indices: string;
}

export interface PortableDesignFile {
  format: "formadesign";
  schemaVersion: number;
  createdAt: string;
  appVersion: string;
  document: DesignDocument;
  meshes: PortableMesh[];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface ProductTemplate {
  id: string;
  nameHe: string;
  icon: string;
  /** Builds a fresh document (fresh layer ids) for this template. */
  createDocument: () => DesignDocument;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

/** Generate a stable unique id (session-scoped, collision-safe for imports). */
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}${Math.floor(
    Math.random() * 46656
  ).toString(36)}`;
}

export function isShapeLayer(layer: DesignLayer): layer is ShapeLayer {
  return layer.type !== "hole";
}

/** Layers that are live 2D-contour extrusions (support bevel + combine). */
export function isContourLayer(
  layer: DesignLayer
): layer is TextLayer | SvgLayer | ImageReliefLayer | SketchLayer {
  return (
    layer.type === "text" ||
    layer.type === "svg" ||
    layer.type === "sketch" ||
    (layer.type === "imageRelief" && layer.mode === "silhouette")
  );
}

/** Default parameters for a freshly created primitive of each kind. */
export function defaultPrimitive(kind: PrimitiveKind): Omit<
  PrimitiveLayer,
  keyof LayerCommon | "type"
> {
  const base = {
    kind,
    widthMm: 20,
    depthMm: 20,
    heightMm: 20,
    radiusMm: 10,
    radius2Mm: 5,
    segments: 64,
    combine: "standalone" as CombineMode,
  };
  switch (kind) {
    case "sphere":
      return { ...base, segments: 48 };
    case "torus":
      return { ...base, radiusMm: 15, radius2Mm: 4, segments: 48 };
    case "cone":
      return { ...base, radius2Mm: 0 };
    case "tube":
      return { ...base, radiusMm: 10, radius2Mm: 7 };
    default:
      return base;
  }
}

export function defaultBevel(): BevelSettings {
  return { enabled: false, sizeMm: 0.6, segments: 4 };
}
