/**
 * Web Worker entry for background removal. Keeps the flood-fill off the UI
 * thread; cancellation is handled by terminating the worker.
 */

import { removeBackgroundAuto } from "./removeBackground";
import type { RawImage } from "./raster";

export interface BgRemovalRequest {
  type: "run";
  width: number;
  height: number;
  /** RGBA buffer (transferred). */
  buffer: ArrayBuffer;
  tolerance: number;
}

export type BgRemovalResponse =
  | { type: "progress"; value: number }
  | { type: "done"; mask: ArrayBuffer; backgroundFraction: number }
  | { type: "error"; message: string };

self.onmessage = (event: MessageEvent<BgRemovalRequest>) => {
  const msg = event.data;
  if (msg.type !== "run") return;
  try {
    const image: RawImage = {
      width: msg.width,
      height: msg.height,
      data: new Uint8ClampedArray(msg.buffer),
    };
    let lastReported = -1;
    const result = removeBackgroundAuto(image, {
      tolerance: msg.tolerance,
      onProgress: (value) => {
        const pct = Math.round(value * 100);
        if (pct !== lastReported) {
          lastReported = pct;
          const progress: BgRemovalResponse = { type: "progress", value };
          self.postMessage(progress);
        }
      },
    });
    const done: BgRemovalResponse = {
      type: "done",
      mask: result.mask.buffer as ArrayBuffer,
      backgroundFraction: result.backgroundFraction,
    };
    (self as unknown as Worker).postMessage(done, [result.mask.buffer as ArrayBuffer]);
  } catch (err) {
    const error: BgRemovalResponse = {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(error);
  }
};
