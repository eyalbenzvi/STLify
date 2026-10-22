/**
 * Placement of eDrawings components in the editor's world: unit, up axis,
 * scale, and the shared rebase onto the build plate.
 *
 * Pure functions so the import screen's preview and the actual import agree
 * on exactly the same numbers.
 */

import type { MeshData } from "@/lib/geometry/meshData";
import { EDRAWINGS_UNIT_TO_MM, type EDrawingsBounds, type EDrawingsUnit } from "./model";

/** "z": keep the file's axes. "y": the file is Y-up — rotate it onto Z-up. */
export type EDrawingsUpAxis = "z" | "y";

export interface EDrawingsPlacement {
  unit: EDrawingsUnit;
  upAxis: EDrawingsUpAxis;
  /** Model scale on top of the unit conversion (0.01 = 1:100). */
  scale: number;
}

export const DEFAULT_EDRAWINGS_PLACEMENT: EDrawingsPlacement = {
  unit: "m",
  upAxis: "z",
  scale: 1,
};

/** Scale presets offered by the import screen (architectural ratios). */
export const EDRAWINGS_SCALE_PRESETS: { value: number; labelHe: string }[] = [
  { value: 1, labelHe: "1:1 (גודל אמיתי)" },
  { value: 1 / 10, labelHe: "1:10" },
  { value: 1 / 20, labelHe: "1:20" },
  { value: 1 / 50, labelHe: "1:50" },
  { value: 1 / 100, labelHe: "1:100" },
  { value: 1 / 200, labelHe: "1:200" },
];

/** Millimetres per file unit after scale. */
export function placementFactor(placement: EDrawingsPlacement): number {
  return EDRAWINGS_UNIT_TO_MM[placement.unit] * placement.scale;
}

/** Map one file-space point to editor space (mm, Z-up), before rebasing. */
function mapPoint(
  x: number,
  y: number,
  z: number,
  factor: number,
  upAxis: EDrawingsUpAxis
): [number, number, number] {
  // +90° about X carries +Y onto +Z and keeps handedness, so winding holds.
  return upAxis === "y" ? [x * factor, -z * factor, y * factor] : [x * factor, y * factor, z * factor];
}

/** Bounds of a set of components after placement (mm), before rebasing. */
export function placedBounds(
  bounds: EDrawingsBounds[],
  placement: EDrawingsPlacement
): EDrawingsBounds | null {
  if (bounds.length === 0) return null;
  const factor = placementFactor(placement);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of bounds) {
    for (const x of [b.min[0], b.max[0]]) {
      for (const y of [b.min[1], b.max[1]]) {
        for (const z of [b.min[2], b.max[2]]) {
          const p = mapPoint(x, y, z, factor, placement.upAxis);
          for (let k = 0; k < 3; k++) {
            if (p[k] < min[k]) min[k] = p[k];
            if (p[k] > max[k]) max[k] = p[k];
          }
        }
      }
    }
  }
  return { min, max };
}

/** The translation that centres XY and rests the selection on Z = 0. */
export function rebaseOffset(bounds: EDrawingsBounds): [number, number, number] {
  return [
    -(bounds.min[0] + bounds.max[0]) / 2,
    -(bounds.min[1] + bounds.max[1]) / 2,
    -bounds.min[2],
  ];
}

/** Component geometry → editor MeshData (mm, Z-up, rebased by `offset`). */
export function placeGeometry(
  geometry: MeshData,
  placement: EDrawingsPlacement,
  offset: [number, number, number]
): MeshData {
  const factor = placementFactor(placement);
  const src = geometry.positions;
  const positions = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const p = mapPoint(src[i], src[i + 1], src[i + 2], factor, placement.upAxis);
    positions[i] = p[0] + offset[0];
    positions[i + 1] = p[1] + offset[1];
    positions[i + 2] = p[2] + offset[2];
  }
  return { positions, indices: geometry.indices.slice() };
}

/** Scale that fits the largest dimension to `targetMm` (unit applied). */
export function fitScale(
  bounds: EDrawingsBounds[],
  unit: EDrawingsUnit,
  targetMm: number
): number {
  const placed = placedBounds(bounds, { unit, upAxis: "z", scale: 1 });
  if (!placed) return 1;
  const size = Math.max(...[0, 1, 2].map((k) => placed.max[k] - placed.min[k]));
  return size > 0 ? targetMm / size : 1;
}

/** Concatenate meshes into one (no welding). */
export function concatMeshes(meshes: MeshData[]): MeshData {
  let vertexCount = 0;
  let indexCount = 0;
  for (const m of meshes) {
    vertexCount += m.positions.length;
    indexCount += m.indices.length;
  }
  const positions = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  let vOffset = 0;
  let iOffset = 0;
  for (const m of meshes) {
    positions.set(m.positions, vOffset);
    const base = vOffset / 3;
    for (let i = 0; i < m.indices.length; i++) indices[iOffset + i] = m.indices[i] + base;
    vOffset += m.positions.length;
    iOffset += m.indices.length;
  }
  return { positions, indices };
}
