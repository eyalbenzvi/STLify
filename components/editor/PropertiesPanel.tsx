"use client";

/**
 * Per-layer properties: type-specific parameters (text, base, SVG, image,
 * imported mesh, hole), material slot, preview opacity and the numeric
 * transform editor.
 */

import type {
  BaseLayer,
  DesignDocument,
  DesignLayer,
  HoleLayer,
  ImageReliefLayer,
  ImportedMeshLayer,
  SketchLayer,
  SvgLayer,
  TextLayer,
} from "@/types/design";
import { PivotControls, PrimitiveProps, SketchProps } from "./PrimitiveProps";
import { FONTS, fontHasBold } from "@/lib/geometry/fonts";
import { PARAM_RANGES } from "@/lib/geometry/types";
import { getMesh } from "@/lib/geometry/meshStore";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { TransformPanel } from "./TransformPanel";

export interface PropertiesPanelProps {
  document: DesignDocument;
  layer: DesignLayer;
  onUpdate: (patch: Partial<DesignLayer>, labelHe: string) => void;
}

export function PropertiesPanel({ document, layer, onUpdate }: PropertiesPanelProps) {
  return (
    <div className="flex flex-col gap-3">
      {layer.type === "text" && <TextProps layer={layer} onUpdate={onUpdate} document={document} />}
      {layer.type === "base" && <BaseProps layer={layer} onUpdate={onUpdate} />}
      {layer.type === "svg" && <SvgProps layer={layer} onUpdate={onUpdate} document={document} />}
      {layer.type === "imageRelief" && (
        <ImageProps layer={layer} onUpdate={onUpdate} document={document} />
      )}
      {layer.type === "importedMesh" && <MeshProps layer={layer} />}
      {layer.type === "hole" && <HoleProps layer={layer} onUpdate={onUpdate} />}
      {layer.type === "primitive" && <PrimitiveProps layer={layer} onUpdate={onUpdate} />}
      {layer.type === "sketch" && (
        <SketchProps
          layer={layer}
          onUpdate={onUpdate}
          extraControls={
            <>
              <CombineSelect
                document={document}
                value={layer.combine}
                onChange={(combine) => onUpdate({ combine }, "מצב שילוב")}
              />
              <BevelControls layer={layer} onUpdate={onUpdate} />
            </>
          }
        />
      )}

      <PivotControls layer={layer} onUpdate={onUpdate} />

      <MaterialSlotSelect document={document} layer={layer} onUpdate={onUpdate} />

      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">שקיפות בתצוגה (לא משפיעה על הקובץ)</span>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={layer.previewOpacity}
          onChange={(e) =>
            onUpdate({ previewOpacity: Number(e.target.value) }, "שקיפות תצוגה")
          }
          aria-label="שקיפות שכבה בתצוגה"
        />
      </label>

      <details className="rounded-md border border-slate-200 p-2" open>
        <summary className="cursor-pointer text-xs font-bold text-slate-600">
          טרנספורמציה (X/Y/Z)
        </summary>
        <div className="pt-2">
          <TransformPanel
            transform={layer.transform}
            disabled={layer.locked}
            onChange={(transform, labelHe) => onUpdate({ transform }, labelHe)}
          />
        </div>
      </details>
    </div>
  );
}

function CombineSelect({
  document,
  value,
  onChange,
}: {
  document: DesignDocument;
  value: "raised" | "engraved" | "inlay" | "standalone";
  onChange: (v: "raised" | "engraved" | "inlay" | "standalone") => void;
}) {
  if (document.baseMode === "baseless") {
    return (
      <p className="text-xs text-slate-400">
        במצב ״ללא בסיס״ כל שכבה היא גוף עצמאי.
      </p>
    );
  }
  return (
    <>
      <ToggleGroup
        label="שילוב עם הבסיס"
        value={value}
        options={[
          { value: "raised", label: "מובלט" },
          { value: "engraved", label: "חרוט" },
          { value: "inlay", label: "משובץ" },
          { value: "standalone", label: "עצמאי" },
        ]}
        onChange={onChange}
      />
      {value === "inlay" && (
        <p className="text-xs text-slate-500">
          שיבוץ: בבסיס נוצר כיס עם חופש הדפסה, והשכבה מיוצאת כחלק נפרד בצבע
          משלה (הדפסה רב־צבעית).
        </p>
      )}
    </>
  );
}

