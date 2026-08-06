/**
 * Parameter-level validation for layer documents (pure, no three.js /
 * kernel imports — unit-tested in isolation). This ports every V2 check
 * (base ranges, text size/depth, engrave floor, hole margins) onto the
 * layer model and adds V3 checks (baseless extrusion thickness, bevel,
 * imported-mesh presence). Geometric analysis (overhangs, wall thickness)
 * lives in lib/geometry/analysis/.
 */

import type {
  BaseLayer,
  DesignDocument,
  DesignLayer,
  HoleLayer,
  ImageReliefLayer,
  SvgLayer,
  TextLayer,
} from "@/types/design";
import { getPrintabilityProfile } from "@/types/profiles";
import { DEFAULT_LIMITS, PARAM_RANGES, type ValidationIssue, type ValidationResult } from "./types";

export { DEFAULT_LIMITS, PARAM_RANGES };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function within(value: number, range: { min: number; max: number }): boolean {
  return Number.isFinite(value) && value >= range.min && value <= range.max;
}

/** Effective printability thresholds for a document (profile + overrides). */
export function effectiveLimits(document: DesignDocument): {
  minWallMm: number;
  minReliefDepthMm: number;
  minEngraveFloorMm: number;
  minTextSizeMm: number;
  minFeatureMm: number;
} {
  const profile = getPrintabilityProfile(document.printabilityProfileId);
  const custom = document.customPrintability;
  const minWallMm = custom?.minWallMm ?? profile.minWallMm;
  const minFeatureMm = custom?.minFeatureMm ?? profile.minFeatureMm;
  return {
    minWallMm,
    minReliefDepthMm: Math.max(0.4, minFeatureMm / 2),
    minEngraveFloorMm: Math.max(0.6, minWallMm * 0.75),
    minTextSizeMm: DEFAULT_LIMITS.minTextSizeMm,
    minFeatureMm,
  };
}

type Limits = ReturnType<typeof effectiveLimits>;

/**
 * Validate an entire document. Errors block the build; warnings are
 * advisory (shown in the validation panel, acknowledged before export).
 */
export function validateDocument(document: DesignDocument): ValidationResult {
  const issues: ValidationIssue[] = [];
  const limits = effectiveLimits(document);
  const base =
    document.baseMode === "withBase"
      ? (document.layers.find((l): l is BaseLayer => l.type === "base") ?? null)
      : null;

  if (document.baseMode === "withBase" && !base) {
    issues.push({
      code: "document/no-base",
      severity: "warning",
      message: "מצב ״עם בסיס״ פעיל אך אין שכבת בסיס — כל שכבה תודפס כגוף עצמאי",
    });
  }

  for (const layer of document.layers) {
    if (!layer.visible) continue;
    switch (layer.type) {
      case "base":
        validateBase(layer, limits, issues);
        break;
      case "text":
        validateText(layer, document, base, limits, issues);
        break;
      case "svg":
      case "imageRelief":
        validateContourish(layer, document, base, limits, issues);
        break;
      case "hole":
        validateHole(layer, base, limits, issues);
        break;
      case "importedMesh":
        break; // geometric checks happen at build/analysis time
    }
    validateTransform(layer, issues);
  }

  const visibleShapes = document.layers.filter((l) => l.visible && l.type !== "hole");
  if (visibleShapes.length === 0) {
    issues.push({
      code: "document/empty",
      severity: "warning",
      message: "אין שכבות גלויות — הוסיפו תוכן כדי ליצור מודל",
    });
  }

  const ok = !issues.some((issue) => issue.severity === "error");
  return { ok, issues };
}

function validateTransform(layer: DesignLayer, issues: ValidationIssue[]): void {
  const t = layer.transform;
  const values = [t.x, t.y, t.z, t.rotationX, t.rotationY, t.rotationZ, t.scaleX, t.scaleY, t.scaleZ];
  if (values.some((v) => !Number.isFinite(v))) {
    issues.push({
      code: "layer/transform-invalid",
      severity: "error",
      message: `לשכבה "${layer.name}" יש ערכי טרנספורמציה לא חוקיים`,
    });
    return;
  }
  if (t.scaleX === 0 || t.scaleY === 0 || t.scaleZ === 0) {
    issues.push({
      code: "layer/scale-zero",
      severity: "error",
      message: `קנה מידה אפס בשכבה "${layer.name}" ייצור גאומטריה שטוחה שאינה ניתנת להדפסה`,
    });
  }
}

