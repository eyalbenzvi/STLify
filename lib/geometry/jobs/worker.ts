/**
 * The geometry Web Worker.
 *
 * Runs jobs from the registry off the main thread so the UI keeps painting
 * while Minkowski sums, level sets and remeshing grind away. The worker owns
 * its own copy of the Manifold WASM module — the kernel is loaded lazily per
 * thread, so this costs one extra instantiation and buys a responsive tab.
 *
 * Protocol: one request per job id; the worker answers with progress
 * messages followed by exactly one result, error, or cancelled message.
 */

import {
  collectTransferables,
  executeJob,
  JobCancelledError,
  type GeometryJobName,
} from "./registry";

export interface JobRequestMessage {
  type: "run";
  id: number;
  name: GeometryJobName;
  payload: unknown;
}

export interface JobCancelMessage {
  type: "cancel";
  id: number;
}

export type WorkerInbound = JobRequestMessage | JobCancelMessage;

export type WorkerOutbound =
  | { type: "progress"; id: number; fraction: number; labelHe: string }
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; messageHe: string }
  | { type: "cancelled"; id: number };

const cancelled = new Set<number>();

self.onmessage = async (event: MessageEvent<WorkerInbound>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelled.add(message.id);
    return;
  }
  if (message.type !== "run") return;

  const { id, name, payload } = message;
  const post = (out: WorkerOutbound, transfer: ArrayBuffer[] = []) => {
    (self as unknown as Worker).postMessage(out, transfer);
  };

  try {
    const result = await executeJob(
      name,
      // The payload's shape is validated by the caller's typed wrapper; the
      // worker boundary is structurally typed only.
      payload as never,
      {
        onProgress: (fraction, labelHe) => post({ type: "progress", id, fraction, labelHe }),
        throwIfCancelled: () => {
          if (cancelled.has(id)) throw new JobCancelledError();
        },
      }
    );
    if (cancelled.has(id)) {
      cancelled.delete(id);
      post({ type: "cancelled", id });
      return;
    }
    post({ type: "result", id, result }, collectTransferables(result));
  } catch (err) {
    cancelled.delete(id);
    if (err instanceof JobCancelledError) {
      post({ type: "cancelled", id });
      return;
    }
    post({
      type: "error",
      id,
      messageHe: err instanceof Error ? err.message : String(err),
    });
  }
};
