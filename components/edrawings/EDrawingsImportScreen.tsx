"use client";

/**
 * The eDrawings import screen — a full-screen step between the file and the
 * editor.
 *
 * Separate from the editor's small import dialogs because an assembly asks
 * questions they have no room for: which of dozens of components to bring
 * in, in what unit (eDrawings stores metres), which way is up, at what scale
 * (a factory floor at 1:1 is thirty metres wide), and whether as separate
 * layers or one body. The answers are visible in a live preview before
 * anything touches the document.
 *
 * It also carries the rights confirmation: an eDrawings file can be
 * published with "allow STL export" switched off, and that flag is not yet
 * identified in the format (docs/EDRAWINGS-PLAN.md). Until it is, the person
 * importing confirms they are entitled to use the model.
 */

import dynamic from "next/dynamic";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { EDrawingsComponent } from "@/lib/import/edrawings/model";
import { EDRAWINGS_UNIT_LABELS_HE, type EDrawingsUnit } from "@/lib/import/edrawings/model";
import {
  DEFAULT_EDRAWINGS_PLACEMENT,
  EDRAWINGS_SCALE_PRESETS,
  fitScale,
  placedBounds,
  type EDrawingsPlacement,
  type EDrawingsUpAxis,
} from "@/lib/import/edrawings/placement";
import { IMPORT_TRIANGLE_BUDGET } from "@/lib/import/triangleBudget";
import type {
  EDrawingsImportChoice,
  EDrawingsLayerMode,
  EDrawingsPending,
} from "@/hooks/useEDrawingsImport";

const EDrawingsPreview = dynamic(
  () => import("./EDrawingsPreview").then((m) => m.EDrawingsPreview),
  { ssr: false, loading: () => <div className="h-full w-full bg-slate-100" /> }
);

/** Fit target offered next to the scale presets. */
const FIT_TARGET_MM = 200;
/** Above this, the screen suggests choosing a scale. */
const LARGE_MODEL_MM = 400;

