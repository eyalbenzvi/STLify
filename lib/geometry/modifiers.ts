/**
 * The modifier stack: re-editable operations attached to a layer.
 *
 * Until now every operation was DESTRUCTIVE. Hollowing a body baked a new
 * mesh into the mesh store and `provenance` recorded where it came from for
 * display only — so changing a wall thickness after a boolean meant undoing
 * back past the boolean and redoing everything. That is the single biggest
 * workflow cost in the editor.
 *
 * A modifier is a parameter record, not geometry. `buildDocument` applies the
 * stack to the layer's freshly built solid on every rebuild, so editing a
 * modifier's parameters — or reordering, disabling or deleting it — simply
 * produces a different result from the same source. Nothing is baked and
 * nothing is lost.
 *
 * Scope: modifiers are UNARY, acting on the layer's own body. Multi-body
 * operations (booleans between layers, cuts that produce several parts,
 * connectors) stay destructive, because their result is a different set
 * of layers rather than a different shape for one layer.
 */

import type { GeometryKernel, Solid } from "./kernel";
import {
  bendSolid,
  stretchSolid,
  taperSolid,
  twistSolid,
  type DeformAxis,
} from "./operations/deform";
import { roundEdges, shellSolid, type RoundingScope, type RoundingStyle } from "./operations/fillet";
import { latticeFill, type LatticeKind } from "./operations/lattice";
import { OpError } from "./operations/layerOps";
import { isotropicRemesh } from "./operations/remesh";

export type ModifierKind =
  | "fillet"
  | "shell"
  | "twist"
  | "taper"
  | "bend"
  | "stretch"
  | "lattice"
  | "remesh"
  | "simplify"
  | "smooth";

interface ModifierCommon {
  /** Stable id, so the UI can reorder without remounting. */
  id: string;
  /** Disabled modifiers stay in the stack but are skipped. */
  enabled: boolean;
}

export type Modifier = ModifierCommon &
  (
    | {
        kind: "fillet";
        sizeMm: number;
        style: RoundingStyle;
        scope: RoundingScope;
      }
    | {
        kind: "shell";
        wallThicknessMm: number;
        opening: "top" | "bottom" | "front" | "back" | "left" | "right" | "none";
      }
    | { kind: "twist"; axis: DeformAxis; degrees: number }
    | { kind: "taper"; axis: DeformAxis; endScale: number }
    | { kind: "bend"; axis: DeformAxis; towards: DeformAxis; degrees: number }
    | {
        kind: "stretch";
        axis: DeformAxis;
        center: number;
        amount: number;
        falloff: number;
      }
    | {
        kind: "lattice";
        latticeKind: LatticeKind;
        cellSizeMm: number;
        thicknessMm: number;
        shellThicknessMm: number;
      }
    | { kind: "remesh"; targetEdgeMm: number; iterations: number; featureAngleDeg: number }
    | { kind: "simplify"; toleranceMm: number }
    | { kind: "smooth"; minSharpAngleDeg: number; refineEdgeMm: number }
  );

export const MODIFIER_NAMES_HE: Record<ModifierKind, string> = {
  fillet: "עיגול קצוות",
  shell: "קליפה",
  twist: "פיתול",
  taper: "התחדדות",
  bend: "כיפוף",
  stretch: "מתיחה",
  lattice: "סריג פנימי",
  remesh: "רישות מחדש",
  simplify: "פישוט",
  smooth: "החלקה",
};

/** A short Hebrew summary of a modifier's settings, for the stack list. */
export function describeModifier(modifier: Modifier): string {
  switch (modifier.kind) {
    case "fillet": {
      const style = modifier.style === "fillet" ? "רדיוס" : "שיפוע";
      const scope =
        modifier.scope === "convex"
          ? "חיצוני"
          : modifier.scope === "concave"
            ? "פנימי"
            : "הכול";
      return `${style} ${modifier.sizeMm} מ״מ, ${scope}`;
    }
    case "shell":
      return `דופן ${modifier.wallThicknessMm} מ״מ`;
    case "twist":
      return `${modifier.degrees}° סביב ${modifier.axis.toUpperCase()}`;
    case "taper":
      return `${modifier.endScale}× בציר ${modifier.axis.toUpperCase()}`;
    case "bend":
      return `${modifier.degrees}° מ-${modifier.axis.toUpperCase()} אל ${modifier.towards.toUpperCase()}`;
    case "stretch":
      return `${modifier.amount}× בציר ${modifier.axis.toUpperCase()}`;
    case "lattice":
      return `תא ${modifier.cellSizeMm} מ״מ`;
    case "remesh":
      return `צלע ${modifier.targetEdgeMm} מ״מ`;
    case "simplify":
      return `סבילות ${modifier.toleranceMm} מ״מ`;
    case "smooth":
      return `זווית חדה ${modifier.minSharpAngleDeg}°`;
  }
}

export interface ModifierApplyResult {
  solid: Solid;
  warningsHe: string[];
  /** Hebrew errors, one per modifier that failed. */
  errorsHe: string[];
}

/**
 * Apply a layer's modifier stack, in order.
 *
 * A modifier that fails does NOT abort the build: its error is collected and
 * the stack continues from the last good solid. That matters because a
 * document is rebuilt on every keystroke — a fillet radius that is briefly
 * too large while the user types should show a message, not blank the
 * viewport.
 *
 * Consumes `solid` and returns a new one.
 */
