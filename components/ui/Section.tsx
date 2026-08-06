import type { ReactNode } from "react";

interface SectionProps {
  title: string;
  children: ReactNode;
}

/** A titled group of controls in the editor panel. */
export function Section({ title, children }: SectionProps) {
  return (
    <section className="border-b border-slate-200 px-4 py-4">
      <h2 className="mb-3 text-sm font-bold text-slate-700">{title}</h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}
