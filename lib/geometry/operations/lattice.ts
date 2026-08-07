/**
 * Internal lattice infill.
 *
 * `hollow.ts` empties a body completely, which saves the most material but
 * gives up nearly all of the stiffness. A lattice fills the cavity with a
 * periodic minimal surface instead: typically 70-90% of the material saved
 * while keeping the part rigid, and — unlike slicer infill — the structure is
 * real geometry that survives export, so it prints identically everywhere.
 *
 * Gyroid and Schwarz-P are triply periodic minimal surfaces (TPMS) defined by
 * a single implicit equation, which is exactly what `kernel.levelSet` wants.
 * Honeycomb is a straight prismatic extrusion of a hex grid.
 */

import type { BoxBounds, Contour, GeometryKernel, Solid } from "../kernel";
import { OpError } from "./layerOps";

export type LatticeKind = "gyroid" | "schwarzP" | "honeycomb";

export interface LatticeSettings {
  kind: LatticeKind;
  /** Repeat length of one lattice cell, mm. */
  cellSizeMm: number;
  /** Wall thickness of the lattice struts, mm. */
  thicknessMm: number;
  /** Solid skin left on the outside of the part, mm. */
  shellThicknessMm: number;
}

export interface LatticeOutcome {
  solid: Solid;
  volumeBeforeMm3: number;
  volumeAfterMm3: number;
  /** Fraction of the original material removed, 0..1. */
  savedFraction: number;
  warningsHe: string[];
}

/** Voxel budget for the level-set evaluation. */
const MAX_LEVELSET_CELLS = 12_000_000;

/**
 * Signed-distance-like field for a TPMS. Positive inside the strut.
 *
 * The classic gyroid equation sin x cos y + sin y cos z + sin z cos x = 0
 * describes an infinitely thin surface; taking `thickness - |f|` thickens it
 * into a printable double-sided wall.
 */
function tpmsField(
  kind: Exclude<LatticeKind, "honeycomb">,
  cellSizeMm: number,
  thicknessMm: number
): (p: { x: number; y: number; z: number }) => number {
  const k = (Math.PI * 2) / cellSizeMm;
  // The implicit value is dimensionless; this converts it to roughly mm so
  // the thickness parameter behaves like a real wall thickness.
  const scale = cellSizeMm / (Math.PI * 2);
  if (kind === "gyroid") {
    return (p) => {
      const x = p.x * k;
      const y = p.y * k;
      const z = p.z * k;
      const f =
        Math.sin(x) * Math.cos(y) + Math.sin(y) * Math.cos(z) + Math.sin(z) * Math.cos(x);
      return thicknessMm / 2 - Math.abs(f) * scale;
    };
  }
  return (p) => {
    const f =
      Math.cos(p.x * k) + Math.cos(p.y * k) + Math.cos(p.z * k);
    return thicknessMm / 2 - Math.abs(f) * scale;
  };
}

/** A hexagonal grid of prisms spanning the given bounds. */
function honeycombSolid(
  kernel: GeometryKernel,
  bounds: BoxBounds,
  cellSizeMm: number,
  thicknessMm: number
): Solid {
  const height = bounds.max.z - bounds.min.z;
  const r = cellSizeMm / 2;
  // Hex grid spacing.
  const dx = r * 1.5;
  const dy = r * Math.sqrt(3);
  const contours: Contour[] = [];
  const cols = Math.ceil((bounds.max.x - bounds.min.x) / dx) + 2;
  const rows = Math.ceil((bounds.max.y - bounds.min.y) / dy) + 2;
  if (cols * rows > 20_000) {
    throw new OpError("תא חלת הדבש קטן מדי ביחס לגודל הגוף", [
      "הגדילו את גודל התא",
    ]);
  }
  // Each cell is a hexagonal RING: the outline minus an inset copy.
  const inner = Math.max(0.01, r - thicknessMm);
  for (let i = -1; i < cols; i++) {
    for (let j = -1; j < rows; j++) {
      const cx = bounds.min.x + i * dx;
      const cy = bounds.min.y + j * dy + (i % 2 === 0 ? 0 : dy / 2);
      const outerHex: Contour = [];
      const innerHex: Contour = [];
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        outerHex.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        innerHex.push([cx + inner * Math.cos(a), cy + inner * Math.sin(a)]);
      }
      contours.push(outerHex, innerHex.reverse());
    }
  }
  return kernel
    .extrude(contours, height)
    .translate(0, 0, bounds.min.z);
}

/**
 * Replace a solid's interior with a lattice, keeping a solid outer skin.
 *
 * Consumes `solid`.
 */
