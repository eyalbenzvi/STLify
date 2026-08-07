/**
 * Component-level cleanup: dropping the debris that makes a model waste
 * material or confuse a slicer.
 *
 * Two distinct defects, often confused:
 *   • Loose shells — tiny disconnected fragments left by scanning or a
 *     failed boolean. They print as specks or get silently dropped.
 *   • Trapped interior shells — a whole closed surface sitting inside
 *     another. The slicer prints internal walls the user never asked for,
 *     burning filament and time invisibly.
 */

import type { MeshData } from "../meshData";
import { signedMeshVolume } from "../meshData";

export interface MeshComponent {
  mesh: MeshData;
  volumeMm3: number;
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
}

/** Split a mesh into vertex-connected components, largest volume first. */
export function splitComponents(mesh: MeshData): MeshComponent[] {
  const vertexCount = mesh.positions.length / 3;
  if (vertexCount === 0) return [];
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i += 3) {
    union(idx[i], idx[i + 1]);
    union(idx[i + 1], idx[i + 2]);
  }

  // Group triangles by their component root.
  const groups = new Map<number, number[]>();
  for (let t = 0; t < idx.length / 3; t++) {
    const root = find(idx[t * 3]);
    const list = groups.get(root);
    if (list) list.push(t);
    else groups.set(root, [t]);
  }

  const components: MeshComponent[] = [];
  for (const triangles of groups.values()) {
    const remap = new Map<number, number>();
    const positions: number[] = [];
    const indices: number[] = [];
    for (const t of triangles) {
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k];
        let mapped = remap.get(v);
        if (mapped === undefined) {
          mapped = positions.length / 3;
          remap.set(v, mapped);
          positions.push(
            mesh.positions[v * 3],
            mesh.positions[v * 3 + 1],
            mesh.positions[v * 3 + 2]
          );
        }
        indices.push(mapped);
      }
    }
    const component: MeshData = {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
    };
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i] < minX) minX = positions[i];
      if (positions[i + 1] < minY) minY = positions[i + 1];
      if (positions[i + 2] < minZ) minZ = positions[i + 2];
      if (positions[i] > maxX) maxX = positions[i];
      if (positions[i + 1] > maxY) maxY = positions[i + 1];
      if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
    }
    components.push({
      mesh: component,
      volumeMm3: Math.abs(signedMeshVolume(component)),
      bounds: {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
      },
    });
  }
  components.sort((a, b) => b.volumeMm3 - a.volumeMm3);
  return components;
}

/** Merge components back into one mesh. */
export function mergeComponents(components: MeshComponent[]): MeshData {
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const c of components) {
    vertexTotal += c.mesh.positions.length;
    indexTotal += c.mesh.indices.length;
  }
  const positions = new Float32Array(vertexTotal);
  const indices = new Uint32Array(indexTotal);
  let positionOffset = 0;
  let indexOffset = 0;
  for (const c of components) {
    positions.set(c.mesh.positions, positionOffset);
    const base = positionOffset / 3;
    for (let i = 0; i < c.mesh.indices.length; i++) {
      indices[indexOffset + i] = c.mesh.indices[i] + base;
    }
    positionOffset += c.mesh.positions.length;
    indexOffset += c.mesh.indices.length;
  }
  return { positions, indices };
}

export interface CleanupResult {
  mesh: MeshData;
  /** Loose fragments removed. */
  smallShellsRemoved: number;
  /** Shells removed because they were sealed inside another shell. */
  interiorShellsRemoved: number;
  /** Volume of everything removed, mm³. */
  removedVolumeMm3: number;
}

export interface CleanupOptions {
  /**
   * Remove components whose volume is below this fraction of the largest
   * component's. 0 disables loose-shell removal.
   */
  minVolumeFraction?: number;
  /** Remove shells fully enclosed by a larger shell's bounding box. */
  removeInteriorShells?: boolean;
}

function boxContains(
  outer: MeshComponent["bounds"],
  inner: MeshComponent["bounds"]
): boolean {
  return (
    inner.min.x >= outer.min.x &&
    inner.min.y >= outer.min.y &&
    inner.min.z >= outer.min.z &&
    inner.max.x <= outer.max.x &&
    inner.max.y <= outer.max.y &&
    inner.max.z <= outer.max.z
  );
}

/** Drop loose fragments and trapped interior shells. */
export function cleanupComponents(
  mesh: MeshData,
  options: CleanupOptions = {}
): CleanupResult {
  const minFraction = options.minVolumeFraction ?? 0.001;
  const removeInterior = options.removeInteriorShells ?? true;
  const components = splitComponents(mesh);
  if (components.length <= 1) {
    return {
      mesh,
      smallShellsRemoved: 0,
      interiorShellsRemoved: 0,
      removedVolumeMm3: 0,
    };
  }

  const largest = components[0];
  const keep: MeshComponent[] = [];
  let smallShellsRemoved = 0;
  let interiorShellsRemoved = 0;
  let removedVolumeMm3 = 0;

  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    if (i > 0 && minFraction > 0 && c.volumeMm3 < largest.volumeMm3 * minFraction) {
      smallShellsRemoved++;
      removedVolumeMm3 += c.volumeMm3;
      continue;
    }
    if (removeInterior && i > 0) {
      // Enclosed by any bigger component that we are keeping?
      const enclosed = components
        .slice(0, i)
        .some((outer) => boxContains(outer.bounds, c.bounds));
      if (enclosed) {
        interiorShellsRemoved++;
        removedVolumeMm3 += c.volumeMm3;
        continue;
      }
    }
    keep.push(c);
  }

  if (smallShellsRemoved === 0 && interiorShellsRemoved === 0) {
    return {
      mesh,
      smallShellsRemoved: 0,
      interiorShellsRemoved: 0,
      removedVolumeMm3: 0,
    };
  }
  return {
    mesh: mergeComponents(keep),
    smallShellsRemoved,
    interiorShellsRemoved,
    removedVolumeMm3,
  };
}
