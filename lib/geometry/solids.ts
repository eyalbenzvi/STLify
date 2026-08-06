/**
 * Per-layer solid builders: turn a DesignLayer into a closed solid in the
 * layer's LOCAL coordinate system. The document pipeline applies the layer's
 * Transform3D (and base anchoring) afterwards, so builders here never look
 * at layer.transform.
 *
 * Local conventions:
 * - Contour layers (text / SVG / image silhouette): centred on XY origin.
 *   • standalone: z ∈ [0, extrude]
 *   • raised:     z ∈ [-overlap, extrude]   (anchored to the base top)
 *   • engraved:   z ∈ [-extrude, +overlap]  (cuts down from the base top)
 * - Base layer: centred on XY, z ∈ [0, thickness].
 * - Hole layer: cylinder along local Z (through = long span, blind = cuts
 *   downward from the local origin).
 */

import type {
  BaseLayer,
  BevelSettings,
  DesignLayer,
  HoleLayer,
  ImageReliefLayer,
  StoredContour,
  SvgLayer,
  TextLayer,
} from "@/types/design";
import { loadFont } from "./fonts";
import type { Contour, GeometryKernel, Solid } from "./kernel";
import { getMesh } from "./meshStore";
import { sampleContour, textToContours } from "./text";
import * as THREE from "three";

/** Overlap used so unions/subtractions never meet on a coplanar face. */
export const BOOLEAN_OVERLAP_MM = 0.05;

/** Hebrew-labelled failure while building a single layer. */
export class LayerBuildError extends Error {
  constructor(
    readonly layerId: string,
    readonly messageHe: string
  ) {
    super(messageHe);
    this.name = "LayerBuildError";
  }
}

// ---------------------------------------------------------------------------
// Extrusion with optional bevel
// ---------------------------------------------------------------------------

/**
 * Extrude contours to `heightMm`, optionally chamfering the top edge by
 * stacking progressively inset slabs (real geometry, kernel-resolved).
 */
export function buildBevelledExtrusion(
  kernel: GeometryKernel,
  contours: Contour[],
  heightMm: number,
  bevel: BevelSettings
): Solid {
  if (!bevel.enabled || bevel.sizeMm <= 0) {
    return kernel.extrude(contours, heightMm);
  }
  // Keep at least 0.2mm of straight wall so the bevel never consumes the body.
  const bevelH = Math.min(bevel.sizeMm, Math.max(heightMm - 0.2, 0));
  if (bevelH <= 0) return kernel.extrude(contours, heightMm);

  const steps = Math.min(Math.max(bevel.segments, 2), 8);
  const bodyH = heightMm - bevelH;
  let solid = kernel.extrude(contours, bodyH);
  const slabH = bevelH / steps;
  // Each slab overlaps DOWNWARD into the previous one, so the stack tops
  // out exactly at heightMm.
  for (let i = 1; i <= steps; i++) {
    const inset = (bevelH * i) / steps;
    const insetContours = kernel.offsetContours(contours, -inset, "round");
    if (insetContours.length === 0) break; // shape vanished — stop the chamfer
    const slab = kernel
      .extrude(insetContours, slabH + BOOLEAN_OVERLAP_MM)
      .translate(0, 0, bodyH + (i - 1) * slabH - BOOLEAN_OVERLAP_MM);
    solid = solid.union(slab);
  }
  return solid;
}

// ---------------------------------------------------------------------------
// Layer contour extraction
// ---------------------------------------------------------------------------

