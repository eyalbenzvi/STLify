"use client";

interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Optional value formatter for the readout. */
  format?: (v: number) => string;
  onChange: (value: number) => void;
}

/** Labelled range slider with a numeric readout. */
export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
}: SliderFieldProps) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span className="w-24 shrink-0 text-slate-600">{label}</span>
      <input
        type="range"
        dir="ltr"
        className="min-w-0 flex-1 accent-blue-600"
        value={value}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-12 shrink-0 text-end font-mono text-xs text-slate-500" dir="ltr">
        {format ? format(value) : value}
      </span>
    </label>
  );
}
