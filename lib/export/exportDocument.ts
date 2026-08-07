/**
 * Turning a built document into a downloadable file.
 *
 * Four output kinds, one per row of the export dialog, and the differences
 * between them are real rather than cosmetic:
 *
 *  - `design` — the portable .formadesign.json. The only kind that does not
 *    need a successful geometry build.
 *  - `stl` — every part merged into ONE body in world space. STL carries no
 *    material information, so painted regions are deliberately not split
 *    out: it would add seams to a file nobody can print in two colours.
 *  - `threemf` — local geometry plus a build transform per object, so the
 *    slicer sees movable objects; the layer hierarchy travels as assemblies.
 *  - `zip` — one STL per part plus a bilingual README.
 *
 * Each builder returns a named blob; the caller downloads it. Keeping the
 * download out of here is what lets the batch CLI and the tests use these.
 */

import {
  type DesignDocument,
  type ImportedMeshLayer,
  type MaterialSlot,
} from "@/types/design";
import { MATERIAL_PROFILES, USAGE_PROFILES } from "@/types/profiles";
import type { MeshData } from "@/lib/geometry/meshData";
import type { PrintablePart } from "@/lib/geometry/buildDocument";
import { meshDataToBinaryStl } from "./stlData";
import { buildMultiPartZip } from "./package";
import { buildThreeMf, matrixToThreeMfTransform } from "./threeMF";

/** Colour used in the 3MF when a part's material slot no longer exists. */
const UNKNOWN_SLOT_COLOR_HEX = "#8a8f98";

export interface NamedBlob {
  blob: Blob;
  fileName: string;
}

/**
 * Concatenate every part's world-space geometry into a single indexed mesh.
 * Vertices are appended and each part's indices shifted by the running
 * vertex offset — no welding, because the parts are separate bodies.
 */
export function mergePartsToMesh(parts: readonly PrintablePart[]): MeshData {
  let totalPositions = 0;
  let totalIndices = 0;
  for (const part of parts) {
    totalPositions += part.worldMesh.positions.length;
    totalIndices += part.worldMesh.indices.length;
  }
  const positions = new Float32Array(totalPositions);
  const indices = new Uint32Array(totalIndices);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const part of parts) {
    positions.set(part.worldMesh.positions, vertexOffset * 3);
    for (let i = 0; i < part.worldMesh.indices.length; i++) {
      indices[indexOffset + i] = part.worldMesh.indices[i] + vertexOffset;
    }
    vertexOffset += part.worldMesh.positions.length / 3;
    indexOffset += part.worldMesh.indices.length;
  }
  return { positions, indices };
}

/**
 * Generated supports export as SUPPORT objects, not model bodies —
 * otherwise the slicer gives them full perimeters and infill and they come
 * out too strong to snap off.
 */
function partRole(
  document: DesignDocument,
  part: PrintablePart
): "model" | "support" {
  const layer = document.layers.find((l) => l.id === part.primaryLayerId);
  return layer?.type === "importedMesh" && layer.provenance.kind === "supportResult"
    ? "support"
    : "model";
}

/** Hebrew handling note for a print aid, shown in the ZIP's README. */
export function printAidNoteHe(
  document: DesignDocument,
  part: PrintablePart
): string | undefined {
  const layer = document.layers.find((l) => l.id === part.primaryLayerId);
  if (layer?.type !== "importedMesh") return undefined;
  switch (layer.provenance.kind) {
    case "supportResult":
      return "חלק תמיכה — הדפיסו בהגדרות תמיכה (ללא מילוי מלא) והסירו לאחר ההדפסה";
    case "brimResult":
      return "Brim — טבעת הצמדה למשטח; קלפו אותה מהחלק לאחר ההדפסה";
    case "raftResult":
      return "Raft — משטח בסיס; הפרידו את החלק ממנו לאחר ההדפסה";
    default:
      return undefined;
  }
}

/** The material profile the document's usage profile suggests. */
function documentMaterialName(document: DesignDocument): string {
  const usage = USAGE_PROFILES.find((u) => u.id === document.usageProfileId);
  const material =
    MATERIAL_PROFILES.find((m) => m.id === usage?.suggestedMaterialId) ??
    MATERIAL_PROFILES[0];
  return material.nameHe;
}

function slotOf(
  document: DesignDocument,
  part: PrintablePart
): MaterialSlot | undefined {
  return document.materialSlots.find((s) => s.id === part.materialSlotId);
}

/** Every part merged into one binary STL, in world space. */
export function buildStlExport(
  parts: readonly PrintablePart[],
  fileName: string
): NamedBlob {
  return {
    blob: meshDataToBinaryStl(mergePartsToMesh(parts)),
    fileName: `${fileName}.stl`,
  };
}

/**
 * 3MF with per-object build transforms and assembly parenting.
 *
 * Geometry goes in LOCAL coordinates with the placement carried by a build
 * transform, so repositioning in the slicer needs no re-bake here. A child
 * layer's part rides its parent's assembly object at its relative placement.
 */
export function buildThreeMfExport(
  document: DesignDocument,
  parts: readonly PrintablePart[],
  fileName: string
): NamedBlob {
  const materialName = documentMaterialName(document);
  const objects = parts.map((part) => {
    const slot = slotOf(document, part);
    const layer = document.layers.find((l) => l.id === part.primaryLayerId);
    const parentPart = layer?.parentId
      ? parts.find((p) => p.primaryLayerId === layer.parentId)
      : undefined;
    return {
      id: part.id,
      name: part.nameHe,
      colorHex: slot?.colorHex ?? UNKNOWN_SLOT_COLOR_HEX,
      materialName: slot ? `${slot.nameHe} (${materialName})` : materialName,
      vertices: part.localMesh.positions,
      triangles: part.localMesh.indices,
      role: partRole(document, part),
      buildTransform: matrixToThreeMfTransform(part.worldMatrix.elements),
      parentId: parentPart?.id ?? null,
      relativeTransform: parentPart
        ? matrixToThreeMfTransform(
            parentPart.worldMatrix.clone().invert().multiply(part.worldMatrix).elements
          )
        : undefined,
    };
  });
  return { blob: buildThreeMf(objects, fileName), fileName: `${fileName}.3mf` };
}

/** One STL per part plus a bilingual README, zipped. */
export async function buildZipExport(
  document: DesignDocument,
  parts: readonly PrintablePart[],
  fileName: string
): Promise<NamedBlob> {
  const blob = await buildMultiPartZip(
    parts.map((part, index) => ({
      fileBaseName: `${fileName}-${index + 1}-${part.nameHe}`,
      nameHe: part.nameHe,
      mesh: part.worldMesh,
      materialSlot: slotOf(document, part) ?? null,
      triangleCount: part.stats.triangleCount,
      printAidHe: printAidNoteHe(document, part),
    })),
    {
      designName: fileName,
      connectorsInfoHe: document.layers
        .filter(
          (l): l is ImportedMeshLayer =>
            l.type === "importedMesh" && l.provenance.kind === "connectorResult"
        )
        .map((l) => l.provenance.descriptionHe ?? "מחברים"),
    }
  );
  return { blob, fileName: `${fileName}.zip` };
}
