"use client";

interface ToggleOption<T extends string> {
  value: T;
  label: string;
  /** Render the option unclickable; pair with `title` to say why. */
  disabled?: boolean;
  /** Tooltip, mainly for explaining a disabled option. */
  title?: string;
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
      <span className="text-slate-600" id={`toggle-${label}`}>
        {label}
      </span>
      {/*
        A segmented control is semantically a radio group: exactly one option
        is active. Rendering it as loose buttons left screen-reader users with
        no way to tell which one was selected.
      */}
      <div
        role="radiogroup"
        aria-labelledby={`toggle-${label}`}
        className="flex overflow-hidden rounded-md border border-slate-300"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            disabled={option.disabled}
            title={option.title}
            className={`px-3 py-1 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40 ${
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
