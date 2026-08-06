"use client";

/**
 * "פתיחת עיצוב מקובץ" — warns that the current design will be replaced,
 * validates the selected .formadesign.json strictly, re-sanitizes any SVG
 * content, restores session assets, and resets history.
 */

import { useRef, useState } from "react";
import { replaceState, useEditorStore } from "@/lib/design/store";
import { clearAssets, registerAssetWithId } from "@/lib/design/assets";
import { clearAssetResolverCache } from "@/lib/design/assetResolver";
import {
  parsePortableDesign,
  PortableImportError,
  validatePortableFile,
} from "@/lib/serialization/portable";
import { sanitizeSvg } from "@/lib/svg/sanitize";
import { Modal, PrimaryButton, SecondaryButton } from "@/components/ui/Modal";

interface OpenDesignDialogProps {
  open: boolean;
  onClose: () => void;
}

export function OpenDesignDialog({ open, onClose }: OpenDesignDialogProps) {
  const { state } = useEditorStore();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasContent = state.doc.layers.length > 1 || state.doc.title.trim() !== "";

  const handleFile = async (file: File): Promise<void> => {
    setError(null);
    const fileError = validatePortableFile(file);
    if (fileError) {
      setError(fileError);
      return;
    }
    setBusy(true);
    try {
      const text = await file.text();
      const parsed = parsePortableDesign(text);

      // Re-sanitize SVG content — never trust markup from a file.
      for (const layer of parsed.state.doc.layers) {
        if (layer.type === "svg" && layer.svgText.trim()) {
          const sanitized = sanitizeSvg(layer.svgText);
          if (!sanitized.ok) {
            throw new PortableImportError(
              `שכבת ה-SVG "${layer.name}" בקובץ מכילה תוכן שאינו תקין`
            );
          }
          layer.svgText = sanitized.svgText;
        }
      }

      clearAssets();
      clearAssetResolverCache();
      for (const [id, asset] of Object.entries(parsed.assets)) {
        registerAssetWithId(id, asset);
      }
      replaceState(parsed.state);
      onClose();
    } catch (err) {
      setError(
        err instanceof PortableImportError
          ? err.messageHe
          : "פתיחת הקובץ נכשלה — הקובץ אינו תואם או פגום"
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <Modal title="פתיחת עיצוב מקובץ" open={open} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {hasContent && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-800">
            פתיחת קובץ חדש תחליף את העיצוב הנוכחי בדפדפן. מומלץ לשמור את העיצוב
            הנוכחי לקובץ לפני ההמשך.
          </p>
        )}
        <p className="text-xs text-slate-500">
          בחרו קובץ עיצוב בסיומת ‎.formadesign.json שנוצר בכלי זה. הקובץ נבדק
          ומאומת לפני הטעינה; קבצים פגומים או לא תואמים יידחו.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          aria-label="בחירת קובץ עיצוב"
          className="block w-full text-sm text-slate-600 file:me-3 file:rounded-md file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-blue-700"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        {busy && <p className="text-sm text-slate-500">טוען ובודק את הקובץ…</p>}
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={onClose}>ביטול</SecondaryButton>
          <PrimaryButton onClick={() => inputRef.current?.click()} disabled={busy}>
            בחירת קובץ…
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  );
}
