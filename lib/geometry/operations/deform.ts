/**
 * Free-form deformation: bend, twist, taper, stretch and an FFD cage.
 *
 * All of these move vertices without changing topology (`kernel.warp`), so
 * the result stays manifold as long as the deformation does not fold the
 * surface through itself. That caveat is real, so every operation bounds its
 * parameters and the result is re-validated by the caller through the
 * standard manifold gate.
 *
 * A coarse mesh deforms badly — a box has no vertices in the middle of a
 * face to bend. Every operation therefore refines the mesh first, to a
 * density derived from the deformation's own curvature. This is why bending
 * a primitive cube produces a smooth arc rather than a sheared box.
 */

import type { Solid } from "../kernel";
import { OpError } from "./layerOps";

export type DeformAxis = "x" | "y" | "z";

/** Triangle ceiling after refinement, to keep the browser responsive. */
const MAX_REFINED_TRIS = 200_000;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function axisValue(p: Vec3, axis: DeformAxis): number {
  return axis === "x" ? p.x : axis === "y" ? p.y : p.z;
}

/**
 * Refine so the deformation has vertices to act on.
 *
 * `targetEdgeMm` should be roughly the length over which the deformation
 * changes appreciably; finer than that is wasted, coarser is visibly faceted.
 */
function refineForDeformation(solid: Solid, targetEdgeMm: number): Solid {
  if (!(targetEdgeMm > 0)) return solid;
  const bounds = solid.boundingBox();
  const span = Math.max(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z
  );
  if (span <= 0) return solid;
  // Estimate the triangle count the refinement would produce and back off
  // rather than locking up the tab.
  const currentTris = solid.numTriangles();
  const factor = Math.max(1, span / targetEdgeMm);
  let edge = targetEdgeMm;
  if (currentTris * factor * factor > MAX_REFINED_TRIS) {
    edge = span / Math.sqrt(MAX_REFINED_TRIS / Math.max(1, currentTris));
  }
  return solid.refineToLength(edge);
}

export interface TwistSettings {
  axis: DeformAxis;
  /** Total rotation from the low end of the axis to the high end. */
  degrees: number;
}

/** Twist a solid around an axis. Consumes `solid`. */
export function twistSolid(solid: Solid, settings: TwistSettings): Solid {
  const { axis, degrees } = settings;
  if (degrees === 0) return solid;
  const bounds = solid.boundingBox();
  const lo = axisValue(bounds.min, axis);
  const hi = axisValue(bounds.max, axis);
  const span = hi - lo;
  if (span <= 0) return solid;

  // One refinement step per ~10 degrees of twist keeps facets invisible.
  const steps = Math.max(4, Math.abs(degrees) / 10);
  const refined = refineForDeformation(solid, span / steps);

  return refined.warp((p) => {
    const t = (axisValue(p, axis) - lo) / span;
    const angle = (t * degrees * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    if (axis === "z") return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos, z: p.z };
    if (axis === "y") return { x: p.x * cos + p.z * sin, y: p.y, z: -p.x * sin + p.z * cos };
    return { x: p.x, y: p.y * cos - p.z * sin, z: p.y * sin + p.z * cos };
  });
}

export interface TaperSettings {
  axis: DeformAxis;
  /** Scale applied to the cross-section at the HIGH end of the axis. */
  endScale: number;
}

/** Linearly scale the cross-section along an axis. Consumes `solid`. */
export function taperSolid(solid: Solid, settings: TaperSettings): Solid {
  const { axis, endScale } = settings;
  if (endScale === 1) return solid;
  if (endScale < 0) {
    solid.dispose();
    throw new OpError("יחס ההתחדדות אינו יכול להיות שלילי");
  }
  const bounds = solid.boundingBox();
  const lo = axisValue(bounds.min, axis);
  const hi = axisValue(bounds.max, axis);
  const span = hi - lo;
  if (span <= 0) return solid;

  // A linear taper is exact on straight edges; a light refinement is enough.
  const refined = refineForDeformation(solid, span / 8);
  return refined.warp((p) => {
    const t = (axisValue(p, axis) - lo) / span;
    const scale = 1 + t * (endScale - 1);
    if (axis === "z") return { x: p.x * scale, y: p.y * scale, z: p.z };
    if (axis === "y") return { x: p.x * scale, y: p.y, z: p.z * scale };
    return { x: p.x, y: p.y * scale, z: p.z * scale };
  });
}

