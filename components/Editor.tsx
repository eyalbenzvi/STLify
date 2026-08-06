"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import { BaseControls } from "@/components/editor/BaseControls";
import { HoleControls } from "@/components/editor/HoleControls";
import { MaterialControls } from "@/components/editor/MaterialControls";
import { TemplatePicker } from "@/components/editor/TemplatePicker";
import { TextControls } from "@/components/editor/TextControls";
import { ValidationPanel } from "@/components/editor/ValidationPanel";
import { Section } from "@/components/ui/Section";
import { useModelBuilder } from "@/hooks/useModelBuilder";
import { downloadBlob, geometryToBinaryStl } from "@/lib/export/stl";
import { getTemplateParams, SAMPLE_DESIGN } from "@/lib/geometry/templates";
import type {
  BaseParams,
  DesignParams,
  HoleParams,
  TemplateId,
  TextParams,
} from "@/lib/geometry/types";

// react-three-fiber requires the browser; skip server rendering entirely.
const ModelViewer = dynamic(
  () => import("@/components/viewer/ModelViewer").then((m) => m.ModelViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        טוען תצוגה תלת־ממדית…
      </div>
    ),
  }
);

/** The single-page editor: controls panel + live 3D preview. */
export function Editor() {
  const [params, setParams] = useState<DesignParams>(() =>
    structuredClone(SAMPLE_DESIGN)
  );
  const { status, geometry, stats, issues } = useModelBuilder(params);

  const selectTemplate = useCallback((id: TemplateId) => {
    setParams(getTemplateParams(id));
  }, []);

  const resetDesign = useCallback(() => {
    setParams((prev) => getTemplateParams(prev.template));
  }, []);

  const updateText = useCallback((patch: Partial<TextParams>) => {
    setParams((prev) => ({ ...prev, text: { ...prev.text, ...patch } }));
  }, []);

  const updateBase = useCallback((patch: Partial<BaseParams>) => {
    setParams((prev) => ({ ...prev, base: { ...prev.base, ...patch } }));
  }, []);

  const updateHole = useCallback((patch: Partial<HoleParams>) => {
    setParams((prev) => ({ ...prev, hole: { ...prev.hole, ...patch } }));
  }, []);

  const canDownload = status === "ok" && geometry !== null;

  const downloadStl = useCallback(() => {
    if (!geometry) return;
    const blob = geometryToBinaryStl(geometry);
    downloadBlob(blob, `printcraft-${params.template}.stl`);
  }, [geometry, params.template]);

  return (
    <div className="flex h-dvh flex-col bg-slate-100">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        <h1 className="text-lg font-bold text-slate-800">
          PrintCraft STL Studio
        </h1>
        <p className="hidden text-xs text-slate-500 sm:block">
          קובץ STL הוא קובץ מודל תלת־ממדי; לפני ההדפסה יש להעביר אותו חיתוך
          (Slicing) בתוכנת ההדפסה.
        </p>
        <div className="ms-auto flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-50"
            onClick={resetDesign}
          >
            איפוס עיצוב
          </button>
          <button
            type="button"
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            disabled={!canDownload}
            onClick={downloadStl}
          >
            הורדת STL ⬇
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        {/* Controls panel (start side = right in RTL). */}
        <aside className="max-h-[55dvh] w-full overflow-y-auto border-t border-slate-200 bg-white lg:max-h-none lg:w-96 lg:border-e lg:border-t-0">
          <Section title="תבנית">
            <TemplatePicker value={params.template} onChange={selectTemplate} />
          </Section>
          <Section title="טקסט">
            <TextControls value={params.text} onChange={updateText} />
          </Section>
          <Section title="בסיס">
            <BaseControls value={params.base} onChange={updateBase} />
          </Section>
          <Section title="חור תלייה">
            <HoleControls value={params.hole} onChange={updateHole} />
          </Section>
          <Section title="תצוגה">
            <MaterialControls
              value={params.materialColor}
              onChange={(materialColor) =>
                setParams((prev) => ({ ...prev, materialColor }))
              }
            />
          </Section>
          <Section title="בדיקות תקינות">
            <ValidationPanel status={status} stats={stats} issues={issues} />
          </Section>
          <p className="px-4 py-3 text-xs leading-relaxed text-slate-400 sm:hidden">
            קובץ STL הוא קובץ מודל תלת־ממדי; לפני ההדפסה יש להעביר אותו חיתוך
            (Slicing) בתוכנת ההדפסה.
          </p>
        </aside>

        {/* 3D preview. */}
        <section className="relative min-h-[45dvh] flex-1">
          <ModelViewer
            geometry={geometry}
            color={params.materialColor}
            building={status === "building"}
          />
          {stats && (
            <div
              className="pointer-events-none absolute bottom-3 start-3 rounded-md bg-white/85 px-3 py-1.5 font-mono text-xs text-slate-700 shadow-sm"
              dir="ltr"
            >
              {stats.dimensionsMm.x} × {stats.dimensionsMm.y} ×{" "}
              {stats.dimensionsMm.z} mm
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
