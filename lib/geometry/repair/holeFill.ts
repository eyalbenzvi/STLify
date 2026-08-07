/**
 * Boundary-loop hole filling.
 *
 * `repair.ts` could only weld vertices, which fixes STL files whose triangles
 * merely fail to share vertices. It cannot fix a mesh with actual missing
 * triangles — the most common defect in scanned and badly-exported models.
 * This module closes those holes with real geometry.
 *
 * Two strategies, in order:
 *   1. Ear clipping on the loop projected onto its best-fit plane. Produces a
 *      clean, vertex-preserving patch — correct for the flat holes left by a
 *      deleted face or a failed boolean.
 *   2. Centroid fan: add one vertex at the loop centroid (pushed onto the
 *      best-fit plane) and fan out. Always succeeds, so a hole is never left
 *      open, at the cost of one new vertex.
 *
 * Winding: a boundary loop is stored in the direction the EXISTING surface
 * traverses it, so every patch triangle must traverse those same edges
 * backwards for the patch normal to agree with its neighbours.
 */

import type { MeshData } from "../meshData";
import { analyzeTopology, type BoundaryLoop } from "./topology";

export interface HoleFillOptions {
  /**
   * Skip loops longer than this (mm). Very large loops usually mean the model
   * is a genuinely open surface (a scan of one side of an object) rather than
   * a solid with a defect, and capping it would invent geometry the user
   * never modelled. 0 disables the limit.
   */
  maxPerimeterMm?: number;
}

export interface HoleFillResult {
  mesh: MeshData;
  /** Loops that were closed. */
  filled: number;
  /** Loops skipped because they exceeded `maxPerimeterMm`. */
  skipped: number;
  /** Triangles added. */
  trianglesAdded: number;
  /** Perimeter of each filled loop, mm, largest first. */
  filledPerimetersMm: number[];
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Newell's method: an area-weighted normal that is well defined even for
 * non-planar loops, unlike a cross product of any three chosen vertices.
 */
function loopNormal(positions: Float32Array, loop: number[]): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] * 3;
    const b = loop[(i + 1) % loop.length] * 3;
    nx += (positions[a + 1] - positions[b + 1]) * (positions[a + 2] + positions[b + 2]);
    ny += (positions[a + 2] - positions[b + 2]) * (positions[a] + positions[b]);
    nz += (positions[a] - positions[b]) * (positions[a + 1] + positions[b + 1]);
  }
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-12) return { x: 0, y: 0, z: 1 };
  return { x: nx / length, y: ny / length, z: nz / length };
}

/** Any unit vector perpendicular to `n`, chosen to avoid degeneracy. */
function perpendicular(n: Vec3): Vec3 {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  // Cross with whichever axis is least aligned with n.
  const axis: Vec3 =
    ax <= ay && ax <= az
      ? { x: 1, y: 0, z: 0 }
      : ay <= az
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
  const cx = n.y * axis.z - n.z * axis.y;
  const cy = n.z * axis.x - n.x * axis.z;
  const cz = n.x * axis.y - n.y * axis.x;
  const length = Math.hypot(cx, cy, cz) || 1;
  return { x: cx / length, y: cy / length, z: cz / length };
}

