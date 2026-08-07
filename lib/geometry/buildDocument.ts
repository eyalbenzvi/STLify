/**
 * Document pipeline: DesignDocument → printable parts.
 *
 * Frames: every part's geometry is built in its PRIMARY layer's local
 * frame, and `worldMatrix` (the primary layer's Transform3D, plus base
 * anchoring for combined parts) carries the placement. The viewer applies
 * worldMatrix to a three.js object — so dragging a transform gizmo never
 * rebuilds geometry — while export/analysis use `worldMesh` (CPU-baked).
 *
 * "withBase" mode reproduces the V2 behaviour with per-layer 3D
 * transforms: base ∪ raised ∖ engraved ∖ holes as one printable part
 * (raised/engraved layers are anchored to the base top plane and ride
 * along with the base's own transform). Standalone layers become
 * independent parts. "baseless" mode builds every visible shape layer as
 * an independent closed solid.
 *
 * All booleans run through the Manifold kernel, so every produced part is
 * watertight by construction; parts additionally report kernel status and
 * are re-checked with the edge-manifold gate before export.
 */

import * as THREE from "three";
import type {
  BaseLayer,
  DesignDocument,
  DesignLayer,
  HoleLayer,
  ModelIssue,
  ShapeLayer,
} from "@/types/design";
import { isContourLayer, isShapeLayer } from "@/types/design";
import { getPrintabilityProfile } from "@/types/profiles";
import { getGeometryKernel, type GeometryKernel, type Solid } from "./kernel";
import { withSolidScopeSync } from "./solidScope";
import {
  meshDataBounds,
  meshDataSurfaceArea,
  meshDataVolume,
  transformMeshData,
  triangleCross,
  type MeshData,
} from "./meshData";
import { matrix4ToManifoldMat4, transformToMatrix4 } from "./transform";
import { resolveParameters, resolveBinding } from "./expression";
import {
  clearanceForFit,
  documentNozzleDiameterMm,
  elephantFootInsetAtHeight,
} from "./calibration";
// Type-only in the other direction, so this is not a runtime cycle.
import { hasStalePaint } from "./painting";
import { applyModifiers } from "./modifiers";
import {
  buildHoleCutter,
  buildInlayPocketCutter,
  buildShapeLayerSolid,
  LayerBuildError,
  type EffectiveCombine,
} from "./solids";

export interface PartStats {
  triangleCount: number;
  volumeMm3: number;
  surfaceAreaMm2: number;
  dimensionsMm: { x: number; y: number; z: number };
  /** World-space bounds. */
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  watertight: boolean;
}

export interface PrintablePart {
  /** Stable id derived from the primary layer. */
  id: string;
  nameHe: string;
  /** The layer whose transform places this part (gizmo target). */
  primaryLayerId: string;
  layerIds: string[];
  materialSlotId: string;
  /** Geometry in the primary layer's local frame. */
  localMesh: MeshData;
  /** World placement of the local frame. */
  worldMatrix: THREE.Matrix4;
  /** Geometry baked into world space (export / analysis). */
  worldMesh: MeshData;
  stats: PartStats;
  issues: ModelIssue[];
}

export type DocumentBuildStatus = "ok" | "empty" | "error";

export interface DocumentBuildResult {
  status: DocumentBuildStatus;
  parts: PrintablePart[];
  /** Document-level issues (per-layer failures, emptiness, ...). */
  issues: ModelIssue[];
}

/**
 * Progress and cancellation hooks, used when the build runs as a job.
 *
 * `throwIfCancelled` throws the CALLER's cancellation error; buildDocument
 * guarantees that anything it throws propagates out with every solid built
 * so far disposed — a cancelled build must not leak WASM memory.
 */
export interface BuildDocumentOptions {
  onProgress?: (fraction: number, labelHe: string) => void;
  throwIfCancelled?: () => void;
  /** Filled in when provided: how many layers were rebuilt vs served from cache. */
  stats?: BuildStats;
  /** Disable the per-layer solid cache (comparison tests). Default: enabled. */
  useLayerCache?: boolean;
}

/**
 * Elephant-foot compensation constants.
 *
 * A face counts as a WALL — something the inset can push inwards — only if
 * its normal has enough horizontal component to give a direction to push
 * along; a near-horizontal face has none. Two walls at a vertex count as the
 * same wall when their horizontal directions are this nearly parallel, which
 * is what keeps a cylinder's many facets from being mitered against each
 * other while a box corner's two genuinely different walls still are.
 */
const MIN_WALL_HORIZONTAL_FRACTION = 0.05;
const SAME_WALL_DIRECTION_DOT = 0.999;

