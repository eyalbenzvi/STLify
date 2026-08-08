/**
 * The AI Web Worker: ONNX inference off the main thread.
 *
 * Mirrors lib/geometry/jobs/worker.ts — one request per job id, answered by
 * progress messages and exactly one result / error / cancelled message. The
 * one addition is a per-job AbortController, so cancelling a job also aborts
 * a model download in flight instead of letting it run to completion.
 */

import { AiJobCancelledError, executeAiJob, type AiJobName } from "./jobs";
import { AiError } from "./errors";

export interface AiJobRequestMessage {
  type: "run";
  id: number;
  name: AiJobName;
  payload: unknown;
}

export interface AiJobCancelMessage {
  type: "cancel";
  id: number;
}

export type AiWorkerInbound = AiJobRequestMessage | AiJobCancelMessage;

export type AiWorkerOutbound =
  | { type: "progress"; id: number; fraction: number; labelHe: string }
  | { type: "result"; id: number; result: unknown }
  | { type: "error"; id: number; messageHe: string }
  | { type: "cancelled"; id: number };

const cancelled = new Set<number>();
const aborters = new Map<number, AbortController>();

self.onmessage = async (event: MessageEvent<AiWorkerInbound>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelled.add(message.id);
    aborters.get(message.id)?.abort();
    return;
  }
  if (message.type !== "run") return;

  const { id, name, payload } = message;
  const post = (out: AiWorkerOutbound, transfer: ArrayBuffer[] = []) => {
    (self as unknown as Worker).postMessage(out, transfer);
  };

  const controller = new AbortController();
  aborters.set(id, controller);
  try {
    const result = await executeAiJob(name, payload as never, {
      onProgress: (fraction, labelHe) => post({ type: "progress", id, fraction, labelHe }),
      throwIfCancelled: () => {
        if (cancelled.has(id)) throw new AiJobCancelledError();
      },
      signal: controller.signal,
    });
    if (cancelled.has(id)) {
      post({ type: "cancelled", id });
      return;
    }
    const transfer = result.map.buffer instanceof ArrayBuffer ? [result.map.buffer] : [];
    post({ type: "result", id, result }, transfer);
  } catch (err) {
    if (err instanceof AiJobCancelledError || controller.signal.aborted) {
      post({ type: "cancelled", id });
      return;
    }
    post({
      type: "error",
      id,
      messageHe:
        err instanceof AiError
          ? err.messageHe
          : err instanceof Error
            ? err.message
            : String(err),
    });
  } finally {
    cancelled.delete(id);
    aborters.delete(id);
  }
};
