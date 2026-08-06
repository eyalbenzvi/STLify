"use client";

/**
 * Manual mask refinement: paint erase/restore strokes over the image with an
 * adjustable brush, with local undo/redo. Applying creates a NEW asset
 * version so the change is fully undoable in the main editor history.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageReliefLayer } from "@/types/design";
import { deriveAssetWithMask, getAsset } from "@/lib/design/assets";
import { updateLayer } from "@/lib/design/store";
import { dataUrlToMask, dataUrlToRaw, maskToDataUrl } from "@/lib/images/browser";
import type { RawImage } from "@/lib/images/raster";
import { Modal, PrimaryButton, SecondaryButton } from "@/components/ui/Modal";
import { SliderField } from "@/components/ui/SliderField";

interface MaskEditorDialogProps {
  open: boolean;
  layer: ImageReliefLayer;
  onClose: () => void;
}

type Tool = "erase" | "restore";

const MAX_MASK_HISTORY = 20;

export function MaskEditorDialog({ open, layer, onClose }: MaskEditorDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rawRef = useRef<RawImage | null>(null);
  const maskRef = useRef<Uint8Array | null>(null);
  const undoStack = useRef<Uint8Array[]>([]);
  const redoStack = useRef<Uint8Array[]>([]);
  const paintingRef = useRef(false);
  const [tool, setTool] = useState<Tool>("erase");
  const [brushSize, setBrushSize] = useState(24);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const raw = rawRef.current;
    const mask = maskRef.current;
    if (!canvas || !raw || !mask) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const data = new Uint8ClampedArray(raw.data);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 0) {
        // Removed pixels: red translucent overlay.
        data[i * 4] = Math.min(255, data[i * 4] * 0.4 + 160);
        data[i * 4 + 1] = data[i * 4 + 1] * 0.3;
        data[i * 4 + 2] = data[i * 4 + 2] * 0.3;
        data[i * 4 + 3] = 140;
      }
    }
    ctx.putImageData(new ImageData(data, raw.width, raw.height), 0, 0);
  }, []);

  // Load image + existing mask when opened.
  useEffect(() => {
    if (!open) return;
    undoStack.current = [];
    redoStack.current = [];
    void (async () => {
      setReady(false);
      setError(null);
      setUndoCount(0);
      setRedoCount(0);
      try {
        const asset = getAsset(layer.assetId);
        if (!asset) throw new Error("קובץ המקור אינו זמין בהפעלה הנוכחית");
        const raw = await dataUrlToRaw(asset.dataUrl);
        rawRef.current = raw;
        if (asset.maskDataUrl) {
          const { mask, width, height } = await dataUrlToMask(asset.maskDataUrl);
          maskRef.current =
            width === raw.width && height === raw.height
              ? mask
              : new Uint8Array(raw.width * raw.height).fill(255);
        } else {
          maskRef.current = new Uint8Array(raw.width * raw.height).fill(255);
        }
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = raw.width;
          canvas.height = raw.height;
        }
        redraw();
        setReady(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "טעינת התמונה נכשלה");
      }
    })();
  }, [open, layer.assetId, redraw]);

  const syncCounts = (): void => {
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
  };

  const pushHistory = (): void => {
    const mask = maskRef.current;
    if (!mask) return;
    undoStack.current.push(new Uint8Array(mask));
    if (undoStack.current.length > MAX_MASK_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    syncCounts();
  };

  const undo = (): void => {
    const prev = undoStack.current.pop();
    if (!prev || !maskRef.current) return;
    redoStack.current.push(new Uint8Array(maskRef.current));
    maskRef.current = prev;
    redraw();
    syncCounts();
  };

  const redo = (): void => {
    const next = redoStack.current.pop();
    if (!next || !maskRef.current) return;
    undoStack.current.push(new Uint8Array(maskRef.current));
    maskRef.current = next;
    redraw();
    syncCounts();
  };

  const paintAt = (clientX: number, clientY: number): void => {
    const canvas = canvasRef.current;
    const raw = rawRef.current;
    const mask = maskRef.current;
    if (!canvas || !raw || !mask) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * raw.width;
    const y = ((clientY - rect.top) / rect.height) * raw.height;
    const radius = (brushSize / rect.width) * raw.width / 2;
    const value = tool === "erase" ? 0 : 255;
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(x - radius));
    const x1 = Math.min(raw.width - 1, Math.ceil(x + radius));
    const y0 = Math.max(0, Math.floor(y - radius));
    const y1 = Math.min(raw.height - 1, Math.ceil(y + radius));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px - x;
        const dy = py - y;
        if (dx * dx + dy * dy <= r2) mask[py * raw.width + px] = value;
      }
    }
    redraw();
  };

  const apply = (): void => {
    const raw = rawRef.current;
    const mask = maskRef.current;
    if (!raw || !mask) return;
    const allKept = mask.every((v) => v === 255);
    const maskDataUrl = allKept ? null : maskToDataUrl(mask, raw.width, raw.height);
    const derived = deriveAssetWithMask(layer.assetId, maskDataUrl);
    if (derived) updateLayer<ImageReliefLayer>(layer.id, { assetId: derived.id });
    onClose();
  };

  return (
    <Modal title="עריכת מסכה ידנית" open={open} onClose={onClose} widthClass="max-w-2xl">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-slate-500">
          ציירו על התמונה כדי למחוק אזורים (אדום = יוסר) או לשחזר אותם. השינוי
          חל רק לאחר לחיצה על אישור, וניתן לביטול עם Ctrl+Z בעורך.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-slate-300">
            <button
              type="button"
              className={toolBtn(tool === "erase")}
              onClick={() => setTool("erase")}
            >
              🧹 מחיקה
            </button>
            <button
              type="button"
              className={toolBtn(tool === "restore")}
              onClick={() => setTool("restore")}
            >
              🖌 שחזור
            </button>
          </div>
          <SecondaryButton onClick={undo} disabled={undoCount === 0}>
            ↶ ביטול
          </SecondaryButton>
          <SecondaryButton onClick={redo} disabled={redoCount === 0}>
            ↷ חזרה
          </SecondaryButton>
        </div>
        <SliderField label="גודל מברשת" value={brushSize} min={4} max={80} onChange={setBrushSize} />

        {error ? (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        ) : (
          <canvas
            ref={canvasRef}
            className="w-full cursor-crosshair touch-none rounded-md border border-slate-300"
            style={{
              backgroundImage: "repeating-conic-gradient(#e2e8f0 0% 25%, #f8fafc 0% 50%)",
              backgroundSize: "16px 16px",
            }}
            onPointerDown={(e) => {
              if (!ready) return;
              pushHistory();
              paintingRef.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              paintAt(e.clientX, e.clientY);
            }}
            onPointerMove={(e) => {
              if (paintingRef.current) paintAt(e.clientX, e.clientY);
            }}
            onPointerUp={() => {
              paintingRef.current = false;
            }}
          />
        )}

        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={onClose}>ביטול</SecondaryButton>
          <PrimaryButton onClick={apply} disabled={!ready}>
            אישור והחלה
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}

function toolBtn(active: boolean): string {
  return `px-3 py-1.5 text-sm ${active ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`;
}
