"use client";

/**
 * Accessible modal: real focus trap, Escape to close, focus restored to the
 * control that opened it, backdrop click closes, RTL-friendly.
 *
 * "Focus-trap-lite" (autofocus only) was not a trap at all: Tab walked
 * straight out of the dialog into the editor behind it, so a keyboard user
 * ended up operating controls they could not see while a modal claimed to be
 * modal. Since every geometry operation is configured through one of these,
 * that made the whole feature set keyboard-hostile.
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
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const focusable = (): HTMLElement[] => {
      const root = ref.current;
      if (!root) return [];
      return [
        ...root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ),
      ].filter((el) => el.offsetParent !== null || el === document.activeElement);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        ref.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // Wrap at both ends so focus can never leave the dialog.
      if (e.shiftKey && (active === first || active === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    // Prefer the first real control; fall back to the dialog itself.
    const items = focusable();
    (items[0] ?? ref.current)?.focus();

    return () => {
      window.removeEventListener("keydown", onKey);
      // Returning focus is what makes a dialog feel like a detour rather than
      // a teleport: the user resumes exactly where they were.
      previouslyFocused.current?.focus?.();
    };
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
