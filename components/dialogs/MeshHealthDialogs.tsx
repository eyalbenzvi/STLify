"use client";

/**
 * The two dialogs that report what is WRONG with the geometry: the mesh
 * inspector, which turns a topology diagnosis into a repair the user can
 * choose the stages of, and the interference report, which lists bodies
 * that overlap on the plate.
 *
 * Both are navigable: every finding carries a world-space location, and
 * clicking it points the camera at the problem rather than leaving the
 * user to hunt for it.
 */

import { useState } from "react";
import { Modal, ModalButton } from "@/components/ui/Modal";
import { NumberField } from "@/components/ui/NumberField";
import type { ModelIssue } from "@/types/design";
import type {
  MeshDiagnosis,
  MeshRepairReport,
  RepairOptions,
} from "@/lib/geometry/repair/diagnose";
import type { InterferenceReport } from "@/lib/geometry/analysis/collision";

// ---------------------------------------------------------------------------
// Mesh inspector
// ---------------------------------------------------------------------------

const SEVERITY_STYLES: Record<ModelIssue["severity"], string> = {
  critical: "border-red-300 bg-red-50 text-red-800",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  ok: "border-emerald-300 bg-emerald-50 text-emerald-800",
};

export function MeshInspectorDialog({
  open,
  diagnosis,
  report,
  busy,
  onClose,
  onNavigate,
  onRepair,
}: {
  open: boolean;
  diagnosis: MeshDiagnosis | null;
  report: MeshRepairReport | null;
  busy: boolean;
  onClose: () => void;
  onNavigate: (location: { x: number; y: number; z: number }) => void;
  onRepair: (options: RepairOptions) => void;
}) {
  const [fillHoles, setFillHoles] = useState(true);
  const [removeShells, setRemoveShells] = useState(true);
  const [allowVoxelRemesh, setAllowVoxel] = useState(true);
  const [voxelSizeMm, setVoxelSize] = useState(0.3);

  return (
    <Modal
      title="בדיקת רשת ותיקון"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>סגור</ModalButton>
          <ModalButton
            variant="primary"
            disabled={busy}
            onClick={() =>
              onRepair({ fillHoles, removeShells, allowVoxelRemesh, voxelSizeMm })
            }
          >
            {busy ? "מתקן…" : "תקן"}
          </ModalButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {diagnosis && (
          <>
            <div className="grid grid-cols-2 gap-1 rounded-md bg-slate-50 p-2 text-[11px] text-slate-600">
              <span>משולשים: {diagnosis.topology.triangleCount.toLocaleString("he-IL")}</span>
              <span>גופים: {diagnosis.topology.componentCount}</span>
              <span>קצוות פתוחים: {diagnosis.topology.boundaryEdgeCount}</span>
              <span>חיתוכים עצמיים: {diagnosis.selfIntersectionCount}</span>
              <span className="col-span-2">
                מצב הליבה: {diagnosis.kernelAccepts ? "תקין" : diagnosis.kernelStatus}
              </span>
            </div>

            {diagnosis.issues.length === 0 ? (
              <p className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-800">
                לא נמצאו תקלות ברשת.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {diagnosis.issues.map((issue) => (
                  <li
                    key={issue.code}
                    className={`rounded-md border p-2 text-xs ${SEVERITY_STYLES[issue.severity]}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <b>{issue.titleHe}</b>
                      {issue.location && (
                        <button
                          type="button"
                          className="shrink-0 rounded border border-current px-1.5 py-0.5 text-[10px]"
                          onClick={() => onNavigate(issue.location as { x: number; y: number; z: number })}
                        >
                          הצג
                        </button>
                      )}
                    </div>
                    <p className="mt-0.5 leading-snug">{issue.detailHe}</p>
                    {issue.actionHe && (
                      <p className="mt-1 font-medium leading-snug">← {issue.actionHe}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="flex flex-col gap-1.5 border-t border-slate-200 pt-2">
          <p className="text-xs font-bold text-slate-500">שלבי התיקון המותרים</p>
          <label className="flex items-center justify-between text-sm">
            <span className="text-slate-600">סגירת חורים (מוסיף גאומטריה)</span>
            <input type="checkbox" checked={fillHoles} onChange={(e) => setFillHoles(e.target.checked)} />
          </label>
          <label className="flex items-center justify-between text-sm">
            <span className="text-slate-600">הסרת שאריות וקליפות כלואות</span>
            <input type="checkbox" checked={removeShells} onChange={(e) => setRemoveShells(e.target.checked)} />
          </label>
          <label className="flex items-center justify-between text-sm">
            <span className="text-slate-600">בנייה מחדש (Voxel) כמוצא אחרון</span>
            <input type="checkbox" checked={allowVoxelRemesh} onChange={(e) => setAllowVoxel(e.target.checked)} />
          </label>
          {allowVoxelRemesh && (
            <NumberField
              label="רזולוציית הבנייה מחדש"
              value={voxelSizeMm}
              min={0.05}
              max={5}
              step={0.05}
              unit="מ״מ"
              onChange={setVoxelSize}
            />
          )}
          <p className="text-[11px] leading-snug text-slate-400">
            התיקון מתחיל בשלבים שאינם משנים גאומטריה (איחוי, ניקוי, כיוונים)
            ומסלים רק אם צריך. בנייה מחדש פותרת כמעט כל תקלה — אך מאבדת
            פרטים דקים מהרזולוציה שנבחרה.
          </p>
        </div>

        {report && (
          <div className="border-t border-slate-200 pt-2">
            <p className="text-xs font-bold text-slate-500">מה בוצע</p>
            <p
              className={`mt-1 text-sm ${report.succeeded ? "text-emerald-700" : "text-red-700"}`}
            >
              {report.messageHe}
            </p>
            {report.stages.length > 0 && (
              <ul className="mt-1 list-inside list-disc text-[11px] text-slate-500">
                {report.stages.map((stage) => (
                  <li key={stage.stage}>{stage.messageHe}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Interference report
// ---------------------------------------------------------------------------

export function InterferenceDialog({
  open,
  report,
  onClose,
  onNavigate,
}: {
  open: boolean;
  report: InterferenceReport | null;
  onClose: () => void;
  onNavigate: (location: { x: number; y: number; z: number }) => void;
}) {
  return (
    <Modal
      title="בדיקת חדירה בין חלקים"
      open={open}
      onClose={onClose}
      footer={<ModalButton variant="primary" onClick={onClose}>סגור</ModalButton>}
    >
      {report && (
        <div className="flex flex-col gap-2">
          <p className={`text-sm ${report.pairs.length === 0 ? "text-emerald-700" : "text-red-700"}`}>
            {report.summaryHe}
          </p>
          {report.pairs.map((pair) => (
            <div
              key={`${pair.layerIdA}-${pair.layerIdB}`}
              className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800"
            >
              <div className="flex items-start justify-between gap-2">
                <b>
                  {pair.nameA} ↔ {pair.nameB}
                </b>
                <button
                  type="button"
                  className="shrink-0 rounded border border-current px-1.5 py-0.5 text-[10px]"
                  onClick={() => onNavigate(pair.location)}
                >
                  הצג
                </button>
              </div>
              <p className="mt-0.5">
                נפח חופף: {pair.overlapVolumeMm3.toFixed(2)} ממ״ק (
                {(pair.overlapFraction * 100).toFixed(1)}% מהחלק הקטן)
              </p>
            </div>
          ))}
          {report.pairs.length > 0 && (
            <p className="text-[11px] leading-snug text-slate-400">
              חלקים שחודרים זה לזה לא יורכבו אחרי ההדפסה. השתמשו ב״חיסור״
              כדי לפנות מקום, או הזיזו אחד מהם.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
