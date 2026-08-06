/**
 * Shared primitive types for the geometry pipeline. All linear dimensions
 * are in millimetres (mm) — the internal and the displayed unit of the
 * application. The layer/document model lives in types/design.ts.
 */

export type TextMode = "raised" | "engraved";

export type TextAlign = "right" | "center" | "left";

export type FontId = "alef" | "davidLibre" | "suezOne" | "varelaRound";

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
