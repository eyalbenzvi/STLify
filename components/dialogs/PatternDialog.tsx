"use client";

/**
 * Array patterns: linear, circular, grid and mirror copies of a layer.
 *
 * Unlike the reshaping dialogs this one produces new LAYERS rather than a
 * replacement body, so it runs entirely on transform maths and never
 * touches the geometry kernel.
 */

import { useState } from "react";
import { Modal, ModalButton } from "@/components/ui/Modal";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import type { PatternSettings } from "@/lib/geometry/operations/pattern";
import type { Axis } from "@/types/design";
import { AXIS_OPTIONS } from "./axisOptions";

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
            <ToggleGroup label="ציר השיקוף" value={mirrorAxis} options={AXIS_OPTIONS} onChange={setMirrorAxis} />
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
