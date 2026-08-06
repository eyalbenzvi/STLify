"use client";

/**
 * Visual product-template gallery. Applying a template to an existing design
 * asks for confirmation first (destructive conversion) and offers keeping
 * compatible layers; starting fresh replaces everything after confirmation.
 */

import { useState } from "react";
import type { ProductTemplate } from "@/types/design";
import { PRODUCT_TEMPLATES } from "@/lib/design/templates";
import { updateState, useEditorStore } from "@/lib/design/store";
import { baseOf } from "@/lib/design/defaults";
import { Modal, PrimaryButton, SecondaryButton } from "@/components/ui/Modal";

interface TemplateGalleryProps {
  open: boolean;
  onClose: () => void;
}

export function TemplateGallery({ open, onClose }: TemplateGalleryProps) {
  const { state } = useEditorStore();
  const [pending, setPending] = useState<ProductTemplate | null>(null);

  const hasContent = state.doc.layers.length > 1;

  const applyTemplate = (template: ProductTemplate, keepLayers: boolean): void => {
    updateState((s) => {
      const fresh = template.create();
      if (keepLayers) {
        // Preserve the user's content layers on top of the template's base.
        const contentLayers = s.doc.layers.slice(1);
        return {
          ...s,
          doc: { ...fresh, title: s.doc.title, layers: [baseOf(fresh), ...contentLayers] },
        };
      }
      return { ...s, doc: { ...fresh, title: s.doc.title } };
    });
    setPending(null);
    onClose();
  };

  return (
    <>
      <Modal title="תבניות מוצר" open={open && !pending} onClose={onClose} widthClass="max-w-3xl">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {PRODUCT_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-start transition-colors ${
                state.doc.templateId === template.id
                  ? "border-blue-400 bg-blue-50"
                  : "border-slate-200 hover:border-blue-300 hover:bg-slate-50"
              }`}
              onClick={() => {
                if (hasContent) setPending(template);
                else applyTemplate(template, false);
              }}
            >
              <span className="text-3xl" aria-hidden>
                {template.icon}
              </span>
              <span className="text-sm font-bold text-slate-800">{template.nameHe}</span>
              <span className="text-xs leading-snug text-slate-500">{template.descriptionHe}</span>
              {template.noteHe && (
                <span className="mt-1 rounded bg-amber-50 px-1.5 py-1 text-[10px] leading-snug text-amber-700">
                  {template.noteHe}
                </span>
              )}
              <span className="mt-1 text-[10px] text-slate-400" dir="ltr">
                {template.suggestedMaterial}
              </span>
            </button>
          ))}
        </div>
      </Modal>

      <Modal
        title={`החלת התבנית "${pending?.nameHe ?? ""}"`}
        open={pending !== null}
        onClose={() => setPending(null)}
        footer={
          <>
            <SecondaryButton onClick={() => setPending(null)}>ביטול</SecondaryButton>
            <SecondaryButton onClick={() => pending && applyTemplate(pending, true)}>
              החלה תוך שמירת השכבות הקיימות
            </SecondaryButton>
            <PrimaryButton onClick={() => pending && applyTemplate(pending, false)}>
              התחלת עיצוב חדש מהתבנית
            </PrimaryButton>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-slate-700">
          לעיצוב הנוכחי יש שכבות תוכן. החלת תבנית חדשה יכולה להחליף את הכול, או
          להחליף רק את הבסיס ולשמור על שכבות הטקסט/לוגו/תמונה הקיימות. בכל מקרה
          אפשר לבטל עם Ctrl+Z.
        </p>
      </Modal>
    </>
  );
}
