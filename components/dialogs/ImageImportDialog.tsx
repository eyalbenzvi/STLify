"use client";

/**
 * "העלאת תמונה" — PNG/JPG upload with validation, preview and initial relief
 * settings. Cancelling changes nothing; confirming registers the image as a
 * session asset and adds an editable ImageReliefLayer.
 */

import { useCallback, useRef, useState } from "react";
import type { BaseLayer, ImageReliefMode } from "@/types/design";
import { createImageReliefLayer } from "@/lib/design/defaults";
import { registerAsset } from "@/lib/design/assets";
import { addLayer, useEditorStore } from "@/lib/design/store";
import { decodeImageFile, validateImageFile, type DecodedImage } from "@/lib/images/browser";
import { Modal, PrimaryButton, SecondaryButton } from "@/components/ui/Modal";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";

interface ImageImportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ImageImportDialog({ open, onClose }: ImageImportDialogProps) {
  const { state } = useEditorStore();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decoded, setDecoded] = useState<DecodedImage | null>(null);
  const [fileName, setFileName] = useState("");
  const [widthMm, setWidthMm] = useState(50);
  const [mode, setMode] = useState<ImageReliefMode>("raised");
  const [maxHeightMm, setMaxHeightMm] = useState(2);

  const reset = useCallback(() => {
    setError(null);
    setDecoded(null);
    setFileName("");
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const handleFile = async (file: File): Promise<void> => {
    setError(null);
    setDecoded(null);
    const fileError = validateImageFile(file);
    if (fileError) {
      setError(fileError);
      return;
    }
    setBusy(true);
    try {
      const result = await decodeImageFile(file);
      setDecoded(result);
      setFileName(file.name);
      const base = state.doc.layers[0] as BaseLayer;
      setWidthMm(Math.round(base.widthMm * 0.5));
    } catch (err) {
      setError(err instanceof Error ? err.message : "פענוח התמונה נכשל");
    } finally {
      setBusy(false);
    }
  };

  const addImageLayer = (): void => {
    if (!decoded) return;
    const aspectRatio = decoded.raw.width / decoded.raw.height;
    const asset = registerAsset(decoded.dataUrl, decoded.raw.width, decoded.raw.height);
    addLayer(
      createImageReliefLayer({
        name: fileName.replace(/\.(png|jpe?g)$/i, "") || "תמונה",
        assetId: asset.id,
        sourceName: fileName,
        mode,
        maxHeightMm,
        widthMm,
        heightMm: Math.round((widthMm / aspectRatio) * 100) / 100,
        aspectRatio,
      })
    );
    close();
  };

  return (
    <Modal title="העלאת תמונה (PNG / JPG)" open={open} onClose={close} widthClass="max-w-xl">
      <div className="flex flex-col gap-4">
        <input
          ref={inputRef}
          type="file"
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          aria-label="בחירת קובץ תמונה"
          className="block w-full text-sm text-slate-600 file:me-3 file:rounded-md file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-blue-700"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        <p className="text-xs text-slate-400">
          PNG או JPG עד 20MB. התמונה נשמרת בזיכרון הדפדפן בלבד להפעלה הנוכחית,
          ומוקטנת אוטומטית לעיבוד. לאחר ההוספה אפשר לחתוך, לכוונן ולהסיר רקע.
        </p>

        {busy && <p className="text-sm text-slate-500">מפענח תמונה…</p>}
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {decoded && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={decoded.dataUrl}
              alt="תצוגה מקדימה של התמונה"
              className="max-h-48 w-full rounded-md border border-slate-200 object-contain"
            />
            <p className="text-xs text-slate-400" dir="ltr">
              {decoded.originalWidth}×{decoded.originalHeight}px
              {decoded.raw.width !== decoded.originalWidth &&
                ` → ${decoded.raw.width}×${decoded.raw.height}px (הוקטן לעיבוד)`}
            </p>
            <NumberField label="רוחב על הבסיס" value={widthMm} min={5} max={380} onChange={setWidthMm} />
            <ToggleGroup
              label="סוג תבליט"
              value={mode}
              options={[
                { value: "raised", label: "מובלט" },
                { value: "engraved", label: "חרוט" },
                { value: "silhouette", label: "צללית" },
              ]}
              onChange={setMode}
            />
            <NumberField
              label="גובה תבליט מקסימלי"
              value={maxHeightMm}
              min={0.1}
              max={20}
              step={0.1}
              onChange={setMaxHeightMm}
            />
          </>
        )}

        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={close}>ביטול</SecondaryButton>
          <PrimaryButton onClick={addImageLayer} disabled={!decoded}>
            הוספה לעיצוב
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}
