/**
 * Mesh topology analysis and the structural half of mesh repair.
 *
 * Everything here works on plain `MeshData` (indexed triangles) WITHOUT the
 * Manifold kernel, because these are exactly the operations needed to turn a
 * mesh the kernel *rejects* into one it accepts. The kernel can only tell us
 * "NotManifold"; this module says which edges, which loops, which triangles —
 * and fixes them.
 *
 * Vertex identity is index-based, so weld the mesh first (`weldMesh`) when the
 * source is an STL: STL files store loose triangles with no shared vertices,
 * and every edge would look like a boundary edge otherwise.
 */

import type { MeshData } from "../meshData";

/** A directed edge encoded as a single number for Map keys. */
type EdgeKey = number;

/**
 * Pack an ordered vertex pair into one number. Safe while
 * vertexCount < 2^26 (~67M vertices), far beyond anything printable.
 */
function edgeKey(a: number, b: number, vertexCount: number): EdgeKey {
  return a * vertexCount + b;
}

export interface BoundaryLoop {
  /** Vertex indices in the direction the *existing surface* traverses them. */
  vertices: number[];
  /** Sum of edge lengths, mm. */
  perimeterMm: number;
  /** Loop centroid in mm — used to point the camera at the hole. */
  center: { x: number; y: number; z: number };
}

export interface TopologyReport {
  vertexCount: number;
  triangleCount: number;
  /** Edges used by exactly one triangle — the mesh has holes. */
  boundaryEdgeCount: number;
  /** Edges used by three or more triangles — not a surface. */
  nonManifoldEdgeCount: number;
  /** Edges used twice in the SAME direction — inconsistent winding. */
  inconsistentEdgeCount: number;
  /** Closed boundary loops, largest first. */
  boundaryLoops: BoundaryLoop[];
  /** Connected components (by shared vertices). */
  componentCount: number;
  /**
   * Triangles with zero area but three distinct vertices. These are a mesh
   * QUALITY problem (slivers), not a topology problem — they keep the surface
   * closed, so they do not make a mesh non-manifold.
   */
  degenerateTriangleCount: number;
  /**
   * Triangles that repeat a vertex. These have a self-loop edge and DO break
   * manifoldness.
   */
  invalidTriangleCount: number;
  /** Triangles repeating an existing vertex triple. */
  duplicateTriangleCount: number;
  /** Vertices referenced by no triangle. */
  unusedVertexCount: number;
  /** Signed volume; negative means the surface is inside-out. */
  signedVolumeMm3: number;
  /** True when the mesh is closed, manifold and consistently wound. */
  isManifold: boolean;
}

function triangleArea(
  p: Float32Array,
  ia: number,
  ib: number,
  ic: number
): number {
  const a = ia * 3;
  const b = ib * 3;
  const c = ic * 3;
  const ux = p[b] - p[a];
  const uy = p[b + 1] - p[a + 1];
  const uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a];
  const vy = p[c + 1] - p[a + 1];
  const vz = p[c + 2] - p[a + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

/** Signed volume of the closed surface (positive = outward-facing normals). */
export function signedVolume(mesh: MeshData): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let volume = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    volume +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) +
        p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
  }
  return volume;
}

/**
 * Chain unpaired directed edges into closed loops. Each boundary edge (u→v)
 * is followed by the boundary edge starting at v. Vertices where several
 * boundary edges meet (pinched holes) are resolved first-come-first-served,
 * which still yields closed loops.
 */
function traceBoundaryLoops(
  boundaryEdges: Map<number, number[]>,
  positions: Float32Array
): BoundaryLoop[] {
  const loops: BoundaryLoop[] = [];
  // Work on a mutable copy so each edge is consumed exactly once.
  const remaining = new Map<number, number[]>();
  for (const [from, tos] of boundaryEdges) remaining.set(from, [...tos]);

  const take = (from: number): number | undefined => {
    const tos = remaining.get(from);
    if (!tos || tos.length === 0) return undefined;
    const next = tos.pop() as number;
    if (tos.length === 0) remaining.delete(from);
    return next;
  };

  for (const start of [...remaining.keys()]) {
    let cursor: number | undefined = start;
    while (cursor !== undefined && remaining.has(cursor)) {
      const loop: number[] = [];
      let node: number | undefined = cursor;
      // Walk until we return to the start or run out of edges.
      while (node !== undefined) {
        loop.push(node);
        const next: number | undefined = take(node);
        if (next === undefined) break;
        if (next === loop[0]) {
          node = undefined;
          break;
        }
        // Guard against pathological chains longer than the whole mesh.
        if (loop.length > positions.length) break;
        node = next;
      }
      if (loop.length >= 3) {
        let perimeter = 0;
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i] * 3;
          const b = loop[(i + 1) % loop.length] * 3;
          perimeter += Math.hypot(
            positions[b] - positions[a],
            positions[b + 1] - positions[a + 1],
            positions[b + 2] - positions[a + 2]
          );
          cx += positions[a];
          cy += positions[a + 1];
          cz += positions[a + 2];
        }
        loops.push({
          vertices: loop,
          perimeterMm: perimeter,
          center: { x: cx / loop.length, y: cy / loop.length, z: cz / loop.length },
        });
      }
      cursor = start;
    }
  }
  loops.sort((a, b) => b.perimeterMm - a.perimeterMm);
  return loops;
}

