"use client";

import type { ReactNode } from "react";
import { DangerButton, Modal, PrimaryButton, SecondaryButton } from "./Modal";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Simple Hebrew confirmation dialog. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "ביטול",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      open={open}
      onClose={onCancel}
      footer={
        <>
          <SecondaryButton onClick={onCancel}>{cancelLabel}</SecondaryButton>
          {danger ? (
            <DangerButton onClick={onConfirm}>{confirmLabel}</DangerButton>
          ) : (
            <PrimaryButton onClick={onConfirm}>{confirmLabel}</PrimaryButton>
          )}
        </>
      }
    >
      <div className="text-sm leading-relaxed text-slate-700">{message}</div>
    </Modal>
  );
}
