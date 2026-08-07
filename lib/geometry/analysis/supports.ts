/**
 * Support structure generation.
 *
 * The overhang analysis already tells the user which faces will droop. It has
 * never told them what to do about it — the answer being "add supports",
 * which the app could not do. So the most common reason a model fails on an
 * FDM machine was diagnosed and then left to the slicer, whose automatic
 * supports are placed without any knowledge of which surfaces matter.
 *
 * These are conical pillars: a small tip that touches the part (so it snaps
 * off and leaves little scarring), flaring down to a wide base (so it does
 * not topple). Generated as real geometry in a separate layer, which means
 * the user can see them, delete individual ones, and export them.
 *
 * Deliberately NOT tree or organic supports: those need a global optimiser,
 * and a browser-side approximation of one would be slower and worse than
 * what a modern slicer already does. Pillars are the case where placing them
 * yourself genuinely beats the slicer, because you choose the surfaces.
 */

import { MeshBvh } from "../bvh";
import type { GeometryKernel, Solid } from "../kernel";
import type { MeshData } from "../meshData";
import { buildAdjacency } from "../selection/meshAdjacency";

export interface SupportSettings {
  /**
   * Faces steeper than this from horizontal need support. Matches the
   * printability profile's overhang threshold.
   */
  maxOverhangDeg: number;
  /** Grid spacing of candidate pillars, mm. */
  spacingMm: number;
  /** Pillar diameter where it meets the part, mm. Small = easy to remove. */
  tipDiameterMm: number;
  /** Pillar diameter at the build plate, mm. */
  baseDiameterMm: number;
  /** Gap left between the tip and the part, mm. 0 = touching. */
  contactGapMm: number;
  /** Skip overhangs lower than this above the plate, mm. */
  minHeightMm: number;
  /** Refuse to generate more than this many pillars. */
  maxPillars?: number;
}

export const DEFAULT_SUPPORT_SETTINGS: SupportSettings = {
  maxOverhangDeg: 50,
  spacingMm: 6,
  tipDiameterMm: 0.8,
  baseDiameterMm: 3,
  contactGapMm: 0.2,
  minHeightMm: 1,
};

export interface SupportPillar {
  /** Where the pillar touches the part, world mm. */
  top: { x: number; y: number; z: number };
  /** Height from the plate (or the surface below) to the contact point. */
  heightMm: number;
  /** Z the pillar stands on: the plate, or another part surface. */
  baseZMm: number;
}

export interface SupportGenerationResult {
  pillars: SupportPillar[];
  /** Pillars skipped because the cap was reached. */
  skipped: number;
  /** Total volume of the generated supports, mm³. */
  volumeMm3: number;
  summaryHe: string;
}

const DEFAULT_MAX_PILLARS = 400;

/**
 * Find the points that need supporting.
 *
 * A downward-facing triangle is sampled at its centroid; a grid filter then
 * keeps at most one pillar per cell, which is what stops a finely tessellated
 * overhang from generating a thousand touching pillars.
 */
export function findSupportPoints(
  mesh: MeshData,
  settings: SupportSettings
): SupportPillar[] {
  const adjacency = buildAdjacency(mesh);
  const bvh = new MeshBvh(mesh);
  const idx = mesh.indices;
  const pos = mesh.positions;

  // A face needs support when its normal points downward steeply enough.
  // normal.z = -1 is fully horizontal-facing-down (the worst case).
  const threshold = -Math.cos((settings.maxOverhangDeg * Math.PI) / 180);

  /** grid cell key -> the lowest candidate found in it */
  const cells = new Map<string, SupportPillar>();
  const spacing = Math.max(0.5, settings.spacingMm);

  for (let t = 0; t < adjacency.triangleCount; t++) {
    const nz = adjacency.normals[t * 3 + 2];
    if (nz > threshold) continue;

    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const cx = (pos[a] + pos[b] + pos[c]) / 3;
    const cy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
    const cz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    if (cz < settings.minHeightMm) continue;

    // What is directly below? A pillar may land on the plate or on the part.
    const baseZ = findSurfaceBelow(bvh, mesh, { x: cx, y: cy, z: cz });
    const height = cz - baseZ;
    if (height < settings.minHeightMm) continue;

    const key = `${Math.round(cx / spacing)}_${Math.round(cy / spacing)}`;
    const existing = cells.get(key);
    // Keep the LOWEST contact point per cell: supporting the lowest overhang
    // in a cluster usually props up everything above it.
    if (!existing || cz < existing.top.z) {
      cells.set(key, { top: { x: cx, y: cy, z: cz }, heightMm: height, baseZMm: baseZ });
    }
  }

  return [...cells.values()].sort((p, q) => p.top.z - q.top.z);
}

