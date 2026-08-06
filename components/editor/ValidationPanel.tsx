"use client";

import type { MeshStats, ValidationIssue } from "@/lib/geometry/types";
import type { BuildStatus } from "@/hooks/useModelBuilder";

interface ValidationPanelProps {
  status: BuildStatus;
  stats: MeshStats | null;
  issues: ValidationIssue[];
}

/** Shows build status, model dimensions, triangle count and issues. */
export function ValidationPanel({ status, stats, issues }: ValidationPanelProps) {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  return (
    <div className="flex flex-col gap-2 text-sm">
      <StatusRow status={status} />

      {stats && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-slate-50 p-3 text-xs">
          <dt className="text-slate-500">מידות (X × Y × Z)</dt>
          <dd className="text-end font-mono" dir="ltr">
            {stats.dimensionsMm.x} × {stats.dimensionsMm.y} ×{" "}
            {stats.dimensionsMm.z} מ״מ
          </dd>
          <dt className="text-slate-500">מספר משולשים (בקירוב)</dt>
          <dd className="text-end font-mono" dir="ltr">
            {stats.triangleCount.toLocaleString()}
          </dd>
          <dt className="text-slate-500">מודל אטום (Watertight)</dt>
          <dd className="text-end">
            {stats.watertight ? "✅ כן" : `❌ לא (${stats.openEdgeCount} קשתות פתוחות)`}
          </dd>
        </dl>
      )}

      {errors.length > 0 && (
        <ul className="flex flex-col gap-1">
          {errors.map((issue) => (
            <li
              key={issue.code}
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
            >
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      {warnings.length > 0 && (
        <ul className="flex flex-col gap-1">
          {warnings.map((issue) => (
            <li
              key={issue.code}
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"
            >
              ⚠️ {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusRow({ status }: { status: BuildStatus }) {
  switch (status) {
    case "building":
      return (
        <p className="flex items-center gap-2 text-slate-500">
          <span className="inline-block size-3 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
          בונה מודל…
        </p>
      );
    case "ok":
      return <p className="font-medium text-green-700">✅ המודל נוצר בהצלחה ומוכן להורדה</p>;
    case "invalid":
      return <p className="font-medium text-red-700">יש לתקן את השגיאות כדי ליצור מודל</p>;
    case "error":
      return <p className="font-medium text-red-700">יצירת המודל נכשלה</p>;
    default:
      return null;
  }
}
