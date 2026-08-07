/**
 * Session-scoped store for heavy mesh payloads referenced by layers via
 * `meshId`.
 *
 * Meshes live only for the current browser session; the portable design file
 * embeds the payloads explicitly. (Crash recovery in
 * lib/serialization/crashRecovery.ts writes a single local snapshot — a
 * same-device safety net, not a document store.)
 *
 * MEMORY: a mesh is referenced by the current document AND by every undo and
 * redo entry, so nothing can be freed just because the live document stopped
 * using it. `garbageCollect` therefore takes the union of ids across the
 * whole history. Without a sweep the store only ever grows: an editing
 * session that runs twenty boolean operations on an imported STL keeps all
 * twenty intermediate meshes alive forever.
 */

import { newId } from "@/types/design";
import type { MeshData } from "./meshData";

const meshes = new Map<string, MeshData>();

/** Bytes held by one mesh payload. */
function meshBytes(mesh: MeshData): number {
  return mesh.positions.byteLength + mesh.indices.byteLength;
}

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

export interface MeshStoreStats {
  count: number;
  bytes: number;
}

/** What the store currently holds, for the memory indicator. */
export function meshStoreStats(): MeshStoreStats {
  let bytes = 0;
  for (const mesh of meshes.values()) bytes += meshBytes(mesh);
  return { count: meshes.size, bytes };
}

export interface GarbageCollectResult {
  removed: number;
  freedBytes: number;
  remaining: number;
  remainingBytes: number;
}

/**
 * Remove meshes not referenced by any of the given ids.
 *
 * The caller must pass the union over the CURRENT document and the full
 * undo/redo history — dropping a mesh that only a past state references would
 * make undo silently produce an empty layer.
 */
export function garbageCollect(referenced: ReadonlySet<string>): GarbageCollectResult {
  let removed = 0;
  let freedBytes = 0;
  for (const [id, mesh] of meshes) {
    if (referenced.has(id)) continue;
    freedBytes += meshBytes(mesh);
    meshes.delete(id);
    removed++;
  }
  const stats = meshStoreStats();
  return {
    removed,
    freedBytes,
    remaining: stats.count,
    remainingBytes: stats.bytes,
  };
}

/** Test helper — clears the store. */
export function clearMeshStore(): void {
  meshes.clear();
}
