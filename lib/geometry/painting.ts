/**
 * Per-face material painting.
 *
 * Material used to be a per-LAYER property, so a two-colour print meant
 * splitting the body into two layers by hand — and once split, the two halves
 * were independent objects that no longer moved or edited together.
 *
 * Painting records the material per TRIANGLE instead. Nothing about the
 * geometry changes while modelling: the paint is metadata, previewed as an
 * overlay, and the body stays one editable object. The separation into
 * printable per-colour parts happens at EXPORT, where it is actually needed.
 *
 * Why the split has to produce solids, not surface patches:
 * a multi-material printer needs each colour as its own closed body that
 * assembles into the original. So a painted region is turned into a shell
 * prism (the patch, plus a copy pushed `depthMm` into the body, plus walls
 * around the boundary) and the body is split by it through the kernel. Both
 * halves are therefore watertight by construction, and their union is exactly
 * the original part.
 *
 * Index stability: paint is stored as triangle indices into the layer's built
 * body. Those indices are only meaningful for the mesh they were picked on, so
 * every entry carries the triangle count of that mesh and is discarded — with
 * a warning — once the body is rebuilt into a different shape.
 */

import type { DesignDocument, FacePaint, MaterialSlot } from "@/types/design";
import type { PrintablePart } from "./buildDocument";
import { getGeometryKernel, type GeometryKernel, type Solid } from "./kernel";
import {
  meshDataBounds,
  meshDataSurfaceArea,
  meshDataVolume,
  transformMeshData,
  triangleCross,
  type MeshData,
} from "./meshData";

/** Depth a painted region reaches into the body, in mm. */
export const DEFAULT_PAINT_DEPTH_MM = 0.8;

// ---------------------------------------------------------------------------
// Paint bookkeeping
// ---------------------------------------------------------------------------

/**
 * Assign `triangles` to a material slot.
 *
 * A triangle belongs to exactly one slot, so painting removes it from every
 * other region first — otherwise the export split would try to carve the same
 * material away twice and the second cut would come back empty.
 */
export function paintTriangles(
  existing: readonly FacePaint[] | undefined,
  materialSlotId: string,
  triangles: Iterable<number>,
  meshTriangleCount: number,
  depthMm: number = DEFAULT_PAINT_DEPTH_MM,
  /** The painted mesh; when given, spatial anchors are (re)computed so the
   *  paint survives a rebuild by re-projection (see reanchorPaints). */
  mesh?: MeshData
): FacePaint[] {
  const added = new Set<number>();
  for (const t of triangles) {
    if (Number.isInteger(t) && t >= 0 && t < meshTriangleCount) added.add(t);
  }
  if (added.size === 0) return activePaints(existing, meshTriangleCount);
  const withAnchors = (paints: FacePaint[]): FacePaint[] =>
    mesh
      ? paints.map((paint) => ({ ...paint, anchors: paintAnchorsFor(mesh, paint.triangles) }))
      : paints;

  const result: FacePaint[] = [];
  let merged = false;
  for (const paint of activePaints(existing, meshTriangleCount)) {
    if (paint.materialSlotId === materialSlotId) {
      merged = true;
      const union = new Set(paint.triangles);
      for (const t of added) union.add(t);
      result.push({ ...paint, depthMm, triangles: [...union].sort((a, b) => a - b) });
      continue;
    }
    const kept = paint.triangles.filter((t) => !added.has(t));
    if (kept.length > 0) result.push({ ...paint, triangles: kept });
  }
  if (!merged) {
    result.push({
      materialSlotId,
      triangles: [...added].sort((a, b) => a - b),
      meshTriangleCount,
      depthMm,
    });
  }
  return withAnchors(result);
}

/** Remove `triangles` from every painted region. */
export function unpaintTriangles(
  existing: readonly FacePaint[] | undefined,
  triangles: Iterable<number>,
  meshTriangleCount: number,
  /** When given, anchors are refreshed to match the kept triangles. */
  mesh?: MeshData
): FacePaint[] {
  const removed = new Set(triangles);
  const result: FacePaint[] = [];
  for (const paint of activePaints(existing, meshTriangleCount)) {
    const kept = paint.triangles.filter((t) => !removed.has(t));
    if (kept.length > 0) {
      result.push({
        ...paint,
        triangles: kept,
        anchors: mesh ? paintAnchorsFor(mesh, kept) : paint.anchors,
      });
    }
  }
  return result;
}

