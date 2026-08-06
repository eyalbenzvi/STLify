"use client";

/**
 * The V2 editor shell: header actions (new / open / save / share / export /
 * undo / redo), session-only notice, tabbed side panel (design, colours,
 * validation, cost) and the 3D viewer. All design state lives in the
 * in-memory store — nothing is persisted anywhere.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addLayer,
  redo,
  replaceState,
  selectLayer,
  undo,
  updateDoc,
  updateLayer,
  useEditorStore,
} from "@/lib/design/store";
import { createHoleLayer, createTextLayer, defaultSettings } from "@/lib/design/defaults";
import { getProductTemplate, PRODUCT_TEMPLATES } from "@/lib/design/templates";
import { decodeShareHash } from "@/lib/serialization/shareLink";
import { PortableImportError } from "@/lib/serialization/portable";
import { useDesignBuilder } from "@/hooks/useDesignBuilder";
import { LayerPanel } from "@/components/layers/LayerPanel";
import { LayerProperties } from "@/components/editor/LayerProperties";
import type { PartBounds } from "@/components/editor/TransformControls";
import { MultiColorPanel } from "@/components/editor/MultiColorPanel";
import { ValidationPanelV2 } from "@/components/editor/ValidationPanelV2";
import { EstimatePanel } from "@/components/editor/EstimatePanel";
import { TemplateGallery } from "@/components/templates/TemplateGallery";
import { SvgImportDialog } from "@/components/dialogs/SvgImportDialog";
import { ImageImportDialog } from "@/components/dialogs/ImageImportDialog";
import { ExportDialog } from "@/components/dialogs/ExportDialog";
import { ShareDialog } from "@/components/dialogs/ShareDialog";
import { NewDesignDialog } from "@/components/dialogs/NewDesignDialog";
import { OpenDesignDialog } from "@/components/dialogs/OpenDesignDialog";
import { Section } from "@/components/ui/Section";

const DesignViewer = dynamic(
  () => import("@/components/viewer/DesignViewer").then((m) => m.DesignViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        טוען תצוגה תלת־ממדית…
      </div>
    ),
  }
);

type SideTab = "design" | "colors" | "check" | "cost";
type DialogId =
  | "templates"
  | "svgImport"
  | "imageImport"
  | "export"
  | "share"
  | "new"
  | "open"
  | null;

const SESSION_NOTICE =
  "העיצוב נשמר זמנית בדפדפן בלבד. רענון הדף או סגירתו עלולים למחוק שינויים. כדי לשמור להמשך עבודה, הורד קובץ עיצוב.";

export function Editor() {
  const store = useEditorStore();
  const builder = useDesignBuilder(store.state);
  const [tab, setTab] = useState<SideTab>("design");
  const [dialog, setDialog] = useState<DialogId>(null);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const [shareLoadMessage, setShareLoadMessage] = useState<string | null>(null);

  const selectedLayer =
    store.state.doc.layers.find((l) => l.id === store.selectedLayerId) ?? null;

  // Initial load: share-link hash, or the default name-plate template. The
  // work runs in a microtask so the effect body itself stays side-effect-
  // light (and message state updates never cascade a sync re-render).
  useEffect(() => {
    queueMicrotask(() => {
      const hash = window.location.hash;
      if (hash.startsWith("#d=")) {
        try {
          const shared = decodeShareHash(hash);
          if (shared) {
            replaceState(shared);
            setShareLoadMessage(
              "נטען עיצוב מקישור שיתוף. העיצוב קיים רק בזיכרון הדפדפן — שמרו אותו לקובץ כדי להמשיך לערוך בעתיד."
            );
          }
        } catch (err) {
          setShareLoadMessage(
            err instanceof PortableImportError
              ? err.messageHe
              : "טעינת הקישור נכשלה — נפתח עיצוב חדש"
          );
          replaceState({ doc: getProductTemplate("namePlate").create(), settings: defaultSettings() });
        }
        // The design now lives in memory; drop the hash so edits and refreshes
        // don't silently reload stale link data (no persistence either way).
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } else {
        replaceState({ doc: getProductTemplate("namePlate").create(), settings: defaultSettings() });
      }
    });
  }, []);

  // Keyboard shortcuts: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (inField) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // XY bounds per built part, for alignment / fit-to-base.
  const partBounds = useMemo(() => {
    const map = new Map<string, PartBounds>();
    for (const part of builder.parts) {
      part.geometry.computeBoundingBox();
      const box = part.geometry.boundingBox;
      if (box) {
        map.set(part.layerId, {
          min: { x: box.min.x, y: box.min.y },
          max: { x: box.max.x, y: box.max.y },
        });
      }
    }
    return map;
  }, [builder.parts]);

  const addText = useCallback(() => {
    addLayer(createTextLayer());
  }, []);

  const addHole = useCallback(() => {
    addLayer(createHoleLayer());
  }, []);

  const resetTemplateColors = useCallback(() => {
    const template = PRODUCT_TEMPLATES.find((t) => t.id === store.state.doc.templateId);
    if (!template) return;
    const fresh = template.create();
    const byType = new Map<string, string[]>();
    for (const layer of fresh.layers) {
      const list = byType.get(layer.type) ?? [];
      list.push(layer.colorHex);
      byType.set(layer.type, list);
    }
    const counters = new Map<string, number>();
    for (const layer of store.state.doc.layers) {
      const colors = byType.get(layer.type);
      if (!colors || colors.length === 0) continue;
      const idx = counters.get(layer.type) ?? 0;
      counters.set(layer.type, idx + 1);
      updateLayer(layer.id, { colorHex: colors[Math.min(idx, colors.length - 1)] }, { coalesceKey: "reset-colors" });
    }
  }, [store.state.doc]);

  const issues = builder.result?.issues ?? [];
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return (
    <div className="flex h-dvh flex-col bg-slate-100">
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5 shadow-sm">
        <h1 className="text-base font-bold text-slate-800">Printable Product Studio</h1>
        <input
          type="text"
          dir="rtl"
          placeholder="שם העיצוב (אופציונלי)"
          aria-label="שם העיצוב"
          className="w-44 rounded-md border border-slate-200 px-2 py-1 text-sm outline-none focus:border-blue-400"
          value={store.state.doc.title}
          onChange={(e) => updateDoc((doc) => ({ ...doc, title: e.target.value }), { coalesceKey: "title" })}
        />

        <div className="flex items-center gap-1">
          <HeaderButton onClick={undo} disabled={!store.canUndo} label="ביטול (Ctrl+Z)">
            ↶
          </HeaderButton>
          <HeaderButton onClick={redo} disabled={!store.canRedo} label="חזרה (Ctrl+Shift+Z)">
            ↷
          </HeaderButton>
        </div>

        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          <HeaderAction onClick={() => setDialog("new")}>עיצוב חדש</HeaderAction>
          <HeaderAction onClick={() => setDialog("open")}>פתיחת עיצוב מקובץ</HeaderAction>
          <HeaderAction onClick={() => setDialog("share")}>שיתוף עיצוב כקובץ</HeaderAction>
          <button
            type="button"
            className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
            onClick={() => setDialog("export")}
          >
            ייצוא ⬇
          </button>
        </div>
      </header>

      {!noticeDismissed && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800">
          <span aria-hidden>ℹ️</span>
          <p className="flex-1">{SESSION_NOTICE}</p>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-amber-700 underline hover:text-amber-900"
            onClick={() => setDialog("export")}
          >
            שמירת עיצוב לקובץ
          </button>
          <button
            type="button"
            aria-label="סגירת ההודעה"
            className="rounded p-1 text-amber-500 hover:text-amber-800"
            onClick={() => setNoticeDismissed(true)}
          >
            ✕
          </button>
        </div>
      )}

      {shareLoadMessage && (
        <div className="flex items-center gap-2 border-b border-blue-200 bg-blue-50 px-4 py-1.5 text-xs text-blue-800">
          <p className="flex-1">{shareLoadMessage}</p>
          <button
            type="button"
            aria-label="סגירה"
            className="rounded p-1 text-blue-400 hover:text-blue-700"
            onClick={() => setShareLoadMessage(null)}
          >
            ✕
          </button>
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        {/* Side panel (start side = right in RTL). */}
        <aside className="flex max-h-[55dvh] w-full flex-col border-t border-slate-200 bg-white lg:max-h-none lg:w-[26rem] lg:border-e lg:border-t-0">
          <nav className="flex border-b border-slate-200" role="tablist" aria-label="פאנלים">
            <TabButton active={tab === "design"} onClick={() => setTab("design")}>
              עיצוב
            </TabButton>
            <TabButton active={tab === "colors"} onClick={() => setTab("colors")}>
              צבעים
            </TabButton>
            <TabButton active={tab === "check"} onClick={() => setTab("check")}>
              בדיקת הדפסה
              {errorCount > 0 ? (
                <span className="ms-1 rounded-full bg-red-100 px-1.5 text-[10px] text-red-700">{errorCount}</span>
              ) : warningCount > 0 ? (
                <span className="ms-1 rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-700">{warningCount}</span>
              ) : null}
            </TabButton>
            <TabButton active={tab === "cost"} onClick={() => setTab("cost")}>
              עלות וזמן
            </TabButton>
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "design" && (
              <>
                <Section title="תבנית מוצר">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm hover:border-blue-300 hover:bg-slate-50"
                    onClick={() => setDialog("templates")}
                  >
                    <span>
                      <span className="me-2" aria-hidden>
                        {getProductTemplate(store.state.doc.templateId).icon}
                      </span>
                      {getProductTemplate(store.state.doc.templateId).nameHe}
                    </span>
                    <span className="text-xs text-blue-600">החלפת תבנית ›</span>
                  </button>
                </Section>

                <Section title="הוספת שכבה">
                  <div className="grid grid-cols-2 gap-1.5">
                    <AddButton onClick={addText}>＋ טקסט</AddButton>
                    <AddButton onClick={() => setDialog("svgImport")}>＋ העלאת לוגו SVG</AddButton>
                    <AddButton onClick={() => setDialog("imageImport")}>＋ העלאת תמונה</AddButton>
                    <AddButton onClick={addHole}>＋ חור / כיס</AddButton>
                  </div>
                </Section>

                <Section title="שכבות">
                  <LayerPanel />
                </Section>

                {selectedLayer && (
                  <Section title={`מאפייני "${selectedLayer.name}"`}>
                    <LayerProperties
                      layer={selectedLayer}
                      bounds={partBounds.get(selectedLayer.id) ?? null}
                    />
                  </Section>
                )}
                {!selectedLayer && (
                  <p className="px-4 py-3 text-xs text-slate-400">
                    בחרו שכבה מהרשימה או לחצו על חלק בתצוגה התלת־ממדית כדי לערוך אותו.
                  </p>
                )}
              </>
            )}

            {tab === "colors" && (
              <>
                <Section title="צבעי תצוגה">
                  <p className="rounded-md bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-800">
                    צבעים בתצוגה אינם נשמרים בקובץ STL. לייצוא רב-צבעי יש לבחור
                    חלקים נפרדים או 3MF.
                  </p>
                  <p className="text-xs text-slate-500">
                    בחירת צבע לשכבה נעשית בלשונית &quot;עיצוב&quot; תחת מאפייני השכבה.
                    אפשרויות מראה החומר (מט/מבריק/מתכתי) נמצאות בתצוגה
                    התלת־ממדית והן לתצוגה בלבד.
                  </p>
                  <button
                    type="button"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                    onClick={resetTemplateColors}
                  >
                    איפוס לצבעי התבנית
                  </button>
                </Section>
                <Section title="הדפסה רב-צבעית">
                  <MultiColorPanel />
                </Section>
              </>
            )}

            {tab === "check" && (
              <Section title="בדיקת הדפסה">
                <ValidationPanelV2 builder={builder} />
              </Section>
            )}

            {tab === "cost" && (
              <Section title="עלות משוערת">
                <EstimatePanel builder={builder} />
              </Section>
            )}
          </div>
        </aside>

        {/* 3D preview. */}
        <section className="relative min-h-[45dvh] flex-1">
          <DesignViewer
            parts={builder.parts}
            selectedLayerId={store.selectedLayerId}
            building={builder.status === "building"}
            buildPlateMm={{
              x: store.state.settings.estimate.printer.buildVolumeMm.x,
              y: store.state.settings.estimate.printer.buildVolumeMm.y,
            }}
            onSelectLayer={(layerId) => selectLayer(layerId)}
          />
          {builder.result?.mesh && (
            <div
              className="pointer-events-none absolute bottom-3 start-3 rounded-md bg-white/85 px-3 py-1.5 font-mono text-xs text-slate-700 shadow-sm"
              dir="ltr"
            >
              {builder.result.mesh.dimensionsMm.x} × {builder.result.mesh.dimensionsMm.y} ×{" "}
              {builder.result.mesh.dimensionsMm.z} mm
            </div>
          )}
          {getProductTemplate(store.state.doc.templateId).noteHe && (
            <div className="pointer-events-none absolute bottom-3 end-3 max-w-72 rounded-md bg-amber-50/95 px-3 py-1.5 text-xs text-amber-800 shadow-sm">
              {getProductTemplate(store.state.doc.templateId).noteHe}
            </div>
          )}
        </section>
      </main>

      <TemplateGallery open={dialog === "templates"} onClose={() => setDialog(null)} />
      <SvgImportDialog open={dialog === "svgImport"} onClose={() => setDialog(null)} />
      <ImageImportDialog open={dialog === "imageImport"} onClose={() => setDialog(null)} />
      <ExportDialog open={dialog === "export"} builder={builder} onClose={() => setDialog(null)} />
      <ShareDialog open={dialog === "share"} onClose={() => setDialog(null)} />
      <NewDesignDialog open={dialog === "new"} onClose={() => setDialog(null)} />
      <OpenDesignDialog open={dialog === "open"} onClose={() => setDialog(null)} />
    </div>
  );
}

function HeaderButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="grid size-8 place-items-center rounded-md border border-slate-200 text-base text-slate-600 hover:bg-slate-50 disabled:opacity-30"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function HeaderAction({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-50"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TabButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`flex-1 border-b-2 px-2 py-2 text-sm transition-colors ${
        active
          ? "border-blue-600 font-bold text-blue-700"
          : "border-transparent text-slate-500 hover:text-slate-800"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function AddButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded-md border border-dashed border-slate-300 bg-white px-2 py-2 text-xs text-slate-600 hover:border-blue-400 hover:text-blue-700"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
