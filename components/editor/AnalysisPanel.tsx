"use client";

/**
 * "בדיקת הדפסה" (print check) — profile selection, custom thresholds and
 * the merged issue list; plus "ניתוח חזותי" (visual analysis) — heatmap
 * overlays, orientation suggestions and print estimates.
 * Severity is always shown with an icon AND text, never color alone.
 */

import type { DesignDocument, ModelIssue } from "@/types/design";
import {
  MATERIAL_PROFILES,
  PRINTABILITY_PROFILES,
  PRINTER_PROFILES,
  USAGE_PROFILES,
  getPrintabilityProfile,
} from "@/types/profiles";
import { formatMinutesHe, type DetailedEstimateResult } from "@/lib/geometry/analysis/estimateDetailed";
import type { ValidationIssue } from "@/lib/geometry/types";
import { NumberField } from "@/components/ui/NumberField";
import type { OverlayMode } from "./store";

export interface AnalysisPanelProps {
  document: DesignDocument;
  paramIssues: ValidationIssue[];
  modelIssues: ModelIssue[];
  overlay: OverlayMode;
  analysisBusy: boolean;
  estimate: DetailedEstimateResult | null;
  onSetOverlay: (overlay: OverlayMode) => void;
  onRunAnalysis: () => void;
  onSuggestOrientation: () => void;
  onUpdateDocument: (patch: Partial<DesignDocument>, labelHe: string) => void;
  onApplyUsageProfile: (profileId: string) => void;
}

const SEVERITY_BADGE: Record<
  "ok" | "warning" | "critical" | "error",
  { icon: string; textHe: string; className: string }
> = {
  ok: { icon: "✓", textHe: "תקין", className: "bg-emerald-50 text-emerald-700" },
  warning: { icon: "⚠", textHe: "אזהרה", className: "bg-amber-50 text-amber-800" },
  critical: { icon: "✖", textHe: "בעיה שחייבים לתקן", className: "bg-red-50 text-red-700" },
  error: { icon: "✖", textHe: "בעיה שחייבים לתקן", className: "bg-red-50 text-red-700" },
};

function IssueRow({
  severity,
  titleHe,
  detailHe,
  actionHe,
}: {
  severity: "ok" | "warning" | "critical" | "error";
  titleHe: string;
  detailHe?: string;
  actionHe?: string;
}) {
  const badge = SEVERITY_BADGE[severity];
  return (
    <li className={`rounded-md p-2 text-xs ${badge.className}`}>
      <p className="font-bold">
        <span aria-hidden>{badge.icon}</span> {badge.textHe}: {titleHe}
      </p>
      {detailHe && <p className="mt-0.5 opacity-90">{detailHe}</p>}
      {actionHe && <p className="mt-0.5 font-medium">→ {actionHe}</p>}
    </li>
  );
}

