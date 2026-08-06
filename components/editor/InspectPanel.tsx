"use client";

/**
 * Inspection tools: measurement, clipping section (preview-only), X-ray
 * transparency, approximate print preview, and precise scale-to-size
 * controls for the selected object.
 */

import { useState } from "react";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import type { EditorTool, PrintPreviewState, SectionPlaneState } from "./store";

export interface InspectPanelProps {
  tool: EditorTool;
  section: SectionPlaneState;
  xray: boolean;
  printPreview: PrintPreviewState;
  measurementCount: number;
  /** World dims of the selected part (null when none). */
  selectedDims: { x: number; y: number; z: number } | null;
  busy: boolean;
  onSetTool: (tool: EditorTool) => void;
  onSetSection: (patch: Partial<SectionPlaneState>) => void;
  onSetXray: (xray: boolean) => void;
  onSetPrintPreview: (patch: Partial<PrintPreviewState>) => void;
  onClearMeasurements: () => void;
  onScaleTo: (axis: "x" | "y" | "z" | "longest", targetMm: number, uniform: boolean) => void;
  onFitBuildVolume: () => void;
}

export function InspectPanel(props: InspectPanelProps) {
  const { tool, section, xray, printPreview, measurementCount, selectedDims, busy } = props;
  const [scaleAxis, setScaleAxis] = useState<"x" | "y" | "z" | "longest">("x");
  const [scaleTarget, setScaleTarget] = useState(100);
  const [uniform, setUniform] = useState(true);

  return (
    <div className="flex flex-col gap-4">
      {/* Measurement */}
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">מדידה</p>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            aria-pressed={tool === "measure"}
            className={`rounded-md border px-2 py-1 text-xs ${
              tool === "measure"
                ? "border-amber-500 bg-amber-500 text-white"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            }`}
            onClick={() => props.onSetTool(tool === "measure" ? "select" : "measure")}
          >
            מדידה (שתי נקודות)
          </button>
          {measurementCount > 0 && (
            <button
              type="button"
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
              onClick={props.onClearMeasurements}
            >
              נקה מדידות ({measurementCount})
            </button>
          )}
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          מדידות הן חזותיות בלבד ואינן מיוצאות למודל. לחיצה על התווית מסירה מדידה.
        </p>
      </div>

      {/* Section view */}
      <div>
        <label className="flex items-center justify-between text-sm">
          <span className="text-xs font-bold text-slate-500">מבט חתך (תצוגה בלבד)</span>
          <input
            type="checkbox"
            checked={section.enabled}
            onChange={(e) => props.onSetSection({ enabled: e.target.checked })}
            aria-label="הפעלת מבט חתך"
          />
        </label>
        {section.enabled && (
          <div className="mt-2 flex flex-col gap-2">
            <ToggleGroup
              label="ציר"
              value={section.axis}
              options={[
                { value: "x", label: "X" },
                { value: "y", label: "Y" },
                { value: "z", label: "Z" },
              ]}
              onChange={(axis) => props.onSetSection({ axis })}
            />
            <NumberField
              label="מיקום"
              value={section.offsetMm}
              min={-300}
              max={300}
              step={1}
              onChange={(offsetMm) => props.onSetSection({ offsetMm })}
            />
            <label className="flex items-center justify-between text-sm">
              <span className="text-slate-600">היפוך כיוון</span>
              <input
                type="checkbox"
                checked={section.flip}
                onChange={(e) => props.onSetSection({ flip: e.target.checked })}
              />
            </label>
            <p className="text-[11px] text-slate-400">
              החתך אינו משנה את הגיאומטריה המיוצאת — לחיתוך אמיתי השתמשו ב״חיתוך
              מישור״.
            </p>
          </div>
        )}
      </div>

      {/* X-ray */}
      <label className="flex items-center justify-between text-sm">
        <span className="text-xs font-bold text-slate-500">מצב שקוף (X-Ray, תצוגה בלבד)</span>
        <input
          type="checkbox"
          checked={xray}
          onChange={(e) => props.onSetXray(e.target.checked)}
          aria-label="מצב שקוף"
        />
      </label>

      {/* Print preview */}
      <div>
        <label className="flex items-center justify-between text-sm">
          <span className="text-xs font-bold text-slate-500">תצוגת הדפסה מקדימה</span>
          <input
            type="checkbox"
            checked={printPreview.enabled}
            onChange={(e) => props.onSetPrintPreview({ enabled: e.target.checked })}
            aria-label="תצוגת הדפסה מקדימה"
          />
        </label>
        {printPreview.enabled && (
          <div className="mt-2 flex flex-col gap-2">
            <NumberField
              label="גובה שכבה"
              value={printPreview.layerHeightMm}
              min={0.05}
              max={0.6}
              step={0.05}
              onChange={(layerHeightMm) => props.onSetPrintPreview({ layerHeightMm })}
            />
            <p className="text-[11px] text-amber-700">
              תצוגה מקדימה בלבד — יש לאמת בסלייסר לפני הדפסה.
            </p>
          </div>
        )}
      </div>

      {/* Scale to size */}
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">קנה מידה מדויק</p>
        {selectedDims ? (
          <>
            <p className="mb-1 font-mono text-[11px] text-slate-500" dir="ltr">
              {selectedDims.x.toFixed(1)} × {selectedDims.y.toFixed(1)} ×{" "}
              {selectedDims.z.toFixed(1)} mm
            </p>
            <ToggleGroup
              label="מידה"
              value={scaleAxis}
              options={[
                { value: "x", label: "רוחב" },
                { value: "y", label: "עומק" },
                { value: "z", label: "גובה" },
                { value: "longest", label: "צלע ארוכה" },
              ]}
              onChange={setScaleAxis}
            />
            <div className="mt-2 flex flex-col gap-2">
              <NumberField label="גודל יעד" value={scaleTarget} min={0.5} max={1000} onChange={setScaleTarget} />
              <label className="flex items-center justify-between text-sm">
                <span className="text-slate-600">קנה מידה אחיד</span>
                <input
                  type="checkbox"
                  checked={uniform}
                  onChange={(e) => setUniform(e.target.checked)}
                />
              </label>
              <div className="flex gap-1">
                <button
                  type="button"
                  disabled={busy}
                  className="flex-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                  onClick={() => props.onScaleTo(scaleAxis, scaleTarget, uniform)}
                >
                  שנה גודל
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                  onClick={props.onFitBuildVolume}
                >
                  התאם לנפח המדפסת
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-400">בחרו אובייקט כדי לשנות את גודלו.</p>
        )}
      </div>
    </div>
  );
}
