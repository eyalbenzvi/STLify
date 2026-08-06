"use client";

interface ToggleOption<T extends string> {
  value: T;
  label: string;
}

interface ToggleGroupProps<T extends string> {
  label: string;
  value: T;
  options: ToggleOption<T>[];
  onChange: (value: T) => void;
}

/** Segmented-button control for small enumerations. */
export function ToggleGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: ToggleGroupProps<T>) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-slate-600">{label}</span>
      <div className="flex overflow-hidden rounded-md border border-slate-300">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`px-3 py-1 text-sm transition-colors ${
              option.value === value
                ? "bg-blue-600 text-white"
                : "bg-white text-slate-600 hover:bg-slate-100"
            }`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
