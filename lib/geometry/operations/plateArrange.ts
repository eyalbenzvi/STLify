/**
 * Auto-arrange: pack every built part onto the build plate and write the
 * result back as layer transforms.
 *
 * `arrangeOnPlate` (analysis/collision) does the packing and knows nothing
 * about the document; this is the half that translates between the two — it
 * measures each part's real footprint, then composes the chosen placement
 * onto the layer's own matrix.
 */

import * as THREE from "three";
import type { DesignDocument, DesignLayer } from "@/types/design";
import type { PrinterProfile } from "@/types/profiles";
import type { PrintablePart } from "../buildDocument";
import { arrangeOnPlate, convexHullXY } from "../analysis/collision";
import {
  matrix4ToTransform,
  snapTransformNoise,
  transformToMatrix4,
} from "../transform";

/** Gap left between neighbouring parts on the plate, in mm. */
export const PLATE_SPACING_MM = 5;

export interface PlateArrangeResult {
  /** The document's layers with the arranged ones moved. */
  layers: DesignLayer[];
  summaryHe: string;
  /** Parts that did not fit on the plate. */
  unplacedCount: number;
}

/**
 * Arrange every part on the plate, returning the updated layer list.
 * Returns null when there is nothing to arrange.
 */
export function arrangePartsOnPlate(
  document: DesignDocument,
  parts: readonly PrintablePart[],
  printer: PrinterProfile
): PlateArrangeResult | null {
  if (parts.length === 0) return null;

  const layerById = new Map(document.layers.map((l) => [l.id, l]));
  const items = parts.map((part) => {
    const layer = layerById.get(part.primaryLayerId);
    const currentX = (part.stats.bounds.min.x + part.stats.bounds.max.x) / 2;
    const currentY = (part.stats.bounds.min.y + part.stats.bounds.max.y) / 2;
    // The REAL footprint: convex hull of the world mesh's XY projection
    // (relative to the part centre) — a diagonal part stops costing its huge
    // axis-aligned box.
    const points: [number, number][] = [];
    const positions = part.worldMesh.positions;
    for (let i = 0; i < positions.length; i += 3) {
      points.push([positions[i] - currentX, positions[i + 1] - currentY]);
    }
    return {
      layerId: part.primaryLayerId,
      widthMm: part.stats.dimensionsMm.x,
      depthMm: part.stats.dimensionsMm.y,
      currentX,
      currentY,
      hull: convexHullXY(points),
      // Rotation composes into the layer transform, which is only sound for a
      // free-standing layer — parents and pivots change what a Z rotation
      // about the part centre means.
      allowRotation: !!layer && !layer.locked && !layer.parentId && !layer.pivot,
    };
  });

  const result = arrangeOnPlate(items, {
    plateWidthMm: printer.buildVolumeMm.x,
    plateDepthMm: printer.buildVolumeMm.y,
    spacingMm: PLATE_SPACING_MM,
  });

  const itemByLayer = new Map(items.map((item) => [item.layerId, item]));
  const placementByLayer = new Map(result.placements.map((p) => [p.layerId, p]));

  const layers = document.layers.map((layer) => {
    const placement = placementByLayer.get(layer.id);
    const item = itemByLayer.get(layer.id);
    if (!placement || !item) return layer;

    if (placement.rotationDeg !== 0) {
      // Rotate about the part's current centre, then move the centre to its
      // shelf position — composed on the layer's own matrix.
      const radians = (placement.rotationDeg * Math.PI) / 180;
      const pivotRotation = new THREE.Matrix4()
        .makeTranslation(item.currentX, item.currentY, 0)
        .multiply(new THREE.Matrix4().makeRotationZ(radians))
        .multiply(new THREE.Matrix4().makeTranslation(-item.currentX, -item.currentY, 0));
      const move = new THREE.Matrix4().makeTranslation(
        placement.x - item.currentX,
        placement.y - item.currentY,
        0
      );
      const next = move.multiply(pivotRotation).multiply(transformToMatrix4(layer.transform));
      return { ...layer, transform: snapTransformNoise(matrix4ToTransform(next)) } as DesignLayer;
    }

    // Placements are absolute plate positions; shift the layer transform by
    // the delta so any local offset baked into the mesh is preserved.
    return {
      ...layer,
      transform: {
        ...layer.transform,
        x: layer.transform.x + (placement.x - item.currentX),
        y: layer.transform.y + (placement.y - item.currentY),
      },
    } as DesignLayer;
  });

  return { layers, summaryHe: result.summaryHe, unplacedCount: result.unplaced.length };
}
