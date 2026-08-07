"use client";

/**
 * Transform toolbar (move/rotate/scale, world/local, snapping) plus
 * placement tools (drop/center/align/distribute/mirror/duplicate/place-on-
 * surface/snap-to-object) and geometry operations (booleans, cut, split,
 * connectors, hollow, drain, thicken, smooth, simplify, repair).
 * Buttons disable themselves when their preconditions aren't met — there
 * are no dead controls.
 */

import type { ReactNode } from "react";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import type { Axis } from "@/types/design";
import type { EditorTool, SnapSettings } from "./store";

export interface ToolsPanelProps {
  tool: EditorTool;
  transformSpace: "world" | "local";
  snap: SnapSettings;
  /** Number of selected layers / of them shape layers / mesh layers. */
  selectedCount: number;
  selectedShapeCount: number;
  selectedMeshCount: number;
  /** Selected layers that own printable parts (gizmo/placement targets). */
  selectedPartCount: number;
  busy: boolean;
  onSetTool: (tool: EditorTool) => void;
  onSetSpace: (space: "world" | "local") => void;
  onSetSnap: (snap: Partial<SnapSettings>) => void;
  onDropToPlate: () => void;
  onCenterOnPlate: () => void;
  onMirror: (axis: Axis) => void;
  onDuplicate: () => void;
  onAlign: (axis: Axis, mode: "min" | "center" | "max") => void;
  onDistribute: (axis: Axis) => void;
  onSnapToCenter: () => void;
  onSnapToEdge: (axis: Axis) => void;
  onBoolean: (kind: "union" | "difference" | "intersection") => void;
  onCut: () => void;
  onSplitComponents: () => void;
  onConnectors: () => void;
  onHollow: () => void;
  onDrain: () => void;
  onThicken: () => void;
  onSmooth: () => void;
  onSimplify: () => void;
  onRepair: () => void;
  onFillet: () => void;
  onShell: () => void;
  onDeform: () => void;
  onLattice: () => void;
  onPattern: () => void;
  onInspectMesh: () => void;
  onCheckInterference: () => void;
  onArrangePlate: () => void;
  onRevolve: () => void;
  onEmboss: () => void;
  onGenerateSupports: () => void;
  onCheckBridging: () => void;
  onAnalyzeWarping: () => void;
  onGenerateBrim: () => void;
  onGenerateRaft: () => void;
  /** True when the selection is a profile that can be revolved. */
  canRevolve: boolean;
  /** Number of printable parts currently in the document. */
  partCount: number;
}

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
  title,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children?: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title ?? label}
      aria-pressed={active}
      className={`rounded-md border px-2 py-1 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? "border-blue-500 bg-blue-600 text-white"
          : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
      }`}
      onClick={onClick}
    >
      {children ?? label}
    </button>
  );
}

