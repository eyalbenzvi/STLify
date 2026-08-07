/**
 * Axis-aligned box arithmetic, shared by everything that has to answer
 * "how big is this, and where is its middle?" — the viewport's framing and
 * view presets, the dimensions readout, and the export dialog's plate check.
 *
 * Each of those grew its own copy of the same min/max fold; this is the one
 * they all call now.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

/**
 * Smallest box containing every input box, or null when there are none —
 * null rather than an empty box at the origin, because "nothing to measure"
 * and "a zero-sized thing at the origin" lead to different UI.
 */
export function unionBounds(boxes: Iterable<Bounds3>): Bounds3 | null {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  let any = false;
  for (const box of boxes) {
    any = true;
    if (box.min.x < min.x) min.x = box.min.x;
    if (box.min.y < min.y) min.y = box.min.y;
    if (box.min.z < min.z) min.z = box.min.z;
    if (box.max.x > max.x) max.x = box.max.x;
    if (box.max.y > max.y) max.y = box.max.y;
    if (box.max.z > max.z) max.z = box.max.z;
  }
  return any ? { min, max } : null;
}

/** Width, depth and height of the box, in mm. */
export function boundsSize(bounds: Bounds3): Vec3 {
  return {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
    z: bounds.max.z - bounds.min.z,
  };
}

/** Midpoint of the box. */
export function boundsCenter(bounds: Bounds3): Vec3 {
  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
}

/**
 * Radius of the sphere around the box — half its diagonal. `fallbackMm`
 * covers the degenerate case (a single point, a flat sheet seen edge-on),
 * where a zero radius would make the camera framing collapse.
 */
export function boundsRadius(bounds: Bounds3, fallbackMm = 10): number {
  const size = boundsSize(bounds);
  return Math.hypot(size.x, size.y, size.z) / 2 || fallbackMm;
}
