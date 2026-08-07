/**
 * A bounding-volume hierarchy over a mesh's triangles.
 *
 * Shared infrastructure for the operations that have to ask geometric
 * questions about a mesh the Manifold kernel will not accept (because it is
 * broken) or would be too slow to ask through the kernel one ray at a time:
 *
 *   • self-intersection detection (overlapping triangle pairs)
 *   • signed-distance sampling for voxel remeshing and lattice infill
 *   • closest-feature queries for viewport snapping
 *   • closest-hit ray casting for viewport picking (see viewportRaycast.ts)
 *
 * Built with a median split on the longest axis of the centroid bounds, which
 * is cheap to construct and good enough for the mesh sizes a browser-side
 * printing app handles.
 */

import { triangleCross, type MeshData } from "./meshData";

interface BvhNode {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** Triangle range in `order` for leaves; -1 for internal nodes. */
  start: number;
  count: number;
  left: number;
  right: number;
}

const LEAF_SIZE = 8;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Result of `raycastClosest`: nearest triangle along the ray. */
export interface RaycastHit {
  triangleIndex: number;
  /** Ray parameter t (metric distance for a unit direction). */
  distance: number;
  point: Vec3Like;
}

/** Instrumentation for `raycastClosest` — lets tests pin the pick cost. */
export interface RaycastStats {
  triangleTests: number;
}

export class MeshBvh {
  private nodes: BvhNode[] = [];
  /** Triangle ids ordered so each leaf owns a contiguous slice. */
  private order: Uint32Array;
  private centroids: Float32Array;
  readonly triangleCount: number;

  constructor(readonly mesh: MeshData) {
    this.triangleCount = mesh.indices.length / 3;
    this.order = new Uint32Array(this.triangleCount);
    for (let i = 0; i < this.triangleCount; i++) this.order[i] = i;
    this.centroids = new Float32Array(this.triangleCount * 3);
    const p = mesh.positions;
    const idx = mesh.indices;
    for (let t = 0; t < this.triangleCount; t++) {
      const a = idx[t * 3] * 3;
      const b = idx[t * 3 + 1] * 3;
      const c = idx[t * 3 + 2] * 3;
      this.centroids[t * 3] = (p[a] + p[b] + p[c]) / 3;
      this.centroids[t * 3 + 1] = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
      this.centroids[t * 3 + 2] = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    }
    if (this.triangleCount > 0) this.build(0, this.triangleCount);
  }

  private triangleBounds(t: number): [number, number, number, number, number, number] {
    const p = this.mesh.positions;
    const idx = this.mesh.indices;
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    return [
      Math.min(p[a], p[b], p[c]),
      Math.min(p[a + 1], p[b + 1], p[c + 1]),
      Math.min(p[a + 2], p[b + 2], p[c + 2]),
      Math.max(p[a], p[b], p[c]),
      Math.max(p[a + 1], p[b + 1], p[c + 1]),
      Math.max(p[a + 2], p[b + 2], p[c + 2]),
    ];
  }

  /** Recursively build; returns the index of the created node. */
  private build(start: number, end: number): number {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const [ax, ay, az, bx, by, bz] = this.triangleBounds(this.order[i]);
      if (ax < minX) minX = ax;
      if (ay < minY) minY = ay;
      if (az < minZ) minZ = az;
      if (bx > maxX) maxX = bx;
      if (by > maxY) maxY = by;
      if (bz > maxZ) maxZ = bz;
    }
    const nodeIndex = this.nodes.length;
    this.nodes.push({
      minX, minY, minZ, maxX, maxY, maxZ,
      start,
      count: end - start,
      left: -1,
      right: -1,
    });

    const count = end - start;
    if (count <= LEAF_SIZE) return nodeIndex;