function BevelControls({
  layer,
  onUpdate,
}: {
  layer: TextLayer | SvgLayer | ImageReliefLayer | SketchLayer;
  onUpdate: (patch: Partial<DesignLayer>, labelHe: string) => void;
}) {
  return (
    <>
      <label className="flex items-center justify-between text-sm">
        <span className="text-slate-600">פאזה (Bevel) בקצה העליון</span>
        <input
          type="checkbox"
          checked={layer.bevel.enabled}
          onChange={(e) =>
            onUpdate({ bevel: { ...layer.bevel, enabled: e.target.checked } }, "פאזה")
          }
        />
      </label>
      {layer.bevel.enabled && (
        <NumberField
          label="גודל פאזה"
          value={layer.bevel.sizeMm}
          min={0.1}
          max={10}
          step={0.1}
          onChange={(v) => onUpdate({ bevel: { ...layer.bevel, sizeMm: v } }, "גודל פאזה")}
        />
      )}
    </>
  );
}

function TextProps({
  layer,
  document,
  onUpdate,
}: {
  layer: TextLayer;
  document: DesignDocument;
  onUpdate: (patch: Partial<DesignLayer>, labelHe: string) => void;
}) {
  const r = PARAM_RANGES;
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-slate-600">תוכן הטקסט</span>
        <textarea
          className="min-h-16 rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={layer.content}
          maxLength={r.maxTextLength}
          onChange={(e) => onUpdate({ content: e.target.value }, "עריכת טקסט")}
        />
      </label>
      <label className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">גופן</span>
        <select
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={layer.fontId}
          onChange={(e) =>
            onUpdate({ fontId: e.target.value as TextLayer["fontId"] }, "החלפת גופן")
          }
        >
          {FONTS.map((font) => (
            <option key={font.id} value={font.id}>
              {font.nameHe}
            </option>
          ))}
        </select>
      </label>
      <NumberField label="גודל טקסט" value={layer.sizeMm} min={r.textSizeMm.min} max={r.textSizeMm.max} onChange={(v) => onUpdate({ sizeMm: v }, "גודל טקסט")} />
      <label className="flex items-center justify-between text-sm">
        <span className="text-slate-600">מודגש</span>
        <input
          type="checkbox"
          checked={layer.bold}
          disabled={!fontHasBold(layer.fontId)}
          onChange={(e) => onUpdate({ bold: e.target.checked }, "הדגשה")}
        />
      </label>
      <ToggleGroup
        label="יישור"
        value={layer.align}
        options={[
          { value: "right", label: "ימין" },
          { value: "center", label: "מרכז" },
          { value: "left", label: "שמאל" },
        ]}
        onChange={(align) => onUpdate({ align }, "יישור טקסט")}
      />
      <NumberField label="מרווח שורות" value={layer.lineSpacing} min={r.lineSpacing.min} max={r.lineSpacing.max} step={0.1} unit="×" onChange={(v) => onUpdate({ lineSpacing: v }, "מרווח שורות")} />
      <NumberField label="ריווח אותיות" value={layer.letterSpacingMm} min={-5} max={20} step={0.1} onChange={(v) => onUpdate({ letterSpacingMm: v }, "ריווח אותיות")} />
      <NumberField
        label="רדיוס קשת (0=ישר)"
        value={layer.curveRadiusMm}
        min={0}
        max={1000}
        step={5}
        onChange={(v) => onUpdate({ curveRadiusMm: v === 0 ? 0 : Math.max(v, 10) }, "רדיוס קשת")}
      />
      <label className="flex items-center justify-between text-sm">
        <span className="text-slate-600">כתב ראי (לחותמות)</span>
        <input
          type="checkbox"
          checked={layer.mirrored}
          onChange={(e) => onUpdate({ mirrored: e.target.checked }, "כתב ראי")}
        />
      </label>
      <ToggleGroup
        label="כיווניות"
        value={layer.direction}
        options={[
          { value: "auto", label: "אוטומטי" },
          { value: "ltr", label: "LTR" },
        ]}
        onChange={(direction) => onUpdate({ direction }, "כיווניות טקסט")}
      />
      <NumberField
        label={layer.combine === "engraved" && document.baseMode === "withBase" ? "עומק חריטה" : "עובי/גובה"}
        value={layer.extrudeMm}
        min={r.textDepthMm.min}
        max={r.textDepthMm.max}
        step={0.1}
        onChange={(v) => onUpdate({ extrudeMm: v }, "עומק טקסט")}
      />
      <CombineSelect document={document} value={layer.combine} onChange={(combine) => onUpdate({ combine }, "מצב שילוב")} />
      <BevelControls layer={layer} onUpdate={onUpdate} />
    </>
  );
}

