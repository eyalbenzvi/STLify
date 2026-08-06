"use client";

/**
 * "העלאת לוגו SVG" — file selection, validation, sanitization, 2D preview
 * and initial sizing before the SVG becomes an editable layer.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { BaseLayer } from "@/types/design";
import { createSvgLayer } from "@/lib/design/defaults";
import { addLayer, useEditorStore } from "@/lib/design/store";
import { sanitizeSvg, validateSvgFile, type SvgSanitizeResult } from "@/lib/svg/sanitize";
import { Modal, PrimaryButton, SecondaryButton } from "@/components/ui/Modal";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";

interface SvgImportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SvgImportDialog({ open, onClose }: SvgImportDialogProps) {
  const { state } = useEditorStore();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<SvgSanitizeResult | null>(null);
  const [widthMm, setWidthMm] = useState(30);
  const [mode, setMode] = useState<"raised" | "engraved">("raised");
  const [depthMm, setDepthMm] = useState(1.5);

  const reset = useCallback(() => {
    setError(null);
    setResult(null);
    setFileName("");
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const handleFile = async (file: File): Promise<void> => {
    setError(null);
    setResult(null);
    const fileError = validateSvgFile(file);
    if (fileError) {
      setError(fileError);
      return;
    }
    const text = await file.text();
    const sanitized = sanitizeSvg(text);
    if (!sanitized.ok) {
      setError(sanitized.error);
      return;
    }
    setFileName(file.name);
    setResult(sanitized);
    const base = state.doc.layers[0] as BaseLayer;
    setWidthMm(Math.min(30, Math.round(base.widthMm * 0.4)));
  };

  // Safe preview: sanitized markup rendered through an <img>, which never
  // executes scripts or loads external resources from SVG content.
  const previewUrl = useMemo(() => {
    if (!result?.ok) return null;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svgText)}`;
  }, [result]);

  const addSvgLayer = (): void => {
    if (!result?.ok) return;
    const heightMm = Math.round((widthMm / Math.max(result.aspectRatio, 0.01)) * 100) / 100;
    addLayer(
      createSvgLayer({
        name: fileName.replace(/\.svg$/i, "") || "לוגו SVG",
        svgText: result.svgText,
        sourceName: fileName,
        targetWidthMm: widthMm,
        targetHeightMm: heightMm,
        aspectRatio: result.aspectRatio,
        mode,
        depthMm,
        importWarnings: result.warnings,
      })
    );
    close();
  };

  return (
    <Modal title="העלאת לוגו SVG" open={open} onClose={close} widthClass="max-w-xl">
      <div className="flex flex-col gap-4">
        <input
          ref={inputRef}
          type="file"
          accept=".svg,image/svg+xml"
          aria-label="בחירת קובץ SVG"
          className="block w-full text-sm text-slate-600 file:me-3 file:rounded-md file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-blue-700"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        <p className="text-xs text-slate-400">
          קובץ SVG עד 3MB. סקריפטים, תוכן חיצוני ואלמנטים לא בטוחים מוסרים
          אוטומטית. מומלץ להעלות לוגו עם צורות מלאות (fill).
        </p>

        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {result?.ok && (
          <>
            {previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt="תצוגה מקדימה של הלוגו"
                className="max-h-48 w-full rounded-md border border-slate-200 object-contain p-2"
                style={{
                  backgroundImage: "repeating-conic-gradient(#e2e8f0 0% 25%, #f8fafc 0% 50%)",
                  backgroundSize: "16px 16px",
                }}
              />
            )}
            {result.warnings.length > 0 && (
              <ul className="flex flex-col gap-1">
                {result.warnings.map((w, i) => (
                  <li key={i} className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    ⚠️ {w}
                  </li>
                ))}
              </ul>
            )}
            <NumberField label="רוחב על הבסיס" value={widthMm} min={2} max={380} onChange={setWidthMm} />
            <ToggleGroup
              label="סגנון"
              value={mode}
              options={[
                { value: "raised", label: "מובלט" },
                { value: "engraved", label: "חרוט" },
              ]}
              onChange={setMode}
            />
            <NumberField
              label={mode === "engraved" ? "עומק חריטה" : "גובה הבלטה"}
              value={depthMm}
              min={0.2}
              max={50}
              step={0.1}
              onChange={setDepthMm}
            />
          </>
        )}

        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={close}>ביטול</SecondaryButton>
          <PrimaryButton onClick={addSvgLayer} disabled={!result?.ok}>
            הוספה לעיצוב
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}
