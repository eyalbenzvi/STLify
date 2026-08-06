"use client";

/**
 * Minimal accessible modal: focus trap-lite (autofocus + Escape to close),
 * backdrop click closes, RTL-friendly.
 */

import { useEffect, useRef, type ReactNode } from "react";

export interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Modal({ title, open, onClose, children, footer, wide }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`max-h-[85dvh] w-full ${wide ? "max-w-2xl" : "max-w-md"} overflow-y-auto rounded-lg bg-white p-4 shadow-xl outline-none`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-800">{title}</h2>
          <button
            type="button"
            aria-label="סגירה"
            className="rounded px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="flex flex-col gap-3">{children}</div>
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function ModalButton({
  children,
  onClick,
  variant = "secondary",
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
}) {
  const styles =
    variant === "primary"
      ? "bg-blue-600 text-white hover:bg-blue-700"
      : variant === "danger"
        ? "bg-red-600 text-white hover:bg-red-700"
        : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50";
  return (
    <button
      type="button"
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
