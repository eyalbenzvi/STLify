"use client";

/**
 * React binding for the geometry job runner.
 *
 * The worker, its registry and its client were all built and tested, but no
 * component ever called them — so every heavy operation still ran on the main
 * thread and froze the tab. This hook is the missing wire.
 *
 * It owns the three things a long operation needs and a plain `await` cannot
 * provide: a progress fraction, a cancel button that actually stops the work,
 * and an honest indication of whether the job got off the main thread at all
 * (it does not, under SSR or in a browser where worker creation fails).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  disposeGeometryWorker,
  geometryWorkerAvailable,
  JobCancelledError,
  runGeometryJob,
  type GeometryJobMap,
  type GeometryJobName,
} from "@/lib/geometry/jobs/client";

export interface JobProgress {
  /** Hebrew label of the running operation. */
  labelHe: string;
  /** 0..1, or null when the job has not reported yet. */
  fraction: number | null;
  /** Hebrew label of the current stage. */
  stageHe: string;
  /** False when the job fell back to the main thread. */
  offThread: boolean;
}

export interface UseGeometryJobs {
  progress: JobProgress | null;
  /** True while a job is running. */
  busy: boolean;
  /**
   * Whether jobs will run off the main thread. A FUNCTION, not state:
   * probing lazily creates the worker, which must not happen during render.
   */
  isWorkerAvailable: () => boolean;
  /**
   * Run a job. Resolves with the result, or null when the user cancelled —
   * cancelling is not an error and must not raise a failure dialog.
   */
  run: <K extends GeometryJobName>(
    name: K,
    payload: GeometryJobMap[K]["payload"],
    labelHe: string,
    options?: {
      /**
       * Buffers to move to the worker instead of "transfer everything in the
       * payload". Required when the payload references long-lived buffers
       * (mesh store, live viewport meshes) — pass [] to clone, or copies.
       */
      transferables?: ArrayBuffer[];
    }
  ) => Promise<GeometryJobMap[K]["result"] | null>;
  cancel: () => void;
}

export function useGeometryJobs(): UseGeometryJobs {
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // Tear the worker down when the editor unmounts. Creating it is deferred to
  // the first job, so nothing is spun up for a user who never runs one.
  useEffect(() => () => disposeGeometryWorker(), []);

  const run = useCallback(
    async <K extends GeometryJobName>(
      name: K,
      payload: GeometryJobMap[K]["payload"],
      labelHe: string,
      options?: { transferables?: ArrayBuffer[] }
    ): Promise<GeometryJobMap[K]["result"] | null> => {
      // A second job would fight the first over the same worker slot and the
      // same progress state; the caller's buttons are disabled while busy,
      // but guard anyway.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      const offThread = geometryWorkerAvailable();
      setProgress({ labelHe, fraction: null, stageHe: "מתחיל…", offThread });

      try {
        const outcome = await runGeometryJob(name, payload, {
          signal: controller.signal,
          transferables: options?.transferables,
          onProgress: (fraction, stageHe) =>
            setProgress({ labelHe, fraction, stageHe, offThread }),
        });
        return outcome.result;
      } catch (err) {
        if (err instanceof JobCancelledError) return null;
        throw err;
      } finally {
        // Both lines belong INSIDE the guard. A superseded job's rejection
        // settles a microtask after the new job has already set its own
        // progress, so clearing unconditionally hid the overlay — and flipped
        // `busy` to false — while the replacement was still running.
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setProgress(null);
        }
      }
    },
    []
  );

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { progress, busy: progress !== null, isWorkerAvailable: geometryWorkerAvailable, run, cancel };
}
