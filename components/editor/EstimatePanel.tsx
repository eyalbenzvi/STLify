"use client";

/**
 * "עלות משוערת" + "זמן הדפסה משוער" — cost & time estimation with editable
 * printer/material assumptions and a transparent "how is this calculated"
 * section. Estimates only; the UI says so explicitly.
 */

import type { EstimateSettings, MaterialProfile, PrinterProfile } from "@/types/design";
import { updateState, useEditorStore } from "@/lib/design/store";
import { MATERIAL_PRESETS, PRINTER_PRESETS } from "@/lib/design/defaults";
import { estimateCost } from "@/lib/estimation/cost";
import { estimatePrintTime, formatMinutesHe } from "@/lib/estimation/time";
import type { DesignBuilderState } from "@/hooks/useDesignBuilder";
import { NumberField } from "@/components/ui/NumberField";

interface EstimatePanelProps {
  builder: DesignBuilderState;
}

export function EstimatePanel({ builder }: EstimatePanelProps) {
  const { state } = useEditorStore();
  const est = state.settings.estimate;
  const mesh = builder.result?.mesh ?? null;

  const patchEstimate = (patch: Partial<EstimateSettings>, key?: string): void => {
    updateState(
      (s) => ({ ...s, settings: { ...s.settings, estimate: { ...s.settings.estimate, ...patch } } }),
      { coalesceKey: key ?? null }
    );
  };
  const patchPrinter = (patch: Partial<PrinterProfile>, key?: string): void =>
    patchEstimate({ printer: { ...est.printer, ...patch } }, key);
  const patchMaterial = (patch: Partial<MaterialProfile>, key?: string): void =>
    patchEstimate({ material: { ...est.material, ...patch } }, key);

  if (!mesh) {
    return (
      <p className="text-sm text-slate-500">
        ההערכה תוצג לאחר שהמודל ייבנה בהצלחה.
      </p>
    );
  }

  const cost = estimateCost({
    modelVolumeMm3: mesh.volumeCm3 * 1000,
    boundsMm: mesh.dimensionsMm,
    settings: est,
  });
  const time = estimatePrintTime({
    modelVolumeMm3: mesh.volumeCm3 * 1000,
    materialVolumeMm3: cost.materialVolumeCm3 * 1000,
    boundsMm: mesh.dimensionsMm,
    settings: est,
  });

  const cur = cost.currency === "ILS" ? "₪" : cost.currency;
  const confidenceHe =
    time.confidence === "high" ? "גבוהה" : time.confidence === "medium" ? "בינונית" : "נמוכה";

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-md bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
        המחיר הוא הערכה בלבד. יש לבדוק זמן, משקל ותמיכות בתוכנת הסלייסר לפני
        תמחור סופי.
      </p>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-slate-50 p-3 text-xs">
        <dt className="text-slate-500">משקל חומר משוער</dt>
        <dd className="text-end font-mono" dir="ltr">{cost.materialWeightGrams} g</dd>
        <dt className="text-slate-500">עלות חומר</dt>
        <dd className="text-end font-mono" dir="ltr">{cur}{cost.materialCost}</dd>
        <dt className="text-slate-500">חשמל</dt>
        <dd className="text-end font-mono" dir="ltr">{cur}{cost.electricityCost}</dd>
        <dt className="text-slate-500">בלאי מכונה</dt>
        <dd className="text-end font-mono" dir="ltr">{cur}{cost.machineCost}</dd>
        <dt className="text-slate-500">עבודה + אריזה</dt>
        <dd className="text-end font-mono" dir="ltr">{cur}{(cost.laborCost + cost.packagingCost).toFixed(2)}</dd>
        <dt className="font-bold text-slate-700">סה״כ עלות</dt>
        <dd className="text-end font-mono font-bold" dir="ltr">{cur}{cost.totalCost}</dd>
        <dt className="text-slate-500">מחיר מוצע ({est.markupPercent}% רווח)</dt>
        <dd className="text-end font-mono text-emerald-700" dir="ltr">{cur}{cost.suggestedPriceMarkup}</dd>
        <dt className="text-slate-500">מחיר לפי מרווח יעד ({est.targetMarginPercent}%)</dt>
        <dd className="text-end font-mono text-emerald-700" dir="ltr">{cur}{cost.suggestedPriceMargin}</dd>
        <dt className="text-slate-500">רווח צפוי (לפי מחיר מוצע)</dt>
        <dd className="text-end font-mono" dir="ltr">
          {cur}{(cost.suggestedPriceMarkup - cost.totalCost).toFixed(2)}
        </dd>
      </dl>

      <div className="rounded-md border border-slate-200 p-3">
        <h3 className="mb-1 text-sm font-bold text-slate-700">זמן הדפסה משוער</h3>
        <p className="text-sm text-slate-800">
          {formatMinutesHe(time.printMinutesMin)} עד {formatMinutesHe(time.printMinutesMax)}
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <dt className="text-slate-500">שכבות (בקירוב)</dt>
          <dd className="text-end font-mono" dir="ltr">{time.layerCount.toLocaleString()}</dd>
          <dt className="text-slate-500">הכנה</dt>
          <dd className="text-end">{formatMinutesHe(time.setupMinutes)}</dd>
          <dt className="text-slate-500">עיבוד לאחר הדפסה</dt>
          <dd className="text-end">{formatMinutesHe(time.postProcessingMinutes)}</dd>
          <dt className="text-slate-500">סה״כ אספקה</dt>
          <dd className="text-end">
            {formatMinutesHe(time.totalMinutesMin)} – {formatMinutesHe(time.totalMinutesMax)}
          </dd>
          <dt className="text-slate-500">רמת ביטחון</dt>
          <dd className="text-end">{confidenceHe}</dd>
        </dl>
        <p className="mt-2 text-[11px] text-slate-400">
          ההערכה מבוססת על נתוני המודל והגדרות כלליות. יש לוודא זמן סופי בסלייסר.
        </p>
      </div>

      <details className="rounded-md border border-slate-200">
        <summary className="cursor-pointer px-3 py-2 text-sm font-bold text-slate-700">
          הגדרות מדפסת
        </summary>
        <div className="flex flex-col gap-2 px-3 pb-3">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="text-slate-600">פרופיל</span>
            <select
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
              value={est.printer.name}
              onChange={(e) => {
                const preset = PRINTER_PRESETS.find((p) => p.name === e.target.value);
                if (preset) patchEstimate({ printer: structuredClone(preset) });
              }}
            >
              {PRINTER_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
              {!PRINTER_PRESETS.some((p) => p.name === est.printer.name) && (
                <option value={est.printer.name}>{est.printer.name} (מותאם)</option>
              )}
            </select>
          </label>
          <NumberField label="נפח הדפסה X" value={est.printer.buildVolumeMm.x} min={10} max={2000} onChange={(x) => patchPrinter({ buildVolumeMm: { ...est.printer.buildVolumeMm, x } }, "bx")} />
          <NumberField label="נפח הדפסה Y" value={est.printer.buildVolumeMm.y} min={10} max={2000} onChange={(y) => patchPrinter({ buildVolumeMm: { ...est.printer.buildVolumeMm, y } }, "by")} />
          <NumberField label="נפח הדפסה Z" value={est.printer.buildVolumeMm.z} min={10} max={2000} onChange={(z) => patchPrinter({ buildVolumeMm: { ...est.printer.buildVolumeMm, z } }, "bz")} />
          {est.printer.technology === "FDM" && (
            <>
              <NumberField label="קוטר פיה" value={est.printer.nozzleDiameterMm} min={0.1} max={2} step={0.1} onChange={(nozzleDiameterMm) => patchPrinter({ nozzleDiameterMm }, "nz")} />
              <NumberField label="מהירות הדפסה" value={est.printer.printSpeedMmS} min={5} max={600} unit="mm/s" onChange={(printSpeedMmS) => patchPrinter({ printSpeedMmS }, "sp")} />
              <NumberField label="מילוי (Infill)" value={est.printer.infillPercent} min={0} max={100} unit="%" onChange={(infillPercent) => patchPrinter({ infillPercent }, "inf")} />
              <NumberField label="מספר דפנות" value={est.printer.wallCount} min={0} max={10} unit="" onChange={(wallCount) => patchPrinter({ wallCount: Math.round(wallCount) }, "wc")} />
              <NumberField label="שכבות עליון/תחתון" value={est.printer.topBottomLayers} min={0} max={20} unit="" onChange={(topBottomLayers) => patchPrinter({ topBottomLayers: Math.round(topBottomLayers) }, "tb")} />
            </>
          )}
          <NumberField label="גובה שכבה" value={est.printer.layerHeightMm} min={0.01} max={1} step={0.05} onChange={(layerHeightMm) => patchPrinter({ layerHeightMm }, "lh")} />
          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="text-slate-600">תמיכות</span>
            <input type="checkbox" className="size-4 accent-blue-600" checked={est.printer.supportsEnabled} onChange={(e) => patchPrinter({ supportsEnabled: e.target.checked })} />
          </label>
          <NumberField label="הספק מדפסת" value={est.printer.powerWatts} min={0} max={5000} unit="W" onChange={(powerWatts) => patchPrinter({ powerWatts }, "pw")} />
          <NumberField label="מחיר חשמל לקוט״ש" value={est.printer.electricityPricePerKwh} min={0} max={100} step={0.01} unit={cur} onChange={(electricityPricePerKwh) => patchPrinter({ electricityPricePerKwh }, "el")} />
        </div>
      </details>

      <details className="rounded-md border border-slate-200">
        <summary className="cursor-pointer px-3 py-2 text-sm font-bold text-slate-700">
          הגדרות חומר
        </summary>
        <div className="flex flex-col gap-2 px-3 pb-3">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="text-slate-600">חומר</span>
            <select
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
              value={est.material.name}
              onChange={(e) => {
                const preset = MATERIAL_PRESETS.find((m) => m.name === e.target.value);
                if (preset) patchEstimate({ material: structuredClone(preset) });
              }}
            >
              {MATERIAL_PRESETS.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="צפיפות" value={est.material.densityGCm3} min={0.5} max={25} step={0.01} unit="g/cm³" onChange={(densityGCm3) => patchMaterial({ densityGCm3 }, "dn")} />
          {est.material.name === "Resin" ? (
            <NumberField label="מחיר לליטר" value={est.material.costPerLitre} min={0} max={10000} unit={cur} onChange={(costPerLitre) => patchMaterial({ costPerLitre }, "cl")} />
          ) : (
            <NumberField label="מחיר לק״ג" value={est.material.costPerKg} min={0} max={10000} unit={cur} onChange={(costPerKg) => patchMaterial({ costPerKg }, "ck")} />
          )}
          <NumberField label="אחוז פחת" value={est.material.wastePercent} min={0} max={100} unit="%" onChange={(wastePercent) => patchMaterial({ wastePercent }, "wp")} />
          <NumberField label="חומר תמיכות" value={est.material.supportMaterialPercent} min={0} max={100} unit="%" onChange={(supportMaterialPercent) => patchMaterial({ supportMaterialPercent }, "sm")} />
        </div>
      </details>

      <details className="rounded-md border border-slate-200">
        <summary className="cursor-pointer px-3 py-2 text-sm font-bold text-slate-700">
          עלויות נוספות ותמחור
        </summary>
        <div className="flex flex-col gap-2 px-3 pb-3">
          <NumberField label="בלאי מכונה לשעה" value={est.machineOverheadPerHour} min={0} max={1000} step={0.5} unit={cur} onChange={(machineOverheadPerHour) => patchEstimate({ machineOverheadPerHour }, "mo")} />
          <NumberField label="עלות עבודה" value={est.laborCost} min={0} max={100000} unit={cur} onChange={(laborCost) => patchEstimate({ laborCost }, "lb")} />
          <NumberField label="אריזה" value={est.packagingCost} min={0} max={100000} unit={cur} onChange={(packagingCost) => patchEstimate({ packagingCost }, "pk")} />
          <NumberField label="זמן הכנה" value={est.setupMinutes} min={0} max={600} unit="דק'" onChange={(setupMinutes) => patchEstimate({ setupMinutes }, "su")} />
          <NumberField label="עיבוד לאחר הדפסה" value={est.postProcessingMinutes} min={0} max={600} unit="דק'" onChange={(postProcessingMinutes) => patchEstimate({ postProcessingMinutes }, "pp")} />
          <NumberField label="אחוז רווח (Markup)" value={est.markupPercent} min={0} max={1000} unit="%" onChange={(markupPercent) => patchEstimate({ markupPercent }, "mk")} />
          <NumberField label="מרווח יעד (Margin)" value={est.targetMarginPercent} min={0} max={95} unit="%" onChange={(targetMarginPercent) => patchEstimate({ targetMarginPercent }, "mg")} />
        </div>
      </details>

      <details className="rounded-md border border-slate-200">
        <summary className="cursor-pointer px-3 py-2 text-sm font-bold text-slate-700">
          איך חושב המחיר?
        </summary>
        <div className="px-3 pb-3 text-xs leading-relaxed text-slate-600">
          <ul className="list-inside list-disc space-y-1">
            <li>נפח המודל ({cost.modelVolumeCm3} cm³) נמדד מהגאומטריה עצמה.</li>
            <li>
              נפח החומר ({cost.materialVolumeCm3} cm³) מחושב לפי דפנות, שכבות
              עליונות/תחתונות ואחוז המילוי (FDM), בתוספת פחת
              {est.printer.supportsEnabled ? " ותמיכות" : ""}.
            </li>
            <li>משקל = נפח × צפיפות; עלות חומר = משקל × מחיר לק״ג (או נפח × מחיר לליטר בשרף).</li>
            <li>חשמל = הספק × זמן הדפסה ממוצע × תעריף.</li>
            <li>בלאי = שעות הדפסה × תעריף בלאי; בתוספת עבודה ואריזה.</li>
            <li>מחיר מוצע = עלות × (1 + אחוז רווח), או עלות ÷ (1 − מרווח יעד).</li>
          </ul>
        </div>
      </details>
    </div>
  );
}
