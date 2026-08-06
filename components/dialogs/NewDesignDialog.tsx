"use client";

/**
 * "עיצוב חדש" — confirmation before clearing the current in-memory design,
 * with the options: blank design, choose a template, or cancel. Resets the
 * undo history and session assets.
 */

import { PRODUCT_TEMPLATES } from "@/lib/design/templates";
import { createBlankState, defaultSettings } from "@/lib/design/defaults";
import { replaceState, useEditorStore } from "@/lib/design/store";
import { clearAssets } from "@/lib/design/assets";
import { clearAssetResolverCache } from "@/lib/design/assetResolver";
import type { ProductTemplateId } from "@/types/design";
import { Modal, SecondaryButton } from "@/components/ui/Modal";

interface NewDesignDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NewDesignDialog({ open, onClose }: NewDesignDialogProps) {
  const { state } = useEditorStore();
  const hasContent = state.doc.layers.length > 1 || state.doc.title.trim() !== "";

  const startNew = (templateId: ProductTemplateId | "blank"): void => {
    clearAssets();
    clearAssetResolverCache();
    if (templateId === "blank") {
      replaceState(createBlankState());
    } else {
      const template = PRODUCT_TEMPLATES.find((t) => t.id === templateId);
      replaceState({
        doc: template ? template.create() : createBlankState().doc,
        settings: defaultSettings(),
      });
    }
    onClose();
  };

  return (
    <Modal title="עיצוב חדש" open={open} onClose={onClose} widthClass="max-w-2xl">
      <div className="flex flex-col gap-4">
        {hasContent && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            יצירת עיצוב חדש תמחק את העיצוב הנוכחי מהדפדפן ותאפס את היסטוריית
            הביטולים. מומלץ לשמור קודם את העיצוב הנוכחי לקובץ (בתפריט הייצוא).
          </p>
        )}
        <button
          type="button"
          className="rounded-xl border border-slate-200 p-3 text-start hover:border-blue-300 hover:bg-slate-50"
          onClick={() => startNew("blank")}
        >
          <span className="text-2xl" aria-hidden>⬜</span>
          <span className="ms-2 text-sm font-bold text-slate-800">עיצוב ריק</span>
          <span className="block text-xs text-slate-500">בסיס נקי בלבד</span>
        </button>
        <div>
          <h3 className="mb-2 text-xs font-bold text-slate-500">או התחלה מתבנית:</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PRODUCT_TEMPLATES.filter((t) => t.id !== "blank").map((template) => (
              <button
                key={template.id}
                type="button"
                className="flex flex-col items-start gap-0.5 rounded-xl border border-slate-200 p-2.5 text-start hover:border-blue-300 hover:bg-slate-50"
                onClick={() => startNew(template.id)}
              >
                <span className="text-2xl" aria-hidden>{template.icon}</span>
                <span className="text-xs font-bold text-slate-800">{template.nameHe}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end">
          <SecondaryButton onClick={onClose}>ביטול</SecondaryButton>
        </div>
      </div>
    </Modal>
  );
}
