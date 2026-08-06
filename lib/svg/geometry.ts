/**
 * Sanitized SVG markup → closed 2D contours (mm, y-up, centred).
 *
 * Uses three.js SVGLoader to parse path data and resolve filled shapes with
 * their internal holes (letters, logo counters). Stroke-only paths are
 * converted along their outline as a best effort. The output winding follows
 * the NonZero convention consumed by the Manifold kernel.
 */

import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import type { Contour } from "@/lib/geometry/kernel";
import type { SvgQuality } from "@/types/design";

const QUALITY_DIVISIONS: Record<SvgQuality, number> = {
  draft: 4,
  standard: 10,
  fine: 24,
};

export interface SvgContoursResult {
  contours: Contour[];
  /** Bounds in the source (unscaled) coordinate space. */
  isEmpty: boolean;
  /** Hebrew warnings raised during conversion. */
  warnings: string[];
}

/**
 * Convert sanitized SVG text into contours scaled to the given target size
 * in mm, centred on the origin, y-up.
 */
export function svgToContours(
  svgText: string,
  targetWidthMm: number,
  targetHeightMm: number,
  quality: SvgQuality,
  flipH = false,
  flipV = false
): SvgContoursResult {
  const warnings: string[] = [];
  const divisions = QUALITY_DIVISIONS[quality];

  const loader = new SVGLoader();
  const data = loader.parse(svgText);

  const contours: Contour[] = [];
  let filledPaths = 0;
  let strokeOnlyPaths = 0;

  for (const path of data.paths) {
    const style = path.userData?.style as
      | { fill?: string; fillOpacity?: number; stroke?: string }
      | undefined;
    const hasFill = style?.fill !== undefined && style.fill !== "none";
    const hasStroke = style?.stroke !== undefined && style.stroke !== "none";

    if (hasFill || (!hasFill && !hasStroke)) {
      // Filled shape (or no explicit styling — SVG default fill is black).
      filledPaths++;
      let shapes: THREE.Shape[];
      try {
        shapes = SVGLoader.createShapes(path);
      } catch {
        warnings.push("חלק מהצורות בקובץ לא הומרו בהצלחה");
        continue;
      }
      for (const shape of shapes) {
        appendShapeContours(shape, divisions, contours);
      }
    } else if (hasStroke) {
      // Stroke-only: use the raw subpath outlines as filled contours
      // (best effort; already warned during sanitization).
      strokeOnlyPaths++;
      for (const subPath of path.subPaths) {
        const points = subPath.getPoints(divisions);
        const contour = dedupe(points.map((p): [number, number] => [p.x, p.y]));
        if (contour.length >= 3) contours.push(contour);
      }
    }
  }

  if (strokeOnlyPaths > 0 && filledPaths === 0) {
    warnings.push(
      "הקובץ מכיל רק צורות קו (stroke) — התוצאה מבוססת על קווי המתאר בלבד"
    );
  }

  if (contours.length === 0) {
    return { contours: [], isEmpty: true, warnings };
  }

  // SVG is y-down; mirror into y-up. Optional user flips compose here.
  // Each axis mirror reverses winding, so reverse point order per mirror.
  const mirrorX = flipH ? -1 : 1;
  const mirrorY = flipV ? 1 : -1; // base -1 converts y-down → y-up
  let flips = 0;
  if (mirrorX < 0) flips++;
  if (mirrorY < 0) flips++;
  let transformed = contours.map((contour) => {
    const mapped = contour.map(([x, y]): [number, number] => [x * mirrorX, y * mirrorY]);
    return flips % 2 === 1 ? mapped.reverse() : mapped;
  });

  // Scale to the requested physical size and centre on the origin.
  const bounds = contoursBounds(transformed);
  const srcW = bounds.maxX - bounds.minX;
  const srcH = bounds.maxY - bounds.minY;
  if (srcW <= 0 || srcH <= 0) {
    return { contours: [], isEmpty: true, warnings };
  }
  const scaleX = targetWidthMm / srcW;
  const scaleY = targetHeightMm / srcH;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  transformed = transformed.map((contour) =>
    contour.map(([x, y]): [number, number] => [(x - cx) * scaleX, (y - cy) * scaleY])
  );

  return { contours: transformed, isEmpty: false, warnings };
}

/** Append a THREE.Shape (outer contour + holes) with NonZero-safe winding. */
function appendShapeContours(
  shape: THREE.Shape,
  divisions: number,
  out: Contour[]
): void {
  const outer = dedupe(
    shape.getPoints(divisions).map((p): [number, number] => [p.x, p.y])
  );
  if (outer.length >= 3) {
    out.push(signedArea(outer) < 0 ? outer.reverse() : outer);
  }
  for (const hole of shape.holes) {
    const inner = dedupe(
      hole.getPoints(divisions).map((p): [number, number] => [p.x, p.y])
    );
    if (inner.length >= 3) {
      out.push(signedArea(inner) > 0 ? inner.reverse() : inner);
    }
  }
}

function dedupe(points: [number, number][]): Contour {
  const contour: Contour = [];
  for (const point of points) {
    const prev = contour[contour.length - 1];
    if (prev && Math.abs(prev[0] - point[0]) < 1e-7 && Math.abs(prev[1] - point[1]) < 1e-7) {
      continue;
    }
    contour.push(point);
  }
  if (contour.length > 1) {
    const first = contour[0];
    const last = contour[contour.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-7 && Math.abs(first[1] - last[1]) < 1e-7) {
      contour.pop();
    }
  }
  return contour;
}

function signedArea(contour: Contour): number {
  let area = 0;
  for (let i = 0; i < contour.length; i++) {
    const [x0, y0] = contour[i];
    const [x1, y1] = contour[(i + 1) % contour.length];
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

function contoursBounds(contours: Contour[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const contour of contours) {
    for (const [x, y] of contour) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, maxX, minY, maxY };
}
