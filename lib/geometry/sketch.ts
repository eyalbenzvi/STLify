/**
 * Sketch compilation: turn drawn 2D entities into closed contours the kernel
 * can extrude.
 *
 * The output feeds exactly the same path as imported SVG artwork — the kernel
 * resolves everything with the NonZero fill rule, so overlapping entities
 * merge into one profile and an opposite-wound entity punches a hole.
 *
 * Open polylines and open Bezier chains have no interior, so they are stroked
 * into a closed ribbon of `strokeWidthMm` rather than silently vanishing.
 */

import type { SketchEntity } from "@/types/design";
import type { Contour, GeometryKernel } from "./kernel";

/** Facets used to approximate a full circle at default quality. */
const CIRCLE_SEGMENTS = 64;
/** Segments per quadratic Bezier span. */
const BEZIER_SEGMENTS = 16;

function rotate(
  x: number,
  y: number,
  cx: number,
  cy: number,
  degrees: number
): [number, number] {
  if (degrees === 0) return [x + cx, y + cy];
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [cx + x * cos - y * sin, cy + x * sin + y * cos];
}

function circleContour(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotationDeg: number,
  segments = CIRCLE_SEGMENTS
): Contour {
  const points: Contour = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(rotate(rx * Math.cos(a), ry * Math.sin(a), cx, cy, rotationDeg));
  }
  return points;
}

function roundedRectContour(
  cx: number,
  cy: number,
  width: number,
  height: number,
  radius: number,
  rotationDeg: number
): Contour {
  const hw = width / 2;
  const hh = height / 2;
  const r = Math.max(0, Math.min(radius, Math.min(hw, hh)));
  if (r <= 1e-6) {
    return [
      rotate(-hw, -hh, cx, cy, rotationDeg),
      rotate(hw, -hh, cx, cy, rotationDeg),
      rotate(hw, hh, cx, cy, rotationDeg),
      rotate(-hw, hh, cx, cy, rotationDeg),
    ];
  }
  const perCorner = 8;
  const points: Contour = [];
  // Corner centres in counter-clockwise order, each with its start angle.
  const corners: [number, number, number][] = [
    [hw - r, -hh + r, -Math.PI / 2],
    [hw - r, hh - r, 0],
    [-hw + r, hh - r, Math.PI / 2],
    [-hw + r, -hh + r, Math.PI],
  ];
  for (const [ccx, ccy, start] of corners) {
    for (let i = 0; i <= perCorner; i++) {
      const a = start + (i / perCorner) * (Math.PI / 2);
      points.push(
        rotate(ccx + r * Math.cos(a), ccy + r * Math.sin(a), cx, cy, rotationDeg)
      );
    }
  }
  return points;
}

/** Sample a chain of quadratic Beziers: [p0, c0, p1, c1, p2, ...]. */
function sampleBezierChain(points: [number, number][], closed: boolean): [number, number][] {
  if (points.length < 3) return points.slice();
  const out: [number, number][] = [];
  const spanCount = Math.floor((points.length - 1) / 2);
  for (let s = 0; s < spanCount; s++) {
    const p0 = points[s * 2];
    const c = points[s * 2 + 1];
    const p1 = points[s * 2 + 2];
    for (let i = 0; i < BEZIER_SEGMENTS; i++) {
      const t = i / BEZIER_SEGMENTS;
      const mt = 1 - t;
      out.push([
        mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0],
        mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1],
      ]);
    }
  }
  const last = points[spanCount * 2];
  if (last) out.push(last);
  if (closed && out.length > 0) out.push(out[0]);
  return out;
}

/**
 * Stroke an open path into a closed ribbon.
 *
 * Uses the kernel's Clipper2 offset on a degenerate "there and back" contour:
 * tracing the path forwards then backwards gives a zero-area polygon whose
 * outward offset is exactly the stroked ribbon, which keeps joins and caps
 * consistent with every other offset in the app.
 */
function strokeOpenPath(
  kernel: GeometryKernel,
  path: [number, number][],
  widthMm: number
): Contour[] {
  if (path.length < 2 || widthMm <= 0) return [];
  const doubled: Contour = [...path, ...[...path].reverse().slice(1, -1)];
  if (doubled.length < 3) {
    // A two-point path degenerates; offset the segment as a thin rectangle.
    const [a, b] = path;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return [];
    const nx = (-dy / length) * (widthMm / 2);
    const ny = (dx / length) * (widthMm / 2);
    return [
      [
        [a[0] + nx, a[1] + ny],
        [b[0] + nx, b[1] + ny],
        [b[0] - nx, b[1] - ny],
        [a[0] - nx, a[1] - ny],
      ],
    ];
  }
  return kernel.offsetContours([doubled], widthMm / 2, "round");
}

/** Compile one entity into closed contours. */
function entityContours(kernel: GeometryKernel, entity: SketchEntity): Contour[] {
  switch (entity.kind) {
    case "rectangle":
      return [
        roundedRectContour(
          entity.x,
          entity.y,
          entity.widthMm,
          entity.heightMm,
          entity.cornerRadiusMm,
          entity.rotationDeg
        ),
      ];
    case "circle":
      if (entity.radiusMm <= 0) return [];
      return [circleContour(entity.x, entity.y, entity.radiusMm, entity.radiusMm, 0)];
    case "ellipse":
      if (entity.radiusXMm <= 0 || entity.radiusYMm <= 0) return [];
      return [
        circleContour(
          entity.x,
          entity.y,
          entity.radiusXMm,
          entity.radiusYMm,
          entity.rotationDeg
        ),
      ];
    case "polygon": {
      const sides = Math.max(3, Math.round(entity.sides));
      if (entity.radiusMm <= 0) return [];
      return [circleContour(entity.x, entity.y, entity.radiusMm, entity.radiusMm, entity.rotationDeg, sides)];
    }
    case "polyline": {
      if (entity.points.length < 2) return [];
      if (entity.closed) return [entity.points.map(([x, y]): [number, number] => [x, y])];
      return strokeOpenPath(kernel, entity.points, entity.strokeWidthMm);
    }
    case "bezier": {
      const sampled = sampleBezierChain(entity.points, entity.closed);
      if (sampled.length < 3) return [];
      if (entity.closed) return [sampled];
      return strokeOpenPath(kernel, sampled, entity.strokeWidthMm);
    }
  }
}

/**
 * Compile a whole sketch. The result is already resolved through the NonZero
 * fill rule, so it is ready to extrude or revolve.
 */
export function sketchToContours(
  kernel: GeometryKernel,
  entities: SketchEntity[]
): Contour[] {
  const all: Contour[] = [];
  for (const entity of entities) {
    for (const contour of entityContours(kernel, entity)) {
      if (contour.length >= 3) all.push(contour);
    }
  }
  if (all.length === 0) return [];
  return kernel.resolveContours(all);
}

/** Axis-aligned bounds of a sketch, in mm. Null when the sketch is empty. */
export function sketchBounds(
  kernel: GeometryKernel,
  entities: SketchEntity[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const contours = sketchToContours(kernel, entities);
  if (contours.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of contours) {
    for (const [x, y] of contour) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}
