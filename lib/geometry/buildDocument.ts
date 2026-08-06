/**
 * Document pipeline: DesignDocument → printable parts.
 *
 * "withBase" mode reproduces the V2 behaviour with per-layer 3D transforms:
 * the base plate is unioned with raised layers, engraved layers and holes
 * are subtracted, and the result is one printable part. Raised/engraved
 * layers are anchored to the base top plane and ride along with the base's
 * own transform. Standalone layers become independent parts.
 *
 * "baseless" mode builds every visible shape layer as an independent closed
 * printable solid (extrusions are closed by construction; imported meshes
 * must pass the manifold gate).
 *
 * All booleans run through the Manifold kernel, so every produced part is
 * watertight by construction; parts additionally report kernel status and
 * are re-checked with the edge-manifold gate before export.
 */

import * as THREE from "three";
import type {
  DesignDocument,
  DesignLayer,
  HoleLayer,
  ModelIssue,
  ShapeLayer,
} from "@/types/design";
import { isShapeLayer } from "@/types/design";
import { getGeometryKernel, type GeometryKernel, type Solid } from "./kernel";
import type { MeshData } from "./meshData";
import { matrix4ToManifoldMat4, transformToMatrix4 } from "./transform";
import { buildHoleCutter, buildShapeLayerSolid, LayerBuildError } from "./solids";

