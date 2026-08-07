"use client";

/**
 * The crash-recovery offer.
 *
 * Shown once on startup when a snapshot exists. Dismissing it can also
 * switch recovery off permanently — the feature writes to this device's
 * IndexedDB, and a user who does not want that must be able to say so.
 */

import { Modal, ModalButton } from "@/components/ui/Modal";

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

export function RecoveryDialog({
  snapshot,
  ageHe,
  onRestore,
  onDismiss,
}: {
  snapshot: { savedAt: string; layerCount: number } | null;
  /** How long ago the snapshot was taken, in Hebrew. */
  ageHe: string;
  onRestore: () => void;
  onDismiss: (disableFuture: boolean) => void;
}) {
  return (
    <Modal
      title="נמצאה עבודה קודמת"
      open={snapshot !== null}
      onClose={() => onDismiss(false)}
      footer={
        <>
          <ModalButton onClick={() => onDismiss(false)}>התחל מחדש</ModalButton>
          <ModalButton variant="primary" onClick={onRestore}>
            שחזר
          </ModalButton>
        </>
      }
    >
      {snapshot && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-slate-600">
            נשמר עותק מקומי של העבודה האחרונה {ageHe} ({snapshot.layerCount}{" "}
            שכבות). רוצים לשחזר אותו?
          </p>
          <p className="text-[11px] leading-snug text-slate-400">
            העותק נשמר <b>בדפדפן הזה בלבד</b> — אין חשבון, אין שרת ואין סנכרון
            בין מכשירים. זו משבצת אחת שנדרסת בכל שמירה, ונועדה רק כדי שרענון
            או קריסה לא ימחקו שעת עבודה.
          </p>
          <label className="flex items-center gap-2 text-xs text-slate-500">
            <input
              type="checkbox"
              onChange={(e) => {
                if (e.target.checked) onDismiss(true);
              }}
            />
            אל תשמור עותק מקומי בעתיד
          </label>
        </div>
      )}
    </Modal>
  );
}
