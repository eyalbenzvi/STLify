/**
 * Mesh inspection utilities: bounding box, triangle count and an
 * edge-manifoldness (watertightness) check used to gate STL export.
 */

import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MeshStats } from "./types";

/**
 * Compute stats for a geometry. The watertight check verifies that every
 * edge is shared by exactly two triangles (edge-manifold), which is the
 * practical requirement for slicers.
 */
export function computeMeshStats(geometry: THREE.BufferGeometry): MeshStats {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new THREE.Box3();
  const size = new THREE.Vector3();
  box.getSize(size);

  // Merge duplicate vertices so shared edges are detectable, then walk the
  // index and count how many triangles use each edge. Welding considers
  // positions only: other attributes (normals) differ across crease edges
  // and would prevent merging.
  let indexed = geometry;
  if (!geometry.index) {
    const positionOnly = new THREE.BufferGeometry();
    positionOnly.setAttribute("position", geometry.getAttribute("position"));
    indexed = mergeVertices(positionOnly, 1e-4);
  }
  const index = indexed.index;

  let triangleCount: number;
  let openEdgeCount = 0;

  if (index) {
    triangleCount = index.count / 3;
    const edgeUse = new Map<string, number>();
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
      }
    }
    for (const count of edgeUse.values()) {
      if (count !== 2) openEdgeCount++;
    }
  } else {
    triangleCount = geometry.getAttribute("position").count / 3;
    openEdgeCount = -1; // unknown
  }

  return {
    triangleCount,
    dimensionsMm: {
      x: round2(size.x),
      y: round2(size.y),
      z: round2(size.z),
    },
    watertight: openEdgeCount === 0,
    openEdgeCount: Math.max(openEdgeCount, 0),
  };
}

/**
 * Centre the geometry around the XY origin and place its lowest point at
 * Z = 0 (the STL export convention used by this app). Mutates the geometry.
 */
export function normalizePlacement(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return;
  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  geometry.translate(-cx, -cy, -box.min.z);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
