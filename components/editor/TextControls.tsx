"use client";

import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { FONTS, fontHasBold } from "@/lib/geometry/fonts";
import { PARAM_RANGES, type TextParams } from "@/lib/geometry/types";

interface TextControlsProps {
  value: TextParams;
  onChange: (patch: Partial<TextParams>) => void;
}

export function TextControls({ value, onChange }: TextControlsProps) {
  const boldAvailable = fontHasBold(value.fontId);
  const r = PARAM_RANGES;

  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-slate-600">תוכן הטקסט</span>
        <textarea
          className="min-h-16 rounded-md border border-slate-300 px-2 py-1 text-base outline-none focus:border-blue-500"
          value={value.content}
          maxLength={r.maxTextLength}
          rows={2}
          placeholder="הקלידו טקסט…"
          onChange={(e) => onChange({ content: e.target.value })}
        />
      </label>

      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">גופן</span>
        <select
          className="w-40 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:border-blue-500"
          value={value.fontId}
          onChange={(e) => {
            const fontId = e.target.value as TextParams["fontId"];
            onChange({
              fontId,
              bold: value.bold && fontHasBold(fontId),
            });
          }}
        >
          {FONTS.map((font) => (
            <option key={font.id} value={font.id}>
              {font.nameHe}
            </option>
          ))}
        </select>
      </label>

      <label
        className={`flex items-center justify-between gap-2 text-sm ${boldAvailable ? "" : "opacity-40"}`}
      >
        <span className="text-slate-600">
          מודגש {boldAvailable ? "" : "(לא זמין בגופן זה)"}
        </span>
        <input
          type="checkbox"
          className="size-4 accent-blue-600"
          checked={value.bold && boldAvailable}
          disabled={!boldAvailable}
          onChange={(e) => onChange({ bold: e.target.checked })}
        />
      </label>

      <NumberField
        label="גודל טקסט"
        value={value.sizeMm}
        min={r.textSizeMm.min}
        max={r.textSizeMm.max}
        onChange={(sizeMm) => onChange({ sizeMm })}
      />

      <ToggleGroup
        label="יישור"
        value={value.align}
        options={[
          { value: "right", label: "ימין" },
          { value: "center", label: "מרכז" },
          { value: "left", label: "שמאל" },
        ]}
        onChange={(align) => onChange({ align })}
      />

      <ToggleGroup
        label="סגנון"
        value={value.mode}
        options={[
          { value: "raised", label: "מובלט" },
          { value: "engraved", label: "חרוט" },
        ]}
        onChange={(mode) => onChange({ mode })}
      />

      <NumberField
        label={value.mode === "raised" ? "גובה הבלטה" : "עומק חריטה"}
        value={value.depthMm}
        min={r.textDepthMm.min}
        max={r.textDepthMm.max}
        step={0.1}
        onChange={(depthMm) => onChange({ depthMm })}
      />

      <NumberField
        label="הזזה אופקית (X)"
        value={value.offsetXMm}
        min={r.textOffsetMm.min}
        max={r.textOffsetMm.max}
        onChange={(offsetXMm) => onChange({ offsetXMm })}
      />

      <NumberField
        label="הזזה אנכית (Y)"
        value={value.offsetYMm}
        min={r.textOffsetMm.min}
        max={r.textOffsetMm.max}
        onChange={(offsetYMm) => onChange({ offsetYMm })}
      />
    </>
  );
}
