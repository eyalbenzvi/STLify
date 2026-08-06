/**
 * Text-to-contour conversion: turns a text block into closed 2D outlines
 * (in mm, XY plane, Y up) using an opentype.js font. The contours are fed
 * to the geometry kernel, whose NonZero fill rule resolves glyph holes and
 * overlapping outlines robustly.
 */

import * as THREE from "three";
import type { Font, PathCommand } from "opentype.js";
import { toVisualOrder } from "./bidi";
import type { Contour } from "./kernel";
import type { TextAlign } from "./types";

/** Curve tessellation quality (points per curve segment). */
const CURVE_SEGMENTS = 8;

export interface TextLayoutOptions {
  /** Font em size in mm. */
  sizeMm: number;
  align: TextAlign;
  /** Line spacing multiplier (1 = font default line height). */
  lineSpacing: number;
}

export interface TextContoursResult {
  contours: Contour[];
  /** Tight bounding box of the produced outlines, in mm. */
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  isEmpty: boolean;
}

const EMPTY_RESULT: TextContoursResult = {
  contours: [],
  bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  isEmpty: true,
};

/**
 * Convert a (possibly multi-line) text block into closed contours.
 * The result is centred so that (0, 0) is the centre of the text bounding box.
 */
export function textToContours(
  font: Font,
  content: string,
  options: TextLayoutOptions
): TextContoursResult {
  const { sizeMm, align, lineSpacing } = options;
  const lines = content.split("\n").map((line) => line.trimEnd());
  const scale = sizeMm / font.unitsPerEm;
  const lineHeight = (font.ascender - font.descender) * scale * lineSpacing;

  const shapePath = new THREE.ShapePath();

  const lineWidths = lines.map((line) =>
    line ? measureLine(font, toVisualOrder(line), sizeMm) : 0
  );
  const blockWidth = Math.max(...lineWidths, 0);

  lines.forEach((line, index) => {
    if (!line) return;
    const visual = toVisualOrder(line);
    const width = lineWidths[index];

    // Alignment offsets within the block (align is visual, not logical).
    let x0 = 0;
    if (align === "center") x0 = (blockWidth - width) / 2;
    else if (align === "right") x0 = blockWidth - width;

    // Glyph paths are in y-down (canvas) coordinates; we negate y in
    // addCommandsToPath to get the y-up modelling convention, so line 0 is
    // at y=0 and following lines go down in negative y.
    const baselineY = -index * lineHeight;
    layoutLine(font, visual, x0, sizeMm, (commands) =>
      addCommandsToPath(shapePath, commands, baselineY)
    );
  });

  const contours = shapePath.subPaths
    .map((subPath) => sampleContour(subPath))
    .filter((contour) => contour.length >= 3);

  if (contours.length === 0) return EMPTY_RESULT;

  // Centre the text block around the origin.
  const bounds = contoursBounds(contours);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  for (const contour of contours) {
    for (const point of contour) {
      point[0] -= cx;
      point[1] -= cy;
    }
  }

  return {
    contours,
    bounds: {
      minX: bounds.minX - cx,
      maxX: bounds.maxX - cx,
      minY: bounds.minY - cy,
      maxY: bounds.maxY - cy,
    },
    isEmpty: false,
  };
}

/** Sample a THREE.Path into a closed polygon, dropping duplicate points. */
export function sampleContour(path: THREE.Path): Contour {
  const points = path.getPoints(CURVE_SEGMENTS);
  const contour: Contour = [];
  for (const point of points) {
    const prev = contour[contour.length - 1];
    if (prev && nearlyEqual(prev[0], point.x) && nearlyEqual(prev[1], point.y)) {
      continue;
    }
    contour.push([point.x, point.y]);
  }
  // Drop an explicit closing point (contours are implicitly closed).
  if (contour.length > 1) {
    const first = contour[0];
    const last = contour[contour.length - 1];
    if (nearlyEqual(first[0], last[0]) && nearlyEqual(first[1], last[1])) {
      contour.pop();
    }
  }
  return contour;
}

/**
 * Lay a visual-order line out glyph by glyph, invoking the callback with
 * each glyph's path commands.
 *
 * Layout is done manually (advance widths + kern-table kerning) instead of
 * through Font.getPath: opentype.js 2.x's text-shaping engine applies GSUB
 * feature lookups it does not fully support yet, which throws on some
 * Hebrew fonts. Hebrew needs no mandatory shaping, so simple per-glyph
 * layout is correct here (niqqud positioning is a known limitation).
 */
function layoutLine(
  font: Font,
  visualText: string,
  x0: number,
  sizeMm: number,
  emit: (commands: PathCommand[]) => void
): void {
  const scale = sizeMm / font.unitsPerEm;
  let x = x0;
  let prev: ReturnType<Font["charToGlyph"]> | null = null;
  for (const char of visualText) {
    const glyph = font.charToGlyph(char);
    if (prev) {
      x += font.getKerningValue(prev, glyph) * scale;
    }
    emit(glyph.getPath(x, 0, sizeMm).commands);
    x += (glyph.advanceWidth ?? 0) * scale;
    prev = glyph;
  }
}

/** Measure the advance width of a visual-order line, in mm. */
function measureLine(font: Font, visualText: string, sizeMm: number): number {
  const scale = sizeMm / font.unitsPerEm;
  let width = 0;
  let prev: ReturnType<Font["charToGlyph"]> | null = null;
  for (const char of visualText) {
    const glyph = font.charToGlyph(char);
    if (prev) {
      width += font.getKerningValue(prev, glyph) * scale;
    }
    width += (glyph.advanceWidth ?? 0) * scale;
    prev = glyph;
  }
  return width;
}

/** Append opentype path commands to a ShapePath, flipping Y to y-up. */
function addCommandsToPath(
  shapePath: THREE.ShapePath,
  commands: PathCommand[],
  offsetY: number
): void {
  for (const cmd of commands) {
    switch (cmd.type) {
      case "M":
        shapePath.moveTo(cmd.x!, -cmd.y! + offsetY);
        break;
      case "L":
        shapePath.lineTo(cmd.x!, -cmd.y! + offsetY);
        break;
      case "Q":
        shapePath.quadraticCurveTo(
          cmd.x1!,
          -cmd.y1! + offsetY,
          cmd.x!,
          -cmd.y! + offsetY
        );
        break;
      case "C":
        shapePath.bezierCurveTo(
          cmd.x1!,
          -cmd.y1! + offsetY,
          cmd.x2!,
          -cmd.y2! + offsetY,
          cmd.x!,
          -cmd.y! + offsetY
        );
        break;
      case "Z":
        // Contours close implicitly.
        break;
    }
  }
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

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}
