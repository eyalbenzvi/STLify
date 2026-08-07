/**
 * Geometric snapping and extended measurements.
 *
 * Snapping was grid-only: positions rounded to 0.1/0.5/1/5 mm. That is fine
 * for laying out a nameplate and useless for assembly, where the thing you
 * want to align to is a corner, an edge midpoint or the centre of a hole —
 * none of which sits on a round grid coordinate. This finds those features
 * near a query point so the viewport can snap to real geometry.
 *
 * Measurements were distances between two picked points. This adds the three
 * a printing workflow actually needs: the ANGLE between two faces (draft and
 * overhang), the RADIUS of a hole or fillet (does the screw fit), and the
 * WALL THICKNESS at a point (will it survive).
 */

import { MeshBvh, type Vec3Like } from "./bvh";
import type { MeshData } from "./meshData";
import { buildAdjacency, type MeshAdjacency } from "./selection/meshAdjacency";

export type SnapFeature = "vertex" | "edgeMidpoint" | "faceCenter" | "edgeProjection";

export interface SnapCandidate {
  feature: SnapFeature;
  point: Vec3Like;
  /** Distance from the query point, mm. */
  distanceMm: number;
  /** Hebrew label for the viewport badge. */
  labelHe: string;
}

export interface SnapOptions {
  /** Only consider features within this distance of the query, mm. */
  radiusMm: number;
  vertices: boolean;
  edgeMidpoints: boolean;
  faceCenters: boolean;
  /** Nearest point along an edge, not just its midpoint. */
  edgeProjections: boolean;
}

export const DEFAULT_SNAP_OPTIONS: SnapOptions = {
  radiusMm: 3,
  vertices: true,
  edgeMidpoints: true,
  faceCenters: true,
  edgeProjections: true,
};

const FEATURE_LABELS_HE: Record<SnapFeature, string> = {
  vertex: "קודקוד",
  edgeMidpoint: "אמצע צלע",
  faceCenter: "מרכז פאה",
  edgeProjection: "על הצלע",
};

/** Closest point on segment ab to p. */
function projectOnSegment(p: Vec3Like, a: Vec3Like, b: Vec3Like): Vec3Like {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  if (lengthSq < 1e-18) return a;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + abx * t, y: a.y + aby * t, z: a.z + abz * t };
}

function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Best snap target near a world point.
 *
 * Candidates are ranked by a PRIORITY first and distance second: a vertex
 * three times further away than a face centre is still the better target,
 * because it is the feature a user means when they hover near a corner.
 * Ranking by raw distance alone makes corners nearly unsnappable.
 */
