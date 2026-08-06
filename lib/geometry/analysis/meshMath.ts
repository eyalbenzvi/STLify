/**
 * Shared triangle-mesh math for the analysis modules: face normals, areas,
 * centroids and vertex-connected components — all pure over MeshData.
 */

import type { MeshData } from "../meshData";

export interface TriangleAccessors {
  count: number;
  /** Unit normal of triangle t (may be zero for degenerates). */
  normal: (t: number) => [number, number, number];
  area: (t: number) => number;
  centroid: (t: number) => [number, number, number];
  minZ: (t: number) => number;
  maxZOfMesh: number;
  minZOfMesh: number;
}

export function triangleAccessors(mesh: MeshData): TriangleAccessors {
  const p = mesh.positions;
  const idx = mesh.indices;
  const count = idx.length / 3;
  let meshMinZ = Infinity;
  let meshMaxZ = -Infinity;
  for (let i = 2; i < p.length; i += 3) {
    if (p[i] < meshMinZ) meshMinZ = p[i];
    if (p[i] > meshMaxZ) meshMaxZ = p[i];
  }

  const cross = (t: number): [number, number, number] => {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };

  return {
    count,
    normal: (t) => {
      const [x, y, z] = cross(t);
      const len = Math.hypot(x, y, z);
      if (len < 1e-12) return [0, 0, 0];
      return [x / len, y / len, z / len];
    },
    area: (t) => {
      const [x, y, z] = cross(t);
      return Math.hypot(x, y, z) / 2;
    },
    centroid: (t) => {
      const a = idx[t * 3] * 3;
      const b = idx[t * 3 + 1] * 3;
      const c = idx[t * 3 + 2] * 3;
      return [
        (p[a] + p[b] + p[c]) / 3,
        (p[a + 1] + p[b + 1] + p[c + 1]) / 3,
        (p[a + 2] + p[b + 2] + p[c + 2]) / 3,
      ];
    },
    minZ: (t) => {
      const a = idx[t * 3] * 3 + 2;
      const b = idx[t * 3 + 1] * 3 + 2;
      const c = idx[t * 3 + 2] * 3 + 2;
      return Math.min(p[a], p[b], p[c]);
    },
    maxZOfMesh: meshMaxZ,
    minZOfMesh: meshMinZ,
  };
}

/** Union-find over vertex indices. */
export class UnionFind {
  private parent: Int32Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}
