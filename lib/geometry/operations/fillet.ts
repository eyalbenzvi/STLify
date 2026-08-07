/**
 * Fillet and chamfer, by morphological rounding.
 *
 * Manifold has no per-edge fillet operator, so this uses the morphological
 * identity every solid modeller falls back on:
 *
 *   opening  (erode then dilate) rounds CONVEX edges  — an outside fillet
 *   closing  (dilate then erode) rounds CONCAVE edges — an inside fillet
 *
 * Rounding with a sphere gives a true radius; rounding with an octahedron
 * (the L1 ball) gives a flat 45-degree cut, which is a chamfer.
 *
 * BE HONEST ABOUT THE LIMITATION: this rounds EVERY edge of the selected
 * kind at once, not a hand-picked subset. That is a real difference from
 * Fusion's edge-select fillet, and the UI says so. It is still the tool
 * people reach for most, because "soften all the sharp edges on this part"
 * is the common case — and unlike a cosmetic shader it produces genuine
 * printable geometry.
 *
 * Minkowski cost grows steeply with triangle count, so the operation runs on
 * a simplified proxy and reports when it had to, exactly like hollow.ts.
 */

import type { GeometryKernel, Solid } from "../kernel";
import { OpError } from "./layerOps";

/** Triangle budget for the Minkowski operands. */
const PROXY_MAX_TRIS = 4000;
const PROXY_HARD_LIMIT = PROXY_MAX_TRIS * 5;

export type RoundingStyle = "fillet" | "chamfer";
export type RoundingScope = "convex" | "concave" | "both";

export interface FilletSettings {
  /** Radius (fillet) or leg length (chamfer), mm. */
  sizeMm: number;
  style: RoundingStyle;
  scope: RoundingScope;
  /** Facets on the rounding ball. Higher is smoother and much slower. */
  quality?: number;
}

export interface FilletOutcome {
  solid: Solid;
  warningsHe: string[];
  volumeBeforeMm3: number;
  volumeAfterMm3: number;
}

/**
 * The structuring element. A sphere rounds; an octahedron cuts a flat
 * 45-degree face, which reads as a chamfer on axis-aligned edges.
 */
function structuringElement(
  kernel: GeometryKernel,
  style: RoundingStyle,
  sizeMm: number,
  quality: number
): Solid {
  if (style === "fillet") {
    return kernel.sphere(sizeMm, Math.max(8, Math.min(quality, 32)));
  }
  // Octahedron: the convex hull of the six axis points at distance sizeMm.
  const points: Solid[] = [];
  const eps = sizeMm * 0.02;
  for (const [x, y, z] of [
    [sizeMm, 0, 0],
    [-sizeMm, 0, 0],
    [0, sizeMm, 0],
    [0, -sizeMm, 0],
    [0, 0, sizeMm],
    [0, 0, -sizeMm],
  ]) {
    points.push(kernel.box(eps, eps, eps, true).translate(x, y, z));
  }
  return kernel.unionAll(points).hull();
}

/** Simplify to something Minkowski can chew, reporting any loss of fidelity. */
function proxyFor(solid: Solid, sizeMm: number, warningsHe: string[]): Solid {
  let proxy = solid.duplicate();
  if (proxy.numTriangles() > PROXY_MAX_TRIS) {
    proxy = proxy.simplify(Math.min(sizeMm * 0.15, 0.3));
  }
  if (proxy.numTriangles() > PROXY_MAX_TRIS) {
    proxy = proxy.simplify(sizeMm * 0.4);
    warningsHe.push(
      "המודל מורכב מאוד — פרטים דקים עשויים להיטשטש בעיגול הקצוות"
    );
  }
  if (proxy.numTriangles() > PROXY_HARD_LIMIT) {
    proxy.dispose();
    throw new OpError("המודל מורכב מדי לעיגול קצוות בדפדפן", [
      "הפעילו ״פישוט״ על הרשת ונסו שוב",
      "או הקטינו את רדיוס העיגול",
    ]);
  }
  return proxy;
}

/**
 * Round the edges of a solid.
 *
 * Consumes `solid` and returns a new one.
 */
