/**
 * Layer-level wrappers for the V4 operations.
 *
 * Each function takes the document plus a source layer, materializes it into
 * a world-space solid, runs the geometry work and packages the result as a
 * replacement mesh layer — the same contract the existing booleans, cuts and
 * hollow operations follow, so the editor's undo, provenance and validation
 * plumbing applies unchanged.
 */

import type {
  DesignDocument,
  ImportedMeshLayer,
  ShapeLayer,
} from "@/types/design";
import { getGeometryKernel } from "../kernel";
import {
  bendSolid,
  ffdSolid,
  stretchSolid,
  taperSolid,
  twistSolid,
  type BendSettings,
  type FfdSettings,
  type StretchSettings,
  type TaperSettings,
  type TwistSettings,
} from "./deform";
import { roundEdges, shellSolid, type FilletSettings, type ShellSettings } from "./fillet";
import { latticeFill, type LatticeSettings } from "./lattice";
import {
  assertValidResult,
  materializeWorldSolid,
  OpError,
  solidToResultLayer,
} from "./layerOps";

export interface AdvancedOpOutcome {
  layer: ImportedMeshLayer;
  warningsHe: string[];
  /** Material change, for the report shown after the operation. */
  volumeBeforeMm3: number;
  volumeAfterMm3: number;
}

async function sourceSolid(document: DesignDocument, layer: ShapeLayer) {
  const kernel = await getGeometryKernel();
  const solid = await materializeWorldSolid(kernel, document, layer);
  if (!solid) {
    throw new OpError(`לשכבה "${layer.name}" אין גוף לעבד`);
  }
  return { kernel, solid };
}

/** Fillet or chamfer every edge of the chosen kind. */
export async function applyFillet(
  document: DesignDocument,
  layer: ShapeLayer,
  settings: FilletSettings
): Promise<AdvancedOpOutcome> {
  const { kernel, solid } = await sourceSolid(document, layer);
  const outcome = roundEdges(kernel, solid, settings);
  assertValidResult(outcome.solid, "עיגול קצוות");
  const styleHe = settings.style === "fillet" ? "עיגול" : "שיפוע";
  return {
    layer: solidToResultLayer(outcome.solid, {
      nameHe: `${layer.name} — ${styleHe} ${settings.sizeMm} מ״מ`,
      provenance: {
        kind: "smoothResult",
        descriptionHe: `${styleHe} קצוות ברדיוס ${settings.sizeMm} מ״מ`,
        sourceLayerIds: [layer.id],
      },
      materialSlotId: layer.materialSlotId,
    }),
    warningsHe: outcome.warningsHe,
    volumeBeforeMm3: outcome.volumeBeforeMm3,
    volumeAfterMm3: outcome.volumeAfterMm3,
  };
}

/** Hollow with an optional opening in one face. */
export async function applyShell(
  document: DesignDocument,
  layer: ShapeLayer,
  settings: ShellSettings
): Promise<AdvancedOpOutcome> {
  const { kernel, solid } = await sourceSolid(document, layer);
  const outcome = shellSolid(kernel, solid, settings);
  assertValidResult(outcome.solid, "חילול עם פתח");
  return {
    layer: solidToResultLayer(outcome.solid, {
      nameHe: `${layer.name} — קליפה ${settings.wallThicknessMm} מ״מ`,
      provenance: {
        kind: "hollowResult",
        descriptionHe: `קליפה בעובי ${settings.wallThicknessMm} מ״מ`,
        sourceLayerIds: [layer.id],
      },
      materialSlotId: layer.materialSlotId,
    }),
    warningsHe: outcome.warningsHe,
    volumeBeforeMm3: outcome.volumeBeforeMm3,
    volumeAfterMm3: outcome.volumeAfterMm3,
  };
}

export type DeformKind = "twist" | "taper" | "bend" | "stretch" | "ffd";

export type DeformRequest =
  | { kind: "twist"; settings: TwistSettings }
  | { kind: "taper"; settings: TaperSettings }
  | { kind: "bend"; settings: BendSettings }
  | { kind: "stretch"; settings: StretchSettings }
  | { kind: "ffd"; settings: FfdSettings };