    // Split on the longest axis of the centroid spread.
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
    let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const t = this.order[i];
      const x = this.centroids[t * 3];
      const y = this.centroids[t * 3 + 1];
      const z = this.centroids[t * 3 + 2];
      if (x < cMinX) cMinX = x;
      if (y < cMinY) cMinY = y;
      if (z < cMinZ) cMinZ = z;
      if (x > cMaxX) cMaxX = x;
      if (y > cMaxY) cMaxY = y;
      if (z > cMaxZ) cMaxZ = z;
    }
    const spanX = cMaxX - cMinX;
    const spanY = cMaxY - cMinY;
    const spanZ = cMaxZ - cMinZ;
    const axis = spanX >= spanY && spanX >= spanZ ? 0 : spanY >= spanZ ? 1 : 2;
    if ((axis === 0 ? spanX : axis === 1 ? spanY : spanZ) < 1e-9) return nodeIndex;

    // Median split (nth_element style via sort of the slice).
    const slice = Array.from(this.order.subarray(start, end));
    slice.sort((a, b) => this.centroids[a * 3 + axis] - this.centroids[b * 3 + axis]);
    this.order.set(slice, start);
    const mid = start + (count >> 1);

    const node = this.nodes[nodeIndex];
    node.left = this.build(start, mid);
    node.right = this.build(mid, end);
    node.count = -1; // internal
    return nodeIndex;
  }

  private forEachLeafTriangle(node: BvhNode, visit: (t: number) => void): void {
    for (let i = node.start; i < node.start + node.count; i++) visit(this.order[i]);
  }

  /** All triangles whose bounding box overlaps the given box. */
  queryBox(
    min: Vec3Like,
    max: Vec3Like,
    visit: (triangleIndex: number) => void
  ): void {
    if (this.nodes.length === 0) return;
    const stack = [0];
    while (stack.length > 0) {
      const node = this.nodes[stack.pop() as number];
      if (
        node.maxX < min.x || node.minX > max.x ||
        node.maxY < min.y || node.minY > max.y ||
        node.maxZ < min.z || node.minZ > max.z
      ) {
        continue;
      }
      if (node.count >= 0) this.forEachLeafTriangle(node, visit);
      else {
        stack.push(node.left, node.right);
      }
    }
  }

  /** Squared distance from a point to a node's box (0 when inside). */
  private boxDistanceSq(node: BvhNode, p: Vec3Like): number {
    const dx = p.x < node.minX ? node.minX - p.x : p.x > node.maxX ? p.x - node.maxX : 0;
    const dy = p.y < node.minY ? node.minY - p.y : p.y > node.maxY ? p.y - node.maxY : 0;
    const dz = p.z < node.minZ ? node.minZ - p.z : p.z > node.maxZ ? p.z - node.maxZ : 0;
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * Nearest point on the mesh surface. Returns the triangle index, the
   * closest point, and the squared distance.
   */
  closestPoint(p: Vec3Like): {
    triangleIndex: number;
    point: Vec3Like;
    distanceSq: number;
  } | null {
    if (this.nodes.length === 0) return null;
    let bestDistanceSq = Infinity;
    let bestTriangle = -1;
    let bestPoint: Vec3Like = { x: 0, y: 0, z: 0 };

    const stack: number[] = [0];
    while (stack.length > 0) {
      const nodeIndex = stack.pop() as number;
      const node = this.nodes[nodeIndex];
      if (this.boxDistanceSq(node, p) >= bestDistanceSq) continue;
      if (node.count >= 0) {
        this.forEachLeafTriangle(node, (t) => {
          const candidate = closestPointOnTriangle(this.mesh, t, p);
          const dx = candidate.x - p.x;
          const dy = candidate.y - p.y;
          const dz = candidate.z - p.z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestDistanceSq) {
            bestDistanceSq = d;
            bestTriangle = t;
            bestPoint = candidate;
          }
        });
      } else {
        // Visit the nearer child first so the bound tightens sooner.
        const left = this.nodes[node.left];
        const right = this.nodes[node.right];
        if (this.boxDistanceSq(left, p) < this.boxDistanceSq(right, p)) {
          stack.push(node.right, node.left);
        } else {
          stack.push(node.left, node.right);
        }
      }
    }
    if (bestTriangle === -1) return null;
    return { triangleIndex: bestTriangle, point: bestPoint, distanceSq: bestDistanceSq };
  }

  /** Overall bounding box of the mesh. */
  bounds(): { min: Vec3Like; max: Vec3Like } {
    if (this.nodes.length === 0) {
      return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
    }
    const root = this.nodes[0];
    return {
      min: { x: root.minX, y: root.minY, z: root.minZ },
      max: { x: root.maxX, y: root.maxY, z: root.maxZ },
    };
  }

  /**
   * Count how many triangles a ray crosses. Used for inside/outside tests on
   * meshes too broken for a kernel ray cast. The ray starts at `origin` and
   * travels along `direction` (need not be normalised) to infinity.
   */
  countRayCrossings(origin: Vec3Like, direction: Vec3Like): number {
    return this.traceRay(origin, direction).crossings;
  }

  /**
   * Signed crossing count (the winding number along this ray): +1 for every
   * back-facing triangle crossed, -1 for every front-facing one.
   *
   * This is what distinguishes UNION from XOR. Parity alone reports a point
   * inside two overlapping solids as *outside*, because the ray leaves both
   * of them — so a parity-based distance field carves the overlap away
   * instead of merging it. A nonzero winding number gets it right.
   *
   * Requires consistently outward winding to be meaningful; callers repair
   * orientation first.
   */
  windingAlongRay(origin: Vec3Like, direction: Vec3Like): number {
    return this.traceRay(origin, direction).winding;
  }

  private traceRay(
    origin: Vec3Like,
    direction: Vec3Like
  ): { crossings: number; winding: number } {
    if (this.nodes.length === 0) return { crossings: 0, winding: 0 };
    let crossings = 0;
    let winding = 0;
    const stack = [0];
    while (stack.length > 0) {
      const node = this.nodes[stack.pop() as number];
      if (!rayHitsBox(origin, direction, node)) continue;
      if (node.count >= 0) {
        this.forEachLeafTriangle(node, (t) => {
          if (!rayHitsTriangle(this.mesh, t, origin, direction)) return;
          crossings++;
          winding += triangleFacesAway(this.mesh, t, direction) ? 1 : -1;
        });
      } else {
        stack.push(node.left, node.right);
      }
    }
    return { crossings, winding };
  }

  /**
   * Closest intersection of a ray with the mesh, front or back facing (the
   * viewport renders double-sided, so picking must too).
   *
   * `distance` is the ray parameter t — the metric distance when `direction`
   * is unit length. Children are visited nearer-first and pruned against the
   * best hit so far, which is what makes a pick O(log n) instead of a linear
   * scan; `stats.triangleTests` counts the narrow-phase tests actually run so
   * a regression back to linear scanning fails a test rather than a user.
   */
  raycastClosest(
    origin: Vec3Like,
    direction: Vec3Like,
    stats?: RaycastStats
  ): RaycastHit | null {
    if (this.nodes.length === 0) return null;
    let bestT = Infinity;
    let bestTriangle = -1;

    // Stack entries pair a node with its box entry distance, so subtrees
    // entirely behind an existing hit are skipped without touching them.
    const stack: { node: number; tEntry: number }[] = [];
    const rootEntry = rayBoxEntry(origin, direction, this.nodes[0]);
    if (rootEntry === Infinity) return null;
    stack.push({ node: 0, tEntry: rootEntry });

    while (stack.length > 0) {
      const { node: nodeIndex, tEntry } = stack.pop() as { node: number; tEntry: number };
      if (tEntry >= bestT) continue;
      const node = this.nodes[nodeIndex];
      if (node.count >= 0) {
        this.forEachLeafTriangle(node, (t) => {
          if (stats) stats.triangleTests++;
          const hitT = rayTriangleDistance(this.mesh, t, origin, direction);
          if (hitT > 0 && hitT < bestT) {
            bestT = hitT;
            bestTriangle = t;
          }
        });
      } else {
        const leftEntry = rayBoxEntry(origin, direction, this.nodes[node.left]);
        const rightEntry = rayBoxEntry(origin, direction, this.nodes[node.right]);
        // Push the farther child first so the nearer one is explored first.
        if (leftEntry <= rightEntry) {
          if (rightEntry < Infinity) stack.push({ node: node.right, tEntry: rightEntry });
          if (leftEntry < Infinity) stack.push({ node: node.left, tEntry: leftEntry });
        } else {
          if (leftEntry < Infinity) stack.push({ node: node.left, tEntry: leftEntry });
          if (rightEntry < Infinity) stack.push({ node: node.right, tEntry: rightEntry });
        }
      }
    }

    if (bestTriangle === -1) return null;
    return {
      triangleIndex: bestTriangle,
      distance: bestT,
      point: {
        x: origin.x + direction.x * bestT,
        y: origin.y + direction.y * bestT,
        z: origin.z + direction.z * bestT,
      },
    };
  }

  /** Every pair of triangles whose bounding boxes overlap, i < j. */
  candidatePairs(visit: (a: number, b: number) => void): void {
    for (let t = 0; t < this.triangleCount; t++) {
      const [minX, minY, minZ, maxX, maxY, maxZ] = this.triangleBounds(t);
      this.queryBox(
        { x: minX, y: minY, z: minZ },
        { x: maxX, y: maxY, z: maxZ },
        (other) => {
          if (other > t) visit(t, other);
        }
      );
    }
  }
}

