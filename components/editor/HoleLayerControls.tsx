"use client";

import type { HoleLayer } from "@/types/design";
import { updateLayer } from "@/lib/design/store";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { RANGES_V2 } from "@/lib/geometry/validateDesign";

export function HoleLayerControls({ layer }: { layer: HoleLayer }) {
  const r = RANGES_V2;
  const patch = (p: Partial<HoleLayer>, key?: string) =>
    updateLayer(layer.id, p, { coalesceKey: key ? `hole:${layer.id}:${key}` : null });

  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        label="צורה"
        value={layer.shape}
        options={[
          { value: "circle", label: "עגול" },
          { value: "rectangle", label: "מלבני" },
        ]}
        onChange={(shape) => patch({ shape })}
      />

      {layer.shape === "circle" ? (
        <NumberField
          label="קוטר"
          value={layer.diameterMm}
          min={r.holeDiameterMm.min}
          max={r.holeDiameterMm.max}
          step={0.5}
          onChange={(diameterMm) => patch({ diameterMm }, "d")}
        />
      ) : (
        <>
          <NumberField
            label="רוחב"
            value={layer.widthMm}
            min={r.holeRectMm.min}
            max={r.holeRectMm.max}
            onChange={(widthMm) => patch({ widthMm }, "w")}
          />
          <NumberField
            label="גובה"
            value={layer.heightMm}
            min={r.holeRectMm.min}
            max={r.holeRectMm.max}
            onChange={(heightMm) => patch({ heightMm }, "h")}
          />
          <NumberField
            label="רדיוס פינה"
            value={layer.cornerRadiusMm}
            min={0}
            max={Math.min(layer.widthMm, layer.heightMm) / 2}
            step={0.5}
            onChange={(cornerRadiusMm) => patch({ cornerRadiusMm }, "cr")}
          />
        </>
      )}

      <ToggleGroup
        label="סוג"
        value={layer.through ? "through" : "pocket"}
        options={[
          { value: "through", label: "חור מפולש" },
          { value: "pocket", label: "כיס (עיוור)" },
        ]}
        onChange={(v) => patch({ through: v === "through" })}
      />

      {!layer.through && (
        <>
          <NumberField
            label="עומק כיס"
            value={layer.depthMm}
            min={0.2}
            max={50}
            step={0.1}
            onChange={(depthMm) => patch({ depthMm }, "depth")}
          />
          <ToggleGroup
            label="פתיחה"
            value={layer.fromBottom ? "bottom" : "top"}
            options={[
              { value: "top", label: "מלמעלה" },
              { value: "bottom", label: "מאחור (מגנט)" },
            ]}
            onChange={(v) => patch({ fromBottom: v === "bottom" })}
          />
        </>
      )}
    </div>
  );
}