export interface PartStats {
  triangleCount: number;
  volumeMm3: number;
  surfaceAreaMm2: number;
  dimensionsMm: { x: number; y: number; z: number };
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
  layerIds: string[];
  materialSlotId: string;
  meshData: MeshData;
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

/** World matrix of a layer, honouring base anchoring in withBase mode. */
export function layerWorldMatrix(
  document: DesignDocument,
  layer: DesignLayer
): THREE.Matrix4 {
  const own = transformToMatrix4(layer.transform);
  if (document.baseMode !== "withBase" || layer.type === "base") return own;

  const base = findBaseLayer(document);
  if (!base) return own;

  const anchored =
    layer.type === "hole" ||
    (layer.type !== "importedMesh" && layer.combine !== "standalone");
  if (!anchored) return own;

  const baseM = transformToMatrix4(base.transform);
  const anchorZ = layer.type === "hole" ? 0 : base.thicknessMm;
  const anchor = new THREE.Matrix4().makeTranslation(0, 0, anchorZ);
  return baseM.multiply(anchor).multiply(own);
}

export function findBaseLayer(document: DesignDocument) {
  for (const layer of document.layers) {
    if (layer.type === "base") return layer;
  }
  return null;
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

function solidToPart(
  document: DesignDocument,
  primaryLayer: ShapeLayer,
  layerIds: string[],
  nameHe: string,
  solid: Solid
): PrintablePart {
  const bounds = solid.boundingBox();
  const stats: PartStats = {
    triangleCount: solid.numTriangles(),
    volumeMm3: solid.volumeMm3(),
    surfaceAreaMm2: solid.surfaceAreaMm2(),
    dimensionsMm: {
      x: bounds.max.x - bounds.min.x,
      y: bounds.max.y - bounds.min.y,
      z: bounds.max.z - bounds.min.z,
    },
    bounds,
    watertight: solid.status() === "NoError" && !solid.isEmpty(),
  };
  const issues: ModelIssue[] = [];
  if (!stats.watertight) {
    issues.push({
      code: "part/not-watertight",
      severity: "critical",
      titleHe: "החלק אינו אטום",
      detailHe: `סטטוס הליבה הגיאומטרית: ${solid.status()}`,
      actionHe: "נסו לתקן את הרשת או לשנות את הפרמטרים",
    });
  }
  return {
    id: `part_${primaryLayer.id}`,
    nameHe,
    layerIds,
    materialSlotId: primaryLayer.materialSlotId,
    meshData: solid.toMeshData(),
    stats,
    issues,
  };
}

/** Apply a layer's world matrix to its local solid. */
function toWorld(document: DesignDocument, layer: DesignLayer, solid: Solid): Solid {
  return solid.transform(matrix4ToManifoldMat4(layerWorldMatrix(document, layer)));
}

interface BuiltShape {
  layer: ShapeLayer;
  solid: Solid;
  effectiveCombine: "standalone" | "raised" | "engraved";
}

/** Effective combine mode of a shape layer under the document's base mode. */
export function effectiveCombineMode(
  document: DesignDocument,
  layer: ShapeLayer
): "standalone" | "raised" | "engraved" {
  if (layer.type === "base") return "standalone";
  if (document.baseMode === "baseless") return "standalone";
  if (!findBaseLayer(document)) return "standalone";
  return layer.combine;
}

/** Build all printable parts of a document. */
export async function buildDocument(
  document: DesignDocument
): Promise<DocumentBuildResult> {
  const kernel = await getGeometryKernel();
  const issues: ModelIssue[] = [];
  const built: BuiltShape[] = [];
  const holes: HoleLayer[] = [];

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
    for (const b of built) b.solid.dispose();
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

  const parts: PrintablePart[] = [];

  try {
    const base = built.find((b) => b.layer.type === "base");
    if (document.baseMode === "withBase" && base) {
      // Combined part: base ∪ raised ∖ engraved.
      let combined = toWorld(document, base.layer, base.solid);
      base.solid = combined; // ownership note: consumed below
      const combinedLayerIds = [base.layer.id];
      for (const b of built) {
        if (b === base) continue;
        if (b.effectiveCombine === "standalone") continue;
        const world = toWorld(document, b.layer, b.solid);
        combined =
          b.effectiveCombine === "raised"
            ? combined.union(world)
            : combined.subtract(world);
        combinedLayerIds.push(b.layer.id);
      }

      const standaloneShapes = built.filter(
        (b) => b !== base && b.effectiveCombine === "standalone"
      );
      const worldStandalones = standaloneShapes.map((b) => ({
        layer: b.layer,
        solid: toWorld(document, b.layer, b.solid),
      }));

      // Holes cut every part they can reach.
      const bodies: { layer: ShapeLayer; solid: Solid; layerIds: string[]; nameHe: string }[] = [
        { layer: base.layer, solid: combined, layerIds: combinedLayerIds, nameHe: base.layer.name },
        ...worldStandalones.map((w) => ({
          layer: w.layer,
          solid: w.solid,
          layerIds: [w.layer.id],
          nameHe: w.layer.name,
        })),
      ];
      applyHoles(kernel, document, holes, bodies);

      for (const body of bodies) {
        parts.push(
          solidToPart(document, body.layer, body.layerIds, body.nameHe, body.solid)
        );
        body.solid.dispose();
      }
    } else {
      // Baseless (or base-less withBase): every shape is its own part.
      const bodies = built.map((b) => ({
        layer: b.layer,
        solid: toWorld(document, b.layer, b.solid),
        layerIds: [b.layer.id],
        nameHe: b.layer.name,
      }));
      applyHoles(kernel, document, holes, bodies);
      for (const body of bodies) {
        parts.push(
          solidToPart(document, body.layer, body.layerIds, body.nameHe, body.solid)
        );
        body.solid.dispose();
      }
    }
  } catch (err) {
    issues.push({
      code: "document/build-failed",
      severity: "critical",
      titleHe: "בניית המודל נכשלה",
      detailHe: err instanceof Error ? err.message : String(err),
    });
    return { status: "error", parts: [], issues };
  }

  const nonEmptyParts = parts.filter((p) => p.stats.triangleCount > 0);
  if (nonEmptyParts.length < parts.length) {
    issues.push({
      code: "part/empty-result",
      severity: "warning",
      titleHe: "חלק מהשכבות הפיקו גוף ריק",
      detailHe: "ייתכן שחיסור או חיתוך הסירו את כל החומר",
    });
  }

  const hasCritical =
    issues.some((i) => i.severity === "critical") ||
    nonEmptyParts.some((p) => p.issues.some((i) => i.severity === "critical"));

  return {
    status: nonEmptyParts.length === 0 ? "error" : hasCritical ? "error" : "ok",
    parts: nonEmptyParts,
    issues,
  };
}

/** Subtract each hole cutter from every body whose bounds it intersects. */
function applyHoles(
  kernel: GeometryKernel,
  document: DesignDocument,
  holes: HoleLayer[],
  bodies: { layer: ShapeLayer; solid: Solid; layerIds: string[]; nameHe: string }[]
): void {
  if (holes.length === 0 || bodies.length === 0) return;

  // Span large enough to pass through anything in the scene.
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
    const matrix = matrix4ToManifoldMat4(layerWorldMatrix(document, hole));
    for (const body of bodies) {
      const cutter = buildHoleCutter(kernel, hole, span * 3).transform(matrix);
      body.solid = body.solid.subtract(cutter);
      if (!body.layerIds.includes(hole.id)) body.layerIds.push(hole.id);
    }
  }
}
