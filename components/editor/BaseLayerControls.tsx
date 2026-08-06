"use client";

import type { BaseLayer } from "@/types/design";
import { updateLayer } from "@/lib/design/store";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { RANGES_V2 } from "@/lib/geometry/validateDesign";

export function BaseLayerControls({ layer }: { layer: BaseLayer }) {
  const r = RANGES_V2;
  const patch = (p: Partial<BaseLayer>, key?: string) =>
    updateLayer(layer.id, p, { coalesceKey: key ? `base:${key}` : null });

  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        label="צורת בסיס"
        value={layer.shape}
        options={[
          { value: "rectangle", label: "מלבן" },
          { value: "roundedRectangle", label: "מעוגל" },
          { value: "circle", label: "עיגול" },
        ]}
        onChange={(shape) => patch({ shape })}
      />
      <NumberField
        label={layer.shape === "circle" ? "קוטר" : "רוחב"}
        value={layer.widthMm}
        min={r.baseSizeMm.min}
        max={r.baseSizeMm.max}
        onChange={(widthMm) => patch({ widthMm }, "w")}
      />
      {layer.shape !== "circle" && (
        <NumberField
          label="גובה"
          value={layer.heightMm}
          min={r.baseSizeMm.min}
          max={r.baseSizeMm.max}
          onChange={(heightMm) => patch({ heightMm }, "h")}
        />
      )}
      <NumberField
        label="עובי"
        value={layer.thicknessMm}
        min={r.baseThicknessMm.min}
        max={r.baseThicknessMm.max}
        step={0.5}
        onChange={(thicknessMm) => patch({ thicknessMm }, "t")}
      />
      {layer.shape === "roundedRectangle" && (
        <NumberField
          label="רדיוס פינה"
          value={layer.cornerRadiusMm}
          min={0}
          max={Math.min(layer.widthMm, layer.heightMm) / 2}
          onChange={(cornerRadiusMm) => patch({ cornerRadiusMm }, "r")}
        />
      )}

      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">מסגרת / שפה מוגבהת</span>
        <input
          type="checkbox"
          className="size-4 accent-blue-600"
          checked={layer.rim.enabled}
          onChange={(e) => patch({ rim: { ...layer.rim, enabled: e.target.checked } })}
        />
      </label>
      {layer.rim.enabled && (
        <>
          <NumberField
            label="רוחב מסגרת"
            value={layer.rim.widthMm}
            min={r.rimWidthMm.min}
            max={r.rimWidthMm.max}
            step={0.5}
            onChange={(widthMm) => patch({ rim: { ...layer.rim, widthMm } }, "rw")}
          />
          <NumberField
            label="גובה מסגרת"
            value={layer.rim.heightMm}
            min={r.rimHeightMm.min}
            max={r.rimHeightMm.max}
            step={0.2}
            onChange={(heightMm) => patch({ rim: { ...layer.rim, heightMm } }, "rh")}
          />
        </>
      )}
    </div>
  );
}