/** Full structural analysis of a mesh. */
export function analyzeTopology(mesh: MeshData): TopologyReport {
  const vertexCount = mesh.positions.length / 3;
  const idx = mesh.indices;
  const triangleCount = idx.length / 3;

  /** directed edge -> use count */
  const directed = new Map<EdgeKey, number>();
  /** undirected edge -> use count */
  const undirected = new Map<EdgeKey, number>();

  let degenerateTriangleCount = 0;
  let invalidTriangleCount = 0;
  const seenTriangles = new Set<string>();
  let duplicateTriangleCount = 0;
  const usedVertices = new Uint8Array(vertexCount);

  for (let t = 0; t < triangleCount; t++) {
    const a = idx[t * 3];
    const b = idx[t * 3 + 1];
    const c = idx[t * 3 + 2];
    usedVertices[a] = 1;
    usedVertices[b] = 1;
    usedVertices[c] = 1;

    // A triangle repeating a vertex has a self-loop edge and cannot take part
    // in edge accounting at all. A zero-AREA triangle with three distinct
    // vertices still has three real edges: skipping those would orphan its
    // neighbours' edges and report phantom holes (marching-tetrahedra output
    // is full of such slivers once float32 rounding collapses them).
    const repeatsVertex = a === b || b === c || c === a;
    if (repeatsVertex) {
      invalidTriangleCount++;
      continue;
    }
    if (triangleArea(mesh.positions, a, b, c) === 0) degenerateTriangleCount++;

    const sorted = [a, b, c].sort((x, y) => x - y).join(",");
    if (seenTriangles.has(sorted)) duplicateTriangleCount++;
    else seenTriangles.add(sorted);

    const pairs: [number, number][] = [
      [a, b],
      [b, c],
      [c, a],
    ];
    for (const [u, v] of pairs) {
      const dk = edgeKey(u, v, vertexCount);
      directed.set(dk, (directed.get(dk) ?? 0) + 1);
      const uk = u < v ? edgeKey(u, v, vertexCount) : edgeKey(v, u, vertexCount);
      undirected.set(uk, (undirected.get(uk) ?? 0) + 1);
    }
  }

  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  for (const count of undirected.values()) {
    if (count === 1) boundaryEdgeCount++;
    else if (count > 2) nonManifoldEdgeCount++;
  }

  // A consistently wound edge is used once per direction. Two uses in the
  // same direction mean the two adjacent triangles disagree.
  let inconsistentEdgeCount = 0;
  const boundaryEdges = new Map<number, number[]>();
  for (const [key, count] of directed) {
    if (count > 1) inconsistentEdgeCount++;
    const u = Math.floor(key / vertexCount);
    const v = key % vertexCount;
    const opposite = directed.get(edgeKey(v, u, vertexCount)) ?? 0;
    if (opposite === 0) {
      // Unpaired: this edge borders a hole.
      const list = boundaryEdges.get(u);
      if (list) list.push(v);
      else boundaryEdges.set(u, [v]);
    }
  }

  let unusedVertexCount = 0;
  for (let v = 0; v < vertexCount; v++) if (!usedVertices[v]) unusedVertexCount++;

  const boundaryLoops = traceBoundaryLoops(boundaryEdges, mesh.positions);
  const componentCount = countComponents(mesh);
  const volume = signedVolume(mesh);

  return {
    vertexCount,
    triangleCount,
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    inconsistentEdgeCount,
    boundaryLoops,
    componentCount,
    degenerateTriangleCount,
    invalidTriangleCount,
    duplicateTriangleCount,
    unusedVertexCount,
    signedVolumeMm3: volume,
    // Zero-area slivers are deliberately excluded: they are a quality issue,
    // not a topological one, and the kernel accepts a mesh that has them.
    isManifold:
      boundaryEdgeCount === 0 &&
      nonManifoldEdgeCount === 0 &&
      inconsistentEdgeCount === 0 &&
      invalidTriangleCount === 0,
  };
}

/** Number of connected components, by shared vertex indices. */
export function countComponents(mesh: MeshData): number {
  const vertexCount = mesh.positions.length / 3;
  if (vertexCount === 0) return 0;
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i += 3) {
    union(idx[i], idx[i + 1]);
    union(idx[i + 1], idx[i + 2]);
  }
  const roots = new Set<number>();
  const used = new Uint8Array(vertexCount);
  for (let i = 0; i < idx.length; i++) used[idx[i]] = 1;
  for (let v = 0; v < vertexCount; v++) if (used[v]) roots.add(find(v));
  return roots.size;
}

