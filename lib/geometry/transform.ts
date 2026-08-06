/**
 * Transform3D (mm / degrees TRS) ⇄ matrix conversions, shared by the
 * three.js preview and the Manifold kernel so the visual pose and the
 * exported geometry are always identical.
 */

import * as THREE from "three";
import type { Transform3D } from "@/types/design";

const DEG = Math.PI / 180;

/** Compose a three.js matrix: M = T · R(XYZ euler) · S. */
export function transformToMatrix4(t: Transform3D): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(t.rotationX * DEG, t.rotationY * DEG, t.rotationZ * DEG, "XYZ")
  );
  matrix.compose(
    new THREE.Vector3(t.x, t.y, t.z),
    quaternion,
    new THREE.Vector3(t.scaleX, t.scaleY, t.scaleZ)
  );
  return matrix;
}

/** Manifold Mat4: full 4x4 in column-major order — same layout as three.js. */
export function transformToManifoldMat4(t: Transform3D): number[] {
  return [...transformToMatrix4(t).elements];
}

/** Convert an arbitrary three.js matrix to a Manifold Mat4 array. */
export function matrix4ToManifoldMat4(matrix: THREE.Matrix4): number[] {
  return [...matrix.elements];
}

/** Decompose a three.js matrix back into a Transform3D (XYZ euler, degrees). */
export function matrix4ToTransform(matrix: THREE.Matrix4): Transform3D {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return {
    x: position.x,
    y: position.y,
    z: position.z,
    rotationX: euler.x / DEG,
    rotationY: euler.y / DEG,
    rotationZ: euler.z / DEG,
    scaleX: scale.x,
    scaleY: scale.y,
    scaleZ: scale.z,
  };
}

/** Round tiny float noise so repeated gizmo edits don't drift the numbers. */
export function snapTransformNoise(t: Transform3D, decimals = 4): Transform3D {
  const f = 10 ** decimals;
  const r = (v: number) => Math.round(v * f) / f;
  return {
    x: r(t.x),
    y: r(t.y),
    z: r(t.z),
    rotationX: r(normalizeDeg(t.rotationX)),
    rotationY: r(normalizeDeg(t.rotationY)),
    rotationZ: r(normalizeDeg(t.rotationZ)),
    scaleX: r(t.scaleX),
    scaleY: r(t.scaleY),
    scaleZ: r(t.scaleZ),
  };
}

/** Normalize an angle to (-180, 180]. */
export function normalizeDeg(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a === 0 ? 0 : a;
}

/** True when the transform has a negative determinant (mirrored). */
export function isMirrored(t: Transform3D): boolean {
  return t.scaleX * t.scaleY * t.scaleZ < 0;
}
