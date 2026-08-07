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
import {
  applyEmbossToTarget,
  projectContoursOntoSurface,
  wrapContoursOnCylinder,
  type EmbossMode,
} from "./emboss";
import { layerContours } from "../solids";
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
  descriptionHe: string,
  // Print aids (supports/brim/raft) pass their own kind so the export can
  // mark them for the slicer instead of shipping them as model bodies.
  kind: ImportedMeshLayer["provenance"]["kind"] = "stlImport"
): ImportedMeshLayer {
  assertValidResult(solid, nameHe);
  return solidToResultLayer(solid, {
    nameHe,
    provenance: { kind, descriptionHe },
    materialSlotId,
  });
}

// ---------------------------------------------------------------------------
// Worker bridge
// ---------------------------------------------------------------------------

/**
 * Materialize a layer into a world-space mesh.
 *
 * The geometry worker can only receive transferable data, not kernel handles,
 * so operations routed off-thread need the layer flattened to a `MeshData`
 * first. Building the source solid is cheap; it is the operation that follows
 * (Minkowski, level set, remesh) that is worth moving off the main thread.
 */
export async function layerToWorldMesh(
  document: DesignDocument,
  layer: ShapeLayer
): Promise<import("../meshData").MeshData> {
  const { solid } = await sourceSolid(document, layer);
  const mesh = solid.toMeshData();
  solid.dispose();
  return mesh;
}

/**
 * Package a world-space mesh returned by a job into a replacement layer.
 *
 * Mirrors `solidToResultLayer` but takes mesh data, because a job's result
 * has already crossed the worker boundary and no longer has a kernel handle.
 */
export async function meshToResultLayer(
  mesh: import("../meshData").MeshData,
  options: {
    nameHe: string;
    descriptionHe: string;
    materialSlotId: string;
    sourceLayerId: string;
    kind?: ImportedMeshLayer["provenance"]["kind"];
  }
): Promise<ImportedMeshLayer> {
  const kernel = await getGeometryKernel();
  const { solid, status } = kernel.fromMeshData(mesh);
  if (status !== "NoError" || solid.isEmpty()) {
    solid.dispose();
    throw new OpError(`תוצאת הפעולה אינה גוף תקין (${status})`, [
      "נסו פרמטרים אחרים",
      "או הפעילו ״תיקון רשת״ על התוצאה",
    ]);
  }
  return solidToResultLayer(solid, {
    nameHe: options.nameHe,
    provenance: {
      kind: options.kind ?? "smoothResult",
      descriptionHe: options.descriptionHe,
      sourceLayerIds: [options.sourceLayerId],
    },
    materialSlotId: options.materialSlotId,
  });
}

// ---------------------------------------------------------------------------
// Revolve
// ---------------------------------------------------------------------------

export interface RevolveSettings {
  /** Sweep angle, degrees. 360 makes a full solid of revolution. */
  degreesSwept: number;
  /** Facets around the axis. */
  segments: number;
  /**
   * Distance from the profile's own left edge to the axis, mm. The profile is
   * shifted right by this much before revolving, so a profile drawn at the
   * origin does not turn inside out.
   */
  axisOffsetMm: number;
}

/**
 * Revolve a 2D profile into a solid of revolution.
 *
 * The kernel gained `revolve` in V4 but nothing exposed it, so vases, cups,
 * knobs and pulleys — the shapes it exists for — were unreachable.
 *
 * The profile revolves around the Y axis of its own plane, with +X becoming
 * the radius. A profile crossing x = 0 would sweep through itself, so the
 * caller supplies an offset that pushes it clear of the axis, and a profile
 * still crossing after the offset is refused with an explanation.
 */
export async function applyRevolve(
  document: DesignDocument,
  layer: ShapeLayer,
  settings: RevolveSettings
): Promise<AdvancedOpOutcome> {
  const kernel = await getGeometryKernel();
  if (
    layer.type !== "sketch" &&
    layer.type !== "svg" &&
    layer.type !== "text" &&
    !(layer.type === "imageRelief" && layer.mode === "silhouette")
  ) {
    throw new OpError("סיבוב פרופיל אפשרי רק על סקיצה, SVG, טקסט או צללית", [
      "צרו סקיצה עם הפרופיל שברצונכם לסובב",
    ]);
  }

  const { contours } = await layerContours(kernel, layer);
  if (contours.length === 0) throw new OpError(`לשכבה "${layer.name}" אין מתאר לסובב`);

  const shifted = contours.map((contour) =>
    contour.map(([x, y]): [number, number] => [x + settings.axisOffsetMm, y])
  );
  let minX = Infinity;
  for (const contour of shifted) for (const [x] of contour) if (x < minX) minX = x;
  if (minX < 0) {
    throw new OpError(
      `הפרופיל חוצה את ציר הסיבוב (חורג ב-${Math.abs(minX).toFixed(1)} מ״מ)`,
      [
        `הגדילו את המרחק מהציר לפחות ל-${(settings.axisOffsetMm - minX).toFixed(1)} מ״מ`,
        "או הזיזו את הצורות בסקיצה ימינה",
      ]
    );
  }

  const degrees = Math.max(1, Math.min(settings.degreesSwept, 360));
  const solid = kernel.revolve(shifted, degrees, Math.max(8, Math.round(settings.segments)));
  assertValidResult(solid, "סיבוב פרופיל");
  const volumeAfter = solid.volumeMm3();

  return {
    layer: solidToResultLayer(solid, {
      nameHe: `${layer.name} — סיבוב`,
      provenance: {
        kind: "smoothResult",
        descriptionHe: `סיבוב פרופיל ב-${degrees}°`,
        sourceLayerIds: [layer.id],
      },
      materialSlotId: layer.materialSlotId,
    }),
    warningsHe: [],
    volumeBeforeMm3: 0,
    volumeAfterMm3: volumeAfter,
  };
}

