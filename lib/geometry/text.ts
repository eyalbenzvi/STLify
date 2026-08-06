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
  /** Extra spacing between glyphs, in mm (default 0). */
  letterSpacingMm?: number;
  /** Bidi handling: "auto" = simplified bidi reorder, "ltr" = keep order. */
  direction?: "auto" | "ltr";
  /**
   * Bend the line along a circle of this radius (0 = straight). The line's
   * middle stays put and the ends curve downward — medal-style arc text.
   */
  curveRadiusMm?: number;
  /** Mirror the result horizontally (stamps must be mirror-imaged). */
  mirrored?: boolean;
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
  const letterSpacingMm = options.letterSpacingMm ?? 0;
  const direction = options.direction ?? "auto";
  const curveRadiusMm = options.curveRadiusMm ?? 0;
  const lines = content.split("\n").map((line) => line.trimEnd());
  const scale = sizeMm / font.unitsPerEm;
  const lineHeight = (font.ascender - font.descender) * scale * lineSpacing;

  const shapePath = new THREE.ShapePath();

  const orderLine = (line: string): string =>
    direction === "ltr" ? line : toVisualOrder(line);

  const lineWidths = lines.map((line) =>
    line ? measureLine(font, orderLine(line), sizeMm, letterSpacingMm) : 0
  );
  const blockWidth = Math.max(...lineWidths, 0);

  lines.forEach((line, index) => {
    if (!line) return;
    const visual = orderLine(line);
    const width = lineWidths[index];

    // Alignment offsets within the block (align is visual, not logical).
    let x0 = 0;
    if (align === "center") x0 = (blockWidth - width) / 2;
    else if (align === "right") x0 = blockWidth - width;

    // Glyph paths are in y-down (canvas) coordinates; we negate y in
    // addCommandsToPath to get the y-up modelling convention, so line 0 is
    // at y=0 and following lines go down in negative y.
    const baselineY = -index * lineHeight;
    const lineCenter = x0 + width / 2;
    layoutLine(font, visual, x0, sizeMm, letterSpacingMm, (commands, penX, advance) => {
      if (curveRadiusMm > 0) {
        const bent = bendCommands(commands, penX + advance / 2, lineCenter, curveRadiusMm);
        addCommandsToPath(shapePath, bent, baselineY);
      } else {
        addCommandsToPath(shapePath, commands, baselineY);
      }
    });
  });

  let contours = shapePath.subPaths
    .map((subPath) => sampleContour(subPath))
    .filter((contour) => contour.length >= 3);

  if (options.mirrored) contours = mirrorContours(contours);

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
  letterSpacingMm: number,
  emit: (commands: PathCommand[], penX: number, advance: number) => void
): void {
  const scale = sizeMm / font.unitsPerEm;
  let x = x0;
  let prev: ReturnType<Font["charToGlyph"]> | null = null;
  for (const char of visualText) {
    const glyph = font.charToGlyph(char);
    if (prev) {
      x += font.getKerningValue(prev, glyph) * scale + letterSpacingMm;
    }
    const advance = (glyph.advanceWidth ?? 0) * scale;
    emit(glyph.getPath(x, 0, sizeMm).commands, x, advance);
    x += advance;
    prev = glyph;
  }
}

/** Measure the advance width of a visual-order line, in mm. */
function measureLine(
  font: Font,
  visualText: string,
  sizeMm: number,
  letterSpacingMm = 0
): number {
  const scale = sizeMm / font.unitsPerEm;
  let width = 0;
  let prev: ReturnType<Font["charToGlyph"]> | null = null;
  for (const char of visualText) {
    const glyph = font.charToGlyph(char);
    if (prev) {
      width += font.getKerningValue(prev, glyph) * scale + letterSpacingMm;
    }
    width += (glyph.advanceWidth ?? 0) * scale;
    prev = glyph;
  }
  return width;
}

/**
 * Bend one glyph's path commands along a circle of the given radius. The
 * glyph's centre (at pen position glyphCenterX) maps onto the circle so the
 * line's middle stays at y=0 and the ends curve downward (medal-style arc).
 * Coordinates here are still y-down (font space); y is negated later.
 */
function bendCommands(
  commands: PathCommand[],
  glyphCenterX: number,
  lineCenterX: number,
  radiusMm: number
): PathCommand[] {
  const phi = (glyphCenterX - lineCenterX) / radiusMm;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  // Font space is y-down; the arc math is for y-up, so negate on the way
  // in and out. Rotate the glyph by -phi around its baseline centre, then
  // translate the baseline point onto the circle.
  const tx = radiusMm * sin;
  const ty = radiusMm * cos - radiusMm;
  const map = (x: number, yDown: number): { x: number; y: number } => {
    const lx = x - glyphCenterX;
    const ly = -yDown;
    const rx = lx * cos + ly * sin;
    const ry = -lx * sin + ly * cos;
    return { x: rx + tx, y: -(ry + ty) };
  };
  return commands.map((cmd) => {
    const next = { ...cmd };
    if (next.x !== undefined && next.y !== undefined) {
      const p = map(next.x, next.y);
      next.x = p.x;
      next.y = p.y;
    }
    if (next.x1 !== undefined && next.y1 !== undefined) {
      const p = map(next.x1, next.y1);
      next.x1 = p.x;
      next.y1 = p.y;
    }
    if (next.x2 !== undefined && next.y2 !== undefined) {
      const p = map(next.x2, next.y2);
      next.x2 = p.x;
      next.y2 = p.y;
    }
    return next;
  });
}

/** Mirror contours around x=0, preserving winding by reversing point order. */
export function mirrorContours(contours: Contour[]): Contour[] {
  return contours.map((contour) =>
    contour.map(([x, y]): [number, number] => [-x, y]).reverse()
  );
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
