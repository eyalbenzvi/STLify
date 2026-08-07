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
  depthMm: number = DEFAULT_PAINT_DEPTH_MM
): FacePaint[] {
  const added = new Set<number>();
  for (const t of triangles) {
    if (Number.isInteger(t) && t >= 0 && t < meshTriangleCount) added.add(t);
  }
  if (added.size === 0) return activePaints(existing, meshTriangleCount);

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
  return result;
}

/** Remove `triangles` from every painted region. */
export function unpaintTriangles(
  existing: readonly FacePaint[] | undefined,
  triangles: Iterable<number>,
  meshTriangleCount: number
): FacePaint[] {
  const removed = new Set(triangles);
  const result: FacePaint[] = [];
  for (const paint of activePaints(existing, meshTriangleCount)) {
    const kept = paint.triangles.filter((t) => !removed.has(t));
    if (kept.length > 0) result.push({ ...paint, triangles: kept });
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
  return existing
    .filter((p) => p.meshTriangleCount === meshTriangleCount && p.triangles.length > 0)
    .map((p) => ({ ...p, triangles: [...p.triangles] }));
}

/** True when paint exists but no longer matches the body it was painted on. */
export function hasStalePaint(
  existing: readonly FacePaint[] | undefined,
  meshTriangleCount: number
): boolean {
  if (!existing || existing.length === 0) return false;
  return existing.some((p) => p.meshTriangleCount !== meshTriangleCount);
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
    const ux = outer[b] - outer[a];
    const uy = outer[b + 1] - outer[a + 1];
    const uz = outer[b + 2] - outer[a + 2];
    const vx = outer[c] - outer[a];
    const vy = outer[c + 1] - outer[a + 1];
    const vz = outer[c + 2] - outer[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
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

  const result: PaintedSolid[] = [];
  let remainder = solid;
  for (const paint of active) {
    const shellMesh = buildPaintShellMesh(
      mesh,
      new Set(paint.triangles),
      paint.depthMm || DEFAULT_PAINT_DEPTH_MM
    );
    if (!shellMesh) {
      warningsHe.push(`אזור צבוע ריק דולג (${paint.materialSlotId})`);
      continue;
    }
    const { solid: shell, status } = kernel.fromMeshData(shellMesh);
    if (status !== "NoError") {
      shell.dispose();
      warningsHe.push(
        `הפרדת האזור הצבוע נכשלה (${status}) — נסו עומק צביעה קטן יותר או אזור פשוט יותר`
      );
      continue;
    }
    const [region, rest] = remainder.splitBySolid(shell);
    if (region.isEmpty() || region.status() !== "NoError") {
      // Put the material back rather than dropping it on the floor.
      region.dispose();
      remainder = rest;
      warningsHe.push("אזור צבוע לא הפיק גוף — נשאר כחלק מהגוף הראשי");
      continue;
    }
    result.push({ materialSlotId: paint.materialSlotId, solid: region });
    remainder = rest;
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

/** A printable part rebuilt from a mesh, sharing the source part's placement. */
function derivePart(
  source: PrintablePart,
  localMesh: MeshData,
  suffix: string,
  nameHe: string,
  materialSlotId: string
): PrintablePart {
  const worldMesh = transformMeshData(localMesh, source.worldMatrix);
  const bounds = meshDataBounds(worldMesh);
  return {
    ...source,
    id: `${source.id}${suffix}`,
    nameHe,
    materialSlotId,
    localMesh,
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
      watertight: true,
    },
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
    return activePaints(layer?.facePaint, part.localMesh.indices.length / 3).length > 0;
  });
  if (!anyPaint) return { parts: [...parts], warningsHe: [] };

  const kernel = await getGeometryKernel();
  const warningsHe: string[] = [];
  const out: PrintablePart[] = [];

  for (const part of parts) {
    const layer = layerById.get(part.primaryLayerId);
    const paints = activePaints(layer?.facePaint, part.localMesh.indices.length / 3);
    if (paints.length === 0) {
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

    if (pieces.length <= 1) {
      for (const piece of pieces) piece.solid.dispose();
      out.push(part);
      continue;
    }

    let index = 0;
    for (const piece of pieces) {
      const mesh = piece.solid.toMeshData();
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
          piece.materialSlotId ?? part.materialSlotId
        )
      );
    }
  }

  return { parts: out, warningsHe };
}
