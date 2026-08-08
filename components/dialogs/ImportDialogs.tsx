"use client";

/**
 * Import dialogs: STL summary confirmation, SVG options, image
 * (silhouette / relief) options.
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
import { AI_MODELS, formatModelSize, type AiModelSpec } from "@/lib/ai/models";
import { isModelCached } from "@/lib/ai/modelCache";
import {
  runAiJob,
  disposeAiWorker,
  AiJobCancelledError,
  type AiJobName,
} from "@/lib/ai/client";
import type { AiInferenceResult } from "@/lib/ai/jobs";
import { decodeImageToRgba } from "@/lib/ai/imageDecode";
import { AiError } from "@/lib/ai/errors";
import { AI_MASK_THRESHOLD, maskCoverage, saliencyToMaskGrid } from "@/lib/ai/segmentation";
import { depthToReliefGrid } from "@/lib/ai/depth";

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
      title="ייבוא קובץ מודל"
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
  /**
   * "smartRelief" is the depth-model relief ("תבליט חכם"); "cloud" sends the
   * image to the configured generative provider (Milestone B). The first two
   * are the classic paths, untouched.
   */
  mode: "silhouette" | "relief" | "smartRelief" | "cloud";
  targetWidthMm: number;
  /**
   * "auto" computes the silhouette threshold from the image (Otsu) at import
   * time; "manual" uses `threshold` below. Auto is the default because the
   * threshold used to be the first thing the user had to guess, sight unseen,
   * and it governs the entire shape. "ai" replaces the luminance grid with
   * the on-device segmentation model's mask, traced at a fixed 0.5.
   */
  thresholdMode: "auto" | "manual" | "ai";
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
  /**
   * On-device model outputs, computed in the dialog (with the download
   * notice and progress) and handed to the import so the preview and the
   * file are the same computation. Null until the user runs the model.
   */
  aiMask: AiInferenceResult | null;
  aiDepth: AiInferenceResult | null;
  /** Smart relief: flip the height mapping (lithophane-style). */
  depthInvert: boolean;
  /** Smart relief: floor the background found by the segmentation model. */
  maskWithSegmentation: boolean;
  /** Cloud mode: footprint of the generated model (the provider has no units). */
  cloudTargetSizeMm: number;
}

// ---------------------------------------------------------------------------
// On-device AI runs (download notice, progress, cancel)
// ---------------------------------------------------------------------------

interface AiRunState {
  busy: { fraction: number | null; labelHe: string } | null;
  errorHe: string | null;
  /** Where the last successful run executed, for the honest engine report. */
  ranOn: "worker" | "main" | null;
}

/**
 * Run the on-device models for the current file. Results live in the
 * dialog's options so the trace the user previews is the trace the import
 * performs; they are keyed to the file and cleared when it changes.
 */
function useAiInference(
  file: File | null,
  onResult: (patch: Partial<ImageImportOptionsValue>) => void
) {
  const [state, setState] = useState<AiRunState>({ busy: null, errorHe: null, ranOn: null });
  const abortRef = useRef<AbortController | null>(null);

  // Results belong to ONE image; abort any run in flight when the file
  // changes or the dialog empties. The aborted run's own rejection handler
  // clears the busy state, and the dialog clears the stored results (a
  // render-phase adjustment there, not an effect cascade here).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [file]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(
    async (jobs: AiJobName[]) => {
      if (!file || jobs.length === 0) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ busy: { fraction: null, labelHe: "מתחיל…" }, errorHe: null, ranOn: null });
      try {
        const rgba = await decodeImageToRgba(file);
        let ranOn: "worker" | "main" = "worker";
        const patch: Partial<ImageImportOptionsValue> = {};
        for (let i = 0; i < jobs.length; i++) {
          const name = jobs[i];
          const outcome = await runAiJob(
            name,
            // Each job gets its own copy: the buffer is transferred to the
            // worker, and a detached buffer cannot be sent twice.
            { rgba: new Uint8Array(rgba.data), width: rgba.width, height: rgba.height },
            {
              signal: controller.signal,
              onProgress: (fraction, labelHe) =>
                setState((s) => ({
                  ...s,
                  busy: { fraction: (i + fraction) / jobs.length, labelHe },
                })),
            }
          );
          ranOn = outcome.ranOn;
          if (name === "segmentImage") patch.aiMask = outcome.result;
          else patch.aiDepth = outcome.result;
        }
        onResult(patch);
        setState({ busy: null, errorHe: null, ranOn });
      } catch (err) {
        if (err instanceof AiJobCancelledError || controller.signal.aborted) {
          setState({ busy: null, errorHe: null, ranOn: null });
          return;
        }
        setState({
          busy: null,
          errorHe:
            err instanceof AiError
              ? err.messageHe
              : err instanceof Error
                ? err.message
                : "הרצת ה-AI נכשלה",
          ranOn: null,
        });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [file, onResult]
  );

  return { state, run, cancel };
}