function formatMm(value: number): string {
  if (value >= 1000) return `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} מ׳`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 2 : 0 })} מ״מ`;
}

function ComponentRow({
  component,
  checked,
  onToggle,
}: {
  component: EDrawingsComponent;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-100">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span
          aria-hidden
          className="inline-block h-3 w-3 shrink-0 rounded-full border border-slate-300"
          style={{ background: component.colorHex ?? "#9ca3af" }}
        />
        <span className="min-w-0 flex-1 truncate" title={component.name}>
          {component.name}
        </span>
        {!component.visibleInFile && (
          <span className="shrink-0 rounded bg-slate-200 px-1 text-[10px] text-slate-600">מוסתר בקובץ</span>
        )}
        <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
          {component.triangleCount.toLocaleString()} △
        </span>
      </label>
    </li>
  );
}

export function EDrawingsImportScreen({
  pending,
  onConfirm,
  onClose,
}: {
  pending: EDrawingsPending | null;
  onConfirm: (choice: EDrawingsImportChoice) => void;
  onClose: () => void;
}) {
  if (!pending) return null;
  // Keyed on the file so every new file starts from fresh choices.
  return (
    <ScreenBody
      key={`${pending.fileName}:${pending.model.components.length}`}
      pending={pending}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

function ScreenBody({
  pending,
  onConfirm,
  onClose,
}: {
  pending: EDrawingsPending;
  onConfirm: (choice: EDrawingsImportChoice) => void;
  onClose: () => void;
}) {
  const { model, fileName } = pending;
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(model.components.filter((c) => c.visibleInFile).map((c) => c.id))
  );
  const [placement, setPlacement] = useState<EDrawingsPlacement>(DEFAULT_EDRAWINGS_PLACEMENT);
  const [fitToTarget, setFitToTarget] = useState(false);
  const [mode, setMode] = useState<EDrawingsLayerMode>("layers");
  const [attested, setAttested] = useState(false);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    rootRef.current?.querySelector<HTMLElement>("button, input, select")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, []);

  const chosen = useMemo(
    () => model.components.filter((c) => selected.has(c.id)),
    [model.components, selected]
  );
  const effectivePlacement = useMemo<EDrawingsPlacement>(() => {
    if (!fitToTarget) return placement;
    return {
      ...placement,
      scale: fitScale(
        chosen.map((c) => c.bounds),
        placement.unit,
        FIT_TARGET_MM
      ),
    };
  }, [fitToTarget, placement, chosen]);

  const bounds = placedBounds(
    chosen.map((c) => c.bounds),
    effectivePlacement
  );
  const size = bounds ? bounds.max.map((v, i) => v - bounds.min[i]) : null;
  const triangles = chosen.reduce((sum, c) => sum + c.triangleCount, 0);
  const tooLarge = size !== null && Math.max(...size) > LARGE_MODEL_MM;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const canImport = attested && chosen.length > 0;
  const scaleValue = fitToTarget ? "fit" : String(placement.scale);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      dir="rtl"
      className="fixed inset-0 z-50 flex flex-col bg-white text-slate-800"
      data-testid="edrawings-screen"
    >
      <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-2">
        <h2 id={titleId} className="text-base font-bold">
          ייבוא eDrawings
        </h2>
        <span className="min-w-0 truncate text-sm text-slate-500" title={fileName}>
          {fileName}
        </span>
        <button
          type="button"
          className="ms-auto rounded px-2 py-1 text-lg leading-none text-slate-500 hover:bg-slate-100"
          aria-label="סגירה"
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[18rem_1fr_18rem] md:overflow-hidden">
        {/* Components */}
        <section className="flex min-h-0 flex-col border-b border-slate-200 md:border-b-0 md:border-e" aria-label="רכיבים">
          <div className="flex items-center gap-1 px-3 pt-3 text-sm">
            <h3 className="font-semibold">רכיבים ({model.components.length})</h3>
            <button
              type="button"
              className="ms-auto rounded px-1.5 text-xs text-blue-700 hover:bg-blue-50"
              onClick={() => setSelected(new Set(model.components.map((c) => c.id)))}
            >
              הכל
            </button>
            <button
              type="button"
              className="rounded px-1.5 text-xs text-blue-700 hover:bg-blue-50"
              onClick={() => setSelected(new Set())}
            >
              ללא
            </button>
          </div>
          <ul className="max-h-64 min-h-0 flex-1 overflow-y-auto p-2 md:max-h-none">
            {model.components.map((component) => (
              <ComponentRow
                key={component.id}
                component={component}
                checked={selected.has(component.id)}
                onToggle={() => toggle(component.id)}
              />
            ))}
          </ul>
        </section>

        {/* Preview */}
        <section className="relative h-72 min-h-0 md:h-auto" aria-label="תצוגה מקדימה">
          {chosen.length > 0 ? (
            <EDrawingsPreview components={chosen} placement={effectivePlacement} />
          ) : (
            <div className="flex h-full items-center justify-center bg-slate-100 text-sm text-slate-500">
              בחרו לפחות רכיב אחד
            </div>
          )}
          {size && (
            <p className="pointer-events-none absolute bottom-2 start-2 rounded bg-white/90 px-2 py-1 text-xs tabular-nums shadow" data-testid="edrawings-size">
              {formatMm(size[0])} × {formatMm(size[1])} × {formatMm(size[2])}
            </p>
          )}
        </section>

        {/* Options */}
        <section className="space-y-4 border-t border-slate-200 p-3 text-sm md:overflow-y-auto md:border-s md:border-t-0" aria-label="אפשרויות">
          <div className="space-y-1">
            <label className="block font-semibold" htmlFor={`${titleId}-unit`}>
              יחידות הקובץ
            </label>
            <select
              id={`${titleId}-unit`}
              className="w-full rounded border border-slate-300 px-2 py-1"
              value={placement.unit}
              onChange={(e) => setPlacement((p) => ({ ...p, unit: e.target.value as EDrawingsUnit }))}
            >
              {(Object.keys(EDRAWINGS_UNIT_LABELS_HE) as EDrawingsUnit[]).map((unit) => (
                <option key={unit} value={unit}>
                  {EDRAWINGS_UNIT_LABELS_HE[unit]}
                </option>
              ))}
            </select>
            {model.unitCheck === "verified" && placement.unit === "m" && (
              <p className="text-xs text-emerald-700">✓ אומת מול נתוני המסה שבקובץ</p>
            )}
            {model.unitCheck === "mismatch" && (
              <p className="text-xs text-amber-700">נתוני המסה בקובץ אינם תואמים — בדקו את המידות</p>
            )}
          </div>

          <div className="space-y-1">
            <label className="block font-semibold" htmlFor={`${titleId}-up`}>
              כיוון ״למעלה״
            </label>
            <select
              id={`${titleId}-up`}
              className="w-full rounded border border-slate-300 px-2 py-1"
              value={placement.upAxis}
              onChange={(e) => setPlacement((p) => ({ ...p, upAxis: e.target.value as EDrawingsUpAxis }))}
            >
              <option value="z">ציר Z (כפי שנשמר)</option>
              <option value="y">ציר Y (מודל שנבנה על מישור Top)</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="block font-semibold" htmlFor={`${titleId}-scale`}>
              קנה מידה
            </label>
            <select
              id={`${titleId}-scale`}
              className="w-full rounded border border-slate-300 px-2 py-1"
              value={scaleValue}
              onChange={(e) => {
                if (e.target.value === "fit") {
                  setFitToTarget(true);
                } else {
                  setFitToTarget(false);
                  setPlacement((p) => ({ ...p, scale: Number(e.target.value) }));
                }
              }}
            >
              {EDRAWINGS_SCALE_PRESETS.map((preset) => (
                <option key={preset.value} value={String(preset.value)}>
                  {preset.labelHe}
                </option>
              ))}
              <option value="fit">התאמה ל-{FIT_TARGET_MM} מ״מ</option>
            </select>
            {tooLarge && (
              <p className="rounded bg-amber-50 p-1.5 text-xs text-amber-800">
                הבחירה גדולה ממשטח הדפסה טיפוסי — שקלו קנה מידה מוקטן.
              </p>
            )}
          </div>

          <fieldset className="space-y-1">
            <legend className="font-semibold">אופן הייבוא</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name={`${titleId}-mode`} checked={mode === "layers"} onChange={() => setMode("layers")} />
              כל רכיב כשכבה נפרדת
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name={`${titleId}-mode`} checked={mode === "merged"} onChange={() => setMode("merged")} />
              איחוד לגוף אחד
            </label>
          </fieldset>

          <dl className="space-y-0.5 rounded bg-slate-50 p-2 text-xs text-slate-600">
            <div className="flex justify-between gap-2">
              <dt>פאות שפוענחו</dt>
              <dd className="tabular-nums">
                {model.facesDecoded.toLocaleString()} / {model.facesDeclared.toLocaleString()}
                {model.complete ? " ✓" : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>משולשים נבחרים</dt>
              <dd className="tabular-nums">{triangles.toLocaleString()}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>גרסת פורמט</dt>
              <dd>
                HSF {model.formatVersion}
                {model.configurationName ? ` · ${model.configurationName}` : ""}
              </dd>
            </div>
          </dl>
          {triangles > IMPORT_TRIANGLE_BUDGET && (
            <p className="rounded bg-amber-50 p-1.5 text-xs text-amber-800">
              הבחירה מכילה יותר מ-{IMPORT_TRIANGLE_BUDGET.toLocaleString()} משולשים — רכיבים יפושטו אוטומטית
              בייבוא.
            </p>
          )}
          {model.warningsHe.map((warning) => (
            <p key={warning} className="rounded bg-amber-50 p-1.5 text-xs text-amber-800">
              {warning}
            </p>
          ))}
          <p className="text-xs text-slate-500">
            eDrawings שומר רשת תצוגה, לא גאומטריית CAD מדויקת: משטחים מעוגלים מקורבים במשולשים, ובכל רכיב
            מופעל תיקון רשת אוטומטי לפני ההוספה לעורך.
          </p>
        </section>
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-4 py-2">
        <label className="flex min-w-0 flex-1 items-start gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={attested}
            onChange={(e) => setAttested(e.target.checked)}
          />
          <span>
            אני מאשר/ת שהמודל שלי, או שיש לי רשות מבעליו להשתמש בו ולהדפיס אותו. (לא ניתן עדיין לקרוא
            מהקובץ אם מחברו התיר ייצוא.)
          </span>
        </label>
        <button
          type="button"
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
          onClick={onClose}
        >
          ביטול
        </button>
        <button
          type="button"
          disabled={!canImport}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() =>
            onConfirm({
              componentIds: chosen.map((c) => c.id),
              placement: effectivePlacement,
              mode,
            })
          }
        >
          ייבוא לעורך ({chosen.length})
        </button>
      </footer>
    </div>
  );
}
