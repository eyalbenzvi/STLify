"use client";

/**
 * The deformer dialog: twist, taper, bend, stretch and free-form.
 *
 * One dialog rather than five, because the deformers share their frame —
 * an axis to act about and an amount — and differ only in the two or three
 * numbers that describe the amount. `confirm` is where the shared form
 * becomes the specific typed request each deformer wants.
 */

import { useState } from "react";
import { Modal, ModalButton } from "@/components/ui/Modal";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import type { DeformRequest } from "@/lib/geometry/operations/advancedOps";
import type { Axis } from "@/types/design";
import { AXIS_OPTIONS } from "./axisOptions";

// ---------------------------------------------------------------------------
// Deformers
// ---------------------------------------------------------------------------


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
          options={AXIS_OPTIONS}
          onChange={setAxis}
        />
        {kind === "bend" && (
          <>
            <ToggleGroup
              label="כיוון הכיפוף"
              value={towards}
              options={AXIS_OPTIONS.filter((a) => a.value !== axis)}
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
