"use client";

/**
 * Import dialogs: STL summary confirmation, SVG options, image
 * (silhouette / relief) options.
 */

import { useEffect, useRef, useState } from "react";
import type { StlImportSummary } from "@/lib/import/stl";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { Modal, ModalButton } from "@/components/ui/Modal";
import {
  applyMaskStrokes,
  decodeImageToGrid,
  ImageImportError,
  otsuThreshold,
  smoothGrid,
  type LuminanceGrid,
  type MaskStroke,
} from "@/lib/import/image";

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
  /**
   * Hand corrections to the silhouette, in normalised image coordinates.
   * Session-only by design — see the note in `MaskBrush`.
   */
  maskStrokes: MaskStroke[];
}

// ---------------------------------------------------------------------------
// Manual mask brush
// ---------------------------------------------------------------------------

/** Brush radius as a fraction of the image's larger side. */
const BRUSH_MIN_PERCENT = 1;
const BRUSH_MAX_PERCENT = 25;
/** Re-decoding on every keystroke would thrash the canvas; wait for a pause. */
const PREVIEW_DEBOUNCE_MS = 220;

/**
 * Live silhouette preview with an add/erase brush.
 *
 * This exists because `removeBackground.ts` promised it and nobody had built
 * it: when the automatic separation failed, the dialog offered two number
 * fields and no recourse at all. It is deliberately an escape hatch and not an
 * image editor — paint, erase, size, reset, and nothing else.
 *
 * The preview runs the same pipeline the import runs (decode → smooth →
 * threshold → strokes), so what is shown is what gets traced.
 */
function MaskBrush({
  file,
  options,
  onStrokes,
}: {
  file: File;
  options: ImageImportOptionsValue;
  onStrokes: (update: (previous: MaskStroke[]) => MaskStroke[]) => void;
}) {
  const [grid, setGrid] = useState<LuminanceGrid | null>(null);
  const [errorHe, setErrorHe] = useState<string | null>(null);
  const [add, setAdd] = useState(false);
  const [radiusPercent, setRadiusPercent] = useState(5);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  const {
    resolution,
    brightness,
    contrast,
    removeBackground,
    bgToleranceMm,
    smoothingLevel,
    thresholdMode,
    threshold,
    invert,
    maskStrokes,
  } = options;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      decodeImageToGrid(file, resolution, {
        removeBackgroundTolerance: removeBackground ? bgToleranceMm : null,
        brightness,
        contrast,
      })
        .then((decoded) => {
          if (cancelled) return;
          setErrorHe(null);
          setGrid(smoothGrid(decoded.grid, smoothingLevel));
        })
        .catch((error) => {
          if (cancelled) return;
          setGrid(null);
          setErrorHe(
            error instanceof ImageImportError
              ? error.messageHe
              : "לא ניתן להציג תצוגה מקדימה של התמונה"
          );
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    file,
    resolution,
    brightness,
    contrast,
    removeBackground,
    bgToleranceMm,
    smoothingLevel,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !grid) return;
    // The same threshold the import will compute from the same grid.
    const effective = thresholdMode === "auto" ? otsuThreshold(grid) : threshold;
    const painted = applyMaskStrokes(grid, maskStrokes, { threshold: effective, invert });
    canvas.width = painted.width;
    canvas.height = painted.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(painted.width, painted.height);
    for (let i = 0; i < painted.values.length; i++) {
      const lum = painted.values[i];
      const inside = invert ? lum > effective : lum < effective;
      image.data[i * 4] = inside ? 30 : 248;
      image.data[i * 4 + 1] = inside ? 41 : 250;
      image.data[i * 4 + 2] = inside ? 59 : 252;
      image.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }, [grid, maskStrokes, threshold, thresholdMode, invert]);

  const pointAt = (event: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    return [
      clamp((event.clientX - rect.left) / rect.width),
      clamp((event.clientY - rect.top) / rect.height),
    ];
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm text-slate-600">תצוגה מקדימה וצביעה ידנית</span>
      {errorHe && <p className="rounded bg-amber-50 p-2 text-xs text-amber-700">{errorHe}</p>}
      {!grid && !errorHe && <p className="text-xs text-slate-500">מכין תצוגה מקדימה…</p>}
      <canvas
        ref={canvasRef}
        data-testid="mask-brush-canvas"
        aria-label="תצוגה מקדימה של הצללית — ניתן לצייר עליה"
        className="w-full cursor-crosshair rounded border border-slate-300 bg-white"
        style={{ imageRendering: "pixelated", touchAction: "none" }}
        onPointerDown={(event) => {
          if (!grid) return;
          drawing.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          const point = pointAt(event);
          onStrokes((previous) => [
            ...previous,
            { points: [point], radius: radiusPercent / 100, add },
          ]);
        }}
        onPointerMove={(event) => {
          if (!drawing.current) return;
          const point = pointAt(event);
          onStrokes((previous) => {
            if (previous.length === 0) return previous;
            const last = previous[previous.length - 1];
            return [
              ...previous.slice(0, -1),
              { ...last, points: [...last.points, point] },
            ];
          });
        }}
        onPointerUp={() => {
          drawing.current = false;
        }}
        onPointerCancel={() => {
          drawing.current = false;
        }}
      />
      <ToggleGroup
        label="מברשת"
        value={add ? "add" : "erase"}
        options={[
          { value: "erase", label: "מחיקה" },
          { value: "add", label: "הוספה" },
        ]}
        onChange={(value) => setAdd(value === "add")}
      />
      <NumberField
        label="גודל מברשת"
        value={radiusPercent}
        min={BRUSH_MIN_PERCENT}
        max={BRUSH_MAX_PERCENT}
        step={1}
        unit="%"
        onChange={setRadiusPercent}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">
          {maskStrokes.length > 0 ? `${maskStrokes.length} משיחות` : "אין משיחות"}
        </span>
        <ModalButton onClick={() => onStrokes(() => [])}>נקה סימונים</ModalButton>
      </div>
      <p className="text-xs text-slate-500">
        הצביעה חלה על הייבוא הזה בלבד ואינה נשמרת בקובץ העיצוב — קובץ העיצוב
        שומר את קווי המתאר שנוצרו, לא את התמונה המקורית, ולכן אין למשיחות על מה
        לחול בטעינה מחדש. שינוי רזולוציה, בהירות או ניגודיות אינו מוחק אותן.
      </p>
    </div>
  );
}

export function ImageImportDialog({
  open,
  file,
  fileName,
  onConfirm,
  onClose,
}: {
  open: boolean;
  file: File | null;
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
    maskStrokes: [],
  });
  const patch = (p: Partial<ImageImportOptionsValue>) =>
    setOptions((o) => ({ ...o, ...p }));

  // Strokes belong to ONE image. The dialog is reused for every pick, so they
  // are dropped on the way out — leaving them would land them on unrelated
  // pixels of the next file. Every other setting is worth keeping.
  const finish = (confirm: boolean) => {
    if (confirm) onConfirm(options);
    else onClose();
    patch({ maskStrokes: [] });
  };

  return (
    <Modal
      title="ייבוא תמונה (PNG/JPG)"
      open={open}
      onClose={() => finish(false)}
      wide
      footer={
        <>
          <ModalButton onClick={() => finish(false)}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={() => finish(true)}>
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
      {options.mode === "silhouette" && file && (
        <MaskBrush
          file={file}
          options={options}
          onStrokes={(update) =>
            setOptions((o) => ({ ...o, maskStrokes: update(o.maskStrokes) }))
          }
        />
      )}
    </Modal>
  );
}
