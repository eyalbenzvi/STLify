"use client";

/**
 * Shared transform editor for non-base layers: position (mm), rotation,
 * scale, reset, centring/alignment against the base, fit-to-base, and grid
 * snapping. Alignment uses the actual built-part bounds when available.
 */

import { useState } from "react";
import type { BaseLayer, DesignLayer, LayerTransform } from "@/types/design";
import { IDENTITY_TRANSFORM } from "@/types/design";
import { updateLayer } from "@/lib/design/store";
import { NumberField } from "@/components/ui/NumberField";

export interface PartBounds {
  min: { x: number; y: number };
  max: { x: number; y: number };
}

interface TransformControlsProps {
  layer: Exclude<DesignLayer, BaseLayer>;
  base: BaseLayer;
  /** XY bounds of this layer's built part, when it exists. */
  bounds: PartBounds | null;
}

export function TransformControls({ layer, base, bounds }: TransformControlsProps) {
  const t = layer.transform;
  const [snap, setSnap] = useState(false);
  const [snapStep, setSnapStep] = useState(1);

  const patch = (next: Partial<LayerTransform>, key: string): void => {
    const merged = { ...t, ...next };
    if (snap) {
      merged.x = Math.round(merged.x / snapStep) * snapStep;
      merged.y = Math.round(merged.y / snapStep) * snapStep;
    }
    updateLayer(layer.id, { transform: merged }, { coalesceKey: `t:${layer.id}:${key}` });
  };

  const baseHalfW = base.widthMm / 2;
  const baseHalfH = (base.shape === "circle" ? base.widthMm : base.heightMm) / 2;

  const align = (edge: "left" | "right" | "top" | "bottom" | "centerX" | "centerY"): void => {
    if (!bounds) return;
    const halfW = (bounds.max.x - bounds.min.x) / 2;
    const halfH = (bounds.max.y - bounds.min.y) / 2;
    const cx = (bounds.min.x + bounds.max.x) / 2 - t.x;
    const cy = (bounds.min.y + bounds.max.y) / 2 - t.y;
    switch (edge) {
      case "centerX":
        patch({ x: -cx }, "align");
        break;
      case "centerY":
        patch({ y: -cy }, "align");
        break;
      case "left":
        patch({ x: -baseHalfW + halfW - cx + 2 }, "align");
        break;
      case "right":
        patch({ x: baseHalfW - halfW - cx - 2 }, "align");
        break;
      case "top":
        patch({ y: baseHalfH - halfH - cy - 2 }, "align");
        break;
      case "bottom":
        patch({ y: -baseHalfH + halfH - cy + 2 }, "align");
        break;
    }
  };

  const fitToBase = (): void => {
    if (!bounds) return;
    const w = bounds.max.x - bounds.min.x;
    const h = bounds.max.y - bounds.min.y;
    if (w <= 0 || h <= 0) return;
    const margin = 4;
    const factor = Math.min(
      (base.widthMm - margin * 2) / w,
      ((base.shape === "circle" ? base.widthMm : base.heightMm) - margin * 2) / h
    );
    const scaleX = clampScale(t.scaleX * factor);
    const scaleY = clampScale(t.scaleY * factor);
    updateLayer(layer.id, {
      transform: { ...t, scaleX, scaleY, x: 0, y: 0 },
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <NumberField label="X" value={round2(t.x)} min={-200} max={200} step={snap ? snapStep : 0.5} onChange={(x) => patch({ x }, "x")} />
        <NumberField label="Y" value={round2(t.y)} min={-200} max={200} step={snap ? snapStep : 0.5} onChange={(y) => patch({ y }, "y")} />
        <NumberField label="Z" value={round2(t.z)} min={-100} max={100} step={0.1} onChange={(z) => patch({ z }, "z")} />
        <NumberField label="סיבוב Z" value={round2(t.rotationZ)} min={-360} max={360} unit="°" onChange={(rotationZ) => patch({ rotationZ }, "rz")} />
        <NumberField
          label="קנה מידה X"
          value={round2(t.scaleX)}
          min={0.05}
          max={20}
          step={0.05}
          unit="×"
          onChange={(scaleX) => patch({ scaleX }, "sx")}
        />
        <NumberField
          label="קנה מידה Y"
          value={round2(t.scaleY)}
          min={0.05}
          max={20}
          step={0.05}
          unit="×"
          onChange={(scaleY) => patch({ scaleY }, "sy")}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <ToolButton onClick={() => align("centerX")} disabled={!bounds} label="מרכוז אופקי">↔ מרכז</ToolButton>
        <ToolButton onClick={() => align("centerY")} disabled={!bounds} label="מרכוז אנכי">↕ מרכז</ToolButton>
        <ToolButton onClick={() => align("right")} disabled={!bounds} label="יישור לימין">⇥ ימין</ToolButton>
        <ToolButton onClick={() => align("left")} disabled={!bounds} label="יישור לשמאל">⇤ שמאל</ToolButton>
        <ToolButton onClick={() => align("top")} disabled={!bounds} label="יישור למעלה">⤒ עליון</ToolButton>
        <ToolButton onClick={() => align("bottom")} disabled={!bounds} label="יישור למטה">⤓ תחתון</ToolButton>
        <ToolButton onClick={fitToBase} disabled={!bounds} label="התאמה לבסיס">⛶ התאמה לבסיס</ToolButton>
        <ToolButton
          onClick={() => updateLayer(layer.id, { transform: { ...IDENTITY_TRANSFORM } })}
          label="איפוס טרנספורמציה"
        >
          ↺ איפוס
        </ToolButton>
      </div>

      <div className="flex items-center gap-3 text-xs text-slate-600">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            className="size-3.5 accent-blue-600"
            checked={snap}
            onChange={(e) => setSnap(e.target.checked)}
          />
          הצמדה לרשת
        </label>
        {snap && (
          <label className="flex items-center gap-1">
            כל
            <select
              className="rounded border border-slate-300 px-1 py-0.5"
              value={snapStep}
              onChange={(e) => setSnapStep(Number(e.target.value))}
            >
              <option value={0.5}>0.5</option>
              <option value={1}>1</option>
              <option value={2.5}>2.5</option>
              <option value={5}>5</option>
            </select>
            מ״מ
          </label>
        )}
      </div>
    </div>
  );
}

function ToolButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function clampScale(v: number): number {
  return Math.min(20, Math.max(0.05, Math.round(v * 100) / 100));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
