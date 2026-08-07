/**
 * Direct modelling on a selected region of triangles.
 *
 * These are the operations that turn "I can move a whole body" into "I can
 * edit this part of it": push/pull a face, smooth or simplify only what is
 * selected, delete a patch, or split a painted region into its own layer.
 *
 * Push/pull works through the kernel (extrude the region's outline, then
 * union or subtract), so its result is a guaranteed-manifold solid. The
 * mesh-level operations work directly on `MeshData` and are re-validated by
 * the caller through the standard manifold gate.
 */

import type { Contour, GeometryKernel, Solid } from "../kernel";
import type { MeshData } from "../meshData";
import { OpError } from "../operations/layerOps";
import { fillHoles } from "../repair/holeFill";
import { analyzeTopology } from "../repair/topology";
import {
  buildAdjacency,
  isSelectionPlanar,
  selectionBoundaryLoops,
  selectionCenter,
  selectionNormal,
  selectionVertices,
  type MeshAdjacency,
  type Vec3,
} from "./meshAdjacency";

// ---------------------------------------------------------------------------
// Push / pull
// ---------------------------------------------------------------------------

export interface PushPullSettings {
  /** Distance along the face normal. Positive adds material. */
  distanceMm: number;
}

/**
 * Move a planar face along its own normal, adding or removing material.
 *
 * The region's boundary loop is projected onto the face plane, extruded to
 * the requested depth, and unioned with (or subtracted from) the body. This
 * is the SketchUp/Shapr3D interaction, and doing it through the kernel means
 * the result is watertight even when the extrusion runs into other geometry.
 *
 * Consumes `solid`.
 */
export function pushPullRegion(
  kernel: GeometryKernel,
  solid: Solid,
  mesh: MeshData,
  selected: ReadonlySet<number>,
  settings: PushPullSettings
): Solid {
  const distance = settings.distanceMm;
  if (distance === 0) return solid;
  if (selected.size === 0) {
    solid.dispose();
    throw new OpError("לא נבחרו פאות");
  }

  const adjacency = buildAdjacency(mesh);
  if (!isSelectionPlanar(mesh, adjacency, selected, 0.05)) {
    solid.dispose();
    throw new OpError("הפאה שנבחרה אינה מישורית", [
      "בחרו פאה שטוחה (הרחיבו את הבחירה עם ״קופלנרי״)",
      "למשטחים מעוקלים השתמשו ב״עיבוי״ או ב״עיוות״",
    ]);
  }

  const loops = selectionBoundaryLoops(mesh, selected);
  if (loops.length === 0) {
    solid.dispose();
    throw new OpError("לא נמצא מתאר לפאה שנבחרה");
  }

  const normal = selectionNormal(adjacency, selected);
  const origin = selectionCenter(mesh, adjacency, selected);

  // Build an orthonormal frame on the face plane so the loops can be
  // expressed as 2D contours for the kernel.
  const { u, v } = planeBasis(normal);
  const pos = mesh.positions;
  const contours: Contour[] = loops.map((loop) =>
    loop.map((index): [number, number] => {
      const dx = pos[index * 3] - origin.x;
      const dy = pos[index * 3 + 1] - origin.y;
      const dz = pos[index * 3 + 2] - origin.z;
      return [dx * u.x + dy * u.y + dz * u.z, dx * v.x + dy * v.y + dz * v.z];
    })
  );

  // Extrude in the local frame, then place it on the face. The prism is
  // always OVERLAP longer than the requested distance so it never meets the
  // body on an exactly coplanar face, which is ambiguous for booleans — but
  // the overlap must always stick out into EMPTY space, never into material
  // that the operation is supposed to keep:
  //
  //   pull (d > 0): span [face - OVERLAP, face + d]  — overlap buried in the
  //                 body, where the union ignores it.
  //   push (d < 0): span [face - |d|, face + OVERLAP] — overlap sticks out
  //                 above the face, so the cut removes exactly |d|.
  //
  // Getting this backwards silently removes an extra OVERLAP of material.
  const OVERLAP = 0.05;
  const magnitude = Math.abs(distance);
  const prism = kernel
    .extrude(contours, magnitude + OVERLAP)
    .transform(frameMatrix(u, v, normal, origin));
  const shift = distance > 0 ? -OVERLAP : -magnitude;
  const placed = prism.translate(normal.x * shift, normal.y * shift, normal.z * shift);

  const result = distance > 0 ? solid.union(placed) : solid.subtract(placed);
  if (result.status() !== "NoError" || result.isEmpty()) {
    const status = result.status();
    result.dispose();
    throw new OpError(`הזזת הפאה נכשלה (${status})`, [
      "נסו מרחק קטן יותר",
      "ודאו שהפאה שנבחרה שלמה",
    ]);
  }
  return result;
}

