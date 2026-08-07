/**
 * Voxel remesh — the "make solid" last resort.
 *
 * Samples a signed-distance field around the input mesh and rebuilds the
 * surface with marching tetrahedra (`kernel.levelSet`). Because the output is
 * generated from a field rather than from the input triangles, it is
 * watertight and manifold BY CONSTRUCTION regardless of how broken the input
 * was: holes close, self-intersections dissolve, inverted normals stop
 * mattering, and interior debris is swallowed.
 *
 * The cost is honest and must be reported to the user: detail finer than the
 * voxel size is lost, and sharp edges are rounded by roughly half a voxel.
 * This is the same trade Meshmixer's "Make Solid" makes.
 *
 * Sign convention: `kernel.levelSet` treats POSITIVE as inside.
 */

import { MeshBvh } from "../bvh";
import { getGeometryKernel } from "../kernel";
import { meshDataVolume, type MeshData } from "../meshData";
import { orientConsistently } from "./topology";

export interface VoxelRemeshOptions {
  /**
   * Target voxel size in mm. Smaller keeps more detail and costs
   * cubically more time. Defaults to a size that puts ~128 voxels across the
   * model's longest axis.
   */
  voxelSizeMm?: number;
  /**
   * Grow (positive) or shrink (negative) the result, mm. A small positive
   * offset closes pinholes that are narrower than one voxel.
   */
  offsetMm?: number;
  /** Hard cap on total voxels, to refuse jobs that would hang the browser. */
  maxVoxels?: number;
}

export interface VoxelRemeshResult {
  mesh: MeshData;
  voxelSizeMm: number;
  triangleCount: number;
  /** Mesh volume before and after, for an honest "what did this cost" report. */
  volumeBeforeMm3: number;
  volumeAfterMm3: number;
}

const DEFAULT_VOXELS_ACROSS = 128;
const DEFAULT_MAX_VOXELS = 40_000_000;

/**
 * Signed distance to the mesh surface, positive inside.
 *
 * Inside/outside uses the WINDING NUMBER along a ray, not crossing parity.
 * Parity implements the XOR rule: a point inside two overlapping shells is
 * reported outside, so a self-intersecting model comes back with its overlap
 * carved out instead of merged. Counting signed crossings implements the
 * nonzero rule, which is the union semantics every user expects when they ask
 * a broken model to be made solid.
 *
 * Three near-axis rays vote, so a ray that grazes an edge cannot flip the
 * result. Directions are deliberately skewed off the axes to avoid running
 * exactly along the shared edges of an axis-aligned model.
 */
function makeSignedDistance(bvh: MeshBvh): (p: { x: number; y: number; z: number }) => number {
  const directions = [
    { x: 1, y: 0.01234, z: 0.00789 },
    { x: 0.00913, y: 1, z: 0.01427 },
    { x: 0.01201, y: 0.00658, z: 1 },
  ];
  return (p) => {
    const closest = bvh.closestPoint(p);
    if (!closest) return -1;
    const distance = Math.sqrt(closest.distanceSq);
    let insideVotes = 0;
    for (const d of directions) {
      if (bvh.windingAlongRay(p, d) !== 0) insideVotes++;
    }
    return insideVotes >= 2 ? distance : -distance;
  };
}

/** Rebuild a mesh as a guaranteed-manifold solid via its distance field. */
export async function voxelRemesh(
  mesh: MeshData,
  options: VoxelRemeshOptions = {}
): Promise<VoxelRemeshResult> {
  if (mesh.indices.length === 0) {
    throw new Error("voxelRemesh: empty mesh");
  }
  // The winding-number test below is only meaningful on consistently
  // outward-facing triangles, so normalise orientation first. This is
  // lossless and idempotent — a mesh that is already correct is untouched.
  const { mesh: oriented } = orientConsistently(mesh);
  const bvh = new MeshBvh(oriented);
  const { min, max } = bvh.bounds();
  const sizeX = max.x - min.x;
  const sizeY = max.y - min.y;
  const sizeZ = max.z - min.z;
  const longest = Math.max(sizeX, sizeY, sizeZ);
  if (!(longest > 0)) throw new Error("voxelRemesh: degenerate bounding box");

  const offset = options.offsetMm ?? 0;
  let voxel = options.voxelSizeMm ?? longest / DEFAULT_VOXELS_ACROSS;
  if (!(voxel > 0)) voxel = longest / DEFAULT_VOXELS_ACROSS;

  // Pad so the surface is never clipped by the sampling box.
  const pad = voxel * 3 + Math.max(0, offset);
  const bounds = {
    min: { x: min.x - pad, y: min.y - pad, z: min.z - pad },
    max: { x: max.x + pad, y: max.y + pad, z: max.z + pad },
  };

  const maxVoxels = options.maxVoxels ?? DEFAULT_MAX_VOXELS;
  const estimate =
    ((bounds.max.x - bounds.min.x) / voxel) *
    ((bounds.max.y - bounds.min.y) / voxel) *
    ((bounds.max.z - bounds.min.z) / voxel);
  if (estimate > maxVoxels) {
    // Coarsen rather than fail: a usable result beats a refusal.
    voxel *= Math.cbrt(estimate / maxVoxels);
  }

  const sdf = makeSignedDistance(bvh);
  const kernel = await getGeometryKernel();
  // `level` insets/outsets the isosurface, which is exactly the offset knob.
  const solid = kernel.levelSet(sdf, bounds, voxel, -offset);
  if (solid.isEmpty()) {
    solid.dispose();
    throw new Error("voxelRemesh: the distance field produced no surface");
  }
  const result = solid.toMeshData();
  const triangleCount = solid.numTriangles();
  const volumeAfter = solid.volumeMm3();
  solid.dispose();

  return {
    mesh: result,
    voxelSizeMm: voxel,
    triangleCount,
    volumeBeforeMm3: meshDataVolume(mesh),
    volumeAfterMm3: volumeAfter,
  };
}
