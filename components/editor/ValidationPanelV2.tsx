"use client";

/**
 * "בדיקת הדפסה" — printability validation: overall status, mesh report,
 * per-issue Hebrew explanations with recommendations and expandable
 * technical details, printability profile selection with editable limits,
 * and the automatic-repair flow (explains → confirms → applies parameter
 * fixes as one undoable step → reports before/after).
 */

import { useMemo, useState } from "react";
import type { DesignIssue, PrintabilityLimitsV2 } from "@/types/design";
import { selectLayer, updateState, useEditorStore } from "@/lib/design/store";
import {
  effectiveLimits,
  getPrintabilityProfile,
  PRINTABILITY_PROFILES,
} from "@/lib/design/defaults";
import { applyAutoFixes, computeAutoFixes } from "@/lib/geometry/autofix";
import type { DesignBuilderState } from "@/hooks/useDesignBuilder";
import { Modal, PrimaryButton, SecondaryButton } from "@/components/ui/Modal";
import { NumberField } from "@/components/ui/NumberField";

interface ValidationPanelV2Props {
  builder: DesignBuilderState;
}

export function ValidationPanelV2({ builder }: ValidationPanelV2Props) {
  const { state } = useEditorStore();
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairReport, setRepairReport] = useState<string | null>(null);

  const result = builder.result;
  const issues = useMemo(() => result?.issues ?? [], [result]);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const mesh = result?.mesh ?? null;

  const status: "ok" | "warning" | "error" =
    errors.length > 0 || builder.status === "error" || builder.status === "invalid"
      ? "error"
      : warnings.length > 0
        ? "warning"
        : "ok";

  const fixes = useMemo(() => computeAutoFixes(state, issues), [state, issues]);

  const limits = effectiveLimits(state.settings);
  const profile = getPrintabilityProfile(state.settings.printabilityProfileId);

  const setProfile = (id: typeof state.settings.printabilityProfileId): void => {
    updateState((s) => ({
      ...s,
      settings: { ...s.settings, printabilityProfileId: id, printabilityOverrides: {} },
    }));
  };

  const overrideLimit = (key: keyof PrintabilityLimitsV2, value: number): void => {
    updateState(
      (s) => ({
        ...s,
        settings: {
          ...s.settings,
          printabilityOverrides: { ...s.settings.printabilityOverrides, [key]: value },
        },
      }),
      { coalesceKey: `limit:${key}` }
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <StatusBadge status={status} building={builder.status === "building"} />

      {mesh && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-slate-50 p-3 text-xs">
          <dt className="text-slate-500">מידות (X × Y × Z)</dt>
          <dd className="text-end font-mono" dir="ltr">
            {mesh.dimensionsMm.x} × {mesh.dimensionsMm.y} × {mesh.dimensionsMm.z} mm
          </dd>
          <dt className="text-slate-500">נפח משוער</dt>
          <dd className="text-end font-mono" dir="ltr">
            {mesh.volumeCm3.toFixed(1)} cm³
          </dd>
          <dt className="text-slate-500">משולשים</dt>
          <dd className="text-end font-mono" dir="ltr">
            {mesh.triangleCount.toLocaleString()}
          </dd>
          <dt className="text-slate-500">חלקים / רכיבים</dt>
          <dd className="text-end font-mono" dir="ltr">
            {mesh.partCount} / {mesh.connectedComponents}
          </dd>
          <dt className="text-slate-500">מודל אטום (Watertight)</dt>
          <dd className="text-end">{mesh.watertight ? "✅ כן" : "❌ לא"}</dd>
          <dt className="text-slate-500">קשתות פתוחות / לא-מנופלד</dt>
          <dd className="text-end font-mono" dir="ltr">
            {mesh.openEdgeCount} / {mesh.nonManifoldEdgeCount}
          </dd>
        </dl>
      )}

      {issues.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {issues.map((issue, i) => (
            <IssueRow key={`${issue.code}_${issue.layerId ?? i}`} issue={issue} />
          ))}
        </ul>
      )}

      {fixes.length > 0 && (
        <button
          type="button"
          className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100"
          onClick={() => setRepairOpen(true)}
        >
          🔧 נסה לתקן אוטומטית ({fixes.length} תיקונים זמינים)
        </button>
      )}
      {repairReport && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{repairReport}</p>
      )}

      <details className="rounded-md border border-slate-200">
        <summary className="cursor-pointer px-3 py-2 text-sm font-bold text-slate-700">
          פרופיל הדפסה וספי בדיקה
        </summary>
        <div className="flex flex-col gap-2 px-3 pb-3">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="text-slate-600">פרופיל</span>
            <select
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
              value={profile.id}
              onChange={(e) => setProfile(e.target.value as typeof profile.id)}
            >
              {PRINTABILITY_PROFILES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nameHe}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="עובי דופן מינימלי" value={limits.minWallMm} min={0.1} max={5} step={0.1} onChange={(v) => overrideLimit("minWallMm", v)} />
          <NumberField label="גובה הבלטה מינימלי" value={limits.minEmbossHeightMm} min={0.1} max={5} step={0.1} onChange={(v) => overrideLimit("minEmbossHeightMm", v)} />
          <NumberField label="עומק חריטה מינימלי" value={limits.minEngraveDepthMm} min={0.1} max={5} step={0.1} onChange={(v) => overrideLimit("minEngraveDepthMm", v)} />
          <NumberField label="קוטר חור מינימלי" value={limits.minHoleDiameterMm} min={0.1} max={10} step={0.1} onChange={(v) => overrideLimit("minHoleDiameterMm", v)} />
          <NumberField label="מרווח מומלץ" value={limits.recommendedClearanceMm} min={0} max={2} step={0.05} onChange={(v) => overrideLimit("recommendedClearanceMm", v)} />
          <NumberField label="גודל טקסט מינימלי" value={limits.minTextSizeMm} min={1} max={20} step={0.5} onChange={(v) => overrideLimit("minTextSizeMm", v)} />
        </div>
      </details>

      <Modal
        title="תיקון אוטומטי"
        open={repairOpen}
        onClose={() => setRepairOpen(false)}
        footer={
          <>
            <SecondaryButton onClick={() => setRepairOpen(false)}>ביטול</SecondaryButton>
            <PrimaryButton
              onClick={() => {
                const before = issues.length;
                updateState((s) => applyAutoFixes(s, fixes));
                setRepairOpen(false);
                setRepairReport(
                  `הוחלו ${fixes.length} תיקונים (לפני: ${before} ממצאים). הבדיקה תרוץ מחדש אוטומטית; אפשר לבטל עם Ctrl+Z.`
                );
              }}
            >
              החלת התיקונים
            </PrimaryButton>
          </>
        }
      >
        <div className="flex flex-col gap-2 text-sm text-slate-700">
          <p>התיקונים הבאים יוחלו על העיצוב (צעד אחד שניתן לביטול ב-Ctrl+Z):</p>
          <ul className="list-inside list-disc space-y-1">
            {fixes.map((fix, i) => (
              <li key={i}>{fix.descriptionHe}</li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">
            שום שינוי לא נעשה בלי אישור, והעיצוב לעולם אינו משתנה באופן הרסני —
            כל תיקון הוא שינוי פרמטרים גלוי והפיך.
          </p>
        </div>
      </Modal>
    </div>
  );
}

function StatusBadge({ status, building }: { status: "ok" | "warning" | "error"; building: boolean }) {
  if (building) {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <span className="inline-block size-3 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
        בונה ובודק מודל…
      </p>
    );
  }
  switch (status) {
    case "ok":
      return (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-700">
          ✅ תקין — לא נמצאו בעיות הדפסה
        </p>
      );
    case "warning":
      return (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm font-bold text-amber-700">
          ⚠️ אזהרה — מומלץ לבדוק את הממצאים לפני הדפסה
        </p>
      );
    case "error":
      return (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm font-bold text-red-700">
          ⛔ בעיה שחייבים לתקן — לא ניתן לייצא עד לתיקון
        </p>
      );
  }
}

function IssueRow({ issue }: { issue: DesignIssue }) {
  const isError = issue.severity === "error";
  return (
    <li
      className={`rounded-md border px-3 py-2 text-xs ${
        isError ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800"
      }`}
    >
      <div className="flex items-start gap-1.5">
        <span aria-hidden>{isError ? "⛔" : "⚠️"}</span>
        <div className="min-w-0 flex-1">
          <p>{issue.message}</p>
          {issue.recommendation && (
            <p className="mt-0.5 text-[11px] opacity-80">💡 {issue.recommendation}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {issue.layerId && (
              <button
                type="button"
                className="rounded border border-current px-1.5 py-0.5 text-[10px] hover:opacity-70"
                onClick={() => selectLayer(issue.layerId ?? null)}
              >
                בחירת השכבה
              </button>
            )}
            {issue.details && (
              <details className="text-[10px]">
                <summary className="cursor-pointer">פרטים טכניים</summary>
                <code dir="ltr" className="block whitespace-pre-wrap pt-1 opacity-80">
                  {issue.details} ({issue.code})
                </code>
              </details>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
