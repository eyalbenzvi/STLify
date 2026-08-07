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
  /** Footprint of the part on the plate, mm. */
  widthMm: number;
  depthMm: number;
  /** Current XY centre, mm. */
  currentX: number;
  currentY: number;
}

export interface ArrangePlacement {
  layerId: string;
  /** New XY centre, mm. */
  x: number;
  y: number;
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
}

/**
 * Shelf-pack part footprints onto the plate.
 *
 * Parts are sorted tallest-footprint first and laid into rows, which is the
 * classic first-fit-decreasing-height heuristic: simple, stable (the same
 * input always gives the same layout) and good enough that users rarely
 * rearrange afterwards. Anything that cannot fit is reported rather than
 * silently stacked.
 */
export function arrangeOnPlate(
  items: ArrangeItem[],
  settings: ArrangeSettings
): ArrangeResult {
  const gap = Math.max(0, settings.spacingMm);
  const usableWidth = settings.plateWidthMm - gap * 2;
  const usableDepth = settings.plateDepthMm - gap * 2;

  const sorted = [...items].sort((a, b) => b.depthMm - a.depthMm);
  const placements: ArrangePlacement[] = [];
  const unplaced: string[] = [];

  let rowY = -usableDepth / 2;
  let rowHeight = 0;
  let cursorX = -usableWidth / 2;

  for (const item of sorted) {
    if (item.widthMm > usableWidth || item.depthMm > usableDepth) {
      unplaced.push(item.layerId);
      continue;
    }
    // Start a new row when this part would run off the right edge.
    if (cursorX + item.widthMm > usableWidth / 2) {
      rowY += rowHeight + gap;
      rowHeight = 0;
      cursorX = -usableWidth / 2;
    }
    if (rowY + item.depthMm > usableDepth / 2) {
      unplaced.push(item.layerId);
      continue;
    }
    placements.push({
      layerId: item.layerId,
      x: cursorX + item.widthMm / 2,
      y: rowY + item.depthMm / 2,
    });
    cursorX += item.widthMm + gap;
    rowHeight = Math.max(rowHeight, item.depthMm);
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