function BaseProps({
  layer,
  onUpdate,
}: {
  layer: BaseLayer;
  onUpdate: (patch: Partial<DesignLayer>, labelHe: string) => void;
}) {
  const r = PARAM_RANGES;
  return (
    <>
      <ToggleGroup
        label="צורה"
        value={layer.shape}
        options={[
          { value: "rectangle", label: "מלבן" },
          { value: "roundedRectangle", label: "מעוגל" },
          { value: "circle", label: "עיגול" },
        ]}
        onChange={(shape) =>
          onUpdate(
            shape === "circle" ? { shape, heightMm: layer.widthMm } : { shape },
            "צורת בסיס"
          )
        }
      />
      {layer.shape === "circle" ? (
        <NumberField
          label="קוטר"
          value={layer.widthMm}
          min={r.baseWidthMm.min}
          max={r.baseWidthMm.max}
          onChange={(v) => onUpdate({ widthMm: v, heightMm: v }, "קוטר בסיס")}
        />
      ) : (
        <>
          <NumberField label="רוחב" value={layer.widthMm} min={r.baseWidthMm.min} max={r.baseWidthMm.max} onChange={(v) => onUpdate({ widthMm: v }, "רוחב בסיס")} />
          <NumberField label="גובה" value={layer.heightMm} min={r.baseHeightMm.min} max={r.baseHeightMm.max} onChange={(v) => onUpdate({ heightMm: v }, "גובה בסיס")} />
        </>
      )}
      <NumberField label="עובי" value={layer.thicknessMm} min={r.baseThicknessMm.min} max={r.baseThicknessMm.max} step={0.5} onChange={(v) => onUpdate({ thicknessMm: v }, "עובי בסיס")} />
      {layer.shape === "roundedRectangle" && (
        <NumberField label="רדיוס פינה" value={layer.cornerRadiusMm} min={0} max={r.cornerRadiusMm.max} onChange={(v) => onUpdate({ cornerRadiusMm: v }, "רדיוס פינה")} />
      )}
      <label className="flex items-center justify-between text-sm">
        <span className="text-slate-600">שפה מוגבהת (מסגרת)</span>
        <input
          type="checkbox"
          checked={layer.rimEnabled}
          onChange={(e) => onUpdate({ rimEnabled: e.target.checked }, "שפה מוגבהת")}
        />
      </label>
      {layer.rimEnabled && (
        <>
          <NumberField label="רוחב השפה" value={layer.rimWidthMm} min={0.5} max={20} step={0.5} onChange={(v) => onUpdate({ rimWidthMm: v }, "רוחב שפה")} />
          <NumberField label="גובה השפה" value={layer.rimHeightMm} min={0.2} max={20} step={0.2} onChange={(v) => onUpdate({ rimHeightMm: v }, "גובה שפה")} />
        </>
      )}
    </>
  );
}

function SvgProps({
  layer,
  document,
  onUpdate,
}: {
  layer: SvgLayer;
  document: DesignDocument;
  onUpdate: (patch: Partial<DesignLayer>, labelHe: string) => void;
}) {
  return (
    <>
      <p className="text-xs text-slate-500">
        קובץ מקור: <span dir="ltr">{layer.sourceName}</span> ({layer.contours.length} קווי
        מתאר)
      </p>
      <NumberField label="עובי/עומק" value={layer.extrudeMm} min={0.2} max={100} step={0.1} onChange={(v) => onUpdate({ extrudeMm: v }, "עובי SVG")} />
      <CombineSelect document={document} value={layer.combine} onChange={(combine) => onUpdate({ combine }, "מצב שילוב")} />
      <BevelControls layer={layer} onUpdate={onUpdate} />
    </>
  );
}

