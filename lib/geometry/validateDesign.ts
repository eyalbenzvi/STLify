/**
 * V2 parameter validation: pure functions over the design document, no
 * three.js / DOM imports so everything is unit-testable in node.
 *
 * Mesh-level checks (watertightness, components…) live in meshStats.ts and
 * buildDesign.ts; this module covers everything derivable from parameters.
 */

import type {
  BaseLayer,
  DesignIssue,
  DesignLayer,
  DesignState,
  HoleLayer,
  ImageReliefLayer,
  PrintabilityLimitsV2,
  SvgLayer,
  TextLayer,
} from "@/types/design";
import { effectiveLimits } from "@/lib/design/defaults";

export const RANGES_V2 = {
  baseSizeMm: { min: 10, max: 400 },
  baseThicknessMm: { min: 1, max: 50 },
  cornerRadiusMm: { min: 0, max: 200 },
  rimWidthMm: { min: 0.8, max: 20 },
  rimHeightMm: { min: 0.4, max: 20 },
  textSizeMm: { min: 2, max: 200 },
  depthMm: { min: 0.2, max: 50 },
  offsetMm: { min: -200, max: 200 },
  lineSpacing: { min: 0.8, max: 3 },
  letterSpacingMm: { min: -2, max: 20 },
  curveRadiusMm: { min: 0, max: 500 },
  maxTextLength: 200,
  svgSizeMm: { min: 2, max: 380 },
  imageSizeMm: { min: 5, max: 380 },
  reliefHeightMm: { min: 0.1, max: 20 },
  holeDiameterMm: { min: 0.5, max: 60 },
  holeRectMm: { min: 1, max: 200 },
  scale: { min: 0.05, max: 20 },
  maxLayers: 40,
} as const;

function within(value: number, range: { min: number; max: number }): boolean {
  return Number.isFinite(value) && value >= range.min && value <= range.max;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface Ctx {
  issues: DesignIssue[];
  limits: PrintabilityLimitsV2;
  base: BaseLayer;
}

function error(ctx: Ctx, code: string, message: string, layerId?: string, recommendation?: string, details?: string): void {
  ctx.issues.push({ code, severity: "error", message, layerId, recommendation, details });
}

function warning(ctx: Ctx, code: string, message: string, layerId?: string, recommendation?: string, details?: string): void {
  ctx.issues.push({ code, severity: "warning", message, layerId, recommendation, details });
}

/** Validate the whole design state. Returns all issues (errors block builds). */
export function validateDesignState(state: DesignState): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const base = state.doc.layers[0];
  if (!base || base.type !== "base") {
    issues.push({
      code: "doc/no-base",
      severity: "error",
      message: "לעיצוב חסרה שכבת בסיס",
    });
    return issues;
  }
  const ctx: Ctx = { issues, limits: effectiveLimits(state.settings), base };

  if (state.doc.layers.length > RANGES_V2.maxLayers) {
    error(ctx, "doc/too-many-layers", `מספר השכבות מוגבל ל-${RANGES_V2.maxLayers}`);
  }

  validateBase(ctx, base);
  for (const layer of state.doc.layers.slice(1)) {
    if (!layer.visible) continue;
    validateTransform(ctx, layer);
    switch (layer.type) {
      case "text":
        validateText(ctx, layer);
        break;
      case "svg":
        validateSvg(ctx, layer);
        break;
      case "imageRelief":
        validateImage(ctx, layer);
        break;
      case "hole":
        validateHole(ctx, layer);
        break;
      case "base":
        error(ctx, "doc/duplicate-base", "נמצאה יותר משכבת בסיס אחת", layer.id);
        break;
    }
  }

  // Build volume check against the selected printer.
  const printer = state.settings.estimate.printer;
  const maxZ = estimateMaxHeight(state);
  if (
    base.widthMm > printer.buildVolumeMm.x ||
    base.heightMm > printer.buildVolumeMm.y ||
    maxZ > printer.buildVolumeMm.z
  ) {
    warning(
      ctx,
      "printer/build-volume",
      "מידות המודל גדולות מנפח ההדפסה של המדפסת שנבחרה",
      undefined,
      "הקטינו את הבסיס או בחרו מדפסת עם נפח הדפסה גדול יותר",
      `Model ≈ ${round2(base.widthMm)}×${round2(base.heightMm)}×${round2(maxZ)} mm; build volume ${printer.buildVolumeMm.x}×${printer.buildVolumeMm.y}×${printer.buildVolumeMm.z} mm`
    );
  }

  return issues;
}

