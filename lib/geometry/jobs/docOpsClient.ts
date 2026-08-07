/**
 * Client-side plumbing for the document-level operation jobs (boolean,
 * hollow, thicken, drain holes).
 *
 * The operations run where the job runner puts them — in the worker when one
 * exists. Two asymmetries need handling here:
 *
 *  - OUTBOUND: operand layers may reference meshes the worker has not seen;
 *    `docOpMeshSync` collects payload copies through the shared bookkeeping
 *    (meshSync.ts), so meshes the build already synced are not re-sent.
 *  - INBOUND: the result layer references a mesh that exists only in the
 *    worker's store; `adoptDocOpResult` stores the returned payload locally
 *    under the same id. In-process runs already stored it — the overwrite is
 *    an identical no-op.
 */

import type { DesignLayer } from "@/types/design";
import { storeMesh } from "../meshStore";
import { collectUnsyncedMeshes } from "./meshSync";
import type { DocOpJobResult } from "./registry";

/** Unsynced mesh payloads for the given operand layers. */
export function docOpMeshSync(layers: readonly DesignLayer[]): ReturnType<typeof collectUnsyncedMeshes> {
  const ids: string[] = [];
  for (const layer of layers) {
    const l = layer as { type: string; meshId?: string | null };
    if ((l.type === "importedMesh" || l.type === "imageRelief") && l.meshId) {
      ids.push(l.meshId);
    }
  }
  return collectUnsyncedMeshes(ids);
}

/** Make the result layer's mesh resolvable on this thread. */
export function adoptDocOpResult<T extends DocOpJobResult>(result: T): T {
  storeMesh(result.resultMesh, result.layer.meshId);
  return result;
}
