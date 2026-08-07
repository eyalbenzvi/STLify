"use client";

/**
 * Keyboard shortcut help + remapping (V6 item 18).
 *
 * Every action is listed with its current binding; editable ones can be
 * re-bound by capturing the next key press. The mapping is stored in
 * localStorage on this device only, and a reset returns the defaults.
 */

import { useCallback, useState } from "react";
import {
  bindingFromEvent,
  bindingMatches,
  formatBinding,
  KEY_ACTIONS,
  resetKeymap,
  saveKeymap,
  type KeyActionId,
  type Keymap,
} from "@/lib/keyboard/keymap";
import { Modal, ModalButton } from "@/components/ui/Modal";

export interface ShortcutsDialogProps {
  open: boolean;
  keymap: Keymap;
  onClose: () => void;
  onChange: (keymap: Keymap) => void;
}

export function ShortcutsDialog({ open, keymap, onClose, onChange }: ShortcutsDialogProps) {
  const [capturing, setCapturing] = useState<KeyActionId | null>(null);
  const [noteHe, setNoteHe] = useState<string | null>(null);

  const handleCaptureKey = useCallback(
    (event: React.KeyboardEvent) => {
      if (!capturing) return;
      event.preventDefault();
      event.stopPropagation();
      const binding = bindingFromEvent(event.nativeEvent);
      if (!binding) return; // a bare modifier — keep waiting
      // Refuse a collision instead of silently shadowing another action.
      const clash = KEY_ACTIONS.find(
        (action) =>
          action.id !== capturing &&
          bindingMatches(
            { code: binding.code, ctrlKey: !!binding.ctrl, metaKey: false, shiftKey: !!binding.shift } as KeyboardEvent,
            keymap[action.id]
          )
      );
      if (clash) {
        setNoteHe(`הצירוף ${formatBinding(binding)} כבר משמש את "${clash.nameHe}"`);
        setCapturing(null);
        return;
      }
      const next = { ...keymap, [capturing]: binding };
      saveKeymap(next);
      onChange(next);
      setNoteHe(null);
      setCapturing(null);
    },
    [capturing, keymap, onChange]
  );

  return (
    <Modal
      title="קיצורי מקלדת"
      open={open}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between">
          <ModalButton
            onClick={() => {
              onChange(resetKeymap());
              setNoteHe(null);
              setCapturing(null);
            }}
          >
            איפוס לברירת המחדל
          </ModalButton>
          <ModalButton variant="primary" onClick={onClose}>
            סגירה
          </ModalButton>
        </div>
      }
    >
      {/* Key capture happens on this container so the page-level handler
          never sees the pressed key. */}
      <div onKeyDown={handleCaptureKey} className="flex flex-col gap-1 text-sm">
        <p className="text-xs text-slate-500">
          המיפוי נשמר בדפדפן הזה בלבד. Esc תמיד חוזר לכלי הבחירה.
        </p>
        {noteHe && <p className="text-xs text-red-600">{noteHe}</p>}
        <ul className="flex flex-col gap-0.5">
          {KEY_ACTIONS.map((action) => (
            <li
              key={action.id}
              className="flex items-center justify-between gap-2 rounded px-1 py-0.5 hover:bg-slate-50"
              data-testid="shortcut-row"
            >
              <span className="text-slate-700">{action.nameHe}</span>
              <span className="flex items-center gap-1">
                <kbd
                  dir="ltr"
                  className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-600"
                >
                  {capturing === action.id ? "הקישו…" : formatBinding(keymap[action.id])}
                </kbd>
                {action.editable && (
                  <button
                    type="button"
                    className="rounded border border-slate-200 px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100"
                    aria-label={`שינוי קיצור: ${action.nameHe}`}
                    onClick={() => {
                      setCapturing(capturing === action.id ? null : action.id);
                      setNoteHe(null);
                    }}
                  >
                    {capturing === action.id ? "ביטול" : "שינוי"}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
