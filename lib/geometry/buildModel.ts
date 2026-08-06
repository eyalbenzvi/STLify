/**
 * The main geometry pipeline: DesignParams -> watertight solid mesh.
 *
 * Pipeline stages:
 *   1. Validate parameters (pure, see validation.ts).
 *   2. Build the base plate outline and extrude it along +Z (kernel).
 *   3. Subtract the keychain hole cylinder when enabled.
 *   4. Convert text to outlines (opentype.js) and extrude to a prism.
 *   5. Union (raised) or subtract (engraved) the text prism.
 *   6. Verify watertightness, centre on XY and rest on Z=0.
 *
 * All booleans run through the Manifold-based geometry kernel (kernel.ts),
 * which guarantees manifold output. The watertight check remains as a
 * defence-in-depth gate: nothing non-manifold is ever exported.
 *
 * Everything is in millimetres, Z-up (the STL convention).
 */

import * as THREE from "three";
import { loadFont } from "./fonts";
import { getGeometryKernel, type Contour, type Solid } from "./kernel";
import { computeMeshStats, normalizePlacement } from "./meshStats";
import { sampleContour, textToContours } from "./text";
import type { DesignParams, MeshStats, ValidationIssue } from "./types";
import { hasVisibleText, validateDesignParams } from "./validation";

/** Height by which text prisms overlap the base to guarantee clean booleans. */
const BOOLEAN_OVERLAP_MM = 0.05;

export interface BuildResult {
  status: "ok" | "invalid" | "error";
  geometry: THREE.BufferGeometry | null;
  stats: MeshStats | null;
  issues: ValidationIssue[];
}

/**
 * Build a printable solid from design parameters.
 * Returns status "invalid" for blocking validation errors, "error" for
 * unexpected pipeline failures, and "ok" with geometry + stats otherwise.
 */
export async function buildModel(params: DesignParams): Promise<BuildResult> {
  const validation = validateDesignParams(params);
  const issues = [...validation.issues];
  if (!validation.ok) {
    return { status: "invalid", geometry: null, stats: null, issues };
  }

  let solid: Solid | null = null;
  try {
    const kernel = await getGeometryKernel();
    const { base, hole, text } = params;

    // 1. Base plate.
    solid = kernel.extrude([baseContour(params)], base.thicknessMm);

    // 2. Keychain hole (through-hole along Z).
    if (hole.enabled) {
      const { x, y } = holeCenter(params);
      const cutter = kernel
        .cylinder(hole.diameterMm / 2, base.thicknessMm + 2)
        .translate(x, y, -1);
      solid = solid.subtract(cutter);
    }

    // 3. Text relief.
    if (hasVisibleText(text.content)) {
      const font = await loadFont(text.fontId, text.bold);
      const result = textToContours(font, text.content, {
        sizeMm: text.sizeMm,
        align: text.align,
        lineSpacing: text.lineSpacing,
      });
      if (!result.isEmpty) {
        checkTextOverflow(params, result.bounds, issues);
        const depth = text.depthMm + BOOLEAN_OVERLAP_MM;
        // Raised: sits on the top face, overlapping into the base.
        // Engraved: sinks into the base, protruding above the top face.
        const z =
          text.mode === "raised"
            ? base.thicknessMm - BOOLEAN_OVERLAP_MM
            : base.thicknessMm - text.depthMm;
        const prism = kernel
          .extrude(result.contours, depth)
          .translate(text.offsetXMm, text.offsetYMm, z);
        solid =
          text.mode === "raised" ? solid.union(prism) : solid.subtract(prism);
      }
    }

    if (solid.isEmpty()) {
      issues.push({
        code: "mesh/empty",
        severity: "error",
        message: "התוצאה ריקה — בדקו את הפרמטרים",
      });
      return { status: "error", geometry: null, stats: null, issues };
    }

    const geometry = solid.toGeometry();
    normalizePlacement(geometry);

    const stats = computeMeshStats(geometry);
    if (!stats.watertight) {
      // Should not happen with the Manifold kernel; kept as a hard gate so
      // broken geometry is never exported silently.
      issues.push({
        code: "mesh/not-watertight",
        severity: "error",
        message:
          "פעולת הגאומטריה יצרה מודל שאינו אטום. נסו לשנות מעט את הפרמטרים (גודל טקסט, מיקום או עומק)",
      });
      geometry.dispose();
      return { status: "error", geometry: null, stats, issues };
    }

    return { status: "ok", geometry, stats, issues };
  } catch (err) {
    issues.push({
      code: "mesh/build-failed",
      severity: "error",
      message: `יצירת המודל נכשלה: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { status: "error", geometry: null, stats: null, issues };
  } finally {
    solid?.dispose();
  }
}

/** Outline of the base plate, centred at the origin. */
function baseContour(params: DesignParams): Contour {
  const { base } = params;
  if (base.shape === "roundedRectangle" && base.cornerRadiusMm > 0) {
    return sampleContour(
      roundedRectPath(base.widthMm, base.heightMm, base.cornerRadiusMm)
    );
  }
  const w = base.widthMm / 2;
  const h = base.heightMm / 2;
  return [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ];
}

/** Rounded rectangle outline centred at the origin, using circular arcs. */
function roundedRectPath(
  width: number,
  height: number,
  radius: number
): THREE.Path {
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

/** Centre of the keychain hole, in plate coordinates. */
function holeCenter(params: DesignParams): { x: number; y: number } {
  const { base, hole } = params;
  switch (hole.position) {
    case "right":
      return { x: base.widthMm / 2 - hole.edgeMarginMm, y: 0 };
    case "left":
      return { x: -(base.widthMm / 2 - hole.edgeMarginMm), y: 0 };
    case "top":
      return { x: 0, y: base.heightMm / 2 - hole.edgeMarginMm };
  }
}

/** Warn when the text block sticks out of the base plate. */
function checkTextOverflow(
  params: DesignParams,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  issues: ValidationIssue[]
): void {
  const { base, text } = params;
  const overflowX =
    Math.max(
      Math.abs(bounds.minX + text.offsetXMm),
      Math.abs(bounds.maxX + text.offsetXMm)
    ) > base.widthMm / 2;
  const overflowY =
    Math.max(
      Math.abs(bounds.minY + text.offsetYMm),
      Math.abs(bounds.maxY + text.offsetYMm)
    ) > base.heightMm / 2;
  if (overflowX || overflowY) {
    issues.push({
      code: "text/overflow",
      severity: "warning",
      message: "הטקסט חורג מגבולות הבסיס — הקטינו את הגודל או הזיזו אותו",
    });
  }
}