function estimateMaxHeight(state: DesignState): number {
  const base = state.doc.layers[0] as BaseLayer;
  let top = base.thicknessMm + (base.rim.enabled ? base.rim.heightMm : 0);
  for (const layer of state.doc.layers.slice(1)) {
    if (!layer.visible) continue;
    if (layer.type === "text" || layer.type === "svg") {
      if (layer.mode === "raised") top = Math.max(top, base.thicknessMm + layer.depthMm + layer.transform.z);
    } else if (layer.type === "imageRelief" && layer.mode !== "engraved") {
      top = Math.max(top, base.thicknessMm + layer.maxHeightMm + layer.transform.z);
    }
  }
  return top;
}

function validateBase(ctx: Ctx, base: BaseLayer): void {
  const r = RANGES_V2;
  if (!within(base.widthMm, r.baseSizeMm) || !within(base.heightMm, r.baseSizeMm)) {
    error(
      ctx,
      "base/size-range",
      `מידות הבסיס חייבות להיות בין ${r.baseSizeMm.min} ל-${r.baseSizeMm.max} מ״מ`,
      base.id
    );
  }
  if (!within(base.thicknessMm, r.baseThicknessMm)) {
    error(
      ctx,
      "base/thickness-range",
      `עובי הבסיס חייב להיות בין ${r.baseThicknessMm.min} ל-${r.baseThicknessMm.max} מ״מ`,
      base.id
    );
  } else if (base.thicknessMm < ctx.limits.minWallMm) {
    warning(
      ctx,
      "base/thin",
      `עובי הבסיס (${base.thicknessMm} מ״מ) נמוך מהמינימום המומלץ (${ctx.limits.minWallMm} מ״מ)`,
      base.id,
      "הגדילו את עובי הבסיס"
    );
  }
  if (base.shape === "roundedRectangle") {
    const maxRadius = Math.min(base.widthMm, base.heightMm) / 2;
    if (base.cornerRadiusMm < 0 || base.cornerRadiusMm > maxRadius) {
      error(ctx, "base/corner-radius", "רדיוס הפינה גדול מדי ביחס למידות הבסיס", base.id);
    }
  }
  if (base.rim.enabled) {
    if (!within(base.rim.widthMm, r.rimWidthMm) || !within(base.rim.heightMm, r.rimHeightMm)) {
      error(ctx, "base/rim-range", "מידות המסגרת/שפה מחוץ לטווח המותר", base.id);
    }
    if (base.rim.widthMm * 2 >= Math.min(base.widthMm, base.heightMm)) {
      error(ctx, "base/rim-too-wide", "המסגרת רחבה מדי ביחס לבסיס", base.id);
    } else if (base.rim.widthMm < ctx.limits.minWallMm) {
      warning(
        ctx,
        "base/rim-thin",
        `רוחב המסגרת (${base.rim.widthMm} מ״מ) דק מהמינימום המומלץ (${ctx.limits.minWallMm} מ״מ)`,
        base.id
      );
    }
  }
}