function planeBasis(normal: Vec3): { u: Vec3; v: Vec3 } {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  const axis: Vec3 =
    ax <= ay && ax <= az
      ? { x: 1, y: 0, z: 0 }
      : ay <= az
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
  let ux = normal.y * axis.z - normal.z * axis.y;
  let uy = normal.z * axis.x - normal.x * axis.z;
  let uz = normal.x * axis.y - normal.y * axis.x;
  const length = Math.hypot(ux, uy, uz) || 1;
  ux /= length;
  uy /= length;
  uz /= length;
  return {
    u: { x: ux, y: uy, z: uz },
    v: {
      x: normal.y * uz - normal.z * uy,
      y: normal.z * ux - normal.x * uz,
      z: normal.x * uy - normal.y * ux,
    },
  };
}

/** Column-major 4x4 taking local (u, v, normal) space to world. */
function frameMatrix(u: Vec3, v: Vec3, n: Vec3, origin: Vec3): number[] {
  return [
    u.x, u.y, u.z, 0,
    v.x, v.y, v.z, 0,
    n.x, n.y, n.z, 0,
    origin.x, origin.y, origin.z, 1,
  ];
}

// ---------------------------------------------------------------------------
// Local smoothing
// ---------------------------------------------------------------------------

export interface LocalSmoothSettings {
  iterations: number;
  /** 0..1; how far each vertex moves towards its neighbours' average. */
  strength: number;
}

/**
 * Taubin-style smoothing restricted to the selected region.
 *
 * The existing smooth operation blurs the whole model, so fixing one rough
 * patch softens every crisp detail elsewhere. Here only the interior
 * vertices of the selection move; vertices on the selection's boundary are
 * pinned, which welds the smoothed patch to the untouched surface instead of
 * tearing a seam.
 */
export function smoothRegion(
  mesh: MeshData,
  selected: ReadonlySet<number>,
  settings: LocalSmoothSettings
): MeshData {
  if (selected.size === 0) throw new OpError("לא נבחרו פאות להחלקה");
  const iterations = Math.max(1, Math.min(Math.round(settings.iterations), 50));
  const lambda = Math.max(0.01, Math.min(settings.strength, 1)) * 0.5;
  const mu = -lambda * 1.02; // Taubin's shrink-compensating back-step.

  const movable = interiorVertices(mesh, selected);
  if (movable.size === 0) {
    throw new OpError("הבחירה קטנה מדי להחלקה מקומית", [
      "הרחיבו את הבחירה — קודקודי הגבול ננעלים כדי לא לקרוע את המשטח",
    ]);
  }

  const neighbours = vertexNeighbours(mesh);
  let positions = new Float32Array(mesh.positions);
  for (let i = 0; i < iterations; i++) {
    positions = laplacianStep(positions, neighbours, movable, lambda);
    positions = laplacianStep(positions, neighbours, movable, mu);
  }
  return { positions, indices: mesh.indices };
}

/** Vertices of the selection that are NOT on its boundary. */
function interiorVertices(mesh: MeshData, selected: ReadonlySet<number>): Set<number> {
  const all = selectionVertices(mesh, selected);
  const boundary = new Set<number>();
  for (const loop of selectionBoundaryLoops(mesh, selected)) {
    for (const v of loop) boundary.add(v);
  }
  const interior = new Set<number>();
  for (const v of all) if (!boundary.has(v)) interior.add(v);
  return interior;
}

function vertexNeighbours(mesh: MeshData): Map<number, Set<number>> {
  const map = new Map<number, Set<number>>();
  const add = (a: number, b: number) => {
    let set = map.get(a);
    if (!set) {
      set = new Set();
      map.set(a, set);
    }
    set.add(b);
  };
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i += 3) {
    add(idx[i], idx[i + 1]);
    add(idx[i + 1], idx[i]);
    add(idx[i + 1], idx[i + 2]);
    add(idx[i + 2], idx[i + 1]);
    add(idx[i + 2], idx[i]);
    add(idx[i], idx[i + 2]);
  }
  return map;
}

