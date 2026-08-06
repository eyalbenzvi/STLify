/**
 * Session-scoped store for heavy mesh payloads referenced by layers via
 * `meshId`. Deliberately NOT persisted anywhere (no localStorage/IndexedDB):
 * meshes live only for the current browser session, exactly like the design
 * document itself. The portable design file embeds the payloads explicitly.
 */

import { newId } from "@/types/design";
import type { MeshData } from "./meshData";

const meshes = new Map<string, MeshData>();

export function storeMesh(mesh: MeshData, id?: string): string {
  const meshId = id ?? newId("mesh");
  meshes.set(meshId, mesh);
  return meshId;
}

export function getMesh(meshId: string): MeshData | null {
  return meshes.get(meshId) ?? null;
}

export function hasMesh(meshId: string): boolean {
  return meshes.has(meshId);
}

/** Ids currently stored (used by portable-file export to embed payloads). */
export function listMeshIds(): string[] {
  return [...meshes.keys()];
}

/**
 * Remove meshes that are no longer referenced by any of the given id sets
 * (current document + full undo/redo history). Called sparingly.
 */
export function garbageCollect(referenced: ReadonlySet<string>): void {
  for (const id of meshes.keys()) {
    if (!referenced.has(id)) meshes.delete(id);
  }
}

/** Test helper — clears the store. */
export function clearMeshStore(): void {
  meshes.clear();
}