function validateTransform(ctx: Ctx, layer: DesignLayer): void {
  const t = layer.transform;
  const r = RANGES_V2;
  const finite = [t.x, t.y, t.z, t.rotationX, t.rotationY, t.rotationZ, t.scaleX, t.scaleY, t.scaleZ].every(Number.isFinite);
  if (!finite) {
    error(ctx, "layer/transform-invalid", `בשכבה "${layer.name}" יש ערכי מיקום לא תקינים`, layer.id);
    return;
  }
  if (!within(t.x, r.offsetMm) || !within(t.y, r.offsetMm)) {
    error(ctx, "layer/offset-range", `מיקום השכבה "${layer.name}" מחוץ לטווח המותר`, layer.id);
  }
  for (const s of [t.scaleX, t.scaleY, t.scaleZ]) {
    if (!within(s, r.scale)) {
      error(ctx, "layer/scale-range", `קנה המידה של "${layer.name}" מחוץ לטווח המותר`, layer.id);
      break;
    }
  }
}

function validateReliefDepth(
  ctx: Ctx,
  layer: TextLayer | SvgLayer,
  labelHe: string
): void {
  const { limits, base } = ctx;
  if (!within(layer.depthMm, RANGES_V2.depthMm)) {
    error(
      ctx,
      "relief/depth-range",
      `עומק/גובה ${labelHe} חייב להיות בין ${RANGES_V2.depthMm.min} ל-${RANGES_V2.depthMm.max} מ״מ`,
      layer.id
    );
    return;
  }
  if (layer.mode === "raised" && layer.depthMm < limits.minEmbossHeightMm) {
    warning(
      ctx,
      "relief/shallow-emboss",
      `גובה ההבלטה של "${layer.name}" (${layer.depthMm} מ״מ) נמוך מהמומלץ (${limits.minEmbossHeightMm} מ״מ)`,
      layer.id,
      "הגדילו את גובה ההבלטה"
    );
  }
  if (layer.mode === "engraved") {
    if (layer.depthMm < limits.minEngraveDepthMm) {
      warning(
        ctx,
        "relief/shallow-engrave",
        `עומק החריטה של "${layer.name}" (${layer.depthMm} מ״מ) נמוך מהמומלץ (${limits.minEngraveDepthMm} מ״מ)`,
        layer.id,
        "הגדילו את עומק החריטה"
      );
    }
    const floor = base.thicknessMm - layer.depthMm;
    if (floor <= 0) {
      error(
        ctx,
        "relief/engrave-through",
        `עומק החריטה של "${layer.name}" גדול מעובי הבסיס — החריטה תחורר את המודל`,
        layer.id,
        "הקטינו את עומק החריטה או הגדילו את עובי הבסיס"
      );
    } else if (floor < limits.minEngraveFloorMm) {
      warning(
        ctx,
        "relief/engrave-floor",
        `נשארת רצפה של ${round2(floor)} מ״מ בלבד מתחת לחריטה של "${layer.name}" (מומלץ ${limits.minEngraveFloorMm} מ״מ)`,
        layer.id
      );
    }
  }
  if (layer.mode === "inlay") {
    const floor = base.thicknessMm - layer.depthMm;
    if (floor <= 0) {
      error(ctx, "relief/inlay-through", `עומק השיבוץ של "${layer.name}" גדול מעובי הבסיס`, layer.id);
    }
  }
}