// ---------------------------------------------------------------------------
// Structural fixes
// ---------------------------------------------------------------------------

/** Drop zero-area and repeated-vertex triangles. */
export function removeDegenerateTriangles(mesh: MeshData, epsilonMm2 = 1e-12): {
  mesh: MeshData;
  removed: number;
} {
  const idx = mesh.indices;
  const kept: number[] = [];
  let removed = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i];
    const b = idx[i + 1];
    const c = idx[i + 2];
    if (a === b || b === c || c === a) {
      removed++;
      continue;
    }
    if (triangleArea(mesh.positions, a, b, c) <= epsilonMm2) {
      removed++;
      continue;
    }
    kept.push(a, b, c);
  }
  if (removed === 0) return { mesh, removed: 0 };
  return { mesh: { positions: mesh.positions, indices: new Uint32Array(kept) }, removed };
}

/**
 * Drop triangles that repeat an existing vertex triple. The first occurrence
 * is kept, including its winding.
 */
export function removeDuplicateTriangles(mesh: MeshData): {
  mesh: MeshData;
  removed: number;
} {
  const idx = mesh.indices;
  const seen = new Set<string>();
  const kept: number[] = [];
  let removed = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i];
    const b = idx[i + 1];
    const c = idx[i + 2];
    const key = [a, b, c].sort((x, y) => x - y).join(",");
    if (seen.has(key)) {
      removed++;
      continue;
    }
    seen.add(key);
    kept.push(a, b, c);
  }
  if (removed === 0) return { mesh, removed: 0 };
  return { mesh: { positions: mesh.positions, indices: new Uint32Array(kept) }, removed };
}

/** Compact the vertex array, dropping vertices no triangle references. */
export function removeUnusedVertices(mesh: MeshData): {
  mesh: MeshData;
  removed: number;
} {
  const vertexCount = mesh.positions.length / 3;
  const remap = new Int32Array(vertexCount).fill(-1);
  const idx = mesh.indices;
  let next = 0;
  for (let i = 0; i < idx.length; i++) {
    if (remap[idx[i]] === -1) remap[idx[i]] = next++;
  }
  if (next === vertexCount) return { mesh, removed: 0 };
  const positions = new Float32Array(next * 3);
  for (let v = 0; v < vertexCount; v++) {
    const target = remap[v];
    if (target === -1) continue;
    positions[target * 3] = mesh.positions[v * 3];
    positions[target * 3 + 1] = mesh.positions[v * 3 + 1];
    positions[target * 3 + 2] = mesh.positions[v * 3 + 2];
  }
  const indices = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) indices[i] = remap[idx[i]];
  return { mesh: { positions, indices }, removed: vertexCount - next };
}

/**
 * Make triangle winding consistent across each connected component, then
 * flip any component whose normals point inward.
 *
 * Propagation: two triangles sharing an edge agree when they traverse that
 * edge in OPPOSITE directions. A breadth-first walk flips neighbours that
 * violate this, which is the standard orientation-propagation fix for STL
 * files exported with mixed winding.
 */
