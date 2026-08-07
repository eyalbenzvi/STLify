/**
 * BVH-backed replacement for THREE.Mesh.raycast, used by the viewport.
 *
 * three's built-in raycast is a linear scan: every hover over an imported
 * 500K-triangle STL tested half a million triangles per pointer move. The
 * project already owns a triangle BVH (lib/geometry/bvh.ts) — this module
 * routes viewport picking through it, keeping the exact event semantics the
 * scene handlers rely on (closest hit, `faceIndex` in the part's local
 * triangle order, `face.normal` in OBJECT space, double-sided).
 *
 * The BVH is cached per MeshData identity (a rebuild produces new MeshData,
 * so the cache invalidates itself with the build), and is only constructed
 * when a ray actually passes the part's bounding sphere — parts the pointer
 * never approaches never pay for a build.
 */

import * as THREE from "three";
import { MeshBvh } from "./bvh";
import type { MeshData } from "./meshData";

const bvhCache = new WeakMap<MeshData, MeshBvh>();

/** Get (or lazily build) the pick BVH for a mesh payload. */
export function pickBvhFor(mesh: MeshData): MeshBvh {
  let bvh = bvhCache.get(mesh);
  if (!bvh) {
    bvh = new MeshBvh(mesh);
    bvhCache.set(mesh, bvh);
  }
  return bvh;
}

// Scratch objects — raycasts run on every pointer move, so no allocation.
const _sphere = new THREE.Sphere();
const _inverseMatrix = new THREE.Matrix4();
const _localRay = new THREE.Ray();

export type MeshRaycastFn = (
  this: THREE.Mesh,
  raycaster: THREE.Raycaster,
  intersects: THREE.Intersection[]
) => void;

/**
 * Build a `raycast` function for a viewport mesh whose geometry was created
 * from `mesh` (same triangle order — that is what makes `faceIndex` valid
 * for the sub-object selection operations downstream).
 */
export function createBvhRaycast(mesh: MeshData): MeshRaycastFn {
  return function bvhRaycast(raycaster, intersects) {
    const geometry = this.geometry as THREE.BufferGeometry;

    // Same cheap broad-phase three uses, so a part the ray misses entirely
    // costs one sphere test and never builds its BVH.
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
    const boundingSphere = geometry.boundingSphere;
    if (!boundingSphere) return;
    _sphere.copy(boundingSphere).applyMatrix4(this.matrixWorld);
    if (!raycaster.ray.intersectsSphere(_sphere)) return;

    _inverseMatrix.copy(this.matrixWorld).invert();
    _localRay.copy(raycaster.ray).applyMatrix4(_inverseMatrix);

    const hit = pickBvhFor(mesh).raycastClosest(
      { x: _localRay.origin.x, y: _localRay.origin.y, z: _localRay.origin.z },
      { x: _localRay.direction.x, y: _localRay.direction.y, z: _localRay.direction.z }
    );
    if (!hit) return;

    const point = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z).applyMatrix4(
      this.matrixWorld
    );
    const distance = raycaster.ray.origin.distanceTo(point);
    if (distance < raycaster.near || distance > raycaster.far) return;

    const t = hit.triangleIndex;
    const a = mesh.indices[t * 3];
    const b = mesh.indices[t * 3 + 1];
    const c = mesh.indices[t * 3 + 2];
    // Object-space normal, exactly like THREE.Mesh.raycast — the scene
    // handlers transform it to world themselves via matrixWorld.
    const normal = new THREE.Vector3();
    THREE.Triangle.getNormal(
      new THREE.Vector3().fromArray(mesh.positions, a * 3),
      new THREE.Vector3().fromArray(mesh.positions, b * 3),
      new THREE.Vector3().fromArray(mesh.positions, c * 3),
      normal
    );

    intersects.push({
      distance,
      point,
      object: this,
      faceIndex: t,
      face: { a, b, c, normal, materialIndex: 0 },
      uv: undefined,
    });
  };
}