/** Document facts the modifiers need but cannot read for themselves. */
export interface ModifierContext {
  /** Drives the lattice's printability check. */
  nozzleDiameterMm?: number;
}

export function applyModifiers(
  kernel: GeometryKernel,
  solid: Solid,
  modifiers: readonly Modifier[],
  context: ModifierContext = {}
): ModifierApplyResult {
  const warningsHe: string[] = [];
  const errorsHe: string[] = [];
  let current = solid;

  for (const modifier of modifiers) {
    if (!modifier.enabled) continue;
    // Keep a fallback: every operation below consumes its input, so a
    // failure would otherwise leave nothing to continue from.
    const fallback = current.duplicate();
    try {
      current = applyOne(kernel, current, modifier, warningsHe, context);
      if (current.status() !== "NoError" || current.isEmpty()) {
        const status = current.status();
        current.dispose();
        current = fallback;
        errorsHe.push(
          `${MODIFIER_NAMES_HE[modifier.kind]}: התוצאה אינה תקינה (${status === "NoError" ? "ריקה" : status})`
        );
        continue;
      }
      fallback.dispose();
    } catch (err) {
      current = fallback;
      errorsHe.push(
        `${MODIFIER_NAMES_HE[modifier.kind]}: ${
          err instanceof OpError ? err.messageHe : err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return { solid: current, warningsHe, errorsHe };
}

function applyOne(
  kernel: GeometryKernel,
  solid: Solid,
  modifier: Modifier,
  warningsHe: string[],
  context: ModifierContext
): Solid {
  switch (modifier.kind) {
    case "fillet": {
      const outcome = roundEdges(kernel, solid, {
        sizeMm: modifier.sizeMm,
        style: modifier.style,
        scope: modifier.scope,
      });
      warningsHe.push(...outcome.warningsHe);
      return outcome.solid;
    }
    case "shell": {
      const outcome = shellSolid(kernel, solid, {
        wallThicknessMm: modifier.wallThicknessMm,
        opening: modifier.opening,
      });
      warningsHe.push(...outcome.warningsHe);
      return outcome.solid;
    }
    case "twist":
      return twistSolid(solid, { axis: modifier.axis, degrees: modifier.degrees });
    case "taper":
      return taperSolid(solid, { axis: modifier.axis, endScale: modifier.endScale });
    case "bend":
      return bendSolid(solid, {
        axis: modifier.axis,
        towards: modifier.towards,
        degrees: modifier.degrees,
      });
    case "stretch":
      return stretchSolid(solid, {
        axis: modifier.axis,
        center: modifier.center,
        amount: modifier.amount,
        falloff: modifier.falloff,
      });
    case "lattice": {
      const outcome = latticeFill(kernel, solid, {
        kind: modifier.latticeKind,
        cellSizeMm: modifier.cellSizeMm,
        thicknessMm: modifier.thicknessMm,
        shellThicknessMm: modifier.shellThicknessMm,
        nozzleDiameterMm: context.nozzleDiameterMm,
      });
      warningsHe.push(...outcome.warningsHe);
      return outcome.solid;
    }
    case "remesh": {
      const mesh = solid.toMeshData();
      const result = isotropicRemesh(mesh, {
        targetEdgeMm: modifier.targetEdgeMm,
        iterations: modifier.iterations,
        featureAngleDeg: modifier.featureAngleDeg,
      });
      warningsHe.push(...result.warningsHe);
      solid.dispose();
      const { solid: rebuilt, status } = kernel.fromMeshData(result.mesh);
      if (status !== "NoError") {
        rebuilt.dispose();
        throw new OpError(`הרישות מחדש יצרה רשת לא תקינה (${status})`);
      }
      return rebuilt;
    }
    case "simplify":
      return solid.simplify(modifier.toleranceMm);
    case "smooth":
      return solid.smoothOut(modifier.minSharpAngleDeg, 0, modifier.refineEdgeMm);
  }
}

/** A new modifier of the given kind with sensible defaults. */
export function defaultModifier(kind: ModifierKind, id: string): Modifier {
  switch (kind) {
    case "fillet":
      return { id, enabled: true, kind, sizeMm: 1, style: "fillet", scope: "convex" };
    case "shell":
      return { id, enabled: true, kind, wallThicknessMm: 2, opening: "top" };
    case "twist":
      return { id, enabled: true, kind, axis: "z", degrees: 45 };
    case "taper":
      return { id, enabled: true, kind, axis: "z", endScale: 0.7 };
    case "bend":
      return { id, enabled: true, kind, axis: "x", towards: "z", degrees: 45 };
    case "stretch":
      return { id, enabled: true, kind, axis: "z", center: 0.5, amount: 1.2, falloff: 0.4 };
    case "lattice":
      return {
        id,
        enabled: true,
        kind,
        latticeKind: "gyroid",
        cellSizeMm: 8,
        thicknessMm: 1.2,
        shellThicknessMm: 1.6,
      };
    case "remesh":
      return { id, enabled: true, kind, targetEdgeMm: 1.5, iterations: 3, featureAngleDeg: 30 };
    case "simplify":
      return { id, enabled: true, kind, toleranceMm: 0.1 };
    case "smooth":
      return { id, enabled: true, kind, minSharpAngleDeg: 50, refineEdgeMm: 1 };
  }
}
