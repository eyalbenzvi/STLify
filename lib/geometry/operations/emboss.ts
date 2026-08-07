/**
 * Embossing and engraving onto curved surfaces.
 *
 * Text and SVG artwork could only ever ride the flat base plate: a raised or
 * engraved layer is a straight prism, so on a mug, a ring, a bottle or a
 * domed plaque it either floats above the surface or buries itself in it.
 * This module makes the artwork follow the surface it is applied to.
 *
 * Two strategies, because they suit different shapes:
 *
 *   • CYLINDRICAL WRAP — analytic and exact. The artwork's flat XY plane is
 *     rolled onto a cylinder of a given radius: X becomes arc length, Y stays
 *     along the axis, and the extrusion depth becomes radial. Correct for
 *     mugs, rings, bottles, bracelets and pipe labels.
 *
 *   • SURFACE PROJECTION — general. The artwork is extruded into a long prism
 *     and each of its vertices is pushed onto the target's surface along the
 *     projection direction, using the kernel's exact ray casts. Correct for
 *     domes, freeform scans and anything a formula cannot describe.
 *
 * Both produce a solid that is then unioned onto the target (emboss) or
 * subtracted from it (engrave) through the normal boolean path, so the result
 * is manifold and printable.
 */

import type { Contour, GeometryKernel, Solid } from "../kernel";
import { OpError } from "./layerOps";

export type EmbossMode = "raised" | "engraved";

export interface CylindricalWrapSettings {
  /** Radius of the surface the artwork is wrapped onto, mm. */
  radiusMm: number;
  /** Height of the raised relief / depth of the engraving, mm. */
  depthMm: number;
  mode: EmbossMode;
  /**
   * Axis the cylinder runs along. The artwork's local +X wraps around it and
   * local +Y runs along it.
   */
  axis: "x" | "y" | "z";
  /** Rotate the artwork around the cylinder, degrees. */
  aroundDeg: number;
  /** Slide the artwork along the cylinder axis, mm. */
  alongMm: number;
  /**
   * Subdivision along the wrap direction. Too coarse and straight strokes
   * become visibly faceted chords instead of following the curve.
   */
  segmentsPerMm?: number;
}

/** Overlap so the wrapped body never meets the target on a coplanar face. */
const OVERLAP_MM = 0.05;

/**
 * Wrap flat contours onto a cylinder.
 *
 * The artwork is extruded radially and then bent: a point at flat coordinate
 * (x, y) with radial offset r lands at angle x / radius around the axis. The
 * mesh is refined first so the bend is smooth — an unrefined letter stroke
 * would keep its straight edges and cut through the curved surface.
 */
