/**
 * Viewport picking through the BVH (V6 item 1).
 *
 * Two claims, both measured rather than assumed:
 *
 * 1. IDENTICAL SEMANTICS — for rays fired at a transformed heavy mesh, the
 *    BVH raycast returns the same triangle, the same distance and the same
 *    hit point as three's built-in linear-scan Mesh.raycast.
 * 2. ORDER-OF-MAGNITUDE CHEAPER — the number of narrow-phase triangle tests
 *    per pick is at least 10x below the triangle count (which is exactly
 *    what the linear scan pays for every pointer move).
 */

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { MeshBvh, type RaycastStats } from "../bvh";
import { geometryToMeshData, meshDataToGeometry } from "../meshData";
import { createBvhRaycast } from "../viewportRaycast";

/** A heavy synthetic mesh: ~80K triangles. */
function heavySphere(): ReturnType<typeof geometryToMeshData> {
  const geometry = new THREE.SphereGeometry(40, 280, 140);
  const mesh = geometryToMeshData(geometry);
  geometry.dispose();
  return mesh;
}

function buildTransformedMesh(data: ReturnType<typeof heavySphere>): THREE.Mesh {
  const mesh = new THREE.Mesh(
    meshDataToGeometry(data),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  );
  // Non-trivial pose: translation, rotation and non-uniform scale, so the
  // local-space path through the BVH is genuinely exercised.
  mesh.position.set(12, -7, 30);
  mesh.rotation.set(0.4, -0.25, 0.7);
  mesh.scale.set(1.4, 1.0, 0.75);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** Deterministic ray fan aimed at the posed body from many directions. */
function rayFan(count: number): THREE.Ray[] {
  const rays: THREE.Ray[] = [];
  const target = new THREE.Vector3(12, -7, 30);
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * Math.PI * 2;
    const phi = Math.acos(2 * ((i * 7919) % count) / count - 1);
    const origin = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi)
    )
      .multiplyScalar(400)
      .add(target);
    // Slight off-centre jitter so rays cross different triangles.
    const aim = target
      .clone()
      .add(new THREE.Vector3(((i * 13) % 21) - 10, ((i * 29) % 17) - 8, ((i * 31) % 23) - 11));
    rays.push(new THREE.Ray(origin, aim.sub(origin).normalize()));
  }
  return rays;
}

describe("viewport BVH raycast", () => {
  const data = heavySphere();
  const triangleCount = data.indices.length / 3;

  it("returns exactly what three's linear-scan raycast returns", () => {
    const mesh = buildTransformedMesh(data);
    const raycaster = new THREE.Raycaster();
    const bvhRaycast = createBvhRaycast(data);

    let hits = 0;
    for (const ray of rayFan(60)) {
      raycaster.set(ray.origin, ray.direction);

      const reference = raycaster.intersectObject(mesh, false);
      const ours: THREE.Intersection[] = [];
      bvhRaycast.call(mesh, raycaster, ours);
      ours.sort((a, b) => a.distance - b.distance);

      expect(ours.length > 0).toBe(reference.length > 0);
      if (reference.length === 0) continue;
      hits++;

      const expected = reference[0];
      const actual = ours[0];
      expect(actual.faceIndex).toBe(expected.faceIndex);
      expect(actual.distance).toBeCloseTo(expected.distance, 4);
      expect(actual.point.distanceTo(expected.point)).toBeLessThan(1e-3);
      // Object-space normal, same convention as three (scene handlers
      // transform it to world themselves).
      expect(actual.face && expected.face
        ? actual.face.normal.distanceTo(expected.face.normal)
        : Infinity
      ).toBeLessThan(1e-4);
    }
    // The fan must actually hit the body for the comparison to mean anything.
    expect(hits).toBeGreaterThan(40);
  });

  it("costs an order of magnitude fewer triangle tests than a linear scan", () => {
    const bvh = new MeshBvh(data);
    expect(triangleCount).toBeGreaterThan(50_000);

    let worst = 0;
    for (const ray of rayFan(40)) {
      const stats: RaycastStats = { triangleTests: 0 };
      bvh.raycastClosest(ray.origin, ray.direction, stats);
      worst = Math.max(worst, stats.triangleTests);
    }
    // A linear scan tests every triangle on every pick. Require at least a
    // 10x drop on the WORST pick of the fan, not the average.
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(triangleCount / 10);
  });
});