/**
 * The paint entries that still apply to a body of `meshTriangleCount`
 * triangles. Entries recorded against a different mesh are dropped: their
 * indices now point at unrelated triangles, and silently repainting a random
 * scatter of faces is worse than losing the paint.
 */
export function activePaints(
  existing: readonly FacePaint[] | undefined,
  meshTriangleCount: number
): FacePaint[] {
  if (!existing || existing.length === 0) return [];
  // Merged by slot, because everything downstream assumes one entry per
  // material: two entries for the same slot cut the body twice (the second
  // cut finds nothing and warns), collide as React keys in the overlay, and
  // export as two files wanting the same filament.
  const bySlot = new Map<string, FacePaint>();
  for (const paint of existing) {
    if (paint.meshTriangleCount !== meshTriangleCount) continue;
    if (paint.triangles.length === 0) continue;
    const existingEntry = bySlot.get(paint.materialSlotId);
    if (!existingEntry) {
      bySlot.set(paint.materialSlotId, { ...paint, triangles: [...paint.triangles] });
      continue;
    }
    const union = new Set(existingEntry.triangles);
    for (const t of paint.triangles) union.add(t);
    existingEntry.triangles = [...union].sort((a, b) => a - b);
    existingEntry.depthMm = Math.max(existingEntry.depthMm, paint.depthMm);
  }
  return [...bySlot.values()];
}

/** True when paint exists but no longer matches the body it was painted on. */
export function hasStalePaint(
  existing: readonly FacePaint[] | undefined,
  meshTriangleCount: number
): boolean {
  if (!existing || existing.length === 0) return false;
  return existing.some((p) => p.meshTriangleCount !== meshTriangleCount);
}

// ---------------------------------------------------------------------------
// Spatial re-anchoring (V6 item 17)
// ---------------------------------------------------------------------------

/** Values per anchor: centroid xyz, normal xyz, size r. */
const ANCHOR_STRIDE = 7;

/**
 * Spatial anchors for the given triangles: centroid, outward normal and a
 * size (max distance from centroid to a vertex) per triangle, in the mesh's
 * own (local) frame. Stored on the paint entry so a rebuilt body can be
 * repainted by PROXIMITY instead of by index.
 */
export function paintAnchorsFor(mesh: MeshData, triangles: readonly number[]): number[] {
  const p = mesh.positions;
  const idx = mesh.indices;
  const anchors = new Array<number>(triangles.length * ANCHOR_STRIDE);
  let cursor = 0;
  for (const t of triangles) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const cx = (p[a] + p[b] + p[c]) / 3;
    const cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
    const cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    let [nx, ny, nz] = triangleCross(p, idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const r = Math.max(
      Math.hypot(p[a] - cx, p[a + 1] - cy, p[a + 2] - cz),
      Math.hypot(p[b] - cx, p[b + 1] - cy, p[b + 2] - cz),
      Math.hypot(p[c] - cx, p[c + 1] - cy, p[c + 2] - cz)
    );
    anchors[cursor++] = cx; anchors[cursor++] = cy; anchors[cursor++] = cz;
    anchors[cursor++] = nx; anchors[cursor++] = ny; anchors[cursor++] = nz;
    anchors[cursor++] = r;
  }
  return anchors;
}

export interface ReanchorResult {
  paints: FacePaint[];
  /** Regions that survived the re-projection. */
  reanchored: number;
  /** Regions dropped (no anchors, or nothing landed within tolerance). */
  dropped: number;
}

/** Minimum normal agreement for a match — keeps paint off the far side of thin walls. */
const REANCHOR_NORMAL_DOT = 0.7;