/** One model's download notice: name, size, license, cache status. */
function AiModelNotice({ spec }: { spec: AiModelSpec }) {
  const [cached, setCached] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    isModelCached(spec).then((hit) => {
      if (live) setCached(hit);
    });
    return () => {
      live = false;
    };
  }, [spec]);
  return (
    <p className="text-xs text-slate-500">
      מודל: {spec.nameHe} · {formatModelSize(spec.approxBytes)} · רישיון {spec.license}
      {cached === true
        ? " · כבר שמור במטמון הדפדפן"
        : " · יורד פעם אחת בהפעלה הראשונה ונשמר במטמון הדפדפן"}
    </p>
  );
}

/**
 * The run button + progress + honest engine report for an on-device model.
 * Nothing downloads and nothing runs until the button is pressed — the
 * notice above the button says what will be fetched and from where it runs.
 */
function AiRunControls({
  specs,
  state,
  hasResult,
  provider,
  runLabelHe,
  onRun,
  onCancel,
  warningHe,
}: {
  specs: AiModelSpec[];
  state: AiRunState;
  hasResult: boolean;
  provider: string | null;
  runLabelHe: string;
  onRun: () => void;
  onCancel: () => void;
  warningHe: string | null;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 p-2">
      {specs.map((spec) => (
        <AiModelNotice key={spec.id} spec={spec} />
      ))}
      <p className="text-xs text-slate-500">
        ההרצה כולה מקומית במכשיר — התמונה אינה נשלחת לשום שרת.
      </p>
      {state.busy ? (
        <div className="flex items-center gap-2">
          <div
            role="progressbar"
            aria-label={state.busy.labelHe}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              state.busy.fraction === null
                ? undefined
                : Math.round(state.busy.fraction * 100)
            }
            className="h-2 flex-1 overflow-hidden rounded bg-slate-200"
          >
            <div
              className="h-full bg-blue-600 transition-all"
              style={{ width: `${Math.round((state.busy.fraction ?? 0.05) * 100)}%` }}
            />
          </div>
          <span className="whitespace-nowrap text-xs text-slate-600">{state.busy.labelHe}</span>
          <ModalButton onClick={onCancel}>ביטול</ModalButton>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <ModalButton variant="primary" onClick={onRun}>
            {hasResult ? `${runLabelHe} מחדש` : runLabelHe}
          </ModalButton>
          {hasResult && provider && (
            <span className="text-xs text-slate-500">
              המנוע שרץ: {provider === "webgpu" ? "WebGPU" : "WASM (איטי יותר)"}
            </span>
          )}
        </div>
      )}
      {state.errorHe && (
        <p className="rounded bg-amber-50 p-2 text-xs text-amber-700">{state.errorHe}</p>
      )}
      {warningHe && !state.busy && (
        <p className="rounded bg-amber-50 p-2 text-xs text-amber-700">{warningHe}</p>
      )}
    </div>
  );
}

