"use client";

/**
 * Progress overlay for long geometry jobs.
 *
 * The editor previously showed a busy label and nothing else: a Minkowski
 * fillet on a dense mesh could sit there for thirty seconds with no way to
 * tell whether it was working or wedged, and no way out. This shows the
 * stage, the fraction where the job reports one, and a cancel button that
 * actually aborts the work.
 *
 * It also states plainly when a job is running on the main thread, because
 * that is the case where the tab really will stop responding and the user
 * deserves to know why rather than assuming the app crashed.
 */

import type { JobProgress } from "@/hooks/useGeometryJobs";

export function JobProgressOverlay({
  progress,
  onCancel,
}: {
  progress: JobProgress | null;
  onCancel: () => void;
}) {
  if (!progress) return null;
  const percent =
    progress.fraction === null ? null : Math.round(Math.max(0, Math.min(progress.fraction, 1)) * 100);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-slate-900/20"
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-auto w-72 rounded-lg border border-slate-300 bg-white p-4 shadow-lg">
        <p className="text-sm font-bold text-slate-700">{progress.labelHe}</p>
        <p className="mt-0.5 text-xs text-slate-500">{progress.stageHe}</p>

        <div
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          aria-label={progress.labelHe}
        >
          <div
            className={`h-full bg-blue-600 transition-[width] ${
              percent === null ? "w-1/3 animate-pulse" : ""
            }`}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>

        {!progress.offThread && (
          <p className="mt-2 rounded bg-amber-50 p-1.5 text-[11px] leading-snug text-amber-800">
            הדפדפן הזה אינו תומך בחישוב ברקע — החלון עשוי להיתקע עד סיום
            הפעולה. זו התנהגות צפויה, לא תקלה.
          </p>
        )}

        <button
          type="button"
          className="mt-3 w-full rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          onClick={onCancel}
        >
          בטל
        </button>
      </div>
    </div>
  );
}