/** Floor on the compensation height, so a zero never divides the falloff. */
const MIN_ELEPHANT_FOOT_HEIGHT_MM = 0.05;

/**
 * How the build's progress fraction is divided. Per-layer solids are the
 * bulk of the work; the remainder covers setup before and the booleans,
 * modifiers and world-space bake after.
 */
const LAYER_BUILD_PROGRESS_START = 0.05;
const LAYER_BUILD_PROGRESS_SPAN = 0.55;

export interface BuildStats {
  layersBuilt: number;
  layersFromCache: number;
}

// ---------------------------------------------------------------------------
// Per-layer solid cache (incremental rebuilds)
// ---------------------------------------------------------------------------

/**
 * Cache of the DERIVED per-layer solids, keyed by layer id.
 *
 * The expensive part of a rebuild is per layer: glyph contouring, extrusion,
 * kernel loading of imported meshes, and the modifier stack. All of that is
 * a pure function of the layer's RESOLVED content — not of its transform
 * (solids are built in the layer's local frame; placement happens at
 * assembly) and not of the other layers. So a solid can be reused as long
 * as the content hash matches, and only the layers the edit touched are
 * rebuilt; assembly (booleans, holes, elephant foot) always reruns because
 * it genuinely depends on multiple layers.
 *
 * Manifold's memory model is what makes the bookkeeping strict: assembly
 * CONSUMES the solids it is given, so the cache hands out `duplicate()`
 * handles and never exposes the stored one. (duplicate() is a cheap extra
 * handle to shared geometry — disposing one side never invalidates the
 * other.) Invalidated and orphaned entries are disposed explicitly.
 *
 * Lives per thread (module state): the worker keeps it across builds, which
 * is exactly where incremental rebuilds pay off.
 */
interface LayerCacheEntry {
  hash: string;
  solid: Solid;
  /** Modifier warnings emitted when the solid was built — re-reported on hits. */
  issues: ModelIssue[];
}

const layerSolidCache = new Map<string, LayerCacheEntry>();

/** Dispose and forget every cached layer solid (tests, memory pressure). */
export function clearLayerSolidCache(): void {
  for (const entry of layerSolidCache.values()) entry.solid.dispose();
  layerSolidCache.clear();
}

/** JSON.stringify with sorted object keys, so hashes are order-stable. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "u";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/**
 * Content hash of everything the layer's LOCAL solid depends on. The
 * transform and name are deliberately excluded (they do not change the local
 * geometry); the resolved layer is used so parameter/binding changes
 * propagate; nozzle diameter feeds the lattice modifier's safety check.
 */
function layerContentHash(
  resolvedLayer: ShapeLayer,
  effectiveCombine: EffectiveCombine,
  nozzleDiameterMm: number
): string {
  // Excluded on purpose: transform, pivot and parentId only place the solid
  // (assembly-stage); name/locked/previewOpacity/facePaint are not geometry.
  const {
    transform,
    pivot,
    parentId,
    name,
    locked,
    previewOpacity,
    facePaint,
    ...content
  } = resolvedLayer as ShapeLayer & Record<string, unknown>;
  void transform;
  void pivot;
  void parentId;
  void name;
  void locked;
  void previewOpacity;
  void facePaint;
  return stableStringify({ content, effectiveCombine, nozzleDiameterMm });
}

export function findBaseLayer(document: DesignDocument): BaseLayer | null {
  for (const layer of document.layers) {
    if (layer.type === "base") return layer;
  }
  return null;
}

/** True when the layer is anchored to the base (withBase mode). */
function isAnchoredToBase(document: DesignDocument, layer: DesignLayer): boolean {
  if (document.baseMode !== "withBase" || layer.type === "base") return false;
  if (!findBaseLayer(document)) return false;
  if (layer.type === "hole") return true;
  if (layer.type === "importedMesh") return false;
  return layer.combine !== "standalone";
}

/**
 * A layer's own transform, applied about its pivot.
 *
 * Without a pivot, rotation and scale always happen about the layer's
 * origin — so rotating a lid spins it around the wrong point. Conjugating
 * the transform by a translation to the pivot moves the centre of rotation
 * without changing where the unrotated layer sits.
 */
function localMatrix(layer: DesignLayer): THREE.Matrix4 {
  const pivot = layer.pivot;
  if (!pivot || (pivot.x === 0 && pivot.y === 0 && pivot.z === 0)) {
    return transformToMatrix4(layer.transform);
  }
  // The pivot must wrap the ROTATION AND SCALE only:
  //   M = T · T(pivot) · R · S · T(-pivot)
  // Putting both pivot translations after the fully composed T·R·S makes
  // them cancel out, silently doing nothing.
  const { x, y, z } = layer.transform;
  const rotationScale = transformToMatrix4({ ...layer.transform, x: 0, y: 0, z: 0 });
  const translation = new THREE.Matrix4().makeTranslation(x, y, z);
  const toPivot = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
  const fromPivot = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
  return translation.multiply(toPivot).multiply(rotationScale).multiply(fromPivot);
}

