"use client";

/**
 * Layer list: selection (multi with Ctrl), visibility, lock, reorder,
 * rename, duplicate and delete. RTL-aware.
 */

import { useState } from "react";
import type { DesignDocument, DesignLayer } from "@/types/design";

const TYPE_ICONS: Record<DesignLayer["type"], string> = {
  base: "▭",
  text: "א",
  svg: "✒",
  imageRelief: "🖼",
  importedMesh: "◆",
  primitive: "⬢",
  sketch: "✐",
  hole: "◎",
};

const TYPE_NAMES_HE: Record<DesignLayer["type"], string> = {
  base: "בסיס",
  text: "טקסט",
  svg: "SVG",
  imageRelief: "תמונה",
  importedMesh: "רשת",
  primitive: "גוף בסיסי",
  sketch: "סקיצה",
  hole: "חור",
};

export interface LayerListPanelProps {
  document: DesignDocument;
  selection: string[];
  onSelect: (ids: string[], additive: boolean) => void;
  onUpdateLayer: (id: string, patch: Partial<DesignLayer>, labelHe: string) => void;
  onDeleteLayer: (id: string) => void;
  onDuplicateLayer: (id: string) => void;
  onMoveLayer: (id: string, direction: -1 | 1) => void;
}

export function LayerListPanel({
  document,
  selection,
  onSelect,
  onUpdateLayer,
  onDeleteLayer,
  onDuplicateLayer,
  onMoveLayer,
}: LayerListPanelProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  if (document.layers.length === 0) {
    return (
      <p className="px-1 py-2 text-xs text-slate-400">
        אין שכבות. הוסיפו טקסט, SVG, תמונה או STL.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1" role="listbox" aria-label="שכבות העיצוב">
      {document.layers.map((layer, index) => {
        const selected = selection.includes(layer.id);
        return (
          <li
            key={layer.id}
            role="option"
            aria-selected={selected}
            className={`group flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-sm transition-colors ${
              selected
                ? "border-blue-400 bg-blue-50"
                : "border-transparent hover:bg-slate-50"
            }`}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-start"
              onClick={(e) => onSelect([layer.id], e.ctrlKey || e.metaKey || e.shiftKey)}
              title={`בחירת השכבה ${layer.name}`}
            >
              <span
                aria-hidden
                className="w-5 text-center text-xs text-slate-400"
                title={TYPE_NAMES_HE[layer.type]}
              >
                {TYPE_ICONS[layer.type]}
              </span>
              {renaming === layer.id ? (
                <input
                  autoFocus
                  className="w-full rounded border border-blue-300 px-1 text-sm"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => {
                    if (renameValue.trim()) {
                      onUpdateLayer(layer.id, { name: renameValue.trim() }, "שינוי שם שכבה");
                    }
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className={`truncate ${layer.visible ? "text-slate-700" : "text-slate-400 line-through"}`}
                  onDoubleClick={() => {
                    setRenaming(layer.id);
                    setRenameValue(layer.name);
                  }}
                >
                  {layer.name}
                </span>
              )}
            </button>

            <span className="flex shrink-0 items-center gap-0.5 opacity-60 group-hover:opacity-100">
              <IconButton
                label={layer.visible ? "הסתרת השכבה" : "הצגת השכבה"}
                onClick={() =>
                  onUpdateLayer(
                    layer.id,
                    { visible: !layer.visible },
                    layer.visible ? "הסתרת שכבה" : "הצגת שכבה"
                  )
                }
              >
                {layer.visible ? "👁" : "🚫"}
              </IconButton>
              <IconButton
                label={layer.locked ? "שחרור נעילה" : "נעילת השכבה"}
                onClick={() =>
                  onUpdateLayer(
                    layer.id,
                    { locked: !layer.locked },
                    layer.locked ? "שחרור נעילה" : "נעילת שכבה"
                  )
                }
              >
                {layer.locked ? "🔒" : "🔓"}
              </IconButton>
              <IconButton
                label="הזזת השכבה למעלה"
                disabled={index === 0}
                onClick={() => onMoveLayer(layer.id, -1)}
              >
                ↑
              </IconButton>
              <IconButton
                label="הזזת השכבה למטה"
                disabled={index === document.layers.length - 1}
                onClick={() => onMoveLayer(layer.id, 1)}
              >
                ↓
              </IconButton>
              <IconButton label="שכפול השכבה" onClick={() => onDuplicateLayer(layer.id)}>
                ⧉
              </IconButton>
              <IconButton
                label="מחיקת השכבה"
                onClick={() => onDeleteLayer(layer.id)}
                danger
              >
                🗑
              </IconButton>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function IconButton({
  label,
  onClick,
  children,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`rounded px-1 py-0.5 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-30 ${
        danger ? "hover:bg-red-100" : "hover:bg-slate-200"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
