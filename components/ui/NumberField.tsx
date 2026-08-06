"use client";

import { useState } from "react";
import { clampNumber, parseNumericInput } from "@/lib/geometry/validation";

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Unit suffix; defaults to millimetres. */
  unit?: string;
  onChange: (value: number) => void;
}

/**
 * Controlled numeric input with graceful invalid-input handling: free typing
 * is allowed, valid values propagate immediately, and the field snaps back
 * to the last valid value on blur.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "מ״מ",
  onChange,
}: NumberFieldProps) {
  const [raw, setRaw] = useState<string>(String(value));
  const [focused, setFocused] = useState(false);
  const [lastValue, setLastValue] = useState(value);

  // Sync external value changes (template switch, reset) while not editing.
  // Render-time state adjustment — the React-recommended replacement for a
  // setState-in-effect prop sync.
  if (value !== lastValue) {
    setLastValue(value);
    if (!focused) setRaw(String(value));
  }

  const parsed = parseNumericInput(raw);
  const isInvalid = parsed === null || parsed < min || parsed > max;

  const handleChange = (next: string) => {
    setRaw(next);
    const num = parseNumericInput(next);
    if (num !== null && num >= min && num <= max) {
      onChange(num);
    }
  };

  const handleBlur = () => {
    setFocused(false);
    const num = parseNumericInput(raw);
    if (num === null) {
      setRaw(String(value));
    } else {
      const clamped = clampNumber(num, min, max, value);
      setRaw(String(clamped));
      if (clamped !== value) onChange(clamped);
    }
  };

  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          dir="ltr"
          className={`w-24 rounded-md border px-2 py-1 text-end text-sm outline-none transition-colors focus:border-blue-500 ${
            isInvalid && focused
              ? "border-red-400 bg-red-50"
              : "border-slate-300 bg-white"
          }`}
          value={raw}
          min={min}
          max={max}
          step={step}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
        />
        <span className="w-8 text-xs text-slate-400">{unit}</span>
      </span>
    </label>
  );
}
