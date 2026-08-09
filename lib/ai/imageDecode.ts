/**
 * Browser decode wrapper for the AI paths: image file → RGBA pixels at a
 * bounded size. The models squash to a square input themselves, so the
 * decode preserves aspect and only caps the longer side — the tensor
 * conversion (imageTensor.ts) does the final resample.
 *
 * Kept apart from lib/import/image.ts on purpose: that decode produces a
 * LUMINANCE grid with brightness/contrast/background applied, and the
 * models must see the original colours untouched.
 */

import { AiError } from "./errors";
import type { RgbaImage } from "./imageTensor";

/** Longer-side cap for the decoded RGBA handed to the models. */
const MAX_DECODE_EDGE = 1024;

export async function decodeImageToRgba(file: Blob): Promise<RgbaImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AiError(
      "לא ניתן לפענח את קובץ התמונה — הדפדפן אינו תומך בפורמט הזה (למשל HEIC מהאייפון). נסו PNG, JPG או WEBP"
    );
  }
  const scale = Math.min(1, MAX_DECODE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(2, Math.round(bitmap.width * scale));
  const height = Math.max(2, Math.round(bitmap.height * scale));

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : (() => {
          const c = document.createElement("canvas");
          c.width = width;
          c.height = height;
          return c;
        })();
  const ctx = canvas.getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) {
    bitmap.close();
    throw new AiError("הדפדפן אינו תומך בעיבוד תמונה");
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const data = ctx.getImageData(0, 0, width, height).data;
  return { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}
