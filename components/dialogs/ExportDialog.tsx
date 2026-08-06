"use client";

/**
 * Export dialog: filename, format selection (single STL / multi-colour ZIP /
 * 3MF / portable design file), dimensions + triangle count + validation
 * summary, honest colour explanations, and warning acknowledgement before
 * export. Errors block export entirely.
 */

import { useMemo, useState } from "react";
import { useEditorStore } from "@/lib/design/store";
import { collectAssets } from "@/lib/design/assets";
import { resolveAsset } from "@/lib/design/assetResolver";
import type { DesignBuilderState } from "@/hooks/useDesignBuilder";
import { downloadBlob } from "@/lib/export/stl";
import {
  designFileName,
  safeFilenameStem,
  stlFileName,
  threeMfFileName,
  zipFileName,
} from "@/lib/export/filenames";
import {
  ExportBlockedError,
  exportMultiColorZip,
  exportSingleStl,
  exportThreeMf,
} from "@/lib/export/exportDesign";
import {
  buildPortableFile,
  PORTABLE_LARGE_BYTES,
  serializePortable,
} from "@/lib/serialization/portable";
import { getProductTemplate } from "@/lib/design/templates";
import { Modal, PrimaryButton, SecondaryButton } from "@/components/ui/Modal";

type ExportFormat = "stl" | "zip" | "3mf" | "design";

interface ExportDialogProps {
  open: boolean;
  builder: DesignBuilderState;
  onClose: () => void;
}

const FORMAT_INFO: Record<ExportFormat, { label: string; explain: string }> = {
  stl: {
    label: "קובץ STL אחד (גאומטריה בלבד)",
    explain:
      "כל החלקים מאוחדים לגוף מודפס אחד. קובץ STL אינו שומר צבעים — הצבעים בתצוגה לא ייכללו בקובץ.",
  },
  zip: {
    label: "קובצי STL נפרדים לפי צבע (ZIP)",
    explain:
      "קובץ STL לכל צבע/חומר + קובץ README עם הוראות הרכבה בעברית ובאנגלית. זו הדרך האמינה להדפסה רב-צבעית בכל סלייסר.",
  },
  "3mf": {
    label: "קובץ 3MF (חלקים + צבעים)",
    explain:
      "אריזת 3MF אחת עם כל החלקים, כולל שמות, צבעים וחומרים — לסלייסרים התומכים ב-3MF (PrusaSlicer, Bambu Studio, Cura).",
  },
  design: {
    label: "קובץ עיצוב לעריכה עתידית (.formadesign.json)",
    explain:
      "קובץ נייד עם כל השכבות וההגדרות. פתחו אותו בכלי בעתיד כדי להמשיך לערוך. אינו קובץ הדפסה.",
  },
};

