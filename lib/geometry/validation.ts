/**
 * Pure parameter-validation functions for the geometry pipeline.
 *
 * This module intentionally has NO three.js (or other heavy) imports so it
 * can be unit-tested in isolation and reused on both client and server.
 */

import {
  DEFAULT_LIMITS,
  PARAM_RANGES,
  type DesignParams,
  type PrintabilityLimits,
  type ValidationIssue,
  type ValidationResult,
} from "./types";

/** Clamp a number into [min, max]; returns fallback for non-finite input. */
export function clampNumber(
  value: number,
  min: number,
  max: number,
  fallback: number = min
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Parse user text into a finite number, or return null when invalid. */
export function parseNumericInput(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Maximum corner radius that keeps a rounded rectangle well-formed. */
export function maxCornerRadius(widthMm: number, heightMm: number): number {
  return Math.max(0, Math.min(widthMm, heightMm) / 2 - 0.01);
}

/** True when the string contains at least one non-whitespace character. */
export function hasVisibleText(content: string): boolean {
  return content.trim().length > 0;
}

/**
 * Validate a full set of design parameters against hard ranges and
 * printability limits. Returns errors (blocking) and warnings (advisory).
 */
export function validateDesignParams(
  params: DesignParams,
  limits: PrintabilityLimits = DEFAULT_LIMITS
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const { base, text, hole } = params;

  const error = (code: string, message: string) =>
    issues.push({ code, severity: "error", message });
  const warning = (code: string, message: string) =>
    issues.push({ code, severity: "warning", message });

  // --- Base plate ---
  const r = PARAM_RANGES;
  if (!within(base.widthMm, r.baseWidthMm)) {
    error(
      "base/width-range",
      `רוחב הבסיס חייב להיות בין ${r.baseWidthMm.min} ל-${r.baseWidthMm.max} מ״מ`
    );
  }
  if (!within(base.heightMm, r.baseHeightMm)) {
    error(
      "base/height-range",
      `גובה הבסיס חייב להיות בין ${r.baseHeightMm.min} ל-${r.baseHeightMm.max} מ״מ`
    );
  }
  if (!within(base.thicknessMm, r.baseThicknessMm)) {
    error(
      "base/thickness-range",
      `עובי הבסיס חייב להיות בין ${r.baseThicknessMm.min} ל-${r.baseThicknessMm.max} מ״מ`
    );
  }
  if (base.shape === "roundedRectangle") {
    if (base.cornerRadiusMm < 0) {
      error("base/corner-negative", "רדיוס הפינה אינו יכול להיות שלילי");
    } else if (base.cornerRadiusMm > maxCornerRadius(base.widthMm, base.heightMm)) {
      error(
        "base/corner-too-large",
        "רדיוס הפינה גדול מדי ביחס למידות הבסיס"
      );
    }
  }
  if (base.thicknessMm < limits.minWallMm && within(base.thicknessMm, r.baseThicknessMm)) {
    warning(
      "base/thin-wall",
      `עובי הבסיס (${base.thicknessMm} מ״מ) נמוך מהמינימום המומלץ להדפסה (${limits.minWallMm} מ״מ)`
    );
  }

  // --- Text ---
  const textVisible = hasVisibleText(text.content);
  if (text.content.length > r.maxTextLength) {
    error("text/too-long", `אורך הטקסט מוגבל ל-${r.maxTextLength} תווים`);
  }
  if (textVisible) {
    if (!within(text.sizeMm, r.textSizeMm)) {
      error(
        "text/size-range",
        `גודל הטקסט חייב להיות בין ${r.textSizeMm.min} ל-${r.textSizeMm.max} מ״מ`
      );
    } else if (text.sizeMm < limits.minTextSizeMm) {
      warning(
        "text/small-size",
        `טקסט בגודל ${text.sizeMm} מ״מ עלול לצאת לא קריא בהדפסה (מומלץ ${limits.minTextSizeMm} מ״מ ומעלה)`
      );
    }
    if (!within(text.depthMm, r.textDepthMm)) {
      error(
        "text/depth-range",
        `עומק/גובה הטקסט חייב להיות בין ${r.textDepthMm.min} ל-${r.textDepthMm.max} מ״מ`
      );
    } else if (text.depthMm < limits.minReliefDepthMm) {
      warning(
        "text/shallow-relief",
        `עומק תבליט של ${text.depthMm} מ״מ נמוך מהמינימום המומלץ (${limits.minReliefDepthMm} מ״מ)`
      );
    }
    if (text.mode === "engraved") {
      const floor = base.thicknessMm - text.depthMm;
      if (floor <= 0) {
        error(
          "text/engrave-through",
          "עומק החריטה גדול מעובי הבסיס — הטקסט יחורר את הלוחית"
        );
      } else if (floor < limits.minEngraveFloorMm) {
        warning(
          "text/engrave-floor",
          `נשארת רצפה של ${round2(floor)} מ״מ בלבד מתחת לחריטה (מומלץ לפחות ${limits.minEngraveFloorMm} מ״מ)`
        );
      }
    }
    if (!within(text.offsetXMm, r.textOffsetMm) || !within(text.offsetYMm, r.textOffsetMm)) {
      error("text/offset-range", "הזזת הטקסט מחוץ לטווח המותר");
    }
    if (!within(text.lineSpacing, r.lineSpacing)) {
      error("text/line-spacing-range", "מרווח השורות מחוץ לטווח המותר");
    }
  } else {
    warning("text/empty", "לא הוזן טקסט — ייווצר בסיס בלבד");
  }

  // --- Keychain hole ---
  if (hole.enabled) {
    if (!within(hole.diameterMm, r.holeDiameterMm)) {
      error(
        "hole/diameter-range",
        `קוטר החור חייב להיות בין ${r.holeDiameterMm.min} ל-${r.holeDiameterMm.max} מ״מ`
      );
    }
    if (!within(hole.edgeMarginMm, r.holeEdgeMarginMm)) {
      error("hole/margin-range", "מרחק החור מהשפה מחוץ לטווח המותר");
    }
    const alongAxis = hole.position === "top" ? base.heightMm : base.widthMm;
    const acrossAxis = hole.position === "top" ? base.widthMm : base.heightMm;
    const wall = hole.edgeMarginMm - hole.diameterMm / 2;
    if (wall < 0) {
      error("hole/outside", "החור חורג מגבולות הבסיס");
    } else if (wall < limits.minWallMm) {
      warning(
        "hole/thin-wall",
        `הדופן סביב החור (${round2(wall)} מ״מ) דקה מהמינימום המומלץ (${limits.minWallMm} מ״מ)`
      );
    }
    if (hole.edgeMarginMm + hole.diameterMm / 2 > alongAxis / 2) {
      error("hole/too-deep", "החור קרוב מדי למרכז הבסיס — הקטינו את המרחק מהשפה");
    }
    if (hole.diameterMm + 2 * limits.minWallMm > acrossAxis) {
      error("hole/too-wide", "קוטר החור גדול מדי ביחס לבסיס");
    }
  }

  const ok = !issues.some((issue) => issue.severity === "error");
  return { ok, issues };
}

function within(value: number, range: { min: number; max: number }): boolean {
  return Number.isFinite(value) && value >= range.min && value <= range.max;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
