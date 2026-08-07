/**
 * Self-intersection detection.
 *
 * Manifold refuses self-intersecting input, so a model that overlaps itself
 * fails to import with nothing but a "NotManifold" status. This module says
 * *where* the overlaps are, which turns an opaque failure into a navigable
 * list of problem locations — and tells the repair pipeline whether the
 * expensive voxel remesh is warranted.
 *
 * Triangle-triangle overlap uses the interval-on-the-line-of-intersection
 * test (Möller 1997). Triangles that merely touch along a shared edge or
 * vertex are NOT reported: they are how a mesh is supposed to be built.
 */

import { MeshBvh } from "../bvh";
import type { MeshData } from "../meshData";
import { weldMesh } from "./repair";

export interface SelfIntersectionResult {
  /** Number of intersecting triangle pairs found (capped, see `truncated`). */
  pairCount: number;
  /** Representative world-space locations, for camera navigation. */
  locations: { x: number; y: number; z: number }[];
  /** True when scanning stopped at `maxPairs` and more may exist. */
  truncated: boolean;
}

const MAX_REPORTED_LOCATIONS = 32;

/**
 * @param maxPairs stop after this many intersecting pairs. Pathological
 * meshes can have millions; the caller only needs to know "yes, and roughly
 * where".
 */
export function findSelfIntersections(
  input: MeshData,
  maxPairs = 2000
): SelfIntersectionResult {
  // Weld first. Neighbouring triangles are skipped by shared-vertex identity,
  // and in an STL-style mesh every triangle owns private copies of its
  // corners — so without welding, every ordinary shared edge of the model
  // looks like two unrelated triangles overlapping along a line, and a
  // perfectly good cube reports twelve self-intersections.
  const mesh = weldMesh(input, 1e-5);
  const bvh = new MeshBvh(mesh);
  let pairCount = 0;
  let truncated = false;
  const locations: { x: number; y: number; z: number }[] = [];

  try {
    bvh.candidatePairs((a, b) => {
      if (pairCount >= maxPairs) {
        truncated = true;
        throw STOP;
      }
      if (sharesVertex(mesh, a, b)) return;
      if (!trianglesIntersect(mesh, a, b)) return;
      pairCount++;
      if (locations.length < MAX_REPORTED_LOCATIONS) {
        locations.push(triangleCentroid(mesh, a));
      }
    });
  } catch (err) {
    if (err !== STOP) throw err;
  }

  return { pairCount, locations, truncated };
}

/** Sentinel used to break out of the BVH traversal callback. */
const STOP = Symbol("stop");

function sharesVertex(mesh: MeshData, a: number, b: number): boolean {
  const idx = mesh.indices;
  for (let i = 0; i < 3; i++) {
    const va = idx[a * 3 + i];
    for (let j = 0; j < 3; j++) {
      if (va === idx[b * 3 + j]) return true;
    }
  }
  return false;
}

function triangleCentroid(mesh: MeshData, t: number): { x: number; y: number; z: number } {
  const p = mesh.positions;
  const idx = mesh.indices;
  const a = idx[t * 3] * 3;
  const b = idx[t * 3 + 1] * 3;
  const c = idx[t * 3 + 2] * 3;
  return {
    x: (p[a] + p[b] + p[c]) / 3,
    y: (p[a + 1] + p[b + 1] + p[c + 1]) / 3,
    z: (p[a + 2] + p[b + 2] + p[c + 2]) / 3,
  };
}

type Tri = [number[], number[], number[]];

function triangleOf(mesh: MeshData, t: number): Tri {
  const p = mesh.positions;
  const idx = mesh.indices;
  const read = (v: number) => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];
  return [read(idx[t * 3]), read(idx[t * 3 + 1]), read(idx[t * 3 + 2])];
}

function sub(a: number[], b: number[]): number[] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

const EPS = 1e-9;

/**
 * Möller's triangle-triangle overlap test. Coplanar pairs are treated as
 * non-intersecting: coplanar overlap is a modelling artefact the voxel
 * remesh resolves anyway, and testing it here produces mostly false
 * positives on legitimately adjacent flat faces.
 */
export function trianglesIntersect(mesh: MeshData, ta: number, tb: number): boolean {
  const t1 = triangleOf(mesh, ta);
  const t2 = triangleOf(mesh, tb);

  // Plane of t2, signed distances of t1's vertices.
  const n2 = cross(sub(t2[1], t2[0]), sub(t2[2], t2[0]));
  const d2 = -dot(n2, t2[0]);
  const dist1 = t1.map((v) => dot(n2, v) + d2);
  if (dist1.every((d) => d > EPS) || dist1.every((d) => d < -EPS)) return false;
  if (dist1.every((d) => Math.abs(d) <= EPS)) return false; // coplanar

  // Plane of t1, signed distances of t2's vertices.
  const n1 = cross(sub(t1[1], t1[0]), sub(t1[2], t1[0]));
  const d1 = -dot(n1, t1[0]);
  const dist2 = t2.map((v) => dot(n1, v) + d1);
  if (dist2.every((d) => d > EPS) || dist2.every((d) => d < -EPS)) return false;
  if (dist2.every((d) => Math.abs(d) <= EPS)) return false; // coplanar

  // Direction of the line where the two planes meet.
  const dir = cross(n1, n2);
  const axis = dir
    .map((v, i) => [Math.abs(v), i])
    .sort((a, b) => b[0] - a[0])[0][1];

  const interval = (tri: Tri, dist: number[]): [number, number] | null => {
    // The vertex on its own side of the other plane.
    let lone = -1;
    for (let i = 0; i < 3; i++) {
      const others = [dist[(i + 1) % 3], dist[(i + 2) % 3]];
      if (
        (dist[i] > EPS && others.every((d) => d < EPS)) ||
        (dist[i] < -EPS && others.every((d) => d > -EPS))
      ) {
        lone = i;
        break;
      }
    }
    if (lone === -1) {
      // A vertex lies on the plane; use the pair straddling it.
      for (let i = 0; i < 3; i++) {
        if (Math.abs(dist[i]) <= EPS) {
          lone = i;
          break;
        }
      }
      if (lone === -1) return null;
    }
    const p = tri[lone][axis];
    const dp = dist[lone];
    const values: number[] = [];
    for (const other of [(lone + 1) % 3, (lone + 2) % 3]) {
      const q = tri[other][axis];
      const dq = dist[other];
      const denom = dp - dq;
      values.push(Math.abs(denom) < EPS ? q : p + (q - p) * (dp / denom));
    }
    return [Math.min(...values), Math.max(...values)];
  };

  const i1 = interval(t1, dist1);
  const i2 = interval(t2, dist2);
  if (!i1 || !i2) return false;
  // Overlapping intervals on the intersection line means the triangles cross.
  return i1[0] <= i2[1] - EPS && i2[0] <= i1[1] - EPS;
}