function ImageProps({
  layer,
  document,
  onUpdate,
}: {
  layer: ImageReliefLayer;
  document: DesignDocument;
  onUpdate: (patch: Partial<DesignLayer>, labelHe: string) => void;
}) {
  return (
    <>
      <p className="text-xs text-slate-500">
        תמונה: <span dir="ltr">{layer.sourceName}</span> —{" "}
        {layer.mode === "silhouette" ? "צללית" : "תבליט"}
      </p>
      {layer.mode === "silhouette" ? (
        <>
          <NumberField label="עובי/עומק" value={layer.extrudeMm} min={0.2} max={100} step={0.1} onChange={(v) => onUpdate({ extrudeMm: v }, "עובי צללית")} />
          <CombineSelect document={document} value={layer.combine} onChange={(combine) => onUpdate({ combine }, "מצב שילוב")} />
          <BevelControls layer={layer} onUpdate={onUpdate} />
        </>
      ) : (
        <p className="text-xs text-slate-500">
          גוף תבליט סגור (עובי מינימלי {layer.settings.minThicknessMm} מ״מ, גובה תבליט{" "}
          {layer.settings.reliefHeightMm} מ״מ). לשינוי ההגדרות ייבאו את התמונה מחדש.
        </p>
      )}
    </>
  );
}

function MeshProps({ layer }: { layer: ImportedMeshLayer }) {
  const mesh = getMesh(layer.meshId);
  const triangles = mesh ? mesh.indices.length / 3 : 0;
  return (
    <div className="flex flex-col gap-1 text-xs text-slate-500">
      {layer.provenance.fileName && (
        <p>
          קובץ מקור: <span dir="ltr">{layer.provenance.fileName}</span>
        </p>
      )}
      {layer.provenance.descriptionHe && <p>מקור: {layer.provenance.descriptionHe}</p>}
      <p>משולשים: {triangles.toLocaleString()}</p>
      {layer.originalMeshId && (
        <p className="text-emerald-600">הרשת המקורית שמורה בזיכרון (ניתן לשחזר בביטול)</p>
      )}
    </div>
  );
}

function HoleProps({
  layer,
  onUpdate,
}: {
  layer: HoleLayer;
  onUpdate: (patch: Partial<DesignLayer>, labelHe: string) => void;
}) {
  const r = PARAM_RANGES;
  return (
    <>
      <NumberField label="קוטר" value={layer.diameterMm} min={r.holeDiameterMm.min} max={r.holeDiameterMm.max} step={0.5} onChange={(v) => onUpdate({ diameterMm: v }, "קוטר חור")} />
      <ToggleGroup
        label="עומק"
        value={layer.depthMode}
        options={[
          { value: "through", label: "חודר" },
          { value: "blind", label: "עיוור" },
        ]}
        onChange={(depthMode) => onUpdate({ depthMode }, "סוג חור")}
      />
      {layer.depthMode === "blind" && (
        <NumberField label="עומק חור" value={layer.depthMm} min={0.5} max={100} step={0.5} onChange={(v) => onUpdate({ depthMm: v }, "עומק חור")} />
      )}
      <p className="text-xs text-slate-400">
        כיוון הקידוח הוא ציר ה-Z המקומי של השכבה — סובבו את השכבה לחור בזווית.
      </p>
    </>
  );
}

function MaterialSlotSelect({
  document,
  layer,
  onUpdate,
}: {
  document: DesignDocument;
  layer: DesignLayer;
  onUpdate: (patch: Partial<DesignLayer>, labelHe: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span className="text-slate-600">צבע / חומר</span>
      <span className="flex items-center gap-1">
        {document.materialSlots.map((slot) => (
          <button
            key={slot.id}
            type="button"
            aria-label={`בחירת ${slot.nameHe}`}
            title={slot.nameHe}
            className={`h-6 w-6 rounded-full border-2 transition-transform focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 ${
              layer.materialSlotId === slot.id
                ? "scale-110 border-slate-700"
                : "border-slate-200"
            }`}
            style={{ backgroundColor: slot.colorHex }}
            onClick={() => onUpdate({ materialSlotId: slot.id }, "החלפת צבע")}
          />
        ))}
      </span>
    </label>
  );
}
