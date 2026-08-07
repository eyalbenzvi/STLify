"use client";

/**
 * Creation panel: add parametric primitives, an empty sketch, or a generated
 * part (thread, gear, enclosure, living hinge, snap-fit, tolerance coupon).
 *
 * Before V4 the editor could only create geometry by importing something —
 * there was no way to add so much as a cube. This is the entry point for
 * modelling from nothing.
 */

import type { PrimitiveKind } from "@/types/design";

export type GeneratorKind =
  | "thread"
  | "gear"
  | "enclosure"
  | "livingHinge"
  | "snapFit"
  | "toleranceTest";

const PRIMITIVES: { kind: PrimitiveKind; labelHe: string; icon: string }[] = [
  { kind: "box", labelHe: "תיבה", icon: "▬" },
  { kind: "cylinder", labelHe: "גליל", icon: "▮" },
  { kind: "sphere", labelHe: "כדור", icon: "●" },
  { kind: "cone", labelHe: "חרוט", icon: "▲" },
  { kind: "torus", labelHe: "טבעת", icon: "◎" },
  { kind: "wedge", labelHe: "טריז", icon: "◺" },
  { kind: "tube", labelHe: "צינור", icon: "⬭" },
];

const GENERATORS: { kind: GeneratorKind; labelHe: string; hintHe: string }[] = [
  { kind: "thread", labelHe: "הברגה", hintHe: "בורג או אום בתקן ISO" },
  { kind: "gear", labelHe: "גלגל שיניים", hintHe: "פרופיל אבולבנטי אמיתי" },
  { kind: "enclosure", labelHe: "מארז", hintHe: "קופסה עם מכסה מותאם" },
  { kind: "livingHinge", labelHe: "ציר חי", hintHe: "פאנל מתקפל" },
  { kind: "snapFit", labelHe: "תפס", hintHe: "וו הצמדה גמיש" },
  { kind: "toleranceTest", labelHe: "מבחן סבולות", hintHe: "כיול דיוק המדפסת" },
];

export interface CreatePanelProps {
  busy: boolean;
  onAddPrimitive: (kind: PrimitiveKind) => void;
  onAddSketch: () => void;
  onOpenGenerator: (kind: GeneratorKind) => void;
}

function CreateButton({
  labelHe,
  title,
  disabled,
  onClick,
  children,
}: {
  labelHe: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title ?? labelHe}
      onClick={onClick}
      className="flex flex-col items-center gap-0.5 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
      <span>{labelHe}</span>
    </button>
  );
}

export function CreatePanel(props: CreatePanelProps) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">גופים בסיסיים</p>
        <div className="grid grid-cols-4 gap-1">
          {PRIMITIVES.map((p) => (
            <CreateButton
              key={p.kind}
              labelHe={p.labelHe}
              disabled={props.busy}
              onClick={() => props.onAddPrimitive(p.kind)}
            >
              <span aria-hidden className="text-base leading-none">
                {p.icon}
              </span>
            </CreateButton>
          ))}
          <CreateButton
            labelHe="סקיצה"
            title="ציור דו־ממדי חופשי שניתן להוציא לגובה"
            disabled={props.busy}
            onClick={props.onAddSketch}
          >
            <span aria-hidden className="text-base leading-none">
              ✐
            </span>
          </CreateButton>
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-bold text-slate-500">חלקים פרמטריים</p>
        <div className="flex flex-wrap gap-1">
          {GENERATORS.map((g) => (
            <button
              key={g.kind}
              type="button"
              disabled={props.busy}
              title={g.hintHe}
              onClick={() => props.onOpenGenerator(g.kind)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-35"
            >
              {g.labelHe}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
