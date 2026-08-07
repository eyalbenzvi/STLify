/**
 * Layer-level boolean operations (union / difference / intersection).
 * Real manifold CSG through the kernel — results are validated before they
 * are accepted; a failed operation never touches the document.
 */

import type { BooleanOperation, DesignDocument, ImportedMeshLayer, ShapeLayer } from "@/types/design";
import { getGeometryKernel, type Solid } from "../kernel";
import {
  assertValidResult,
  BOOLEAN_FIX_SUGGESTIONS_HE,
  materializeWorldSolid,
  OpError,
  solidToResultLayer,
  type OpHooks,
} from "./layerOps";

const KIND_NAMES_HE: Record<BooleanOperation["kind"], string> = {
  union: "איחוד",
  difference: "חיסור",
  intersection: "חיתוך משותף",
};

export interface BooleanOpOutcome {
  layer: ImportedMeshLayer;
  warningsHe: string[];
}

/** Maximum operands for one boolean call (performance guard). */
export const MAX_BOOLEAN_OPERANDS = 6;

/**
 * Perform a boolean operation on the given shape layers (in operand order —
 * for difference the first layer is the minuend). Throws OpError with
 * Hebrew guidance on failure.
 */
export async function performBoolean(
  document: DesignDocument,
  layers: ShapeLayer[],
  kind: BooleanOperation["kind"],
  hooks: OpHooks = {}
): Promise<BooleanOpOutcome> {
  if (layers.length < 2) {
    throw new OpError("יש לבחור לפחות שתי שכבות לפעולה בוליאנית");
  }
  if (layers.length > MAX_BOOLEAN_OPERANDS) {
    throw new OpError(
      `ניתן לבצע פעולה בוליאנית על עד ${MAX_BOOLEAN_OPERANDS} שכבות בבת אחת`,
      ["בצעו את הפעולה בשלבים"]
    );
  }

  const kernel = await getGeometryKernel();
  const warningsHe: string[] = [];
  const solids: Solid[] = [];
  // Cancellation must escape unwrapped (the catch below turns other errors
  // into OpError with fix suggestions, which would eat the cancel signal).
  let cancelled = false;
  const cancelPoint = () => {
    if (!hooks.throwIfCancelled) return;
    try {
      hooks.throwIfCancelled();
    } catch (err) {
      cancelled = true;
      throw err;
    }
  };
  try {
    let operandIndex = 0;
    for (const layer of layers) {
      cancelPoint();
      hooks.onProgress?.(
        0.1 + 0.5 * (operandIndex++ / layers.length),
        `מכין את "${layer.name}"`
      );
      const solid = await materializeWorldSolid(kernel, document, layer);
      if (!solid || solid.isEmpty()) {
        solid?.dispose();
        throw new OpError(`לשכבה "${layer.name}" אין גאומטריה — הפעולה בוטלה`, [
          "בדקו שהשכבה אינה ריקה ושאינה מוסתרת",
        ]);
      }
      solids.push(solid);
    }

    // Overlap sanity check (union / difference need actual overlap to be
    // meaningful; touching-but-not-overlapping produces fragile results).
    if (kind !== "intersection") {
      const overlap = measurePairOverlap(solids);
      if (overlap === 0) {
        warningsHe.push(
          "האובייקטים אינם חופפים — התוצאה עלולה להיות שני גופים נפרדים או ריקה"
        );
      } else if (overlap < 1) {
        warningsHe.push(
          "החפיפה בין האובייקטים קטנה מ-1 ממ״ק — חיבור כזה עלול להיות שביר או לא אמין"
        );
      }
    }

    // Last safe cancel point: every operand is still individually owned.
    cancelPoint();
    hooks.onProgress?.(0.7, "מבצע את הפעולה הבוליאנית");

    let result: Solid;
    if (kind === "union") {
      result = kernel.unionAll(solids.splice(0));
    } else if (kind === "difference") {
      const [target, ...cutters] = solids.splice(0);
      const cutter = cutters.length === 1 ? cutters[0] : kernel.unionAll(cutters);
      result = target.subtract(cutter);
    } else {
      let acc = solids.shift()!;
      while (solids.length > 0) acc = acc.intersect(solids.shift()!);
      result = acc;
    }

    if (kind === "intersection" && (result.isEmpty() || result.numTriangles() === 0)) {
      result.dispose();
      throw new OpError("אין נפח משותף בין האובייקטים שנבחרו", [
        "ודאו שהאובייקטים חופפים במרחב",
        "השתמשו בכלי ההזזה כדי לקרב אותם",
      ]);
    }

    assertValidResult(result, KIND_NAMES_HE[kind]);

    const layer = solidToResultLayer(result, {
      nameHe: `${KIND_NAMES_HE[kind]}: ${layers.map((l) => l.name).join(" + ")}`,
      provenance: {
        kind: "booleanResult",
        descriptionHe: KIND_NAMES_HE[kind],
        sourceLayerIds: layers.map((l) => l.id),
      },
      materialSlotId: layers[0].materialSlotId,
    });
    return { layer, warningsHe };
  } catch (err) {
    for (const solid of solids) solid.dispose();
    if (cancelled || err instanceof OpError) throw err;
    throw new OpError(
      `הפעולה "${KIND_NAMES_HE[kind]}" נכשלה: ${err instanceof Error ? err.message : String(err)}`,
      BOOLEAN_FIX_SUGGESTIONS_HE
    );
  }
}

/**
 * Smallest pairwise intersection volume between consecutive operands, mm³.
 * Uses duplicated handles so the operand solids stay alive.
 */
function measurePairOverlap(solids: Solid[]): number {
  let minOverlap = Infinity;
  for (let i = 0; i < solids.length - 1; i++) {
    const inter = solids[i].duplicate().intersect(solids[i + 1].duplicate());
    const volume = inter.isEmpty() ? 0 : inter.volumeMm3();
    inter.dispose();
    minOverlap = Math.min(minOverlap, volume);
  }
  return Number.isFinite(minOverlap) ? minOverlap : 0;
}
