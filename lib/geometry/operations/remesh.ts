/**
 * Isotropic remeshing.
 *
 * The pipeline could already DECIMATE (kernel simplify) and SMOOTH (Taubin),
 * but neither improves triangle quality: decimation leaves long slivers and
 * smoothing just moves bad triangles around. Several downstream operations
 * care about triangle quality rather than triangle count —
 * `hollow`/`thicken` simplify dense meshes before their Minkowski step and
 * warn that the wall thickness may drift, and the deformers need evenly
 * spaced vertices to bend smoothly.
 *
 * This is the standard incremental algorithm (Botsch & Kobbelt): repeatedly
 * split long edges, collapse short ones, then relax vertices tangentially.
 * The result is a mesh whose edges are all close to one target length.
 *
 * It works on `MeshData` and preserves the surface's shape by keeping every
 * relaxed vertex in its own tangent plane; the caller re-validates through
 * the manifold gate.
 */

import type { MeshData } from "../meshData";
import { OpError } from "./layerOps";
import { analyzeTopology, removeDegenerateTriangles, removeUnusedVertices } from "../repair/topology";

export interface RemeshSettings {
  /** Desired edge length, mm. */
  targetEdgeMm: number;
  /** Split/collapse/relax passes. Three to five is usually enough. */
  iterations: number;
  /**
   * Edges meeting at a sharper angle than this are treated as features and
   * their vertices are pinned, so remeshing a cube does not round its
   * corners off.
   */
  featureAngleDeg: number;
  /** Refuse to produce more than this many triangles. */
  maxTriangles?: number;
}

export interface RemeshResult {
  mesh: MeshData;
  trianglesBefore: number;
  trianglesAfter: number;
  /** Mean edge length after remeshing, mm. */
  meanEdgeMm: number;
  warningsHe: string[];
}

const DEFAULT_MAX_TRIANGLES = 400_000;

interface WorkingMesh {
  positions: number[];
  /** Triangle vertex indices; -1 marks a deleted triangle. */
  triangles: number[];
}

function toWorking(mesh: MeshData): WorkingMesh {
  return {
    positions: Array.from(mesh.positions),
    triangles: Array.from(mesh.indices),
  };
}

function toMeshData(work: WorkingMesh): MeshData {
  const indices: number[] = [];
  for (let i = 0; i < work.triangles.length; i += 3) {
    if (work.triangles[i] < 0) continue;
    indices.push(work.triangles[i], work.triangles[i + 1], work.triangles[i + 2]);
  }
  return {
    positions: new Float32Array(work.positions),
    indices: new Uint32Array(indices),
  };
}

