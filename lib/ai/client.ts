/**
 * Client for the AI worker, with an in-process fallback.
 *
 * Mirrors lib/geometry/jobs/client.ts: the worker is created lazily, jobs
 * are addressed by id, and where a worker cannot exist (SSR, vitest,
 * browsers where creation fails) the same job runs on the calling thread
 * and the outcome says so. Cancellation aborts the model download too.
 */

import {
  AiJobCancelledError,
  executeAiJob,
  type AiJobMap,
  type AiJobName,
} from "./jobs";
import type { AiSessionFactory } from "./onnx";
import type { AiWorkerInbound, AiWorkerOutbound } from "./aiWorker";
import { aiTestModeEnabled, fakeAiResult } from "./testMode";

export interface RunAiJobOptions {
  onProgress?: (fraction: number, labelHe: string) => void;
  signal?: AbortSignal;
  /** Force the in-process path (used by tests). */
  forceInProcess?: boolean;
  /** Test-only session injection; honoured on the in-process path. */
  sessionFactory?: AiSessionFactory;
}

export interface AiJobOutcome<T> {
  result: T;
  /** Which execution path actually ran. */
  ranOn: "worker" | "main";
}

let workerInstance: Worker | null = null;
let workerUnavailable = false;
let nextJobId = 1;

interface PendingAiJob {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onProgress?: (fraction: number, labelHe: string) => void;
}

const pending = new Map<number, PendingAiJob>();

function getWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (workerInstance) return workerInstance;
  if (typeof Worker === "undefined" || typeof window === "undefined") {
    workerUnavailable = true;
    return null;
  }
  try {
    workerInstance = new Worker(new URL("./aiWorker.ts", import.meta.url), {
      type: "module",
    });
    workerInstance.onmessage = (event: MessageEvent<AiWorkerOutbound>) => {
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
          job.reject(new AiJobCancelledError());
          break;
        case "error":
          pending.delete(message.id);
          job.reject(new Error(message.messageHe));
          break;
      }
    };
    workerInstance.onerror = () => {
      for (const [, job] of pending) {
        job.reject(new Error("עובד ה-AI נכשל — הפעולה תרוץ בחלון הראשי"));
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

/**
 * Run an AI job, preferring the worker. Rejects with AiJobCancelledError
 * when aborted, so callers can tell "changed their mind" from "failed".
 */
export async function runAiJob<K extends AiJobName>(
  name: K,
  payload: AiJobMap[K]["payload"],
  options: RunAiJobOptions = {}
): Promise<AiJobOutcome<AiJobMap[K]["result"]>> {
  if (options.signal?.aborted) throw new AiJobCancelledError();

  // The e2e mock boundary: deterministic shapes, full downstream pipeline.
  if (aiTestModeEnabled()) {
    options.onProgress?.(1, "מצב בדיקה");
    return { result: fakeAiResult(name, payload), ranOn: "main" };
  }

  const worker = options.forceInProcess || options.sessionFactory ? null : getWorker();
  if (worker) {
    const id = nextJobId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress: options.onProgress });
    });
    const abort = () => {
      const message: AiWorkerInbound = { type: "cancel", id };
      worker.postMessage(message);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const request: AiWorkerInbound = { type: "run", id, name, payload };
    try {
      const transfer =
        payload.rgba.buffer instanceof ArrayBuffer ? [payload.rgba.buffer] : [];
      worker.postMessage(request, transfer);
      const result = (await promise) as AiJobMap[K]["result"];
      return { result, ranOn: "worker" };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      pending.delete(id);
    }
  }

  // In-process fallback. Yield once so a busy indicator can paint first.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = await executeAiJob(name, payload, {
    onProgress: (fraction, labelHe) => options.onProgress?.(fraction, labelHe),
    throwIfCancelled: () => {
      if (options.signal?.aborted) throw new AiJobCancelledError();
    },
    signal: options.signal,
    sessionFactory: options.sessionFactory,
  });
  return { result, ranOn: "main" };
}

/** Tear the AI worker down (editor unmount). */
export function disposeAiWorker(): void {
  workerInstance?.terminate();
  workerInstance = null;
  pending.clear();
}

export { AiJobCancelledError };
export type { AiJobMap, AiJobName };