export function latticeFill(
  kernel: GeometryKernel,
  solid: Solid,
  settings: LatticeSettings
): LatticeOutcome {
  const { cellSizeMm, thicknessMm, shellThicknessMm } = settings;
  if (!(cellSizeMm > 0)) {
    solid.dispose();
    throw new OpError("גודל התא חייב להיות גדול מאפס");
  }
  if (!(thicknessMm > 0)) {
    solid.dispose();
    throw new OpError("עובי הסריג חייב להיות גדול מאפס");
  }
  if (thicknessMm >= cellSizeMm / 2) {
    solid.dispose();
    throw new OpError("עובי הסריג גדול מדי ביחס לגודל התא — לא ייווצר חלל");
  }
  if (!(shellThicknessMm > 0)) {
    solid.dispose();
    throw new OpError("עובי המעטפת חייב להיות גדול מאפס");
  }

  const warningsHe: string[] = [];
  const volumeBefore = solid.volumeMm3();
  const bounds = solid.boundingBox();
  const smallest = Math.min(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z
  );
  if (shellThicknessMm >= smallest / 2) {
    solid.dispose();
    throw new OpError("עובי המעטפת גדול מדי — לא נותר חלל למילוי");
  }

  // Carve the interior: erode by the shell thickness to get the region the
  // lattice may occupy.
  const shellBall = kernel.sphere(shellThicknessMm, 10);
  let proxy = solid.duplicate();
  if (proxy.numTriangles() > 6000) {
    proxy = proxy.simplify(Math.min(shellThicknessMm * 0.3, 0.4));
    warningsHe.push("המודל מורכב — עובי המעטפת בפועל עשוי לסטות מעט");
  }
  const interior = proxy.minkowskiDifference(shellBall);
  if (interior.isEmpty()) {
    interior.dispose();
    solid.dispose();
    throw new OpError("עובי המעטפת גדול מדי — לא נותר חלל למילוי");
  }

  // Build the lattice over the interior's bounds, then clip it to the
  // interior so struts never poke through the skin.
  const interiorBounds = interior.boundingBox();
  const pad = cellSizeMm;
  const fieldBounds: BoxBounds = {
    min: {
      x: interiorBounds.min.x - pad,
      y: interiorBounds.min.y - pad,
      z: interiorBounds.min.z - pad,
    },
    max: {
      x: interiorBounds.max.x + pad,
      y: interiorBounds.max.y + pad,
      z: interiorBounds.max.z + pad,
    },
  };

  let lattice: Solid;
  if (settings.kind === "honeycomb") {
    lattice = honeycombSolid(kernel, fieldBounds, cellSizeMm, thicknessMm);
  } else {
    // Resolve the strut wall with several voxels across it.
    let voxel = Math.min(thicknessMm / 2.5, cellSizeMm / 10);
    const cells =
      ((fieldBounds.max.x - fieldBounds.min.x) / voxel) *
      ((fieldBounds.max.y - fieldBounds.min.y) / voxel) *
      ((fieldBounds.max.z - fieldBounds.min.z) / voxel);
    if (cells > MAX_LEVELSET_CELLS) {
      voxel *= Math.cbrt(cells / MAX_LEVELSET_CELLS);
      warningsHe.push(
        "הסריג עדין ביחס לגודל הגוף — הרזולוציה הופחתה כדי לא לתקוע את הדפדפן"
      );
    }
    lattice = kernel.levelSet(
      tpmsField(settings.kind, cellSizeMm, thicknessMm),
      fieldBounds,
      voxel
    );
  }

  if (lattice.isEmpty()) {
    lattice.dispose();
    interior.dispose();
    solid.dispose();
    throw new OpError("יצירת הסריג נכשלה — נסו תא גדול יותר או עובי גדול יותר");
  }

  // `intersect` consumes both operands, so keep a second handle on the
  // interior: it is needed again as the cutter that hollows the shell.
  const interiorCutter = interior.duplicate();
  const clipped = lattice.intersect(interior);

  // result = (original minus interior) union (lattice clipped to interior):
  // a solid skin of `shellThicknessMm` with the lattice filling the void.
  const hollowShell = solid.duplicate().subtract(interiorCutter);
  const result = hollowShell.union(clipped);
  solid.dispose();

  if (result.status() !== "NoError" || result.isEmpty()) {
    result.dispose();
    throw new OpError("מילוי הסריג נכשל — נסו פרמטרים אחרים");
  }

  const volumeAfter = result.volumeMm3();
  return {
    solid: result,
    volumeBeforeMm3: volumeBefore,
    volumeAfterMm3: volumeAfter,
    savedFraction: volumeBefore > 0 ? 1 - volumeAfter / volumeBefore : 0,
    warningsHe,
  };
}
