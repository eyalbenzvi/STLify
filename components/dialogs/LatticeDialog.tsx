"use client";

/**
 * Lattice infill: replace a solid interior with a periodic minimal surface
 * (gyroid, Schwarz-P) or a honeycomb.
 *
 * The printability of the result depends on the printer's nozzle, which
 * this dialog deliberately does not ask for — the editor supplies the
 * document's own nozzle diameter when it runs the job.
 */

import { useState } from "react";
import { Modal, ModalButton } from "@/components/ui/Modal";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import type { LatticeSettings } from "@/lib/geometry/operations/lattice";

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