export function wrapContoursOnCylinder(
  kernel: GeometryKernel,
  contours: Contour[],
  settings: CylindricalWrapSettings
): Solid {
  const { radiusMm, depthMm, mode } = settings;
  if (!(radiusMm > 0)) throw new OpError("רדיוס העטיפה חייב להיות גדול מאפס");
  if (!(depthMm > 0)) throw new OpError("עומק ההטבעה חייב להיות גדול מאפס");
  if (contours.length === 0) throw new OpError("אין מתאר להטבעה");

  // Total arc the artwork spans; beyond a full turn it would overlap itself.
  let minX = Infinity;
  let maxX = -Infinity;
  for (const contour of contours) {
    for (const [x] of contour) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  const width = maxX - minX;
  const circumference = 2 * Math.PI * radiusMm;
  if (width > circumference) {
    throw new OpError(
      `הכיתוב רחב מהיקף הגליל (${width.toFixed(1)} מ״מ מול ${circumference.toFixed(1)} מ״מ)`,
      ["הקטינו את הטקסט", "או הגדילו את רדיוס העטיפה"]
    );
  }

  // Extrude radially: z in [0, depth + overlap], measured outward from the
  // surface for a relief, inward for an engraving.
  const height = depthMm + OVERLAP_MM;
  let flat = kernel.extrude(contours, height);

  // Refine so the wrap has vertices to bend. One segment per ~0.5mm of arc
  // keeps the chord error well under a printer's resolution.
  const perMm = settings.segmentsPerMm ?? 2;
  const targetEdge = Math.max(0.2, 1 / Math.max(perMm, 0.1));
  flat = flat.refineToLength(targetEdge);

  // Bend: flat x -> angle, flat z -> radius.
  const aroundRad = (settings.aroundDeg * Math.PI) / 180;
  const inner = mode === "raised" ? radiusMm - OVERLAP_MM : radiusMm - depthMm;
  const wrapped = flat.warp((p) => {
    const angle = p.x / radiusMm + aroundRad;
    const radius = inner + p.z;
    // Local frame: the wrap plane is XZ, the axis is Y.
    return {
      x: radius * Math.sin(angle),
      y: p.y + settings.alongMm,
      z: radius * Math.cos(angle),
    };
  });

  // Re-orient onto the requested world axis. The construction above puts the
  // cylinder axis along local Y.
  if (settings.axis === "y") return wrapped;
  if (settings.axis === "z") return wrapped.rotate(90, 0, 0);
  return wrapped.rotate(0, 0, 90).rotate(90, 0, 0);
}

export interface SurfaceProjectionSettings {
  /** Height of the relief above (or depth below) the target surface, mm. */
  depthMm: number;
  mode: EmbossMode;
  /** Direction the artwork is projected along, world space. */
  direction: { x: number; y: number; z: number };
  /**
   * Longest distance the projection searches for the surface, mm. Defaults
   * to twice the target's diagonal.
   */
  maxDistanceMm?: number;
  /** Subdivision of the artwork before projection, mm. */
  refineEdgeMm?: number;
}

/**
 * Project flat contours onto an arbitrary target surface.
 *
 * Each vertex of the extruded artwork is ray-cast onto the target along the
 * projection direction and moved to the hit point, offset by its own depth
 * within the prism. Vertices that miss the target keep their original
 * position, which keeps the body closed rather than tearing it — the caller
 * is told how much of the artwork actually landed.
 *
 * Consumes neither `target` nor the returned solid's inputs beyond the
 * artwork prism it builds internally.
 */
export function projectContoursOntoSurface(
  kernel: GeometryKernel,
  contours: Contour[],
  target: Solid,
  settings: SurfaceProjectionSettings
): { solid: Solid; hitFraction: number } {
  const { depthMm, mode } = settings;
  if (!(depthMm > 0)) throw new OpError("עומק ההטבעה חייב להיות גדול מאפס");
  if (contours.length === 0) throw new OpError("אין מתאר להטבעה");

  const dirLength = Math.hypot(settings.direction.x, settings.direction.y, settings.direction.z);
  if (dirLength < 1e-9) throw new OpError("כיוון ההקרנה אינו יכול להיות אפס");
  const dir = {
    x: settings.direction.x / dirLength,
    y: settings.direction.y / dirLength,
    z: settings.direction.z / dirLength,
  };

  const bounds = target.boundingBox();
  const diagonal = Math.hypot(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z
  );
  const maxDistance = settings.maxDistanceMm ?? diagonal * 2;

  // Extrude the artwork; local z spans [0, depth + overlap].
  const height = depthMm + OVERLAP_MM;
  let prism = kernel.extrude(contours, height);
  const refineEdge = settings.refineEdgeMm ?? Math.max(0.3, diagonal / 200);
  prism = prism.refineToLength(refineEdge);

  let hits = 0;
  let total = 0;
  const projected = prism.warp((p) => {
    total++;
    // Cast from far back along the direction, through this vertex's XY
    // position, and take the first surface hit.
    const origin = {
      x: p.x - dir.x * maxDistance,
      y: p.y - dir.y * maxDistance,
      z: p.z - dir.z * maxDistance,
    };
    const end = {
      x: p.x + dir.x * maxDistance,
      y: p.y + dir.y * maxDistance,
      z: p.z + dir.z * maxDistance,
    };
    const found = target.rayCast(origin, end);
    if (found.length === 0) return p;
    hits++;
    const surface = found[0].position;
    // The vertex's own depth within the prism becomes its offset from the
    // surface: outward for a relief, inward for an engraving.
    const offset = mode === "raised" ? p.z - OVERLAP_MM : -(height - p.z);
    return {
      x: surface.x + dir.x * -offset,
      y: surface.y + dir.y * -offset,
      z: surface.z + dir.z * -offset,
    };
  });

  return {
    solid: projected,
    hitFraction: total === 0 ? 0 : hits / total,
  };
}

/**
 * Apply a wrapped or projected artwork body to a target.
 *
 * Consumes both solids.
 */
export function applyEmbossToTarget(
  target: Solid,
  artwork: Solid,
  mode: EmbossMode
): Solid {
  const result = mode === "raised" ? target.union(artwork) : target.subtract(artwork);
  if (result.status() !== "NoError" || result.isEmpty()) {
    const status = result.status();
    result.dispose();
    throw new OpError(
      `ההטבעה על המשטח נכשלה (${status})`,
      [
        "ודאו שהכיתוב אכן נוגע במשטח היעד",
        "נסו רדיוס עטיפה או כיוון הקרנה אחרים",
        "הקטינו את עומק ההטבעה",
      ]
    );
  }
  return result;
}