export interface BendSettings {
  /** Axis along which the body is bent (the "long" axis). */
  axis: DeformAxis;
  /** Total bend angle over the body's length, degrees. */
  degrees: number;
  /**
   * Which axis the body curls towards. Must differ from `axis`. Bending a
   * nameplate along X towards Z wraps it over a cylinder lying along Y.
   */
  towards: DeformAxis;
}

/**
 * Bend a body around a circular arc — the operation that wraps a flat plate
 * onto a curved surface (bracelets, curved signs, cylinder labels).
 *
 * The body's extent along `axis` is mapped onto an arc of `degrees`; the
 * offset along `towards` becomes a radial offset, so thickness is preserved.
 * Consumes `solid`.
 */
export function bendSolid(solid: Solid, settings: BendSettings): Solid {
  const { axis, towards, degrees } = settings;
  if (axis === towards) {
    solid.dispose();
    throw new OpError("ציר הכיפוף וציר הכיוון חייבים להיות שונים");
  }
  if (degrees === 0) return solid;
  if (Math.abs(degrees) > 350) {
    solid.dispose();
    throw new OpError("זווית הכיפוף מוגבלת ל-350 מעלות (מעבר לכך הגוף חופף לעצמו)");
  }

  const bounds = solid.boundingBox();
  const lo = axisValue(bounds.min, axis);
  const hi = axisValue(bounds.max, axis);
  const length = hi - lo;
  if (length <= 0) return solid;

  const angleRad = (degrees * Math.PI) / 180;
  // Arc length equals the body length, so radius = length / angle.
  const radius = length / Math.abs(angleRad);

  // The body must have vertices along the bend to follow the arc.
  const steps = Math.max(8, Math.abs(degrees) / 5);
  const refined = refineForDeformation(solid, length / steps);

  const sign = Math.sign(angleRad);
  const centre = (lo + hi) / 2;

  return refined.warp((p) => {
    const along = axisValue(p, axis) - centre;
    const radial = axisValue(p, towards);
    // Angle swept by this slice, measured from the body's centre.
    const theta = (along / radius) * sign;
    const effectiveRadius = radius - sign * radial;
    const newAlong = effectiveRadius * Math.sin(theta);
    const newRadial = sign * (radius - effectiveRadius * Math.cos(theta));

    const out: Vec3 = { x: p.x, y: p.y, z: p.z };
    if (axis === "x") out.x = newAlong;
    else if (axis === "y") out.y = newAlong;
    else out.z = newAlong;
    if (towards === "x") out.x = newRadial;
    else if (towards === "y") out.y = newRadial;
    else out.z = newRadial;
    return out;
  });
}

export interface StretchSettings {
  axis: DeformAxis;
  /** Where along the axis the stretch is centred, 0..1 of the body's extent. */
  center: number;
  /** Scale applied at the centre; falls off to 1 at both ends. */
  amount: number;
  /** Width of the affected region, 0..1 of the body's extent. */
  falloff: number;
}

/**
 * A localised bulge or pinch (a "spherify"/"stretch" brush without needing a
 * sculpting mode). Consumes `solid`.
 */
export function stretchSolid(solid: Solid, settings: StretchSettings): Solid {
  const { axis, amount } = settings;
  if (amount === 1) return solid;
  if (amount <= 0) {
    solid.dispose();
    throw new OpError("עוצמת המתיחה חייבת להיות גדולה מאפס");
  }
  const bounds = solid.boundingBox();
  const lo = axisValue(bounds.min, axis);
  const hi = axisValue(bounds.max, axis);
  const span = hi - lo;
  if (span <= 0) return solid;

  const falloff = Math.max(0.05, Math.min(settings.falloff, 1));
  const center = Math.max(0, Math.min(settings.center, 1));
  const refined = refineForDeformation(solid, (span * falloff) / 6);

  return refined.warp((p) => {
    const t = (axisValue(p, axis) - lo) / span;
    const distance = Math.abs(t - center) / falloff;
    // Smooth cosine falloff, zero outside the affected band.
    const weight = distance >= 1 ? 0 : 0.5 * (1 + Math.cos(distance * Math.PI));
    const scale = 1 + (amount - 1) * weight;
    if (axis === "z") return { x: p.x * scale, y: p.y * scale, z: p.z };
    if (axis === "y") return { x: p.x * scale, y: p.y, z: p.z * scale };
    return { x: p.x, y: p.y * scale, z: p.z * scale };
  });
}