/** Closest point on triangle `t` to `p` (Ericson, Real-Time Collision Detection). */
export function closestPointOnTriangle(mesh: MeshData, t: number, p: Vec3Like): Vec3Like {
  const pos = mesh.positions;
  const idx = mesh.indices;
  const ia = idx[t * 3] * 3;
  const ib = idx[t * 3 + 1] * 3;
  const ic = idx[t * 3 + 2] * 3;
  const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2];
  const bx = pos[ib], by = pos[ib + 1], bz = pos[ib + 2];
  const cx = pos[ic], cy = pos[ic + 1], cz = pos[ic + 2];

  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = p.x - ax, apy = p.y - ay, apz = p.z - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return { x: ax, y: ay, z: az };

  const bpx = p.x - bx, bpy = p.y - by, bpz = p.z - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return { x: bx, y: by, z: bz };

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { x: ax + abx * v, y: ay + aby * v, z: az + abz * v };
  }

  const cpx = p.x - cx, cpy = p.y - cy, cpz = p.z - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return { x: cx, y: cy, z: cz };

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { x: ax + acx * w, y: ay + acy * w, z: az + acz * w };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return { x: bx + (cx - bx) * w, y: by + (cy - by) * w, z: bz + (cz - bz) * w };
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return {
    x: ax + abx * v + acx * w,
    y: ay + aby * v + acy * w,
    z: az + abz * v + acz * w,
  };
}