/** Grayscale preview of the smart-relief height field (taller = brighter). */
function DepthPreview({ options }: { options: ImageImportOptionsValue }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { aiDepth, aiMask, maskWithSegmentation, depthInvert } = options;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !aiDepth) return;
    const grid = depthToReliefGrid(aiDepth.map, aiDepth.width, aiDepth.height, {
      gridWidth: aiDepth.width,
      gridHeight: aiDepth.height,
      mask:
        maskWithSegmentation && aiMask
          ? { map: aiMask.map, width: aiMask.width, height: aiMask.height }
          : null,
    });
    canvas.width = grid.width;
    canvas.height = grid.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(grid.width, grid.height);
    for (let i = 0; i < grid.values.length; i++) {
      // The grid stores lum = 1 − height; show height, honouring the flip.
      const height = depthInvert ? grid.values[i] : 1 - grid.values[i];
      const v = Math.round(height * 255);
      image.data[i * 4] = v;
      image.data[i * 4 + 1] = v;
      image.data[i * 4 + 2] = v;
      image.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }, [aiDepth, aiMask, maskWithSegmentation, depthInvert]);
  if (!aiDepth) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-slate-500">תצוגה מקדימה של גובה התבליט (בהיר = גבוה)</span>
      <canvas
        ref={canvasRef}
        data-testid="depth-preview-canvas"
        aria-label="תצוגה מקדימה של מפת העומק"
        className="w-full max-w-xs rounded border border-slate-300 bg-white"
        style={{ imageRendering: "pixelated" }}
      />
    </div>
  );
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
  const aiMask = options.aiMask;
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

  // Before the model has run there is nothing honest to preview — the
  // classic thresholded view would be a lie about what "צור גוף" will do.
  // Derived, not set: the canvas is simply not shown while this holds.
  const aiPending = thresholdMode === "ai" && !aiMask;

  useEffect(() => {
    if (aiPending) return;
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
          // In AI mode the decode only supplies the grid DIMENSIONS; the
          // values are the segmentation mask, exactly as at import time.
          const base =
            thresholdMode === "ai" && aiMask
              ? saliencyToMaskGrid(
                  aiMask.map,
                  aiMask.width,
                  aiMask.height,
                  decoded.grid.width,
                  decoded.grid.height
                )
              : decoded.grid;
          setGrid(smoothGrid(base, smoothingLevel));
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
    thresholdMode,
    aiMask,
    aiPending,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !grid) return;
    // The same threshold the import will compute from the same grid. The AI
    // grid encodes the mask around 0.5 with invert always off.
    const effective =
      thresholdMode === "ai"
        ? AI_MASK_THRESHOLD
        : thresholdMode === "auto"
          ? otsuThreshold(grid)
          : threshold;
    const effectiveInvert = thresholdMode === "ai" ? false : invert;
    const painted = applyMaskStrokes(grid, maskStrokes, {
      threshold: effective,
      invert: effectiveInvert,
    });
    canvas.width = painted.width;
    canvas.height = painted.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(painted.width, painted.height);
    for (let i = 0; i < painted.values.length; i++) {
      const lum = painted.values[i];
      const inside = effectiveInvert ? lum > effective : lum < effective;
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
      {aiPending && (
        <p className="text-xs text-slate-500">
          הפעילו את הזיהוי החכם (AI) כדי לראות תצוגה מקדימה
        </p>
      )}
      {!aiPending && !grid && !errorHe && (
        <p className="text-xs text-slate-500">מכין תצוגה מקדימה…</p>
      )}
      {!aiPending && (
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
      )}
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

/** What the cloud mode needs to know about the server (Milestone B). */
export interface CloudModeAvailability {
  enabled: boolean;
  providerNameHe: string;
}

export function ImageImportDialog({
  open,
  file,
  fileName,
  cloudAvailability,
  onConfirm,
  onClose,
}: {
  open: boolean;
  file: File | null;
  fileName: string;
  /** null while the availability probe is in flight. */
  cloudAvailability: CloudModeAvailability | null;
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
    aiMask: null,
    aiDepth: null,
    depthInvert: false,
    maskWithSegmentation: true,
    cloudTargetSizeMm: 80,
  });
  const patch = useCallback(
    (p: Partial<ImageImportOptionsValue>) => setOptions((o) => ({ ...o, ...p })),
    []
  );

  const ai = useAiInference(file, patch);

  // AI results belong to ONE image — cleared the moment a different file
  // arrives (state adjustment derived from a prop change, done during
  // render, the same pattern NumberField uses).
  const [lastFile, setLastFile] = useState<File | null>(file);
  if (file !== lastFile) {
    setLastFile(file);
    if (options.aiMask || options.aiDepth) {
      setOptions((o) => ({ ...o, aiMask: null, aiDepth: null }));
    }
  }

  // Tear the AI worker down with the editor, mirroring useGeometryJobs.
  // Creation is deferred to the first run, so nothing is spun up for a user
  // who never touches the AI modes.
  useEffect(() => () => disposeAiWorker(), []);

  // Strokes belong to ONE image. The dialog is reused for every pick, so they
  // are dropped on the way out — leaving them would land them on unrelated
  // pixels of the next file. (The AI results are keyed to the file and are
  // cleared by useAiInference when it changes.) Every other setting is kept.
  const finish = (confirm: boolean) => {
    if (confirm) onConfirm(options);
    else onClose();
    patch({ maskStrokes: [] });
  };

  const cloudEnabled = cloudAvailability?.enabled === true;
  const aiSilhouette = options.mode === "silhouette" && options.thresholdMode === "ai";

  // The mask has to actually contain a subject for a confirm to mean
  // anything; a flat map or ~0%/~100% coverage is the model saying "nothing
  // here", and that is said out loud instead of traced into an empty error.
  const maskWarningHe = (() => {
    if (!options.aiMask) return null;
    const coverage = maskCoverage(options.aiMask.map);
    if (!options.aiMask.hasSignal || coverage < 0.005 || coverage > 0.995) {
      return "ה-AI לא זיהה נושא ברור בתמונה — נסו את המצב הקלאסי או ציירו ידנית על התצוגה המקדימה";
    }
    return null;
  })();
  const depthWarningHe =
    options.aiDepth && !options.aiDepth.hasSignal
      ? "מפת העומק שהתקבלה שטוחה — התבליט ייצא אחיד. נסו תמונה אחרת או את התבליט הקלאסי"
      : null;

  const confirmDisabled =
    (aiSilhouette && !options.aiMask) ||
    (options.mode === "smartRelief" && !options.aiDepth) ||
    (options.mode === "cloud" && !cloudEnabled);

  const confirmLabelHe = options.mode === "cloud" ? "צור מודל בענן" : "צור גוף";

  return (
    <Modal
      title="ייבוא תמונה (PNG/JPG)"
      open={open}
      onClose={() => finish(false)}
      wide
      footer={
        <>
          <ModalButton onClick={() => finish(false)}>ביטול</ModalButton>
          <ModalButton
            variant="primary"
            disabled={confirmDisabled}
            onClick={() => finish(true)}
          >
            {confirmLabelHe}
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
          { value: "smartRelief", label: "תבליט חכם (AI)" },
          {
            value: "cloud",
            label: "מודל מלא (AI, ענן)",
            disabled: !cloudEnabled,
            title: cloudEnabled
              ? "יצירת מודל תלת-ממדי מלא מהתמונה בשירות ענן"
              : cloudAvailability === null
                ? "בודק זמינות מול השרת…"
                : "יצירת מודל בענן אינה מוגדרת בשרת — חסר מפתח API (ראו .env.example)",
          },
        ]}
        onChange={(mode) => patch({ mode })}
      />
      {options.mode !== "cloud" && (
        <NumberField label="רוחב יעד" value={options.targetWidthMm} min={5} max={400} onChange={(targetWidthMm) => patch({ targetWidthMm })} />
      )}
      {options.mode === "silhouette" && (
        <>
          <ToggleGroup
            label="סף בהירות"
            value={options.thresholdMode}
            options={[
              { value: "auto", label: "אוטומטי" },
              { value: "ai", label: "אוטומטי חכם (AI)" },
              { value: "manual", label: "ידני" },
            ]}
            onChange={(thresholdMode) => patch({ thresholdMode })}
          />
          {options.thresholdMode === "manual" && (
            <NumberField label="ערך הסף" value={options.threshold} min={0.05} max={0.95} step={0.05} unit="" onChange={(threshold) => patch({ threshold })} />
          )}
          {options.thresholdMode === "auto" && (
            <p className="text-xs text-slate-500">
              הסף מחושב מהתמונה עצמה (שיטת Otsu) ברגע הייבוא, ונשמר בשכבה.
              עברו ל״ידני״ אם ההפרדה שיצאה אינה מה שרציתם.
            </p>
          )}
          {options.thresholdMode === "ai" && (
            <AiRunControls
              specs={[AI_MODELS.segmentation]}
              state={ai.state}
              hasResult={options.aiMask !== null}
              provider={options.aiMask?.provider ?? null}
              runLabelHe="זהה את הנושא (AI)"
              onRun={() => void ai.run(["segmentImage"])}
              onCancel={ai.cancel}
              warningHe={maskWarningHe}
            />
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
      )}
      {options.mode === "relief" && (
        <>
          <NumberField label="גובה תבליט" value={options.reliefHeightMm} min={0.2} max={30} step={0.2} onChange={(reliefHeightMm) => patch({ reliefHeightMm })} />
          <NumberField label="עובי מינימלי" value={options.minThicknessMm} min={0.4} max={20} step={0.2} onChange={(minThicknessMm) => patch({ minThicknessMm })} />
        </>
      )}
      {options.mode === "smartRelief" && (
        <>
          <AiRunControls
            specs={
              options.maskWithSegmentation
                ? [AI_MODELS.depth, AI_MODELS.segmentation]
                : [AI_MODELS.depth]
            }
            state={ai.state}
            hasResult={options.aiDepth !== null}
            provider={options.aiDepth?.provider ?? null}
            runLabelHe="חשב מפת עומק (AI)"
            onRun={() =>
              void ai.run(
                options.maskWithSegmentation
                  ? ["estimateDepth", "segmentImage"]
                  : ["estimateDepth"]
              )
            }
            onCancel={ai.cancel}
            warningHe={depthWarningHe}
          />
          <NumberField label="גובה תבליט" value={options.reliefHeightMm} min={0.2} max={30} step={0.2} onChange={(reliefHeightMm) => patch({ reliefHeightMm })} />
          <NumberField label="עובי בסיס" value={options.minThicknessMm} min={0.4} max={20} step={0.2} onChange={(minThicknessMm) => patch({ minThicknessMm })} />
          <label className="flex items-center justify-between text-sm">
            <span className="text-slate-600">היפוך עומק (מצב ליתופן — הקרוב נמוך)</span>
            <input
              type="checkbox"
              checked={options.depthInvert}
              onChange={(e) => patch({ depthInvert: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between text-sm">
            <span className="text-slate-600">בידוד הנושא מהרקע (מודל זיהוי נושא)</span>
            <input
              type="checkbox"
              checked={options.maskWithSegmentation}
              onChange={(e) => {
                // A mask computed later still applies; requiring a re-run
                // here keeps "what you previewed" and "what you get" equal.
                patch({ maskWithSegmentation: e.target.checked });
              }}
            />
          </label>
          {options.maskWithSegmentation && options.aiDepth && !options.aiMask && (
            <p className="rounded bg-amber-50 p-2 text-xs text-amber-700">
              מסכת הנושא טרם חושבה — הריצו את ה-AI מחדש כדי שהרקע יוסר.
            </p>
          )}
          <DepthPreview options={options} />
        </>
      )}
      {options.mode === "cloud" && (
        <>
          <NumberField
            label="גודל יעד"
            value={options.cloudTargetSizeMm}
            min={10}
            max={300}
            onChange={(cloudTargetSizeMm) => patch({ cloudTargetSizeMm })}
          />
          <p className="text-xs text-slate-500">
            השירות בענן מחזיר מודל ללא קנה מידה פיזי, ולכן הגוף ייקבע כך שצידו
            הארוך במישור ההדפסה יהיה ״גודל יעד״. יצירה אורכת בדרך כלל דקה עד
            שלוש דקות; המרקם והצבעים אינם מיובאים — גאומטריה בלבד.
          </p>
        </>
      )}
      {(options.mode === "silhouette" || options.mode === "relief") && (
        <>
          {!(options.mode === "silhouette" && options.thresholdMode === "ai") && (
            <label className="flex items-center justify-between text-sm">
              <span className="text-slate-600">היפוך (בהיר ↔ כהה)</span>
              <input
                type="checkbox"
                checked={options.invert}
                onChange={(e) => patch({ invert: e.target.checked })}
              />
            </label>
          )}
        </>
      )}
      {options.mode !== "cloud" && (
        <>
          <NumberField label="רזולוציה" value={options.resolution} min={32} max={512} step={16} unit="px" onChange={(resolution) => patch({ resolution })} />
          <NumberField label="רמת החלקה" value={options.smoothingLevel} min={0} max={5} step={1} unit="" onChange={(smoothingLevel) => patch({ smoothingLevel: Math.round(smoothingLevel) })} />
        </>
      )}
      {(options.mode === "silhouette" || options.mode === "relief") &&
        !(options.mode === "silhouette" && options.thresholdMode === "ai") && (
          <>
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
          </>
        )}
      {options.mode !== "cloud" && (
        <p className="text-xs text-slate-500">
          צללית: אזורים כהים (או הנושא שה-AI זיהה) הופכים לגוף שטוח. תבליט: גוף
          סגור שגובהו משתנה לפי בהירות. תבליט חכם: הגובה נקבע לפי עומק משוער
          מהתמונה — קרוב יותר גבוה יותר.
        </p>
      )}
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
