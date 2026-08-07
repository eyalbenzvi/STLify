/**
 * Mesh synchronisation between the main thread's mesh store and the worker.
 *
 * Layers reference heavy meshes by id, and each thread has its own store.
 * A mesh is COPIED once, transferred to the worker, and remembered as known
 * — later jobs send only ids. The copy is deliberate: transferring the
 * store's own buffers would detach them on the main thread and break the
 * viewport, exports, and everything else still using them.
 *
 * Result meshes flow the other way: a job that creates a new mesh in the
 * worker returns its payload; `adoptWorkerMesh` stores it locally under the
 * SAME id and marks it known, because the worker already holds it.
 *
 * A crashed-and-recreated worker starts with an empty store, so the
 * bookkeeping resets when the worker generation changes.
 */

import type { MeshData } from "../meshData";
import { getMesh, storeMesh } from "../meshStore";
import { workerGeneration } from "./client";

export interface MeshSeed {
  id: string;
  mesh: MeshData;
}

let knownMeshes = new Set<string>();
let knownGeneration = -1;

function syncGeneration(): void {
  const generation = workerGeneration();
  if (generation !== knownGeneration) {
    knownMeshes = new Set();
    knownGeneration = generation;
  }
}

/**
 * Collect payload copies for every referenced mesh the worker has not seen,
 * plus the transfer list for postMessage (the copies' buffers — never the
 * store's own).
 */
export function collectUnsyncedMeshes(meshIds: Iterable<string>): {
  meshes: MeshSeed[];
  transferables: ArrayBuffer[];
} {
  syncGeneration();
  const meshes: MeshSeed[] = [];
  const transferables: ArrayBuffer[] = [];
  for (const id of new Set(meshIds)) {
    if (knownMeshes.has(id)) continue;
    const mesh = getMesh(id);
    if (!mesh) continue; // a missing mesh is the job's own error to report
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    meshes.push({ id, mesh: { positions, indices } });
    transferables.push(positions.buffer, indices.buffer);
  }
  return { meshes, transferables };
}

/** Record that the worker now holds these meshes (call only on success). */
export function markMeshesSynced(meshes: MeshSeed[], ranOn: "worker" | "main"): void {
  if (ranOn !== "worker") return;
  syncGeneration();
  for (const { id } of meshes) knownMeshes.add(id);
}

/**
 * Store a mesh the WORKER created into the local store under the same id,
 * and mark it known so future jobs do not send it back.
 */
export function adoptWorkerMesh(id: string, mesh: MeshData, ranOn: "worker" | "main"): void {
  if (ranOn === "worker") {
    storeMesh(mesh, id);
    syncGeneration();
    knownMeshes.add(id);
  }
  // In-process the op already stored it in the (shared) local store.
}

/** Mesh ids a document's layers resolve through the mesh store. */
export function documentMeshIds(layers: readonly { visible?: boolean; type: string }[]): string[] {
  const ids: string[] = [];
  for (const layer of layers) {
    const l = layer as { visible: boolean; type: string; meshId?: string | null };
    if (!l.visible) continue;
    if (l.type === "importedMesh" && l.meshId) ids.push(l.meshId);
    else if (l.type === "imageRelief" && l.meshId) ids.push(l.meshId);
  }
  return ids;
}
