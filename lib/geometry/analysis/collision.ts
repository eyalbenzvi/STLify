/**
 * Interference detection and build-plate arrangement.
 *
 * Interference: two parts that overlap in space cannot be assembled, and the
 * existing overlap warning only fires inside the boolean dialog. This checks
 * every visible pair and reports the overlapping volume, which is the
 * difference between "these touch" (fine) and "these interpenetrate" (a bug
 * that will not be discovered until the parts are printed).
 *
 * Arrangement: a simple shelf-packing of part footprints onto the plate, so a
 * multi-part design can be laid out without dragging each piece by hand.
 */

import type { PrintablePart } from "../buildDocument";
import { getGeometryKernel } from "../kernel";

export interface InterferencePair {
  layerIdA: string;
  layerIdB: string;
  nameA: string;
  nameB: string;
  /** Volume shared by both bodies, mm³. */
  overlapVolumeMm3: number;
  /** Overlap as a fraction of the smaller body, 0..1. */
  overlapFraction: number;
  /** Centre of the overlapping region, for camera navigation. */
  location: { x: number; y: number; z: number };
}

export interface InterferenceReport {
  pairs: InterferencePair[];
  checkedPairs: number;
  /** Hebrew summary. */
  summaryHe: string;
}

/**
 * Volume below which an overlap is treated as modelling noise rather than a
 * real interference. Parts designed to touch overlap by a hair because of the
 * pipeline's own 0.05mm boolean overlap.
 */
const NOISE_VOLUME_MM3 = 0.01;

/** Check every pair of parts for interpenetration. */
export async function detectInterference(
  parts: PrintablePart[]
): Promise<InterferenceReport> {
  const kernel = await getGeometryKernel();
  const pairs: InterferencePair[] = [];
  let checkedPairs = 0;

  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i];
      const b = parts[j];
      if (a.worldMesh.indices.length === 0 || b.worldMesh.indices.length === 0) continue;

      // Cheap rejection first: disjoint bounding boxes cannot overlap.
      if (!boxesOverlap(a, b)) {
        checkedPairs++;
        continue;
      }

      const solidA = kernel.fromMeshData(a.worldMesh);
      if (solidA.status !== "NoError") {
        solidA.solid.dispose();
        continue;
      }
      const solidB = kernel.fromMeshData(b.worldMesh);
      if (solidB.status !== "NoError") {
        solidA.solid.dispose();
        solidB.solid.dispose();
        continue;
      }
      const volumeA = solidA.solid.volumeMm3();
      const volumeB = solidB.solid.volumeMm3();
      const overlap = solidA.solid.intersect(solidB.solid);
      const overlapVolume = overlap.isEmpty() ? 0 : overlap.volumeMm3();
      const box = overlap.isEmpty() ? null : overlap.boundingBox();
      overlap.dispose();
      checkedPairs++;

      if (overlapVolume > NOISE_VOLUME_MM3 && box) {
        pairs.push({
          layerIdA: a.primaryLayerId,
          layerIdB: b.primaryLayerId,
          nameA: a.nameHe,
          nameB: b.nameHe,
          overlapVolumeMm3: overlapVolume,
          overlapFraction: overlapVolume / Math.max(1e-9, Math.min(volumeA, volumeB)),
          location: {
            x: (box.min.x + box.max.x) / 2,
            y: (box.min.y + box.max.y) / 2,
            z: (box.min.z + box.max.z) / 2,
          },
        });
      }
    }
  }

  pairs.sort((x, y) => y.overlapVolumeMm3 - x.overlapVolumeMm3);
  return {
    pairs,
    checkedPairs,
    summaryHe:
      pairs.length === 0
        ? `נבדקו ${checkedPairs} זוגות — לא נמצאה חדירה בין חלקים`
        : `נמצאו ${pairs.length} זוגות חלקים שחודרים זה לזה`,
  };
}

function boxesOverlap(a: PrintablePart, b: PrintablePart): boolean {
  const ab = a.stats.bounds;
  const bb = b.stats.bounds;
  return !(
    ab.max.x <= bb.min.x ||
    bb.max.x <= ab.min.x ||
    ab.max.y <= bb.min.y ||
    bb.max.y <= ab.min.y ||
    ab.max.z <= bb.min.z ||
    bb.max.z <= ab.min.z
  );
}

// ---------------------------------------------------------------------------
// Build-plate arrangement
// ---------------------------------------------------------------------------

export interface ArrangeItem {
  layerId: string;
  /** Footprint of the part on the plate, mm (axis-aligned fallback). */
  widthMm: number;
  depthMm: number;
  /** Current XY centre, mm. */
  currentX: number;
  currentY: number;
  /**
   * The REAL footprint: convex hull of the part's XY projection, relative
   * to (currentX, currentY). When present, rotation candidates measure the
   * rotated hull's tight box instead of the axis-aligned box — a part lying
   * diagonally stops costing its huge AABB.
   */
  hull?: [number, number][];
  /** Whether this item may be rotated (default true). */
  allowRotation?: boolean;
}

export interface ArrangePlacement {
  layerId: string;
  /** New XY centre OF THE PART, mm (hull offset already accounted for). */
  x: number;
  y: number;
  /** Chosen rotation about the part's centre, CCW degrees. */
  rotationDeg: number;
}