export function findSnapCandidate(
  mesh: MeshData,
  bvh: MeshBvh,
  query: Vec3Like,
  options: SnapOptions = DEFAULT_SNAP_OPTIONS
): SnapCandidate | null {
  const radius = options.radiusMm;
  if (!(radius > 0)) return null;

  const priority: Record<SnapFeature, number> = {
    vertex: 0,
    edgeMidpoint: 1,
    faceCenter: 2,
    edgeProjection: 3,
  };

  let best: SnapCandidate | null = null;
  const consider = (feature: SnapFeature, point: Vec3Like) => {
    const d = distance(query, point);
    if (d > radius) return;
    if (
      best &&
      (priority[best.feature] < priority[feature] ||
        (priority[best.feature] === priority[feature] && best.distanceMm <= d))
    ) {
      return;
    }
    best = { feature, point, distanceMm: d, labelHe: FEATURE_LABELS_HE[feature] };
  };

  const idx = mesh.indices;
  const pos = mesh.positions;
  const readVertex = (v: number): Vec3Like => ({
    x: pos[v * 3],
    y: pos[v * 3 + 1],
    z: pos[v * 3 + 2],
  });

  const min = { x: query.x - radius, y: query.y - radius, z: query.z - radius };
  const max = { x: query.x + radius, y: query.y + radius, z: query.z + radius };

  bvh.queryBox(min, max, (t) => {
    const v0 = idx[t * 3];
    const v1 = idx[t * 3 + 1];
    const v2 = idx[t * 3 + 2];
    const a = readVertex(v0);
    const b = readVertex(v1);
    const c = readVertex(v2);

    if (options.vertices) {
      consider("vertex", a);
      consider("vertex", b);
      consider("vertex", c);
    }
    if (options.edgeMidpoints) {
      consider("edgeMidpoint", { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
      consider("edgeMidpoint", { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2, z: (b.z + c.z) / 2 });
      consider("edgeMidpoint", { x: (c.x + a.x) / 2, y: (c.y + a.y) / 2, z: (c.z + a.z) / 2 });
    }
    if (options.faceCenters) {
      consider("faceCenter", {
        x: (a.x + b.x + c.x) / 3,
        y: (a.y + b.y + c.y) / 3,
        z: (a.z + b.z + c.z) / 3,
      });
    }
    if (options.edgeProjections) {
      consider("edgeProjection", projectOnSegment(query, a, b));
      consider("edgeProjection", projectOnSegment(query, b, c));
      consider("edgeProjection", projectOnSegment(query, c, a));
    }
  });

  return best;
}

// ---------------------------------------------------------------------------
// Extended measurements
// ---------------------------------------------------------------------------

/**
 * Angle between the faces under two picked points, in degrees.
 *
 * Reported as the DIHEDRAL angle of the material (180 degrees for a flat
 * surface, 90 for a square inside corner), which is what a printer cares
 * about — a 30-degree wedge is a draft problem, a 30-degree normal
 * difference is not obviously anything.
 */
export function measureAngleBetweenFaces(
  mesh: MeshData,
  bvh: MeshBvh,
  a: Vec3Like,
  b: Vec3Like,
  adjacency?: MeshAdjacency
): { degrees: number; normalA: Vec3Like; normalB: Vec3Like } | null {
  const hitA = bvh.closestPoint(a);
  const hitB = bvh.closestPoint(b);
  if (!hitA || !hitB) return null;
  const adj = adjacency ?? buildAdjacency(mesh);
  const normalA = {
    x: adj.normals[hitA.triangleIndex * 3],
    y: adj.normals[hitA.triangleIndex * 3 + 1],
    z: adj.normals[hitA.triangleIndex * 3 + 2],
  };
  const normalB = {
    x: adj.normals[hitB.triangleIndex * 3],
    y: adj.normals[hitB.triangleIndex * 3 + 1],
    z: adj.normals[hitB.triangleIndex * 3 + 2],
  };
  const dot = Math.max(
    -1,
    Math.min(1, normalA.x * normalB.x + normalA.y * normalB.y + normalA.z * normalB.z)
  );
  const between = (Math.acos(dot) * 180) / Math.PI;
  return { degrees: 180 - between, normalA, normalB };
}

/**
 * Radius of the circle through three picked points.
 *
 * Three points on the rim of a hole or the arc of a fillet determine it
 * exactly, which is how a user measures a bore without needing the model's
 * construction history.
 */
export function measureRadiusFromThreePoints(
  a: Vec3Like,
  b: Vec3Like,
  c: Vec3Like
): { radiusMm: number; center: Vec3Like } | null {
  const sub = (p: Vec3Like, q: Vec3Like): Vec3Like => ({
    x: p.x - q.x,
    y: p.y - q.y,
    z: p.z - q.z,
  });
  const cross = (p: Vec3Like, q: Vec3Like): Vec3Like => ({
    x: p.y * q.z - p.z * q.y,
    y: p.z * q.x - p.x * q.z,
    z: p.x * q.y - p.y * q.x,
  });
  const lengthSq = (p: Vec3Like): number => p.x * p.x + p.y * p.y + p.z * p.z;

  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const nLenSq = lengthSq(n);
  // Collinear points describe a straight line, not a circle.
  if (nLenSq < 1e-18) return null;

  // Circumcentre:
  //   a + ( |ac|^2 (n x ab) + |ab|^2 (ac x n) ) / (2 |n|^2)
  // The operand ORDER of both cross products matters. Reversing them mirrors
  // the centre through `a` while leaving |centre - a| unchanged, so the
  // radius still looks correct and only the centre is wrong.
  const t1 = cross(n, ab);
  const t2 = cross(ac, n);
  const k1 = lengthSq(ac) / (2 * nLenSq);
  const k2 = lengthSq(ab) / (2 * nLenSq);

  const center = {
    x: a.x + t1.x * k1 + t2.x * k2,
    y: a.y + t1.y * k1 + t2.y * k2,
    z: a.z + t1.z * k1 + t2.z * k2,
  };
  return { radiusMm: distance(center, a), center };
}

/**
 * Wall thickness at a point: the distance from the surface to the next
 * surface, measured straight into the material.
 *
 * The existing thickness ANALYSIS samples the whole model and paints a
 * heatmap; this answers "how thick is it exactly here", which is the question
 * asked when a specific feature looks marginal.
 */
export function measureThicknessAtPoint(
  mesh: MeshData,
  bvh: MeshBvh,
  point: Vec3Like,
  adjacency?: MeshAdjacency
): { thicknessMm: number; from: Vec3Like; to: Vec3Like } | null {
  const hit = bvh.closestPoint(point);
  if (!hit) return null;
  const adj = adjacency ?? buildAdjacency(mesh);
  const t = hit.triangleIndex;
  // Step inward along the inward normal.
  const nx = -adj.normals[t * 3];
  const ny = -adj.normals[t * 3 + 1];
  const nz = -adj.normals[t * 3 + 2];

  const bounds = bvh.bounds();
  const span = Math.hypot(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z
  );
  if (!(span > 0)) return null;

  // Start slightly inside so the ray does not immediately re-hit the face it
  // started from.
  const epsilon = Math.max(1e-4, span * 1e-6);
  const origin = {
    x: hit.point.x + nx * epsilon,
    y: hit.point.y + ny * epsilon,
    z: hit.point.z + nz * epsilon,
  };

  // Walk along the inward ray and take the first triangle crossed.
  let nearest: { distance: number; point: Vec3Like } | null = null;
  const direction = { x: nx, y: ny, z: nz };
  const end = {
    x: origin.x + nx * span * 2,
    y: origin.y + ny * span * 2,
    z: origin.z + nz * span * 2,
  };
  const min = {
    x: Math.min(origin.x, end.x),
    y: Math.min(origin.y, end.y),
    z: Math.min(origin.z, end.z),
  };
  const max = {
    x: Math.max(origin.x, end.x),
    y: Math.max(origin.y, end.y),
    z: Math.max(origin.z, end.z),
  };
  const idx = mesh.indices;
  const pos = mesh.positions;
  bvh.queryBox(min, max, (tri) => {
    if (tri === t) return;
    const hitDistance = rayTriangleDistance(pos, idx, tri, origin, direction);
    if (hitDistance === null) return;
    if (!nearest || hitDistance < nearest.distance) {
      nearest = {
        distance: hitDistance,
        point: {
          x: origin.x + nx * hitDistance,
          y: origin.y + ny * hitDistance,
          z: origin.z + nz * hitDistance,
        },
      };
    }
  });

  if (!nearest) return null;
  const found = nearest as { distance: number; point: Vec3Like };
  return {
    thicknessMm: found.distance + epsilon,
    from: hit.point,
    to: found.point,
  };
}

/** Möller-Trumbore returning the hit distance, or null. */
function rayTriangleDistance(
  pos: Float32Array,
  idx: Uint32Array,
  t: number,
  origin: Vec3Like,
  direction: Vec3Like
): number | null {
  const ia = idx[t * 3] * 3;
  const ib = idx[t * 3 + 1] * 3;
  const ic = idx[t * 3 + 2] * 3;
  const e1x = pos[ib] - pos[ia];
  const e1y = pos[ib + 1] - pos[ia + 1];
  const e1z = pos[ib + 2] - pos[ia + 2];
  const e2x = pos[ic] - pos[ia];
  const e2y = pos[ic + 1] - pos[ia + 1];
  const e2z = pos[ic + 2] - pos[ia + 2];
  const px = direction.y * e2z - direction.z * e2y;
  const py = direction.z * e2x - direction.x * e2z;
  const pz = direction.x * e2y - direction.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return null;
  const invDet = 1 / det;
  const tx = origin.x - pos[ia];
  const ty = origin.y - pos[ia + 1];
  const tz = origin.z - pos[ia + 2];
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (direction.x * qx + direction.y * qy + direction.z * qz) * invDet;
  if (v < 0 || u + v > 1) return null;
  const hitDistance = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return hitDistance > 1e-9 ? hitDistance : null;
}
