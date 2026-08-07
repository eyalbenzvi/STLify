"use client";

/**
 * Editing one entry of a layer's modifier stack.
 */

import { Modal, ModalButton } from "@/components/ui/Modal";
import { NumberField } from "@/components/ui/NumberField";
import type { Modifier } from "@/lib/geometry/modifiers";
import { MODIFIER_NAMES_HE } from "@/lib/geometry/modifiers";

// ---------------------------------------------------------------------------
// Modifier editing
// ---------------------------------------------------------------------------

/**
 * Edit a modifier's parameters in place.
 *
 * Generic over the modifier union: every modifier is a flat record of
 * numbers and short enums, so the dialog reflects over its own fields rather
 * than hard-coding one form per kind. That keeps a new modifier kind from
 * needing a new dialog, and — more importantly — makes it obvious that
 * editing writes back into the STACK rather than baking a new mesh.
 */
const MODIFIER_FIELD_LABELS_HE: Record<string, string> = {
  sizeMm: "גודל (מ״מ)",
  style: "סוג",
  scope: "היקף",
  wallThicknessMm: "עובי דופן (מ״מ)",
  opening: "פאה פתוחה",
  axis: "ציר",
  towards: "כיוון",
  degrees: "זווית (°)",
  endScale: "קנה מידה בקצה",
  center: "מרכז (0..1)",
  amount: "עוצמה",
  falloff: "רוחב השפעה",
  latticeKind: "סוג סריג",
  cellSizeMm: "גודל תא (מ״מ)",
  thicknessMm: "עובי (מ״מ)",
  shellThicknessMm: "עובי מעטפת (מ״מ)",
  targetEdgeMm: "אורך צלע (מ״מ)",
  iterations: "מחזורים",
  featureAngleDeg: "זווית מאפיין (°)",
  toleranceMm: "סבילות (מ״מ)",
  minSharpAngleDeg: "זווית חדה (°)",
  refineEdgeMm: "צפיפות (מ״מ)",
};

const MODIFIER_ENUM_OPTIONS: Record<string, string[]> = {
  style: ["fillet", "chamfer"],
  scope: ["convex", "concave", "both"],
  axis: ["x", "y", "z"],
  towards: ["x", "y", "z"],
  opening: ["top", "bottom", "front", "back", "left", "right", "none"],
  latticeKind: ["gyroid", "schwarzP", "honeycomb"],
};

export function ModifierEditDialog({
  modifier,
  onClose,
  onChange,
}: {
  modifier: Modifier | null;
  onClose: () => void;
  onChange: (next: Modifier) => void;
}) {
  if (!modifier) return null;
  const entries = Object.entries(modifier).filter(
    ([key]) => key !== "id" && key !== "kind" && key !== "enabled"
  );

  return (
    <Modal
      title={`עריכת ${MODIFIER_NAMES_HE[modifier.kind]}`}
      open
      onClose={onClose}
      footer={<ModalButton variant="primary" onClick={onClose}>סגור</ModalButton>}
    >
      <div className="flex flex-col gap-3">
        {entries.map(([key, value]) => {
          const label = MODIFIER_FIELD_LABELS_HE[key] ?? key;
          const options = MODIFIER_ENUM_OPTIONS[key];
          if (options && typeof value === "string") {
            return (
              <label key={key} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-600">{label}</span>
                <select
                  className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                  value={value}
                  onChange={(e) =>
                    onChange({ ...modifier, [key]: e.target.value } as Modifier)
                  }
                >
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            );
          }
          if (typeof value !== "number") return null;
          return (
            <NumberField
              key={key}
              label={label}
              value={value}
              min={-1080}
              max={1080}
              step={0.1}
              unit=""
              onChange={(v) => onChange({ ...modifier, [key]: v } as Modifier)}
            />
          );
        })}
        <p className="text-[11px] leading-snug text-slate-400">
          השינוי מחושב מחדש מהגוף המקורי — לא נערמות פעולות זו על זו, ואפשר
          לחזור ולשנות כל פרמטר בכל שלב.
        </p>
      </div>
    </Modal>
  );
}