function edgeKeyOf(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/** Undirected edges of the live triangles, with their incident triangles. */
function collectEdges(work: WorkingMesh): Map<string, number[]> {
  const edges = new Map<string, number[]>();
  for (let t = 0; t < work.triangles.length; t += 3) {
    if (work.triangles[t] < 0) continue;
    for (let k = 0; k < 3; k++) {
      const u = work.triangles[t + k];
      const v = work.triangles[t + ((k + 1) % 3)];
      const key = edgeKeyOf(u, v);
      const list = edges.get(key);
      if (list) list.push(t);
      else edges.set(key, [t]);
    }
  }
  return edges;
}

function edgeLength(work: WorkingMesh, a: number, b: number): number {
  return Math.hypot(
    work.positions[a * 3] - work.positions[b * 3],
    work.positions[a * 3 + 1] - work.positions[b * 3 + 1],
    work.positions[a * 3 + 2] - work.positions[b * 3 + 2]
  );
}

/**
 * Split every edge longer than `limit` at its midpoint.
 *
 * Both triangles sharing the edge are replaced by two each, which keeps the
 * surface closed at every step.
 */
function splitLongEdges(work: WorkingMesh, limit: number): number {
  const edges = collectEdges(work);
  let splits = 0;
  for (const [key, tris] of edges) {
    if (tris.length !== 2) continue; // only split manifold interior edges
    const [aStr, bStr] = key.split("_");
    const a = Number(aStr);
    const b = Number(bStr);
    if (edgeLength(work, a, b) <= limit) continue;
    // Both triangles must still be live (an earlier split may have replaced
    // one of them, in which case this edge no longer exists as recorded).
    if (work.triangles[tris[0]] < 0 || work.triangles[tris[1]] < 0) continue;
    if (!triangleUsesEdge(work, tris[0], a, b) || !triangleUsesEdge(work, tris[1], a, b)) {
      continue;
    }

    const mid = work.positions.length / 3;
    work.positions.push(
      (work.positions[a * 3] + work.positions[b * 3]) / 2,
      (work.positions[a * 3 + 1] + work.positions[b * 3 + 1]) / 2,
      (work.positions[a * 3 + 2] + work.positions[b * 3 + 2]) / 2
    );
    for (const t of tris) splitTriangle(work, t, a, b, mid);
    splits++;
  }
  return splits;
}

function triangleUsesEdge(work: WorkingMesh, t: number, a: number, b: number): boolean {
  const v = [work.triangles[t], work.triangles[t + 1], work.triangles[t + 2]];
  return v.includes(a) && v.includes(b);
}

/** Replace triangle `t` with two triangles split at `mid` on edge (a, b). */
function splitTriangle(
  work: WorkingMesh,
  t: number,
  a: number,
  b: number,
  mid: number
): void {
  const v = [work.triangles[t], work.triangles[t + 1], work.triangles[t + 2]];
  // Rotate so the triangle reads (a, b, c) while preserving winding.
  let offset = -1;
  for (let k = 0; k < 3; k++) {
    if (v[k] === a && v[(k + 1) % 3] === b) {
      offset = k;
      break;
    }
  }
  if (offset === -1) {
    // The triangle traverses the edge the other way: (b, a, c).
    for (let k = 0; k < 3; k++) {
      if (v[k] === b && v[(k + 1) % 3] === a) {
        offset = k;
        break;
      }
    }
    if (offset === -1) return;
    const p = v[offset];
    const q = v[(offset + 1) % 3];
    const c = v[(offset + 2) % 3];
    work.triangles[t] = p;
    work.triangles[t + 1] = mid;
    work.triangles[t + 2] = c;
    work.triangles.push(mid, q, c);
    return;
  }
  const p = v[offset];
  const q = v[(offset + 1) % 3];
  const c = v[(offset + 2) % 3];
  work.triangles[t] = p;
  work.triangles[t + 1] = mid;
  work.triangles[t + 2] = c;
  work.triangles.push(mid, q, c);
}

/**
 * Collapse edges shorter than `limit` onto their midpoint.
 *
 * A collapse is rejected when it would flip a neighbouring triangle's
 * normal, which is what keeps the operation from turning the surface inside
 * out at tight curvature.
 */
function collapseShortEdges(
  work: WorkingMesh,
  limit: number,
  pinned: Set<number>
): number {
  const edges = collectEdges(work);
  let collapses = 0;
  const dead = new Set<number>();

  for (const key of edges.keys()) {
    const [aStr, bStr] = key.split("_");
    const a = Number(aStr);
    const b = Number(bStr);
    if (dead.has(a) || dead.has(b)) continue;
    if (pinned.has(a) && pinned.has(b)) continue;
    if (edgeLength(work, a, b) >= limit) continue;

    // Collapse the free vertex onto the pinned one when exactly one is
    // pinned, so feature lines keep their exact position.
    const keep = pinned.has(a) ? a : pinned.has(b) ? b : a;
    const remove = keep === a ? b : a;

    const target = pinned.has(keep)
      ? {
          x: work.positions[keep * 3],
          y: work.positions[keep * 3 + 1],
          z: work.positions[keep * 3 + 2],
        }
      : {
          x: (work.positions[a * 3] + work.positions[b * 3]) / 2,
          y: (work.positions[a * 3 + 1] + work.positions[b * 3 + 1]) / 2,
          z: (work.positions[a * 3 + 2] + work.positions[b * 3 + 2]) / 2,
        };

    if (!collapseIsSafe(work, keep, remove, target)) continue;

    work.positions[keep * 3] = target.x;
    work.positions[keep * 3 + 1] = target.y;
    work.positions[keep * 3 + 2] = target.z;
    for (let t = 0; t < work.triangles.length; t += 3) {
      if (work.triangles[t] < 0) continue;
      for (let k = 0; k < 3; k++) {
        if (work.triangles[t + k] === remove) work.triangles[t + k] = keep;
      }
      const v0 = work.triangles[t];
      const v1 = work.triangles[t + 1];
      const v2 = work.triangles[t + 2];
      if (v0 === v1 || v1 === v2 || v2 === v0) {
        work.triangles[t] = -1;
        work.triangles[t + 1] = -1;
        work.triangles[t + 2] = -1;
      }
    }
    dead.add(remove);
    collapses++;
  }
  return collapses;
}

/** True when moving `remove` onto `target` flips no surviving triangle. */
function collapseIsSafe(
  work: WorkingMesh,
  keep: number,
  remove: number,
  target: { x: number; y: number; z: number }
): boolean {
  for (let t = 0; t < work.triangles.length; t += 3) {
    if (work.triangles[t] < 0) continue;
    const v = [work.triangles[t], work.triangles[t + 1], work.triangles[t + 2]];
    if (!v.includes(remove) && !v.includes(keep)) continue;
    // Triangles that vanish in the collapse cannot flip.
    if (v.includes(remove) && v.includes(keep)) continue;
    const before = triangleNormal(work, v[0], v[1], v[2], null, target);
    const after = triangleNormal(work, v[0], v[1], v[2], remove, target, keep);
    if (!before || !after) continue;
    const dot = before.x * after.x + before.y * after.y + before.z * after.z;
    if (dot <= 0) return false;
  }
  return true;
}

function triangleNormal(
  work: WorkingMesh,
  i0: number,
  i1: number,
  i2: number,
  replaceIndex: number | null,
  replaceWith: { x: number; y: number; z: number },
  alsoReplace?: number
): { x: number; y: number; z: number } | null {
  const read = (i: number) => {
    if (replaceIndex !== null && (i === replaceIndex || i === alsoReplace)) {
      return replaceWith;
    }
    return {
      x: work.positions[i * 3],
      y: work.positions[i * 3 + 1],
      z: work.positions[i * 3 + 2],
    };
  };
  const a = read(i0);
  const b = read(i1);
  const c = read(i2);
  const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
  const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
  const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-14) return null;
  return { x: nx / length, y: ny / length, z: nz / length };
}