/**
 * Re-project stale paint onto a rebuilt mesh by anchor proximity.
 *
 * A new triangle joins a region when its centroid lies within the catch
 * radius of one of the region's anchors (1.5× the LARGER of the two
 * triangle sizes, floored at 0.75mm) AND its normal agrees with the
 * anchor's — the normal test is what keeps paint from bleeding through to
 * the far side of a thin wall. Entries that never had anchors (pre-V6
 * paint) or catch nothing are dropped, exactly like before.
 */
export function reanchorPaints(
  existing: readonly FacePaint[] | undefined,
  mesh: MeshData,
  options?: { minCatchMm?: number }
): ReanchorResult {
  const triangleCount = mesh.indices.length / 3;
  const still = activePaints(existing, triangleCount);
  const stale = (existing ?? []).filter(
    (paint) => paint.meshTriangleCount !== triangleCount && paint.triangles.length > 0
  );
  if (stale.length === 0) {
    return { paints: still, reanchored: 0, dropped: 0 };
  }
  const minCatch = options?.minCatchMm ?? 0.75;

  // Hash-grid over all stale anchors, cell size = the largest catch radius,
  // so a lookup only ever probes the 27 neighbouring cells.
  interface GridAnchor {
    slotIndex: number;
    x: number; y: number; z: number;
    nx: number; ny: number; nz: number;
    r: number;
  }
  const gridAnchors: GridAnchor[] = [];
  let maxCatch = minCatch;
  stale.forEach((paint, slotIndex) => {
    const anchors = paint.anchors ?? [];
    for (let i = 0; i + ANCHOR_STRIDE <= anchors.length; i += ANCHOR_STRIDE) {
      const r = anchors[i + 6];
      maxCatch = Math.max(maxCatch, 1.5 * r);
      gridAnchors.push({
        slotIndex,
        x: anchors[i], y: anchors[i + 1], z: anchors[i + 2],
        nx: anchors[i + 3], ny: anchors[i + 4], nz: anchors[i + 5],
        r,
      });
    }
  });
  const dropped = stale.filter((p) => !p.anchors || p.anchors.length === 0).length;
  if (gridAnchors.length === 0) {
    return { paints: still, reanchored: 0, dropped };
  }
  const cell = maxCatch;
  const grid = new Map<string, GridAnchor[]>();
  const keyOf = (x: number, y: number, z: number) =>
    `${Math.floor(x / cell)}_${Math.floor(y / cell)}_${Math.floor(z / cell)}`;
  for (const anchor of gridAnchors) {
    const key = keyOf(anchor.x, anchor.y, anchor.z);
    const bucket = grid.get(key);
    if (bucket) bucket.push(anchor);
    else grid.set(key, [anchor]);
  }

  // Assign each new triangle to the nearest catching anchor's region.
  const newAnchors = paintAnchorsFor(
    mesh,
    Array.from({ length: triangleCount }, (_, t) => t)
  );
  const claimed = new Map<number, number>(); // triangle → stale slot index
  for (let t = 0; t < triangleCount; t++) {
    const base = t * ANCHOR_STRIDE;
    const cx = newAnchors[base], cy = newAnchors[base + 1], cz = newAnchors[base + 2];
    const nx = newAnchors[base + 3], ny = newAnchors[base + 4], nz = newAnchors[base + 5];
    const size = newAnchors[base + 6];
    let best = Infinity;
    let bestSlot = -1;
    const gx = Math.floor(cx / cell), gy = Math.floor(cy / cell), gz = Math.floor(cz / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(`${gx + dx}_${gy + dy}_${gz + dz}`);
          if (!bucket) continue;
          for (const anchor of bucket) {
            const catchRadius = Math.max(minCatch, 1.5 * Math.max(anchor.r, size));
            const distance = Math.hypot(cx - anchor.x, cy - anchor.y, cz - anchor.z);
            if (distance > catchRadius) continue;
            if (nx * anchor.nx + ny * anchor.ny + nz * anchor.nz < REANCHOR_NORMAL_DOT) continue;
            if (distance < best) {
              best = distance;
              bestSlot = anchor.slotIndex;
            }
          }
        }
      }
    }
    if (bestSlot >= 0) claimed.set(t, bestSlot);
  }

  const paints: FacePaint[] = [...still];
  let reanchored = 0;
  let droppedTotal = dropped;
  stale.forEach((paint, slotIndex) => {
    if (!paint.anchors || paint.anchors.length === 0) return;
    const triangles = [...claimed.entries()]
      .filter(([, slot]) => slot === slotIndex)
      .map(([t]) => t)
      .sort((a, b) => a - b);
    if (triangles.length === 0) {
      droppedTotal++;
      return;
    }
    reanchored++;
    paints.push({
      materialSlotId: paint.materialSlotId,
      triangles,
      meshTriangleCount: triangleCount,
      depthMm: paint.depthMm,
      anchors: paintAnchorsFor(mesh, triangles),
    });
  });
  // Merge with any same-slot survivors through the canonical path, then
  // refresh anchors so they describe the MERGED triangle sets.
  const merged = activePaints(paints, triangleCount).map((paint) => ({
    ...paint,
    anchors: paintAnchorsFor(mesh, paint.triangles),
  }));
  return { paints: merged, reanchored, dropped: droppedTotal };
}