/**
 * World matrix of a layer: its parent chain, then base anchoring, then its
 * own pivot-aware transform.
 *
 * The parent walk is defensive about cycles. Validation rejects them, but a
 * hand-edited or hostile design file could still contain one, and the build
 * must not hang: the walk stops as soon as it revisits a layer.
 */
export function layerWorldMatrix(
  document: DesignDocument,
  layer: DesignLayer
): THREE.Matrix4 {
  const own = localMatrix(layer);

  let matrix = own;
  if (layer.parentId) {
    const byId = new Map(document.layers.map((l) => [l.id, l]));
    const seen = new Set<string>([layer.id]);
    const chain: DesignLayer[] = [];
    let cursor = byId.get(layer.parentId);
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      chain.push(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    // Outermost ancestor first, so each multiplication nests inward.
    for (let i = chain.length - 1; i >= 0; i--) {
      matrix = localMatrix(chain[i]).multiply(matrix);
    }
  }

  if (!isAnchoredToBase(document, layer)) return matrix;
  const base = findBaseLayer(document)!;
  const baseM = transformToMatrix4(base.transform);
  const anchorZ = layer.type === "hole" ? 0 : base.thicknessMm;
  const anchor = new THREE.Matrix4().makeTranslation(0, 0, anchorZ);
  return baseM.multiply(anchor).multiply(matrix);
}

/** Effective combine mode of a shape layer under the document's base mode. */
export function effectiveCombineMode(
  document: DesignDocument,
  layer: ShapeLayer
): EffectiveCombine {
  if (layer.type === "base") return "standalone";
  if (document.baseMode === "baseless") return "standalone";
  if (!findBaseLayer(document)) return "standalone";
  return layer.combine;
}

/** Printing clearance used for inlay pockets, mm. */
function inlayClearanceMm(document: DesignDocument): number {
  // Precedence, most specific first. A calibrated machine beats the profile's
  // guess — that is the whole point of measuring — but it must NOT beat a
  // number the user typed into the printability panel: that field stays
  // editable and kept accepting edits that did nothing.
  const override = document.customPrintability?.clearanceMm;
  if (override !== undefined) return override;
  if (document.calibration) {
    return clearanceForFit(document.calibration, "sliding");
  }
  return getPrintabilityProfile(document.printabilityProfileId).clearanceMm;
}

function issueForLayerFailure(layer: DesignLayer, err: unknown): ModelIssue {
  const detail =
    err instanceof LayerBuildError
      ? err.messageHe
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    code: "layer/build-failed",
    severity: "critical",
    titleHe: `בניית השכבה "${layer.name}" נכשלה`,
    detailHe: detail,
    actionHe: "בדקו את הפרמטרים של השכבה או הסתירו אותה זמנית",
  };
}

/**
 * Apply a layer's expression bindings to its numeric fields.
 *
 * Bindings live in a side table keyed by field name, so any numeric field
 * can be driven by a parameter without every layer type growing a parallel
 * "expression" property. A binding that does not evaluate leaves the stored
 * literal alone — the document keeps building and the parameters panel shows
 * the error.
 */
function resolveLayer<T extends ShapeLayer>(layer: T, parameters: ReadonlyMap<string, number>): T {
  const bindings = layer.bindings;
  if (!bindings) return layer;
  const entries = Object.entries(bindings).filter(([, expr]) => expr && expr.trim());
  if (entries.length === 0) return layer;

  const patched = { ...layer } as T & Record<string, unknown>;
  for (const [field, expression] of entries) {
    const current = patched[field];
    if (typeof current !== "number") continue;
    const { value } = resolveBinding(expression, parameters, current);
    patched[field] = value;
  }
  return patched as T;
}

interface PartBody {
  primary: ShapeLayer;
  /** In the primary layer's local frame. Reassigned by post-processing. */
  solid: Solid;
  layerIds: string[];
  nameHe: string;
}

/** World-space bounds of a solid held in `worldMatrix`'s local frame. */
function worldBoundsOf(solid: Solid, worldMatrix: THREE.Matrix4): THREE.Box3 {
  const local = solid.boundingBox();
  const box = new THREE.Box3(
    new THREE.Vector3(local.min.x, local.min.y, local.min.z),
    new THREE.Vector3(local.max.x, local.max.y, local.max.z)
  );
  return box.applyMatrix4(worldMatrix);
}

