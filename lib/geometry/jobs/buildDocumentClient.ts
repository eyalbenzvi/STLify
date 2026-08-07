/**
 * Client for the buildDocument job — the editor's HOT PATH.
 *
 * Every document edit rebuilds the printable parts. V5 ran that on the main
 * thread; this client routes it through the geometry worker with two pieces
 * of bookkeeping the generic job client cannot do:
 *
 *  1. MESH SYNC. Layers reference imported meshes by id, and the worker has
 *     its own mesh store. Each mesh is COPIED once, transferred to the
 *     worker, and remembered as known — later rebuilds send only ids. The
 *     copy is deliberate: transferring the store's own buffers would detach
 *     them on this thread. A crashed-and-recreated worker (workerGeneration)
 *     resets the bookkeeping.
 *
 *  2. WIRE REVIVAL. THREE.Matrix4 does not survive structured clone, so
 *     parts return with raw matrix elements and are revived here.
 *
 * When no worker can exist (SSR, vitest, blocked workers) the document is
 * built directly in-process — same code, honest `ranOn: "main"`.
 */

import * as THREE from "three";
import type { DesignDocument } from "@/types/design";
import {
  buildDocument,
  type DocumentBuildResult,
  type PrintablePart,
} from "../buildDocument";
import { geometryWorkerAvailable, runGeometryJob } from "./client";
import { collectUnsyncedMeshes, documentMeshIds, markMeshesSynced } from "./meshSync";
import type { BuildDocumentJobResult } from "./registry";

export interface BuildDocumentOutcome {
  result: DocumentBuildResult;
  /** Which execution path actually ran — reported honestly to the UI. */
  ranOn: "worker" | "main";
}

export interface BuildDocumentCallOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number, labelHe: string) => void;
  /** Force the direct path (used by tests to compare both paths). */
  forceInProcess?: boolean;
}

function reviveParts(wire: BuildDocumentJobResult): DocumentBuildResult {
  const parts: PrintablePart[] = wire.parts.map((part) => {
    const { worldMatrixElements, ...rest } = part;
    return { ...rest, worldMatrix: new THREE.Matrix4().fromArray(worldMatrixElements) };
  });
  return { status: wire.status, issues: wire.issues, parts };
}

export async function buildDocumentViaJob(
  document: DesignDocument,
  options: BuildDocumentCallOptions = {}
): Promise<BuildDocumentOutcome> {
  const useWorker = !options.forceInProcess && geometryWorkerAvailable();

  if (!useWorker) {
    // Direct call: no serialization, no mesh copies — and no wire round-trip
    // to distort the comparison tests.
    const result = await buildDocument(document, {
      onProgress: options.onProgress,
      throwIfCancelled: options.signal
        ? () => {
            if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
          }
        : undefined,
    });
    return { result, ranOn: "main" };
  }

  const { meshes, transferables } = collectUnsyncedMeshes(documentMeshIds(document.layers));

  const { result, ranOn } = await runGeometryJob(
    "buildDocument",
    { document, meshes },
    {
      signal: options.signal,
      onProgress: options.onProgress,
      transferables,
    }
  );
  // Mark as known only after success — a failed send retries the sync.
  markMeshesSynced(meshes, ranOn);
  return { result: reviveParts(result), ranOn };
}