/** triangle index → material slot id, for preview and hit-testing. */
export function paintedTriangleSlots(
  paints: readonly FacePaint[]
): Map<number, string> {
  const map = new Map<number, string>();
  for (const paint of paints) {
    for (const t of paint.triangles) map.set(t, paint.materialSlotId);
  }
  return map;
}

/** Slots actually used by a document, painted or assigned to a layer. */
export function slotById(document: DesignDocument): Map<string, MaterialSlot> {
  return new Map(document.materialSlots.map((s) => [s.id, s]));
}

// ---------------------------------------------------------------------------
// Geometry: painted region → closed shell
// ---------------------------------------------------------------------------

/**
 * Build the closed prism swept by a painted patch pushed `depthMm` inward.
 *
 * The prism is the patch itself, a copy displaced along the patch's own
 * per-vertex normals, and a wall around every boundary edge. It is only used
 * as a boolean cutter, so it does not have to be a nice solid on its own — but
 * it does have to be closed and consistently wound, or the kernel rejects it.
 */
export function buildPaintShellMesh(
  mesh: MeshData,
  selected: ReadonlySet<number>,
  depthMm: number
): MeshData | null {
  const { indices, positions } = mesh;
  const triangleCount = indices.length / 3;
  const depth = Math.max(0.01, depthMm);

  // Compact the patch's vertices so the prism carries only what it needs.
  const remap = new Map<number, number>();
  const patch: number[] = [];
  for (const t of selected) {
    if (!Number.isInteger(t) || t < 0 || t >= triangleCount) continue;
    const local: number[] = [];
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      let index = remap.get(v);
      if (index === undefined) {
        index = remap.size;
        remap.set(v, index);
      }
      local.push(index);
    }
    if (local[0] === local[1] || local[1] === local[2] || local[0] === local[2]) continue;
    patch.push(local[0], local[1], local[2]);
  }
  if (patch.length === 0) return null;

  const count = remap.size;
  const outer = new Float32Array(count * 3);
  for (const [original, local] of remap) {
    outer[local * 3] = positions[original * 3];
    outer[local * 3 + 1] = positions[original * 3 + 1];
    outer[local * 3 + 2] = positions[original * 3 + 2];
  }

  // Area-weighted vertex normals from the PATCH only. Using the whole body's
  // normals would bend the prism away from the painted surface wherever the
  // patch ends on a crease.
  const normals = new Float32Array(count * 3);
  let patchNx = 0;
  let patchNy = 0;
  let patchNz = 0;
  for (let i = 0; i < patch.length; i += 3) {
    const a = patch[i] * 3;
    const b = patch[i + 1] * 3;
    const c = patch[i + 2] * 3;
    const [nx, ny, nz] = triangleCross(outer, patch[i], patch[i + 1], patch[i + 2]);
    patchNx += nx;
    patchNy += ny;
    patchNz += nz;
    for (const base of [a, b, c]) {
      normals[base] += nx;
      normals[base + 1] += ny;
      normals[base + 2] += nz;
    }
  }
  const patchLength = Math.hypot(patchNx, patchNy, patchNz) || 1;
  patchNx /= patchLength;
  patchNy /= patchLength;
  patchNz /= patchLength;

  const inner = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    let nx = normals[i * 3];
    let ny = normals[i * 3 + 1];
    let nz = normals[i * 3 + 2];
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-12) {
      // A vertex whose incident patch triangles cancel out has no direction of
      // its own; the patch average is the only sane fallback.
      nx = patchNx;
      ny = patchNy;
      nz = patchNz;
    } else {
      nx /= length;
      ny /= length;
      nz /= length;
    }
    inner[i * 3] = outer[i * 3] - nx * depth;
    inner[i * 3 + 1] = outer[i * 3 + 1] - ny * depth;
    inner[i * 3 + 2] = outer[i * 3 + 2] - nz * depth;
  }

  // Boundary edges: directed edges of the patch with no opposite twin.
  const seen = new Map<number, { a: number; b: number; count: number }>();
  for (let i = 0; i < patch.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = patch[i + k];
      const b = patch[i + ((k + 1) % 3)];
      const key = Math.min(a, b) * count + Math.max(a, b);
      const entry = seen.get(key);
      if (entry) entry.count++;
      else seen.set(key, { a, b, count: 1 });
    }
  }

  const out: number[] = [];
  // Outer skin, as painted.
  for (let i = 0; i < patch.length; i += 3) {
    out.push(patch[i], patch[i + 1], patch[i + 2]);
  }
  // Inner skin, reversed so its normals face the other way.
  for (let i = 0; i < patch.length; i += 3) {
    out.push(patch[i] + count, patch[i + 2] + count, patch[i + 1] + count);
  }
  // Walls. For a boundary edge a→b of an outward-facing patch, the interior
  // lies to the LEFT, so the wall has to wind a → b' → b to face outward;
  // winding it a → b → b' turns the prism inside out.
  for (const edge of seen.values()) {
    if (edge.count !== 1) continue;
    const a = edge.a;
    const b = edge.b;
    out.push(a, b + count, b);
    out.push(a, a + count, b + count);
  }

  const merged = new Float32Array(count * 6);
  merged.set(outer, 0);
  merged.set(inner, count * 3);
  return { positions: merged, indices: new Uint32Array(out) };
}

