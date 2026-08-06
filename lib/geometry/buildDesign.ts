/**
 * V2 build pipeline: DesignState → printable per-part solids.
 *
 * Every visible layer becomes real solid geometry through the Manifold
 * kernel: engraved layers and holes are SUBTRACTED from the base, raised
 * layers become their own parts (unioned into the base at single-STL export
 * time), inlay layers get a clearance pocket cut into the base and sit flush
 * inside it. Nothing is ever exported as merely-overlapping visual meshes.
 *
 * The same pipeline serves the live preview (separate parts → per-layer
 * colours and click-selection) and export (parts are unioned per colour
 * slot or all together).
 */

import * as THREE from "three";
import type {
  BaseLayer,
  DesignIssue,
  DesignState,
  HoleLayer,
  ImageReliefLayer,
  ModelMeshReport,
  SvgLayer,
  TextLayer,
} from "@/types/design";
import { effectiveLimits } from "@/lib/design/defaults";
import { loadFontById, findUnsupportedChars } from "@/lib/fonts/library";
import { svgToContours } from "@/lib/svg/geometry";
import { buildHeightField, estimateTriangleCount } from "@/lib/images/heightField";
import type { RawImage } from "@/lib/images/raster";
import { applyAdjustments } from "@/lib/images/raster";
import { heightmapToMeshArrays } from "./heightmapSolid";
import { contoursToMm, maskToContours } from "./marchingSquares";
import { getGeometryKernel, type Contour, type GeometryKernel, type Solid } from "./kernel";
import { sampleContour, textToContours } from "./text";
import { validateDesignState } from "./validateDesign";

/** Height by which solids overlap the base to guarantee clean booleans. */
const OVERLAP_MM = 0.05;

export interface BuiltPart {
  /** "base" or the source layer id. */
  key: string;
  layerId: string;
  name: string;
  colorHex: string;
  colorSlot: number;
  kind: "base" | "raised" | "inlay";
  geometry: THREE.BufferGeometry;
  triangleCount: number;
  volumeMm3: number;
}

export interface BuildDesignResult {
  status: "ok" | "invalid" | "error";
  parts: BuiltPart[];
  issues: DesignIssue[];
  mesh: ModelMeshReport | null;
}

/** Resolves an asset id to its RawImage with any mask already applied. */
export type AssetResolver = (assetId: string) => Promise<RawImage | null>;

export interface BuildOptions {
  assetResolver: AssetResolver;
}

export interface PartSolid {
  key: string;
  layerId: string;
  name: string;
  colorHex: string;
  colorSlot: number;
  kind: "base" | "raised" | "inlay";
  solid: Solid;
}

/**
 * Build the raw per-part solids (caller owns disposal). Used by the export
 * pipeline to union parts per colour slot or all together.
 */
export async function buildPartSolids(
  state: DesignState,
  options: BuildOptions
): Promise<{ parts: PartSolid[]; issues: DesignIssue[] }> {
  const issues = validateDesignState(state);
  if (issues.some((i) => i.severity === "error")) {
    return { parts: [], issues };
  }
  const kernel = await getGeometryKernel();
  const parts = await buildSolids(state, kernel, options, issues);
  return { parts, issues };
}

