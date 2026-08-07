"use client";

/**
 * The editor's top bar: template picker, base-mode switch, undo/redo, the
 * import buttons, and the library / shortcuts / share / export actions.
 *
 * The hidden file inputs live here too, next to the buttons that click
 * them, rather than at the bottom of the editor two hundred lines away.
 * All four behave identically — clear the value so re-picking the same file
 * fires a change — so they are one component, not four copies.
 */

import { useRef } from "react";
import type { BaseMode, DesignDocument } from "@/types/design";
import { createTemplateDocument, PRODUCT_TEMPLATES } from "@/lib/geometry/documentTemplates";
import { IMAGE_INPUT_ACCEPT } from "@/lib/import/image";
import { DESIGN_FILE_EXTENSION } from "@/lib/serialization/designFile";

const TOOLBAR_BUTTON_CLASS =
  "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50";

const HISTORY_BUTTON_CLASS =
  "rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-30";

const BASE_MODES: { mode: BaseMode; labelHe: string }[] = [
  { mode: "withBase", labelHe: "עם בסיס" },
  { mode: "baseless", labelHe: "ללא בסיס" },
];

/**
 * A hidden file input plus the button that opens it. The value is cleared
 * on every change so picking the SAME file twice still fires.
 */
function FilePickerButton({
  labelHe,
  accept,
  ariaLabel,
  onFile,
}: {
  labelHe: string;
  accept: string;
  ariaLabel: string;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={TOOLBAR_BUTTON_CLASS}
        onClick={() => inputRef.current?.click()}
      >
        {labelHe}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        aria-label={ariaLabel}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
    </>
  );
}

export interface EditorHeaderProps {
  document: DesignDocument;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onApplyTemplate: (document: DesignDocument) => void;
  onRequestBaseMode: (mode: BaseMode) => void;
  onStlFile: (file: File) => void;
  onSvgFile: (file: File) => void;
  onImageFile: (file: File) => void;
  onDesignFile: (file: File) => void;
  onOpenLibrary: () => void;
  onOpenShortcuts: () => void;
  onShareLink: () => void;
  onOpenExport: () => void;
}

export function EditorHeader({
  document: doc,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onApplyTemplate,
  onRequestBaseMode,
  onStlFile,
  onSvgFile,
  onImageFile,
  onDesignFile,
  onOpenLibrary,
  onOpenShortcuts,
  onShareLink,
  onOpenExport,
}: EditorHeaderProps) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 shadow-sm">
      <h1 className="text-lg font-bold text-slate-800">PrintCraft STL Studio</h1>

      <select
        className="rounded-md border border-slate-300 px-2 py-1 text-sm"
        value={doc.templateId ?? ""}
        aria-label="בחירת תבנית"
        onChange={(e) => {
          if (!e.target.value) return;
          onApplyTemplate(createTemplateDocument(e.target.value));
        }}
      >
        <option value="">תבנית…</option>
        {PRODUCT_TEMPLATES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.icon} {t.nameHe}
          </option>
        ))}
      </select>

      <div
        className="flex overflow-hidden rounded-md border border-slate-300"
        role="group"
        aria-label="מצב בסיס"
      >
        {BASE_MODES.map(({ mode, labelHe }) => (
          <button
            key={mode}
            type="button"
            aria-pressed={doc.baseMode === mode}
            className={`px-3 py-1 text-sm ${
              doc.baseMode === mode
                ? "bg-blue-600 text-white"
                : "bg-white text-slate-600 hover:bg-slate-100"
            }`}
            onClick={() => doc.baseMode !== mode && onRequestBaseMode(mode)}
          >
            {labelHe}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={!canUndo}
          title="ביטול (Ctrl+Z)"
          aria-label="ביטול"
          className={HISTORY_BUTTON_CLASS}
          onClick={onUndo}
        >
          ↶
        </button>
        <button
          type="button"
          disabled={!canRedo}
          title="ביצוע מחדש (Ctrl+Y)"
          aria-label="ביצוע מחדש"
          className={HISTORY_BUTTON_CLASS}
          onClick={onRedo}
        >
          ↷
        </button>
      </div>

      <div className="ms-auto flex flex-wrap items-center gap-1.5">
        <FilePickerButton
          labelHe="ייבוא STL"
          accept=".stl"
          ariaLabel="קובץ STL"
          onFile={onStlFile}
        />
        <FilePickerButton
          labelHe="ייבוא SVG"
          accept=".svg"
          ariaLabel="קובץ SVG"
          onFile={onSvgFile}
        />
        <FilePickerButton
          labelHe="ייבוא תמונה"
          accept={IMAGE_INPUT_ACCEPT}
          ariaLabel="קובץ תמונה"
          onFile={onImageFile}
        />
        <FilePickerButton
          labelHe="טעינת עיצוב"
          accept={`.json,${DESIGN_FILE_EXTENSION}`}
          ariaLabel="קובץ עיצוב"
          onFile={onDesignFile}
        />
        <button
          type="button"
          className={TOOLBAR_BUTTON_CLASS}
          title="ספריית עיצובים עם גרסאות — במכשיר זה בלבד, ללא חשבון וללא סנכרון"
          onClick={onOpenLibrary}
        >
          ספרייה
        </button>
        <button
          type="button"
          className={TOOLBAR_BUTTON_CLASS}
          title="קיצורי מקלדת (Shift+?)"
          aria-label="קיצורי מקלדת"
          onClick={onOpenShortcuts}
        >
          ⌨
        </button>
        <button
          type="button"
          className={TOOLBAR_BUTTON_CLASS}
          title="קישור שמכיל את העיצוב עצמו — לעיצובים קטנים בלבד"
          onClick={onShareLink}
        >
          שיתוף בקישור
        </button>
        <button
          type="button"
          className="rounded-md bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-700"
          onClick={onOpenExport}
        >
          ייצוא ⬇
        </button>
      </div>
    </header>
  );
}