export function roundEdges(
  kernel: GeometryKernel,
  solid: Solid,
  settings: FilletSettings
): FilletOutcome {
  const size = settings.sizeMm;
  if (!(size > 0)) {
    solid.dispose();
    throw new OpError("רדיוס העיגול חייב להיות גדול מאפס");
  }
  const bounds = solid.boundingBox();
  const smallest = Math.min(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z
  );
  if (size >= smallest / 2) {
    solid.dispose();
    throw new OpError(
      `רדיוס העיגול (${size} מ״מ) גדול מדי — הוא חייב להיות קטן ממחצית המידה הקטנה של הגוף (${(smallest / 2).toFixed(2)} מ״מ)`
    );
  }

  const warningsHe: string[] = [];
  const quality = settings.quality ?? 12;
  const volumeBefore = solid.volumeMm3();
  const proxy = proxyFor(solid, size, warningsHe);
  solid.dispose();

  let result = proxy;

  // Concave first: closing an already-opened solid would re-sharpen nothing,
  // but opening an already-closed one still rounds the outside correctly.
  if (settings.scope === "concave" || settings.scope === "both") {
    const ball = structuringElement(kernel, settings.style, size, quality);
    const grown = result.minkowskiSum(ball);
    const ball2 = structuringElement(kernel, settings.style, size, quality);
    result = grown.minkowskiDifference(ball2);
    if (result.isEmpty()) {
      result.dispose();
      throw new OpError("עיגול הפינות הפנימיות מחק את הגוף — הקטינו את הרדיוס");
    }
  }

  if (settings.scope === "convex" || settings.scope === "both") {
    const ball = structuringElement(kernel, settings.style, size, quality);
    const shrunk = result.minkowskiDifference(ball);
    if (shrunk.isEmpty()) {
      shrunk.dispose();
      throw new OpError(
        "רדיוס העיגול גדול מדי — הגוף נעלם בשלב הכיווץ. הקטינו את הרדיוס"
      );
    }
    const ball2 = structuringElement(kernel, settings.style, size, quality);
    result = shrunk.minkowskiSum(ball2);
  }

  if (result.status() !== "NoError" || result.isEmpty()) {
    result.dispose();
    throw new OpError("עיגול הקצוות נכשל — נסו רדיוס קטן יותר");
  }

  return {
    solid: result,
    warningsHe,
    volumeBeforeMm3: volumeBefore,
    volumeAfterMm3: result.volumeMm3(),
  };
}

// ---------------------------------------------------------------------------
// Open shell
// ---------------------------------------------------------------------------

export type ShellOpening = "top" | "bottom" | "front" | "back" | "left" | "right" | "none";

export interface ShellSettings {
  wallThicknessMm: number;
  /** Which face to leave open. "none" produces a sealed hollow body. */
  opening: ShellOpening;
}

export interface ShellOutcome {
  solid: Solid;
  warningsHe: string[];
  volumeBeforeMm3: number;
  volumeAfterMm3: number;
}

/**
 * Hollow a solid and cut an opening in one face — the difference between a
 * sealed hollow blob and an actual box, cup or tray.
 *
 * `hollow.ts` can only produce sealed cavities (which then need a drain
 * hole); this produces a usable open container.
 *
 * Consumes `solid`.
 */
export function shellSolid(
  kernel: GeometryKernel,
  solid: Solid,
  settings: ShellSettings
): ShellOutcome {
  const wall = settings.wallThicknessMm;
  if (!(wall > 0)) {
    solid.dispose();
    throw new OpError("עובי הדופן חייב להיות גדול מאפס");
  }
  const bounds = solid.boundingBox();
  const smallest = Math.min(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z
  );
  if (wall >= smallest / 2) {
    solid.dispose();
    throw new OpError(
      `עובי הדופן (${wall} מ״מ) גדול מדי ביחס לגוף — המקסימום הוא ${(smallest / 2).toFixed(2)} מ״מ`
    );
  }

  const warningsHe: string[] = [];
  const volumeBefore = solid.volumeMm3();
  const detailed = solid.duplicate();
  const proxy = proxyFor(solid, wall, warningsHe);

  const ball = kernel.sphere(wall, 10);
  const cavity = proxy.minkowskiDifference(ball);
  if (cavity.isEmpty()) {
    cavity.dispose();
    detailed.dispose();
    throw new OpError("עובי הדופן גדול מדי — לא נותר חלל פנימי");
  }

  let result = detailed.subtract(cavity);

  if (settings.opening !== "none") {
    // Cut a slab off the chosen face, down to the wall thickness, so the
    // cavity is exposed.
    const sizeX = bounds.max.x - bounds.min.x;
    const sizeY = bounds.max.y - bounds.min.y;
    const sizeZ = bounds.max.z - bounds.min.z;
    const pad = Math.max(sizeX, sizeY, sizeZ);
    let cutter: Solid;
    switch (settings.opening) {
      case "top":
        cutter = kernel
          .box(pad * 2, pad * 2, wall * 2, true)
          .translate(0, 0, bounds.max.z);
        break;
      case "bottom":
        cutter = kernel
          .box(pad * 2, pad * 2, wall * 2, true)
          .translate(0, 0, bounds.min.z);
        break;
      case "right":
        cutter = kernel.box(wall * 2, pad * 2, pad * 2, true).translate(bounds.max.x, 0, 0);
        break;
      case "left":
        cutter = kernel.box(wall * 2, pad * 2, pad * 2, true).translate(bounds.min.x, 0, 0);
        break;
      case "back":
        cutter = kernel.box(pad * 2, wall * 2, pad * 2, true).translate(0, bounds.max.y, 0);
        break;
      case "front":
        cutter = kernel.box(pad * 2, wall * 2, pad * 2, true).translate(0, bounds.min.y, 0);
        break;
    }
    result = result.subtract(cutter);
  }

  if (result.status() !== "NoError" || result.isEmpty()) {
    result.dispose();
    throw new OpError("החילול נכשל — נסו עובי דופן קטן יותר");
  }

  return {
    solid: result,
    warningsHe,
    volumeBeforeMm3: volumeBefore,
    volumeAfterMm3: result.volumeMm3(),
  };
}