/**
 * Move each near-vertical wall of the bottom slab inward, perpendicular to
 * itself. Consumes `slab`; returns null when the result is not a valid solid.
 *
 * Contracting radially towards the part's centre — the obvious first
 * implementation — is wrong in two ways that matter:
 *
 *  - **It closes holes.** A hole's wall lies on the far side of the centre
 *    from itself, so pulling everything inward makes the bore SMALLER at the
 *    bed. That is the exact opposite of the correction, and it fights
 *    `holeCompensationMm`, the other half of the same feature. Offsetting
 *    along each wall's own outward normal instead widens a bore and narrows
 *    an outer wall, which is what the squashed first layer actually does.
 *  - **It rounds corners.** A radial pull moves a corner by the compensation
 *    along the diagonal, so each face lands short: 0.283 mm per axis for a
 *    0.4 mm setting on a box. A corner vertex has to satisfy BOTH of its
 *    walls' offset planes at once — a miter — which is a 2x2 solve.
 *
 * Only walls take part: a vertex whose faces are all horizontal (the bed
 * face, the cut plane) has no in-plane direction to move along and stays put,
 * which is what keeps the part flat on the plate and keeps the cut plane
 * matching the untouched top half.
 */
function insetSlabWalls(
  kernel: GeometryKernel,
  slab: Solid,
  calibration: NonNullable<DesignDocument["calibration"]>,
  toWorld: THREE.Matrix4,
  toLocal: THREE.Matrix4
): Solid | null {
  const mesh = slab.toMeshData();
  slab.dispose();
  const vertexCount = mesh.positions.length / 3;
  const triangleCount = mesh.indices.length / 3;

  // World-space copy: the bed is a world plane, and so is the offset.
  const world = new Float64Array(mesh.positions.length);
  const point = new THREE.Vector3();
  for (let v = 0; v < vertexCount; v++) {
    point
      .set(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2])
      .applyMatrix4(toWorld);
    world[v * 3] = point.x;
    world[v * 3 + 1] = point.y;
    world[v * 3 + 2] = point.z;
  }

  // Distinct wall directions per vertex. Distinct matters: a cylinder's
  // vertex has two nearly-parallel facets and must not be mitered between
  // them, while a box corner has two genuinely different walls and must.
  const walls: number[][] = Array.from({ length: vertexCount }, () => []);
  const cross: [number, number, number] = [0, 0, 0];
  for (let t = 0; t < triangleCount; t++) {
    const [nx, ny, nz] = triangleCross(
      world,
      mesh.indices[t * 3],
      mesh.indices[t * 3 + 1],
      mesh.indices[t * 3 + 2],
      cross
    );
    const horizontal = Math.hypot(nx, ny);
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-12) continue;
    // Near-horizontal faces have no in-plane direction to offset along.
    if (horizontal / length < MIN_WALL_HORIZONTAL_FRACTION) continue;
    const dx = nx / horizontal;
    const dy = ny / horizontal;
    for (let k = 0; k < 3; k++) {
      const list = walls[mesh.indices[t * 3 + k]];
      let known = false;
      for (let i = 0; i < list.length; i += 2) {
        if (list[i] * dx + list[i + 1] * dy > SAME_WALL_DIRECTION_DOT) {
          known = true;
          break;
        }
      }
      if (!known) list.push(dx, dy);
    }
  }

  let moved = false;
  for (let v = 0; v < vertexCount; v++) {
    const inset = elephantFootInsetAtHeight(calibration, world[v * 3 + 2]);
    if (inset <= 0) continue;
    const list = walls[v];
    if (list.length === 0) continue;

    const px = world[v * 3];
    const py = world[v * 3 + 1];
    let targetX: number;
    let targetY: number;

    if (list.length === 2) {
      targetX = px - list[0] * inset;
      targetY = py - list[1] * inset;
    } else {
      // The two most divergent walls define the corner; a third would be
      // over-determined, and the sharpest pair is the one that decides where
      // the corner actually lands.
      let bestI = 0;
      let bestJ = 2;
      let bestDot = Infinity;
      for (let i = 0; i < list.length; i += 2) {
        for (let j = i + 2; j < list.length; j += 2) {
          const dot = list[i] * list[j] + list[i + 1] * list[j + 1];
          if (dot < bestDot) {
            bestDot = dot;
            bestI = i;
            bestJ = j;
          }
        }
      }
      const n1x = list[bestI];
      const n1y = list[bestI + 1];
      const n2x = list[bestJ];
      const n2y = list[bestJ + 1];
      const det = n1x * n2y - n1y * n2x;
      if (Math.abs(det) < 0.02) {
        // Effectively one wall (or a fold sharper than the miter can express).
        targetX = px - n1x * inset;
        targetY = py - n1y * inset;
      } else {
        const d1 = n1x * px + n1y * py - inset;
        const d2 = n2x * px + n2y * py - inset;
        targetX = (d1 * n2y - d2 * n1y) / det;
        targetY = (n1x * d2 - n2x * d1) / det;
      }
    }

    // A very sharp corner sends the miter off to infinity; clamping keeps a
    // spike from turning the slab inside out.
    const limit = inset * 4;
    const dx = targetX - px;
    const dy = targetY - py;
    const distance = Math.hypot(dx, dy);
    if (distance > limit && distance > 1e-12) {
      targetX = px + (dx / distance) * limit;
      targetY = py + (dy / distance) * limit;
    }
    world[v * 3] = targetX;
    world[v * 3 + 1] = targetY;
    moved = true;
  }

  if (!moved) {
    const { solid: unchanged, status } = kernel.fromMeshData(mesh);
    if (status !== "NoError") {
      unchanged.dispose();
      return null;
    }
    return unchanged;
  }

  for (let v = 0; v < vertexCount; v++) {
    point.set(world[v * 3], world[v * 3 + 1], world[v * 3 + 2]).applyMatrix4(toLocal);
    mesh.positions[v * 3] = point.x;
    mesh.positions[v * 3 + 1] = point.y;
    mesh.positions[v * 3 + 2] = point.z;
  }
  const { solid: inset, status } = kernel.fromMeshData(mesh);
  if (status !== "NoError" || inset.isEmpty()) {
    inset.dispose();
    return null;
  }
  return inset;
}

