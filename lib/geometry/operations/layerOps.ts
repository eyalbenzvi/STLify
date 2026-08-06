/**
 * Shared plumbing for layer-level geometry operations (booleans, cuts,
 * hollowing, ...). Operations materialize layers into world-space solids,
 * run kernel work, and package results as new ImportedMeshLayer records
 * whose mesh lives in the session mesh store.
 *
 * Result layers are re-anchored: the mesh is baked centred on its own XY
 * bounding-box centre with its lowest point at local z=0, and the layer
 * transform carries the world placement — so subsequent rotations and
 * scales pivot around the object itself, not the world origin.
 */

import type {
  DesignDocument,
  ImportedMeshLayer,
  MeshProvenance,
  ShapeLayer,
} from "@/types/design";
import { identityTransform, newId } from "@/types/design";
import { effectiveCombineMode, layerWorldMatrix } from "../buildDocument";
import type { GeometryKernel, Solid } from "../kernel";
import { matrix4ToManifoldMat4 } from "../transform";
import { buildShapeLayerSolid } from "../solids";
import { storeMesh } from "../meshStore";

/** Operation failure with a Hebrew user-facing message + fix suggestions. */
export class OpError extends Error {
  constructor(
    readonly messageHe: string,
    readonly suggestionsHe: string[] = []
  ) {
    super(messageHe);
    this.name = "OpError";
  }
}

/** Standard fix suggestions for failed boolean-style operations. */
export const BOOLEAN_FIX_SUGGESTIONS_HE = [
  "ודאו שהאובייקטים חופפים זה את זה (לא רק נוגעים)",
  "נסו לתקן את הרשתות (פעולת ״תיקון״ על שכבות מיובאות)",
  "הזיזו מעט אחד מהאובייקטים כדי להימנע ממשטחים חופפים במדויק",
  "פשטו רשתות מורכבות מאוד לפני הפעולה",
];

/**
 * Build a shape layer's solid in WORLD coordinates.
 * Returns null when the layer produces no geometry (e.g. empty text).
 */
export async function materializeWorldSolid(
  kernel: GeometryKernel,
  document: DesignDocument,
  layer: ShapeLayer
): Promise<Solid | null> {
  const combine = effectiveCombineMode(document, layer);
  const local = await buildShapeLayerSolid(
    kernel,
    layer,
    // Ops always want the layer's positive body, not a cutter/flush pose.
    combine === "engraved" || combine === "inlay" ? "raised" : combine
  );
  if (!local) return null;
  return local.transform(matrix4ToManifoldMat4(layerWorldMatrix(document, layer)));
}

export interface ResultLayerOptions {
  nameHe: string;
  provenance: MeshProvenance;
  materialSlotId: string;
  /** Keep a copy of the pre-operation mesh as the recoverable original. */
  originalMeshId?: string | null;
}

/**
 * Convert a world-space result solid into an ImportedMeshLayer.
 * Consumes the solid.
 */
export function solidToResultLayer(
  solid: Solid,
  options: ResultLayerOptions
): ImportedMeshLayer {
  const bounds = solid.boundingBox();
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cy = (bounds.min.y + bounds.max.y) / 2;
  const minZ = bounds.min.z;
  const rebased = solid.translate(-cx, -cy, -minZ);
  const mesh = rebased.toMeshData();
  rebased.dispose();
  const meshId = storeMesh(mesh);
  return {
    id: newId("layer"),
    type: "importedMesh",
    name: options.nameHe,
    visible: true,
    locked: false,
    materialSlotId: options.materialSlotId,
    transform: { ...identityTransform(), x: cx, y: cy, z: minZ },
    previewOpacity: 1,
    meshId,
    provenance: options.provenance,
    originalMeshId: options.originalMeshId ?? null,
    combine: "standalone",
  };
}

/** Assert a result solid is a valid non-empty manifold, else throw OpError. */
export function assertValidResult(solid: Solid, contextHe: string): void {
  const status = solid.status();
  if (status !== "NoError") {
    solid.dispose();
    throw new OpError(
      `${contextHe}: הליבה הגיאומטרית דיווחה על תוצאה לא תקינה (${status})`,
      BOOLEAN_FIX_SUGGESTIONS_HE
    );
  }
  if (solid.isEmpty() || solid.numTriangles() === 0) {
    solid.dispose();
    throw new OpError(`${contextHe}: התוצאה ריקה — לא נותר חומר`, [
      "בדקו שהאובייקטים חופפים",
      "בדקו את כיוון הפעולה (מי מחסיר את מי)",
    ]);
  }
}