/**
 * Move each free vertex towards the centroid of its neighbours, then project
 * that motion back into the vertex's tangent plane.
 *
 * The tangential projection is what makes this "relaxation" rather than
 * "smoothing": vertices spread out evenly WITHOUT the surface shrinking.
 */
function tangentialRelax(work: WorkingMesh, pinned: Set<number>): void {
  const vertexCount = work.positions.length / 3;
  const sums = new Float64Array(vertexCount * 3);
  const counts = new Uint32Array(vertexCount);
  const normals = new Float64Array(vertexCount * 3);

  for (let t = 0; t < work.triangles.length; t += 3) {
    if (work.triangles[t] < 0) continue;
    const v = [work.triangles[t], work.triangles[t + 1], work.triangles[t + 2]];
    const n = triangleNormal(work, v[0], v[1], v[2], null, { x: 0, y: 0, z: 0 });
    for (let k = 0; k < 3; k++) {
      const self = v[k];
      const next = v[(k + 1) % 3];
      sums[self * 3] += work.positions[next * 3];
      sums[self * 3 + 1] += work.positions[next * 3 + 1];
      sums[self * 3 + 2] += work.positions[next * 3 + 2];
      counts[self]++;
      if (n) {
        normals[self * 3] += n.x;
        normals[self * 3 + 1] += n.y;
        normals[self * 3 + 2] += n.z;
      }
    }
  }

  for (let v = 0; v < vertexCount; v++) {
    if (counts[v] === 0 || pinned.has(v)) continue;
    const cx = sums[v * 3] / counts[v];
    const cy = sums[v * 3 + 1] / counts[v];
    const cz = sums[v * 3 + 2] / counts[v];
    let dx = cx - work.positions[v * 3];
    let dy = cy - work.positions[v * 3 + 1];
    let dz = cz - work.positions[v * 3 + 2];
    // Remove the component along the vertex normal so the surface keeps its
    // shape and only the vertex DISTRIBUTION changes.
    const nl = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
    if (nl > 1e-12) {
      const nx = normals[v * 3] / nl;
      const ny = normals[v * 3 + 1] / nl;
      const nz = normals[v * 3 + 2] / nl;
      const along = dx * nx + dy * ny + dz * nz;
      dx -= along * nx;
      dy -= along * ny;
      dz -= along * nz;
    }
    work.positions[v * 3] += dx * 0.5;
    work.positions[v * 3 + 1] += dy * 0.5;
    work.positions[v * 3 + 2] += dz * 0.5;
  }
}

/** Vertices on edges sharper than the feature angle, which must not move. */
function findFeatureVertices(mesh: MeshData, featureAngleDeg: number): Set<number> {
  const pinned = new Set<number>();
  const cos = Math.cos((featureAngleDeg * Math.PI) / 180);
  const idx = mesh.indices;
  const pos = mesh.positions;
  const triangleCount = idx.length / 3;
  const vertexCount = pos.length / 3;

  const normals = new Float32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const nx =
      (pos[b + 1] - pos[a + 1]) * (pos[c + 2] - pos[a + 2]) -
      (pos[b + 2] - pos[a + 2]) * (pos[c + 1] - pos[a + 1]);
    const ny =
      (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]) -
      (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]);
    const nz =
      (pos[b] - pos[a]) * (pos[c + 1] - pos[a + 1]) -
      (pos[b + 1] - pos[a + 1]) * (pos[c] - pos[a]);
    const length = Math.hypot(nx, ny, nz) || 1;
    normals[t * 3] = nx / length;
    normals[t * 3 + 1] = ny / length;
    normals[t * 3 + 2] = nz / length;
  }

  const edgeTriangles = new Map<number, number[]>();
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const u = idx[t * 3 + k];
      const v = idx[t * 3 + ((k + 1) % 3)];
      const key = u < v ? u * vertexCount + v : v * vertexCount + u;
      const list = edgeTriangles.get(key);
      if (list) list.push(t);
      else edgeTriangles.set(key, [t]);
    }
  }

  for (const [key, tris] of edgeTriangles) {
    const u = Math.floor(key / vertexCount);
    const v = key % vertexCount;
    if (tris.length !== 2) {
      // Boundary or non-manifold edges are always features.
      pinned.add(u);
      pinned.add(v);
      continue;
    }
    const dot =
      normals[tris[0] * 3] * normals[tris[1] * 3] +
      normals[tris[0] * 3 + 1] * normals[tris[1] * 3 + 1] +
      normals[tris[0] * 3 + 2] * normals[tris[1] * 3 + 2];
    if (dot < cos) {
      pinned.add(u);
      pinned.add(v);
    }
  }
  return pinned;
}

