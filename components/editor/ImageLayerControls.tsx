"use client";

import { useState } from "react";
import type { ImageAdjustments, ImageReliefLayer } from "@/types/design";
import { updateLayer } from "@/lib/design/store";
import { estimateTriangleCount } from "@/lib/images/heightField";
import { NumberField } from "@/components/ui/NumberField";
import { SliderField } from "@/components/ui/SliderField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { RANGES_V2 } from "@/lib/geometry/validateDesign";
import { BackgroundRemovalDialog } from "@/components/dialogs/BackgroundRemovalDialog";
import { MaskEditorDialog } from "@/components/dialogs/MaskEditorDialog";
import { ImagePreviewCanvas } from "./ImagePreviewCanvas";

export function ImageLayerControls({ layer }: { layer: ImageReliefLayer }) {
  const r = RANGES_V2;
  const [bgDialogOpen, setBgDialogOpen] = useState(false);
  const [maskDialogOpen, setMaskDialogOpen] = useState(false);
  const patch = (p: Partial<ImageReliefLayer>, key?: string) =>
    updateLayer(layer.id, p, { coalesceKey: key ? `img:${layer.id}:${key}` : null });
  const adjust = (p: Partial<ImageAdjustments>, key: string) =>
    patch({ adjustments: { ...layer.adjustments, ...p } }, key);

  const setWidth = (widthMm: number): void => {
    if (layer.preserveAspect && layer.aspectRatio > 0) {
      patch({ widthMm, heightMm: round2(widthMm / layer.aspectRatio) }, "w");
    } else patch({ widthMm }, "w");
  };
  const setHeight = (heightMm: number): void => {
    if (layer.preserveAspect && layer.aspectRatio > 0) {
      patch({ heightMm, widthMm: round2(heightMm * layer.aspectRatio) }, "h");
    } else patch({ heightMm }, "h");
  };

  const estTris = estimateTriangleCount(layer);
  const a = layer.adjustments;

  return (
    <div className="flex flex-col gap-3">
      <ImagePreviewCanvas assetId={layer.assetId} adjustments={a} />

      <div className="flex flex-wrap gap-1.5">
        <SmallButton onClick={() => setBgDialogOpen(true)}>✨ הסרת רקע אוטומטית</SmallButton>
        <SmallButton onClick={() => setMaskDialogOpen(true)}>🖌 עריכת מסכה ידנית</SmallButton>
        <SmallButton onClick={() => adjust({ rotate90: (a.rotate90 + 1) % 4 }, "rot")}>
          ⟳ סיבוב 90°
        </SmallButton>
        <SmallButton onClick={() => adjust({ flipH: !a.flipH }, "flip")}>⇄ היפוך אופקי</SmallButton>
        <SmallButton onClick={() => adjust({ flipV: !a.flipV }, "flip")}>⇅ היפוך אנכי</SmallButton>
      </div>

      <details className="rounded-md border border-slate-200">
        <summary className="cursor-pointer px-3 py-2 text-sm font-bold text-slate-700">
          התאמות תמונה
        </summary>
        <div className="flex flex-col gap-2 px-3 pb-3">
          <SliderField label="בהירות" value={a.brightness} min={-100} max={100} onChange={(brightness) => adjust({ brightness }, "b")} />
          <SliderField label="ניגודיות" value={a.contrast} min={-100} max={100} onChange={(contrast) => adjust({ contrast }, "c")} />
          <SliderField label="סיבוב חופשי" value={a.freeRotationDeg} min={-45} max={45} onChange={(freeRotationDeg) => adjust({ freeRotationDeg }, "fr")} format={(v) => `${v}°`} />
          <SliderField label="טשטוש" value={a.blurPx} min={0} max={10} onChange={(blurPx) => adjust({ blurPx }, "blur")} />
          <SliderField
            label="רמות גוון"
            value={a.posterizeLevels}
            min={0}
            max={8}
            onChange={(posterizeLevels) =>
              adjust({ posterizeLevels: posterizeLevels === 1 ? 2 : posterizeLevels }, "post")
            }
            format={(v) => (v === 0 ? "כבוי" : String(v))}
          />
          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="text-slate-600">גווני אפור</span>
            <input type="checkbox" className="size-4 accent-blue-600" checked={a.grayscale} onChange={(e) => adjust({ grayscale: e.target.checked }, "gs")} />
          </label>
          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="text-slate-600">היפוך בהירות (נגטיב)</span>
            <input type="checkbox" className="size-4 accent-blue-600" checked={a.invert} onChange={(e) => adjust({ invert: e.target.checked }, "inv")} />
          </label>
          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="text-slate-600">סף שחור-לבן</span>
            <input
              type="checkbox"
              className="size-4 accent-blue-600"
              checked={a.threshold >= 0}
              onChange={(e) => adjust({ threshold: e.target.checked ? 128 : -1 }, "th")}
            />
          </label>
          {a.threshold >= 0 && (
            <SliderField label="ערך סף" value={a.threshold} min={0} max={255} onChange={(threshold) => adjust({ threshold }, "thv")} />
          )}

          <p className="pt-1 text-xs font-bold text-slate-600">חיתוך (Crop)</p>
          <SliderField label="ימין" value={Math.round(a.cropRight * 100)} min={0} max={45} onChange={(v) => adjust({ cropRight: v / 100 }, "crop")} format={(v) => `${v}%`} />
          <SliderField label="שמאל" value={Math.round(a.cropLeft * 100)} min={0} max={45} onChange={(v) => adjust({ cropLeft: v / 100 }, "crop")} format={(v) => `${v}%`} />
          <SliderField label="עליון" value={Math.round(a.cropTop * 100)} min={0} max={45} onChange={(v) => adjust({ cropTop: v / 100 }, "crop")} format={(v) => `${v}%`} />
          <SliderField label="תחתון" value={Math.round(a.cropBottom * 100)} min={0} max={45} onChange={(v) => adjust({ cropBottom: v / 100 }, "crop")} format={(v) => `${v}%`} />
        </div>
      </details>

      <NumberField label="רוחב" value={round2(layer.widthMm)} min={r.imageSizeMm.min} max={r.imageSizeMm.max} onChange={setWidth} />
      <NumberField label="גובה" value={round2(layer.heightMm)} min={r.imageSizeMm.min} max={r.imageSizeMm.max} onChange={setHeight} />
      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">שמירה על יחס גובה-רוחב</span>
        <input
          type="checkbox"
          className="size-4 accent-blue-600"
          checked={layer.preserveAspect}
          onChange={(e) => patch({ preserveAspect: e.target.checked })}
        />
      </label>

      <ToggleGroup
        label="סוג תבליט"
        value={layer.mode}
        options={[
          { value: "raised", label: "מובלט" },
          { value: "engraved", label: "חרוט" },
          { value: "silhouette", label: "צללית" },
        ]}
        onChange={(mode) => patch({ mode })}
      />
      {layer.mode !== "silhouette" && (
        <ToggleGroup
          label="מיפוי גוונים"
          value={layer.mapping}
          options={[
            { value: "darkHigh", label: "כהה = גבוה" },
            { value: "lightHigh", label: "בהיר = גבוה" },
          ]}
          onChange={(mapping) => patch({ mapping })}
        />
      )}
      <NumberField
        label="גובה מינימלי"
        value={layer.minHeightMm}
        min={r.reliefHeightMm.min}
        max={r.reliefHeightMm.max}
        step={0.1}
        onChange={(minHeightMm) => patch({ minHeightMm }, "minh")}
      />
      <NumberField
        label="גובה מקסימלי"
        value={layer.maxHeightMm}
        min={r.reliefHeightMm.min}
        max={r.reliefHeightMm.max}
        step={0.1}
        onChange={(maxHeightMm) => patch({ maxHeightMm }, "maxh")}
      />
      <SliderField
        label="סף שקיפות"
        value={layer.alphaThreshold}
        min={0}
        max={255}
        onChange={(alphaThreshold) => patch({ alphaThreshold }, "alpha")}
      />

      <ToggleGroup
        label="רזולוציה"
        value={layer.resolution}
        options={[
          { value: "draft", label: "טיוטה" },
          { value: "standard", label: "רגילה" },
          { value: "fine", label: "עדינה" },
        ]}
        onChange={(resolution) => patch({ resolution })}
      />
      <p className="text-xs text-slate-400" dir="rtl">
        כ-{estTris.toLocaleString()} משולשים ברזולוציה הנוכחית.
        {layer.resolution === "fine" &&
          " רזולוציה עדינה מכבידה על הדפדפן ומגדילה את קובץ ה-STL."}
      </p>

      <BackgroundRemovalDialog open={bgDialogOpen} layer={layer} onClose={() => setBgDialogOpen(false)} />
      <MaskEditorDialog open={maskDialogOpen} layer={layer} onClose={() => setMaskDialogOpen(false)} />
    </div>
  );
}

function SmallButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
    >
      {children}
    </button>
  );
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