/**
 * Shrink the first layers of a part inward.
 *
 * "Elephant foot" is the bulge left when the nozzle squashes the opening
 * layers against the bed: the part comes out oversized at its base and will
 * not seat flush in a pocket or against a mating face. Insetting those layers
 * in the MODEL cancels it, and doing it here — after the part is finished —
 * means it applies to every part however it was built.
 *
 * Three things this has to get right, each of which was wrong in the first
 * version:
 *
 *  1. **Only the affected band is touched.** Refining the whole part so the
 *     warp has vertices to move took a 12-triangle cube to 65,292 triangles —
 *     on every debounced rebuild. The part is instead SPLIT at the
 *     compensation height and only the bottom slab is deformed.
 *  2. **No refinement is needed at all.** The split guarantees vertices at
 *     z = 0 and at the compensation height, and the inset fades linearly
 *     between them, so linear interpolation across the side walls is already
 *     exact. Refining only added triangles, never accuracy.
 *  3. **The bed is a WORLD plane.** Reading the world height from the
 *     matrix's translation alone ignored rotation, so a part stood on its
 *     side got the correction on a vertical face in its middle — or, when it
 *     was also lifted, no correction at all. Every vertex is now taken to
 *     world space, inset there, and brought back.
 *
 * Never throws and never consumes `solid` on failure: the caller keeps a live
 * handle either way.
 */
function applyElephantFoot(
  kernel: GeometryKernel,
  solid: Solid,
  document: DesignDocument,
  worldMatrix: THREE.Matrix4
): { solid: Solid; failed: boolean } {
  const calibration = document.calibration;
  if (!calibration || calibration.elephantFootCompensationMm <= 0) {
    return { solid, failed: false };
  }
  const height = Math.max(
    MIN_ELEPHANT_FOOT_HEIGHT_MM,
    calibration.elephantFootHeightMm
  );

  const worldBounds = worldBoundsOf(solid, worldMatrix);
  // Nothing of this part is near the plate, so nothing is squashed.
  if (worldBounds.min.z >= height) return { solid, failed: false };

  const centreX = (worldBounds.min.x + worldBounds.max.x) / 2;
  const centreY = (worldBounds.min.y + worldBounds.max.y) / 2;
  const toWorld = worldMatrix;
  const toLocal = worldMatrix.clone().invert();

  // The scope owns every intermediate; a mid-way kernel failure frees them
  // all and leaves the caller holding the original untouched `solid`.
  // (dispose() is idempotent, so handles consumed by split/union are
  // skipped safely by the final sweep.)
  try {
    return withSolidScopeSync((scope) => {
      const working = scope.track(solid.duplicate());
      // A world-space slab from below the part up to the compensation
      // height, expressed in the part's own frame so it can cut the local
      // solid.
      const size = new THREE.Vector3();
      worldBounds.getSize(size);
      const pad = Math.max(size.x, size.y, 10) + 10;
      const floor = worldBounds.min.z - 1;
      const span = pad * 2;
      const slab = scope.track(
        kernel
          .box(span, span, height - floor, false)
          .translate(centreX - pad, centreY - pad, floor)
          .transform(matrix4ToManifoldMat4(toLocal))
      );
      const [bottom, top] = working.splitBySolid(slab);
      scope.track(bottom);
      scope.track(top);
      if (bottom.isEmpty()) return { solid, failed: false };
      const warped = scope.trackMaybe(
        insetSlabWalls(kernel, bottom, calibration, toWorld, toLocal)
      );
      if (!warped) return { solid, failed: true };
      const merged = top.isEmpty() ? warped : scope.track(warped.union(top));
      if (merged.status() !== "NoError" || merged.isEmpty()) {
        return { solid, failed: true };
      }
      solid.dispose();
      return { solid: scope.keep(merged), failed: false };
    });
  } catch {
    return { solid, failed: true };
  }
}