// Reused across calls: this runs per ray per candidate triangle, which the
// voxel remesher drives into the millions.
const facingCross: [number, number, number] = [0, 0, 0];

/** True when the triangle's outward normal points away from the ray. */
function triangleFacesAway(mesh: MeshData, t: number, direction: Vec3Like): boolean {
  const idx = mesh.indices;
  const [nx, ny, nz] = triangleCross(
    mesh.positions,
    idx[t * 3],
    idx[t * 3 + 1],
    idx[t * 3 + 2],
    facingCross
  );
  return nx * direction.x + ny * direction.y + nz * direction.z > 0;
}

/**
 * Ray parameter at which the ray enters the node's box, or Infinity when it
 * misses. 0 when the origin is already inside.
 */
function rayBoxEntry(origin: Vec3Like, direction: Vec3Like, node: BvhNode): number {
  let tMin = 0;
  let tMax = Infinity;
  const o = [origin.x, origin.y, origin.z];
  const d = [direction.x, direction.y, direction.z];
  const lo = [node.minX, node.minY, node.minZ];
  const hi = [node.maxX, node.maxY, node.maxZ];
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 1e-12) {
      if (o[axis] < lo[axis] || o[axis] > hi[axis]) return Infinity;
      continue;
    }
    const inv = 1 / d[axis];
    let t1 = (lo[axis] - o[axis]) * inv;
    let t2 = (hi[axis] - o[axis]) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return Infinity;
  }
  return tMin;
}

function rayHitsBox(origin: Vec3Like, direction: Vec3Like, node: BvhNode): boolean {
  let tMin = 0;
  let tMax = Infinity;
  const o = [origin.x, origin.y, origin.z];
  const d = [direction.x, direction.y, direction.z];
  const lo = [node.minX, node.minY, node.minZ];
  const hi = [node.maxX, node.maxY, node.maxZ];
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 1e-12) {
      if (o[axis] < lo[axis] || o[axis] > hi[axis]) return false;
      continue;
    }
    const inv = 1 / d[axis];
    let t1 = (lo[axis] - o[axis]) * inv;
    let t2 = (hi[axis] - o[axis]) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return false;
  }
  return true;
}

/** Möller–Trumbore, front and back faces, t > 0 only. */
function rayHitsTriangle(
  mesh: MeshData,
  t: number,
  origin: Vec3Like,
  direction: Vec3Like
): boolean {
  return rayTriangleDistance(mesh, t, origin, direction) > 0;
}

/**
 * Ray parameter of the intersection with triangle `t`, or -1 when the ray
 * misses (front and back faces alike; hits behind the origin rejected).
 */
function rayTriangleDistance(
  mesh: MeshData,
  t: number,
  origin: Vec3Like,
  direction: Vec3Like
): number {
  const pos = mesh.positions;
  const idx = mesh.indices;
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
  if (Math.abs(det) < 1e-12) return -1;
  const invDet = 1 / det;
  const tx = origin.x - pos[ia];
  const ty = origin.y - pos[ia + 1];
  const tz = origin.z - pos[ia + 2];
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (direction.x * qx + direction.y * qy + direction.z * qz) * invDet;
  if (v < 0 || u + v > 1) return -1;
  const distance = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return distance > 1e-9 ? distance : -1;
}
