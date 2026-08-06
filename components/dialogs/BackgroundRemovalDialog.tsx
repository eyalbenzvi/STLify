"use client";

/**
 * "הסרת רקע אוטומטית" — automatic background removal with progress, cancel,
 * before/after preview, tolerance adjustment, and Apply / Keep-original.
 * Fully client-side (Web Worker); on failure the user keeps the original
 * and is pointed at the threshold-mode + manual mask fallbacks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageReliefLayer } from "@/types/design";
import { deriveAssetWithMask, getAsset } from "@/lib/design/assets";
import { updateLayer } from "@/lib/design/store";
import {
  dataUrlToRaw,
  maskToDataUrl,
  runBackgroundRemoval,
  type BgRemovalHandle,
} from "@/lib/images/browser";
import type { RawImage } from "@/lib/images/raster";
import { applyMask } from "@/lib/images/raster";
import { Modal, PrimaryButton, SecondaryButton } from "@/components/ui/Modal";
import { SliderField } from "@/components/ui/SliderField";

interface BackgroundRemovalDialogProps {
  open: boolean;
  layer: ImageReliefLayer;
  onClose: () => void;
}

type Phase = "idle" | "running" | "preview" | "failed";

export function BackgroundRemovalDialog({ open, layer, onClose }: BackgroundRemovalDialogProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [tolerance, setTolerance] = useState(24);
  const [error, setError] = useState<string | null>(null);
  const [mask, setMask] = useState<Uint8Array | null>(null);
  const rawRef = useRef<RawImage | null>(null);
  const handleRef = useRef<BgRemovalHandle | null>(null);
  const beforeRef = useRef<HTMLCanvasElement | null>(null);
  const afterRef = useRef<HTMLCanvasElement | null>(null);

  const reset = useCallback(() => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setPhase("idle");
    setProgress(0);
    setError(null);
    setMask(null);
  }, []);

  useEffect(() => {
    if (!open) queueMicrotask(reset);
  }, [open, reset]);

  const run = useCallback(async () => {
    setPhase("running");
    setProgress(0);
    setError(null);
    try {
      const asset = getAsset(layer.assetId);
      if (!asset) throw new Error("קובץ המקור אינו זמין בהפעלה הנוכחית");
      // Always start from the ORIGINAL image (no existing mask) so the
      // operation is repeatable and reversible.
      const raw = await dataUrlToRaw(asset.dataUrl);
      rawRef.current = raw;
      const handle = runBackgroundRemoval(raw, tolerance, setProgress);
      handleRef.current = handle;
      const result = await handle.promise;
      if (result.backgroundFraction < 0.02) {
        setError(
          "לא זוהה רקע אחיד להסרה. אפשר לנסות סובלנות גבוהה יותר, מצב סף שחור-לבן, או עריכת מסכה ידנית."
        );
        setPhase("failed");
        return;
      }
      if (result.backgroundFraction > 0.98) {
        setError(
          "כמעט כל התמונה זוהתה כרקע — נסו סובלנות נמוכה יותר או עריכת מסכה ידנית."
        );
        setPhase("failed");
        return;
      }
      setMask(result.mask);
      setPhase("preview");
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "הסרת הרקע נכשלה. התמונה המקורית נשמרה — אפשר להשתמש במצב סף או בעריכת מסכה ידנית."
      );
      setPhase("failed");
    }
  }, [layer.assetId, tolerance]);

  // Draw before/after previews.
  useEffect(() => {
    if (phase !== "preview" || !mask || !rawRef.current) return;
    const raw = rawRef.current;
    drawRaw(beforeRef.current, raw);
    drawRaw(afterRef.current, applyMask(raw, mask));
  }, [phase, mask]);

  const apply = (): void => {
    if (!mask || !rawRef.current) return;
    const raw = rawRef.current;
    const maskDataUrl = maskToDataUrl(mask, raw.width, raw.height);
    const derived = deriveAssetWithMask(layer.assetId, maskDataUrl);
    if (derived) {
      // New asset id → history snapshot keeps the old asset → fully undoable.
      updateLayer<ImageReliefLayer>(layer.id, { assetId: derived.id });
    }
    onClose();
  };

  return (
    <Modal title="הסרת רקע אוטומטית" open={open} onClose={onClose} widthClass="max-w-2xl">
      <div className="flex flex-col gap-4">
        <p className="text-xs leading-relaxed text-slate-500">
          העיבוד מתבצע כולו בדפדפן — התמונה אינה נשלחת לשום שרת. האלגוריתם מזהה
          רקע אחיד מקצוות התמונה ומסיר אותו. התמונה המקורית נשמרת בזיכרון וניתן
          לבטל את הפעולה בכל שלב (Ctrl+Z).
        </p>

        <SliderField
          label="סובלנות צבע"
          value={tolerance}
          min={5}
          max={80}
          onChange={setTolerance}
        />

        {phase === "running" && (
          <div className="flex flex-col gap-2">
            <div className="h-2 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-blue-600 transition-all"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>מעבד… {Math.round(progress * 100)}%</span>
              <SecondaryButton
                onClick={() => {
                  handleRef.current?.cancel();
                  reset();
                }}
              >
                ביטול העיבוד
              </SecondaryButton>
            </div>
          </div>
        )}

        {phase === "preview" && (
          <div className="grid grid-cols-2 gap-3">
            <figure>
              <figcaption className="mb-1 text-xs font-bold text-slate-600">לפני</figcaption>
              <canvas ref={beforeRef} className="w-full rounded-md border border-slate-200" />
            </figure>
            <figure>
              <figcaption className="mb-1 text-xs font-bold text-slate-600">אחרי</figcaption>
              <canvas
                ref={afterRef}
                className="w-full rounded-md border border-slate-200"
                style={{
                  backgroundImage: "repeating-conic-gradient(#e2e8f0 0% 25%, #f8fafc 0% 50%)",
                  backgroundSize: "16px 16px",
                }}
              />
            </figure>
          </div>
        )}

        {error && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{error}</p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <SecondaryButton onClick={onClose}>
            {phase === "preview" ? "שמירת המקור (ללא שינוי)" : "סגירה"}
          </SecondaryButton>
          {(phase === "idle" || phase === "failed") && (
            <PrimaryButton onClick={() => void run()}>
              {phase === "failed" ? "ניסיון חוזר" : "הפעלת הסרת רקע"}
            </PrimaryButton>
          )}
          {phase === "preview" && (
            <>
              <SecondaryButton onClick={() => void run()}>חישוב מחדש</SecondaryButton>
              <PrimaryButton onClick={apply}>אישור והחלה</PrimaryButton>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function drawRaw(canvas: HTMLCanvasElement | null, raw: RawImage): void {
  if (!canvas) return;
  canvas.width = raw.width;
  canvas.height = raw.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(raw.data), raw.width, raw.height), 0, 0);
}
