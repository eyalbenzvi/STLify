"use client";

/**
 * Parameter editors for the two layer types that had none.
 *
 * A primitive could be created but never resized, and a sketch was created
 * with a fixed rectangle that could not be touched — both were effectively
 * read-only bodies. These panels close that gap.
 *
 * Only the fields each primitive kind actually reads are shown. Rendering all
 * seven parameters for every kind would leave a cylinder with a "depth" box
 * that changes nothing, which is worse than useless: it teaches the user that
 * controls lie.
 */

import type {
  DesignLayer,
  PrimitiveKind,
  PrimitiveLayer,
  SketchEntity,
  SketchLayer,
} from "@/types/design";
import { NumberField } from "@/components/ui/NumberField";

type UpdateFn = (patch: Partial<DesignLayer>, labelHe: string) => void;

/** Which parameters each primitive kind consumes (see buildPrimitiveSolid). */
const PRIMITIVE_FIELDS: Record<
  PrimitiveKind,
  { field: keyof PrimitiveLayer; labelHe: string; min: number }[]
> = {
  box: [
    { field: "widthMm", labelHe: "רוחב (X)", min: 0.1 },
    { field: "depthMm", labelHe: "עומק (Y)", min: 0.1 },
    { field: "heightMm", labelHe: "גובה (Z)", min: 0.1 },
  ],
  wedge: [
    { field: "widthMm", labelHe: "רוחב (X)", min: 0.1 },
    { field: "depthMm", labelHe: "עומק (Y)", min: 0.1 },
    { field: "heightMm", labelHe: "גובה (Z)", min: 0.1 },
  ],
  cylinder: [
    { field: "radiusMm", labelHe: "רדיוס", min: 0.1 },
    { field: "heightMm", labelHe: "גובה", min: 0.1 },
  ],
  sphere: [{ field: "radiusMm", labelHe: "רדיוס", min: 0.1 }],
  cone: [
    { field: "radiusMm", labelHe: "רדיוס תחתון", min: 0.1 },
    { field: "radius2Mm", labelHe: "רדיוס עליון", min: 0 },
    { field: "heightMm", labelHe: "גובה", min: 0.1 },
  ],
  torus: [
    { field: "radiusMm", labelHe: "רדיוס ראשי", min: 0.1 },
    { field: "radius2Mm", labelHe: "רדיוס חתך", min: 0.05 },
  ],
  tube: [
    { field: "radiusMm", labelHe: "רדיוס חיצוני", min: 0.1 },
    { field: "radius2Mm", labelHe: "רדיוס פנימי", min: 0 },
    { field: "heightMm", labelHe: "גובה", min: 0 },
  ],
};

/** Kinds whose surface is curved and therefore has a facet count. */
const CURVED_KINDS: PrimitiveKind[] = ["cylinder", "sphere", "cone", "torus", "tube"];

const PRIMITIVE_NAMES_HE: Record<PrimitiveKind, string> = {
  box: "תיבה",
  cylinder: "גליל",
  sphere: "כדור",
  cone: "חרוט",
  torus: "טבעת",
  wedge: "טריז",
  tube: "צינור",
};

