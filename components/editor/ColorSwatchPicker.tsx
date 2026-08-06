"use client";

/**
 * Colour picker: preset filament-inspired palette, session-recent colours,
 * a native colour input and HEX text entry.
 */

import { useState } from "react";
import { FILAMENT_PALETTE } from "@/lib/design/defaults";
import { useSessionPrefs } from "@/lib/design/sessionPrefs";

interface ColorSwatchPickerProps {
  value: string;
  onChange: (hex: string) => void;
}

export function ColorSwatchPicker({ value, onChange }: ColorSwatchPickerProps) {
  const prefs = useSessionPrefs();
  const [hexInput, setHexInput] = useState(value);
  const [lastValue, setLastValue] = useState(value);

  // Render-time sync when the layer colour changes externally.
  if (value !== lastValue) {
    setLastValue(value);
    setHexInput(value);
  }

  const commitHex = (raw: string): void => {
    const cleaned = raw.trim().startsWith("#") ? raw.trim() : `#${raw.trim()}`;
    if (/^#[0-9a-fA-F]{6}$/.test(cleaned)) onChange(cleaned.toLowerCase());
    else setHexInput(value);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="פלטת צבעים">
        {FILAMENT_PALETTE.map((color) => (
          <button
            key={color.hex}
            type="button"
            title={color.name}
            aria-label={`בחירת צבע ${color.name}`}
            className={`size-6 rounded-full border-2 transition-transform hover:scale-110 ${
              value === color.hex ? "border-blue-500 ring-2 ring-blue-200" : "border-white shadow-sm"
            }`}
            style={{ backgroundColor: color.hex }}
            onClick={() => onChange(color.hex)}
          />
        ))}
      </div>

      {prefs.recentColors.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] text-slate-400">אחרונים (הפעלה נוכחית)</p>
          <div className="flex flex-wrap gap-1.5">
            {prefs.recentColors.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={`בחירת צבע ${hex}`}
                className={`size-5 rounded-full border ${value === hex ? "border-blue-500" : "border-slate-200"}`}
                style={{ backgroundColor: hex }}
                onClick={() => onChange(hex)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label="בוחר צבע חופשי"
          className="h-8 w-10 cursor-pointer rounded border border-slate-300"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          type="text"
          dir="ltr"
          aria-label="קוד צבע HEX"
          className="w-24 rounded-md border border-slate-300 px-2 py-1 font-mono text-xs outline-none focus:border-blue-500"
          value={hexInput}
          onChange={(e) => setHexInput(e.target.value)}
          onBlur={(e) => commitHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitHex((e.target as HTMLInputElement).value);
          }}
        />
      </div>
    </div>
  );
}
