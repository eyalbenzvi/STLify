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

/** World matrix of a layer, honouring base anchoring in withBase mode. */
export function layerWorldMatrix(
  document: DesignDocument,
  layer: DesignLayer
): THREE.Matrix4 {
  const own = transformToMatrix4(layer.transform);
  if (!isAnchoredToBase(document, layer)) return own;
  const base = findBaseLayer(document)!;
  const baseM = transformToMatrix4(base.transform);
  const anchorZ = layer.type === "hole" ? 0 : base.thicknessMm;
  const anchor = new THREE.Matrix4().makeTranslation(0, 0, anchorZ);
  return baseM.multiply(anchor).multiply(own);
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
      const solid = await buildShapeLayerSolid(kernel, layer, effectiveCombine);
      if (solid) built.push({ layer, solid, effectiveCombine });
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
