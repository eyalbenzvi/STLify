"use client";

/**
 * "הדפסה רב-צבעית" — colour/material slots, per-layer assignments overview,
 * inlay clearance, and honest explanations of what STL can and cannot store.
 */

import type { ColorMaterial, DesignState } from "@/types/design";
import { layerOperation } from "@/types/design";
import { updateState, useEditorStore } from "@/lib/design/store";
import { effectiveLimits, MATERIAL_PRESETS } from "@/lib/design/defaults";
import { NumberField } from "@/components/ui/NumberField";

export function MultiColorPanel() {
  const { state } = useEditorStore();
  const mc = state.settings.multiColor;
  const limits = effectiveLimits(state.settings);

  const setMultiColor = (patch: Partial<DesignState["settings"]["multiColor"]>, key?: string): void => {
    updateState(
      (s) => ({ ...s, settings: { ...s.settings, multiColor: { ...s.settings.multiColor, ...patch } } }),
      { coalesceKey: key ?? null }
    );
  };

  const patchSlot = (index: number, patch: Partial<ColorMaterial>, key?: string): void => {
    const slots = mc.slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot));
    setMultiColor({ slots }, key);
  };

  const usedSlots = new Set(
    state.doc.layers.filter((l) => l.visible && layerOperation(l) === "add").map((l) => l.colorSlot)
  );

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="font-bold text-slate-700">הדפסה רב-צבעית</span>
        <input
          type="checkbox"
          className="size-4 accent-blue-600"
          checked={mc.enabled}
          onChange={(e) => setMultiColor({ enabled: e.target.checked })}
        />
      </label>

      <p className="rounded-md bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-800">
        קובץ STL אינו שומר מידע על צבעים. להדפסה רב-צבעית מייצאים חלקים נפרדים
        (ZIP של קובצי STL) או קובץ 3MF, ומדפיסים כל חלק בצבע/חומר משלו — או
        במדפסת רב-חומרים.
      </p>

      {mc.enabled && (
        <>
          <div className="flex flex-col gap-2">
            {mc.slots.map((slot, i) => {
              const layersInSlot = state.doc.layers.filter(
                (l) => l.visible && l.colorSlot === i && layerOperation(l) === "add"
              );
              return (
                <div key={i} className="rounded-lg border border-slate-200 p-2.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={`צבע משבצת ${i + 1}`}
                      className="h-7 w-9 cursor-pointer rounded border border-slate-300"
                      value={slot.colorHex}
                      onChange={(e) => patchSlot(i, { colorHex: e.target.value }, `slot:${i}:c`)}
                    />
                    <input
                      type="text"
                      dir="rtl"
                      aria-label={`שם משבצת ${i + 1}`}
                      className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                      value={slot.name}
                      onChange={(e) => patchSlot(i, { name: e.target.value }, `slot:${i}:n`)}
                    />
                    <select
                      aria-label="סוג חומר"
                      className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-xs"
                      value={slot.materialType}
                      onChange={(e) => patchSlot(i, { materialType: e.target.value })}
                    >
                      {MATERIAL_PRESETS.map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    type="text"
                    dir="rtl"
                    placeholder="שם פילמנט (אופציונלי)"
                    aria-label="שם פילמנט"
                    className="mt-1.5 w-full rounded-md border border-slate-200 px-2 py-1 text-xs"
                    value={slot.filamentName}
                    onChange={(e) => patchSlot(i, { filamentName: e.target.value }, `slot:${i}:f`)}
                  />
                  <p className="mt-1 text-[11px] text-slate-400">
                    {layersInSlot.length > 0
                      ? `שכבות: ${layersInSlot.map((l) => l.name).join(", ")}`
                      : "אין שכבות במשבצת זו"}
                  </p>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-slate-500">
            בשימוש: {usedSlots.size} מתוך 4 צבעים. שיוך שכבה לצבע נעשה בפאנל
            המאפיינים של השכבה.
          </p>

          <NumberField
            label="מרווח שיבוץ (Inlay)"
            value={mc.inlayClearanceMm}
            min={0}
            max={1}
            step={0.05}
            onChange={(inlayClearanceMm) => setMultiColor({ inlayClearanceMm }, "clr")}
          />
          {mc.inlayClearanceMm < limits.recommendedClearanceMm * 0.5 && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              ⚠️ מרווח קטן מדי — החלק המשובץ עלול לא להיכנס לכיס. מומלץ{" "}
              {limits.recommendedClearanceMm} מ״מ.
            </p>
          )}
          {mc.inlayClearanceMm > 0.5 && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              ⚠️ מרווח גדול מדי — החלק המשובץ ירגיש רופף בכיס.
            </p>
          )}
          <p className="text-xs leading-relaxed text-slate-500">
            גישות עיצוב נתמכות: הבלטה על הבסיס (Overlay), חריטה (Recess), שיבוץ
            בגובה אחיד (Inlay — בחרו &quot;שיבוץ&quot; בשכבת טקסט/לוגו), וחלקים
            נפרדים להרכבה.
          </p>
        </>
      )}
    </div>
  );
}
