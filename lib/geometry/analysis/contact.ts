/**
 * Build-plate contact analysis: how much surface actually touches Z=0 and
 * whether that contact plausibly holds the model during printing.
 */

import type { ModelIssue } from "@/types/design";
import type { MeshData } from "../meshData";
import { triangleAccessors } from "./meshMath";

export interface ContactAnalysis {
  contactAreaMm2: number;
  lowestZ: number;
  onPlate: boolean;
  stable: boolean;
  issues: ModelIssue[];
}

export function analyzeContact(
  mesh: MeshData,
  opts?: { toleranceMm?: number }
): ContactAnalysis {
  const tolerance = opts?.toleranceMm ?? 0.25;
  const tris = triangleAccessors(mesh);
  const p = mesh.positions;
  const idx = mesh.indices;

  let contactArea = 0;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i];
    if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1];
    if (p[i + 1] > maxY) maxY = p[i + 1];
  }

  for (let t = 0; t < tris.count; t++) {
    const [, , nz] = tris.normal(t);
    if (nz > -0.7) continue;
    const a = idx[t * 3] * 3 + 2;
    const b = idx[t * 3 + 1] * 3 + 2;
    const c = idx[t * 3 + 2] * 3 + 2;
    const zMax = Math.max(p[a], p[b], p[c]);
    if (zMax <= tris.minZOfMesh + tolerance) contactArea += tris.area(t);
  }

  const lowestZ = tris.minZOfMesh;
  const onPlate = Math.abs(lowestZ) <= tolerance;
  const heightMm = tris.maxZOfMesh - tris.minZOfMesh;
  const footprint = Math.max((maxX - minX) * (maxY - minY), 1e-6);
  // Stability heuristic: ≥25 mm² of contact per 100 mm of height AND at
  // least 1% of the XY footprint actually touching the plate.
  const stable =
    contactArea >= (25 * Math.max(heightMm, 1)) / 100 && contactArea >= footprint * 0.01;

  const issues: ModelIssue[] = [];
  if (!onPlate) {
    issues.push({
      code: "contact/off-plate",
      severity: "critical",
      titleHe: "המודל אינו מונח על משטח ההדפסה",
      detailHe: `הנקודה הנמוכה ביותר נמצאת ב-Z=${lowestZ.toFixed(2)} מ״מ`,
      actionHe: "השתמשו ב״הנח על משטח ההדפסה״",
    });
  } else if (!stable) {
    issues.push({
      code: "contact/unstable",
      severity: "warning",
      titleHe: "שטח המגע עם המשטח קטן",
      detailHe: `שטח המגע הוא ${contactArea.toFixed(1)} מ״מ² בלבד עבור גובה של ${heightMm.toFixed(0)} מ״מ — המודל עלול להתנתק בזמן ההדפסה`,
      actionHe: "שקלו תנוחה אחרת, הוספת Brim בסלייסר או הרחבת הבסיס",
    });
  } else {
    issues.push({
      code: "contact/ok",
      severity: "ok",
      titleHe: "מגע יציב עם משטח ההדפסה",
      detailHe: `שטח מגע: ${contactArea.toFixed(1)} מ״מ²`,
    });
  }

  return { contactAreaMm2: contactArea, lowestZ, onPlate, stable, issues };
}
