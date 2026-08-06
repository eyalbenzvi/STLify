"use client";

/**
 * Parameter dialogs for geometry operations: boolean source handling,
 * plane cut, connectors, hollow, drain hole, thicken, smooth, simplify,
 * plus the generic error/result dialog with Hebrew fix suggestions.
 */

import { useState } from "react";
import type {
  BooleanOperationKind,
  ConnectorDefinition,
  ConnectorType,
  CutPlaneDefinition,
  HollowSettings,
  SimplifySettings,
  SmoothSettings,
} from "@/types/design";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import { Modal, ModalButton } from "@/components/ui/Modal";

// ---------------------------------------------------------------------------
// Message / error dialog
// ---------------------------------------------------------------------------

export interface OpMessage {
  titleHe: string;
  bodyHe: string;
  suggestionsHe?: string[];
  kind: "error" | "info" | "success";
}

export function MessageDialog({
  message,
  onClose,
}: {
  message: OpMessage | null;
  onClose: () => void;
}) {
  return (
    <Modal
      title={message?.titleHe ?? ""}
      open={message !== null}
      onClose={onClose}
      footer={<ModalButton variant="primary" onClick={onClose}>הבנתי</ModalButton>}
    >
      {message && (
        <>
          <p
            className={`text-sm ${
              message.kind === "error"
                ? "text-red-700"
                : message.kind === "success"
                  ? "text-emerald-700"
                  : "text-slate-600"
            }`}
          >
            {message.bodyHe}
          </p>
          {message.suggestionsHe && message.suggestionsHe.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-bold text-slate-500">הצעות לתיקון:</p>
              <ul className="list-inside list-disc text-xs text-slate-600">
                {message.suggestionsHe.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Boolean sources dialog
// ---------------------------------------------------------------------------

const BOOLEAN_NAMES_HE: Record<BooleanOperationKind, string> = {
  union: "איחוד",
  difference: "חיסור",
  intersection: "חיתוך משותף",
};

export function BooleanDialog({
  kind,
  layerNames,
  onConfirm,
  onClose,
}: {
  kind: BooleanOperationKind | null;
  layerNames: string[];
  onConfirm: (sources: "keep" | "hide" | "replace") => void;
  onClose: () => void;
}) {
  const [sources, setSources] = useState<"keep" | "hide" | "replace">("hide");
  return (
    <Modal
      title={kind ? `${BOOLEAN_NAMES_HE[kind]} — ${layerNames.length} שכבות` : ""}
      open={kind !== null}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton
            variant={sources === "replace" ? "danger" : "primary"}
            onClick={() => onConfirm(sources)}
          >
            {sources === "replace" ? "בצע והחלף (מחיקת המקור)" : "בצע"}
          </ModalButton>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        {kind === "difference"
          ? `השכבה הראשונה שנבחרה (${layerNames[0] ?? ""}) היא הגוף שממנו מחסירים.`
          : `הפעולה תבוצע על: ${layerNames.join(", ")}`}
      </p>
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 text-xs font-bold text-slate-500">
          מה לעשות עם שכבות המקור?
        </legend>
        {(
          [
            ["keep", "השאר גלויות (לעריכה חוזרת)"],
            ["hide", "הסתר (ניתן להחזיר מרשימת השכבות)"],
            ["replace", "מחק והחלף בתוצאה (פעולה הרסנית)"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name="booleanSources"
              checked={sources === value}
              onChange={() => setSources(value)}
            />
            <span className={value === "replace" ? "text-red-700" : "text-slate-700"}>
              {label}
            </span>
          </label>
        ))}
      </fieldset>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Plane cut dialog
// ---------------------------------------------------------------------------

export interface CutRequest {
  plane: CutPlaneDefinition;
  keep: "top" | "bottom" | "both";
}

export function CutDialog({
  open,
  layerName,
  boundsZ,
  plane,
  onPlaneChange,
  onConfirm,
  onClose,
}: {
  open: boolean;
  layerName: string;
  boundsZ: { min: number; max: number } | null;
  plane: CutPlaneDefinition;
  onPlaneChange: (plane: CutPlaneDefinition) => void;
  onConfirm: (request: CutRequest) => void;
  onClose: () => void;
}) {
  const [keep, setKeep] = useState<"top" | "bottom" | "both">("both");
  return (
    <Modal
      title={`חיתוך מישור — ${layerName}`}
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={() => onConfirm({ plane, keep })}>
            חתוך
          </ModalButton>
        </>
      }
    >
      <p className="text-xs text-slate-500">
        מישור החיתוך מוצג בתצוגה התלת־ממדית. שני הצדדים נסגרים במכסים שטוחים
        (Caps) כך שהחלקים נשארים גופים אטומים וניתנים להדפסה.
      </p>
      <ToggleGroup
        label="כיוון המישור"
        value={plane.orientation}
        options={[
          { value: "xy", label: "אופקי" },
          { value: "xz", label: "אנכי XZ" },
          { value: "yz", label: "אנכי YZ" },
          { value: "custom", label: "מותאם" },
        ]}
        onChange={(orientation) => onPlaneChange({ ...plane, orientation })}
      />
      <NumberField
        label="מיקום המישור"
        value={plane.offsetMm}
        min={-500}
        max={500}
        step={0.5}
        onChange={(offsetMm) => onPlaneChange({ ...plane, offsetMm })}
      />
      {boundsZ && plane.orientation === "xy" && (
        <p className="text-xs text-slate-400" dir="ltr">
          Z ∈ [{boundsZ.min.toFixed(1)}, {boundsZ.max.toFixed(1)}]
        </p>
      )}
      {plane.orientation === "custom" && (
        <>
          <NumberField label="סיבוב X" value={plane.rotationX} min={-90} max={90} step={5} unit="°" onChange={(rotationX) => onPlaneChange({ ...plane, rotationX })} />
          <NumberField label="סיבוב Y" value={plane.rotationY} min={-90} max={90} step={5} unit="°" onChange={(rotationY) => onPlaneChange({ ...plane, rotationY })} />
        </>
      )}
      <ToggleGroup
        label="מה לשמור"
        value={keep}
        options={[
          { value: "both", label: "שני הצדדים" },
          { value: "top", label: "עליון" },
          { value: "bottom", label: "תחתון" },
        ]}
        onChange={setKeep}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Connectors dialog
// ---------------------------------------------------------------------------

export function ConnectorsDialog({
  open,
  maleName,
  femaleName,
  onConfirm,
  onClose,
}: {
  open: boolean;
  maleName: string;
  femaleName: string;
  onConfirm: (def: ConnectorDefinition) => void;
  onClose: () => void;
}) {
  const [def, setDef] = useState<ConnectorDefinition>({
    type: "pin",
    sizeMm: 4,
    depthMm: 4,
    count: 2,
    spacingMm: 0,
    clearanceMm: 0.2,
    edgeMarginMm: 4,
  });
  const patch = (p: Partial<ConnectorDefinition>) => setDef((d) => ({ ...d, ...p }));
  return (
    <Modal
      title="הוספת מחברים בין חלקים"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={() => onConfirm(def)}>
            הוסף מחברים
          </ModalButton>
        </>
      }
    >
      <p className="text-xs text-slate-500">
        זכר: {maleName} (החלק התחתון) · נקבה: {femaleName} (החלק העליון). המחברים
        ימוקמו במשטח המגע של החיתוך האחרון.
      </p>
      <ToggleGroup
        label="סוג מחבר"
        value={def.type}
        options={[
          { value: "pin", label: "פין" },
          { value: "key", label: "לשונית" },
          { value: "dovetail", label: "זנב סנונית" },
          { value: "magnetPocket", label: "כיס מגנט" },
        ] satisfies { value: ConnectorType; label: string }[]}
        onChange={(type) => patch({ type })}
      />
      <NumberField label={def.type === "pin" || def.type === "magnetPocket" ? "קוטר" : "רוחב"} value={def.sizeMm} min={1} max={30} step={0.5} onChange={(sizeMm) => patch({ sizeMm })} />
      <NumberField label="עומק" value={def.depthMm} min={1} max={30} step={0.5} onChange={(depthMm) => patch({ depthMm })} />
      <NumberField label="כמות" value={def.count} min={1} max={12} step={1} unit="" onChange={(count) => patch({ count: Math.round(count) })} />
      <NumberField label="מרווח (0=אוטומטי)" value={def.spacingMm} min={0} max={200} step={1} onChange={(spacingMm) => patch({ spacingMm })} />
      <NumberField label="חופש (Clearance)" value={def.clearanceMm} min={0} max={1} step={0.05} onChange={(clearanceMm) => patch({ clearanceMm })} />
      <NumberField label="מרחק מהשפה" value={def.edgeMarginMm} min={1} max={30} step={0.5} onChange={(edgeMarginMm) => patch({ edgeMarginMm })} />
      {def.type === "dovetail" && (
        <p className="text-xs text-amber-600">
          זנב סנונית מורכב בהחלקה מהצד (לא בלחיצה ישרה).
        </p>
      )}
      {def.type === "magnetPocket" && (
        <p className="text-xs text-slate-500">
          כיסי מגנט נקדחים בשני הצדדים; הקוטר כולל את החופש שהוגדר.
        </p>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Hollow dialog
// ---------------------------------------------------------------------------

export function HollowDialog({
  open,
  layerName,
  onConfirm,
  onClose,
}: {
  open: boolean;
  layerName: string;
  onConfirm: (settings: HollowSettings) => void;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<HollowSettings>({
    wallThicknessMm: 2,
    preserveBaseMm: 0,
  });
  return (
    <Modal
      title={`חלול — ${layerName}`}
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={() => onConfirm(settings)}>
            חלול
          </ModalButton>
        </>
      }
    >
      <p className="text-xs text-slate-500">
        הגוף יהפוך לקליפה עם עובי דופן אחיד (שחיקה מורפולוגית אמיתית). מודלים
        מורכבים מאוד עשויים להיכשל — במקרה כזה תוצג הודעה ברורה.
      </p>
      <NumberField
        label="עובי דופן"
        value={settings.wallThicknessMm}
        min={0.5}
        max={20}
        step={0.5}
        onChange={(wallThicknessMm) => setSettings((s) => ({ ...s, wallThicknessMm }))}
      />
      <NumberField
        label="שימור רצפה מלאה"
        value={settings.preserveBaseMm}
        min={0}
        max={50}
        step={0.5}
        onChange={(preserveBaseMm) => setSettings((s) => ({ ...s, preserveBaseMm }))}
      />
      <p className="text-xs text-amber-600">
        מומלץ להוסיף חורי ניקוז אחרי החלול — חובה בהדפסת שרף (SLA).
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Drain hole dialog (opened after picking a point in the viewer)
// ---------------------------------------------------------------------------

export function DrainHoleDialog({
  open,
  onConfirm,
  onClose,
}: {
  open: boolean;
  onConfirm: (diameterMm: number, depthMm: number) => void;
  onClose: () => void;
}) {
  const [diameter, setDiameter] = useState(3);
  const [depth, setDepth] = useState(10);
  return (
    <Modal
      title="חור ניקוז"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={() => onConfirm(diameter, depth)}>
            קדח
          </ModalButton>
        </>
      }
    >
      <p className="text-xs text-slate-500">
        החור ייקדח בנקודה שנבחרה, בניצב לפני השטח, פנימה. רלוונטי במיוחד
        להדפסת שרף (SLA) — חלל סגור ללא ניקוז גורם לכשלי הדפסה.
      </p>
      <NumberField label="קוטר" value={diameter} min={1} max={12} step={0.5} onChange={setDiameter} />
      <NumberField label="עומק קידוח" value={depth} min={1} max={200} step={1} onChange={setDepth} />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Thicken / smooth / simplify dialogs
// ---------------------------------------------------------------------------

export function ThickenDialog({
  open,
  layerName,
  onConfirm,
  onClose,
}: {
  open: boolean;
  layerName: string;
  onConfirm: (thicknessMm: number) => void;
  onClose: () => void;
}) {
  const [thickness, setThickness] = useState(1);
  return (
    <Modal
      title={`עיבוי — ${layerName}`}
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={() => onConfirm(thickness)}>
            עבה
          </ModalButton>
        </>
      }
    >
      <p className="text-xs text-slate-500">
        הגוף ינופח בכל הכיוונים בעובי שנבחר. שימו לב: פרטים עדינים עשויים
        להתעגל ולהתמזג, והמידות החיצוניות יגדלו.
      </p>
      <NumberField label="תוספת עובי" value={thickness} min={0.1} max={20} step={0.1} onChange={setThickness} />
    </Modal>
  );
}

export function SmoothDialog({
  open,
  layerName,
  onConfirm,
  onClose,
}: {
  open: boolean;
  layerName: string;
  onConfirm: (settings: SmoothSettings) => void;
  onClose: () => void;
}) {
  const [strength, setStrength] = useState<SmoothSettings["strength"]>("standard");
  const [preserveFeatures, setPreserveFeatures] = useState(true);
  const [iterations, setIterations] = useState(0);
  return (
    <Modal
      title={`החלקה — ${layerName}`}
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton
            variant="primary"
            onClick={() => onConfirm({ strength, iterations, preserveFeatures })}
          >
            החלק
          </ModalButton>
        </>
      }
    >
      <ToggleGroup
        label="עוצמה"
        value={strength}
        options={[
          { value: "light", label: "קלה" },
          { value: "standard", label: "רגילה" },
          { value: "strong", label: "חזקה" },
        ]}
        onChange={setStrength}
      />
      <NumberField
        label="איטרציות (0=לפי עוצמה)"
        value={iterations}
        min={0}
        max={30}
        step={1}
        unit=""
        onChange={(v) => setIterations(Math.round(v))}
      />
      <label className="flex items-center justify-between text-sm">
        <span className="text-slate-600">שימור פינות חדות</span>
        <input
          type="checkbox"
          checked={preserveFeatures}
          onChange={(e) => setPreserveFeatures(e.target.checked)}
        />
      </label>
    </Modal>
  );
}

export function SimplifyDialog({
  open,
  layerName,
  currentTriangles,
  onConfirm,
  onClose,
}: {
  open: boolean;
  layerName: string;
  currentTriangles: number;
  onConfirm: (settings: SimplifySettings) => void;
  onClose: () => void;
}) {
  const [preset, setPreset] = useState<SimplifySettings["preset"]>("standard");
  const [tolerance, setTolerance] = useState(0.15);
  return (
    <Modal
      title={`פישוט רשת — ${layerName}`}
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton
            variant="primary"
            onClick={() => onConfirm({ preset, toleranceMm: tolerance })}
          >
            פשט
          </ModalButton>
        </>
      }
    >
      <p className="text-xs text-slate-500">
        משולשים כרגע: {currentTriangles.toLocaleString()}. פישוט אגרסיבי עלול
        לפגוע בטקסט קטן, בחורים ובפרטים עדינים.
      </p>
      <ToggleGroup
        label="רמת פישוט"
        value={preset}
        options={[
          { value: "draft", label: "עדין" },
          { value: "standard", label: "רגיל" },
          { value: "aggressive", label: "אגרסיבי" },
          { value: "custom", label: "מותאם" },
        ]}
        onChange={setPreset}
      />
      {preset === "custom" && (
        <NumberField label="סבילות" value={tolerance} min={0.01} max={5} step={0.05} onChange={setTolerance} />
      )}
    </Modal>
  );
}
