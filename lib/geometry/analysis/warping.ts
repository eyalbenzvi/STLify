/**
 * Warping-risk analysis (V6 item 12).
 *
 * Warping is thermal contraction pulling the first layers off the bed. The
 * risk grows with three measurable properties — a long bed footprint (the
 * ends of a long part are where the corners lift), a large contact area
 * (more shrinking material pulling on the bed), and a tall body over a
 * small base (a lever arm for the peeling force). Same discipline as the
 * orientation scorer: a deterministic, explainable score whose numbers are
 * printed in the Hebrew explanation — never a black box.
 */

import type { ModelIssue } from "@/types/design";
import type { MeshData } from "../meshData";
import { triangleAccessors } from "./meshMath";

export type WarpingRiskLevel = "low" | "medium" | "high";

export interface WarpingAssessment {
  /** 0 (none) .. 100 (severe). */
  riskScore: number;
  riskLevel: WarpingRiskLevel;
  contactAreaMm2: number;
  /** Longest XY extent of the bed contact region, mm. */
  contactSpanMm: number;
  /** Body height over the shorter base extent. */
  heightToBaseRatio: number;
  /** The score components, spelled out for the user. */
  explanationHe: string[];
  issues: ModelIssue[];
}

/** Documented scoring weights — see each explanation line. */
const WEIGHTS = {
  /** Points per mm of contact span, capped. */
  spanPerMm: 0.35,
  spanCap: 40,
  /** Points per 400mm² of contact area, capped. */
  areaPer400Mm2: 1,
  areaCap: 30,
  /** Points per unit of (height/base − 1), capped. */
  aspectPerUnit: 12,
  aspectCap: 30,
} as const;

const LEVEL_THRESHOLDS = { medium: 25, high: 50 } as const;

export function analyzeWarping(
  mesh: MeshData,
  opts?: { toleranceMm?: number }
): WarpingAssessment {
  const tolerance = opts?.toleranceMm ?? 0.25;
  const tris = triangleAccessors(mesh);
  const p = mesh.positions;
  const idx = mesh.indices;

  // Bed-contact triangles: all three vertices near z=0, facing down.
  let contactArea = 0;
  let cMinX = Infinity, cMaxX = -Infinity, cMinY = Infinity, cMaxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < bMinX) bMinX = p[i];
    if (p[i] > bMaxX) bMaxX = p[i];
    if (p[i + 1] < bMinY) bMinY = p[i + 1];
    if (p[i + 1] > bMaxY) bMaxY = p[i + 1];
    if (p[i + 2] < minZ) minZ = p[i + 2];
    if (p[i + 2] > maxZ) maxZ = p[i + 2];
  }
  if (!Number.isFinite(minZ)) {
    return {
      riskScore: 0,
      riskLevel: "low",
      contactAreaMm2: 0,
      contactSpanMm: 0,
      heightToBaseRatio: 0,
      explanationHe: ["אין גאומטריה לניתוח"],
      issues: [],
    };
  }

  for (let t = 0; t < tris.count; t++) {
    const [, , nz] = tris.normal(t);
    if (nz > -0.7) continue;
    let onBed = true;
    for (let k = 0; k < 3; k++) {
      const z = p[idx[t * 3 + k] * 3 + 2];
      if (z - minZ > tolerance) {
        onBed = false;
        break;
      }
    }
    if (!onBed) continue;
    contactArea += tris.area(t);
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      if (p[v] < cMinX) cMinX = p[v];
      if (p[v] > cMaxX) cMaxX = p[v];
      if (p[v + 1] < cMinY) cMinY = p[v + 1];
      if (p[v + 1] > cMaxY) cMaxY = p[v + 1];
    }
  }

  const contactSpan =
    contactArea > 0 ? Math.max(cMaxX - cMinX, cMaxY - cMinY) : 0;
  const height = maxZ - minZ;
  const baseShort = Math.max(1e-6, Math.min(bMaxX - bMinX, bMaxY - bMinY));
  const heightToBase = height / baseShort;

  const spanPoints = Math.min(WEIGHTS.spanCap, WEIGHTS.spanPerMm * contactSpan);
  const areaPoints = Math.min(WEIGHTS.areaCap, (contactArea / 400) * WEIGHTS.areaPer400Mm2);
  const aspectPoints = Math.min(
    WEIGHTS.aspectCap,
    Math.max(0, heightToBase - 1) * WEIGHTS.aspectPerUnit
  );
  const riskScore = Math.round(spanPoints + areaPoints + aspectPoints);
  const riskLevel: WarpingRiskLevel =
    riskScore >= LEVEL_THRESHOLDS.high
      ? "high"
      : riskScore >= LEVEL_THRESHOLDS.medium
        ? "medium"
        : "low";

  const explanationHe = [
    `אורך המגע עם המשטח: ${contactSpan.toFixed(0)} מ״מ → ${spanPoints.toFixed(0)} נק׳ (קצוות של חלקים ארוכים מתרוממים ראשונים)`,
    `שטח המגע: ${contactArea.toFixed(0)} ממ״ר → ${areaPoints.toFixed(0)} נק׳ (יותר חומר מתכווץ מושך את השכבות הראשונות)`,
    `יחס גובה לבסיס: ${heightToBase.toFixed(1)} → ${aspectPoints.toFixed(0)} נק׳ (גוף גבוה על בסיס צר הוא זרוע מנוף לקילוף)`,
    `סה״כ: ${riskScore} מתוך 100 — הניקוד דטרמיניסטי ומוסבר; בחומרים מתכווצים (ABS/ASA) הסיכון גבוה יותר מהמוצג`,
  ];

  const issues: ModelIssue[] = [];
  if (riskLevel !== "low") {
    issues.push({
      code: "warping/risk",
      severity: "warning",
      titleHe:
        riskLevel === "high"
          ? "סיכון גבוה להתקמרות (Warping) בהדפסה"
          : "סיכון בינוני להתקמרות (Warping)",
      detailHe: explanationHe.join(" · "),
      actionHe: "הוסיפו Brim או Raft (בלוח הכלים), או הדפיסו עם משטח מחומם ודבק",
    });
  }

  return {
    riskScore,
    riskLevel,
    contactAreaMm2: contactArea,
    contactSpanMm: contactSpan,
    heightToBaseRatio: heightToBase,
    explanationHe,
    issues,
  };
}