export function orientConsistently(mesh: MeshData): {
  mesh: MeshData;
  flipped: number;
} {
  const vertexCount = mesh.positions.length / 3;
  const idx = mesh.indices;
  const triangleCount = idx.length / 3;
  if (triangleCount === 0) return { mesh, flipped: 0 };

  // Undirected edge -> adjacent triangle ids.
  const edgeTriangles = new Map<EdgeKey, number[]>();
  for (let t = 0; t < triangleCount; t++) {
    const v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    for (let e = 0; e < 3; e++) {
      const u = v[e];
      const w = v[(e + 1) % 3];
      const key = u < w ? edgeKey(u, w, vertexCount) : edgeKey(w, u, vertexCount);
      const list = edgeTriangles.get(key);
      if (list) list.push(t);
      else edgeTriangles.set(key, [t]);
    }
  }

  const out = new Uint32Array(idx);
  const visited = new Uint8Array(triangleCount);
  let flipped = 0;

  /** True when triangle `t` (in `out`) traverses u->v in that direction. */
  const traverses = (t: number, u: number, v: number): boolean => {
    const a = out[t * 3];
    const b = out[t * 3 + 1];
    const c = out[t * 3 + 2];
    return (a === u && b === v) || (b === u && c === v) || (c === u && a === v);
  };

  const flip = (t: number) => {
    const tmp = out[t * 3 + 1];
    out[t * 3 + 1] = out[t * 3 + 2];
    out[t * 3 + 2] = tmp;
    flipped++;
  };

  for (let seed = 0; seed < triangleCount; seed++) {
    if (visited[seed]) continue;
    // New component: fix winding relative to this seed, then check its sign.
    const component: number[] = [];
    const queue = [seed];
    visited[seed] = 1;
    while (queue.length > 0) {
      const t = queue.pop() as number;
      component.push(t);
      const v = [out[t * 3], out[t * 3 + 1], out[t * 3 + 2]];
      for (let e = 0; e < 3; e++) {
        const u = v[e];
        const w = v[(e + 1) % 3];
        const key = u < w ? edgeKey(u, w, vertexCount) : edgeKey(w, u, vertexCount);
        const neighbours = edgeTriangles.get(key);
        if (!neighbours) continue;
        // Only 2-manifold edges can propagate orientation unambiguously.
        if (neighbours.length !== 2) continue;
        const other = neighbours[0] === t ? neighbours[1] : neighbours[0];
        if (other === t || visited[other]) continue;
        // The neighbour must traverse this edge the other way round.
        if (traverses(other, u, w)) flip(other);
        visited[other] = 1;
        queue.push(other);
      }
    }
    // Inside-out check for this component alone.
    let componentVolume = 0;
    const p = mesh.positions;
    for (const t of component) {
      const a = out[t * 3] * 3;
      const b = out[t * 3 + 1] * 3;
      const c = out[t * 3 + 2] * 3;
      componentVolume +=
        (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) +
          p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) +
          p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
        6;
    }
    if (componentVolume < 0) for (const t of component) flip(t);
  }

  if (flipped === 0) return { mesh, flipped: 0 };
  return { mesh: { positions: mesh.positions, indices: out }, flipped };
}

/**
 * Split vertices shared by more than one edge-connected fan ("bowtie"
 * vertices) so each fan gets its own copy. Manifold rejects bowties, and
 * duplicating the vertex is the standard lossless fix — no geometry moves.
 */
export function splitNonManifoldVertices(mesh: MeshData): {
  mesh: MeshData;
  split: number;
} {
  const vertexCount = mesh.positions.length / 3;
  const idx = mesh.indices;
  const triangleCount = idx.length / 3;

  // Triangles incident on each vertex.
  const incident: number[][] = Array.from({ length: vertexCount }, () => []);
  for (let t = 0; t < triangleCount; t++) {
    incident[idx[t * 3]].push(t);
    incident[idx[t * 3 + 1]].push(t);
    incident[idx[t * 3 + 2]].push(t);
  }

  const positions: number[] = Array.from(mesh.positions);
  const out = new Uint32Array(idx);
  let split = 0;

  for (let v = 0; v < vertexCount; v++) {
    const tris = incident[v];
    if (tris.length < 2) continue;
    // Group the incident triangles into edge-connected fans around v.
    const groupOf = new Map<number, number>();
    const groups: number[][] = [];
    for (const t of tris) {
      // Neighbours sharing an edge THROUGH v.
      let target = -1;
      for (const other of tris) {
        if (other === t) continue;
        const g = groupOf.get(other);
        if (g === undefined) continue;
        if (sharesEdgeThroughVertex(out, t, other, v)) {
          target = g;
          break;
        }
      }
      if (target === -1) {
        target = groups.length;
        groups.push([]);
      }
      groupOf.set(t, target);
      groups[target].push(t);
    }
    // Merge groups that turn out to be connected (order-dependent grouping).
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
          for (const a of groups[i]) {
            for (const b of groups[j]) {
              if (sharesEdgeThroughVertex(out, a, b, v)) {
                groups[i].push(...groups[j]);
                groups.splice(j, 1);
                merged = true;
                break outer;
              }
            }
          }
        }
      }
    }
    if (groups.length < 2) continue;
    // Keep group 0 on the original vertex; give each other group a copy.
    for (let g = 1; g < groups.length; g++) {
      const copy = positions.length / 3;
      positions.push(
        mesh.positions[v * 3],
        mesh.positions[v * 3 + 1],
        mesh.positions[v * 3 + 2]
      );
      for (const t of groups[g]) {
        for (let k = 0; k < 3; k++) {
          if (out[t * 3 + k] === v) out[t * 3 + k] = copy;
        }
      }
      split++;
    }
  }

  if (split === 0) return { mesh, split: 0 };
  return { mesh: { positions: new Float32Array(positions), indices: out }, split };
}

function sharesEdgeThroughVertex(
  indices: Uint32Array,
  t1: number,
  t2: number,
  v: number
): boolean {
  const a = [indices[t1 * 3], indices[t1 * 3 + 1], indices[t1 * 3 + 2]].filter((x) => x !== v);
  const b = [indices[t2 * 3], indices[t2 * 3 + 1], indices[t2 * 3 + 2]].filter((x) => x !== v);
  return a.some((x) => b.includes(x));
}
