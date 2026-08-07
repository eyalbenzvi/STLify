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
import {
  meshDataBounds,
  meshDataSurfaceArea,
  meshDataVolume,
  transformMeshData,
  type MeshData,
} from "./meshData";
import { matrix4ToManifoldMat4, transformToMatrix4 } from "./transform";
import { resolveParameters, resolveBinding } from "./expression";
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
  return (
    document.customPrintability?.clearanceMm ??
    getPrintabilityProfile(document.printabilityProfileId).clearanceMm
  );
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
  solid: Solid; // in the primary layer's local frame
  layerIds: string[];
  nameHe: string;
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
  document: DesignDocument
): Promise<DocumentBuildResult> {
  const kernel = await getGeometryKernel();
  const issues: ModelIssue[] = [];
  const holes: HoleLayer[] = [];

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
  for (const layer of visibleLayers) {
    if (layer.type === "hole") {
      holes.push(layer);
      continue;
    }
    if (layer.type === "base" && document.baseMode === "baseless") continue;
    if (!isShapeLayer(layer)) continue;
    const effectiveCombine = effectiveCombineMode(document, layer);
    try {
      const solid = await buildShapeLayerSolid(kernel, resolveLayer(layer, parameters), effectiveCombine);
      if (!solid) continue;
      // Apply the re-editable modifier stack. Failures are reported as
      // issues but never abort the build: the document is rebuilt on every
      // keystroke, and a momentarily invalid parameter should surface a
      // message rather than blank the viewport.
      const stack = layer.modifiers ?? [];
      if (stack.length === 0) {
        built.push({ layer, solid, effectiveCombine });
        continue;
      }
      const applied = applyModifiers(kernel, solid, stack);
      for (const errorHe of applied.errorsHe) {
        issues.push({
          code: "modifier/failed",
          severity: "warning",
          titleHe: `מודיפייר בשכבה "${layer.name}" נכשל`,
          detailHe: errorHe,
          actionHe: "שנו את הפרמטרים של המודיפייר או כבו אותו",
        });
      }
      built.push({ layer, solid: applied.solid, effectiveCombine });
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

  const parts: PrintablePart[] = [];
  for (const body of bodies) {
    const part = bodyToPart(document, body);
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
      const cutter = buildHoleCutter(kernel, hole, span * 3).transform(
        matrix4ToManifoldMat4(local)
      );
      body.solid = body.solid.subtract(cutter);
      if (!body.layerIds.includes(hole.id)) body.layerIds.push(hole.id);
    }
  }
}
