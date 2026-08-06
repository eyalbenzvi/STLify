/**
 * Plane cutting and model splitting.
 *
 * Manifold's splitByPlane always produces closed (capped) solids — cut
 * faces are real flat caps, so retained parts are printable by
 * construction. Splitting into disconnected components uses decompose().
 */

import * as THREE from "three";
import type {
  CutPlaneDefinition,
  DesignDocument,
  ImportedMeshLayer,
  ShapeLayer,
} from "@/types/design";
import { getGeometryKernel } from "../kernel";
import { materializeWorldSolid, OpError, solidToResultLayer } from "./layerOps";

const DEG = Math.PI / 180;

/** World-space unit normal + origin offset of a cut plane definition. */
export function cutPlaneNormalOffset(plane: CutPlaneDefinition): {
  normal: { x: number; y: number; z: number };
  offset: number;
} {
  let normal = new THREE.Vector3(0, 0, 1);
  if (plane.orientation === "xz") normal = new THREE.Vector3(0, 1, 0);
  else if (plane.orientation === "yz") normal = new THREE.Vector3(1, 0, 0);
  else if (plane.orientation === "custom") {
    normal = new THREE.Vector3(0, 0, 1).applyEuler(
      new THREE.Euler(plane.rotationX * DEG, plane.rotationY * DEG, 0, "XYZ")
    );
  }
  return {
    normal: { x: normal.x, y: normal.y, z: normal.z },
    offset: plane.offsetMm,
  };
}

export interface CutOutcome {
  /** Resulting part layers, in the order [above, below] (filtered by keep). */
  layers: ImportedMeshLayer[];
  warningsHe: string[];
}

/** Maximum parts a single split may produce (safety limit). */
export const MAX_SPLIT_PARTS = 12;

/** Cut one layer by a plane, keeping the requested sides as new layers. */
export async function performPlaneCut(
  document: DesignDocument,
  layer: ShapeLayer,
  plane: CutPlaneDefinition,
  keep: "top" | "bottom" | "both"
): Promise<CutOutcome> {
  const kernel = await getGeometryKernel();
  const solid = await materializeWorldSolid(kernel, document, layer);
  if (!solid || solid.isEmpty()) {
    solid?.dispose();
    throw new OpError(`לשכבה "${layer.name}" אין גאומטריה לחיתוך`);
  }

  const { normal, offset } = cutPlaneNormalOffset(plane);
  const [above, below] = solid.splitByPlane(normal.x, normal.y, normal.z, offset);

  const warningsHe: string[] = [];
  const results: ImportedMeshLayer[] = [];

  const wantAbove = keep === "top" || keep === "both";
  const wantBelow = keep === "bottom" || keep === "both";

  if (above.isEmpty() || below.isEmpty()) {
    // The plane did not actually pass through the body — nothing was cut.
    above.dispose();
    below.dispose();
    throw new OpError("מישור החיתוך אינו חוצה את האובייקט", [
      "הזיזו את מישור החיתוך אל תוך גבולות האובייקט",
    ]);
  }

  if (wantAbove && !above.isEmpty()) {
    results.push(
      solidToResultLayer(above, {
        nameHe: `${layer.name} — חלק עליון`,
        provenance: { kind: "cutResult", descriptionHe: "חיתוך מישור", sourceLayerIds: [layer.id] },
        materialSlotId: layer.materialSlotId,
      })
    );
  } else {
    above.dispose();
  }

  if (wantBelow && !below.isEmpty()) {
    results.push(
      solidToResultLayer(below, {
        nameHe: `${layer.name} — חלק תחתון`,
        provenance: { kind: "cutResult", descriptionHe: "חיתוך מישור", sourceLayerIds: [layer.id] },
        materialSlotId: layer.materialSlotId,
      })
    );
  } else {
    below.dispose();
  }

  if (results.length === 0) {
    throw new OpError("הצד שביקשתם לשמור ריק — הפעולה בוטלה");
  }
  return { layers: results, warningsHe };
}

export interface SplitPartsOutcome {
  layers: ImportedMeshLayer[];
  warningsHe: string[];
}

/** Split a layer into its disconnected printable components. */
export async function splitDisconnectedParts(
  document: DesignDocument,
  layer: ShapeLayer
): Promise<SplitPartsOutcome> {
  const kernel = await getGeometryKernel();
  const solid = await materializeWorldSolid(kernel, document, layer);
  if (!solid || solid.isEmpty()) {
    solid?.dispose();
    throw new OpError(`לשכבה "${layer.name}" אין גאומטריה לפיצול`);
  }
  const parts = solid.decompose();
  if (parts.length <= 1) {
    parts.forEach((p) => p.dispose());
    throw new OpError("האובייקט מקשה אחת — אין חלקים נפרדים לפיצול", [
      "השתמשו בחיתוך מישור כדי לפצל גוף רציף",
    ]);
  }
  const warningsHe: string[] = [];
  let kept = parts;
  if (parts.length > MAX_SPLIT_PARTS) {
    warningsHe.push(
      `האובייקט מכיל ${parts.length} חלקים — נשמרו ${MAX_SPLIT_PARTS} הגדולים ביותר`
    );
    kept = [...parts]
      .sort((a, b) => b.volumeMm3() - a.volumeMm3())
      .slice(0, MAX_SPLIT_PARTS);
    for (const part of parts) {
      if (!kept.includes(part)) part.dispose();
    }
  }
  const layers = kept.map((part, index) =>
    solidToResultLayer(part, {
      nameHe: `${layer.name} — חלק ${index + 1}`,
      provenance: { kind: "splitPart", descriptionHe: "פיצול לרכיבים", sourceLayerIds: [layer.id] },
      materialSlotId: layer.materialSlotId,
    })
  );
  return { layers, warningsHe };
}
