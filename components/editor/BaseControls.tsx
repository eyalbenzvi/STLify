"use client";

import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { maxCornerRadius } from "@/lib/geometry/validation";
import { PARAM_RANGES, type BaseParams } from "@/lib/geometry/types";

interface BaseControlsProps {
  value: BaseParams;
  onChange: (patch: Partial<BaseParams>) => void;
}

export function BaseControls({ value, onChange }: BaseControlsProps) {
  const r = PARAM_RANGES;
  const cornerMax = Math.floor(maxCornerRadius(value.widthMm, value.heightMm));

  return (
    <>
      <ToggleGroup
        label="צורת בסיס"
        value={value.shape}
        options={[
          { value: "rectangle", label: "מלבן" },
          { value: "roundedRectangle", label: "פינות מעוגלות" },
        ]}
        onChange={(shape) => onChange({ shape })}
      />

      <NumberField
        label="רוחב (X)"
        value={value.widthMm}
        min={r.baseWidthMm.min}
        max={r.baseWidthMm.max}
        onChange={(widthMm) => onChange({ widthMm })}
      />

      <NumberField
        label="גובה (Y)"
        value={value.heightMm}
        min={r.baseHeightMm.min}
        max={r.baseHeightMm.max}
        onChange={(heightMm) => onChange({ heightMm })}
      />

      <NumberField
        label="עובי (Z)"
        value={value.thicknessMm}
        min={r.baseThicknessMm.min}
        max={r.baseThicknessMm.max}
        step={0.5}
        onChange={(thicknessMm) => onChange({ thicknessMm })}
      />

      {value.shape === "roundedRectangle" && (
        <NumberField
          label="רדיוס פינה"
          value={value.cornerRadiusMm}
          min={0}
          max={cornerMax}
          step={0.5}
          onChange={(cornerRadiusMm) => onChange({ cornerRadiusMm })}
        />
      )}
    </>
  );
}