// ---------------------------------------------------------------------------
// Free-form deformation cage
// ---------------------------------------------------------------------------

export interface FfdSettings {
  /** Control points per axis (2..4). */
  resolution: { x: number; y: number; z: number };
  /**
   * Displacement of each control point, mm, indexed
   * [ix + nx * (iy + ny * iz)]. Points left at zero do not move.
   */
  displacements: Vec3[];
}

/**
 * Trilinear free-form deformation over a control cage.
 *
 * The cage spans the body's bounding box; each vertex is displaced by the
 * trilinear blend of its surrounding control points. A 2x2x2 cage reproduces
 * shear and taper; 3x3x3 and 4x4x4 give the organic bulges that are
 * impossible to reach with axis-aligned operations.
 *
 * Consumes `solid`.
 */
export function ffdSolid(solid: Solid, settings: FfdSettings): Solid {
  const nx = Math.max(2, Math.min(Math.round(settings.resolution.x), 4));
  const ny = Math.max(2, Math.min(Math.round(settings.resolution.y), 4));
  const nz = Math.max(2, Math.min(Math.round(settings.resolution.z), 4));
  const expected = nx * ny * nz;
  if (settings.displacements.length !== expected) {
    solid.dispose();
    throw new OpError(
      `מספר נקודות הבקרה אינו תואם לרזולוציה (נדרשות ${expected})`
    );
  }
  if (settings.displacements.every((d) => d.x === 0 && d.y === 0 && d.z === 0)) {
    return solid;
  }

  const bounds = solid.boundingBox();
  const sizeX = bounds.max.x - bounds.min.x || 1;
  const sizeY = bounds.max.y - bounds.min.y || 1;
  const sizeZ = bounds.max.z - bounds.min.z || 1;

  // One refinement per cage cell, so each cell can actually curve.
  const cell = Math.min(sizeX / (nx - 1), sizeY / (ny - 1), sizeZ / (nz - 1));
  const refined = refineForDeformation(solid, cell / 4);

  const at = (ix: number, iy: number, iz: number): Vec3 =>
    settings.displacements[ix + nx * (iy + ny * iz)];

  return refined.warp((p) => {
    // Normalised position inside the cage, clamped to its faces.
    const u = Math.max(0, Math.min((p.x - bounds.min.x) / sizeX, 1)) * (nx - 1);
    const v = Math.max(0, Math.min((p.y - bounds.min.y) / sizeY, 1)) * (ny - 1);
    const w = Math.max(0, Math.min((p.z - bounds.min.z) / sizeZ, 1)) * (nz - 1);
    const i0 = Math.min(Math.floor(u), nx - 2);
    const j0 = Math.min(Math.floor(v), ny - 2);
    const k0 = Math.min(Math.floor(w), nz - 2);
    const fu = u - i0;
    const fv = v - j0;
    const fw = w - k0;

    let dx = 0;
    let dy = 0;
    let dz = 0;
    for (let di = 0; di <= 1; di++) {
      const wu = di === 0 ? 1 - fu : fu;
      for (let dj = 0; dj <= 1; dj++) {
        const wv = dj === 0 ? 1 - fv : fv;
        for (let dk = 0; dk <= 1; dk++) {
          const ww = dk === 0 ? 1 - fw : fw;
          const weight = wu * wv * ww;
          if (weight === 0) continue;
          const d = at(i0 + di, j0 + dj, k0 + dk);
          dx += d.x * weight;
          dy += d.y * weight;
          dz += d.z * weight;
        }
      }
    }
    return { x: p.x + dx, y: p.y + dy, z: p.z + dz };
  });
}
