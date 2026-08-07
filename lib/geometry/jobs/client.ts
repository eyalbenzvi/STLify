/**
 * Client for the geometry worker, with an in-process fallback.
 *
 * The fallback is not a nicety: this code runs under SSR (no `Worker`), in
 * vitest (jsdom, no module workers), and in browsers where worker creation
 * can fail outright. A job must always be runnable, so `runGeometryJob`
 * degrades to executing the same registry handler on the calling thread and
 * reports which path it took, rather than silently doing nothing.
 */

import {
  collectTransferables,
  executeJob,
  JobCancelledError,
  type GeometryJobMap,
  type GeometryJobName,
} from "./registry";
import type { WorkerInbound, WorkerOutbound } from "./worker";

export interface RunJobOptions {
  onProgress?: (fraction: number, labelHe: string) => void;
  /** Abort the job. In-process jobs stop at the next checkpoint. */
  signal?: AbortSignal;
  /** Force the in-process path (used by tests). */
  forceInProcess?: boolean;
}

export interface JobOutcome<T> {
  result: T;
  /** Which execution path actually ran. */
  ranOn: "worker" | "main";
}

let workerInstance: Worker | null = null;
let workerUnavailable = false;
let nextJobId = 1;

interface PendingJob {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onProgress?: (fraction: number, labelHe: string) => void;
}

const pending = new Map<number, PendingJob>();

/** Lazily create the worker; returns null when workers are unusable here. */
function getWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (workerInstance) return workerInstance;
  if (typeof Worker === "undefined" || typeof window === "undefined") {
    workerUnavailable = true;
    return null;
  }
  try {
    // `new URL(..., import.meta.url)` is the form bundlers recognise.
    workerInstance = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    workerInstance.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const message = event.data;
      const job = pending.get(message.id);
      if (!job) return;
      switch (message.type) {
        case "progress":
          job.onProgress?.(message.fraction, message.labelHe);
          break;
        case "result":
          pending.delete(message.id);
          job.resolve(message.result);
          break;
        case "cancelled":
          pending.delete(message.id);
          job.reject(new JobCancelledError());
          break;
        case "error":
          pending.delete(message.id);
          job.reject(new Error(message.messageHe));
          break;
      }
    };
    workerInstance.onerror = () => {
      // A worker that fails to boot must not strand every queued job.
      for (const [, job] of pending) {
        job.reject(new Error("עובד הגאומטריה נכשל — הפעולה תרוץ בחלון הראשי"));
      }
      pending.clear();
      workerInstance?.terminate();
      workerInstance = null;
      workerUnavailable = true;
    };
    return workerInstance;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

/** True when heavy jobs will run off the main thread. */
export function geometryWorkerAvailable(): boolean {
  return getWorker() !== null;
}

/**
 * Run a geometry job, preferring the worker.
 *
 * Rejects with `JobCancelledError` when aborted, so callers can distinguish
 * "the user changed their mind" from "the operation failed".
 */
export async function runGeometryJob<K extends GeometryJobName>(
  name: K,
  payload: GeometryJobMap[K]["payload"],
  options: RunJobOptions = {}
): Promise<JobOutcome<GeometryJobMap[K]["result"]>> {
  if (options.signal?.aborted) throw new JobCancelledError();

  const worker = options.forceInProcess ? null : getWorker();
  if (worker) {
    const id = nextJobId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress: options.onProgress });
    });
    const abort = () => {
      const message: WorkerInbound = { type: "cancel", id };
      worker.postMessage(message);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const request: WorkerInbound = { type: "run", id, name, payload };
    try {
      worker.postMessage(request, collectTransferables(payload));
      const result = (await promise) as GeometryJobMap[K]["result"];
      return { result, ranOn: "worker" };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      pending.delete(id);
    }
  }

  // In-process fallback. Yield once so a busy indicator can paint before the
  // main thread is blocked.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = await executeJob(name, payload, {
    onProgress: (fraction, labelHe) => options.onProgress?.(fraction, labelHe),
    throwIfCancelled: () => {
      if (options.signal?.aborted) throw new JobCancelledError();
    },
  });
  return { result, ranOn: "main" };
}

/** Tear the worker down (used when the editor unmounts). */
export function disposeGeometryWorker(): void {
  workerInstance?.terminate();
  workerInstance = null;
  pending.clear();
}

export { JobCancelledError };
