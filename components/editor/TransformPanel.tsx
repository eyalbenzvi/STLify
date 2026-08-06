"use client";

/**
 * Numeric transform editor: exact X/Y/Z position (mm), rotation (deg) and
 * scale for the selected layer, with uniform-scale lock and reset. World
 * mode edits the values directly (build-plate axes); Local mode is used by
 * the gizmo — the numbers always show the layer's stored transform.
 */

import { useState } from "react";
import type { Transform3D } from "@/types/design";
import { identityTransform } from "@/types/design";
import { NumberField } from "@/components/ui/NumberField";

export interface TransformPanelProps {
  transform: Transform3D;
  disabled?: boolean;
  onChange: (transform: Transform3D, labelHe: string) => void;
}

export function TransformPanel({ transform, disabled, onChange }: TransformPanelProps) {
  const [uniformScale, setUniformScale] = useState(true);

  const patch = (p: Partial<Transform3D>, labelHe: string) =>
    onChange({ ...transform, ...p }, labelHe);

  const setScale = (axis: "scaleX" | "scaleY" | "scaleZ", value: number) => {
    if (uniformScale) {
      onChange(
        { ...transform, scaleX: value, scaleY: value, scaleZ: value },
        "שינוי קנה מידה"
      );
    } else {
      patch({ [axis]: value } as Partial<Transform3D>, "שינוי קנה מידה");
    }
  };

  if (disabled) {
    return <p className="text-xs text-slate-400">השכבה נעולה — שחררו נעילה כדי לערוך.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold text-slate-500">מיקום (מ״מ)</p>
      <NumberField label="X" value={round3(transform.x)} min={-1000} max={1000} step={0.5} onChange={(v) => patch({ x: v }, "הזזה")} />
      <NumberField label="Y" value={round3(transform.y)} min={-1000} max={1000} step={0.5} onChange={(v) => patch({ y: v }, "הזזה")} />
      <NumberField label="Z" value={round3(transform.z)} min={-1000} max={1000} step={0.5} onChange={(v) => patch({ z: v }, "הזזה")} />

      <p className="mt-1 text-xs font-semibold text-slate-500">סיבוב (מעלות)</p>
      <NumberField label="סיבוב X" value={round3(transform.rotationX)} min={-360} max={360} step={5} unit="°" onChange={(v) => patch({ rotationX: v }, "סיבוב")} />
      <NumberField label="סיבוב Y" value={round3(transform.rotationY)} min={-360} max={360} step={5} unit="°" onChange={(v) => patch({ rotationY: v }, "סיבוב")} />
      <NumberField label="סיבוב Z" value={round3(transform.rotationZ)} min={-360} max={360} step={5} unit="°" onChange={(v) => patch({ rotationZ: v }, "סיבוב")} />

      <div className="mt-1 flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-500">קנה מידה</p>
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={uniformScale}
            onChange={(e) => setUniformScale(e.target.checked)}
          />
          נעילה אחידה
        </label>
      </div>
      <NumberField label="קנה X" value={round3(transform.scaleX)} min={-100} max={100} step={0.1} unit="×" onChange={(v) => setScale("scaleX", v)} />
      <NumberField label="קנה Y" value={round3(transform.scaleY)} min={-100} max={100} step={0.1} unit="×" onChange={(v) => setScale("scaleY", v)} />
      <NumberField label="קנה Z" value={round3(transform.scaleZ)} min={-100} max={100} step={0.1} unit="×" onChange={(v) => setScale("scaleZ", v)} />

      <button
        type="button"
        className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
        onClick={() => onChange(identityTransform(), "איפוס טרנספורמציה")}
      >
        איפוס טרנספורמציה
      </button>
    </div>
  );
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