// ---------------------------------------------------------------------------
// Curved-surface emboss
// ---------------------------------------------------------------------------

export interface EmbossRequest {
  method: "cylinder" | "project";
  mode: EmbossMode;
  depthMm: number;
  /** Cylinder method. */
  radiusMm: number;
  axis: "x" | "y" | "z";
  aroundDeg: number;
  alongMm: number;
  /** Projection method. */
  direction: { x: number; y: number; z: number };
}

/**
 * Emboss or engrave one layer's artwork onto another layer's body.
 *
 * The engine could wrap and project but nothing connected the two layers, so
 * putting text on a mug was impossible from the UI. Both source and target
 * are materialised in WORLD space so the artwork lands where the user sees
 * the target, not where its local frame happens to be.
 */
export async function applyEmboss(
  document: DesignDocument,
  artworkLayer: ShapeLayer,
  targetLayer: ShapeLayer,
  request: EmbossRequest
): Promise<AdvancedOpOutcome & { hitFraction: number | null }> {
  const kernel = await getGeometryKernel();
  if (artworkLayer.id === targetLayer.id) {
    throw new OpError("שכבת הכיתוב ושכבת היעד חייבות להיות שונות");
  }

  const { contours } = await layerContours(
    kernel,
    artworkLayer as Parameters<typeof layerContours>[1]
  );
  if (contours.length === 0) {
    throw new OpError(`לשכבה "${artworkLayer.name}" אין מתאר להטבעה`, [
      "בחרו שכבת טקסט, SVG או סקיצה",
    ]);
  }

  const target = await materializeWorldSolid(kernel, document, targetLayer);
  if (!target) throw new OpError(`לשכבה "${targetLayer.name}" אין גוף לחרוט עליו`);
  const volumeBefore = target.volumeMm3();

  let artwork;
  let hitFraction: number | null = null;
  if (request.method === "cylinder") {
    artwork = wrapContoursOnCylinder(kernel, contours, {
      radiusMm: request.radiusMm,
      depthMm: request.depthMm,
      mode: request.mode,
      axis: request.axis,
      aroundDeg: request.aroundDeg,
      alongMm: request.alongMm,
    });
    // The wrap is built around the world origin; move it onto the target.
    const bounds = target.boundingBox();
    artwork = artwork.translate(
      (bounds.min.x + bounds.max.x) / 2,
      (bounds.min.y + bounds.max.y) / 2,
      (bounds.min.z + bounds.max.z) / 2
    );
  } else {
    const projected = projectContoursOntoSurface(kernel, contours, target.duplicate(), {
      depthMm: request.depthMm,
      mode: request.mode,
      direction: request.direction,
    });
    artwork = projected.solid;
    hitFraction = projected.hitFraction;
    if (projected.hitFraction < 0.2) {
      artwork.dispose();
      target.dispose();
      throw new OpError(
        `רק ${Math.round(projected.hitFraction * 100)}% מהכיתוב פגע במשטח היעד`,
        [
          "בדקו שהכיתוב נמצא מעל גוף היעד",
          "נסו כיוון הקרנה אחר",
        ]
      );
    }
  }

  const result = applyEmbossToTarget(target, artwork, request.mode);
  assertValidResult(result, "הטבעה על משטח");
  const volumeAfter = result.volumeMm3();

  const modeHe = request.mode === "raised" ? "הטבעה" : "חריטה";
  return {
    layer: solidToResultLayer(result, {
      nameHe: `${targetLayer.name} — ${modeHe}`,
      provenance: {
        kind: "booleanResult",
        descriptionHe: `${modeHe} של "${artworkLayer.name}" על משטח מעוקל`,
        sourceLayerIds: [targetLayer.id, artworkLayer.id],
      },
      materialSlotId: targetLayer.materialSlotId,
    }),
    warningsHe:
      hitFraction !== null && hitFraction < 0.95
        ? [`${Math.round(hitFraction * 100)}% מהכיתוב נחת על המשטח — השאר נותר במקומו`]
        : [],
    volumeBeforeMm3: volumeBefore,
    volumeAfterMm3: volumeAfter,
    hitFraction,
  };
}