export function ExportDialog({ open, builder, onClose }: ExportDialogProps) {
  const { state } = useEditorStore();
  const [format, setFormat] = useState<ExportFormat>("stl");
  const [stem, setStem] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const issues = builder.result?.issues ?? [];
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const mesh = builder.result?.mesh ?? null;
  const template = getProductTemplate(state.doc.templateId);

  const defaultStem = useMemo(
    () => safeFilenameStem(state.doc.title, template.suggestedFilename),
    [state.doc.title, template.suggestedFilename]
  );
  const effectiveStem = stem.trim() || defaultStem;

  const blocked = errors.length > 0 || builder.status !== "ok";
  const needsAck = warnings.length > 0 && format !== "design";
  const canExport = !busy && (format === "design" || !blocked) && (!needsAck || acknowledged);

  const runExport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      if (format === "design") {
        const assetIds = state.doc.layers
          .filter((l) => l.type === "imageRelief")
          .map((l) => (l.type === "imageRelief" ? l.assetId : ""))
          .filter(Boolean);
        const portable = buildPortableFile({
          state,
          title: state.doc.title || effectiveStem,
          assets: collectAssets(assetIds),
        });
        const json = serializePortable(portable);
        const name = designFileName(state.doc.title, template.suggestedFilename);
        downloadBlob(new Blob([json], { type: "application/json" }), name);
        setSuccess(
          `קובץ העיצוב ירד למחשב (${name}). אפשר לפתוח אותו בעתיד כדי להמשיך לערוך.` +
            (json.length > PORTABLE_LARGE_BYTES
              ? " שימו לב: הקובץ גדול בגלל תמונות מוטמעות."
              : "")
        );
      } else if (format === "stl") {
        const result = await exportSingleStl(state, resolveAsset);
        downloadBlob(result.blob, stlFileName(effectiveStem, template.suggestedFilename));
        setSuccess("קובץ ה-STL ירד למחשב. זכרו: הצבעים אינם נשמרים ב-STL.");
      } else if (format === "zip") {
        const result = await exportMultiColorZip(state, resolveAsset);
        downloadBlob(result.blob, zipFileName(effectiveStem, template.suggestedFilename));
        setSuccess(
          `ארכיון ZIP עם ${result.parts.length} חלקים ירד למחשב, כולל README עם הוראות.`
        );
      } else {
        const result = await exportThreeMf(state, resolveAsset);
        downloadBlob(result.blob, threeMfFileName(effectiveStem, template.suggestedFilename));
        setSuccess(`קובץ 3MF עם ${result.parts.length} חלקים צבעוניים ירד למחשב.`);
      }
    } catch (err) {
      if (err instanceof ExportBlockedError) {
        setError("הייצוא נחסם בגלל שגיאות בעיצוב — תקנו אותן בלשונית הבדיקה ונסו שוב.");
      } else {
        setError(`הייצוא נכשל: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="ייצוא"
      open={open}
      onClose={onClose}
      widthClass="max-w-xl"
      footer={
        <>
          <SecondaryButton onClick={onClose}>סגירה</SecondaryButton>
          <PrimaryButton onClick={() => void runExport()} disabled={!canExport}>
            {busy ? "מייצא…" : "ייצוא והורדה"}
          </PrimaryButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-slate-600">שם קובץ</span>
          <input
            type="text"
            dir="ltr"
            className="w-52 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-blue-500"
            placeholder={defaultStem}
            value={stem}
            onChange={(e) => setStem(e.target.value)}
          />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-bold text-slate-700">פורמט ייצוא</legend>
          {(Object.keys(FORMAT_INFO) as ExportFormat[]).map((f) => (
            <label
              key={f}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm ${
                format === f ? "border-blue-400 bg-blue-50" : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <input
                type="radio"
                name="export-format"
                className="mt-1 accent-blue-600"
                checked={format === f}
                onChange={() => {
                  setFormat(f);
                  setAcknowledged(false);
                  setSuccess(null);
                }}
              />
              <span>
                <span className="font-semibold text-slate-800">{FORMAT_INFO[f].label}</span>
                <span className="block text-xs leading-relaxed text-slate-500">
                  {FORMAT_INFO[f].explain}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {mesh && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-slate-50 p-3 text-xs">
            <dt className="text-slate-500">מידות</dt>
            <dd className="text-end font-mono" dir="ltr">
              {mesh.dimensionsMm.x} × {mesh.dimensionsMm.y} × {mesh.dimensionsMm.z} mm
            </dd>
            <dt className="text-slate-500">משולשים</dt>
            <dd className="text-end font-mono" dir="ltr">{mesh.triangleCount.toLocaleString()}</dd>
            <dt className="text-slate-500">בדיקת הדפסה</dt>
            <dd className="text-end">
              {blocked ? "⛔ שגיאות" : warnings.length > 0 ? `⚠️ ${warnings.length} אזהרות` : "✅ תקין"}
            </dd>
          </dl>
        )}

        {blocked && format !== "design" && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            לא ניתן לייצא קובצי הדפסה כשיש שגיאות בעיצוב. פתחו את לשונית
            &quot;בדיקה&quot; לפרטים ולתיקון אוטומטי. (ייצוא קובץ עיצוב לעריכה עדיין אפשרי.)
          </p>
        )}

        {needsAck && !blocked && (
          <label className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <input
              type="checkbox"
              className="mt-0.5 accent-amber-600"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>
              יש {warnings.length} אזהרות הדפסה. אני מבין/ה שהמודל עלול לצאת
              שונה מהמצופה ומאשר/ת לייצא בכל זאת.
            </span>
          </label>
        )}

        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {success && (
          <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{success}</p>
        )}
      </div>
    </Modal>
  );
}