/** Mean length of the mesh's edges, mm. */
export function meanEdgeLength(mesh: MeshData): number {
  const idx = mesh.indices;
  const pos = mesh.positions;
  let total = 0;
  let count = 0;
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k] * 3;
      const b = idx[t + ((k + 1) % 3)] * 3;
      total += Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
      count++;
    }
  }
  return count === 0 ? 0 : total / count;
}

/** Remesh to a uniform target edge length. */
export function isotropicRemesh(mesh: MeshData, settings: RemeshSettings): RemeshResult {
  const target = settings.targetEdgeMm;
  if (!(target > 0)) throw new OpError("אורך הצלע המבוקש חייב להיות גדול מאפס");
  const trianglesBefore = mesh.indices.length / 3;
  if (trianglesBefore === 0) throw new OpError("הרשת ריקה");

  const warningsHe: string[] = [];
  const maxTriangles = settings.maxTriangles ?? DEFAULT_MAX_TRIANGLES;

  // Estimate the output size before doing the work and refuse rather than
  // freezing the tab.
  const report = analyzeTopology(mesh);
  const currentMean = meanEdgeLength(mesh);
  if (currentMean > 0) {
    const growth = (currentMean / target) ** 2;
    if (trianglesBefore * growth > maxTriangles * 4) {
      throw new OpError(
        `אורך הצלע המבוקש (${target} מ״מ) קטן מדי — התוצאה תכיל מיליוני משולשים`,
        ["הגדילו את אורך הצלע", "או פשטו את הרשת לפני הרישות מחדש"]
      );
    }
  }
  if (!report.isManifold) {
    warningsHe.push("הרשת אינה תקינה טופולוגית — מומלץ להריץ ״תיקון רשת״ לפני הרישות");
  }

  const work = toWorking(mesh);

  // Botsch & Kobbelt's thresholds: split above 4/3 of target, collapse below
  // 4/5. The gap prevents an edge from oscillating between the two rules.
  const splitLimit = (target * 4) / 3;
  const collapseLimit = (target * 4) / 5;
  const iterations = Math.max(1, Math.min(Math.round(settings.iterations), 10));

  for (let i = 0; i < iterations; i++) {
    splitLongEdges(work, splitLimit);
    // Recompute features AFTER splitting, every iteration. Splitting a sharp
    // edge creates a midpoint that also lies on that edge, and a set computed
    // once up front would not contain it — relaxation would then drag those
    // new vertices off the surface and visibly inflate the model (a 20mm cube
    // grew to 23mm before this was fixed). Vertex indices are stable across
    // split and collapse, so recomputing here stays consistent.
    const pinned = findFeatureVertices(toMeshData(work), settings.featureAngleDeg);
    collapseShortEdges(work, collapseLimit, pinned);
    tangentialRelax(work, pinned);
    const liveTriangles = work.triangles.filter((_, k) => k % 3 === 0 && work.triangles[k] >= 0).length;
    if (liveTriangles > maxTriangles) {
      warningsHe.push(
        `הרישות נעצרה אחרי ${i + 1} מחזורים בגלל מגבלת ${maxTriangles.toLocaleString("he-IL")} משולשים`
      );
      break;
    }
  }

  let result = toMeshData(work);
  result = removeDegenerateTriangles(result).mesh;
  result = removeUnusedVertices(result).mesh;

  const after = analyzeTopology(result);
  if (after.boundaryEdgeCount > report.boundaryEdgeCount) {
    warningsHe.push("הרישות פתחה חורים ברשת — מומלץ להריץ ״תיקון רשת״");
  }

  return {
    mesh: result,
    trianglesBefore,
    trianglesAfter: result.indices.length / 3,
    meanEdgeMm: meanEdgeLength(result),
    warningsHe,
  };
}