export interface PaintedSolid {
  /** Null for the unpainted remainder of the body. */
  materialSlotId: string | null;
  solid: Solid;
}

/**
 * Split a body into one solid per painted material plus the remainder.
 *
 * Consumes `solid`. Regions whose shell cannot be built or whose cut comes
 * back empty are reported and left as part of the remainder, so a bad paint
 * never loses material from the print.
 */
export function splitSolidByPaint(
  kernel: GeometryKernel,
  solid: Solid,
  mesh: MeshData,
  paints: readonly FacePaint[],
  warningsHe: string[] = []
): PaintedSolid[] {
  const active = activePaints(paints, mesh.indices.length / 3);
  if (active.length === 0) return [{ materialSlotId: null, solid }];

  // A paint depth deeper than the body turns the offset copy inside out: the
  // shell comes back with NEGATIVE volume and a clean `NoError` status,
  // because the kernel validates topology and never geometry. Bounding the
  // depth by the body's own thinnest dimension is what keeps the split
  // honest, and the user is told rather than silently overridden.
  const bounds = solid.boundingBox();
  const thinnest = Math.min(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z
  );
  const maxDepth = Math.max(0.05, thinnest * 0.45);

  const result: PaintedSolid[] = [];
  let remainder = solid;
  try {
    for (const paint of active) {
      const requested = paint.depthMm || DEFAULT_PAINT_DEPTH_MM;
      const depth = Math.min(requested, maxDepth);
      if (depth < requested - 1e-9) {
        warningsHe.push(
          `עומק הצביעה הוקטן מ-${requested.toFixed(1)} ל-${depth.toFixed(2)} מ״מ — ` +
            `עומק גדול מעובי הגוף היה יוצר גוף הפוך`
        );
      }

      const shellMesh = buildPaintShellMesh(mesh, new Set(paint.triangles), depth);
      if (!shellMesh) {
        warningsHe.push(`אזור צבוע ריק דולג (${paint.materialSlotId})`);
        continue;
      }
      const { solid: shell, status } = kernel.fromMeshData(shellMesh);
      // A non-positive volume means the offset copy crossed through the
      // original surface. Such a shell cuts unpredictably, so it is refused.
      if (status !== "NoError" || shell.volumeMm3() <= 0) {
        const reason = status !== "NoError" ? status : "נפח לא חוקי";
        shell.dispose();
        warningsHe.push(
          `הפרדת האזור הצבוע נכשלה (${reason}) — נסו עומק צביעה קטן יותר או אזור פשוט יותר`
        );
        continue;
      }
      // Keep a way back. `splitBySolid` consumes its input, so without this
      // there is nothing to fall back to when the cut turns out to be bad.
      const volumeBefore = remainder.volumeMm3();
      const backup = remainder.duplicate();
      const [region, rest] = remainder.splitBySolid(shell);

      // The invariant this whole feature rests on: the pieces must add back
      // up to what they were cut from, and each must be a real body. A
      // boolean split guarantees that only for a well-formed cutter, and a
      // shell can self-intersect in ways the kernel accepts silently.
      //
      // A 1 mm-walled tube painted 9 mm deep is the case that proves both
      // checks are needed: the remainder came back INSIDE OUT, at
      // −2,327 mm³, with status NoError. The sum still balanced — the
      // negative cancelled the excess — so only the per-piece sign catches
      // it, and mesh-level volume (which integrates to +2,327) hid it all
      // the way to a 7,102 mm³ export of a 2,446 mm³ body.
      const regionVolume = region.volumeMm3();
      const restVolume = rest.volumeMm3();
      const volumeAfter = regionVolume + restVolume;
      const tolerance = Math.max(0.05, volumeBefore * 1e-3);
      const conserved =
        Number.isFinite(volumeAfter) &&
        regionVolume > 0 &&
        restVolume >= 0 &&
        Math.abs(volumeAfter - volumeBefore) <= tolerance;

      if (!conserved || region.isEmpty() || region.status() !== "NoError") {
        region.dispose();
        rest.dispose();
        // Put the material back rather than dropping it on the floor.
        remainder = backup;
        warningsHe.push(
          conserved
            ? "אזור צבוע לא הפיק גוף — נשאר כחלק מהגוף הראשי"
            : "אזור צבוע לא ניתן להפרדה נקייה (עומק גדול מדי ביחס לדופן) — נשאר כחלק מהגוף הראשי"
        );
        continue;
      }
      backup.dispose();
      result.push({ materialSlotId: paint.materialSlotId, solid: region });
      remainder = rest;
    }
  } catch (err) {
    // Every solid still in flight belongs to this function; nothing outside
    // holds a handle, so failing without freeing them leaks WASM memory on
    // every export attempt.
    remainder.dispose();
    for (const piece of result) piece.solid.dispose();
    throw err;
  }

  if (!remainder.isEmpty()) {
    result.unshift({ materialSlotId: null, solid: remainder });
  } else {
    remainder.dispose();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Export: parts → per-colour parts
// ---------------------------------------------------------------------------

export interface PaintSplitResult {
  parts: PrintablePart[];
  warningsHe: string[];
}

/**
 * A printable part rebuilt from a mesh, sharing the source part's placement.
 *
 * Built field by field rather than by spreading `source`: the callers pass
 * `BuiltPart`s, whose extra `geometry` handle is disposed by the next
 * rebuild, and copying it here would hand every derived piece a dead GPU
 * resource. `issues` is likewise reset — they described the whole body.
 */
function derivePart(
  source: PrintablePart,
  localMesh: MeshData,
  suffix: string,
  nameHe: string,
  materialSlotId: string,
  watertight: boolean
): PrintablePart {
  const worldMesh = transformMeshData(localMesh, source.worldMatrix);
  const bounds = meshDataBounds(worldMesh);
  return {
    id: `${source.id}${suffix}`,
    nameHe,
    primaryLayerId: source.primaryLayerId,
    layerIds: source.layerIds,
    materialSlotId,
    localMesh,
    worldMatrix: source.worldMatrix,
    worldMesh,
    stats: {
      triangleCount: localMesh.indices.length / 3,
      volumeMm3: meshDataVolume(worldMesh),
      surfaceAreaMm2: meshDataSurfaceArea(worldMesh),
      dimensionsMm: {
        x: bounds.max.x - bounds.min.x,
        y: bounds.max.y - bounds.min.y,
        z: bounds.max.z - bounds.min.z,
      },
      bounds,
      watertight,
    },
    issues: [],
  };
}

/**
 * Expand painted parts into one printable part per material.
 *
 * Called only from the export path: while modelling, a painted body stays a
 * single object. Parts with no usable paint pass through untouched, and a
 * region that fails to separate is reported and stays in the main body — the
 * export is always complete, even when the paint is not.
 */
export async function splitPartsByPaint(
  document: DesignDocument,
  parts: readonly PrintablePart[]
): Promise<PaintSplitResult> {
  const layerById = new Map(document.layers.map((l) => [l.id, l]));
  const slots = slotById(document);
  const anyPaint = parts.some((part) => {
    const layer = layerById.get(part.primaryLayerId);
    const count = part.localMesh.indices.length / 3;
    return (
      activePaints(layer?.facePaint, count).length > 0 ||
      hasStalePaint(layer?.facePaint, count)
    );
  });
  if (!anyPaint) return { parts: [...parts], warningsHe: [] };

  const kernel = await getGeometryKernel();
  const warningsHe: string[] = [];
  const out: PrintablePart[] = [];

  for (const part of parts) {
    const layer = layerById.get(part.primaryLayerId);
    const triangleCount = part.localMesh.indices.length / 3;
    const paints = activePaints(layer?.facePaint, triangleCount);
    if (paints.length === 0) {
      // Say it here too. The build reports it as a document issue, but a user
      // who goes straight from editing to Export would otherwise get a
      // single-colour ZIP with no explanation of the missing colour.
      if (hasStalePaint(layer?.facePaint, triangleCount)) {
        warningsHe.push(
          `הצביעה בשכבה "${layer?.name ?? part.nameHe}" בוטלה — הגוף השתנה מאז שנצבע`
        );
      }
      out.push(part);
      continue;
    }
    const { solid, status } = kernel.fromMeshData(part.localMesh);
    if (status !== "NoError") {
      solid.dispose();
      warningsHe.push(
        `החלק "${part.nameHe}" אינו תקין (${status}) — יוצא ללא הפרדת צבעים`
      );
      out.push(part);
      continue;
    }

    let pieces: PaintedSolid[];
    try {
      pieces = splitSolidByPaint(kernel, solid, part.localMesh, paints, warningsHe);
    } catch (err) {
      warningsHe.push(
        `הפרדת הצבעים בחלק "${part.nameHe}" נכשלה: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      out.push(part);
      continue;
    }

    // One piece means the paint did not divide the body. That is legitimate
    // when a region covers the whole thing — but the piece then carries the
    // PAINTED material, and emitting the untouched part would hand the user a
    // single file in the wrong colour with nothing said about it.
    if (pieces.length === 1) {
      const only = pieces[0];
      if (only.materialSlotId === null) {
        only.solid.dispose();
        out.push(part);
        continue;
      }
      warningsHe.push(
        `האזור הצבוע מכסה את כל החלק "${part.nameHe}" — הוא ייוצא כחלק אחד בחומר הצבוע`
      );
    }

    let index = 0;
    for (const piece of pieces) {
      const mesh = piece.solid.toMeshData();
      const watertight = piece.solid.status() === "NoError" && !piece.solid.isEmpty();
      piece.solid.dispose();
      if (mesh.indices.length === 0) continue;
      const slot = piece.materialSlotId ? slots.get(piece.materialSlotId) : null;
      out.push(
        derivePart(
          part,
          mesh,
          `_paint${index++}`,
          piece.materialSlotId
            ? `${part.nameHe} — ${slot?.nameHe ?? "צבע"}`
            : `${part.nameHe} — גוף`,
          piece.materialSlotId ?? part.materialSlotId,
          watertight
        )
      );
    }
  }

  return { parts: out, warningsHe };
}
