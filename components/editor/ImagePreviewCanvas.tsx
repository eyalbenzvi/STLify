"use client";

/**
 * Live preview of a session image asset with the layer's adjustments (and
 * background-removal mask) applied. Renders on a checkerboard so removed
 * regions are visibly transparent.
 */

import { useEffect, useRef } from "react";
import type { ImageAdjustments } from "@/types/design";
import { applyAdjustments } from "@/lib/images/raster";
import { resolveAsset } from "@/lib/design/assetResolver";

interface ImagePreviewCanvasProps {
  assetId: string;
  adjustments: ImageAdjustments;
  className?: string;
  maxHeight?: number;
}

export function ImagePreviewCanvas({
  assetId,
  adjustments,
  className = "",
  maxHeight = 200,
}: ImagePreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void resolveAsset(assetId).then((raw) => {
        if (cancelled || !raw) return;
        const processed = applyAdjustments(raw, adjustments);
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = processed.width;
        canvas.height = processed.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.putImageData(
          new ImageData(new Uint8ClampedArray(processed.data), processed.width, processed.height),
          0,
          0
        );
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [assetId, adjustments]);

  return (
    <canvas
      ref={canvasRef}
      className={`w-full rounded-md border border-slate-200 object-contain ${className}`}
      style={{
        maxHeight,
        backgroundImage:
          "repeating-conic-gradient(#e2e8f0 0% 25%, #f8fafc 0% 50%)",
        backgroundSize: "16px 16px",
      }}
      aria-label="תצוגה מקדימה של התמונה"
    />
  );
}