function bodyToPart(document: DesignDocument, body: PartBody): PrintablePart {
  const worldMatrix = layerWorldMatrix(document, body.primary);
  const localMesh = body.solid.toMeshData();
  const worldMesh = transformMeshData(localMesh, worldMatrix);
  const bounds = meshDataBounds(worldMesh);
  const watertight = body.solid.status() === "NoError" && !body.solid.isEmpty();
  const stats: PartStats = {
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
  };
  const issues: ModelIssue[] = [];
  if (!watertight) {
    issues.push({
      code: "part/not-watertight",
      severity: "critical",
      titleHe: `החלק "${body.nameHe}" אינו אטום`,
      detailHe: `סטטוס הליבה הגיאומטרית: ${body.solid.status()}`,
      actionHe: "נסו לתקן את הרשת או לשנות את הפרמטרים",
    });
  }
  return {
    id: `part_${body.primary.id}`,
    nameHe: body.nameHe,
    primaryLayerId: body.primary.id,
    layerIds: body.layerIds,
    materialSlotId: body.primary.materialSlotId,
    localMesh,
    worldMatrix,
    worldMesh,
    stats,
    issues,
  };
}

/** Build all printable parts of a document. */
export async function buildDocument(
  document: DesignDocument,
  options: BuildDocumentOptions = {}
): Promise<DocumentBuildResult> {
  const kernel = await getGeometryKernel();
  const issues: ModelIssue[] = [];
  const holes: HoleLayer[] = [];
  const onProgress = options.onProgress ?? (() => undefined);
  const cancelPoint = () => options.throwIfCancelled?.();
  const useCache = options.useLayerCache !== false;
  const nozzleDiameterMm = documentNozzleDiameterMm(document);

  // Entries whose layer no longer exists can never be reused — free their
  // WASM memory now. (A concurrent cancelled build holds its own duplicate
  // handles, so disposing the cache's handle here is safe.)
  if (useCache) {
    const liveIds = new Set(document.layers.map((l) => l.id));
    for (const [id, entry] of layerSolidCache) {
      if (!liveIds.has(id)) {
        entry.solid.dispose();
        layerSolidCache.delete(id);
      }
    }
  }

  interface BuiltShape {
    layer: ShapeLayer;
    solid: Solid;
    effectiveCombine: EffectiveCombine;
  }
  const built: BuiltShape[] = [];

  // Named parameters are resolved once per build and drive every
  // expression-bound field.
  const parameterTable = resolveParameters(document.parameters ?? []);
  const parameters = parameterTable.values;
  for (const [name, messageHe] of parameterTable.errors) {
    issues.push({
      code: "parameter/invalid",
      severity: "warning",
      titleHe: `הפרמטר "${name}" אינו תקין`,
      detailHe: messageHe,
      actionHe: "תקנו את הביטוי בלוח הפרמטרים",
    });
  }

  const visibleLayers = document.layers.filter((l) => l.visible);
  let layerIndex = 0;
  for (const layer of visibleLayers) {
    // Cancellation and progress live OUTSIDE the per-layer try: the catch
    // below exists to turn a broken layer into an issue and keep building,
    // which is exactly the wrong treatment for "stop building".
    try {
      cancelPoint();
    } catch (err) {
      for (const b of built) b.solid.dispose();
      throw err;
    }
    onProgress(
      LAYER_BUILD_PROGRESS_START +
        LAYER_BUILD_PROGRESS_SPAN *
          (layerIndex++ / Math.max(1, visibleLayers.length)),
      `בונה את השכבה "${layer.name}"`
    );
    if (layer.type === "hole") {
      holes.push(layer);
      continue;
    }
    if (layer.type === "base" && document.baseMode === "baseless") continue;
    if (!isShapeLayer(layer)) continue;
    const effectiveCombine = effectiveCombineMode(document, layer);
    try {
      const resolved = resolveLayer(layer, parameters);
      const hash = useCache
        ? layerContentHash(resolved, effectiveCombine, nozzleDiameterMm)
        : null;
      if (hash) {
        const cached = layerSolidCache.get(layer.id);
        if (cached && cached.hash === hash) {
          // Hand out a DUPLICATE — assembly consumes what it is given, and
          // the stored handle must survive for the next build.
          issues.push(...cached.issues);
          built.push({ layer, solid: cached.solid.duplicate(), effectiveCombine });
          if (options.stats) options.stats.layersFromCache++;
          continue;
        }
      }

      const solid = await buildShapeLayerSolid(kernel, resolved, effectiveCombine);
      if (options.stats) options.stats.layersBuilt++;
      if (!solid) continue;
      // Apply the re-editable modifier stack. Failures are reported as
      // issues but never abort the build: the document is rebuilt on every
      // keystroke, and a momentarily invalid parameter should surface a
      // message rather than blank the viewport.
      const stack = layer.modifiers ?? [];
      let finalSolid = solid;
      const layerIssues: ModelIssue[] = [];
      if (stack.length > 0) {
        const applied = applyModifiers(kernel, solid, stack, { nozzleDiameterMm });
        for (const errorHe of applied.errorsHe) {
          layerIssues.push({
            code: "modifier/failed",
            severity: "warning",
            titleHe: `מודיפייר בשכבה "${layer.name}" נכשל`,
            detailHe: errorHe,
            actionHe: "שנו את הפרמטרים של המודיפייר או כבו אותו",
          });
        }
        finalSolid = applied.solid;
      }
      issues.push(...layerIssues);
      if (hash) {
        // Cache the finished solid; modifier warnings are cached WITH it so
        // a cache hit re-reports them instead of silently clearing them.
        layerSolidCache.get(layer.id)?.solid.dispose();
        layerSolidCache.set(layer.id, {
          hash,
          solid: finalSolid.duplicate(),
          issues: layerIssues,
        });
      }
      built.push({ layer, solid: finalSolid, effectiveCombine });
    } catch (err) {
      issues.push(issueForLayerFailure(layer, err));
    }
  }

  if (built.length === 0) {
    return {
      status: issues.length > 0 ? "error" : "empty",
      parts: [],
      issues:
        issues.length > 0
          ? issues
          : [
              {
                code: "document/empty",
                severity: "warning",
                titleHe: "אין תוכן להצגה",
                detailHe: "הוסיפו טקסט, SVG, תמונה או קובץ STL כדי ליצור מודל",
              },
            ],
    };
  }

  // Safe cancellation boundary: every solid built so far is still owned by
  // `built`, so all of them can be disposed. (Inside the assembly below,
  // handles are progressively consumed by booleans — a mid-assembly cancel
  // could not tell live handles from consumed ones.)
  try {
    cancelPoint();
  } catch (err) {
    for (const b of built) b.solid.dispose();
    throw err;
  }
  onProgress(0.65, "מאחד גופים");

  const bodies: PartBody[] = [];
  try {
    const base = built.find((b) => b.layer.type === "base");
    if (document.baseMode === "withBase" && base && base.layer.type === "base") {
      // Combined part in the BASE's local frame: base at identity, anchored
      // layers at translate(0,0,thickness) · ownTransform.
      let combined = base.solid;
      const combinedLayerIds = [base.layer.id];
      for (const b of built) {
        if (b === base || b.effectiveCombine === "standalone") continue;
        const anchor = new THREE.Matrix4()
          .makeTranslation(0, 0, base.layer.thicknessMm)
          .multiply(transformToMatrix4(b.layer.transform));
        if (b.effectiveCombine === "inlay") {
          // Flush insert: subtract a clearance pocket from the base; the
          // inlay body itself becomes a separate part below.
          if (isContourLayer(b.layer)) {
            const pocket = await buildInlayPocketCutter(
              kernel,
              b.layer,
              inlayClearanceMm(document)
            );
            if (pocket) {
              combined = combined.subtract(
                pocket.transform(matrix4ToManifoldMat4(anchor))
              );
              combinedLayerIds.push(b.layer.id);
            }
          }
          continue;
        }
        const positioned = b.solid.transform(matrix4ToManifoldMat4(anchor));
        combined =
          b.effectiveCombine === "raised"
            ? combined.union(positioned)
            : combined.subtract(positioned);
        combinedLayerIds.push(b.layer.id);
      }
      bodies.push({
        primary: base.layer,
        solid: combined,
        layerIds: combinedLayerIds,
        nameHe: base.layer.name,
      });
      for (const b of built) {
        if (b === base) continue;
        if (b.effectiveCombine === "standalone") {
          bodies.push({
            primary: b.layer,
            solid: b.solid,
            layerIds: [b.layer.id],
            nameHe: b.layer.name,
          });
        } else if (b.effectiveCombine === "inlay") {
          bodies.push({
            primary: b.layer,
            solid: b.solid,
            layerIds: [b.layer.id],
            nameHe: `${b.layer.name} (שיבוץ)`,
          });
        }
      }
    } else {
      for (const b of built) {
        bodies.push({
          primary: b.layer,
          solid: b.solid,
          layerIds: [b.layer.id],
          nameHe: b.layer.name,
        });
      }
    }

    applyHoles(kernel, document, holes, bodies);
  } catch (err) {
    for (const body of bodies) body.solid.dispose();
    issues.push({
      code: "document/build-failed",
      severity: "critical",
      titleHe: "בניית המודל נכשלה",
      detailHe: err instanceof Error ? err.message : String(err),
    });
    return { status: "error", parts: [], issues };
  }

  // Second safe boundary: assembly is done, every live handle sits in
  // `bodies`.
  try {
    cancelPoint();
  } catch (err) {
    for (const body of bodies) body.solid.dispose();
    throw err;
  }
  onProgress(0.85, "מכין חלקים להצגה");

  const parts: PrintablePart[] = [];
  for (const body of bodies) {
    // First-layer compensation is applied to the finished body, so it covers
    // every part regardless of how it was built.
    if (document.calibration && document.calibration.elephantFootCompensationMm > 0) {
      const compensated = applyElephantFoot(
        kernel,
        body.solid,
        document,
        layerWorldMatrix(document, body.primary)
      );
      body.solid = compensated.solid;
      if (compensated.failed) {
        issues.push({
          code: "calibration/elephant-foot-failed",
          severity: "warning",
          titleHe: `פיצוי ״רגל פיל״ נכשל בחלק "${body.nameHe}"`,
          detailHe: "החלק נבנה ללא הפיצוי. נסו ערך פיצוי קטן יותר.",
        });
      }
    }
    const part = bodyToPart(document, body);
    // Painted regions are recorded against a specific body. Say so here, at
    // the point the mismatch becomes real, rather than leaving the user to
    // discover the missing colour when the ZIP comes out single-coloured.
    if (hasStalePaint(body.primary.facePaint, part.stats.triangleCount)) {
      issues.push({
        code: "paint/stale",
        severity: "warning",
        titleHe: `הצביעה בשכבה "${body.primary.name}" בוטלה`,
        detailHe:
          "הגוף השתנה מאז שנצבע, ולכן סימוני הצבע כבר אינם מתאימים לפאות שלו.",
        actionHe: "צבעו את האזורים מחדש במצב בחירת פאות",
      });
    }
    body.solid.dispose();
    if (part.stats.triangleCount > 0) {
      parts.push(part);
    } else {
      issues.push({
        code: "part/empty-result",
        severity: "warning",
        titleHe: `השכבה "${body.nameHe}" הפיקה גוף ריק`,
        detailHe: "ייתכן שחיסור או חיתוך הסירו את כל החומר",
      });
    }
  }

  const hasCritical =
    issues.some((i) => i.severity === "critical") ||
    parts.some((p) => p.issues.some((i) => i.severity === "critical"));

  return {
    status: parts.length === 0 ? "error" : hasCritical ? "error" : "ok",
    parts,
    issues,
  };
}

/**
 * Subtract each hole cutter from every body. Cutters are expressed in each
 * body's local frame: bodyWorld⁻¹ · holeWorld.
 */
function applyHoles(
  kernel: GeometryKernel,
  document: DesignDocument,
  holes: HoleLayer[],
  bodies: PartBody[]
): void {
  if (holes.length === 0 || bodies.length === 0) return;

  let span = 10;
  for (const body of bodies) {
    const b = body.solid.boundingBox();
    span = Math.max(
      span,
      Math.abs(b.min.x),
      Math.abs(b.max.x),
      Math.abs(b.min.y),
      Math.abs(b.max.y),
      Math.abs(b.min.z),
      Math.abs(b.max.z)
    );
  }

  for (const hole of holes) {
    const holeWorld = layerWorldMatrix(document, hole);
    for (const body of bodies) {
      const bodyWorldInv = layerWorldMatrix(document, body.primary).invert();
      const local = bodyWorldInv.multiply(holeWorld);
      const cutter = buildHoleCutter(kernel, hole, span * 3, document.calibration).transform(
        matrix4ToManifoldMat4(local)
      );
      body.solid = body.solid.subtract(cutter);
      if (!body.layerIds.includes(hole.id)) body.layerIds.push(hole.id);
    }
  }
}
