"use client";

import type { SvgLayer } from "@/types/design";
import { updateLayer } from "@/lib/design/store";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { RANGES_V2 } from "@/lib/geometry/validateDesign";

export function SvgLayerControls({
  layer,
  multiColorEnabled,
}: {
  layer: SvgLayer;
  multiColorEnabled: boolean;
}) {
  const r = RANGES_V2;
  const patch = (p: Partial<SvgLayer>, key?: string) =>
    updateLayer(layer.id, p, { coalesceKey: key ? `svg:${layer.id}:${key}` : null });

  const setWidth = (targetWidthMm: number): void => {
    if (layer.preserveAspect && layer.aspectRatio > 0) {
      patch({ targetWidthMm, targetHeightMm: round2(targetWidthMm / layer.aspectRatio) }, "w");
    } else {
      patch({ targetWidthMm }, "w");
    }
  };
  const setHeight = (targetHeightMm: number): void => {
    if (layer.preserveAspect && layer.aspectRatio > 0) {
      patch({ targetHeightMm, targetWidthMm: round2(targetHeightMm * layer.aspectRatio) }, "h");
    } else {
      patch({ targetHeightMm }, "h");
    }
  };

  const modeOptions: { value: SvgLayer["mode"]; label: string }[] = [
    { value: "raised", label: "מובלט" },
    { value: "engraved", label: "חרוט" },
  ];
  if (multiColorEnabled) modeOptions.push({ value: "inlay", label: "שיבוץ" });

  return (
    <div className="flex flex-col gap-3">
      <p className="truncate text-xs text-slate-400" dir="ltr" title={layer.sourceName}>
        {layer.sourceName}
      </p>

      <NumberField
        label="רוחב"
        value={round2(layer.targetWidthMm)}
        min={r.svgSizeMm.min}
        max={r.svgSizeMm.max}
        onChange={setWidth}
      />
      <NumberField
        label="גובה"
        value={round2(layer.targetHeightMm)}
        min={r.svgSizeMm.min}
        max={r.svgSizeMm.max}
        onChange={setHeight}
      />
      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">שמירה על יחס גובה-רוחב</span>
        <input
          type="checkbox"
          className="size-4 accent-blue-600"
          checked={layer.preserveAspect}
          onChange={(e) => patch({ preserveAspect: e.target.checked })}
        />
      </label>

      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">היפוך</span>
        <div className="flex gap-1.5">
          <button
            type="button"
            aria-pressed={layer.flipH}
            className={flipBtn(layer.flipH)}
            onClick={() => patch({ flipH: !layer.flipH })}
          >
            ⇄ אופקי
          </button>
          <button
            type="button"
            aria-pressed={layer.flipV}
            className={flipBtn(layer.flipV)}
            onClick={() => patch({ flipV: !layer.flipV })}
          >
            ⇅ אנכי
          </button>
        </div>
      </div>

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
      <ToggleGroup
        label="איכות עקומות"
        value={layer.quality}
        options={[
          { value: "draft", label: "טיוטה" },
          { value: "standard", label: "רגילה" },
          { value: "fine", label: "עדינה" },
        ]}
        onChange={(quality) => patch({ quality })}
      />

      {layer.importWarnings.length > 0 && (
        <ul className="flex flex-col gap-1">
          {layer.importWarnings.map((w, i) => (
            <li key={i} className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              ⚠️ {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function flipBtn(active: boolean): string {
  return `rounded-md border px-2 py-1 text-xs ${
    active
      ? "border-blue-400 bg-blue-50 text-blue-700"
      : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
  }`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
