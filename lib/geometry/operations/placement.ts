/**
 * Placement and alignment tools: pure Transform3D math over world-space
 * bounding boxes. The viewer/store supplies each layer's current world
 * bounds (from the built parts); these helpers return NEW transforms —
 * they never mutate and never touch geometry, so they are cheap enough to
 * run per keystroke and easy to unit-test.
 */

import * as THREE from "three";
import type { Transform3D } from "@/types/design";
import { matrix4ToTransform, snapTransformNoise, transformToMatrix4 } from "../transform";

export interface WorldBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export type Axis = "x" | "y" | "z";
export type AlignMode = "min" | "center" | "max";

/** Move so the lowest point touches Z=0. X/Y are left untouched. */
export function dropToPlate(transform: Transform3D, bounds: WorldBounds): Transform3D {
  return snapTransformNoise({ ...transform, z: transform.z - bounds.min.z });
}

/** Centre the object on the build plate origin (XY only). */
export function centerOnPlate(transform: Transform3D, bounds: WorldBounds): Transform3D {
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cy = (bounds.min.y + bounds.max.y) / 2;
  return snapTransformNoise({ ...transform, x: transform.x - cx, y: transform.y - cy });
}

/** Mirror the layer over the axis plane through its own centre. */
export function mirrorTransform(
  transform: Transform3D,
  bounds: WorldBounds,
  axis: Axis
): Transform3D {
  // Flip scale on the axis, then restore the object's centre position.
  const centre = {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
  const m = transformToMatrix4(transform);
  const toCentre = new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z);
  const mirror = new THREE.Matrix4().makeScale(
    axis === "x" ? -1 : 1,
    axis === "y" ? -1 : 1,
    axis === "z" ? -1 : 1
  );
  const back = new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z);
  const result = back.multiply(mirror).multiply(toCentre).multiply(m);
  return snapTransformNoise(matrix4ToTransform(result));
}

/** Align several layers on one axis (by their world bounds). */
export function alignTransforms(
  items: { transform: Transform3D; bounds: WorldBounds }[],
  axis: Axis,
  mode: AlignMode
): Transform3D[] {
  if (items.length === 0) return [];
  const pick = (b: WorldBounds): number =>
    mode === "min" ? b.min[axis] : mode === "max" ? b.max[axis] : (b.min[axis] + b.max[axis]) / 2;
  // Align everyone to the first selected layer's reference value.
  const target = pick(items[0].bounds);
  return items.map(({ transform, bounds }) => {
    const delta = target - pick(bounds);
    return snapTransformNoise({ ...transform, [axis]: transform[axis] + delta });
  });
}

/** Evenly distribute ≥3 layers between the two extreme ones on an axis. */
export function distributeTransforms(
  items: { transform: Transform3D; bounds: WorldBounds }[],
  axis: Axis
): Transform3D[] {
  if (items.length < 3) return items.map((i) => i.transform);
  const centres = items.map(
    (i) => (i.bounds.min[axis] + i.bounds.max[axis]) / 2
  );
  const order = centres
    .map((c, index) => ({ c, index }))
    .sort((a, b) => a.c - b.c);
  const lo = order[0].c;
  const hi = order[order.length - 1].c;
  const step = (hi - lo) / (order.length - 1);
  const result = items.map((i) => i.transform);
  order.forEach(({ index }, rank) => {
    const targetCentre = lo + step * rank;
    const delta = targetCentre - centres[index];
    const t = items[index].transform;
    result[index] = snapTransformNoise({ ...t, [axis]: t[axis] + delta });
  });
  return result;
}

/**
 * Orient an object so its local bottom face rests on a clicked surface.
 * The rotation aligns the object's +Z with the surface normal; position
 * places the bottom-centre at the hit point plus the offset along the
 * normal. Existing scale is preserved; existing rotation is replaced.
 */
export function placeOnSurface(
  transform: Transform3D,
  localBounds: WorldBounds,
  hitPoint: { x: number; y: number; z: number },
  hitNormal: { x: number; y: number; z: number },
  offsetMm: number
): Transform3D {
  const n = new THREE.Vector3(hitNormal.x, hitNormal.y, hitNormal.z);
  if (n.lengthSq() < 1e-9) n.set(0, 0, 1);
  n.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  const scale = new THREE.Vector3(transform.scaleX, transform.scaleY, transform.scaleZ);
  // Bottom-centre of the object's local bounds, scaled.
  const bottom = new THREE.Vector3(
    ((localBounds.min.x + localBounds.max.x) / 2) * scale.x,
    ((localBounds.min.y + localBounds.max.y) / 2) * scale.y,
    localBounds.min.z * scale.z
  ).applyQuaternion(q);
  const target = new THREE.Vector3(hitPoint.x, hitPoint.y, hitPoint.z).addScaledVector(
    n,
    offsetMm
  );
  const position = target.sub(bottom);
  const matrix = new THREE.Matrix4().compose(position, q, scale);
  return snapTransformNoise(matrix4ToTransform(matrix));
}

/**
 * Rotate the object so a chosen face normal on it points along (or against)
 * a target face normal, keeping the object's centre in place. Used by
 * "align face to face".
 */
