"use client";

/**
 * Parameter dialogs for the V4 tools: fillet/chamfer, open shell, deformers,
 * lattice infill, array patterns, the parametric generators, and the mesh
 * inspector that turns a diagnosis into a repair.
 */

import { useState } from "react";
import { Modal, ModalButton } from "@/components/ui/Modal";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import type { GeneratorKind } from "@/components/editor/CreatePanel";
import type { ModelIssue } from "@/types/design";
import type { MeshDiagnosis, MeshRepairReport, RepairOptions } from "@/lib/geometry/repair/diagnose";
import type { FilletSettings, ShellSettings } from "@/lib/geometry/operations/fillet";
import type { LatticeSettings } from "@/lib/geometry/operations/lattice";
import type {
  DeformRequest,
  EmbossRequest,
  RevolveSettings,
} from "@/lib/geometry/operations/advancedOps";
import type { PatternSettings } from "@/lib/geometry/operations/pattern";
import type { InterferenceReport } from "@/lib/geometry/analysis/collision";
import type { Modifier } from "@/lib/geometry/modifiers";
import { MODIFIER_NAMES_HE } from "@/lib/geometry/modifiers";

// ---------------------------------------------------------------------------
// Fillet / chamfer
// ---------------------------------------------------------------------------

export function FilletDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (settings: FilletSettings) => void;
}) {
  const [sizeMm, setSizeMm] = useState(1.5);
  const [style, setStyle] = useState<FilletSettings["style"]>("fillet");
  const [scope, setScope] = useState<FilletSettings["scope"]>("convex");

  return (
    <Modal
      title="עיגול ושיפוע קצוות"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={() => onConfirm({ sizeMm, style, scope })}>
            החל
          </ModalButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ToggleGroup
          label="סוג"
          value={style}
          options={[
            { value: "fillet", label: "עיגול (רדיוס)" },
            { value: "chamfer", label: "שיפוע (45°)" },
          ]}
          onChange={setStyle}
        />
        <ToggleGroup
          label="על אילו קצוות"
          value={scope}
          options={[
            { value: "convex", label: "חיצוניים" },
            { value: "concave", label: "פנימיים" },
            { value: "both", label: "הכול" },
          ]}
          onChange={setScope}
        />
        <NumberField
          label={style === "fillet" ? "רדיוס" : "עומק השיפוע"}
          value={sizeMm}
          min={0.1}
          max={50}
          step={0.1}
          unit="מ״מ"
          onChange={setSizeMm}
        />
        <p className="rounded-md bg-amber-50 p-2 text-[11px] leading-snug text-amber-800">
          שימו לב: הפעולה מעגלת את <b>כל</b> הקצוות מהסוג שנבחר, ולא קצוות
          בודדים שנבחרים בעכבר. זו מגבלה אמיתית של הליבה הגאומטרית — לא
          קיצור דרך. בנוסף, מודלים מורכבים מפושטים לפני החישוב, ולכן פרטים
          דקים מאוד עלולים להיטשטש.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Open shell
// ---------------------------------------------------------------------------

export function ShellDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (settings: ShellSettings) => void;
}) {
  const [wallThicknessMm, setWall] = useState(2);
  const [opening, setOpening] = useState<ShellSettings["opening"]>("top");

  return (
    <Modal
      title="קליפה עם פתח"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton
            variant="primary"
            onClick={() => onConfirm({ wallThicknessMm, opening })}
          >
            החל
          </ModalButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <NumberField
          label="עובי דופן"
          value={wallThicknessMm}
          min={0.2}
          max={50}
          step={0.1}
          unit="מ״מ"
          onChange={setWall}
        />
        <label className="flex items-center justify-between gap-2 text-sm">
          <span className="text-slate-600">פאה פתוחה</span>
          <select
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
            value={opening}
            onChange={(e) => setOpening(e.target.value as ShellSettings["opening"])}
          >
            <option value="top">עליונה</option>
            <option value="bottom">תחתונה</option>
            <option value="front">קדמית</option>
            <option value="back">אחורית</option>
            <option value="left">שמאלית</option>
            <option value="right">ימנית</option>
            <option value="none">ללא פתח (חלול אטום)</option>
          </select>
        </label>
        <p className="text-[11px] leading-snug text-slate-400">
          בניגוד ל״חלול״, כאן נוצר פתח אמיתי — כך מתקבלת קופסה, מגש או כוס
          ולא גוף חלול אטום שדורש חור ניקוז.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Deformers
// ---------------------------------------------------------------------------

type Axis = "x" | "y" | "z";
const AXES: { value: Axis; label: string }[] = [
  { value: "x", label: "X" },
  { value: "y", label: "Y" },
  { value: "z", label: "Z" },
];

export function DeformDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (request: DeformRequest) => void;
}) {
  const [kind, setKind] = useState<DeformRequest["kind"]>("bend");
  const [axis, setAxis] = useState<Axis>("x");
  const [towards, setTowards] = useState<Axis>("z");
  const [degrees, setDegrees] = useState(90);
  const [endScale, setEndScale] = useState(0.5);
  const [amount, setAmount] = useState(1.3);
  const [falloff, setFalloff] = useState(0.4);
  const [center, setCenter] = useState(0.5);

  const confirm = () => {
    switch (kind) {
      case "twist":
        onConfirm({ kind: "twist", settings: { axis, degrees } });
        break;
      case "taper":
        onConfirm({ kind: "taper", settings: { axis, endScale } });
        break;
      case "bend":
        onConfirm({ kind: "bend", settings: { axis, towards, degrees } });
        break;
      case "stretch":
        onConfirm({ kind: "stretch", settings: { axis, center, amount, falloff } });
        break;
      case "ffd":
        // The cage editor is a separate tool; this dialog offers the
        // axis-aligned deformations only.
        break;
    }
  };

  return (
    <Modal
      title="עיוות גוף"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={confirm}>
            החל
          </ModalButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ToggleGroup
          label="סוג עיוות"
          value={kind}
          options={[
            { value: "bend", label: "כיפוף" },
            { value: "twist", label: "פיתול" },
            { value: "taper", label: "התחדדות" },
            { value: "stretch", label: "מתיחה" },
          ]}
          onChange={(v) => setKind(v as DeformRequest["kind"])}
        />
        <ToggleGroup
          label={kind === "bend" ? "ציר הגוף" : "ציר"}
          value={axis}
          options={AXES}
          onChange={setAxis}
        />
        {kind === "bend" && (
          <>
            <ToggleGroup
              label="כיוון הכיפוף"
              value={towards}
              options={AXES.filter((a) => a.value !== axis)}
              onChange={setTowards}
            />
            <NumberField
              label="זווית"
              value={degrees}
              min={-350}
              max={350}
              step={5}
              unit="°"
              onChange={setDegrees}
            />
          </>
        )}
        {kind === "twist" && (
          <NumberField
            label="זווית פיתול כוללת"
            value={degrees}
            min={-1080}
            max={1080}
            step={5}
            unit="°"
            onChange={setDegrees}
          />
        )}
        {kind === "taper" && (
          <NumberField
            label="קנה מידה בקצה העליון"
            value={endScale}
            min={0}
            max={5}
            step={0.05}
            unit="×"
            onChange={setEndScale}
          />
        )}
        {kind === "stretch" && (
          <>
            <NumberField
              label="עוצמה"
              value={amount}
              min={0.1}
              max={4}
              step={0.05}
              unit="×"
              onChange={setAmount}
            />
            <NumberField
              label="מיקום המרכז"
              value={center}
              min={0}
              max={1}
              step={0.05}
              unit=""
              onChange={setCenter}
            />
            <NumberField
              label="רוחב ההשפעה"
              value={falloff}
              min={0.05}
              max={1}
              step={0.05}
              unit=""
              onChange={setFalloff}
            />
          </>
        )}
        <p className="text-[11px] leading-snug text-slate-400">
          העיוות מצפיף את הרשת לפי עוצמתו, כדי שכיפוף ייראה כקשת חלקה ולא
          כהטיה מדורגת. אם הגוף מתקפל על עצמו תתקבל הודעת שגיאה מפורשת.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Lattice
// ---------------------------------------------------------------------------

export function LatticeDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (settings: LatticeSettings) => void;
}) {
  const [kind, setKind] = useState<LatticeSettings["kind"]>("gyroid");
  const [cellSizeMm, setCell] = useState(8);
  const [thicknessMm, setThickness] = useState(1.2);
  const [shellThicknessMm, setShell] = useState(1.6);

  return (
    <Modal
      title="מילוי סריג פנימי"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton
            variant="primary"
            onClick={() => onConfirm({ kind, cellSizeMm, thicknessMm, shellThicknessMm })}
          >
            החל
          </ModalButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ToggleGroup
          label="סוג הסריג"
          value={kind}
          options={[
            { value: "gyroid", label: "ג׳ירואיד" },
            { value: "schwarzP", label: "שוורץ־P" },
            { value: "honeycomb", label: "חלת דבש" },
          ]}
          onChange={setKind}
        />
        <NumberField
          label="גודל תא"
          value={cellSizeMm}
          min={1}
          max={60}
          step={0.5}
          unit="מ״מ"
          onChange={setCell}
        />
        <NumberField
          label="עובי הסריג"
          value={thicknessMm}
          min={0.2}
          max={20}
          step={0.1}
          unit="מ״מ"
          onChange={setThickness}
        />
        <NumberField
          label="עובי המעטפת החיצונית"
          value={shellThicknessMm}
          min={0.4}
          max={30}
          step={0.1}
          unit="מ״מ"
          onChange={setShell}
        />
        <p className="text-[11px] leading-snug text-slate-400">
          בניגוד למילוי של הסלייסר, הסריג הזה הוא גאומטריה אמיתית שנשמרת
          בקובץ — כך התוצאה זהה בכל תוכנת חיתוך. חישוב הסריג כבד; במודלים
          גדולים הוא עשוי לקחת מספר שניות.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export function PatternDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (settings: PatternSettings) => void;
}) {
  const [kind, setKind] = useState<PatternSettings["kind"]>("linear");
  const [count, setCount] = useState(4);
  const [spacingX, setSpacingX] = useState(25);
  const [spacingY, setSpacingY] = useState(0);
  const [spacingZ, setSpacingZ] = useState(0);
  const [countX, setCountX] = useState(3);
  const [countY, setCountY] = useState(3);
  const [gridX, setGridX] = useState(25);
  const [gridY, setGridY] = useState(25);
  const [centerX, setCenterX] = useState(0);
  const [centerY, setCenterY] = useState(0);
  const [totalAngleDeg, setTotalAngle] = useState(360);
  const [rotateCopies, setRotateCopies] = useState(true);
  const [mirrorAxis, setMirrorAxis] = useState<Axis>("x");
  const [mirrorOffset, setMirrorOffset] = useState(0);

  const confirm = () => {
    switch (kind) {
      case "linear":
        onConfirm({
          kind: "linear",
          count,
          spacingMm: { x: spacingX, y: spacingY, z: spacingZ },
        });
        break;
      case "grid":
        onConfirm({ kind: "grid", countX, countY, spacingXMm: gridX, spacingYMm: gridY });
        break;
      case "circular":
        onConfirm({
          kind: "circular",
          count,
          center: { x: centerX, y: centerY },
          totalAngleDeg,
          rotateCopies,
        });
        break;
      case "mirror":
        onConfirm({ kind: "mirror", axis: mirrorAxis, offsetMm: mirrorOffset });
        break;
    }
  };

  return (
    <Modal
      title="מערך עותקים"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={confirm}>
            צור
          </ModalButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ToggleGroup
          label="סוג"
          value={kind}
          options={[
            { value: "linear", label: "קווי" },
            { value: "grid", label: "רשת" },
            { value: "circular", label: "מעגלי" },
            { value: "mirror", label: "שיקוף" },
          ]}
          onChange={setKind}
        />
        {kind === "linear" && (
          <>
            <NumberField label="מספר עותקים" value={count} min={2} max={400} step={1} unit="" onChange={setCount} />
            <NumberField label="מרווח X" value={spacingX} min={-500} max={500} step={1} unit="מ״מ" onChange={setSpacingX} />
            <NumberField label="מרווח Y" value={spacingY} min={-500} max={500} step={1} unit="מ״מ" onChange={setSpacingY} />
            <NumberField label="מרווח Z" value={spacingZ} min={-500} max={500} step={1} unit="מ״מ" onChange={setSpacingZ} />
          </>
        )}
        {kind === "grid" && (
          <>
            <NumberField label="עותקים בציר X" value={countX} min={1} max={40} step={1} unit="" onChange={setCountX} />
            <NumberField label="עותקים בציר Y" value={countY} min={1} max={40} step={1} unit="" onChange={setCountY} />
            <NumberField label="מרווח X" value={gridX} min={-500} max={500} step={1} unit="מ״מ" onChange={setGridX} />
            <NumberField label="מרווח Y" value={gridY} min={-500} max={500} step={1} unit="מ״מ" onChange={setGridY} />
          </>
        )}
        {kind === "circular" && (
          <>
            <NumberField label="מספר עותקים" value={count} min={2} max={400} step={1} unit="" onChange={setCount} />
            <NumberField label="מרכז X" value={centerX} min={-500} max={500} step={1} unit="מ״מ" onChange={setCenterX} />
            <NumberField label="מרכז Y" value={centerY} min={-500} max={500} step={1} unit="מ״מ" onChange={setCenterY} />
            <NumberField label="זווית כוללת" value={totalAngleDeg} min={-360} max={360} step={5} unit="°" onChange={setTotalAngle} />
            <label className="flex items-center justify-between text-sm">
              <span className="text-slate-600">סובב את העותקים עם המעגל</span>
              <input
                type="checkbox"
                checked={rotateCopies}
                onChange={(e) => setRotateCopies(e.target.checked)}
              />
            </label>
          </>
        )}
        {kind === "mirror" && (
          <>
            <ToggleGroup label="ציר השיקוף" value={mirrorAxis} options={AXES} onChange={setMirrorAxis} />
            <NumberField label="מיקום מישור השיקוף" value={mirrorOffset} min={-500} max={500} step={1} unit="מ״מ" onChange={setMirrorOffset} />
          </>
        )}
        <p className="text-[11px] leading-snug text-slate-400">
          העותקים חולקים את נתוני הגוף של המקור, כך שמערך גדול אינו מכפיל את
          צריכת הזיכרון. כל עותק נשאר שכבה נפרדת שניתן לערוך בנפרד.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export interface GeneratorParams {
  [key: string]: number | boolean | string;
}

const GENERATOR_TITLES_HE: Record<GeneratorKind, string> = {
  thread: "מחולל הברגה",
  gear: "מחולל גלגל שיניים",
  enclosure: "מחולל מארז",
  livingHinge: "מחולל ציר חי",
  snapFit: "מחולל תפס",
  toleranceTest: "מחולל מבחן סבולות",
};

export function GeneratorDialog({
  kind,
  onClose,
  onConfirm,
}: {
  kind: GeneratorKind | null;
  onClose: () => void;
  onConfirm: (kind: GeneratorKind, params: GeneratorParams) => void;
}) {
  const [params, setParams] = useState<GeneratorParams>({});
  const value = (key: string, fallback: number): number =>
    typeof params[key] === "number" ? (params[key] as number) : fallback;
  const flag = (key: string, fallback: boolean): boolean =>
    typeof params[key] === "boolean" ? (params[key] as boolean) : fallback;
  const set = (key: string, v: number | boolean | string) =>
    setParams((prev) => ({ ...prev, [key]: v }));

  const field = (
    key: string,
    label: string,
    fallback: number,
    min: number,
    max: number,
    step: number,
    unit = "מ״מ"
  ) => (
    <NumberField
      key={key}
      label={label}
      value={value(key, fallback)}
      min={min}
      max={max}
      step={step}
      unit={unit}
      onChange={(v) => set(key, v)}
    />
  );

  return (
    <Modal
      title={kind ? GENERATOR_TITLES_HE[kind] : ""}
      open={kind !== null}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={() => kind && onConfirm(kind, params)}>
            צור
          </ModalButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {kind === "thread" && (
          <>
            {field("diameterMm", "קוטר נומינלי", 8, 1, 200, 0.5)}
            {field("pitchMm", "פסיעה", 1.25, 0.2, 20, 0.05)}
            {field("lengthMm", "אורך", 20, 1, 300, 1)}
            {field("clearanceMm", "מרווח (לאום בלבד)", 0.4, 0, 2, 0.05)}
            <ToggleGroup
              label="מחלקת התאמה"
              value={String(params.fitClass ?? "normal")}
              options={[
                { value: "tight", label: "הדוקה" },
                { value: "normal", label: "רגילה" },
                { value: "loose", label: "רפויה" },
              ]}
              onChange={(v) => set("fitClass", v)}
            />
            <p className="text-[11px] leading-snug text-slate-400">
              מכפילה את המרווח: הדוקה ×0.5, רגילה ×1, רפויה ×1.75. חלה על
              הברגה פנימית בלבד.
            </p>
            {field("chamferMm", "שיפוע כניסה", 0.6, 0, 3, 0.1)}
            <p className="text-[11px] leading-snug text-slate-400">
              קטימה בשני הקצוות, כדי שהאום יתפוס ישר ולא ייתקע בחוט הראשון.
            </p>
            <label className="flex items-center justify-between text-sm">
              <span className="text-slate-600">הברגה פנימית (אום)</span>
              <input
                type="checkbox"
                checked={flag("internal", false)}
                onChange={(e) => set("internal", e.target.checked)}
              />
            </label>
            <p className="text-[11px] leading-snug text-slate-400">
              הברגה פנימית נוצרת ככלי חיתוך — חסרו אותה מהגוף שלכם בעזרת
              פעולת ״חיסור״.
            </p>
          </>
        )}
        {kind === "gear" && (
          <>
            {field("teeth", "מספר שיניים", 20, 5, 500, 1, "")}
            {field("moduleMm", "מודול", 2, 0.2, 20, 0.1)}
            {field("thicknessMm", "עובי", 6, 0.5, 100, 0.5)}
            {field("boreDiameterMm", "קוטר חור מרכזי", 6, 0, 200, 0.5)}
            {field("backlashMm", "מרווח בין שיניים", 0.1, 0, 2, 0.05)}
            <p className="text-[11px] leading-snug text-slate-400">
              שני גלגלים משתלבים רק אם המודול שלהם זהה. מרחק הצירים הוא
              סכום קטרי הצעד חלקי שתיים.
            </p>
          </>
        )}
        {kind === "enclosure" && (
          <>
            {field("innerWidthMm", "רוחב פנימי", 60, 5, 400, 1)}
            {field("innerDepthMm", "עומק פנימי", 40, 5, 400, 1)}
            {field("innerHeightMm", "גובה פנימי", 25, 5, 400, 1)}
            {field("wallMm", "עובי דופן", 2, 0.4, 20, 0.1)}
            {field("floorMm", "עובי רצפה", 2, 0.4, 20, 0.1)}
            {field("cornerRadiusMm", "רדיוס פינה", 3, 0, 50, 0.5)}
            {field("lipHeightMm", "גובה שפת המכסה", 4, 0, 40, 0.5)}
            {field("clearanceMm", "מרווח בין מכסה לקופסה", 0.2, 0, 2, 0.05)}
          </>
        )}
        {kind === "livingHinge" && (
          <>
            {field("widthMm", "רוחב", 40, 5, 400, 1)}
            {field("lengthMm", "אורך", 30, 5, 400, 1)}
            {field("thicknessMm", "עובי הפאנל", 2, 0.5, 20, 0.1)}
            {field("hingeThicknessMm", "עובי הציר", 0.5, 0.1, 5, 0.05)}
            {field("grooveCount", "מספר חריצים", 3, 1, 40, 1, "")}
            {field("grooveWidthMm", "רוחב חריץ", 1, 0.2, 20, 0.1)}
            <p className="text-[11px] leading-snug text-slate-400">
              עובי ציר מומלץ ל-PLA הוא 0.3–0.6 מ״מ. דק מדי — נשבר; עבה מדי —
              לא מתכופף.
            </p>
          </>
        )}
        {kind === "snapFit" && (
          <>
            {field("lengthMm", "אורך הזרוע", 15, 2, 200, 0.5)}
            {field("widthMm", "רוחב", 6, 1, 100, 0.5)}
            {field("thicknessMm", "עובי הזרוע", 1.5, 0.4, 20, 0.1)}
            {field("hookDepthMm", "עומק הוו", 1, 0.2, 20, 0.1)}
            {field("insertionAngleDeg", "זווית הכנסה", 30, 5, 80, 1, "°")}
            {field("retentionAngleDeg", "זווית החזקה", 75, 30, 90, 1, "°")}
          </>
        )}
        {kind === "toleranceTest" && (
          <>
            {field("pinDiameterMm", "קוטר הפין", 5, 1, 50, 0.5)}
            {field("thicknessMm", "עובי הלוחית", 4, 1, 40, 0.5)}
            {field("spacingMm", "מרווח בין חורים", 12, 2, 100, 1)}
            <p className="text-[11px] leading-snug text-slate-400">
              נוצרים חורים במרווחים 0.1 / 0.2 / 0.3 / 0.4 / 0.5 מ״מ. הדפיסו
              פעם אחת, בדקו איזה חור מתאים, והשתמשו בערך הזה בכל פעולה
              שדורשת מרווח (מחברים, שיבוצים, מארזים, הברגות).
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Mesh inspector
// ---------------------------------------------------------------------------

const SEVERITY_STYLES: Record<ModelIssue["severity"], string> = {
  critical: "border-red-300 bg-red-50 text-red-800",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  ok: "border-emerald-300 bg-emerald-50 text-emerald-800",
};

export function MeshInspectorDialog({
  open,
  diagnosis,
  report,
  busy,
  onClose,
  onNavigate,
  onRepair,
}: {
  open: boolean;
  diagnosis: MeshDiagnosis | null;
  report: MeshRepairReport | null;
  busy: boolean;
  onClose: () => void;
  onNavigate: (location: { x: number; y: number; z: number }) => void;
  onRepair: (options: RepairOptions) => void;
}) {
  const [fillHoles, setFillHoles] = useState(true);
  const [removeShells, setRemoveShells] = useState(true);
  const [allowVoxelRemesh, setAllowVoxel] = useState(true);
  const [voxelSizeMm, setVoxelSize] = useState(0.3);

  return (
    <Modal
      title="בדיקת רשת ותיקון"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>סגור</ModalButton>
          <ModalButton
            variant="primary"
            disabled={busy}
            onClick={() =>
              onRepair({ fillHoles, removeShells, allowVoxelRemesh, voxelSizeMm })
            }
          >
            {busy ? "מתקן…" : "תקן"}
          </ModalButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {diagnosis && (
          <>
            <div className="grid grid-cols-2 gap-1 rounded-md bg-slate-50 p-2 text-[11px] text-slate-600">
              <span>משולשים: {diagnosis.topology.triangleCount.toLocaleString("he-IL")}</span>
              <span>גופים: {diagnosis.topology.componentCount}</span>
              <span>קצוות פתוחים: {diagnosis.topology.boundaryEdgeCount}</span>
              <span>חיתוכים עצמיים: {diagnosis.selfIntersectionCount}</span>
              <span className="col-span-2">
                מצב הליבה: {diagnosis.kernelAccepts ? "תקין" : diagnosis.kernelStatus}
              </span>
            </div>

            {diagnosis.issues.length === 0 ? (
              <p className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-800">
                לא נמצאו תקלות ברשת.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {diagnosis.issues.map((issue) => (
                  <li
                    key={issue.code}
                    className={`rounded-md border p-2 text-xs ${SEVERITY_STYLES[issue.severity]}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <b>{issue.titleHe}</b>
                      {issue.location && (
                        <button
                          type="button"
                          className="shrink-0 rounded border border-current px-1.5 py-0.5 text-[10px]"
                          onClick={() => onNavigate(issue.location as { x: number; y: number; z: number })}
                        >
                          הצג
                        </button>
                      )}
                    </div>
                    <p className="mt-0.5 leading-snug">{issue.detailHe}</p>
                    {issue.actionHe && (
                      <p className="mt-1 font-medium leading-snug">← {issue.actionHe}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="flex flex-col gap-1.5 border-t border-slate-200 pt-2">
          <p className="text-xs font-bold text-slate-500">שלבי התיקון המותרים</p>
          <label className="flex items-center justify-between text-sm">
            <span className="text-slate-600">סגירת חורים (מוסיף גאומטריה)</span>
            <input type="checkbox" checked={fillHoles} onChange={(e) => setFillHoles(e.target.checked)} />
          </label>
          <label className="flex items-center justify-between text-sm">
            <span className="text-slate-600">הסרת שאריות וקליפות כלואות</span>
            <input type="checkbox" checked={removeShells} onChange={(e) => setRemoveShells(e.target.checked)} />
          </label>
          <label className="flex items-center justify-between text-sm">
            <span className="text-slate-600">בנייה מחדש (Voxel) כמוצא אחרון</span>
            <input type="checkbox" checked={allowVoxelRemesh} onChange={(e) => setAllowVoxel(e.target.checked)} />
          </label>
          {allowVoxelRemesh && (
            <NumberField
              label="רזולוציית הבנייה מחדש"
              value={voxelSizeMm}
              min={0.05}
              max={5}
              step={0.05}
              unit="מ״מ"
              onChange={setVoxelSize}
            />
          )}
          <p className="text-[11px] leading-snug text-slate-400">
            התיקון מתחיל בשלבים שאינם משנים גאומטריה (איחוי, ניקוי, כיוונים)
            ומסלים רק אם צריך. בנייה מחדש פותרת כמעט כל תקלה — אך מאבדת
            פרטים דקים מהרזולוציה שנבחרה.
          </p>
        </div>

        {report && (
          <div className="border-t border-slate-200 pt-2">
            <p className="text-xs font-bold text-slate-500">מה בוצע</p>
            <p
              className={`mt-1 text-sm ${report.succeeded ? "text-emerald-700" : "text-red-700"}`}
            >
              {report.messageHe}
            </p>
            {report.stages.length > 0 && (
              <ul className="mt-1 list-inside list-disc text-[11px] text-slate-500">
                {report.stages.map((stage) => (
                  <li key={stage.stage}>{stage.messageHe}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Interference report
// ---------------------------------------------------------------------------

export function InterferenceDialog({
  open,
  report,
  onClose,
  onNavigate,
}: {
  open: boolean;
  report: InterferenceReport | null;
  onClose: () => void;
  onNavigate: (location: { x: number; y: number; z: number }) => void;
}) {
  return (
    <Modal
      title="בדיקת חדירה בין חלקים"
      open={open}
      onClose={onClose}
      footer={<ModalButton variant="primary" onClick={onClose}>סגור</ModalButton>}
    >
      {report && (
        <div className="flex flex-col gap-2">
          <p className={`text-sm ${report.pairs.length === 0 ? "text-emerald-700" : "text-red-700"}`}>
            {report.summaryHe}
          </p>
          {report.pairs.map((pair) => (
            <div
              key={`${pair.layerIdA}-${pair.layerIdB}`}
              className="rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800"
            >
              <div className="flex items-start justify-between gap-2">
                <b>
                  {pair.nameA} ↔ {pair.nameB}
                </b>
                <button
                  type="button"
                  className="shrink-0 rounded border border-current px-1.5 py-0.5 text-[10px]"
                  onClick={() => onNavigate(pair.location)}
                >
                  הצג
                </button>
              </div>
              <p className="mt-0.5">
                נפח חופף: {pair.overlapVolumeMm3.toFixed(2)} ממ״ק (
                {(pair.overlapFraction * 100).toFixed(1)}% מהחלק הקטן)
              </p>
            </div>
          ))}
          {report.pairs.length > 0 && (
            <p className="text-[11px] leading-snug text-slate-400">
              חלקים שחודרים זה לזה לא יורכבו אחרי ההדפסה. השתמשו ב״חיסור״
              כדי לפנות מקום, או הזיזו אחד מהם.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Modifier editing
// ---------------------------------------------------------------------------

/**
 * Edit a modifier's parameters in place.
 *
 * Generic over the modifier union: every modifier is a flat record of
 * numbers and short enums, so the dialog reflects over its own fields rather
 * than hard-coding one form per kind. That keeps a new modifier kind from
 * needing a new dialog, and — more importantly — makes it obvious that
 * editing writes back into the STACK rather than baking a new mesh.
 */
const MODIFIER_FIELD_LABELS_HE: Record<string, string> = {
  sizeMm: "גודל (מ״מ)",
  style: "סוג",
  scope: "היקף",
  wallThicknessMm: "עובי דופן (מ״מ)",
  opening: "פאה פתוחה",
  axis: "ציר",
  towards: "כיוון",
  degrees: "זווית (°)",
  endScale: "קנה מידה בקצה",
  center: "מרכז (0..1)",
  amount: "עוצמה",
  falloff: "רוחב השפעה",
  latticeKind: "סוג סריג",
  cellSizeMm: "גודל תא (מ״מ)",
  thicknessMm: "עובי (מ״מ)",
  shellThicknessMm: "עובי מעטפת (מ״מ)",
  targetEdgeMm: "אורך צלע (מ״מ)",
  iterations: "מחזורים",
  featureAngleDeg: "זווית מאפיין (°)",
  toleranceMm: "סבילות (מ״מ)",
  minSharpAngleDeg: "זווית חדה (°)",
  refineEdgeMm: "צפיפות (מ״מ)",
};

const MODIFIER_ENUM_OPTIONS: Record<string, string[]> = {
  style: ["fillet", "chamfer"],
  scope: ["convex", "concave", "both"],
  axis: ["x", "y", "z"],
  towards: ["x", "y", "z"],
  opening: ["top", "bottom", "front", "back", "left", "right", "none"],
  latticeKind: ["gyroid", "schwarzP", "honeycomb"],
};

export function ModifierEditDialog({
  modifier,
  onClose,
  onChange,
}: {
  modifier: Modifier | null;
  onClose: () => void;
  onChange: (next: Modifier) => void;
}) {
  if (!modifier) return null;
  const entries = Object.entries(modifier).filter(
    ([key]) => key !== "id" && key !== "kind" && key !== "enabled"
  );

  return (
    <Modal
      title={`עריכת ${MODIFIER_NAMES_HE[modifier.kind]}`}
      open
      onClose={onClose}
      footer={<ModalButton variant="primary" onClick={onClose}>סגור</ModalButton>}
    >
      <div className="flex flex-col gap-3">
        {entries.map(([key, value]) => {
          const label = MODIFIER_FIELD_LABELS_HE[key] ?? key;
          const options = MODIFIER_ENUM_OPTIONS[key];
          if (options && typeof value === "string") {
            return (
              <label key={key} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-600">{label}</span>
                <select
                  className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                  value={value}
                  onChange={(e) =>
                    onChange({ ...modifier, [key]: e.target.value } as Modifier)
                  }
                >
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            );
          }
          if (typeof value !== "number") return null;
          return (
            <NumberField
              key={key}
              label={label}
              value={value}
              min={-1080}
              max={1080}
              step={0.1}
              unit=""
              onChange={(v) => onChange({ ...modifier, [key]: v } as Modifier)}
            />
          );
        })}
        <p className="text-[11px] leading-snug text-slate-400">
          השינוי מחושב מחדש מהגוף המקורי — לא נערמות פעולות זו על זו, ואפשר
          לחזור ולשנות כל פרמטר בכל שלב.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

export function RecoveryDialog({
  snapshot,
  ageHe,
  onRestore,
  onDismiss,
}: {
  snapshot: { savedAt: string; layerCount: number } | null;
  /** How long ago the snapshot was taken, in Hebrew. */
  ageHe: string;
  onRestore: () => void;
  onDismiss: (disableFuture: boolean) => void;
}) {
  return (
    <Modal
      title="נמצאה עבודה קודמת"
      open={snapshot !== null}
      onClose={() => onDismiss(false)}
      footer={
        <>
          <ModalButton onClick={() => onDismiss(false)}>התחל מחדש</ModalButton>
          <ModalButton variant="primary" onClick={onRestore}>
            שחזר
          </ModalButton>
        </>
      }
    >
      {snapshot && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-slate-600">
            נשמר עותק מקומי של העבודה האחרונה {ageHe} ({snapshot.layerCount}{" "}
            שכבות). רוצים לשחזר אותו?
          </p>
          <p className="text-[11px] leading-snug text-slate-400">
            העותק נשמר <b>בדפדפן הזה בלבד</b> — אין חשבון, אין שרת ואין סנכרון
            בין מכשירים. זו משבצת אחת שנדרסת בכל שמירה, ונועדה רק כדי שרענון
            או קריסה לא ימחקו שעת עבודה.
          </p>
          <label className="flex items-center gap-2 text-xs text-slate-500">
            <input
              type="checkbox"
              onChange={(e) => {
                if (e.target.checked) onDismiss(true);
              }}
            />
            אל תשמור עותק מקומי בעתיד
          </label>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Revolve
// ---------------------------------------------------------------------------

export function RevolveDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (settings: RevolveSettings) => void;
}) {
  const [degreesSwept, setDegrees] = useState(360);
  const [segments, setSegments] = useState(64);
  const [axisOffsetMm, setAxisOffset] = useState(10);

  return (
    <Modal
      title="סיבוב פרופיל (Revolve)"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton
            variant="primary"
            onClick={() => onConfirm({ degreesSwept, segments, axisOffsetMm })}
          >
            צור
          </ModalButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <NumberField label="זווית סיבוב" value={degreesSwept} min={1} max={360} step={5} unit="°" onChange={setDegrees} />
        <NumberField label="מרחק מציר הסיבוב" value={axisOffsetMm} min={0} max={500} step={0.5} unit="מ״מ" onChange={setAxisOffset} />
        <NumberField label="חלקות (מקטעים)" value={segments} min={8} max={256} step={1} unit="" onChange={setSegments} />
        <p className="text-[11px] leading-snug text-slate-400">
          הפרופיל מסתובב סביב ציר אנכי שנמצא משמאלו. ״מרחק מציר הסיבוב״
          קובע את הרדיוס הפנימי — כך יוצרים כוס, אגרטל, כפתור או גלגלת.
          פרופיל שחוצה את הציר יידחה עם הסבר.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Curved-surface emboss
// ---------------------------------------------------------------------------

export function EmbossDialog({
  open,
  artworkName,
  targetOptions,
  onClose,
  onConfirm,
}: {
  open: boolean;
  artworkName: string;
  /** Candidate target bodies (everything except the artwork layer). */
  targetOptions: { id: string; nameHe: string }[];
  onClose: () => void;
  onConfirm: (targetLayerId: string, request: EmbossRequest) => void;
}) {
  const [targetId, setTargetId] = useState("");
  const [method, setMethod] = useState<EmbossRequest["method"]>("cylinder");
  const [mode, setMode] = useState<EmbossRequest["mode"]>("raised");
  const [depthMm, setDepth] = useState(1);
  const [radiusMm, setRadius] = useState(20);
  const [axis, setAxis] = useState<"x" | "y" | "z">("z");
  const [aroundDeg, setAround] = useState(0);
  const [alongMm, setAlong] = useState(0);
  const [dirAxis, setDirAxis] = useState<"x" | "y" | "z">("z");
  const [dirSign, setDirSign] = useState(-1);

  const effectiveTarget = targetId || targetOptions[0]?.id || "";

  return (
    <Modal
      title="הטבעה על משטח מעוקל"
      open={open}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton
            variant="primary"
            disabled={!effectiveTarget}
            onClick={() =>
              onConfirm(effectiveTarget, {
                method,
                mode,
                depthMm,
                radiusMm,
                axis,
                aroundDeg,
                alongMm,
                direction: {
                  x: dirAxis === "x" ? dirSign : 0,
                  y: dirAxis === "y" ? dirSign : 0,
                  z: dirAxis === "z" ? dirSign : 0,
                },
              })
            }
          >
            החל
          </ModalButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-slate-500">
          הכיתוב: <b>{artworkName}</b>
        </p>
        {targetOptions.length === 0 ? (
          <p className="rounded-md bg-amber-50 p-2 text-[11px] text-amber-800">
            אין גוף יעד להטבעה. הוסיפו גוף (למשל גליל) ובחרו את שכבת הכיתוב.
          </p>
        ) : (
          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="text-slate-600">גוף היעד</span>
            <select
              className="max-w-[60%] rounded-md border border-slate-300 px-2 py-1 text-sm"
              value={effectiveTarget}
              onChange={(e) => setTargetId(e.target.value)}
            >
              {targetOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.nameHe}
                </option>
              ))}
            </select>
          </label>
        )}

        <ToggleGroup
          label="שיטה"
          value={method}
          options={[
            { value: "cylinder", label: "עטיפה על גליל" },
            { value: "project", label: "הקרנה על משטח" },
          ]}
          onChange={(v) => setMethod(v as EmbossRequest["method"])}
        />
        <ToggleGroup
          label="סוג"
          value={mode}
          options={[
            { value: "raised", label: "בולט" },
            { value: "engraved", label: "חרוט" },
          ]}
          onChange={(v) => setMode(v as EmbossRequest["mode"])}
        />
        <NumberField label="עומק/גובה" value={depthMm} min={0.1} max={20} step={0.1} unit="מ״מ" onChange={setDepth} />

        {method === "cylinder" ? (
          <>
            <NumberField label="רדיוס הגליל" value={radiusMm} min={1} max={500} step={0.5} unit="מ״מ" onChange={setRadius} />
            <ToggleGroup label="ציר הגליל" value={axis} options={AXES} onChange={setAxis} />
            <NumberField label="סיבוב סביב הגליל" value={aroundDeg} min={-360} max={360} step={5} unit="°" onChange={setAround} />
            <NumberField label="הזזה לאורך הציר" value={alongMm} min={-500} max={500} step={1} unit="מ״מ" onChange={setAlong} />
            <p className="text-[11px] leading-snug text-slate-400">
              רדיוס הגליל חייב להתאים לרדיוס גוף היעד, אחרת הכיתוב ירחף
              מעליו או ייבלע בתוכו.
            </p>
          </>
        ) : (
          <>
            <ToggleGroup label="ציר ההקרנה" value={dirAxis} options={AXES} onChange={setDirAxis} />
            <ToggleGroup
              label="כיוון"
              value={String(dirSign)}
              options={[
                { value: "-1", label: "שלילי (מלמעלה למטה)" },
                { value: "1", label: "חיובי" },
              ]}
              onChange={(v) => setDirSign(Number(v))}
            />
            <p className="text-[11px] leading-snug text-slate-400">
              ההקרנה מתאימה לכיפות ולמשטחים חופשיים. אם רק חלק מהכיתוב פוגע
              במשטח — תופיע אזהרה עם האחוז שנחת בפועל.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