function validateText(ctx: Ctx, layer: TextLayer): void {
  const r = RANGES_V2;
  const { limits, base } = ctx;
  if (layer.content.length > r.maxTextLength) {
    error(ctx, "text/too-long", `אורך הטקסט מוגבל ל-${r.maxTextLength} תווים`, layer.id);
  }
  if (layer.content.trim().length === 0) {
    warning(ctx, "text/empty", `שכבת הטקסט "${layer.name}" ריקה`, layer.id);
    return;
  }
  if (!within(layer.sizeMm, r.textSizeMm)) {
    error(ctx, "text/size-range", `גודל הטקסט חייב להיות בין ${r.textSizeMm.min} ל-${r.textSizeMm.max} מ״מ`, layer.id);
  } else {
    const effectiveSize = layer.sizeMm * Math.min(layer.transform.scaleX, layer.transform.scaleY);
    if (effectiveSize < limits.minTextSizeMm) {
      warning(
        ctx,
        "text/small",
        `טקסט בגודל ${round2(effectiveSize)} מ״מ עלול לצאת לא קריא בהדפסה (מומלץ ${limits.minTextSizeMm} מ״מ ומעלה)`,
        layer.id,
        "הגדילו את גודל הטקסט"
      );
    }
  }
  if (!within(layer.lineSpacing, r.lineSpacing)) {
    error(ctx, "text/line-spacing", "מרווח השורות מחוץ לטווח המותר", layer.id);
  }
  if (!within(layer.letterSpacingMm, r.letterSpacingMm)) {
    error(ctx, "text/letter-spacing", "מרווח האותיות מחוץ לטווח המותר", layer.id);
  }
  if (layer.curveRadiusMm !== 0 && !within(layer.curveRadiusMm, r.curveRadiusMm)) {
    error(ctx, "text/curve-radius", "רדיוס העיקול מחוץ לטווח המותר", layer.id);
  }
  if (layer.curveRadiusMm > 0 && layer.curveRadiusMm < layer.sizeMm) {
    warning(
      ctx,
      "text/curve-tight",
      `רדיוס העיקול של "${layer.name}" קטן מדי ביחס לגודל הטקסט — אותיות עלולות לחפוף`,
      layer.id,
      "הגדילו את רדיוס העיקול"
    );
  }
  validateReliefDepth(ctx, layer, "הטקסט");

  // Rough overflow estimate (precise check happens after layout in build).
  const estWidth = layer.content.length * layer.sizeMm * 0.6 * layer.transform.scaleX;
  if (estWidth > base.widthMm * 1.4) {
    warning(
      ctx,
      "text/likely-overflow",
      `הטקסט של "${layer.name}" ככל הנראה רחב מהבסיס`,
      layer.id,
      "הקטינו את הטקסט או פצלו לשורות"
    );
  }
}

function validateSvg(ctx: Ctx, layer: SvgLayer): void {
  const r = RANGES_V2;
  if (!layer.svgText.trim()) {
    warning(ctx, "svg/empty", `שכבת ה-SVG "${layer.name}" ריקה`, layer.id);
    return;
  }
  if (!within(layer.targetWidthMm, r.svgSizeMm) || !within(layer.targetHeightMm, r.svgSizeMm)) {
    error(ctx, "svg/size-range", `מידות ה-SVG חייבות להיות בין ${r.svgSizeMm.min} ל-${r.svgSizeMm.max} מ״מ`, layer.id);
  }
  validateReliefDepth(ctx, layer, "הלוגו");
  const smallest = Math.min(layer.targetWidthMm, layer.targetHeightMm);
  if (smallest < ctx.limits.minFeatureMm * 8) {
    warning(
      ctx,
      "svg/small",
      `הלוגו "${layer.name}" קטן מאוד — פרטים דקים עלולים להיעלם בהדפסה`,
      layer.id,
      "הגדילו את הלוגו"
    );
  }
}

function validateImage(ctx: Ctx, layer: ImageReliefLayer): void {
  const r = RANGES_V2;
  const { limits, base } = ctx;
  if (!layer.assetId) {
    error(ctx, "image/no-asset", `לשכבת התמונה "${layer.name}" חסר קובץ מקור`, layer.id);
    return;
  }
  if (!within(layer.widthMm, r.imageSizeMm) || !within(layer.heightMm, r.imageSizeMm)) {
    error(ctx, "image/size-range", `מידות התמונה חייבות להיות בין ${r.imageSizeMm.min} ל-${r.imageSizeMm.max} מ״מ`, layer.id);
  }
  if (
    !within(layer.minHeightMm, r.reliefHeightMm) ||
    !within(layer.maxHeightMm, r.reliefHeightMm) ||
    layer.maxHeightMm < layer.minHeightMm
  ) {
    error(ctx, "image/relief-range", "טווח גובה התבליט אינו תקין", layer.id);
  }
  if (layer.mode === "engraved") {
    const floor = base.thicknessMm - layer.maxHeightMm;
    if (floor <= 0) {
      error(ctx, "image/engrave-through", `עומק התבליט החרוט של "${layer.name}" גדול מעובי הבסיס`, layer.id);
    } else if (floor < limits.minEngraveFloorMm) {
      warning(
        ctx,
        "image/engrave-floor",
        `נשארת רצפה דקה (${round2(floor)} מ״מ) מתחת לתבליט של "${layer.name}"`,
        layer.id
      );
    }
  } else if (layer.maxHeightMm < limits.minEmbossHeightMm) {
    warning(
      ctx,
      "image/shallow",
      `גובה התבליט של "${layer.name}" נמוך מהמומלץ (${limits.minEmbossHeightMm} מ״מ)`,
      layer.id
    );
  }
}