export function alignFaceToFace(
  transform: Transform3D,
  bounds: WorldBounds,
  sourceNormal: { x: number; y: number; z: number },
  targetNormal: { x: number; y: number; z: number },
  opposite: boolean
): Transform3D {
  const from = new THREE.Vector3(sourceNormal.x, sourceNormal.y, sourceNormal.z).normalize();
  const to = new THREE.Vector3(targetNormal.x, targetNormal.y, targetNormal.z).normalize();
  if (opposite) to.negate();
  const q = new THREE.Quaternion().setFromUnitVectors(from, to);
  const centre = new THREE.Vector3(
    (bounds.min.x + bounds.max.x) / 2,
    (bounds.min.y + bounds.max.y) / 2,
    (bounds.min.z + bounds.max.z) / 2
  );
  const m = transformToMatrix4(transform);
  const rotation = new THREE.Matrix4().makeRotationFromQuaternion(q);
  const toCentre = new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z);
  const back = new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z);
  const result = back.multiply(rotation).multiply(toCentre).multiply(m);
  return snapTransformNoise(matrix4ToTransform(result));
}

/** Snap a translation to the given grid (0 disables). */
export function snapToGrid(transform: Transform3D, gridMm: number): Transform3D {
  if (gridMm <= 0) return transform;
  const snap = (v: number) => Math.round(v / gridMm) * gridMm;
  return { ...transform, x: snap(transform.x), y: snap(transform.y), z: snap(transform.z) };
}

/** Move object A so its centre coincides with object B's centre. */
export function snapToObjectCenter(
  transform: Transform3D,
  bounds: WorldBounds,
  targetBounds: WorldBounds
): Transform3D {
  const delta = {
    x:
      (targetBounds.min.x + targetBounds.max.x) / 2 -
      (bounds.min.x + bounds.max.x) / 2,
    y:
      (targetBounds.min.y + targetBounds.max.y) / 2 -
      (bounds.min.y + bounds.max.y) / 2,
    z:
      (targetBounds.min.z + targetBounds.max.z) / 2 -
      (bounds.min.z + bounds.max.z) / 2,
  };
  return snapTransformNoise({
    ...transform,
    x: transform.x + delta.x,
    y: transform.y + delta.y,
    z: transform.z + delta.z,
  });
}

/** Move object A so its nearest edge touches object B's nearest edge on an axis. */
export function snapToObjectEdge(
  transform: Transform3D,
  bounds: WorldBounds,
  targetBounds: WorldBounds,
  axis: Axis
): Transform3D {
  // Choose the direction that requires the smaller move: touch target's max
  // with our min, or target's min with our max.
  const moveToMax = targetBounds.max[axis] - bounds.min[axis];
  const moveToMin = targetBounds.min[axis] - bounds.max[axis];
  const delta = Math.abs(moveToMax) <= Math.abs(moveToMin) ? moveToMax : moveToMin;
  return snapTransformNoise({ ...transform, [axis]: transform[axis] + delta });
}

export interface ScaleTargetOptions {
  axis: Axis | "longest";
  targetMm: number;
  uniform: boolean;
}

/** Scale so a chosen dimension reaches the target size. */
export function scaleToSize(
  transform: Transform3D,
  bounds: WorldBounds,
  options: ScaleTargetOptions
): Transform3D {
  const dims = {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
    z: bounds.max.z - bounds.min.z,
  };
  let axis: Axis;
  if (options.axis === "longest") {
    axis = dims.x >= dims.y && dims.x >= dims.z ? "x" : dims.y >= dims.z ? "y" : "z";
  } else {
    axis = options.axis;
  }
  const current = dims[axis];
  if (current < 1e-6 || options.targetMm <= 0) return transform;
  const factor = options.targetMm / current;
  if (options.uniform) {
    return snapTransformNoise({
      ...transform,
      scaleX: transform.scaleX * factor,
      scaleY: transform.scaleY * factor,
      scaleZ: transform.scaleZ * factor,
    });
  }
  const key = axis === "x" ? "scaleX" : axis === "y" ? "scaleY" : "scaleZ";
  return snapTransformNoise({ ...transform, [key]: transform[key] * factor });
}

/** Uniform factor that fits the bounds inside a printer's build volume. */
export function fitToBuildVolumeFactor(
  bounds: WorldBounds,
  buildVolumeMm: { x: number; y: number; z: number },
  marginMm = 2
): number {
  const dims = {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
    z: bounds.max.z - bounds.min.z,
  };
  const fx = (buildVolumeMm.x - marginMm) / Math.max(dims.x, 1e-6);
  const fy = (buildVolumeMm.y - marginMm) / Math.max(dims.y, 1e-6);
  const fz = (buildVolumeMm.z - marginMm) / Math.max(dims.z, 1e-6);
  return Math.min(fx, fy, fz, 1);
}

/** Offset used when duplicating a layer. */
export function duplicateTransform(
  transform: Transform3D,
  offset: { x: number; y: number; z: number }
): Transform3D {
  return snapTransformNoise({
    ...transform,
    x: transform.x + offset.x,
    y: transform.y + offset.y,
    z: transform.z + offset.z,
  });
}