function validateBase(layer: BaseLayer, limits: Limits, issues: ValidationIssue[]): void {
  const r = PARAM_RANGES;
  if (!within(layer.widthMm, r.baseWidthMm)) {
    issues.push({
      code: "base/width-range",
      severity: "error",
      message: `רוחב הבסיס חייב להיות בין ${r.baseWidthMm.min} ל-${r.baseWidthMm.max} מ״מ`,
    });
  }
  if (!within(layer.heightMm, r.baseHeightMm)) {
    issues.push({
      code: "base/height-range",
      severity: "error",
      message: `גובה הבסיס חייב להיות בין ${r.baseHeightMm.min} ל-${r.baseHeightMm.max} מ״מ`,
    });
  }
  if (!within(layer.thicknessMm, r.baseThicknessMm)) {
    issues.push({
      code: "base/thickness-range",
      severity: "error",
      message: `עובי הבסיס חייב להיות בין ${r.baseThicknessMm.min} ל-${r.baseThicknessMm.max} מ״מ`,
    });
  } else if (layer.thicknessMm < limits.minWallMm) {
    issues.push({
      code: "base/thin-wall",
      severity: "warning",
      message: `עובי הבסיס (${layer.thicknessMm} מ״מ) נמוך מהמינימום המומלץ להדפסה (${limits.minWallMm} מ״מ)`,
    });
  }
  if (layer.shape === "roundedRectangle") {
    const maxRadius = Math.max(0, Math.min(layer.widthMm, layer.heightMm) / 2 - 0.01);
    if (layer.cornerRadiusMm < 0) {
      issues.push({
        code: "base/corner-negative",
        severity: "error",
        message: "רדיוס הפינה אינו יכול להיות שלילי",
      });
    } else if (layer.cornerRadiusMm > maxRadius) {
      issues.push({
        code: "base/corner-too-large",
        severity: "error",
        message: "רדיוס הפינה גדול מדי ביחס למידות הבסיס",
      });
    }
  }
}

function validateExtrusion(
  layer: TextLayer | SvgLayer | ImageReliefLayer,
  document: DesignDocument,
  base: BaseLayer | null,
  limits: Limits,
  issues: ValidationIssue[]
): void {
  const r = PARAM_RANGES;
  const depth = layer.extrudeMm;
  if (!within(depth, r.textDepthMm)) {
    issues.push({
      code: "layer/depth-range",
      severity: "error",
      message: `עומק/גובה השכבה "${layer.name}" חייב להיות בין ${r.textDepthMm.min} ל-${r.textDepthMm.max} מ״מ`,
    });
    return;
  }
  const standalone = document.baseMode === "baseless" || layer.combine === "standalone" || !base;
  if (standalone) {
    if (depth < limits.minWallMm) {
      issues.push({
        code: "layer/thin-standalone",
        severity: "warning",
        message: `העובי של "${layer.name}" ‏(${depth} מ״מ) דק ממינימום הקיר המומלץ (${limits.minWallMm} מ״מ) לגוף עצמאי`,
      });
    }
  } else if (depth < limits.minReliefDepthMm) {
    issues.push({
      code: "layer/shallow-relief",
      severity: "warning",
      message: `עומק תבליט של ${depth} מ״מ בשכבה "${layer.name}" נמוך מהמינימום המומלץ (${limits.minReliefDepthMm} מ״מ)`,
    });
  }
  if (!standalone && layer.combine === "engraved" && base) {
    const floor = base.thicknessMm - depth;
    if (floor <= 0) {
      issues.push({
        code: "layer/engrave-through",
        severity: "warning",
        message: `עומק החריטה של "${layer.name}" גדול מעובי הבסיס — החריטה תחורר את הלוחית`,
      });
    } else if (floor < limits.minEngraveFloorMm) {
      issues.push({
        code: "layer/engrave-floor",
        severity: "warning",
        message: `נשארת רצפה של ${round2(floor)} מ״מ בלבד מתחת לחריטת "${layer.name}" (מומלץ לפחות ${limits.minEngraveFloorMm} מ״מ)`,
      });
    }
  }
  if (layer.bevel.enabled) {
    if (layer.bevel.sizeMm <= 0) {
      issues.push({
        code: "layer/bevel-size",
        severity: "error",
        message: `גודל הפאזה בשכבה "${layer.name}" חייב להיות גדול מאפס`,
      });
    } else if (layer.bevel.sizeMm >= depth) {
      issues.push({
        code: "layer/bevel-too-big",
        severity: "warning",
        message: `הפאזה בשכבה "${layer.name}" גדולה מגובה האקסטרוזיה — היא תקוצץ אוטומטית`,
      });
    }
  }
}

