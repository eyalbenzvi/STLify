"use client";

/**
 * Undo history, parameters, modifier stack and the session memory readout.
 *
 * The history stack already carried a Hebrew label for every step but never
 * showed it: undo was a blind keystroke. Listing the steps turns it into
 * navigation — click any entry to jump straight there.
 */

import type { EditorHistoryState, ParameterDefinition } from "@/types/design";
import type { Modifier, ModifierKind } from "@/lib/geometry/modifiers";
import { describeModifier, MODIFIER_NAMES_HE } from "@/lib/geometry/modifiers";
import type { MeshStoreStats } from "@/lib/geometry/meshStore";
import { NumberField } from "@/components/ui/NumberField";

export interface HistoryPanelProps {
  history: EditorHistoryState;
  /** Steps back (negative) or forward (positive) from the present. */
  onJump: (delta: number) => void;
}

export function HistoryPanel({ history, onJump }: HistoryPanelProps) {
  const entries = [
    ...history.past.map((entry, i) => ({
      labelHe: entry.labelHe,
      delta: -(history.past.length - i),
      state: "past" as const,
    })),
    { labelHe: history.present.labelHe, delta: 0, state: "present" as const },
    ...history.future.map((entry, i) => ({
      labelHe: entry.labelHe,
      delta: i + 1,
      state: "future" as const,
    })),
  ];

  return (
    <ol className="flex max-h-64 flex-col gap-0.5 overflow-y-auto text-xs">
      {entries.map((entry, index) => (
        <li key={`${entry.delta}_${index}`}>
          <button
            type="button"
            disabled={entry.state === "present"}
            onClick={() => onJump(entry.delta)}
            className={`w-full rounded px-2 py-1 text-start transition-colors ${
              entry.state === "present"
                ? "cursor-default bg-blue-600 font-bold text-white"
                : entry.state === "future"
                  ? "text-slate-400 hover:bg-slate-100"
                  : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {entry.labelHe}
            {entry.state === "future" && <span className="ms-1 text-[10px]">(בוטל)</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface ParametersPanelProps {
  parameters: ParameterDefinition[];
  /** Resolved values, so the panel can show what an expression evaluates to. */
  resolved: ReadonlyMap<string, number>;
  errors: ReadonlyMap<string, string>;
  onChange: (parameters: ParameterDefinition[]) => void;
}

export function ParametersPanel({
  parameters,
  resolved,
  errors,
  onChange,
}: ParametersPanelProps) {
  const update = (index: number, patch: Partial<ParameterDefinition>) => {
    onChange(parameters.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  return (
    <div className="flex flex-col gap-2">
      {parameters.length === 0 && (
        <p className="text-[11px] leading-snug text-slate-400">
          פרמטרים בעלי שם מאפשרים להגדיר מידה פעם אחת ולהשתמש בה בכל מקום —
          למשל <code>עובי</code>, ואז לקשור שדה כלשהו לביטוי{" "}
          <code>עובי * 2</code>. שינוי הפרמטר מעדכן את כל מה שתלוי בו.
        </p>
      )}
      {parameters.map((parameter, index) => {
        const error = errors.get(parameter.name);
        const value = resolved.get(parameter.name);
        return (
          <div
            key={`${parameter.name}_${index}`}
            className="rounded-md border border-slate-200 p-2"
          >
            <div className="flex items-center gap-1">
              <input
                className="min-w-0 flex-1 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                value={parameter.name}
                aria-label="שם הפרמטר"
                onChange={(e) => update(index, { name: e.target.value })}
              />
              <button
                type="button"
                aria-label={`מחיקת הפרמטר ${parameter.name}`}
                className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-50"
                onClick={() => onChange(parameters.filter((_, i) => i !== index))}
              >
                מחק
              </button>
            </div>
            <div className="mt-1 flex items-center gap-1">
              <NumberField
                label="ערך"
                value={parameter.value}
                min={-100000}
                max={100000}
                step={0.1}
                unit=""
                onChange={(v) => update(index, { value: v })}
              />
            </div>
            <input
              className="mt-1 w-full rounded border border-slate-300 px-1.5 py-0.5 text-xs"
              placeholder="ביטוי (אופציונלי), למשל: עובי * 2"
              value={parameter.expression}
              aria-label={`ביטוי עבור ${parameter.name}`}
              onChange={(e) => update(index, { expression: e.target.value })}
            />
            {error ? (
              <p className="mt-0.5 text-[11px] text-red-700">{error}</p>
            ) : parameter.expression.trim() ? (
              <p className="mt-0.5 text-[11px] text-slate-400">
                = {value?.toFixed(3)}
              </p>
            ) : null}
          </div>
        );
      })}
      <button
        type="button"
        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
        onClick={() =>
          onChange([
            ...parameters,
            {
              name: `param${parameters.length + 1}`,
              value: 10,
              expression: "",
              noteHe: "",
            },
          ])
        }
      >
        + פרמטר
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modifier stack
// ---------------------------------------------------------------------------

const MODIFIER_KINDS: ModifierKind[] = [
  "fillet",
  "shell",
  "bend",
  "twist",
  "taper",
  "stretch",
  "lattice",
  "remesh",
  "simplify",
  "smooth",
];

export interface ModifierStackPanelProps {
  modifiers: Modifier[];
  disabled: boolean;
  onChange: (modifiers: Modifier[]) => void;
  onAdd: (kind: ModifierKind) => void;
  onEdit: (id: string) => void;
}

export function ModifierStackPanel({
  modifiers,
  disabled,
  onChange,
  onAdd,
  onEdit,
}: ModifierStackPanelProps) {
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= modifiers.length) return;
    const next = [...modifiers];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      {modifiers.length === 0 && (
        <p className="text-[11px] leading-snug text-slate-400">
          מודיפיירים הם פעולות שנשארות ניתנות לעריכה: הן מחושבות מחדש מהגוף
          המקורי בכל שינוי, כך שאפשר לשנות רדיוס או עובי בכל רגע בלי לבטל
          פעולות אחרות.
        </p>
      )}
      <ol className="flex flex-col gap-1">
        {modifiers.map((modifier, index) => (
          <li
            key={modifier.id}
            className={`rounded-md border p-1.5 ${
              modifier.enabled ? "border-slate-300 bg-white" : "border-slate-200 bg-slate-50"
            }`}
          >
            <div className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={modifier.enabled}
                aria-label={`הפעלת ${MODIFIER_NAMES_HE[modifier.kind]}`}
                onChange={(e) =>
                  onChange(
                    modifiers.map((m) =>
                      m.id === modifier.id ? { ...m, enabled: e.target.checked } : m
                    )
                  )
                }
              />
              <button
                type="button"
                className="min-w-0 flex-1 text-start text-xs"
                onClick={() => onEdit(modifier.id)}
              >
                <span className={modifier.enabled ? "font-bold text-slate-700" : "text-slate-400"}>
                  {MODIFIER_NAMES_HE[modifier.kind]}
                </span>
                <span className="ms-1 text-[11px] text-slate-400">
                  {describeModifier(modifier)}
                </span>
              </button>
              <button
                type="button"
                aria-label="הזז למעלה"
                disabled={index === 0}
                className="rounded border border-slate-300 px-1 text-[10px] disabled:opacity-30"
                onClick={() => move(index, -1)}
              >
                ▲
              </button>
              <button
                type="button"
                aria-label="הזז למטה"
                disabled={index === modifiers.length - 1}
                className="rounded border border-slate-300 px-1 text-[10px] disabled:opacity-30"
                onClick={() => move(index, 1)}
              >
                ▼
              </button>
              <button
                type="button"
                aria-label="מחיקת מודיפייר"
                className="rounded border border-slate-300 px-1 text-[10px] text-slate-500"
                onClick={() => onChange(modifiers.filter((m) => m.id !== modifier.id))}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ol>
      <label className="flex items-center gap-1 text-xs">
        <span className="text-slate-500">הוסף:</span>
        <select
          className="flex-1 rounded-md border border-slate-300 px-1.5 py-1 text-xs"
          value=""
          disabled={disabled}
          aria-label="הוספת מודיפייר"
          onChange={(e) => {
            if (e.target.value) onAdd(e.target.value as ModifierKind);
            e.target.value = "";
          }}
        >
          <option value="">בחרו מודיפייר…</option>
          {MODIFIER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {MODIFIER_NAMES_HE[kind]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session memory
// ---------------------------------------------------------------------------

export function MemoryPanel({
  stats,
  onCollect,
}: {
  stats: MeshStoreStats;
  onCollect: () => void;
}) {
  const megabytes = stats.bytes / (1024 * 1024);
  const heavy = megabytes > 200;
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className={heavy ? "font-bold text-amber-700" : "text-slate-500"}>
        {stats.count} גופים בזיכרון · {megabytes.toFixed(1)} מ״ב
      </span>
      <button
        type="button"
        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
        onClick={onCollect}
      >
        פנה זיכרון
      </button>
    </div>
  );
}