export interface LayerContoursResult {
  contours: Contour[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  isEmpty: boolean;
}

function storedContoursResult(stored: StoredContour[]): LayerContoursResult {
  const contours: Contour[] = stored.map((c) => c.map(([x, y]): [number, number] => [x, y]));
  if (contours.length === 0) {
    return { contours: [], bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, isEmpty: true };
  }
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const contour of contours) {
    for (const [x, y] of contour) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { contours, bounds: { minX, maxX, minY, maxY }, isEmpty: false };
}

/** 2D outlines of a contour-based layer, in the layer's local mm space. */
export async function layerContours(
  layer: TextLayer | SvgLayer | ImageReliefLayer
): Promise<LayerContoursResult> {
  if (layer.type === "text") {
    if (layer.content.trim().length === 0) {
      return { contours: [], bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, isEmpty: true };
    }
    const font = await loadFont(layer.fontId, layer.bold);
    return textToContours(font, layer.content, {
      sizeMm: layer.sizeMm,
      align: layer.align,
      lineSpacing: layer.lineSpacing,
      letterSpacingMm: layer.letterSpacingMm,
      direction: layer.direction,
      curveRadiusMm: layer.curveRadiusMm,
      mirrored: layer.mirrored,
    });
  }
  return storedContoursResult(layer.contours);
}

// ---------------------------------------------------------------------------
// Per-layer solids
// ---------------------------------------------------------------------------

/** Base plate in local coordinates (centred XY, z ∈ [0, thickness]). */
export function buildBaseSolid(kernel: GeometryKernel, layer: BaseLayer): Solid {
  const outline = baseOutline(layer);
  let plate = kernel.extrude([outline], layer.thicknessMm);
  if (layer.rimEnabled && layer.rimWidthMm > 0 && layer.rimHeightMm > 0) {
    // Raised border: outline minus an inset outline, extruded on top.
    const inset = kernel.offsetContours([outline], -layer.rimWidthMm, "round");
    if (inset.length > 0) {
      const ringContours: Contour[] = [
        outline,
        ...inset.map((c) => [...c].reverse()),
      ];
      const ring = kernel
        .extrude(ringContours, layer.rimHeightMm + BOOLEAN_OVERLAP_MM)
        .translate(0, 0, layer.thicknessMm - BOOLEAN_OVERLAP_MM);
      plate = plate.union(ring);
    }
  }
  return plate;
}

export function baseOutline(layer: BaseLayer): Contour {
  if (layer.shape === "circle") {
    const radius = layer.widthMm / 2;
    const segments = 96;
    const contour: Contour = [];
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      contour.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
    return contour;
  }
  if (layer.shape === "roundedRectangle" && layer.cornerRadiusMm > 0) {
    return sampleContour(
      roundedRectPath(layer.widthMm, layer.heightMm, layer.cornerRadiusMm)
    );
  }
  const w = layer.widthMm / 2;
  const h = layer.heightMm / 2;
  return [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ];
}

/** Rounded rectangle outline centred at the origin, using circular arcs. */
function roundedRectPath(width: number, height: number, radius: number): THREE.Path {
  const w = width / 2;
  const h = height / 2;
  const r = Math.min(radius, w, h);
  const path = new THREE.Path();
  path.moveTo(-w + r, -h);
  path.lineTo(w - r, -h);
  path.absarc(w - r, -h + r, r, -Math.PI / 2, 0, false);
  path.lineTo(w, h - r);
  path.absarc(w - r, h - r, r, 0, Math.PI / 2, false);
  path.lineTo(-w + r, h);
  path.absarc(-w + r, h - r, r, Math.PI / 2, Math.PI, false);
  path.lineTo(-w, -h + r);
  path.absarc(-w + r, -h + r, r, Math.PI, Math.PI * 1.5, false);
  return path;
}

export type EffectiveCombine = "standalone" | "raised" | "engraved" | "inlay";

/**
 * Solid of a contour layer in local coordinates, positioned for its combine
 * mode (see module docs). Returns null when the layer has no visible shape.
 * Inlay bodies span z ∈ [-depth, 0] so their top sits flush with the base
 * top plane they are anchored to.
 */
export async function buildContourLayerSolid(
  kernel: GeometryKernel,
  layer: TextLayer | SvgLayer | ImageReliefLayer,
  effectiveCombine: EffectiveCombine
): Promise<Solid | null> {
  const result = await layerContours(layer);
  if (result.isEmpty) return null;
  const depth = layer.extrudeMm;
  if (depth <= 0) {
    throw new LayerBuildError(layer.id, "עובי האקסטרוזיה חייב להיות גדול מאפס");
  }

  if (effectiveCombine === "standalone") {
    return buildBevelledExtrusion(kernel, result.contours, depth, layer.bevel);
  }
  if (effectiveCombine === "raised") {
    const solid = buildBevelledExtrusion(
      kernel,
      result.contours,
      depth + BOOLEAN_OVERLAP_MM,
      layer.bevel
    );
    return solid.translate(0, 0, -BOOLEAN_OVERLAP_MM);
  }
  if (effectiveCombine === "inlay") {
    // Flush insert: top at the anchor plane (bevel n/a for flush inlays).
    return kernel.extrude(result.contours, depth).translate(0, 0, -depth);
  }
  // engraved: plain prism cutting down from the anchor plane (bevel n/a).
  const solid = kernel.extrude(result.contours, depth + BOOLEAN_OVERLAP_MM);
  return solid.translate(0, 0, -depth);
}

/**
 * Pocket cutter for an inlay layer: the layer's outline inflated by the
 * printing clearance, cutting down from the anchor plane. The pocket is
 * slightly deeper than the body so the inlay always seats fully.
 */
export async function buildInlayPocketCutter(
  kernel: GeometryKernel,
  layer: TextLayer | SvgLayer | ImageReliefLayer,
  clearanceMm: number
): Promise<Solid | null> {
  const result = await layerContours(layer);
  if (result.isEmpty) return null;
  const depth = layer.extrudeMm;
  const inflated =
    clearanceMm > 0
      ? kernel.offsetContours(result.contours, clearanceMm, "round")
      : result.contours;
  if (inflated.length === 0) return null;
  return kernel
    .extrude(inflated, depth + BOOLEAN_OVERLAP_MM)
    .translate(0, 0, -depth);
}

/** Relief solid stored in the mesh store (image relief in "relief" mode). */
export function buildStoredMeshSolid(
  kernel: GeometryKernel,
  meshId: string,
  layerId: string
): Solid {
  const mesh = getMesh(meshId);
  if (!mesh) {
    throw new LayerBuildError(layerId, "נתוני הרשת של השכבה חסרים בהפעלה הנוכחית");
  }
  const { solid, status } = kernel.fromMeshData(mesh);
  if (status !== "NoError") {
    solid.dispose();
    throw new LayerBuildError(layerId, "הרשת של השכבה אינה תקינה (לא אטומה)");
  }
  return solid;
}

/**
 * Cylinder cutter for a hole layer, in local coordinates. `spanMm` should
 * exceed the target body size so through-holes always pass fully through.
 */
export function buildHoleCutter(
  kernel: GeometryKernel,
  layer: HoleLayer,
  spanMm: number
): Solid {
  const radius = layer.diameterMm / 2;
  if (layer.depthMode === "through") {
    return kernel.cylinder(radius, spanMm * 2).translate(0, 0, -spanMm);
  }
  return kernel
    .cylinder(radius, layer.depthMm + BOOLEAN_OVERLAP_MM)
    .translate(0, 0, -layer.depthMm);
}

/**
 * Build the local-space solid for any shape layer.
 * `effectiveCombine` already accounts for the document's base mode.
 */
export async function buildShapeLayerSolid(
  kernel: GeometryKernel,
  layer: Exclude<DesignLayer, HoleLayer>,
  effectiveCombine: EffectiveCombine
): Promise<Solid | null> {
  switch (layer.type) {
    case "base":
      return buildBaseSolid(kernel, layer);
    case "text":
    case "svg":
      return buildContourLayerSolid(kernel, layer, effectiveCombine);
    case "imageRelief":
      if (layer.mode === "silhouette") {
        return buildContourLayerSolid(kernel, layer, effectiveCombine);
      }
      if (!layer.meshId) return null;
      return buildStoredMeshSolid(kernel, layer.meshId, layer.id);
    case "importedMesh":
      return buildStoredMeshSolid(kernel, layer.meshId, layer.id);
  }
}
