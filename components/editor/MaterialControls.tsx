"use client";

const PRESET_COLORS = [
  "#2f6feb",
  "#e0483e",
  "#4b9b6e",
  "#c99b3f",
  "#7c5cde",
  "#3aa8b8",
  "#444a55",
  "#d9d9d9",
];

interface MaterialControlsProps {
  value: string;
  onChange: (color: string) => void;
}

/** Preview material colour picker (visual only — does not affect the STL). */
export function MaterialControls({ value, onChange }: MaterialControlsProps) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-slate-600">צבע תצוגה</span>
      <div className="flex items-center gap-1">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`צבע ${color}`}
            className={`size-5 rounded-full border transition-transform hover:scale-110 ${
              value.toLowerCase() === color ? "ring-2 ring-blue-500 ring-offset-1" : "border-slate-300"
            }`}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
          />
        ))}
        <input
          type="color"
          aria-label="צבע מותאם אישית"
          className="size-6 cursor-pointer rounded border border-slate-300 bg-white p-0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
