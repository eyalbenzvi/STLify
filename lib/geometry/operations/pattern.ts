/**
 * Array / pattern tools: linear, circular, grid and mirror.
 *
 * Patterns operate on the DOCUMENT, not on geometry: each copy is a real
 * layer with its own transform, sharing the source layer's parameters (and,
 * for mesh layers, its mesh-store payload — copies are references, so a
 * hundred-item array costs one mesh, not a hundred).
 *
 * That choice matters for a browser app: it keeps arrays free to create,
 * free to undo, and individually editable afterwards, which is what users
 * expect from Fusion's pattern tools.
 */

import {
  identityTransform,
  newId,
  type DesignLayer,
  type Transform3D,
} from "@/types/design";

export interface LinearPatternSettings {
  kind: "linear";
  /** Number of copies INCLUDING the original. */
  count: number;
  /** Step between consecutive copies, mm. */
  spacingMm: { x: number; y: number; z: number };
}

export interface CircularPatternSettings {
  kind: "circular";
  count: number;
  /** Centre of rotation in world mm. */
  center: { x: number; y: number };
  /** Total sweep in degrees; 360 distributes evenly all the way round. */
  totalAngleDeg: number;
  /** Rotate each copy to follow the circle, rather than keeping it upright. */
  rotateCopies: boolean;
}

export interface GridPatternSettings {
  kind: "grid";
  countX: number;
  countY: number;
  spacingXMm: number;
  spacingYMm: number;
}

export interface MirrorPatternSettings {
  kind: "mirror";
  axis: "x" | "y" | "z";
  /** Mirror plane position along the axis, world mm. */
  offsetMm: number;
}

export type PatternSettings =
  | LinearPatternSettings
  | CircularPatternSettings
  | GridPatternSettings
  | MirrorPatternSettings;

export interface PatternResult {
  /** The new layers to append to the document (the original is untouched). */
  layers: DesignLayer[];
  /** Hebrew summary for the history label. */
  labelHe: string;
}

/** Validation failure with a Hebrew message. */
export class PatternError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "PatternError";
  }
}

const MAX_COPIES = 400;

function cloneLayer(source: DesignLayer, transform: Transform3D, suffix: string): DesignLayer {
  // A shallow clone is correct here: every layer field is either a primitive,
  // an immutable array we never mutate in place, or a mesh-store id that
  // copies are meant to share.
  return {
    ...source,
    id: newId("layer"),
    name: `${source.name} ${suffix}`,
    transform,
  } as DesignLayer;
}

function offsetTransform(
  base: Transform3D,
  dx: number,
  dy: number,
  dz: number
): Transform3D {
  return { ...base, x: base.x + dx, y: base.y + dy, z: base.z + dz };
}

/** Rotate (x, y) around (cx, cy) by `deg`. */
function rotateAround(
  x: number,
  y: number,
  cx: number,
  cy: number,
  deg: number
): [number, number] {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

/** Build the copies for a pattern. Throws `PatternError` on bad settings. */
export function buildPattern(
  source: DesignLayer,
  settings: PatternSettings
): PatternResult {
  const base = source.transform ?? identityTransform();

  switch (settings.kind) {
    case "linear": {
      const count = Math.round(settings.count);
      if (count < 2) throw new PatternError("מספר העותקים חייב להיות 2 לפחות");
      if (count > MAX_COPIES) {
        throw new PatternError(`מספר העותקים מוגבל ל-${MAX_COPIES}`);
      }
      const { x, y, z } = settings.spacingMm;
      if (x === 0 && y === 0 && z === 0) {
        throw new PatternError("המרווח חייב להיות שונה מאפס לפחות בציר אחד");
      }
      const layers: DesignLayer[] = [];
      for (let i = 1; i < count; i++) {
        layers.push(
          cloneLayer(source, offsetTransform(base, x * i, y * i, z * i), `(${i + 1})`)
        );
      }
      return { layers, labelHe: `מערך קווי: ${count} עותקים` };
    }

    case "grid": {
      const cx = Math.round(settings.countX);
      const cy = Math.round(settings.countY);
      if (cx < 1 || cy < 1) throw new PatternError("מספר העותקים בכל ציר חייב להיות 1 לפחות");
      if (cx * cy < 2) throw new PatternError("הרשת חייבת להכיל 2 עותקים לפחות");
      if (cx * cy > MAX_COPIES) {
        throw new PatternError(`מספר העותקים מוגבל ל-${MAX_COPIES}`);
      }
      if (settings.spacingXMm === 0 && settings.spacingYMm === 0) {
        throw new PatternError("המרווח חייב להיות שונה מאפס");
      }
      const layers: DesignLayer[] = [];
      for (let iy = 0; iy < cy; iy++) {
        for (let ix = 0; ix < cx; ix++) {
          if (ix === 0 && iy === 0) continue; // the original
          layers.push(
            cloneLayer(
              source,
              offsetTransform(base, settings.spacingXMm * ix, settings.spacingYMm * iy, 0),
              `(${ix + 1},${iy + 1})`
            )
          );
        }
      }
      return { layers, labelHe: `רשת: ${cx}×${cy}` };
    }

    case "circular": {
      const count = Math.round(settings.count);
      if (count < 2) throw new PatternError("מספר העותקים חייב להיות 2 לפחות");
      if (count > MAX_COPIES) {
        throw new PatternError(`מספר העותקים מוגבל ל-${MAX_COPIES}`);
      }
      const total = settings.totalAngleDeg;
      if (total === 0) throw new PatternError("זווית הפיזור חייבת להיות שונה מאפס");
      // A full revolution has no duplicate at 360 degrees, so the step
      // divides by count; a partial arc puts a copy at each end.
      const full = Math.abs(Math.abs(total) - 360) < 1e-6;
      const step = full ? total / count : total / (count - 1);
      const layers: DesignLayer[] = [];
      for (let i = 1; i < count; i++) {
        const angle = step * i;
        const [x, y] = rotateAround(base.x, base.y, settings.center.x, settings.center.y, angle);
        const transform: Transform3D = {
          ...base,
          x,
          y,
          rotationZ: settings.rotateCopies ? base.rotationZ + angle : base.rotationZ,
        };
        layers.push(cloneLayer(source, transform, `(${i + 1})`));
      }
      return { layers, labelHe: `מערך מעגלי: ${count} עותקים` };
    }

    case "mirror": {
      const axis = settings.axis;
      const transform: Transform3D = { ...base };
      // Mirroring a placed object reflects both its position and its
      // orientation. Negating the scale on the mirrored axis reflects the
      // geometry itself; the pipeline flips triangle winding for negative
      // determinants, so the copy stays outward-facing.
      if (axis === "x") {
        transform.x = 2 * settings.offsetMm - base.x;
        transform.scaleX = -base.scaleX;
      } else if (axis === "y") {
        transform.y = 2 * settings.offsetMm - base.y;
        transform.scaleY = -base.scaleY;
      } else {
        transform.z = 2 * settings.offsetMm - base.z;
        transform.scaleZ = -base.scaleZ;
      }
      return {
        layers: [cloneLayer(source, transform, "(מראה)")],
        labelHe: `שיקוף בציר ${axis.toUpperCase()}`,
      };
    }
  }
}