export function ToolsPanel(props: ToolsPanelProps) {
  const {
    tool,
    transformSpace,
    snap,
    selectedCount,
    selectedShapeCount,
    selectedMeshCount,
    selectedPartCount,
    busy,
    partCount,
    canRevolve,
  } = props;
  const single = selectedPartCount === 1;
  const singleShape = selectedShapeCount === 1;

  return (
    <div className="flex flex-col gap-4">
      {/* Transform tools */}
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">כלי טרנספורמציה</p>
        <div className="flex flex-wrap gap-1" role="toolbar" aria-label="כלי טרנספורמציה">
          <ToolButton label="בחירה" active={tool === "select"} onClick={() => props.onSetTool("select")} />
          <ToolButton label="הזזה" active={tool === "translate"} onClick={() => props.onSetTool("translate")} />
          <ToolButton label="סיבוב" active={tool === "rotate"} onClick={() => props.onSetTool("rotate")} />
          <ToolButton label="קנה מידה" active={tool === "scale"} onClick={() => props.onSetTool("scale")} />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <ToggleGroup
            label="צירים"
            value={transformSpace}
            options={[
              { value: "world", label: "עולם" },
              { value: "local", label: "מקומי" },
            ]}
            onChange={props.onSetSpace}
          />
        </div>
        <p className="mt-1 text-[11px] leading-snug text-slate-400">
          עולם = צירי משטח ההדפסה; מקומי = הצירים המסובבים של האובייקט.
        </p>
      </div>

      {/* Snapping */}
      <div>
        <label className="flex items-center justify-between text-sm">
          <span className="font-bold text-slate-500">הצמדה (Snap)</span>
          <input
            type="checkbox"
            checked={snap.enabled}
            onChange={(e) => props.onSetSnap({ enabled: e.target.checked })}
            aria-label="הפעלת הצמדה"
          />
        </label>
        {snap.enabled && (
          <div className="mt-2 flex flex-col gap-2">
            <label className="flex items-center justify-between gap-2 text-sm">
              <span className="text-slate-600">מיקום</span>
              <select
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                value={snap.positionMm}
                onChange={(e) => props.onSetSnap({ positionMm: Number(e.target.value) })}
              >
                {[0.1, 0.5, 1, 5].map((v) => (
                  <option key={v} value={v}>
                    {v} מ״מ
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2 text-sm">
              <span className="text-slate-600">סיבוב</span>
              <select
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                value={snap.rotationDeg}
                onChange={(e) => props.onSetSnap({ rotationDeg: Number(e.target.value) })}
              >
                {[1, 5, 15, 45, 90].map((v) => (
                  <option key={v} value={v}>
                    {v}°
                  </option>
                ))}
              </select>
            </label>
            <NumberField
              label="קנה מידה"
              value={snap.scaleStep}
              min={0.01}
              max={1}
              step={0.01}
              unit="×"
              onChange={(scaleStep) => props.onSetSnap({ scaleStep })}
            />
          </div>
        )}
      </div>

      {/* Placement */}
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">מיקום והצבה</p>
        <div className="flex flex-wrap gap-1">
          <ToolButton label="הנח על משטח ההדפסה" disabled={!single || busy} onClick={props.onDropToPlate} />
          <ToolButton label="מרכז אובייקט" disabled={!single || busy} onClick={props.onCenterOnPlate} />
          <ToolButton
            label="הנח על משטח"
            active={tool === "placeOnSurface"}
            disabled={!single || busy}
            title="בחרו אובייקט ואז לחצו על משטח יעד בתצוגה"
            onClick={() =>
              props.onSetTool(tool === "placeOnSurface" ? "select" : "placeOnSurface")
            }
          />
          <ToolButton label="שכפול" disabled={selectedCount === 0 || busy} onClick={props.onDuplicate} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-xs text-slate-500">שיקוף:</span>
          {(["x", "y", "z"] as const).map((axis) => (
            <ToolButton key={axis} label={`שיקוף ${axis.toUpperCase()}`} disabled={!single || busy} onClick={() => props.onMirror(axis)}>
              {axis.toUpperCase()}
            </ToolButton>
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-xs text-slate-500">יישור:</span>
          {(["x", "y", "z"] as const).map((axis) => (
            <ToolButton
              key={axis}
              label={`יישור מרכזים בציר ${axis.toUpperCase()}`}
              disabled={selectedPartCount < 2 || busy}
              onClick={() => props.onAlign(axis, "center")}
            >
              {axis.toUpperCase()}
            </ToolButton>
          ))}
          <span className="ms-2 text-xs text-slate-500">פיזור:</span>
          {(["x", "y", "z"] as const).map((axis) => (
            <ToolButton
              key={axis}
              label={`פיזור אחיד בציר ${axis.toUpperCase()}`}
              disabled={selectedPartCount < 3 || busy}
              onClick={() => props.onDistribute(axis)}
            >
              {axis.toUpperCase()}
            </ToolButton>
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <ToolButton label="הצמד למרכז אובייקט" disabled={selectedPartCount !== 2 || busy} onClick={props.onSnapToCenter} />
          <span className="text-xs text-slate-500">הצמד לקצה:</span>
          {(["x", "y", "z"] as const).map((axis) => (
            <ToolButton
              key={axis}
              label={`הצמדה לקצה בציר ${axis.toUpperCase()}`}
              disabled={selectedPartCount !== 2 || busy}
              onClick={() => props.onSnapToEdge(axis)}
            >
              {axis.toUpperCase()}
            </ToolButton>
          ))}
        </div>
      </div>

      {/* Booleans */}
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">
          פעולות בוליאניות (בחרו 2+ שכבות)
        </p>
        <div className="flex flex-wrap gap-1">
          <ToolButton label="איחוד" disabled={selectedShapeCount < 2 || busy} onClick={() => props.onBoolean("union")} />
          <ToolButton label="חיסור" disabled={selectedShapeCount < 2 || busy} onClick={() => props.onBoolean("difference")} />
          <ToolButton label="חיתוך" disabled={selectedShapeCount < 2 || busy} onClick={() => props.onBoolean("intersection")} />
        </div>
      </div>

      {/* Body operations */}
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">עיבוד גוף (שכבה אחת)</p>
        <div className="flex flex-wrap gap-1">
          <ToolButton label="חיתוך מישור" disabled={!singleShape || busy} onClick={props.onCut} />
          <ToolButton label="פיצול לרכיבים" disabled={!singleShape || busy} onClick={props.onSplitComponents} />
          <ToolButton
            label="מחברים"
            disabled={selectedMeshCount !== 2 || busy}
            title="בחרו את שני חלקי החיתוך (תחתון ועליון)"
            onClick={props.onConnectors}
          />
          <ToolButton label="חלול" disabled={!singleShape || busy} onClick={props.onHollow} />
          <ToolButton
            label="חור ניקוז"
            active={tool === "drainHole"}
            disabled={!singleShape || busy}
            onClick={() => props.onDrain()}
          />
          <ToolButton label="עיבוי" disabled={!singleShape || busy} onClick={props.onThicken} />
          <ToolButton label="החלקה" disabled={!singleShape || busy} onClick={props.onSmooth} />
          <ToolButton label="פישוט" disabled={!singleShape || busy} onClick={props.onSimplify} />
          <ToolButton label="תיקון רשת" disabled={selectedMeshCount !== 1 || busy} onClick={props.onRepair} />
        </div>
      </div>

      {/* Advanced shaping */}
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">עיצוב מתקדם (שכבה אחת)</p>
        <div className="flex flex-wrap gap-1">
          <ToolButton
            label="עיגול/שיפוע קצוות"
            title="מעגל את כל הקצוות מהסוג שנבחר — לא קצוות בודדים"
            disabled={!singleShape || busy}
            onClick={props.onFillet}
          />
          <ToolButton
            label="קליפה עם פתח"
            title="חלול עם פתח בפאה נבחרת — קופסה, מגש או כוס"
            disabled={!singleShape || busy}
            onClick={props.onShell}
          />
          <ToolButton
            label="עיוות"
            title="כיפוף, פיתול, התחדדות או מתיחה"
            disabled={!singleShape || busy}
            onClick={props.onDeform}
          />
          <ToolButton
            label="סריג פנימי"
            title="מילוי ג׳ירואיד / חלת דבש — חוסך חומר ושומר על קשיחות"
            disabled={!singleShape || busy}
            onClick={props.onLattice}
          />
          <ToolButton
            label="סיבוב פרופיל"
            title="הופך סקיצה או SVG לגוף סיבובי — כוס, אגרטל, כפתור"
            disabled={!canRevolve || busy}
            onClick={props.onRevolve}
          />
          <ToolButton
            label="הטבעה על משטח"
            title="עוטף או מקרין טקסט/SVG על גוף מעוקל"
            disabled={!singleShape || busy || partCount < 2}
            onClick={props.onEmboss}
          />
        </div>
      </div>

      {/* Duplication */}
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">שכפול ובדיקה</p>
        <div className="flex flex-wrap gap-1">
          <ToolButton
            label="מערך עותקים"
            title="מערך קווי, רשת, מעגלי או שיקוף"
            disabled={selectedCount !== 1 || busy}
            onClick={props.onPattern}
          />
          <ToolButton
            label="בדיקת רשת"
            title="אבחון תקלות ותיקון מדורג"
            disabled={selectedMeshCount !== 1 || busy}
            onClick={props.onInspectMesh}
          />
          <ToolButton
            label="בדיקת חדירה"
            title="מאתר חלקים שחודרים זה לזה"
            disabled={partCount < 2 || busy}
            onClick={props.onCheckInterference}
          />
          <ToolButton
            label="סידור על המשטח"
            title="פורס את כל החלקים על משטח ההדפסה ללא חפיפה"
            disabled={partCount < 2 || busy}
            onClick={props.onArrangePlate}
          />
        </div>
      </div>

      {/* Print preparation */}
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">הכנה להדפסה</p>
        <div className="flex flex-wrap gap-1">
          <ToolButton
            label="צור תמיכות"
            title="עמודים חרוטיים מתחת למשטחים תלויים — בסיס רחב, קצה דק להסרה קלה"
            disabled={partCount === 0 || busy}
            onClick={props.onGenerateSupports}
          />
          <ToolButton
            label="בדיקת גישורים"
            title="מאתר מקטעים אופקיים ללא תמיכה מתחתם"
            disabled={partCount === 0 || busy}
            onClick={props.onCheckBridging}
          />
          <ToolButton
            label="ניתוח כיווץ"
            title="מעריך סיכון להתקמרות (Warping) לפי שטח מגע, אורך הקצה ויחס גובה־בסיס — ניקוד מוסבר"
            disabled={partCount === 0 || busy}
            onClick={props.onAnalyzeWarping}
          />
          <ToolButton
            label="הוספת Brim"
            title="טבעת ברוחב 5 מ״מ סביב השכבה הראשונה — גיאומטריה אמיתית בשכבה נפרדת שאפשר למחוק"
            disabled={partCount === 0 || busy}
            onClick={props.onGenerateBrim}
          />
          <ToolButton
            label="הוספת Raft"
            title="משטח בעובי 2 מ״מ מתחת לחלק (החלק מורם עליו) — שכבה נפרדת שאפשר למחוק"
            disabled={partCount === 0 || busy}
            onClick={props.onGenerateRaft}
          />
        </div>
      </div>
    </div>
  );
}
