"use client";

/**
 * Import dialogs: STL summary confirmation, SVG options, image
 * (silhouette / relief) options.
 */

import { useState } from "react";
import type { StlImportSummary } from "@/lib/import/stl";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { Modal, ModalButton } from "@/components/ui/Modal";

// ---------------------------------------------------------------------------
// STL summary
// ---------------------------------------------------------------------------

export interface StlImportPreview {
  fileName: string;
  summary: StlImportSummary;
  manifold: boolean;
  repairMessageHe: string | null;
}

export function StlImportDialog({
  preview,
  onConfirm,
  onClose,
}: {
  preview: StlImportPreview | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="ייבוא קובץ STL"
      open={preview !== null}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={onConfirm}>
            ייבא
          </ModalButton>
        </>
      }
    >
      {preview && (
        <>
          <p className="text-sm text-slate-700" dir="ltr">
            {preview.fileName}
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-slate-500">מידות</dt>
            <dd dir="ltr" className="text-end font-mono text-xs">
              {preview.summary.dimensionsMm.x.toFixed(1)} × {preview.summary.dimensionsMm.y.toFixed(1)} × {preview.summary.dimensionsMm.z.toFixed(1)} mm
            </dd>
            <dt className="text-slate-500">משולשים</dt>
            <dd className="text-end">{preview.summary.triangleCount.toLocaleString()}</dd>
            <dt className="text-slate-500">נפח משוער</dt>
            <dd className="text-end">
              {(preview.summary.approxVolumeMm3 / 1000).toFixed(1)} סמ״ק
            </dd>
            <dt className="text-slate-500">חלקים</dt>
            <dd className="text-end">{preview.summary.componentCount}</dd>
            <dt className="text-slate-500">אטימות (Manifold)</dt>
            <dd className={`text-end ${preview.manifold ? "text-emerald-600" : "text-amber-600"}`}>
              {preview.manifold ? "תקין" : "דורש תיקון"}
            </dd>
          </dl>
          {preview.repairMessageHe && (
            <p className="rounded bg-amber-50 p-2 text-xs text-amber-700">
              {preview.repairMessageHe}
            </p>
          )}
          {preview.summary.warningsHe.map((w, i) => (
            <p key={i} className="rounded bg-slate-50 p-2 text-xs text-slate-600">
              ⚠ {w}
            </p>
          ))}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// SVG options
// ---------------------------------------------------------------------------

export interface SvgImportOptionsValue {
  targetWidthMm: number;
  extrudeMm: number;
}

export function SvgImportDialog({
  open,
  fileName,
  onConfirm,
  onClose,
}: {
  open: boolean;
  fileName: string;
  onConfirm: (options: SvgImportOptionsValue) => void;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(60);
  const [extrude, setExtrude] = useState(3);
  return (
    <Modal
      title="ייבוא SVG"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton
            variant="primary"
            onClick={() => onConfirm({ targetWidthMm: width, extrudeMm: extrude })}
          >
            ייבא
          </ModalButton>
        </>
      }
    >
      <p className="text-sm text-slate-700" dir="ltr">
        {fileName}
      </p>
      <NumberField label="רוחב יעד" value={width} min={1} max={400} onChange={setWidth} />
      <NumberField label="עובי/עומק" value={extrude} min={0.2} max={100} step={0.5} onChange={setExtrude} />
      <p className="text-xs text-slate-500">
        צורות ממולאות בלבד נתמכות; חורים (fill-rule) נשמרים. ניתן לשנות הכל
        אחר כך בפאנל המאפיינים.
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Image options
// ---------------------------------------------------------------------------

export interface ImageImportOptionsValue {
  mode: "silhouette" | "relief";
  targetWidthMm: number;
  /**
   * "auto" computes the silhouette threshold from the image (Otsu) at import
   * time; "manual" uses `threshold` below. Auto is the default because the
   * threshold used to be the first thing the user had to guess, sight unseen,
   * and it governs the entire shape.
   */
  thresholdMode: "auto" | "manual";
  threshold: number;
  invert: boolean;
  extrudeMm: number;
  reliefHeightMm: number;
  minThicknessMm: number;
  resolution: number;
  smoothingLevel: number;
  /**
   * Silhouette only: thicken strokes the printer cannot resolve, up to the
   * machine's minimum. Default on — a stroke thinner than two extrusion
   * widths does not come out at all, so leaving it alone produces a file that
   * looks right and prints wrong.
   */
  thickenThinFeatures: boolean;
  removeBackground: boolean;
  bgToleranceMm: number;
  brightness: number;
  contrast: number;
}

export function ImageImportDialog({
  open,
  fileName,
  onConfirm,
  onClose,
}: {
  open: boolean;
  fileName: string;
  onConfirm: (options: ImageImportOptionsValue) => void;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<ImageImportOptionsValue>({
    mode: "silhouette",
    targetWidthMm: 60,
    thresholdMode: "auto",
    threshold: 0.5,
    invert: false,
    extrudeMm: 3,
    reliefHeightMm: 2,
    minThicknessMm: 1,
    resolution: 200,
    smoothingLevel: 1,
    thickenThinFeatures: true,
    removeBackground: false,
    bgToleranceMm: 24,
    brightness: 0,
    contrast: 0,
  });
  const patch = (p: Partial<ImageImportOptionsValue>) =>
    setOptions((o) => ({ ...o, ...p }));
  return (
    <Modal
      title="ייבוא תמונה (PNG/JPG)"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={() => onConfirm(options)}>
            צור גוף
          </ModalButton>
        </>
      }
    >
      <p className="text-sm text-slate-700" dir="ltr">
        {fileName}
      </p>
      <ToggleGroup
        label="מצב"
        value={options.mode}
        options={[
          { value: "silhouette", label: "צללית" },
          { value: "relief", label: "תבליט" },
        ]}
        onChange={(mode) => patch({ mode })}
      />
      <NumberField label="רוחב יעד" value={options.targetWidthMm} min={5} max={400} onChange={(targetWidthMm) => patch({ targetWidthMm })} />
      {options.mode === "silhouette" ? (
        <>
          <ToggleGroup
            label="סף בהירות"
            value={options.thresholdMode}
            options={[
              { value: "auto", label: "אוטומטי" },
              { value: "manual", label: "ידני" },
            ]}
            onChange={(thresholdMode) => patch({ thresholdMode })}
          />
          {options.thresholdMode === "manual" ? (
            <NumberField label="ערך הסף" value={options.threshold} min={0.05} max={0.95} step={0.05} unit="" onChange={(threshold) => patch({ threshold })} />
          ) : (
            <p className="text-xs text-slate-500">
              הסף מחושב מהתמונה עצמה (שיטת Otsu) ברגע הייבוא, ונשמר בשכבה.
              עברו ל״ידני״ אם ההפרדה שיצאה אינה מה שרציתם.
            </p>
          )}
          <NumberField label="עובי" value={options.extrudeMm} min={0.4} max={100} step={0.5} onChange={(extrudeMm) => patch({ extrudeMm })} />
          <label className="flex items-center justify-between text-sm">
            <span className="text-slate-600">עיבוי קווים דקים לפי המדפסת</span>
            <input
              type="checkbox"
              checked={options.thickenThinFeatures}
              onChange={(e) => patch({ thickenThinFeatures: e.target.checked })}
            />
          </label>
          <p className="text-xs text-slate-500">
            קו דק משתי רצועות פיה לא ייצא בהדפסה. כשנמצא קו כזה הוא יעובה
            אוטומטית עד למינימום של המדפסת, ותוצג הודעה עם המידה שנמדדה.
          </p>
        </>
      ) : (
        <>
          <NumberField label="גובה תבליט" value={options.reliefHeightMm} min={0.2} max={30} step={0.2} onChange={(reliefHeightMm) => patch({ reliefHeightMm })} />
          <NumberField label="עובי מינימלי" value={options.minThicknessMm} min={0.4} max={20} step={0.2} onChange={(minThicknessMm) => patch({ minThicknessMm })} />
        </>
      )}
      <label className="flex items-center justify-between text-sm">
        <span className="text-slate-600">היפוך (בהיר ↔ כהה)</span>
        <input
          type="checkbox"
          checked={options.invert}
          onChange={(e) => patch({ invert: e.target.checked })}
        />
      </label>
      <NumberField label="רזולוציה" value={options.resolution} min={32} max={512} step={16} unit="px" onChange={(resolution) => patch({ resolution })} />
      <NumberField label="רמת החלקה" value={options.smoothingLevel} min={0} max={5} step={1} unit="" onChange={(smoothingLevel) => patch({ smoothingLevel: Math.round(smoothingLevel) })} />
      <label className="flex items-center justify-between text-sm">
        <span className="text-slate-600">הסרת רקע אוטומטית (מקומית, ללא ענן)</span>
        <input
          type="checkbox"
          checked={options.removeBackground}
          onChange={(e) => patch({ removeBackground: e.target.checked })}
        />
      </label>
      {options.removeBackground && (
        <NumberField
          label="סבילות צבע רקע"
          value={options.bgToleranceMm}
          min={1}
          max={100}
          step={1}
          unit=""
          onChange={(bgToleranceMm) => patch({ bgToleranceMm })}
        />
      )}
      <NumberField label="בהירות" value={options.brightness} min={-1} max={1} step={0.05} unit="" onChange={(brightness) => patch({ brightness })} />
      <NumberField label="ניגודיות" value={options.contrast} min={-1} max={1} step={0.05} unit="" onChange={(contrast) => patch({ contrast })} />
      <p className="text-xs text-slate-500">
        צללית: אזורים כהים הופכים לגוף שטוח (כמו SVG). תבליט: גוף סגור שגובהו
        משתנה לפי בהירות — אזורים כהים גבוהים יותר.
      </p>
    </Modal>
  );
}