/** 2D signed area of a polygon (positive = counter-clockwise). */
function signedArea2D(points: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clip a simple polygon given as CCW 2D points. Returns index triples
 * into `points`, or null when the polygon is not simple (self-intersecting
 * projection) and clipping stalls.
 */
function earClip(points: [number, number][]): [number, number, number][] | null {
  const n = points.length;
  if (n < 3) return null;
  if (n === 3) return [[0, 1, 2]];
  const remaining = points.map((_, i) => i);
  const triangles: [number, number, number][] = [];
  let guard = 0;
  const guardLimit = n * n;

  while (remaining.length > 3) {
    if (guard++ > guardLimit) return null;
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const prev = remaining[(i - 1 + remaining.length) % remaining.length];
      const curr = remaining[i];
      const next = remaining[(i + 1) % remaining.length];
      const [ax, ay] = points[prev];
      const [bx, by] = points[curr];
      const [cx, cy] = points[next];
      // Convex check for a CCW polygon.
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (cross <= 0) continue;
      // No other vertex may lie inside the candidate ear.
      let contains = false;
      for (const other of remaining) {
        if (other === prev || other === curr || other === next) continue;
        const [px, py] = points[other];
        if (pointInTriangle(px, py, ax, ay, bx, by, cx, cy)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      triangles.push([prev, curr, next]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  triangles.push([remaining[0], remaining[1], remaining[2]]);
  return triangles;
}

/**
 * Close every boundary loop in the mesh.
 *
 * The returned mesh shares nothing with the input; positions are copied only
 * when a centroid vertex has to be added.
 */
export function fillHoles(mesh: MeshData, options: HoleFillOptions = {}): HoleFillResult {
  const maxPerimeter = options.maxPerimeterMm ?? 0;
  const report = analyzeTopology(mesh);
  if (report.boundaryLoops.length === 0) {
    return {
      mesh,
      filled: 0,
      skipped: 0,
      trianglesAdded: 0,
      filledPerimetersMm: [],
    };
  }

  const positions: number[] = Array.from(mesh.positions);
  const indices: number[] = Array.from(mesh.indices);
  let filled = 0;
  let skipped = 0;
  let trianglesAdded = 0;
  const filledPerimetersMm: number[] = [];

  for (const loop of report.boundaryLoops) {
    if (maxPerimeter > 0 && loop.perimeterMm > maxPerimeter) {
      skipped++;
      continue;
    }
    const added = fillSingleLoop(positions, indices, loop);
    if (added > 0) {
      filled++;
      trianglesAdded += added;
      filledPerimetersMm.push(loop.perimeterMm);
    } else {
      skipped++;
    }
  }

  if (filled === 0) {
    return { mesh, filled: 0, skipped, trianglesAdded: 0, filledPerimetersMm: [] };
  }
  return {
    mesh: {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
    },
    filled,
    skipped,
    trianglesAdded,
    filledPerimetersMm,
  };
}

/** Returns the number of triangles added (0 = could not fill). */
function fillSingleLoop(
  positions: number[],
  indices: number[],
  loop: BoundaryLoop
): number {
  const verts = loop.vertices;
  if (verts.length < 3) return 0;

  const flat = new Float32Array(positions);
  const normal = loopNormal(flat, verts);

  // The patch must traverse the loop backwards relative to the existing
  // surface, so its normal opposes the loop's own traversal direction.
  const patchLoop = [...verts].reverse();

  if (patchLoop.length === 3) {
    indices.push(patchLoop[0], patchLoop[1], patchLoop[2]);
    return 1;
  }

  // Project onto the best-fit plane.
  const u = perpendicular(normal);
  const v = {
    x: normal.y * u.z - normal.z * u.y,
    y: normal.z * u.x - normal.x * u.z,
    z: normal.x * u.y - normal.y * u.x,
  };
  const origin = loop.center;
  const projected: [number, number][] = patchLoop.map((idx) => {
    const dx = positions[idx * 3] - origin.x;
    const dy = positions[idx * 3 + 1] - origin.y;
    const dz = positions[idx * 3 + 2] - origin.z;
    return [dx * u.x + dy * u.y + dz * u.z, dx * v.x + dy * v.y + dz * v.z];
  });

  // Ear clipping needs a counter-clockwise polygon. When the projection comes
  // out clockwise we MIRROR one axis rather than reversing the vertex list:
  // ear clipping preserves the input's cyclic order, so reversing the list
  // would also reverse every patch edge and flip the patch normal back into
  // agreement with the boundary — exactly the winding error we are avoiding.
  const ccw =
    signedArea2D(projected) >= 0
      ? projected
      : projected.map(([x, y]): [number, number] => [x, -y]);

  const ears = earClip(ccw);
  if (ears) {
    for (const [a, b, c] of ears) {
      indices.push(patchLoop[a], patchLoop[b], patchLoop[c]);
    }
    return ears.length;
  }

  // Fallback: centroid fan. Always closes the loop.
  const centroidIndex = positions.length / 3;
  positions.push(origin.x, origin.y, origin.z);
  for (let i = 0; i < patchLoop.length; i++) {
    indices.push(centroidIndex, patchLoop[i], patchLoop[(i + 1) % patchLoop.length]);
  }
  return patchLoop.length;
}
