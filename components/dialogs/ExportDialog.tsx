"use client";

/**
 * Export dialog: filename, output type (single STL / ZIP of parts /
 * portable design file), part stats, validation results and a required
 * acknowledgement when exporting with warnings. Export is blocked on
 * critical geometry failures — never silently.
 */

import { useMemo, useState } from "react";
import type { DesignDocument, ModelIssue } from "@/types/design";
import type { BuiltPart } from "@/hooks/useDocumentBuilder";
import { getPrintabilityProfile } from "@/types/profiles";
import { unionBounds } from "@/lib/geometry/bounds";
import { Modal, ModalButton } from "@/components/ui/Modal";

export type ExportKind = "stl" | "zip" | "threemf" | "design";

export interface ExportDialogProps {
  open: boolean;
  document: DesignDocument;
  parts: BuiltPart[];
  issues: ModelIssue[];
  buildOk: boolean;
  onExport: (kind: ExportKind, fileName: string) => void;
  onClose: () => void;
}

export function ExportDialog({
  open,
  document,
  parts,
  issues,
  buildOk,
  onExport,
  onClose,
}: ExportDialogProps) {
  const [kind, setKind] = useState<ExportKind>("stl");
  const [fileName, setFileName] = useState("my-design");
  const [acknowledged, setAcknowledged] = useState(false);

  const profile = getPrintabilityProfile(document.printabilityProfileId);
  const totalTriangles = parts.reduce((sum, p) => sum + p.stats.triangleCount, 0);
  const allWatertight = parts.length > 0 && parts.every((p) => p.stats.watertight);
  const criticalIssues = useMemo(
    () =>
      [
        ...issues,
        ...parts.flatMap((p) => p.issues),
      ].filter((i) => i.severity === "critical"),
    [issues, parts]
  );
  const warningIssues = useMemo(
    () =>
      [
        ...issues,
        ...parts.flatMap((p) => p.issues),
      ].filter((i) => i.severity === "warning"),
    [issues, parts]
  );

  // Paint only survives the formats that can carry more than one material.
  // Saying nothing here shipped a single-colour file to someone who had just
  // watched the viewport show two.
  const hasPaint = useMemo(
    () =>
      document.layers.some((layer) =>
        (layer.facePaint ?? []).some((p) => p.triangles.length > 0)
      ),
    [document.layers]
  );

  const geometryBlocked =
    kind !== "design" && (!buildOk || !allWatertight || criticalIssues.length > 0 || parts.length === 0);
  const needsAck = kind !== "design" && warningIssues.length > 0;
  const canExport = !geometryBlocked && (!needsAck || acknowledged) && fileName.trim().length > 0;

  const bounds = useMemo(
    () => unionBounds(parts.map((p) => p.stats.bounds)),
    [parts]
  );

  return (
    <Modal
      title="ייצוא"
      open={open}
      onClose={onClose}
      wide
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton
            variant="primary"
            disabled={!canExport}
            onClick={() => onExport(kind, fileName.trim())}
          >
            ייצוא
          </ModalButton>
        </>
      }
    >
      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">שם קובץ</span>
        <input
          dir="ltr"
          className="w-56 rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
        />
      </label>

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 text-xs font-bold text-slate-500">סוג ייצוא</legend>
        {hasPaint && kind === "stl" && (
          <p className="mb-1 rounded-md bg-amber-50 p-2 text-[11px] leading-snug text-amber-800">
            בעיצוב יש אזורים צבועים. קובץ STL יחיד אינו נושא חומרים, ולכן הם
            <b> לא יופרדו</b>. בחרו ZIP או 3MF כדי לשמור את הצבעים.
          </p>
        )}
        <label className="flex items-center gap-2">
          <input type="radio" checked={kind === "stl"} onChange={() => setKind("stl")} />
          <span>
            קובץ STL בינארי אחד{" "}
            {parts.length > 1 && (
              <span className="text-xs text-slate-400">
                (כל {parts.length} החלקים בקובץ אחד)
              </span>
            )}
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={kind === "zip"} onChange={() => setKind("zip")} />
          <span>
            ZIP עם STL נפרד לכל חלק/צבע + README{" "}
            <span className="text-xs text-slate-400">({parts.length} חלקים)</span>
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={kind === "threemf"} onChange={() => setKind("threemf")} />
          <span>
            קובץ 3MF{" "}
            <span className="text-xs text-slate-400">
              (שומר צבעים/חומרים לכל חלק — PrusaSlicer, Bambu, Cura)
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={kind === "design"} onChange={() => setKind("design")} />
          <span>
            קובץ עיצוב נייד (.formadesign.json){" "}
            <span className="text-xs text-slate-400">להמשך עבודה</span>
          </span>
        </label>
      </fieldset>

      <div className="rounded-md border border-slate-200 p-2 text-sm">
        <p className="mb-1 text-xs font-bold text-slate-500">סיכום</p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-slate-500">חלקים</dt>
          <dd className="text-end">{parts.length}</dd>
          <dt className="text-slate-500">משולשים</dt>
          <dd className="text-end">{totalTriangles.toLocaleString()}</dd>
          {bounds && (
            <>
              <dt className="text-slate-500">מידות כוללות</dt>
              <dd className="text-end font-mono" dir="ltr">
                {(bounds.max.x - bounds.min.x).toFixed(1)} × {(bounds.max.y - bounds.min.y).toFixed(1)} × {(bounds.max.z - bounds.min.z).toFixed(1)} mm
              </dd>
            </>
          )}
          <dt className="text-slate-500">אטימות</dt>
          <dd className={`text-end ${allWatertight ? "text-emerald-600" : "text-red-600"}`}>
            {allWatertight ? "כל החלקים אטומים" : "יש חלקים לא אטומים"}
          </dd>
          <dt className="text-slate-500">פרופיל הדפסה</dt>
          <dd className="text-end">{profile.nameHe}</dd>
        </dl>
        {parts.length > 1 && (
          <ul className="mt-2 border-t border-slate-100 pt-1 text-xs text-slate-600">
            {parts.map((p) => {
              const slot = document.materialSlots.find((s) => s.id === p.materialSlotId);
              return (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 truncate">
                    <span
                      className="inline-block h-3 w-3 shrink-0 rounded-full border border-slate-200"
                      style={{ backgroundColor: slot?.colorHex ?? "#888" }}
                    />
                    {p.nameHe}
                  </span>
                  <span dir="ltr" className="shrink-0 font-mono text-[11px] text-slate-400">
                    {p.stats.dimensionsMm.x.toFixed(0)}×{p.stats.dimensionsMm.y.toFixed(0)}×{p.stats.dimensionsMm.z.toFixed(0)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {geometryBlocked && (
        <div className="rounded-md bg-red-50 p-2 text-xs text-red-700">
          <p className="font-bold">הייצוא חסום — יש בעיות גיאומטריה קריטיות:</p>
          <ul className="mt-1 list-inside list-disc">
            {criticalIssues.slice(0, 5).map((issue, i) => (
              <li key={i}>{issue.titleHe}</li>
            ))}
            {parts.length === 0 && <li>אין חלקים לייצוא</li>}
          </ul>
        </div>
      )}

      {needsAck && !geometryBlocked && (
        <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
          <p className="font-bold">אזהרות פעילות:</p>
          <ul className="mt-1 list-inside list-disc">
            {warningIssues.slice(0, 6).map((issue, i) => (
              <li key={i}>{issue.titleHe}</li>
            ))}
          </ul>
          <label className="mt-2 flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            אני מבין/ה את האזהרות ומעוניין/ת לייצא בכל זאת
          </label>
        </div>
      )}
    </Modal>
  );
}