export interface ArrangeResult {
  placements: ArrangePlacement[];
  /** Items that did not fit on the plate. */
  unplaced: string[];
  summaryHe: string;
}

export interface ArrangeSettings {
  plateWidthMm: number;
  plateDepthMm: number;
  /** Gap left between parts and around the plate edge, mm. */
  spacingMm: number;
  /** Rotation candidate step (default 15°; rectangles only benefit at 90°). */
  rotationStepDeg?: number;
}

/** Convex hull of XY points (Andrew's monotone chain), CCW. */
export function convexHullXY(points: readonly [number, number][]): [number, number][] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length <= 2) return sorted;
  const cross = (o: number[], a: number[], b: number[]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

interface Orientation {
  angleDeg: number;
  widthMm: number;
  depthMm: number;
  /** Offset from the part centre to the rotated footprint's box centre. */
  offsetX: number;
  offsetY: number;
}

/** Tight box of the item's footprint rotated by `angleDeg` about its centre. */
function orientationAt(item: ArrangeItem, angleDeg: number): Orientation {
  const hull: [number, number][] =
    item.hull && item.hull.length >= 3
      ? item.hull
      : [
          [-item.widthMm / 2, -item.depthMm / 2],
          [item.widthMm / 2, -item.depthMm / 2],
          [item.widthMm / 2, item.depthMm / 2],
          [-item.widthMm / 2, item.depthMm / 2],
        ];
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of hull) {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }
  return {
    angleDeg,
    widthMm: maxX - minX,
    depthMm: maxY - minY,
    offsetX: (minX + maxX) / 2,
    offsetY: (minY + maxY) / 2,
  };
}

/**
 * Best orientation for shelf packing: the first candidate, ordered by
 * (fits, depth, width, angle). Minimum depth keeps shelves short — the
 * dominant term in shelf-packing utilisation — and the full ordering makes
 * the choice DETERMINISTIC (the existing arrange(x)===arrange(x) test is a
 * contract).
 */
function bestOrientation(
  item: ArrangeItem,
  usableWidth: number,
  usableDepth: number,
  stepDeg: number
): Orientation | null {
  const angles: number[] = [0];
  if (item.allowRotation !== false) {
    for (let a = stepDeg; a < 180; a += stepDeg) angles.push(a);
    if (!angles.includes(90)) angles.push(90);
  }
  const candidates = angles.map((a) => orientationAt(item, a));
  candidates.sort(
    (a, b) => a.depthMm - b.depthMm || a.widthMm - b.widthMm || a.angleDeg - b.angleDeg
  );
  return (
    candidates.find((c) => c.widthMm <= usableWidth && c.depthMm <= usableDepth) ?? null
  );
}

/**
 * Shelf-pack part footprints onto the plate.
 *
 * V6: each part first picks its best ORIENTATION — rotation candidates in
 * `rotationStepDeg` steps, measured on the real convex hull of its
 * projection when provided — then parts are sorted tallest-footprint first
 * and laid into rows (first-fit decreasing height). Still simple, still
 * stable, and elongated or diagonal parts stop wasting the plate. Anything
 * that cannot fit in ANY orientation is reported rather than silently
 * stacked.
 */
export function arrangeOnPlate(
  items: ArrangeItem[],
  settings: ArrangeSettings
): ArrangeResult {
  const gap = Math.max(0, settings.spacingMm);
  const usableWidth = settings.plateWidthMm - gap * 2;
  const usableDepth = settings.plateDepthMm - gap * 2;
  const stepDeg = Math.max(1, settings.rotationStepDeg ?? 15);

  const oriented = items.map((item) => ({
    item,
    orientation: bestOrientation(item, usableWidth, usableDepth, stepDeg),
  }));
  oriented.sort(
    (a, b) => (b.orientation?.depthMm ?? 0) - (a.orientation?.depthMm ?? 0)
  );

  const placements: ArrangePlacement[] = [];
  const unplaced: string[] = [];

  let rowY = -usableDepth / 2;
  let rowHeight = 0;
  let cursorX = -usableWidth / 2;

  for (const { item, orientation } of oriented) {
    if (!orientation) {
      unplaced.push(item.layerId);
      continue;
    }
    // Start a new row when this part would run off the right edge.
    if (cursorX + orientation.widthMm > usableWidth / 2) {
      rowY += rowHeight + gap;
      rowHeight = 0;
      cursorX = -usableWidth / 2;
    }
    if (rowY + orientation.depthMm > usableDepth / 2) {
      unplaced.push(item.layerId);
      continue;
    }
    // The box goes on the shelf; the PART centre is the box centre minus
    // the rotated footprint's own offset.
    placements.push({
      layerId: item.layerId,
      x: cursorX + orientation.widthMm / 2 - orientation.offsetX,
      y: rowY + orientation.depthMm / 2 - orientation.offsetY,
      rotationDeg: orientation.angleDeg,
    });
    cursorX += orientation.widthMm + gap;
    rowHeight = Math.max(rowHeight, orientation.depthMm);
  }

  return {
    placements,
    unplaced,
    summaryHe:
      unplaced.length === 0
        ? `${placements.length} חלקים סודרו על המשטח`
        : `${placements.length} חלקים סודרו; ${unplaced.length} לא נכנסו למשטח`,
  };
}