function validateText(
  layer: TextLayer,
  document: DesignDocument,
  base: BaseLayer | null,
  limits: Limits,
  issues: ValidationIssue[]
): void {
  const r = PARAM_RANGES;
  if (layer.content.length > r.maxTextLength) {
    issues.push({
      code: "text/too-long",
      severity: "error",
      message: `אורך הטקסט מוגבל ל-${r.maxTextLength} תווים`,
    });
  }
  if (layer.content.trim().length === 0) {
    issues.push({
      code: "text/empty",
      severity: "warning",
      message: `שכבת הטקסט "${layer.name}" ריקה`,
    });
    return;
  }
  if (!within(layer.sizeMm, r.textSizeMm)) {
    issues.push({
      code: "text/size-range",
      severity: "error",
      message: `גודל הטקסט חייב להיות בין ${r.textSizeMm.min} ל-${r.textSizeMm.max} מ״מ`,
    });
  } else if (layer.sizeMm < limits.minTextSizeMm) {
    issues.push({
      code: "text/small-size",
      severity: "warning",
      message: `טקסט בגודל ${layer.sizeMm} מ״מ עלול לצאת לא קריא בהדפסה (מומלץ ${limits.minTextSizeMm} מ״מ ומעלה)`,
    });
  }
  if (!within(layer.lineSpacing, r.lineSpacing)) {
    issues.push({
      code: "text/line-spacing-range",
      severity: "error",
      message: "מרווח השורות מחוץ לטווח המותר",
    });
  }
  validateExtrusion(layer, document, base, limits, issues);
}

function validateContourish(
  layer: SvgLayer | ImageReliefLayer,
  document: DesignDocument,
  base: BaseLayer | null,
  limits: Limits,
  issues: ValidationIssue[]
): void {
  if (layer.type === "imageRelief" && layer.mode === "relief") {
    if (!layer.meshId) {
      issues.push({
        code: "image/missing-mesh",
        severity: "error",
        message: `לשכבת התבליט "${layer.name}" חסרים נתוני גוף — ייבאו את התמונה מחדש`,
      });
    }
    return;
  }
  if (layer.contours.length === 0) {
    issues.push({
      code: "contour/empty",
      severity: "warning",
      message: `לשכבה "${layer.name}" אין קווי מתאר — היא לא תיכלל במודל`,
    });
    return;
  }
  validateExtrusion(layer, document, base, limits, issues);
}

function validateHole(
  layer: HoleLayer,
  base: BaseLayer | null,
  limits: Limits,
  issues: ValidationIssue[]
): void {
  const r = PARAM_RANGES;
  if (!within(layer.diameterMm, r.holeDiameterMm)) {
    issues.push({
      code: "hole/diameter-range",
      severity: "error",
      message: `קוטר החור חייב להיות בין ${r.holeDiameterMm.min} ל-${r.holeDiameterMm.max} מ״מ`,
    });
    return;
  }
  if (layer.depthMode === "blind" && layer.depthMm <= 0) {
    issues.push({
      code: "hole/depth",
      severity: "error",
      message: "עומק חור עיוור חייב להיות גדול מאפס",
    });
  }
  // Wall-thickness check around the hole relative to the base outline
  // (only when the hole is axis-aligned on an untransformed base — the
  // general case is covered by the wall-thickness analysis).
  if (base && isAxisAligned(layer) && isAxisAligned(base)) {
    const dx = Math.abs(layer.transform.x - base.transform.x);
    const dy = Math.abs(layer.transform.y - base.transform.y);
    const wallX = base.widthMm / 2 - dx - layer.diameterMm / 2;
    const wallY = base.heightMm / 2 - dy - layer.diameterMm / 2;
    const wall = Math.min(wallX, wallY);
    const inside = dx < base.widthMm / 2 && dy < base.heightMm / 2;
    if (!inside) {
      issues.push({
        code: "hole/outside",
        severity: "warning",
        message: `החור "${layer.name}" נמצא מחוץ לגבולות הבסיס`,
      });
    } else if (wall < 0) {
      issues.push({
        code: "hole/overflow",
        severity: "warning",
        message: `החור "${layer.name}" חורג מגבולות הבסיס`,
      });
    } else if (wall < limits.minWallMm) {
      issues.push({
        code: "hole/thin-wall",
        severity: "warning",
        message: `הדופן סביב החור "${layer.name}" ‏(${round2(wall)} מ״מ) דקה מהמינימום המומלץ (${limits.minWallMm} מ״מ)`,
      });
    }
  }
}

function isAxisAligned(layer: DesignLayer): boolean {
  const t = layer.transform;
  return (
    t.rotationX === 0 &&
    t.rotationY === 0 &&
    t.rotationZ === 0 &&
    t.scaleX === 1 &&
    t.scaleY === 1 &&
    t.scaleZ === 1
  );
}
