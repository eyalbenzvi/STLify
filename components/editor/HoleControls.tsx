"use client";

import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { PARAM_RANGES, type HoleParams } from "@/lib/geometry/types";

interface HoleControlsProps {
  value: HoleParams;
  onChange: (patch: Partial<HoleParams>) => void;
}

export function HoleControls({ value, onChange }: HoleControlsProps) {
  const r = PARAM_RANGES;

  return (
    <>
      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">חור למחזיק מפתחות</span>
        <input
          type="checkbox"
          className="size-4 accent-blue-600"
          checked={value.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
      </label>

      {value.enabled && (
        <>
          <NumberField
            label="קוטר החור"
            value={value.diameterMm}
            min={r.holeDiameterMm.min}
            max={r.holeDiameterMm.max}
            step={0.5}
            onChange={(diameterMm) => onChange({ diameterMm })}
          />
          <NumberField
            label="מרחק מהשפה"
            value={value.edgeMarginMm}
            min={r.holeEdgeMarginMm.min}
            max={r.holeEdgeMarginMm.max}
            step={0.5}
            onChange={(edgeMarginMm) => onChange({ edgeMarginMm })}
          />
          <ToggleGroup
            label="מיקום"
            value={value.position}
            options={[
              { value: "right", label: "ימין" },
              { value: "left", label: "שמאל" },
              { value: "top", label: "למעלה" },
            ]}
            onChange={(position) => onChange({ position })}
          />
        </>
      )}
    </>
  );
}
