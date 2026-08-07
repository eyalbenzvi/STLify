/**
 * Sub-object topology: the structure that makes face / edge / vertex
 * selection possible.
 *
 * Everything in the editor up to now worked at LAYER granularity — you could
 * move a whole body but never touch one face of it. Direct modelling (push/
 * pull, per-region smoothing, splitting off a painted patch) needs to know
 * which triangles are neighbours, which of them lie in the same plane, and
 * where the boundary of a selected region runs.
 *
 * A triangle mesh has no notion of a "face" the way a CAD kernel does: the
 * flat top of a box is two triangles, and a cylinder's side is dozens. So
 * this module reconstructs logical faces by growing regions of triangles
 * that share a plane (for planar faces) or vary smoothly (for curved ones).
 */

import { triangleCross, type MeshData } from "../meshData";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Adjacency and per-triangle geometry for a mesh. */
export interface MeshAdjacency {
  triangleCount: number;
  vertexCount: number;
  /** Unit normal per triangle, xyz triples. */
  normals: Float32Array;
  /** Area per triangle, mm². */
  areas: Float32Array;
  /**
   * Up to three edge-neighbours per triangle, -1 where the edge is a
   * boundary or non-manifold. Neighbour k sits across the edge from
   * vertex k to vertex k+1.
   */
  neighbours: Int32Array;
  /** Triangle indices incident on each vertex, as a CSR-style pair. */
  vertexTriangleStart: Uint32Array;
  vertexTriangleList: Uint32Array;
}

function edgeKey(a: number, b: number, vertexCount: number): number {
  return a < b ? a * vertexCount + b : b * vertexCount + a;
}

/** Build the adjacency structure. O(triangles) with a hash map on edges. */
export function buildAdjacency(mesh: MeshData): MeshAdjacency {
  const idx = mesh.indices;
  const pos = mesh.positions;
  const triangleCount = idx.length / 3;
  const vertexCount = pos.length / 3;

  const normals = new Float32Array(triangleCount * 3);
  const areas = new Float32Array(triangleCount);
  const cross: [number, number, number] = [0, 0, 0];
  for (let t = 0; t < triangleCount; t++) {
    const [nx, ny, nz] = triangleCross(
      pos,
      idx[t * 3],
      idx[t * 3 + 1],
      idx[t * 3 + 2],
      cross
    );
    const length = Math.hypot(nx, ny, nz);
    areas[t] = length / 2;
    if (length > 1e-20) {
      normals[t * 3] = nx / length;
      normals[t * 3 + 1] = ny / length;
      normals[t * 3 + 2] = nz / length;
    }
  }

  // Edge -> the (at most two) triangles using it.
  const edgeMap = new Map<number, number>();
  const neighbours = new Int32Array(triangleCount * 3).fill(-1);
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const u = idx[t * 3 + k];
      const v = idx[t * 3 + ((k + 1) % 3)];
      if (u === v) continue;
      const key = edgeKey(u, v, vertexCount);
      const existing = edgeMap.get(key);
      if (existing === undefined) {
        // Store the half-edge slot so the partner can link back to it.
        edgeMap.set(key, t * 3 + k);
      } else {
        const otherTriangle = Math.floor(existing / 3);
        const otherSlot = existing % 3;
        // A third user of the same edge means non-manifold geometry; leave
        // both links as -1 rather than inventing an arbitrary neighbour.
        if (neighbours[otherTriangle * 3 + otherSlot] === -1) {
          neighbours[otherTriangle * 3 + otherSlot] = t;
          neighbours[t * 3 + k] = otherTriangle;
        }
      }
    }
  }

  // CSR vertex -> triangles.
  const counts = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < idx.length; i++) counts[idx[i] + 1]++;
  for (let v = 0; v < vertexCount; v++) counts[v + 1] += counts[v];
  const vertexTriangleStart = counts;
  const vertexTriangleList = new Uint32Array(idx.length);
  const cursor = new Uint32Array(vertexCount);
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      vertexTriangleList[vertexTriangleStart[v] + cursor[v]] = t;
      cursor[v]++;
    }
  }

  return {
    triangleCount,
    vertexCount,
    normals,
    areas,
    neighbours,
    vertexTriangleStart,
    vertexTriangleList,
  };
}

export type SelectionMode =
  | "triangle"
  /** Grow across edges whose dihedral angle is below the threshold. */
  | "coplanar"
  /** Grow across the whole connected shell. */
  | "connected"
  /** Grow while the normal stays within the threshold of the seed's normal. */
  | "similarNormal";

export interface GrowSelectionOptions {
  mode: SelectionMode;
  /** Angle threshold in degrees for coplanar / similarNormal. */
  angleToleranceDeg: number;
}

/**
 * Grow a triangle selection from a seed.
 *
 * "coplanar" is the one that reconstructs a CAD-style face: it walks
 * neighbours while the crease between them stays flatter than the
 * tolerance, so the top of a box comes back as its two triangles and a
 * cylinder's wall comes back as the whole barrel (at a loose tolerance) or
 * one facet strip (at a tight one).
 */