export function AnalysisPanel({
  document,
  paramIssues,
  modelIssues,
  overlay,
  analysisBusy,
  estimate,
  onSetOverlay,
  onRunAnalysis,
  onSuggestOrientation,
  onUpdateDocument,
  onApplyUsageProfile,
}: AnalysisPanelProps) {
  const profile = getPrintabilityProfile(document.printabilityProfileId);
  const custom = document.customPrintability;

  return (
    <div className="flex flex-col gap-4">
      {/* Profiles */}
      <div className="flex flex-col gap-2">
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-slate-600">מדפסת</span>
          <select
            className="max-w-44 rounded-md border border-slate-300 px-2 py-1 text-sm"
            value={document.printerProfileId}
            onChange={(e) =>
              onUpdateDocument({ printerProfileId: e.target.value }, "החלפת מדפסת")
            }
          >
            {PRINTER_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nameHe}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-slate-600">פרופיל הדפסה</span>
          <select
            className="max-w-44 rounded-md border border-slate-300 px-2 py-1 text-sm"
            value={document.printabilityProfileId}
            onChange={(e) =>
              onUpdateDocument(
                { printabilityProfileId: e.target.value, customPrintability: null },
                "החלפת פרופיל הדפסה"
              )
            }
          >
            {PRINTABILITY_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nameHe}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-slate-600">פרופיל שימוש</span>
          <select
            className="max-w-44 rounded-md border border-slate-300 px-2 py-1 text-sm"
            value={document.usageProfileId ?? ""}
            onChange={(e) => e.target.value && onApplyUsageProfile(e.target.value)}
          >
            <option value="">— ללא —</option>
            {USAGE_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.icon} {p.nameHe}
              </option>
            ))}
          </select>
        </label>
        {document.usageProfileId && (
          <UsageProfileNotes profileId={document.usageProfileId} />
        )}

        <details className="rounded-md border border-slate-200 p-2">
          <summary className="cursor-pointer text-xs font-bold text-slate-600">
            ספי הדפסה מתקדמים (עריכה)
          </summary>
          <div className="flex flex-col gap-2 pt-2">
            <NumberField
              label="עובי קיר מזערי"
              value={custom?.minWallMm ?? profile.minWallMm}
              min={0.2}
              max={5}
              step={0.1}
              onChange={(v) =>
                onUpdateDocument(
                  { customPrintability: { ...custom, minWallMm: v } },
                  "סף עובי קיר"
                )
              }
            />
            <NumberField
              label="פרט מזערי"
              value={custom?.minFeatureMm ?? profile.minFeatureMm}
              min={0.1}
              max={5}
              step={0.1}
              onChange={(v) =>
                onUpdateDocument(
                  { customPrintability: { ...custom, minFeatureMm: v } },
                  "סף פרט מזערי"
                )
              }
            />
            <NumberField
              label="זווית תלייה מרבית"
              value={custom?.maxOverhangDeg ?? profile.maxOverhangDeg}
              min={20}
              max={80}
              step={5}
              unit="°"
              onChange={(v) =>
                onUpdateDocument(
                  { customPrintability: { ...custom, maxOverhangDeg: v } },
                  "סף זווית תלייה"
                )
              }
            />
            <NumberField
              label="גובה שכבה"
              value={custom?.layerHeightMm ?? profile.layerHeightMm}
              min={0.02}
              max={0.6}
              step={0.02}
              onChange={(v) =>
                onUpdateDocument(
                  { customPrintability: { ...custom, layerHeightMm: v } },
                  "גובה שכבה"
                )
              }
            />
            <NumberField
              label="קוטר פיה (Nozzle)"
              value={custom?.nozzleDiameterMm ?? profile.nozzleDiameterMm}
              min={0.1}
              max={1.2}
              step={0.1}
              onChange={(v) =>
                onUpdateDocument(
                  { customPrintability: { ...custom, nozzleDiameterMm: v } },
                  "קוטר פיה"
                )
              }
            />
            <NumberField
              label="חופש מומלץ"
              value={custom?.clearanceMm ?? profile.clearanceMm}
              min={0.05}
              max={1}
              step={0.05}
              onChange={(v) =>
                onUpdateDocument(
                  { customPrintability: { ...custom, clearanceMm: v } },
                  "חופש מומלץ"
                )
              }
            />
          </div>
        </details>
      </div>

      {/* Visual analysis */}
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">ניתוח חזותי</p>
        <div className="flex flex-wrap gap-1">
          {(
            [
              ["none", "ללא"],
              ["thickness", "מפת עובי דפנות"],
              ["overhang", "משטחים תלויים"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={overlay === value}
              className={`rounded-md border px-2 py-1 text-xs ${
                overlay === value
                  ? "border-blue-500 bg-blue-600 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
              }`}
              onClick={() => onSetOverlay(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {overlay === "thickness" && (
          <p className="mt-1 text-[11px] text-slate-500">
            ירוק = בטוח · צהוב = גבולי · אדום = דק מדי · אפור = לא נדגם
          </p>
        )}
        {overlay === "overhang" && (
          <p className="mt-1 text-[11px] text-slate-500">
            אדום = משטח תלוי שכנראה יזדקק לתמיכה. הערכה בלבד — לא פלט סלייסר.
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          <button
            type="button"
            disabled={analysisBusy}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            onClick={onRunAnalysis}
          >
            {analysisBusy ? "מנתח…" : "הרץ ניתוח מלא"}
          </button>
          <button
            type="button"
            disabled={analysisBusy}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            onClick={onSuggestOrientation}
          >
            הצע תנוחת הדפסה
          </button>
        </div>
      </div>

      {/* Estimates */}
      {estimate && (
        <div className="rounded-md border border-slate-200 p-2 text-xs text-slate-600">
          <p className="mb-1 font-bold text-slate-500">
            הערכת חומר, זמן ועלות (הערכה בלבד — יש לאמת בסלייסר)
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <dt className="text-slate-500">חומר (כולל פחת)</dt>
            <dd className="text-end">
              {estimate.materialVolumeCm3} סמ״ק · {estimate.materialWeightGrams} גרם
            </dd>
            <dt className="text-slate-500">זמן הדפסה (טווח)</dt>
            <dd className="text-end">
              {formatMinutesHe(estimate.time.totalMinutesMin)} – {formatMinutesHe(estimate.time.totalMinutesMax)}
            </dd>
            <dt className="text-slate-500">שכבות</dt>
            <dd className="text-end">{estimate.time.layerCount.toLocaleString()}</dd>
            <dt className="text-slate-500">עלות חומר</dt>
            <dd className="text-end">{estimate.materialCostIls} ₪</dd>
            <dt className="text-slate-500">חשמל + בלאי מכונה</dt>
            <dd className="text-end">
              {(estimate.electricityCostIls + estimate.machineCostIls).toFixed(2)} ₪
            </dd>
            <dt className="text-slate-500">סה״כ עלות משוערת</dt>
            <dd className="text-end font-bold">{estimate.totalCostIls} ₪</dd>
          </dl>
          <p className="mt-1 text-[11px] text-slate-400">
            רמת ביטחון: {estimate.time.confidence === "high" ? "גבוהה" : estimate.time.confidence === "medium" ? "בינונית" : "נמוכה"}
          </p>
        </div>
      )}

      {/* Issues */}
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">ממצאים</p>
        {paramIssues.length === 0 && modelIssues.length === 0 ? (
          <p className="text-xs text-emerald-600">✓ לא נמצאו בעיות</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {paramIssues.map((issue, i) => (
              <IssueRow
                key={`p${i}`}
                severity={issue.severity === "error" ? "critical" : "warning"}
                titleHe={issue.message}
              />
            ))}
            {modelIssues.map((issue, i) => (
              <IssueRow
                key={`m${i}`}
                severity={issue.severity}
                titleHe={issue.titleHe}
                detailHe={issue.detailHe}
                actionHe={issue.actionHe}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function UsageProfileNotes({ profileId }: { profileId: string }) {
  const profile = USAGE_PROFILES.find((p) => p.id === profileId);
  if (!profile) return null;
  const material = MATERIAL_PROFILES.find((m) => m.id === profile.suggestedMaterialId);
  return (
    <div className="rounded-md bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600">
      <p>
        <b>{profile.nameHe}</b>: חומר מוצע {material?.nameHe}, קיר{" "}
        {profile.suggestedWallMm} מ״מ, מילוי {profile.suggestedInfillPct}%.
      </p>
      <p className="mt-0.5">{profile.orientationNotesHe}</p>
      {profile.warningsHe.map((w, i) => (
        <p key={i} className="mt-0.5 text-amber-700">
          ⚠ {w}
        </p>
      ))}
    </div>
  );
}
