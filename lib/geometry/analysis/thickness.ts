/**
 * Wall-thickness sampling: for a sample of triangles, cast a ray from the
 * face centroid into the body (via the kernel's exact ray casting) and
 * measure the distance to the first exit — the local wall thickness.
 * Doubles as the small-feature detector (thickness < minFeature).
 */

import type { ModelIssue } from "@/types/design";
import type { Solid } from "../kernel";
import type { MeshData } from "../meshData";
import { triangleAccessors } from "./meshMath";

export interface ThicknessSample {
  position: { x: number; y: number; z: number };
  thicknessMm: number;
}

export interface ThicknessAnalysis {
  minSampledMm: number;
  /** Per-triangle sampled thickness (NaN = not sampled). */
  triangleThickness: Float32Array;
  samples: ThicknessSample[];
  issues: ModelIssue[];
}

const BACKOFF_MM = 0.01;

export function analyzeThickness(
  solid: Solid,
  mesh: MeshData,
  opts: { minWallMm: number; minFeatureMm: number; maxSamples?: number }
): ThicknessAnalysis {
  const maxSamples = opts.maxSamples ?? 4000;
  const tris = triangleAccessors(mesh);
  const triangleThickness = new Float32Array(tris.count).fill(Number.NaN);
  const samples: ThicknessSample[] = [];

  const bounds = solid.boundingBox();
  const diagonal = Math.hypot(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z
  );
  if (diagonal < 1e-9 || tris.count === 0) {
    return {
      minSampledMm: Number.POSITIVE_INFINITY,
      triangleThickness,
      samples,
      issues: [],
    };
  }

  const stride = Math.max(1, Math.floor(tris.count / maxSamples));
  let minSampled = Number.POSITIVE_INFINITY;
  let worst: ThicknessSample | null = null;

  for (let t = 0; t < tris.count; t += stride) {
    const [nx, ny, nz] = tris.normal(t);
    if (nx === 0 && ny === 0 && nz === 0) continue;
    const [cx, cy, cz] = tris.centroid(t);
    const origin = {
      x: cx - nx * BACKOFF_MM,
      y: cy - ny * BACKOFF_MM,
      z: cz - nz * BACKOFF_MM,
    };
    const end = {
      x: cx - nx * diagonal,
      y: cy - ny * diagonal,
      z: cz - nz * diagonal,
    };
    const hits = solid.rayCast(origin, end);
    if (hits.length === 0) continue;
    const thickness = hits[0].distance + BACKOFF_MM;
    triangleThickness[t] = thickness;
    const sample = { position: { x: cx, y: cy, z: cz }, thicknessMm: thickness };
    samples.push(sample);
    if (thickness < minSampled) {
      minSampled = thickness;
      worst = sample;
    }
  }

  const issues: ModelIssue[] = [];
  if (samples.length === 0) {
    issues.push({
      code: "thickness/no-samples",
      severity: "warning",
      titleHe: "לא ניתן היה לדגום עובי דפנות",
      detailHe: "בדיקת עובי הדפנות לא הצליחה לדגום את הגוף",
    });
  } else if (minSampled < opts.minWallMm * 0.5) {
    issues.push({
      code: "thickness/critical",
      severity: "critical",
      titleHe: "קירות דקים מדי להדפסה",
      detailHe: `נמצא עובי מינימלי של ${minSampled.toFixed(2)} מ״מ — פחות ממחצית המינימום (${opts.minWallMm} מ״מ)`,
      actionHe: "עבו את האזורים הדקים או הגדילו את המודל",
      location: worst?.position,
    });
  } else if (minSampled < opts.minWallMm) {
    issues.push({
      code: "thickness/warning",
      severity: "warning",
      titleHe: "אזורים דקים מהמינימום המומלץ",
      detailHe: `עובי מינימלי שנדגם: ${minSampled.toFixed(2)} מ״מ (מומלץ: ${opts.minWallMm} מ״מ)`,
      actionHe: "בדקו את האזורים המסומנים באדום במפת החום",
      location: worst?.position,
    });
  } else {
    issues.push({
      code: "thickness/ok",
      severity: "ok",
      titleHe: "עובי הדפנות שנדגם תקין",
      detailHe: `עובי מינימלי שנדגם: ${minSampled.toFixed(2)} מ״מ`,
    });
  }

  if (
    samples.length > 0 &&
    minSampled >= opts.minWallMm &&
    minSampled < opts.minFeatureMm
  ) {
    issues.push({
      code: "thickness/small-features",
      severity: "warning",
      titleHe: "פרטים קטנים מסף ההדפסה",
      detailHe: `נמצאו פרטים דקים מ-${opts.minFeatureMm} מ״מ — הם עלולים לא לצאת בהדפסה`,
      location: worst?.position,
    });
  }

  return { minSampledMm: minSampled, triangleThickness, samples, issues };
}

/**
 * Map sampled thickness onto per-vertex RGB colors for the heatmap overlay:
 * green (safe) → yellow (marginal) → red (critical); gray = unsampled.
 */
export function thicknessToVertexColors(
  mesh: MeshData,
  analysis: ThicknessAnalysis,
  minWallMm: number
): Float32Array {
  const vertexCount = mesh.positions.length / 3;
  const colors = new Float32Array(vertexCount * 3).fill(0.55);
  const sums = new Float32Array(vertexCount);
  const counts = new Uint32Array(vertexCount);
  for (let t = 0; t < analysis.triangleThickness.length; t++) {
    const value = analysis.triangleThickness[t];
    if (Number.isNaN(value)) continue;
    for (let v = 0; v < 3; v++) {
      const vertex = mesh.indices[t * 3 + v];
      sums[vertex] += value;
      counts[vertex]++;
    }
  }
  for (let v = 0; v < vertexCount; v++) {
    if (counts[v] === 0) continue;
    const thickness = sums[v] / counts[v];
    let r: number, g: number, b: number;
    if (thickness >= 2 * minWallMm) {
      [r, g, b] = [0.22, 0.65, 0.35]; // safely thick — green
    } else if (thickness >= minWallMm) {
      const t = (thickness - minWallMm) / minWallMm; // 0..1 → yellow→green
      r = 0.95 - 0.73 * t;
      g = 0.75 - 0.1 * t;
      b = 0.15 + 0.2 * t;
    } else {
      const t = Math.max(0, thickness / minWallMm - 0.5) * 2; // ≤0.5min → red
      r = 0.85 + 0.1 * t;
      g = 0.15 + 0.6 * t;
      b = 0.15;
    }
    colors[v * 3] = r;
    colors[v * 3 + 1] = g;
    colors[v * 3 + 2] = b;
  }
  return colors;
}

/** Vertex colors for the overhang overlay (red = needs support). */
export function overhangToVertexColors(
  mesh: MeshData,
  triangleFlags: Uint8Array
): Float32Array {
  const vertexCount = mesh.positions.length / 3;
  const colors = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    colors[v * 3] = 0.32;
    colors[v * 3 + 1] = 0.55;
    colors[v * 3 + 2] = 0.75;
  }
  for (let t = 0; t < triangleFlags.length; t++) {
    if (!triangleFlags[t]) continue;
    for (let v = 0; v < 3; v++) {
      const vertex = mesh.indices[t * 3 + v];
      colors[vertex * 3] = 0.9;
      colors[vertex * 3 + 1] = 0.25;
      colors[vertex * 3 + 2] = 0.2;
    }
  }
  return colors;
}