export function growSelection(
  adjacency: MeshAdjacency,
  seedTriangle: number,
  options: GrowSelectionOptions
): Set<number> {
  const selected = new Set<number>();
  if (seedTriangle < 0 || seedTriangle >= adjacency.triangleCount) return selected;
  if (options.mode === "triangle") {
    selected.add(seedTriangle);
    return selected;
  }

  const cos = Math.cos((options.angleToleranceDeg * Math.PI) / 180);
  const n = adjacency.normals;
  const seedNx = n[seedTriangle * 3];
  const seedNy = n[seedTriangle * 3 + 1];
  const seedNz = n[seedTriangle * 3 + 2];

  const stack = [seedTriangle];
  selected.add(seedTriangle);
  while (stack.length > 0) {
    const t = stack.pop() as number;
    for (let k = 0; k < 3; k++) {
      const other = adjacency.neighbours[t * 3 + k];
      if (other < 0 || selected.has(other)) continue;
      if (options.mode === "coplanar") {
        // Compare against the triangle we are stepping FROM, so a smoothly
        // curving surface is followed while a sharp crease stops the walk.
        const dot =
          n[t * 3] * n[other * 3] +
          n[t * 3 + 1] * n[other * 3 + 1] +
          n[t * 3 + 2] * n[other * 3 + 2];
        if (dot < cos) continue;
      } else if (options.mode === "similarNormal") {
        // Compare against the SEED, which bounds total drift and keeps a
        // cylinder from wrapping all the way around.
        const dot =
          seedNx * n[other * 3] +
          seedNy * n[other * 3 + 1] +
          seedNz * n[other * 3 + 2];
        if (dot < cos) continue;
      }
      selected.add(other);
      stack.push(other);
    }
  }
  return selected;
}

/** Area-weighted average normal of a triangle set. */
export function selectionNormal(
  adjacency: MeshAdjacency,
  triangles: Iterable<number>
): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const t of triangles) {
    const w = adjacency.areas[t];
    x += adjacency.normals[t * 3] * w;
    y += adjacency.normals[t * 3 + 1] * w;
    z += adjacency.normals[t * 3 + 2] * w;
  }
  const length = Math.hypot(x, y, z);
  if (length < 1e-12) return { x: 0, y: 0, z: 1 };
  return { x: x / length, y: y / length, z: z / length };
}

/** Total area of a triangle set, mm². */
export function selectionArea(
  adjacency: MeshAdjacency,
  triangles: Iterable<number>
): number {
  let area = 0;
  for (const t of triangles) area += adjacency.areas[t];
  return area;
}

/** Area-weighted centroid of a triangle set. */
export function selectionCenter(
  mesh: MeshData,
  adjacency: MeshAdjacency,
  triangles: Iterable<number>
): Vec3 {
  const idx = mesh.indices;
  const pos = mesh.positions;
  let x = 0;
  let y = 0;
  let z = 0;
  let total = 0;
  for (const t of triangles) {
    const w = adjacency.areas[t];
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      x += (pos[v] * w) / 3;
      y += (pos[v + 1] * w) / 3;
      z += (pos[v + 2] * w) / 3;
    }
    total += w;
  }
  if (total < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: x / total, y: y / total, z: z / total };
}

/**
 * Ordered boundary loops of a triangle selection, as vertex-index rings.
 *
 * An edge is on the boundary when exactly one of its two triangles is
 * selected. Chaining those directed edges gives the outline of the region —
 * which is what push/pull extrudes and what split-by-paint has to seal.
 */
export function selectionBoundaryLoops(
  mesh: MeshData,
  selected: ReadonlySet<number>
): number[][] {
  const idx = mesh.indices;
  const vertexCount = mesh.positions.length / 3;

  // Directed edges of the selected triangles.
  const directed = new Set<number>();
  for (const t of selected) {
    for (let k = 0; k < 3; k++) {
      directed.add(idx[t * 3 + k] * vertexCount + idx[t * 3 + ((k + 1) % 3)]);
    }
  }
  // A directed edge is on the boundary when its reverse is not also used by
  // the selection.
  const next = new Map<number, number[]>();
  for (const key of directed) {
    const u = Math.floor(key / vertexCount);
    const v = key % vertexCount;
    if (directed.has(v * vertexCount + u)) continue;
    const list = next.get(u);
    if (list) list.push(v);
    else next.set(u, [v]);
  }

  const loops: number[][] = [];
  const remaining = new Map<number, number[]>();
  for (const [from, tos] of next) remaining.set(from, [...tos]);
  const take = (from: number): number | undefined => {
    const tos = remaining.get(from);
    if (!tos || tos.length === 0) return undefined;
    const to = tos.pop() as number;
    if (tos.length === 0) remaining.delete(from);
    return to;
  };

  for (const start of [...remaining.keys()]) {
    while (remaining.has(start)) {
      const loop: number[] = [start];
      let cursor = take(start);
      let guard = 0;
      while (cursor !== undefined && cursor !== start && guard++ < vertexCount * 3) {
        loop.push(cursor);
        cursor = take(cursor);
      }
      if (loop.length >= 3) loops.push(loop);
      else break;
    }
  }
  return loops;
}

/** Vertices used by a triangle selection. */
export function selectionVertices(
  mesh: MeshData,
  selected: ReadonlySet<number>
): Set<number> {
  const vertices = new Set<number>();
  for (const t of selected) {
    vertices.add(mesh.indices[t * 3]);
    vertices.add(mesh.indices[t * 3 + 1]);
    vertices.add(mesh.indices[t * 3 + 2]);
  }
  return vertices;
}

/**
 * True when every selected triangle lies in one plane, within tolerance.
 * Push/pull needs this: extruding a non-planar region along a single
 * direction produces self-intersecting geometry.
 */
export function isSelectionPlanar(
  mesh: MeshData,
  adjacency: MeshAdjacency,
  selected: ReadonlySet<number>,
  toleranceMm = 0.01
): boolean {
  if (selected.size === 0) return false;
  const normal = selectionNormal(adjacency, selected);
  const center = selectionCenter(mesh, adjacency, selected);
  const pos = mesh.positions;
  for (const v of selectionVertices(mesh, selected)) {
    const d =
      (pos[v * 3] - center.x) * normal.x +
      (pos[v * 3 + 1] - center.y) * normal.y +
      (pos[v * 3 + 2] - center.z) * normal.z;
    if (Math.abs(d) > toleranceMm) return false;
  }
  return true;
}
