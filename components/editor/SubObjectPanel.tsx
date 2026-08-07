"use client";

/**
 * Sub-object editing panel.
 *
 * The engine for face selection and direct editing existed and was tested,
 * but nothing exposed it — this is the control surface. It stays deliberately
 * small: pick a growth mode, click a face, then act on it.
 *
 * Every action states its precondition rather than silently doing nothing.
 * Push/pull in particular only works on a flat face, and saying so up front
 * is better than an error after the click.
 */

import type { FaceGrowMode } from "./store";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";

export interface RegionInfo {
  triangleCount: number;
  areaMm2: number;
  planar: boolean;
}

export interface SubObjectPanelProps {
  active: boolean;
  growMode: FaceGrowMode;
  growAngleDeg: number;
  /** Null when nothing is selected. */
  region: RegionInfo | null;
  busy: boolean;
  pushPullMm: number;
  onToggleActive: () => void;
  onSetGrowMode: (mode: FaceGrowMode) => void;
  onSetGrowAngle: (degrees: number) => void;
  onSetPushPull: (mm: number) => void;
  onPushPull: () => void;
  onSmooth: () => void;
  onDelete: () => void;
  onSplit: () => void;
  onSelectAll: () => void;
  onClear: () => void;
}

function ActionButton({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title ?? label}
      onClick={onClick}
      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-35"
    >
      {label}
    </button>
  );
}

export function SubObjectPanel(props: SubObjectPanelProps) {
  const { active, region, busy } = props;
  const hasRegion = region !== null && region.triangleCount > 0;

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-pressed={active}
        onClick={props.onToggleActive}
        className={`rounded-md border px-2 py-1.5 text-xs transition-colors ${
          active
            ? "border-blue-500 bg-blue-600 text-white"
            : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
        }`}
      >
        {active ? "מצב בחירת פאות פעיל — לחצו לסיום" : "הפעל בחירת פאות"}
      </button>

      {active && (
        <>
          <ToggleGroup
            label="אופן הבחירה"
            value={props.growMode}
            options={[
              { value: "coplanar", label: "פאה שלמה" },
              { value: "triangle", label: "משולש בודד" },
              { value: "similarNormal", label: "כיוון דומה" },
              { value: "connected", label: "כל הגוף" },
            ]}
            onChange={(mode) => props.onSetGrowMode(mode as FaceGrowMode)}
          />
          {(props.growMode === "coplanar" || props.growMode === "similarNormal") && (
            <NumberField
              label="סבילות זווית"
              value={props.growAngleDeg}
              min={0.5}
              max={90}
              step={0.5}
              unit="°"
              onChange={props.onSetGrowAngle}
            />
          )}

          <div className="rounded-md bg-slate-50 p-2 text-[11px] text-slate-600">
            {hasRegion ? (
              <>
                נבחרו {region.triangleCount} משולשים · שטח{" "}
                {region.areaMm2.toFixed(1)} ממ״ר ·{" "}
                <span className={region.planar ? "text-emerald-700" : "text-amber-700"}>
                  {region.planar ? "מישורית" : "לא מישורית"}
                </span>
              </>
            ) : (
              "לחצו על פאה בתצוגה כדי לבחור אותה. Ctrl/Shift מוסיף לבחירה."
            )}
          </div>

          <div className="flex flex-wrap gap-1">
            <ActionButton
              label="בחר הכל"
              disabled={busy}
              onClick={props.onSelectAll}
            />
            <ActionButton
              label="נקה בחירה"
              disabled={!hasRegion || busy}
              onClick={props.onClear}
            />
          </div>

          <div>
            <p className="mb-1.5 text-xs font-bold text-slate-500">הזזת פאה (Push/Pull)</p>
            <NumberField
              label="מרחק"
              value={props.pushPullMm}
              min={-500}
              max={500}
              step={0.5}
              unit="מ״מ"
              onChange={props.onSetPushPull}
            />
            <ActionButton
              label="הזז פאה"
              title={
                region && !region.planar
                  ? "הפאה אינה מישורית — הרחיבו את הבחירה במצב ״פאה שלמה״"
                  : "חיובי מוסיף חומר, שלילי מחסיר"
              }
              disabled={!hasRegion || !region?.planar || busy || props.pushPullMm === 0}
              onClick={props.onPushPull}
            />
            {region && !region.planar && (
              <p className="mt-1 text-[11px] leading-snug text-amber-700">
                הזזת פאה דורשת פאה שטוחה. למשטח מעוקל השתמשו ב״עיבוי״ או
                ב״עיוות״.
              </p>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-xs font-bold text-slate-500">פעולות על הבחירה</p>
            <div className="flex flex-wrap gap-1">
              <ActionButton
                label="החלקה מקומית"
                title="מחליק רק את האזור הנבחר; קודקודי הגבול ננעלים"
                disabled={!hasRegion || busy}
                onClick={props.onSmooth}
              />
              <ActionButton
                label="מחק אזור"
                title="מוחק את הפאות ואוטם את החור שנוצר"
                disabled={!hasRegion || busy}
                onClick={props.onDelete}
              />
              <ActionButton
                label="הפרד לשכבה"
                title="מפריד את האזור הנבחר לגוף סגור נפרד"
                disabled={!hasRegion || busy}
                onClick={props.onSplit}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
