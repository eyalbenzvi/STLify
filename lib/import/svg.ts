/**
 * SVG import: vector artwork → closed 2D contours in mm, ready for
 * extrusion by the geometry kernel.
 *
 * Parsing is delegated to three.js SVGLoader (paths, basic shapes, groups,
 * transforms); SVGLoader.createShapes resolves fill rules so holes come out
 * as separate sub-contours. Winding is normalized here (outer CCW, holes
 * CW) to match the kernel's NonZero convention, the Y axis is flipped from
 * SVG's y-down to the model's y-up, and the result is uniformly scaled to
 * the requested width and centred on the origin.
 */

import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import type { StoredContour } from "@/types/design";

export class SvgImportError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "SvgImportError";
  }
}

export interface SvgImportOptions {
  targetWidthMm: number;
  /** Points per curve segment (default 8). */
  curveSegments?: number;
}

export interface SvgImportResult {
  contours: StoredContour[];
  widthMm: number;
  heightMm: number;
  warningsHe: string[];
}

const MAX_SVG_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_POINTS = 200_000;

function signedArea(points: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function toContour(
  points: { x: number; y: number }[],
  wantCcw: boolean
): StoredContour | null {
  // Drop consecutive duplicates and an explicit closing point.
  const cleaned: [number, number][] = [];
  for (const p of points) {
    const prev = cleaned[cleaned.length - 1];
    if (prev && Math.abs(prev[0] - p.x) < 1e-9 && Math.abs(prev[1] - p.y) < 1e-9) continue;
    cleaned.push([p.x, p.y]);
  }
  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) {
      cleaned.pop();
    }
  }
  if (cleaned.length < 3) return null;
  const ccw = signedArea(cleaned.map(([x, y]) => ({ x, y }))) > 0;
  if (ccw !== wantCcw) cleaned.reverse();
  return cleaned;
}

/** Parse SVG text into scaled, centred contours. */
export function parseSvgToContours(
  svgText: string,
  options: SvgImportOptions
): SvgImportResult {
  if (svgText.length > MAX_SVG_BYTES) {
    throw new SvgImportError("קובץ ה-SVG גדול מדי (מקסימום 5MB)");
  }
  if (options.targetWidthMm <= 0) {
    throw new SvgImportError("רוחב היעד חייב להיות גדול מאפס");
  }

  const warningsHe: string[] = [];
  let curveSegments = Math.max(2, Math.min(options.curveSegments ?? 8, 24));

  const extract = (segments: number): StoredContour[] => {
    const parsed = new SVGLoader().parse(svgText);
    const contours: StoredContour[] = [];
    let strokeOnlySkipped = false;
    for (const path of parsed.paths) {
      const style = path.userData?.style as { fill?: string } | undefined;
      if (style && (style.fill === "none" || style.fill === "")) {
        strokeOnlySkipped = true;
        continue;
      }
      const shapes = SVGLoader.createShapes(path);
      for (const shape of shapes) {
        const outer = toContour(shape.getPoints(segments), true);
        if (outer) contours.push(outer);
        for (const hole of shape.holes) {
          const inner = toContour(hole.getPoints(segments), false);
          if (inner) contours.push(inner);
        }
      }
    }
    if (strokeOnlySkipped && contours.length > 0) {
      warningsHe.push("נתיבים עם קו מתאר בלבד (stroke) לא נתמכים ודולגו");
    }
    return contours;
  };

  let contours = extract(curveSegments);
  let totalPoints = contours.reduce((sum, c) => sum + c.length, 0);
  if (totalPoints > MAX_TOTAL_POINTS) {
    curveSegments = Math.max(2, Math.floor(curveSegments / 2));
    contours = extract(curveSegments);
    totalPoints = contours.reduce((sum, c) => sum + c.length, 0);
    warningsHe.push("קובץ ה-SVG מפורט מאוד — רמת הפירוט הופחתה אוטומטית");
    if (totalPoints > MAX_TOTAL_POINTS) {
      throw new SvgImportError("קובץ ה-SVG מורכב מדי לעיבוד בדפדפן");
    }
  }

  if (contours.length === 0) {
    throw new SvgImportError("קובץ ה-SVG אינו מכיל צורות ממולאות שניתן להמיר");
  }

  // Bounds in SVG space.
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
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < 1e-6 || height < 1e-6) {
    throw new SvgImportError("צורות ה-SVG מנוונות (רוחב או גובה אפס)");
  }

  const scale = options.targetWidthMm / width;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  // Scale, centre, and flip Y (SVG y-down → model y-up). The Y flip
  // reverses winding, so flip point order to restore the convention.
  const result: StoredContour[] = contours.map((contour) => {
    const mapped: StoredContour = contour.map(([x, y]): [number, number] => [
      (x - cx) * scale,
      -(y - cy) * scale,
    ]);
    mapped.reverse();
    return mapped;
  });

  return {
    contours: result,
    widthMm: width * scale,
    heightMm: height * scale,
    warningsHe,
  };
}
