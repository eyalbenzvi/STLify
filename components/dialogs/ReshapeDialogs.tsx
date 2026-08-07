"use client";

/**
 * Parameter dialogs for the operations that reshape ONE body: rounding or
 * chamfering its edges, hollowing it into a shell with an opening,
 * revolving a 2D profile into a solid of revolution, and pressing artwork
 * into a curved surface.
 *
 * They share a shape as well as a subject — a few numbers, a toggle or
 * two, and a short honest note about what the operation cannot do. Those
 * notes are load-bearing: whole-body rounding and profile revolution both
 * have real limits, and hiding them produces bug reports rather than
 * better models.
 */

import { useState } from "react";
import { Modal, ModalButton } from "@/components/ui/Modal";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import type { FilletSettings, ShellSettings } from "@/lib/geometry/operations/fillet";
import type { EmbossRequest, RevolveSettings } from "@/lib/geometry/operations/advancedOps";
import type { Axis } from "@/types/design";
import { AXIS_OPTIONS } from "./axisOptions";

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
  const [axis, setAxis] = useState<Axis>("z");
  const [aroundDeg, setAround] = useState(0);
  const [alongMm, setAlong] = useState(0);
  const [dirAxis, setDirAxis] = useState<Axis>("z");
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
            <ToggleGroup label="ציר הגליל" value={axis} options={AXIS_OPTIONS} onChange={setAxis} />
            <NumberField label="סיבוב סביב הגליל" value={aroundDeg} min={-360} max={360} step={5} unit="°" onChange={setAround} />
            <NumberField label="הזזה לאורך הציר" value={alongMm} min={-500} max={500} step={1} unit="מ״מ" onChange={setAlong} />
            <p className="text-[11px] leading-snug text-slate-400">
              רדיוס הגליל חייב להתאים לרדיוס גוף היעד, אחרת הכיתוב ירחף
              מעליו או ייבלע בתוכו.
            </p>
          </>
        ) : (
          <>
            <ToggleGroup label="ציר ההקרנה" value={dirAxis} options={AXIS_OPTIONS} onChange={setDirAxis} />
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