function laplacianStep(
  positions: Float32Array,
  neighbours: Map<number, Set<number>>,
  movable: ReadonlySet<number>,
  factor: number
): Float32Array<ArrayBuffer> {
  const out = new Float32Array(positions.length);
  out.set(positions);
  for (const v of movable) {
    const ring = neighbours.get(v);
    if (!ring || ring.size === 0) continue;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const n of ring) {
      cx += positions[n * 3];
      cy += positions[n * 3 + 1];
      cz += positions[n * 3 + 2];
    }
    cx /= ring.size;
    cy /= ring.size;
    cz /= ring.size;
    out[v * 3] = positions[v * 3] + factor * (cx - positions[v * 3]);
    out[v * 3 + 1] = positions[v * 3 + 1] + factor * (cy - positions[v * 3 + 1]);
    out[v * 3 + 2] = positions[v * 3 + 2] + factor * (cz - positions[v * 3 + 2]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delete region
// ---------------------------------------------------------------------------

export interface DeleteRegionResult {
  mesh: MeshData;
  trianglesRemoved: number;
  /** Whether the hole left behind was patched. */
  capped: boolean;
}

/**
 * Delete the selected triangles, optionally sealing the hole they leave.
 *
 * Deleting faces always opens the surface, so a printable result needs the
 * hole filled. Reusing the repair module's patcher means the seal is real
 * geometry, not a claim.
 */
export function deleteRegion(
  mesh: MeshData,
  selected: ReadonlySet<number>,
  options: { cap: boolean } = { cap: true }
): DeleteRegionResult {
  if (selected.size === 0) throw new OpError("לא נבחרו פאות למחיקה");
  const idx = mesh.indices;
  const triangleCount = idx.length / 3;
  if (selected.size >= triangleCount) {
    throw new OpError("לא ניתן למחוק את כל הפאות של הגוף");
  }
  const kept: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    if (selected.has(t)) continue;
    kept.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
  }
  let result: MeshData = {
    positions: mesh.positions,
    indices: new Uint32Array(kept),
  };
  let capped = false;
  if (options.cap) {
    const filled = fillHoles(result);
    if (filled.filled > 0) {
      result = filled.mesh;
      capped = true;
    }
  }
  return { mesh: result, trianglesRemoved: selected.size, capped };
}

// ---------------------------------------------------------------------------
// Split by paint
// ---------------------------------------------------------------------------

export interface SplitRegionResult {
  /** The selected patch, sealed into its own closed body. */
  regionMesh: MeshData;
  /** The remainder, sealed where the patch was taken out. */
  remainderMesh: MeshData;
}

/**
 * Separate a painted region into its own body.
 *
 * Both halves are capped, so each is a printable solid rather than an open
 * shell — this is how a model gets split for multi-colour printing or to cut
 * an awkward part along a freeform boundary that no plane could follow.
 */
export function splitByRegion(
  mesh: MeshData,
  selected: ReadonlySet<number>
): SplitRegionResult {
  if (selected.size === 0) throw new OpError("לא נבחרו פאות להפרדה");
  const idx = mesh.indices;
  const triangleCount = idx.length / 3;
  if (selected.size >= triangleCount) {
    throw new OpError("הבחירה כוללת את כל הגוף — אין מה להפריד");
  }

  const regionIndices: number[] = [];
  const remainderIndices: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const target = selected.has(t) ? regionIndices : remainderIndices;
    target.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
  }

  const seal = (indices: number[]): MeshData => {
    const open: MeshData = {
      positions: mesh.positions,
      indices: new Uint32Array(indices),
    };
    const filled = fillHoles(open);
    return compact(filled.mesh);
  };

  return {
    regionMesh: seal(regionIndices),
    remainderMesh: seal(remainderIndices),
  };
}

/** Drop vertices no triangle references, so each half carries only its own. */
function compact(mesh: MeshData): MeshData {
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i];
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
    indices[i] = mapped;
  }
  return { positions: new Float32Array(positions), indices };
}

// ---------------------------------------------------------------------------
// Region report
// ---------------------------------------------------------------------------

export interface RegionSummary {
  triangleCount: number;
  areaMm2: number;
  planar: boolean;
  normal: Vec3;
  center: Vec3;
  boundaryLoopCount: number;
  /** True when the whole mesh stays closed after removing this region. */
  closedAfterRemoval: boolean;
}

/** Facts about the current selection, for the properties panel. */
export function summarizeRegion(
  mesh: MeshData,
  adjacency: MeshAdjacency,
  selected: ReadonlySet<number>
): RegionSummary {
  let area = 0;
  for (const t of selected) area += adjacency.areas[t];
  const loops = selectionBoundaryLoops(mesh, selected);
  return {
    triangleCount: selected.size,
    areaMm2: area,
    planar: isSelectionPlanar(mesh, adjacency, selected, 0.05),
    normal: selectionNormal(adjacency, selected),
    center: selectionCenter(mesh, adjacency, selected),
    boundaryLoopCount: loops.length,
    closedAfterRemoval:
      selected.size > 0 &&
      analyzeTopology(deleteRegion(mesh, selected, { cap: true }).mesh).boundaryEdgeCount === 0,
  };
}
