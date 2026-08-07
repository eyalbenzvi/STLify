"use client";

/**
 * Printer calibration panel.
 *
 * The tolerance coupon already existed; its result had nowhere to go. This is
 * where the measured number lands, and from here every fit in the document
 * derives — connectors, inlays, enclosures, threads and holes stop each
 * guessing separately.
 *
 * The panel shows the DERIVED values, not just the input, because the whole
 * proposition is "measure once, everything follows" and the user should be
 * able to see that happening.
 */

import type { CalibrationSettings } from "@/types/design";
import { makeCustomPrinter, type PrinterProfile } from "@/types/profiles";
import { clearanceForFit, DEFAULT_CALIBRATION } from "@/lib/geometry/calibration";
import { NumberField } from "@/components/ui/NumberField";

export interface CalibrationPanelProps {
  calibration: CalibrationSettings | undefined;
  onChange: (calibration: CalibrationSettings) => void;
  /** Opens the tolerance-coupon generator. */
  onGenerateCoupon: () => void;
}

export function CalibrationPanel({
  calibration,
  onChange,
  onGenerateCoupon,
}: CalibrationPanelProps) {
  const value = calibration ?? DEFAULT_CALIBRATION;
  const set = (patch: Partial<CalibrationSettings>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] leading-snug text-slate-400">
        הדפיסו את מבחן הסבולות פעם אחת, בדקו איזה חור מתאים לפין, והזינו את
        הערך כאן. כל המרווחים בתוכנה — מחברים, שיבוצים, מארזים והברגות —
        ייגזרו ממנו אוטומטית.
      </p>

      <button
        type="button"
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
        onClick={onGenerateCoupon}
      >
        צור מבחן סבולות להדפסה
      </button>

      <NumberField
        label="מרווח נמדד"
        value={value.measuredClearanceMm}
        min={0}
        max={2}
        step={0.05}
        unit="מ״מ"
        onChange={(measuredClearanceMm) => set({ measuredClearanceMm })}
      />

      <div className="rounded-md bg-slate-50 p-2 text-[11px] text-slate-600">
        <p className="mb-1 font-bold">מרווחים נגזרים:</p>
        <p>הרכבה נעה (מכסה, מגירה): {clearanceForFit(value, "sliding").toFixed(2)} מ״מ</p>
        <p>התאמה קרובה (פין מיישר): {clearanceForFit(value, "close").toFixed(2)} מ״מ</p>
        <p>
          לחיצה (press fit): {clearanceForFit(value, "press").toFixed(2)} מ״מ —
          חפיפה מכוונת
        </p>
      </div>

      <NumberField
        label="פיצוי חורים"
        value={value.holeCompensationMm}
        min={0}
        max={1}
        step={0.05}
        unit="מ״מ"
        onChange={(holeCompensationMm) => set({ holeCompensationMm })}
      />
      <p className="text-[11px] leading-snug text-slate-400">
        חור מודפס יוצא קטן מהמתוכנן. הערך הזה מגדיל את החור במודל כדי שהחור
        <b> בפועל</b> יימדד בדיוק כפי שהוגדר.
      </p>

      <NumberField
        label="פיצוי ״רגל פיל״"
        value={value.elephantFootCompensationMm}
        min={0}
        max={1}
        step={0.05}
        unit="מ״מ"
        onChange={(elephantFootCompensationMm) => set({ elephantFootCompensationMm })}
      />
      {value.elephantFootCompensationMm > 0 && (
        <NumberField
          label="גובה הדעיכה"
          value={value.elephantFootHeightMm}
          min={0.1}
          max={5}
          step={0.1}
          unit="מ״מ"
          onChange={(elephantFootHeightMm) => set({ elephantFootHeightMm })}
        />
      )}
      <p className="text-[11px] leading-snug text-slate-400">
        השכבות הראשונות נמעכות אל המשטח ומרחיבות את בסיס החלק. הפיצוי מכווץ
        אותן פנימה כדי שהחלק יישב ישר.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom printers
// ---------------------------------------------------------------------------

export interface CustomPrinterPanelProps {
  printers: PrinterProfile[];
  onChange: (printers: PrinterProfile[]) => void;
}

export function CustomPrinterPanel({ printers, onChange }: CustomPrinterPanelProps) {
  const update = (index: number, patch: Partial<PrinterProfile>) =>
    onChange(printers.map((p, i) => (i === index ? { ...p, ...patch } : p)));

  return (
    <div className="flex flex-col gap-2">
      {printers.length === 0 && (
        <p className="text-[11px] leading-snug text-slate-400">
          המדפסות המובנות מכסות מקרים נפוצים בלבד. הוסיפו את המדפסת שלכם כדי
          שבדיקות נפח ההדפסה והסידור על המשטח יהיו נכונות. ההגדרה נשמרת בתוך
          קובץ העיצוב.
        </p>
      )}
      {printers.map((printer, index) => (
        <div key={printer.id} className="rounded-md border border-slate-200 p-2">
          <div className="flex items-center gap-1">
            <input
              className="min-w-0 flex-1 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
              value={printer.nameHe}
              aria-label="שם המדפסת"
              onChange={(e) => update(index, { nameHe: e.target.value })}
            />
            <button
              type="button"
              aria-label={`מחיקת ${printer.nameHe}`}
              className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-500"
              onClick={() => onChange(printers.filter((_, i) => i !== index))}
            >
              מחק
            </button>
          </div>
          <div className="mt-1 flex flex-col gap-1">
            {(["x", "y", "z"] as const).map((axis) => (
              <NumberField
                key={axis}
                label={`נפח ${axis.toUpperCase()}`}
                value={printer.buildVolumeMm[axis]}
                min={1}
                max={2000}
                step={5}
                unit="מ״מ"
                onChange={(v) =>
                  update(index, {
                    buildVolumeMm: { ...printer.buildVolumeMm, [axis]: v },
                  })
                }
              />
            ))}
            <NumberField
              label="קוטר פיה"
              value={printer.nozzleDiameterMm ?? 0.4}
              min={0.05}
              max={2}
              step={0.05}
              unit="מ״מ"
              onChange={(nozzleDiameterMm) => update(index, { nozzleDiameterMm })}
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
        onClick={() =>
          onChange([
            ...printers,
            // Through the factory, so the "resin printers have no nozzle"
            // rule and the dimension floors apply here too.
            makeCustomPrinter({
              id: `custom_${printers.length + 1}_${Math.random().toString(36).slice(2, 8)}`,
              nameHe: `המדפסת שלי ${printers.length + 1}`,
              buildVolumeMm: { x: 220, y: 220, z: 250 },
              nozzleDiameterMm: 0.4,
              defaultLayerHeightMm: 0.2,
            }),
          ])
        }
      >
        + מדפסת מותאמת
      </button>
    </div>
  );
}
