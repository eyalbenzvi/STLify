"use client";

/**
 * "שכבות" — the layer panel: list, select, rename, show/hide, lock,
 * duplicate, delete (with confirmation), and reorder (accessible buttons).
 */

import { useState } from "react";
import type { DesignLayer } from "@/types/design";
import { layerOperation } from "@/types/design";
import {
  duplicateLayer,
  moveLayer,
  removeLayer,
  selectLayer,
  updateLayer,
  useEditorStore,
} from "@/lib/design/store";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

const TYPE_ICONS: Record<DesignLayer["type"], string> = {
  base: "▭",
  text: "א",
  svg: "◆",
  imageRelief: "🖼",
  hole: "◯",
};

const TYPE_LABELS: Record<DesignLayer["type"], string> = {
  base: "בסיס",
  text: "טקסט",
  svg: "SVG",
  imageRelief: "תמונה",
  hole: "חור",
};

function operationBadge(layer: DesignLayer): { label: string; className: string } {
  if (layer.type === "hole") return { label: "חיתוך", className: "bg-red-50 text-red-700" };
  if (layer.type === "base") return { label: "בסיס", className: "bg-slate-100 text-slate-600" };
  if ((layer.type === "text" || layer.type === "svg") && layer.mode === "inlay") {
    return { label: "שיבוץ", className: "bg-purple-50 text-purple-700" };
  }
  return layerOperation(layer) === "add"
    ? { label: "מובלט", className: "bg-emerald-50 text-emerald-700" }
    : { label: "חרוט", className: "bg-amber-50 text-amber-700" };
}

export function LayerPanel() {
  const { state, selectedLayerId } = useEditorStore();
  const layers = state.doc.layers;
  const [deleteTarget, setDeleteTarget] = useState<DesignLayer | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Panel shows topmost layer first (matching visual stacking intuition).
  const displayLayers = [...layers].reverse();

  return (
    <div className="flex flex-col gap-1" role="list" aria-label="שכבות העיצוב">
      {displayLayers.map((layer) => {
        const index = layers.indexOf(layer);
        const selected = layer.id === selectedLayerId;
        const badge = operationBadge(layer);
        const isBase = layer.type === "base";
        return (
          <div
            key={layer.id}
            role="listitem"
            className={`group rounded-lg border px-2 py-1.5 transition-colors ${
              selected
                ? "border-blue-400 bg-blue-50"
                : "border-transparent hover:border-slate-200 hover:bg-slate-50"
            }`}
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-start"
                onClick={() => selectLayer(layer.id)}
                aria-label={`בחירת שכבה ${layer.name}`}
              >
                <span
                  className="grid size-6 shrink-0 place-items-center rounded-md text-xs"
                  style={{ backgroundColor: `${layer.colorHex}22`, color: layer.colorHex }}
                  title={TYPE_LABELS[layer.type]}
                >
                  {TYPE_ICONS[layer.type]}
                </span>
                {renamingId === layer.id ? (
                  <input
                    autoFocus
                    dir="rtl"
                    defaultValue={layer.name}
                    className="w-full rounded border border-blue-300 px-1 py-0.5 text-sm outline-none"
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (name) updateLayer(layer.id, { name });
                      setRenamingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <span
                    className={`truncate text-sm ${layer.visible ? "text-slate-800" : "text-slate-400 line-through"}`}
                    onDoubleClick={() => setRenamingId(layer.id)}
                    title={layer.name}
                  >
                    {layer.name}
                  </span>
                )}
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${badge.className}`}>
                  {badge.label}
                </span>
              </button>

              <span
                className="size-3 shrink-0 rounded-full border border-slate-300"
                style={{ backgroundColor: layer.colorHex }}
                title={`צבע: ${layer.colorHex}`}
              />
            </div>

            <div className="mt-1 flex items-center gap-0.5 text-xs">
              <IconButton
                label={layer.visible ? "הסתרת שכבה" : "הצגת שכבה"}
                onClick={() => updateLayer(layer.id, { visible: !layer.visible })}
              >
                {layer.visible ? "👁" : "🚫"}
              </IconButton>
              <IconButton
                label={layer.locked ? "שחרור נעילה" : "נעילת שכבה"}
                onClick={() => updateLayer(layer.id, { locked: !layer.locked })}
              >
                {layer.locked ? "🔒" : "🔓"}
              </IconButton>
              <IconButton label="שינוי שם" onClick={() => setRenamingId(layer.id)}>
                ✎
              </IconButton>
              {!isBase && (
                <>
                  <IconButton label="שכפול שכבה" onClick={() => duplicateLayer(layer.id)}>
                    ⧉
                  </IconButton>
                  <IconButton
                    label="העברת שכבה למעלה"
                    disabled={index >= layers.length - 1}
                    onClick={() => moveLayer(layer.id, 1)}
                  >
                    ↑
                  </IconButton>
                  <IconButton
                    label="העברת שכבה למטה"
                    disabled={index <= 1}
                    onClick={() => moveLayer(layer.id, -1)}
                  >
                    ↓
                  </IconButton>
                  <IconButton label="מחיקת שכבה" onClick={() => setDeleteTarget(layer)}>
                    🗑
                  </IconButton>
                </>
              )}
            </div>
          </div>
        );
      })}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="מחיקת שכבה"
        message={`למחוק את השכבה "${deleteTarget?.name ?? ""}"? אפשר לבטל עם Ctrl+Z.`}
        confirmLabel="מחיקה"
        danger
        onConfirm={() => {
          if (deleteTarget) removeLayer(deleteTarget.id);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="grid size-6 place-items-center rounded text-slate-500 hover:bg-slate-200 hover:text-slate-800 disabled:opacity-30"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
