/**
 * Overhang analysis: flags downward-facing triangles steeper than the
 * profile's overhang threshold. This is a geometric estimate for guidance
 * only — the UI must always present it as such, never as slicer output.
 */

import type { ModelIssue } from "@/types/design";
import type { MeshData } from "../meshData";
import { triangleAccessors } from "./meshMath";

export interface OverhangAnalysis {
  overhangAreaMm2: number;
  totalAreaMm2: number;
  /** 1 byte per triangle: 0 = ok, 1 = overhang needing support. */
  triangleFlags: Uint8Array;
  /** Worst overhang angle found, measured from vertical (degrees). */
  worstAngleDeg: number;
  supportRisk: "low" | "medium" | "high";
  issues: ModelIssue[];
}

/** Faces resting on the plate (within this Z tolerance) are not overhangs. */
const PLATE_TOLERANCE_MM = 0.3;

export const OVERHANG_DISCLAIMER_HE =
  "הניתוח הוא המלצה. יש לבדוק תמיכות סופיות בתוכנת הסלייסר.";

export function analyzeOverhangs(mesh: MeshData, maxOverhangDeg: number): OverhangAnalysis {
  const tris = triangleAccessors(mesh);
  const flags = new Uint8Array(tris.count);
  let overhangArea = 0;
  let totalArea = 0;
  let worstAngle = 0;

  // A downward face with normal angle θ from straight-down (0,0,-1) has an
  // overhang angle from vertical of θ; it needs support when the surface
  // slope exceeds the threshold, i.e. θ < 90° − maxOverhangDeg means the
  // face is close to horizontal-facing-down (worst), θ ≥ 90° is not
  // downward at all. Flag when angleFromVertical = 90° − θ > maxOverhang.
  for (let t = 0; t < tris.count; t++) {
    const area = tris.area(t);
    totalArea += area;
    const [, , nz] = tris.normal(t);
    if (nz >= -1e-6) continue; // not downward-facing
    if (tris.minZ(t) <= tris.minZOfMesh + PLATE_TOLERANCE_MM) continue; // on plate
    const angleFromDown = (Math.acos(Math.min(1, Math.max(-1, -nz))) * 180) / Math.PI;
    const overhangAngle = 90 - angleFromDown; // 90 = flat ceiling, 0 = vertical wall
    if (overhangAngle > 90 - maxOverhangDeg) {
      flags[t] = 1;
      overhangArea += area;
      worstAngle = Math.max(worstAngle, overhangAngle);
    }
  }

  const fraction = totalArea > 0 ? overhangArea / totalArea : 0;
  const supportRisk: OverhangAnalysis["supportRisk"] =
    fraction < 0.02 ? "low" : fraction < 0.1 ? "medium" : "high";

  const issues: ModelIssue[] = [];
  if (supportRisk !== "low") {
    issues.push({
      code: "overhang/support-needed",
      severity: "warning",
      titleHe: "משטחים תלויים צפויים להזדקק לתמיכות",
      detailHe: `נמצאו כ-${Math.round(overhangArea)} מ״מ² של משטחים תלויים מעל סף של ${maxOverhangDeg}°. רמת סיכון: ${supportRisk === "high" ? "גבוהה" : "בינונית"}.`,
      actionHe: "סובבו את המודל לתנוחה נוחה יותר או הפעילו תמיכות בסלייסר",
    });
  }
  issues.push({
    code: "overhang/disclaimer",
    severity: "ok",
    titleHe: "הערכת תמיכות",
    detailHe: OVERHANG_DISCLAIMER_HE,
  });

  return {
    overhangAreaMm2: overhangArea,
    totalAreaMm2: totalArea,
    triangleFlags: flags,
    worstAngleDeg: worstAngle,
    supportRisk,
    issues,
  };
}