const DEFORM_NAMES_HE: Record<DeformKind, string> = {
  twist: "פיתול",
  taper: "התחדדות",
  bend: "כיפוף",
  stretch: "מתיחה",
  ffd: "עיוות חופשי",
};

/** Apply a deformation to a layer's body. */
export async function applyDeform(
  document: DesignDocument,
  layer: ShapeLayer,
  request: DeformRequest
): Promise<AdvancedOpOutcome> {
  const { solid } = await sourceSolid(document, layer);
  const volumeBefore = solid.volumeMm3();

  let result;
  switch (request.kind) {
    case "twist":
      result = twistSolid(solid, request.settings);
      break;
    case "taper":
      result = taperSolid(solid, request.settings);
      break;
    case "bend":
      result = bendSolid(solid, request.settings);
      break;
    case "stretch":
      result = stretchSolid(solid, request.settings);
      break;
    case "ffd":
      result = ffdSolid(solid, request.settings);
      break;
  }

  // A deformation can fold the surface through itself; the manifold gate is
  // what catches that and turns it into an honest message.
  if (result.status() !== "NoError") {
    const status = result.status();
    result.dispose();
    throw new OpError(
      `ה${DEFORM_NAMES_HE[request.kind]} יצר גוף לא תקין (${status}) — הגוף כנראה מתקפל על עצמו`,
      [
        "הקטינו את עוצמת העיוות",
        "הפעילו ״פישוט״ או ״תיקון רשת״ על הגוף לפני העיוות",
      ]
    );
  }
  assertValidResult(result, DEFORM_NAMES_HE[request.kind]);

  const nameHe = DEFORM_NAMES_HE[request.kind];
  // Read the volume BEFORE handing the solid over: solidToResultLayer
  // consumes it.
  const volumeAfter = result.volumeMm3();
  return {
    layer: solidToResultLayer(result, {
      nameHe: `${layer.name} — ${nameHe}`,
      provenance: {
        kind: "smoothResult",
        descriptionHe: nameHe,
        sourceLayerIds: [layer.id],
      },
      materialSlotId: layer.materialSlotId,
    }),
    warningsHe: [],
    volumeBeforeMm3: volumeBefore,
    volumeAfterMm3: volumeAfter,
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Turn a generator's solid into a placed layer.
 *
 * Generators build in their own local frame at the origin; this re-anchors
 * them exactly like an operation result, so they land on the plate and
 * rotate around themselves.
 */
export function generatorToLayer(
  solid: import("../kernel").Solid,
  nameHe: string,
  materialSlotId: string,
  descriptionHe: string
): ImportedMeshLayer {
  assertValidResult(solid, nameHe);
  return solidToResultLayer(solid, {
    nameHe,
    provenance: { kind: "stlImport", descriptionHe },
    materialSlotId,
  });
}

/** Fill a body's interior with a lattice. */
export async function applyLattice(
  document: DesignDocument,
  layer: ShapeLayer,
  settings: LatticeSettings
): Promise<AdvancedOpOutcome & { savedFraction: number }> {
  const { kernel, solid } = await sourceSolid(document, layer);
  const outcome = latticeFill(kernel, solid, settings);
  assertValidResult(outcome.solid, "מילוי סריג");
  const kindHe =
    settings.kind === "gyroid"
      ? "ג׳ירואיד"
      : settings.kind === "schwarzP"
        ? "שוורץ־P"
        : "חלת דבש";
  return {
    layer: solidToResultLayer(outcome.solid, {
      nameHe: `${layer.name} — סריג ${kindHe}`,
      provenance: {
        kind: "hollowResult",
        descriptionHe: `מילוי סריג ${kindHe}, תא ${settings.cellSizeMm} מ״מ`,
        sourceLayerIds: [layer.id],
      },
      materialSlotId: layer.materialSlotId,
    }),
    warningsHe: outcome.warningsHe,
    volumeBeforeMm3: outcome.volumeBeforeMm3,
    volumeAfterMm3: outcome.volumeAfterMm3,
    savedFraction: outcome.savedFraction,
  };
}