/**
 * Highest surface strictly below a point, or 0 (the build plate).
 *
 * A pillar that ignores this would pass straight through the part it is
 * supposed to support.
 */
function findSurfaceBelow(
  bvh: MeshBvh,
  mesh: MeshData,
  point: { x: number; y: number; z: number }
): number {
  const bounds = bvh.bounds();
  const min = { x: point.x - 0.01, y: point.y - 0.01, z: bounds.min.z - 1 };
  const max = { x: point.x + 0.01, y: point.y + 0.01, z: point.z - 0.05 };
  let best = 0;
  const idx = mesh.indices;
  const pos = mesh.positions;
  bvh.queryBox(min, max, (t) => {
    // Cheap test: does the triangle's XY footprint contain the point?
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    if (!pointInTriangle2D(point.x, point.y, pos[a], pos[a + 1], pos[b], pos[b + 1], pos[c], pos[c + 1])) {
      return;
    }
    const z = Math.max(pos[a + 2], pos[b + 2], pos[c + 2]);
    if (z < point.z - 0.05 && z > best) best = z;
  });
  return best;
}

function pointInTriangle2D(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Build the pillars as one solid. */
export function buildSupports(
  kernel: GeometryKernel,
  mesh: MeshData,
  settings: SupportSettings,
  hooks: { onProgress?: (fraction: number, labelHe: string) => void; throwIfCancelled?: () => void } = {}
): { solid: Solid | null; result: SupportGenerationResult } {
  hooks.throwIfCancelled?.();
  hooks.onProgress?.(0.15, "סורק משטחים תלויים");
  const candidates = findSupportPoints(mesh, settings);
  hooks.throwIfCancelled?.();
  hooks.onProgress?.(0.6, "בונה עמודי תמיכה");
  const cap = settings.maxPillars ?? DEFAULT_MAX_PILLARS;
  const pillars = candidates.slice(0, cap);
  const skipped = Math.max(0, candidates.length - pillars.length);

  if (pillars.length === 0) {
    return {
      solid: null,
      result: {
        pillars: [],
        skipped: 0,
        volumeMm3: 0,
        summaryHe: "לא נמצאו משטחים תלויים הדורשים תמיכה",
      },
    };
  }

  const tipRadius = Math.max(0.1, settings.tipDiameterMm / 2);
  const baseRadius = Math.max(tipRadius, settings.baseDiameterMm / 2);
  const gap = Math.max(0, settings.contactGapMm);

  const solids: Solid[] = [];
  try {
    for (const pillar of pillars) {
      const height = pillar.top.z - pillar.baseZMm - gap;
      if (height <= 0.1) continue;
      // Cone: wide at the bottom for stability, narrow at the tip so it snaps
      // off cleanly and leaves minimal witness marks.
      solids.push(
        kernel
          .cone(baseRadius, tipRadius, height, 16)
          .translate(pillar.top.x, pillar.top.y, pillar.baseZMm)
      );
    }
  } catch (err) {
    // `unionAll` has not taken ownership yet, so these are ours to free.
    for (const s of solids) s.dispose();
    throw err;
  }

  if (solids.length === 0) {
    return {
      solid: null,
      result: {
        pillars: [],
        skipped,
        volumeMm3: 0,
        summaryHe: "כל התמיכות היו נמוכות מדי מכדי להיבנות",
      },
    };
  }

  // Last safe cancel point: the pillar solids are still individually owned.
  try {
    hooks.throwIfCancelled?.();
  } catch (err) {
    for (const s of solids) s.dispose();
    throw err;
  }
  hooks.onProgress?.(0.85, "מאחד את התמיכות");
  const solid = kernel.unionAll(solids);
  const volume = solid.volumeMm3();
  const parts = [`נוצרו ${pillars.length} תמיכות`];
  if (skipped > 0) parts.push(`${skipped} נוספות דולגו (מעל המגבלה)`);
  parts.push(`נפח חומר: ${volume.toFixed(0)} ממ״ק`);

  return {
    solid,
    result: {
      pillars,
      skipped,
      volumeMm3: volume,
      summaryHe: parts.join(" · "),
    },
  };
}

// ---------------------------------------------------------------------------
// Bridging
// ---------------------------------------------------------------------------

export interface BridgeSpan {
  /** Midpoint of the unsupported span, world mm. */
  center: { x: number; y: number; z: number };
  /** Length of the unsupported run, mm. */
  lengthMm: number;
}

export interface BridgingReport {
  spans: BridgeSpan[];
  longestMm: number;
  summaryHe: string;
}

/**
 * Find horizontal runs of material with nothing beneath them.
 *
 * A printer can bridge a gap by stretching filament between two anchors, but
 * only so far: past roughly 5 mm the strand sags visibly, and past 20 mm it
 * usually fails outright. The overhang analysis misses this entirely, because
 * the underside of a bridge is a perfectly horizontal face — the worst
 * possible overhang angle, yet completely printable if it is short.
 */
export function analyzeBridging(
  mesh: MeshData,
  options: { minSpanMm?: number; sampleStepMm?: number } = {}
): BridgingReport {
  const minSpan = options.minSpanMm ?? 5;
  const bvh = new MeshBvh(mesh);
  const adjacency = buildAdjacency(mesh);
  const idx = mesh.indices;
  const pos = mesh.positions;
  const spans: BridgeSpan[] = [];

  const step = options.sampleStepMm ?? 2;

  for (let t = 0; t < adjacency.triangleCount; t++) {
    // Only near-horizontal downward faces can be bridges.
    if (adjacency.normals[t * 3 + 2] > -0.95) continue;

    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const cx = (pos[a] + pos[b] + pos[c]) / 3;
    const cy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
    const cz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
    if (cz < 0.5) continue; // resting on the plate, not a bridge

    // Nothing below means the span is unsupported here.
    if (findSurfaceBelow(bvh, mesh, { x: cx, y: cy, z: cz }) > 0.05) continue;

    // Merge BEFORE measuring, not after. Every triangle of one physical
    // bridge used to pay for up to 400 BVH probes only to be folded into a
    // span that was already found — which is why a 17k-triangle model took a
    // quarter of a second to report the same two bridges as a 36-triangle
    // one. The radius comes from the span already on record, and never
    // shrinks below the reporting threshold, so a short bridge stays one
    // finding instead of fragmenting into many.
    const covered = spans.find(
      (s) =>
        Math.abs(s.center.z - cz) < 0.5 &&
        Math.hypot(s.center.x - cx, s.center.y - cy) < Math.max(s.lengthMm / 2, minSpan)
    );
    if (covered) continue;

    // Measure how far the unsupported region runs in X and in Y.
    const runX = measureUnsupportedRun(bvh, mesh, cx, cy, cz, step, true);
    const runY = measureUnsupportedRun(bvh, mesh, cx, cy, cz, step, false);
    const length = Math.min(runX, runY);
    if (length < minSpan) continue;

    spans.push({ center: { x: cx, y: cy, z: cz }, lengthMm: length });
  }

  spans.sort((p, q) => q.lengthMm - p.lengthMm);
  const longest = spans[0]?.lengthMm ?? 0;

  let summaryHe: string;
  if (spans.length === 0) {
    summaryHe = "לא נמצאו גישורים ארוכים";
  } else if (longest > 20) {
    summaryHe = `נמצאו ${spans.length} גישורים; הארוך ביותר ${longest.toFixed(1)} מ״מ — סביר שייכשל ללא תמיכה`;
  } else {
    summaryHe = `נמצאו ${spans.length} גישורים; הארוך ביותר ${longest.toFixed(1)} מ״מ — צפוי שקע קל בתחתית`;
  }

  return { spans, longestMm: longest, summaryHe };
}

/** How far the unsupported region extends along one axis, mm. */
function measureUnsupportedRun(
  bvh: MeshBvh,
  mesh: MeshData,
  x: number,
  y: number,
  z: number,
  step: number,
  alongX: boolean
): number {
  const LIMIT = 200;
  let negative = 0;
  let positive = 0;
  for (let d = step; d < LIMIT; d += step) {
    const px = alongX ? x - d : x;
    const py = alongX ? y : y - d;
    if (!isUnsupportedAt(bvh, mesh, px, py, z)) break;
    negative = d;
  }
  for (let d = step; d < LIMIT; d += step) {
    const px = alongX ? x + d : x;
    const py = alongX ? y : y + d;
    if (!isUnsupportedAt(bvh, mesh, px, py, z)) break;
    positive = d;
  }
  return negative + positive;
}

/** True when there is material at (x, y, z) and nothing under it. */
function isUnsupportedAt(
  bvh: MeshBvh,
  mesh: MeshData,
  x: number,
  y: number,
  z: number
): boolean {
  const idx = mesh.indices;
  const pos = mesh.positions;
  let hasCeiling = false;
  bvh.queryBox(
    { x: x - 0.01, y: y - 0.01, z: z - 0.2 },
    { x: x + 0.01, y: y + 0.01, z: z + 0.2 },
    (t) => {
      if (hasCeiling) return;
      const a = idx[t * 3] * 3;
      const b = idx[t * 3 + 1] * 3;
      const c = idx[t * 3 + 2] * 3;
      if (pointInTriangle2D(x, y, pos[a], pos[a + 1], pos[b], pos[b + 1], pos[c], pos[c + 1])) {
        hasCeiling = true;
      }
    }
  );
  if (!hasCeiling) return false;
  return findSurfaceBelow(bvh, mesh, { x, y, z }) <= 0.05;
}