/** Build all printable parts for the design. */
export async function buildDesignParts(
  state: DesignState,
  options: BuildOptions
): Promise<BuildDesignResult> {
  const issues = validateDesignState(state);
  if (issues.some((i) => i.severity === "error")) {
    return { status: "invalid", parts: [], issues, mesh: null };
  }

  const partSolids: PartSolid[] = [];
  try {
    const kernel = await getGeometryKernel();
    const built = await buildSolids(state, kernel, options, issues);
    partSolids.push(...built);

    const parts: BuiltPart[] = [];
    let totalVolume = 0;
    let totalTris = 0;
    let componentCount = 0;
    const bbox = new THREE.Box3();

    for (const part of partSolids) {
      const geometry = part.solid.toGeometry();
      const volume = part.solid.volume();
      const tris = part.solid.triangleCount();
      componentCount += part.solid.componentCount();
      totalVolume += volume;
      totalTris += tris;
      geometry.computeBoundingBox();
      if (geometry.boundingBox) bbox.union(geometry.boundingBox);
      parts.push({
        key: part.key,
        layerId: part.layerId,
        name: part.name,
        colorHex: part.colorHex,
        colorSlot: part.colorSlot,
        kind: part.kind,
        geometry,
        triangleCount: tris,
        volumeMm3: volume,
      });
    }

    const size = new THREE.Vector3();
    bbox.getSize(size);
    const limits = effectiveLimits(state.settings);
    if (totalTris > limits.maxTriangleCount) {
      issues.push({
        code: "mesh/high-triangles",
        severity: "warning",
        message: `מספר המשולשים גבוה מאוד (${totalTris.toLocaleString()}) — קובץ ה-STL יהיה כבד והדפדפן עלול להאט`,
        recommendation: "הקטינו את רזולוציית התמונות או את איכות העקומות",
      });
    }

    const mesh: ModelMeshReport = {
      triangleCount: totalTris,
      dimensionsMm: { x: round2(size.x), y: round2(size.y), z: round2(size.z) },
      volumeCm3: totalVolume / 1000,
      // Kernel invariant: every Manifold result is watertight and manifold.
      watertight: true,
      openEdgeCount: 0,
      nonManifoldEdgeCount: 0,
      degenerateTriangleCount: 0,
      duplicateVertexCount: 0,
      connectedComponents: componentCount,
      partCount: parts.length,
    };

    return { status: "ok", parts, issues, mesh };
  } catch (err) {
    issues.push({
      code: "mesh/build-failed",
      severity: "error",
      message: `יצירת המודל נכשלה: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { status: "error", parts: [], issues, mesh: null };
  } finally {
    for (const part of partSolids) part.solid.dispose();
  }
}

// ---------------------------------------------------------------------------
// Solid construction
// ---------------------------------------------------------------------------

async function buildSolids(
  state: DesignState,
  kernel: GeometryKernel,
  options: BuildOptions,
  issues: DesignIssue[]
): Promise<PartSolid[]> {
  const doc = state.doc;
  const base = doc.layers[0] as BaseLayer;
  const multiColor = state.settings.multiColor;
  const inlayClearance = multiColor.inlayClearanceMm;

  const baseContours = baseOutline(base);
  let baseSolid = kernel.extrude(baseContours, base.thicknessMm);

  if (base.rim.enabled) {
    const rim = kernel
      .ring(baseContours, base.rim.heightMm + OVERLAP_MM, base.rim.widthMm)
      .translate(0, 0, base.thicknessMm - OVERLAP_MM);
    baseSolid = baseSolid.union(rim);
  }

  const raisedParts: PartSolid[] = [];
  const baseTop = base.thicknessMm;

  for (const layer of doc.layers.slice(1)) {
    if (!layer.visible) continue;

    switch (layer.type) {
      case "hole": {
        const cutter = holeCutter(kernel, layer, base);
        if (cutter) baseSolid = baseSolid.subtract(cutter);
        break;
      }
      case "text":
      case "svg": {
        const contours =
          layer.type === "text"
            ? await textLayerContours(layer, issues)
            : svgLayerContours(layer, issues);
        if (!contours || contours.length === 0) break;

        if (layer.mode === "engraved") {
          const cutter = placeReliefSolid(
            kernel.extrude(contours, layer.depthMm + OVERLAP_MM * 2),
            layer.transform,
            baseTop - layer.depthMm
          );
          baseSolid = baseSolid.subtract(cutter);
        } else if (layer.mode === "inlay") {
          const pocketContours = kernel.offsetContours(contours, inlayClearance);
          if (pocketContours.length > 0) {
            const pocket = placeReliefSolid(
              kernel.extrude(pocketContours, layer.depthMm + OVERLAP_MM),
              layer.transform,
              baseTop - layer.depthMm
            );
            baseSolid = baseSolid.subtract(pocket);
          }
          const partSolid = placeReliefSolid(
            kernel.extrude(contours, layer.depthMm),
            layer.transform,
            baseTop - layer.depthMm
          );
          raisedParts.push(partFromLayer(layer, partSolid, "inlay"));
        } else {
          const partSolid = placeReliefSolid(
            kernel.extrude(contours, layer.depthMm + OVERLAP_MM),
            layer.transform,
            baseTop - OVERLAP_MM
          );
          raisedParts.push(partFromLayer(layer, partSolid, "raised"));
        }
        break;
      }
      case "imageRelief": {
        const solid = await imageReliefSolid(kernel, layer, baseTop, options, issues);
        if (!solid) break;
        if (layer.mode === "engraved") {
          baseSolid = baseSolid.subtract(solid);
        } else {
          raisedParts.push(partFromLayer(layer, solid, "raised"));
        }
        break;
      }
      default:
        break;
    }
  }

  if (baseSolid.isEmpty()) {
    baseSolid.dispose();
    for (const part of raisedParts) part.solid.dispose();
    throw new Error("שכבת הבסיס התרוקנה — בדקו חורים וחריטות");
  }

  // Floating / connectivity check: every raised part should touch the base.
  for (const part of raisedParts) {
    const probe = part.solid.clone().intersect(baseSolid.clone());
    const touches = !probe.isEmpty() && probe.volume() > 1e-6;
    probe.dispose();
    if (!touches) {
      issues.push({
        code: "layer/floating",
        severity: "warning",
        layerId: part.layerId,
        message: `השכבה "${part.name}" אינה מחוברת לבסיס — היא תודפס כחלק מרחף`,
        recommendation: "הזיזו את השכבה כך שתיגע בבסיס או בטלו את הזזת ה-Z שלה",
      });
    }
  }

  // Overlap check between separate raised parts (invalid multi-colour joins).
  if (raisedParts.length >= 2 && raisedParts.length <= 8) {
    for (let i = 0; i < raisedParts.length; i++) {
      for (let j = i + 1; j < raisedParts.length; j++) {
        const a = raisedParts[i];
        const b = raisedParts[j];
        const probe = a.solid.clone().intersect(b.solid.clone());
        const overlap = !probe.isEmpty() && probe.volume() > 0.5;
        probe.dispose();
        if (overlap && a.colorSlot !== b.colorSlot) {
          issues.push({
            code: "layer/overlap",
            severity: "warning",
            layerId: b.layerId,
            message: `השכבות "${a.name}" ו-"${b.name}" חופפות אך משויכות לצבעים שונים — בהדפסה רב-צבעית הן יתנגשו`,
            recommendation: "הזיזו אחת מהשכבות או שייכו אותן לאותו צבע",
          });
        }
      }
    }
  }

  const baseLayerData = base;
  return [
    {
      key: "base",
      layerId: baseLayerData.id,
      name: baseLayerData.name,
      colorHex: baseLayerData.colorHex,
      colorSlot: baseLayerData.colorSlot,
      kind: "base",
      solid: baseSolid,
    },
    ...raisedParts,
  ];
}

function partFromLayer(
  layer: TextLayer | SvgLayer | ImageReliefLayer,
  solid: Solid,
  kind: "raised" | "inlay"
): PartSolid {
  return {
    key: layer.id,
    layerId: layer.id,
    name: layer.name,
    colorHex: layer.colorHex,
    colorSlot: layer.colorSlot,
    kind,
    solid,
  };
}

/** Apply scale → rotation → translation, with z placed at zBase + t.z. */
function placeReliefSolid(solid: Solid, t: TextLayer["transform"], zBase: number): Solid {
  return solid
    .scale(t.scaleX, t.scaleY, t.scaleZ)
    .rotate(t.rotationX, t.rotationY, t.rotationZ)
    .translate(t.x, t.y, zBase + t.z);
}

/** Base plate outline centred at the origin. */
function baseOutline(base: BaseLayer): Contour[] {
  if (base.shape === "circle") {
    const r = base.widthMm / 2;
    const segments = 96;
    const contour: Contour = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      contour.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return [contour];
  }
  if (base.shape === "roundedRectangle" && base.cornerRadiusMm > 0) {
    return [sampleContour(roundedRectPath(base.widthMm, base.heightMm, base.cornerRadiusMm))];
  }
  const w = base.widthMm / 2;
  const h = base.heightMm / 2;
  return [
    [
      [-w, -h],
      [w, -h],
      [w, h],
      [-w, h],
    ],
  ];
}

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

async function textLayerContours(
  layer: TextLayer,
  issues: DesignIssue[]
): Promise<Contour[] | null> {
  if (layer.content.trim().length === 0) return null;
  const font = await loadFontById(layer.fontId, layer.bold);
  const missing = findUnsupportedChars(font, layer.content);
  if (missing.length > 0) {
    issues.push({
      code: "text/unsupported-glyphs",
      severity: "warning",
      layerId: layer.id,
      message: `הגופן שנבחר אינו כולל את התווים: ${missing.slice(0, 8).join(" ")}${missing.length > 8 ? "…" : ""}`,
      recommendation: "בחרו גופן אחר או הסירו את התווים",
    });
  }
  const result = textToContours(font, layer.content, {
    sizeMm: layer.sizeMm,
    align: layer.align,
    lineSpacing: layer.lineSpacing,
    letterSpacingMm: layer.letterSpacingMm,
    direction: layer.direction,
    curveRadiusMm: layer.curveRadiusMm,
    mirrored: layer.mirrored,
  });
  return result.isEmpty ? null : result.contours;
}

function svgLayerContours(layer: SvgLayer, issues: DesignIssue[]): Contour[] | null {
  if (!layer.svgText.trim()) return null;
  const result = svgToContours(
    layer.svgText,
    layer.targetWidthMm,
    layer.targetHeightMm,
    layer.quality,
    layer.flipH,
    layer.flipV
  );
  for (const warning of result.warnings) {
    issues.push({
      code: "svg/conversion",
      severity: "warning",
      layerId: layer.id,
      message: warning,
    });
  }
  if (result.isEmpty) {
    issues.push({
      code: "svg/no-geometry",
      severity: "warning",
      layerId: layer.id,
      message: `לא נמצאו צורות הניתנות להמרה ב-"${layer.name}"`,
      recommendation: "ודאו שהקובץ מכיל צורות עם מילוי (fill)",
    });
    return null;
  }
  return result.contours;
}

function holeCutter(kernel: GeometryKernel, layer: HoleLayer, base: BaseLayer): Solid | null {
  const t = layer.transform;
  let solid: Solid;
  // Through-holes must clear the base plus any rim / raised feature height.
  const cutHeight = layer.through
    ? base.thicknessMm + 60 + OVERLAP_MM * 2
    : layer.depthMm + OVERLAP_MM;

  if (layer.shape === "circle") {
    solid = kernel.cylinder((layer.diameterMm / 2) * Math.max(t.scaleX, 0.05), cutHeight);
  } else {
    const contour = sampleContour(
      roundedRectPath(layer.widthMm, layer.heightMm, layer.cornerRadiusMm)
    );
    solid = kernel.extrude([contour], cutHeight).scale(t.scaleX, t.scaleY, 1);
  }

  let z: number;
  if (layer.through) {
    z = -30 - OVERLAP_MM;
  } else if (layer.fromBottom) {
    z = -OVERLAP_MM;
  } else {
    z = base.thicknessMm - layer.depthMm;
  }
  return solid.rotate(0, 0, t.rotationZ).translate(t.x, t.y, z);
}

async function imageReliefSolid(
  kernel: GeometryKernel,
  layer: ImageReliefLayer,
  baseTop: number,
  options: BuildOptions,
  issues: DesignIssue[]
): Promise<Solid | null> {
  const raw = await options.assetResolver(layer.assetId);
  if (!raw) {
    issues.push({
      code: "image/asset-missing",
      severity: "warning",
      layerId: layer.id,
      message: `קובץ המקור של "${layer.name}" אינו זמין בהפעלה הנוכחית`,
      recommendation: "העלו את התמונה מחדש",
    });
    return null;
  }

  const estTris = estimateTriangleCount(layer);
  if (estTris > 400_000) {
    issues.push({
      code: "image/high-detail",
      severity: "warning",
      layerId: layer.id,
      message: `רזולוציית התבליט של "${layer.name}" גבוהה מאוד (כ-${Math.round(estTris / 1000)} אלף משולשים)`,
      recommendation: "בחרו רזולוציה נמוכה יותר",
    });
  }

  const processed = applyAdjustments(raw, layer.adjustments);
  const engraved = layer.mode === "engraved";

  const field = buildHeightField(processed, layer);
  if (field.coverageFraction === 0) {
    issues.push({
      code: "image/fully-masked",
      severity: "warning",
      layerId: layer.id,
      message: `כל הפיקסלים של "${layer.name}" שקופים — אין גאומטריה ליצירה`,
    });
    return null;
  }

  // Engraved reliefs are cut downward from the base top: build the slab with
  // vertically flipped rows, rotate it upside down (which un-flips the rows)
  // and hang it from z = baseTop + overlap.
  const heights = new Float32Array(field.heights);
  if (engraved) {
    for (let r = 0; r < field.rows; r++) {
      for (let c = 0; c < field.cols; c++) {
        heights[r * field.cols + c] =
          field.heights[(field.rows - 1 - r) * field.cols + c] + OVERLAP_MM;
      }
    }
  }

  const meshArrays = heightmapToMeshArrays({
    cols: field.cols,
    rows: field.rows,
    widthMm: layer.widthMm,
    heightMm: layer.heightMm,
    heights,
  });

  let solid: Solid;
  try {
    solid = kernel.fromMeshArrays(meshArrays);
  } catch {
    issues.push({
      code: "image/mesh-failed",
      severity: "warning",
      layerId: layer.id,
      message: `יצירת התבליט של "${layer.name}" נכשלה`,
      recommendation: "נסו רזולוציה אחרת או התאמות תמונה שונות",
    });
    return null;
  }

  // Clip away masked (transparent) cells using the coverage contours.
  if (field.hasMask) {
    const coverage = engraved ? flipRows(field.coverage, field.cols, field.rows) : field.coverage;
    const maskContours = contoursToMm(
      maskToContours({ width: field.cols, height: field.rows, inside: coverage }),
      field.cols,
      field.rows,
      layer.widthMm,
      layer.heightMm
    );
    if (maskContours.length === 0) {
      solid.dispose();
      return null;
    }
    const maxH = Math.max(layer.maxHeightMm, layer.minHeightMm) + OVERLAP_MM * 4 + 1;
    const clip = kernel.extrude(maskContours, maxH);
    solid = solid.intersect(clip);
    if (solid.isEmpty()) {
      solid.dispose();
      issues.push({
        code: "image/empty-after-mask",
        severity: "warning",
        layerId: layer.id,
        message: `לאחר הסרת הרקע לא נשארה גאומטריה ב-"${layer.name}"`,
      });
      return null;
    }
  }

  const t = layer.transform;
  if (engraved) {
    // Upside down: after rotateX(180) the flat face lies at z = 0 (top) and
    // the relief hangs below it. Hoist the flat face above the base top so
    // the cut opens through the top surface.
    return solid
      .rotate(180, 0, 0)
      .scale(t.scaleX, t.scaleY, t.scaleZ)
      .rotate(0, 0, t.rotationZ)
      .translate(t.x, t.y, baseTop + OVERLAP_MM + t.z);
  }
  return solid
    .scale(t.scaleX, t.scaleY, t.scaleZ)
    .rotate(t.rotationX, t.rotationY, t.rotationZ)
    .translate(t.x, t.y, baseTop - OVERLAP_MM + t.z);
}

function flipRows(data: Uint8Array, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let r = 0; r < rows; r++) {
    out.set(data.subarray((rows - 1 - r) * cols, (rows - r) * cols), r * cols);
  }
  return out;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
