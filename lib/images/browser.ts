"use client";

/**
 * Browser-side image helpers: file decoding, RawImage ↔ canvas/data-URL
 * conversion, and the background-removal client (worker orchestration with
 * a main-thread fallback).
 *
 * Heavy work is lazy: nothing here loads until an image feature is used.
 */

import type { RawImage } from "./raster";
import type { BgRemovalRequest, BgRemovalResponse } from "./bgRemoval.worker";
import { removeBackgroundAuto } from "./removeBackground";

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
export const IMAGE_MAX_DIM = 8192;
/** Working resolution for processing / storage (largest side). */
export const IMAGE_PROCESS_DIM = 1024;

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg"]);

/** Validate basic file facts. Returns a Hebrew error or null. */
export function validateImageFile(file: File): string | null {
  const name = file.name.toLowerCase();
  const extOk = [".png", ".jpg", ".jpeg"].some((ext) => name.endsWith(ext));
  if (!extOk) return "יש לבחור קובץ PNG או JPG";
  if (file.type && !ACCEPTED_TYPES.has(file.type)) {
    return "סוג הקובץ אינו נתמך — יש להעלות PNG או JPG";
  }
  if (file.size === 0) return "הקובץ ריק";
  if (file.size > IMAGE_MAX_BYTES) {
    return `הקובץ גדול מדי (מקסימום ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB)`;
  }
  return null;
}

export interface DecodedImage {
  raw: RawImage;
  dataUrl: string;
  originalWidth: number;
  originalHeight: number;
}

/**
 * Decode an image file, downscale to the working resolution, and produce a
 * PNG data URL for session storage. Throws Hebrew-message errors.
 */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("לא ניתן לפענח את התמונה — ייתכן שהקובץ פגום");
  }
  try {
    if (bitmap.width < 4 || bitmap.height < 4) {
      throw new Error("התמונה קטנה מדי (מינימום 4×4 פיקסלים)");
    }
    if (bitmap.width > IMAGE_MAX_DIM || bitmap.height > IMAGE_MAX_DIM) {
      throw new Error(`מידות התמונה גדולות מדי (מקסימום ${IMAGE_MAX_DIM} פיקסלים לצלע)`);
    }
    const scale = Math.min(1, IMAGE_PROCESS_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas אינו זמין בדפדפן זה");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    return {
      raw: { width: w, height: h, data: imageData.data },
      dataUrl: canvas.toDataURL("image/png"),
      originalWidth: bitmap.width,
      originalHeight: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

/** Decode a data URL back into a RawImage (used for session assets). */
export async function dataUrlToRaw(dataUrl: string): Promise<RawImage> {
  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("לא ניתן לטעון את נתוני התמונה"));
    image.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas אינו זמין");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: data.data };
}

/** Render a RawImage into a PNG data URL. */
export function rawToDataUrl(raw: RawImage): string {
  const canvas = document.createElement("canvas");
  canvas.width = raw.width;
  canvas.height = raw.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas אינו זמין");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(raw.data), raw.width, raw.height), 0, 0);
  return canvas.toDataURL("image/png");
}

/** Encode a 0/255 mask as a grayscale PNG data URL. */
export function maskToDataUrl(mask: Uint8Array, width: number, height: number): string {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < mask.length; i++) {
    rgba[i * 4] = mask[i];
    rgba[i * 4 + 1] = mask[i];
    rgba[i * 4 + 2] = mask[i];
    rgba[i * 4 + 3] = 255;
  }
  return rawToDataUrl({ width, height, data: rgba });
}

/** Decode a mask data URL back into a byte-per-pixel mask. */
export async function dataUrlToMask(dataUrl: string): Promise<{ mask: Uint8Array; width: number; height: number }> {
  const raw = await dataUrlToRaw(dataUrl);
  const mask = new Uint8Array(raw.width * raw.height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = raw.data[i * 4] >= 128 ? 255 : 0;
  }
  return { mask, width: raw.width, height: raw.height };
}

// ---------------------------------------------------------------------------
// Background-removal client
// ---------------------------------------------------------------------------

export interface BgRemovalHandle {
  promise: Promise<{ mask: Uint8Array; backgroundFraction: number }>;
  cancel: () => void;
}

/**
 * Run automatic background removal, preferring a Web Worker. Falls back to
 * the main thread when workers are unavailable. Cancellation terminates the
 * worker (fallback runs are not cancellable but are fast at ≤1024px).
 */
export function runBackgroundRemoval(
  raw: RawImage,
  tolerance: number,
  onProgress: (fraction: number) => void
): BgRemovalHandle {
  if (typeof Worker !== "undefined") {
    try {
      const worker = new Worker(new URL("./bgRemoval.worker.ts", import.meta.url));
      let cancelled = false;
      const promise = new Promise<{ mask: Uint8Array; backgroundFraction: number }>(
        (resolve, reject) => {
          worker.onmessage = (event: MessageEvent<BgRemovalResponse>) => {
            const msg = event.data;
            if (msg.type === "progress") onProgress(msg.value);
            else if (msg.type === "done") {
              worker.terminate();
              resolve({ mask: new Uint8Array(msg.mask), backgroundFraction: msg.backgroundFraction });
            } else if (msg.type === "error") {
              worker.terminate();
              reject(new Error(msg.message));
            }
          };
          worker.onerror = () => {
            worker.terminate();
            if (!cancelled) reject(new Error("עיבוד ברקע נכשל"));
          };
          const buffer = raw.data.buffer.slice(0) as ArrayBuffer;
          const request: BgRemovalRequest = {
            type: "run",
            width: raw.width,
            height: raw.height,
            buffer,
            tolerance,
          };
          worker.postMessage(request, [buffer]);
        }
      );
      return {
        promise,
        cancel: () => {
          cancelled = true;
          worker.terminate();
        },
      };
    } catch {
      // fall through to the main-thread path
    }
  }
  // Main-thread fallback (still asynchronous so the UI can paint a spinner).
  const promise = new Promise<{ mask: Uint8Array; backgroundFraction: number }>(
    (resolve, reject) => {
      setTimeout(() => {
        try {
          const result = removeBackgroundAuto(raw, { tolerance, onProgress });
          resolve({ mask: result.mask, backgroundFraction: result.backgroundFraction });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }, 30);
    }
  );
  return { promise, cancel: () => undefined };
}