export function PrimitiveProps({
  layer,
  onUpdate,
}: {
  layer: PrimitiveLayer;
  onUpdate: UpdateFn;
}) {
  const fields = PRIMITIVE_FIELDS[layer.kind];

  return (
    <>
      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">סוג הגוף</span>
        <select
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={layer.kind}
          onChange={(e) =>
            onUpdate({ kind: e.target.value as PrimitiveKind }, "שינוי סוג גוף")
          }
        >
          {(Object.keys(PRIMITIVE_NAMES_HE) as PrimitiveKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {PRIMITIVE_NAMES_HE[kind]}
            </option>
          ))}
        </select>
      </label>

      {fields.map(({ field, labelHe, min }) => (
        <NumberField
          key={field}
          label={labelHe}
          value={layer[field] as number}
          min={min}
          max={2000}
          step={0.5}
          unit="מ״מ"
          onChange={(v) => onUpdate({ [field]: v } as Partial<DesignLayer>, `שינוי ${labelHe}`)}
        />
      ))}

      {CURVED_KINDS.includes(layer.kind) && (
        <NumberField
          label="חלקות (מקטעים)"
          value={layer.segments}
          min={3}
          max={256}
          step={1}
          unit=""
          onChange={(v) => onUpdate({ segments: Math.round(v) }, "שינוי חלקות")}
        />
      )}

      {layer.kind === "tube" && layer.radius2Mm >= layer.radiusMm && (
        <p className="rounded-md bg-red-50 p-2 text-[11px] text-red-700">
          הרדיוס הפנימי חייב להיות קטן מהחיצוני — הגוף לא ייבנה.
        </p>
      )}
      {layer.kind === "torus" && layer.radius2Mm >= layer.radiusMm && (
        <p className="rounded-md bg-red-50 p-2 text-[11px] text-red-700">
          רדיוס החתך חייב להיות קטן מהרדיוס הראשי — הגוף לא ייבנה.
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sketch
// ---------------------------------------------------------------------------

const ENTITY_NAMES_HE: Record<SketchEntity["kind"], string> = {
  rectangle: "מלבן",
  circle: "עיגול",
  ellipse: "אליפסה",
  polygon: "מצולע",
  polyline: "קו שבור",
  bezier: "עקומה",
};

/** A fresh entity of each kind, placed at the sketch origin. */
function newEntity(kind: SketchEntity["kind"]): SketchEntity {
  switch (kind) {
    case "rectangle":
      return { kind, x: 0, y: 0, widthMm: 20, heightMm: 12, cornerRadiusMm: 0, rotationDeg: 0 };
    case "circle":
      return { kind, x: 0, y: 0, radiusMm: 8 };
    case "ellipse":
      return { kind, x: 0, y: 0, radiusXMm: 12, radiusYMm: 7, rotationDeg: 0 };
    case "polygon":
      return { kind, x: 0, y: 0, radiusMm: 10, sides: 6, rotationDeg: 0 };
    case "polyline":
      return {
        kind,
        points: [
          [-10, 0],
          [10, 0],
        ],
        closed: false,
        strokeWidthMm: 2,
      };
    case "bezier":
      return {
        kind,
        points: [
          [-12, 0],
          [0, 12],
          [12, 0],
        ],
        closed: false,
        strokeWidthMm: 2,
      };
  }
}

/** Numeric fields per entity kind, so each editor shows only what it uses. */
function entityFields(
  entity: SketchEntity
): { field: string; labelHe: string; min: number; max: number; step: number; unit: string }[] {
  const position = [
    { field: "x", labelHe: "מיקום X", min: -1000, max: 1000, step: 0.5, unit: "מ״מ" },
    { field: "y", labelHe: "מיקום Y", min: -1000, max: 1000, step: 0.5, unit: "מ״מ" },
  ];
  switch (entity.kind) {
    case "rectangle":
      return [
        ...position,
        { field: "widthMm", labelHe: "רוחב", min: 0.1, max: 1000, step: 0.5, unit: "מ״מ" },
        { field: "heightMm", labelHe: "גובה", min: 0.1, max: 1000, step: 0.5, unit: "מ״מ" },
        { field: "cornerRadiusMm", labelHe: "רדיוס פינה", min: 0, max: 500, step: 0.5, unit: "מ״מ" },
        { field: "rotationDeg", labelHe: "סיבוב", min: -360, max: 360, step: 1, unit: "°" },
      ];
    case "circle":
      return [
        ...position,
        { field: "radiusMm", labelHe: "רדיוס", min: 0.1, max: 1000, step: 0.5, unit: "מ״מ" },
      ];
    case "ellipse":
      return [
        ...position,
        { field: "radiusXMm", labelHe: "רדיוס X", min: 0.1, max: 1000, step: 0.5, unit: "מ״מ" },
        { field: "radiusYMm", labelHe: "רדיוס Y", min: 0.1, max: 1000, step: 0.5, unit: "מ״מ" },
        { field: "rotationDeg", labelHe: "סיבוב", min: -360, max: 360, step: 1, unit: "°" },
      ];
    case "polygon":
      return [
        ...position,
        { field: "radiusMm", labelHe: "רדיוס", min: 0.1, max: 1000, step: 0.5, unit: "מ״מ" },
        { field: "sides", labelHe: "מספר צלעות", min: 3, max: 64, step: 1, unit: "" },
        { field: "rotationDeg", labelHe: "סיבוב", min: -360, max: 360, step: 1, unit: "°" },
      ];
    case "polyline":
    case "bezier":
      return [
        { field: "strokeWidthMm", labelHe: "עובי קו", min: 0.1, max: 100, step: 0.1, unit: "מ״מ" },
      ];
  }
}

export function SketchProps({
  layer,
  onUpdate,
  extraControls,
}: {
  layer: SketchLayer;
  onUpdate: UpdateFn;
  /** Combine mode + bevel, supplied by the parent so this file stays generic. */
  extraControls?: React.ReactNode;
}) {
  const setEntities = (entities: SketchEntity[], labelHe: string) =>
    onUpdate({ entities } as Partial<DesignLayer>, labelHe);

  const patchEntity = (index: number, patch: Record<string, unknown>) => {
    setEntities(
      layer.entities.map((e, i) => (i === index ? ({ ...e, ...patch } as SketchEntity) : e)),
      "עריכת סקיצה"
    );
  };

  return (
    <>
      <NumberField
        label="עובי/עומק"
        value={layer.extrudeMm}
        min={0.2}
        max={500}
        step={0.1}
        unit="מ״מ"
        onChange={(v) => onUpdate({ extrudeMm: v }, "עובי סקיצה")}
      />
      {extraControls}

      <div className="rounded-md border border-slate-200 p-2">
        <p className="mb-1.5 text-xs font-bold text-slate-500">
          צורות בסקיצה ({layer.entities.length})
        </p>
        {layer.entities.length === 0 && (
          <p className="mb-1.5 text-[11px] text-slate-400">
            סקיצה ריקה לא תייצר גוף. הוסיפו צורה אחת לפחות.
          </p>
        )}

        <ol className="flex flex-col gap-1.5">
          {layer.entities.map((entity, index) => (
            <li key={index} className="rounded-md border border-slate-200 bg-slate-50 p-1.5">
              <div className="mb-1 flex items-center justify-between gap-1">
                <span className="text-xs font-bold text-slate-600">
                  {ENTITY_NAMES_HE[entity.kind]}
                </span>
                <button
                  type="button"
                  aria-label={`מחיקת ${ENTITY_NAMES_HE[entity.kind]}`}
                  className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-white"
                  onClick={() =>
                    setEntities(
                      layer.entities.filter((_, i) => i !== index),
                      "מחיקת צורה מסקיצה"
                    )
                  }
                >
                  מחק
                </button>
              </div>
              <div className="flex flex-col gap-1">
                {entityFields(entity).map(({ field, labelHe, min, max, step, unit }) => (
                  <NumberField
                    key={field}
                    label={labelHe}
                    value={(entity as unknown as Record<string, number>)[field]}
                    min={min}
                    max={max}
                    step={step}
                    unit={unit}
                    onChange={(v) =>
                      patchEntity(index, { [field]: field === "sides" ? Math.round(v) : v })
                    }
                  />
                ))}
                {(entity.kind === "polyline" || entity.kind === "bezier") && (
                  <label className="flex items-center justify-between text-xs">
                    <span className="text-slate-600">סגור (ממולא)</span>
                    <input
                      type="checkbox"
                      checked={entity.closed}
                      onChange={(e) => patchEntity(index, { closed: e.target.checked })}
                    />
                  </label>
                )}
              </div>
            </li>
          ))}
        </ol>

        <label className="mt-2 flex items-center gap-1 text-xs">
          <span className="text-slate-500">הוסף:</span>
          <select
            className="flex-1 rounded-md border border-slate-300 px-1.5 py-1 text-xs"
            value=""
            aria-label="הוספת צורה לסקיצה"
            onChange={(e) => {
              if (!e.target.value) return;
              setEntities(
                [...layer.entities, newEntity(e.target.value as SketchEntity["kind"])],
                "הוספת צורה לסקיצה"
              );
              e.target.value = "";
            }}
          >
            <option value="">בחרו צורה…</option>
            {(Object.keys(ENTITY_NAMES_HE) as SketchEntity["kind"][]).map((kind) => (
              <option key={kind} value={kind}>
                {ENTITY_NAMES_HE[kind]}
              </option>
            ))}
          </select>
        </label>

        <p className="mt-1.5 text-[11px] leading-snug text-slate-400">
          צורות חופפות מתמזגות לגוף אחד. כדי לנקב חור, הוסיפו צורה פנימית
          וסובבו אותה ב-180° — כיוון הפוך נחשב לחור.
        </p>
      </div>
    </>
  );
}

/** Pivot editor — the data model supported a pivot but nothing exposed it. */
export function PivotControls({
  layer,
  onUpdate,
}: {
  layer: DesignLayer;
  onUpdate: UpdateFn;
}) {
  const pivot = layer.pivot ?? { x: 0, y: 0, z: 0 };
  const set = (patch: Partial<{ x: number; y: number; z: number }>) =>
    onUpdate({ pivot: { ...pivot, ...patch } } as Partial<DesignLayer>, "נקודת ציר");

  return (
    <details className="rounded-md border border-slate-200 p-2">
      <summary className="cursor-pointer text-xs font-bold text-slate-500">
        נקודת ציר (סיבוב וקנה מידה)
      </summary>
      <div className="mt-2 flex flex-col gap-1">
        <NumberField label="ציר X" value={pivot.x} min={-1000} max={1000} step={0.5} unit="מ״מ" onChange={(x) => set({ x })} />
        <NumberField label="ציר Y" value={pivot.y} min={-1000} max={1000} step={0.5} unit="מ״מ" onChange={(y) => set({ y })} />
        <NumberField label="ציר Z" value={pivot.z} min={-1000} max={1000} step={0.5} unit="מ״מ" onChange={(z) => set({ z })} />
        <button
          type="button"
          className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          onClick={() => onUpdate({ pivot: { x: 0, y: 0, z: 0 } } as Partial<DesignLayer>, "איפוס נקודת ציר")}
        >
          אפס לראשית הגוף
        </button>
        <p className="text-[11px] leading-snug text-slate-400">
          הסיבוב וקנה המידה מתבצעים סביב הנקודה הזו. למשל, כדי לסובב מכסה
          סביב הציר שלו, הזיזו את נקודת הציר לקצה המכסה.
        </p>
      </div>
    </details>
  );
}
