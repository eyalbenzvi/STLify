/**
 * Ties the bounded undo history (history.ts) to the session mesh store.
 *
 * History entries are cheap structural shares — EXCEPT the meshes that
 * imported-mesh and relief layers reference by id. Once an entry falls off
 * the old end of the bounded history, a mesh only that entry referenced can
 * never be reached again, but the store would keep it alive forever. This
 * sweep runs after every history change and frees exactly those meshes.
 *
 * `extraReferenced` covers meshes that are stored but not yet committed to
 * any document — an STL import whose preview dialog is still open. Without
 * it, an edit made while the dialog is open would sweep the pending mesh out
 * from under the confirm button.
 */

import type { EditorHistoryState } from "@/types/design";
import { garbageCollect, type GarbageCollectResult } from "@/lib/geometry/meshStore";
import { referencedMeshIds } from "./history";

export function sweepUnreferencedMeshes(
  state: EditorHistoryState,
  extraReferenced: Iterable<string> = []
): GarbageCollectResult {
  const referenced = referencedMeshIds(state);
  for (const id of extraReferenced) referenced.add(id);
  return garbageCollect(referenced);
}
