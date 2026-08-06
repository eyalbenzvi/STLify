/**
 * Core parameter types for the PrintCraft STL Studio geometry pipeline.
 * All linear dimensions are in millimetres (mm) — the internal and the
 * displayed unit of the application.
 */

export type TemplateId = "namePlate" | "keychain" | "logoPlaque" | "reliefTile";

export type BaseShape = "rectangle" | "roundedRectangle";

export type TextMode = "raised" | "engraved";

export type TextAlign = "right" | "center" | "left";

export type HolePosition = "right" | "left" | "top";

export type FontId = "alef" | "davidLibre" | "suezOne" | "varelaRound";

/** Base plate parameters. The plate lies in the XY plane and extrudes along +Z. */
export interface BaseParams {
  shape: BaseShape;
  /** Plate size along X, in mm. */
  widthMm: number;
  /** Plate size along Y, in mm. */
  heightMm: number;
  /** Plate size along Z (thickness), in mm. */
  thicknessMm: number;
  /** Corner radius in mm; only used when shape === "roundedRectangle". */
  cornerRadiusMm: number;
}

/** Text relief parameters. */
export interface TextParams {
  /** Text content. May contain "\n" for multiple lines. */
  content: string;
  fontId: FontId;
  /** Font em size in mm (approximately the line height of the glyphs). */
  sizeMm: number;
  bold: boolean;
  align: TextAlign;
  mode: TextMode;
  /** Raised height above the plate, or engraved depth into it, in mm. */
  depthMm: number;
  /** Horizontal offset of the text block from the plate centre, in mm. */
  offsetXMm: number;
  /** Vertical offset of the text block from the plate centre, in mm. */
  offsetYMm: number;
  /** Line spacing multiplier for multi-line text (1 = font default). */
  lineSpacing: number;
}

/** Keychain hole parameters. The hole is a through-hole along Z. */
export interface HoleParams {
  enabled: boolean;
  diameterMm: number;
  /** Distance from the hole centre to the nearest plate edge, in mm. */
  edgeMarginMm: number;
  position: HolePosition;
}

/** Full, explicit description of a design. Everything the pipeline needs. */
export interface DesignParams {
  template: TemplateId;
  base: BaseParams;
  text: TextParams;
  hole: HoleParams;
  /** Preview material colour (hex string). Does not affect the exported STL. */
  materialColor: string;
}

/** Printability thresholds used by validation. Configurable in one place. */
export interface PrintabilityLimits {
  /** Minimum wall / floor thickness that is considered safely printable, in mm. */
  minWallMm: number;
  /** Minimum raised-relief height that will survive printing, in mm. */
  minReliefDepthMm: number;
  /** Minimum remaining floor under an engraving, in mm. */
  minEngraveFloorMm: number;
  /** Minimum text em size that keeps strokes printable, in mm. */
  minTextSizeMm: number;
}

export const DEFAULT_LIMITS: PrintabilityLimits = {
  minWallMm: 0.8,
  minReliefDepthMm: 0.4,
  minEngraveFloorMm: 0.6,
  minTextSizeMm: 4,
};

/** Hard parameter ranges (mm) enforced by validation / input clamping. */
export const PARAM_RANGES = {
  baseWidthMm: { min: 10, max: 300 },
  baseHeightMm: { min: 10, max: 300 },
  baseThicknessMm: { min: 1, max: 50 },
  cornerRadiusMm: { min: 0, max: 150 },
  textSizeMm: { min: 2, max: 200 },
  textDepthMm: { min: 0.2, max: 50 },
  textOffsetMm: { min: -150, max: 150 },
  holeDiameterMm: { min: 1, max: 30 },
  holeEdgeMarginMm: { min: 1, max: 50 },
  lineSpacing: { min: 0.8, max: 3 },
  maxTextLength: 120,
} as const;

/** A single issue found during validation. */
export interface ValidationIssue {
  code: string;
  severity: "error" | "warning";
  /** Human-readable message shown in the (Hebrew) UI. */
  message: string;
}

/** Result of validating a set of design parameters. */
export interface ValidationResult {
  /** True when there are no blocking errors (warnings are allowed). */
  ok: boolean;
  issues: ValidationIssue[];
}

/** Statistics about a generated mesh, shown in the validation panel. */
export interface MeshStats {
  triangleCount: number;
  /** Bounding-box dimensions in mm. */
  dimensionsMm: { x: number; y: number; z: number };
  /** True when every edge is shared by exactly two triangles. */
  watertight: boolean;
  openEdgeCount: number;
}
