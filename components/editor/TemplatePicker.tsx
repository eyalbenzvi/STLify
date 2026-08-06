"use client";

import { TEMPLATES } from "@/lib/geometry/templates";
import type { TemplateId } from "@/lib/geometry/types";

interface TemplatePickerProps {
  value: TemplateId;
  onChange: (id: TemplateId) => void;
}

/** Grid of template cards. Selecting one loads its full preset. */
export function TemplatePicker({ value, onChange }: TemplatePickerProps) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {TEMPLATES.map((template) => (
        <button
          key={template.id}
          type="button"
          className={`flex flex-col items-center gap-1 rounded-lg border p-3 text-sm transition-colors ${
            template.id === value
              ? "border-blue-600 bg-blue-50 font-semibold text-blue-700"
              : "border-slate-300 bg-white text-slate-600 hover:border-blue-300"
          }`}
          onClick={() => onChange(template.id)}
        >
          <span className="text-2xl" aria-hidden>
            {template.icon}
          </span>
          {template.nameHe}
        </button>
      ))}
    </div>
  );
}
