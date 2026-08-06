"use client";

import { useState } from "react";
import type { TextLayer } from "@/types/design";
import { updateLayer } from "@/lib/design/store";
import { getFontEntry } from "@/lib/fonts/library";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { RANGES_V2 } from "@/lib/geometry/validateDesign";
import { FontBrowserDialog } from "./FontBrowserDialog";

export function TextLayerControls({
  layer,
  multiColorEnabled,
}: {
  layer: TextLayer;
  multiColorEnabled: boolean;
}) {
  const r = RANGES_V2;
  const [fontBrowserOpen, setFontBrowserOpen] = useState(false);
  const font = getFontEntry(layer.fontId);
  const patch = (p: Partial<TextLayer>, key?: string) =>
    updateLayer(layer.id, p, { coalesceKey: key ? `text:${layer.id}:${key}` : null });

  const modeOptions: { value: TextLayer["mode"]; label: string }[] = [
    { value: "raised", label: "מובלט" },
    { value: "engraved", label: "חרוט" },
  ];
  if (multiColorEnabled) modeOptions.push({ value: "inlay", label: "שיבוץ" });

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-slate-600">תוכן הטקסט</span>
        <textarea
          className="min-h-16 rounded-md border border-slate-300 px-2 py-1 text-base outline-none focus:border-blue-500"
          value={layer.content}
          maxLength={r.maxTextLength}
          rows={2}
          placeholder="הקלידו טקסט…"
          onChange={(e) => patch({ content: e.target.value }, "content")}
        />
      </label>

      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">גופן</span>
        <button
          type="button"
          className="flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-50"
          onClick={() => setFontBrowserOpen(true)}
        >
          <span>{font.nameHe}</span>
          <span className="text-xs text-slate-400">▾ ספרייה</span>
        </button>
      </div>

      <label
        className={`flex items-center justify-between gap-2 text-sm ${font.hasBold ? "" : "opacity-40"}`}
      >
        <span className="text-slate-600">מודגש {font.hasBold ? "" : "(לא זמין בגופן זה)"}</span>
        <input
          type="checkbox"
          className="size-4 accent-blue-600"
          checked={layer.bold && font.hasBold}
          disabled={!font.hasBold}
          onChange={(e) => patch({ bold: e.target.checked })}
        />
      </label>

      <NumberField
        label="גודל טקסט"
        value={layer.sizeMm}
        min={r.textSizeMm.min}
        max={r.textSizeMm.max}
        onChange={(sizeMm) => patch({ sizeMm }, "size")}
      />
      <NumberField
        label="מרווח אותיות"
        value={layer.letterSpacingMm}
        min={r.letterSpacingMm.min}
        max={r.letterSpacingMm.max}
        step={0.1}
        onChange={(letterSpacingMm) => patch({ letterSpacingMm }, "ls")}
      />
      <NumberField
        label="מרווח שורות"
        value={layer.lineSpacing}
        min={r.lineSpacing.min}
        max={r.lineSpacing.max}
        step={0.1}
        unit="×"
        onChange={(lineSpacing) => patch({ lineSpacing }, "lh")}
      />

      <ToggleGroup
        label="יישור"
        value={layer.align}
        options={[
          { value: "right", label: "ימין" },
          { value: "center", label: "מרכז" },
          { value: "left", label: "שמאל" },
        ]}
        onChange={(align) => patch({ align })}
      />
      <ToggleGroup
        label="כיוון"
        value={layer.direction}
        options={[
          { value: "auto", label: "אוטומטי" },
          { value: "rtl", label: "עברית" },
          { value: "ltr", label: "LTR" },
        ]}
        onChange={(direction) => patch({ direction })}
      />
      <ToggleGroup
        label="סגנון"
        value={layer.mode}
        options={modeOptions}
        onChange={(mode) => patch({ mode })}
      />
      <NumberField
        label={layer.mode === "engraved" ? "עומק חריטה" : "גובה הבלטה"}
        value={layer.depthMm}
        min={r.depthMm.min}
        max={r.depthMm.max}
        step={0.1}
        onChange={(depthMm) => patch({ depthMm }, "depth")}
      />
      <NumberField
        label="עיקול קשתי (רדיוס, 0=ישר)"
        value={layer.curveRadiusMm}
        min={0}
        max={r.curveRadiusMm.max}
        onChange={(curveRadiusMm) => patch({ curveRadiusMm }, "curve")}
      />
      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">טקסט מראה (לחותמות)</span>
        <input
          type="checkbox"
          className="size-4 accent-blue-600"
          checked={layer.mirrored}
          onChange={(e) => patch({ mirrored: e.target.checked })}
        />
      </label>
      {layer.mirrored && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
          הטקסט מוצג במראה (הפוך) — כך ההטבעה על נייר תצא ישרה.
        </p>
      )}

      <FontBrowserDialog
        open={fontBrowserOpen}
        currentFontId={layer.fontId}
        previewText={layer.content}
        onSelect={(fontId) => {
          const entry = getFontEntry(fontId);
          patch({ fontId, bold: layer.bold && entry.hasBold });
        }}
        onClose={() => setFontBrowserOpen(false)}
      />
    </div>
  );
}
