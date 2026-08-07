"use client";

/**
 * The parametric-generator dialog.
 *
 * One generic renderer rather than six hand-written forms: the fields, their
 * ranges, their defaults and their Hebrew explanations all come from
 * GENERATOR_SPECS, which is also what the build handler reads. That is the
 * point — a dialog and a builder that disagree about a default produce a
 * part that is not the part the user was shown.
 */

import { useState } from "react";
import { Modal, ModalButton } from "@/components/ui/Modal";
import { NumberField } from "@/components/ui/NumberField";
import { ToggleGroup } from "@/components/ui/ToggleGroup";
import {
  GENERATOR_SPECS,
  type GeneratorFieldSpec,
  type GeneratorKind,
  type GeneratorParams,
} from "@/lib/geometry/generators/specs";

const HINT_CLASS = "text-[11px] leading-snug text-slate-400";

function GeneratorField({
  spec,
  params,
  onChange,
}: {
  spec: GeneratorFieldSpec;
  params: GeneratorParams;
  onChange: (key: string, value: number | boolean | string) => void;
}) {
  const stored = params[spec.key];
  return (
    <>
      {spec.kind === "number" && (
        <NumberField
          label={spec.labelHe}
          value={typeof stored === "number" ? stored : spec.defaultValue}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          unit={spec.unitHe ?? "מ״מ"}
          onChange={(v) => onChange(spec.key, v)}
        />
      )}
      {spec.kind === "boolean" && (
        <label className="flex items-center justify-between text-sm">
          <span className="text-slate-600">{spec.labelHe}</span>
          <input
            type="checkbox"
            checked={typeof stored === "boolean" ? stored : spec.defaultValue}
            onChange={(e) => onChange(spec.key, e.target.checked)}
          />
        </label>
      )}
      {spec.kind === "choice" && (
        <ToggleGroup
          label={spec.labelHe}
          value={typeof stored === "string" ? stored : spec.defaultValue}
          options={spec.options.map((o) => ({ value: o.value, label: o.labelHe }))}
          onChange={(v) => onChange(spec.key, v)}
        />
      )}
      {spec.hintHe && <p className={HINT_CLASS}>{spec.hintHe}</p>}
    </>
  );
}

export function GeneratorDialog({
  kind,
  onClose,
  onConfirm,
}: {
  kind: GeneratorKind | null;
  onClose: () => void;
  onConfirm: (kind: GeneratorKind, params: GeneratorParams) => void;
}) {
  // Only the fields the user touched are stored; every other read falls back
  // to the spec's default, so the two never disagree.
  const [params, setParams] = useState<GeneratorParams>({});
  const spec = kind ? GENERATOR_SPECS[kind] : null;

  return (
    <Modal
      title={spec?.titleHe ?? ""}
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
        {spec?.fields.map((field) => (
          <GeneratorField
            key={field.key}
            spec={field}
            params={params}
            onChange={(key, value) => setParams((prev) => ({ ...prev, [key]: value }))}
          />
        ))}
        {spec?.noteHe && <p className={HINT_CLASS}>{spec.noteHe}</p>}
      </div>
    </Modal>
  );
}