function validateHole(ctx: Ctx, layer: HoleLayer): void {
  const r = RANGES_V2;
  const { limits, base } = ctx;
  if (layer.shape === "circle") {
    if (!within(layer.diameterMm, r.holeDiameterMm)) {
      error(ctx, "hole/diameter-range", `קוטר החור חייב להיות בין ${r.holeDiameterMm.min} ל-${r.holeDiameterMm.max} מ״מ`, layer.id);
      return;
    }
    if (layer.diameterMm < limits.minHoleDiameterMm) {
      warning(
        ctx,
        "hole/small",
        `קוטר החור "${layer.name}" (${layer.diameterMm} מ״מ) קטן מהמומלץ (${limits.minHoleDiameterMm} מ״מ) — החור עלול להיסתם בהדפסה`,
        layer.id,
        "הגדילו את קוטר החור"
      );
    }
  } else {
    if (!within(layer.widthMm, r.holeRectMm) || !within(layer.heightMm, r.holeRectMm)) {
      error(ctx, "hole/rect-range", "מידות הפתח מחוץ לטווח המותר", layer.id);
      return;
    }
  }

  if (!layer.through) {
    if (layer.depthMm <= 0 || !Number.isFinite(layer.depthMm)) {
      error(ctx, "hole/depth-invalid", `עומק הכיס "${layer.name}" אינו תקין`, layer.id);
    } else if (layer.depthMm >= base.thicknessMm) {
      error(
        ctx,
        "hole/pocket-through",
        `עומק הכיס "${layer.name}" גדול מעובי הבסיס — ייווצר חור מפולש`,
        layer.id,
        "הקטינו את עומק הכיס או הגדילו את עובי הבסיס"
      );
    } else {
      const remaining = base.thicknessMm - layer.depthMm;
      if (remaining < limits.minWallMm) {
        warning(
          ctx,
          "hole/pocket-floor",
          `מעל/מתחת לכיס "${layer.name}" נשאר חומר בעובי ${round2(remaining)} מ״מ בלבד (מומלץ ${limits.minWallMm} מ״מ)`,
          layer.id,
          "הקטינו את עומק הכיס"
        );
      }
    }
  }

  // Distance from the base edge (rectangle approximation for circles too).
  const radius = layer.shape === "circle" ? layer.diameterMm / 2 : Math.max(layer.widthMm, layer.heightMm) / 2;
  const halfW = base.shape === "circle" ? base.widthMm / 2 : base.widthMm / 2;
  const halfH = base.shape === "circle" ? base.widthMm / 2 : base.heightMm / 2;
  const dx = halfW - Math.abs(layer.transform.x);
  const dy = halfH - Math.abs(layer.transform.y);
  const edgeDistance = Math.min(dx, dy) - radius;
  if (edgeDistance < 0) {
    warning(
      ctx,
      "hole/outside",
      `החור "${layer.name}" חורג מגבולות הבסיס`,
      layer.id,
      "הזיזו את החור פנימה"
    );
  } else if (edgeDistance < limits.minHoleEdgeDistanceMm) {
    warning(
      ctx,
      "hole/near-edge",
      `החור "${layer.name}" קרוב מדי לשפת הבסיס (${round2(edgeDistance)} מ״מ; מומלץ ${limits.minHoleEdgeDistanceMm} מ״מ) — הדופן עלולה להישבר`,
      layer.id,
      "הזיזו את החור פנימה או הגדילו את הבסיס"
    );
  }
}
