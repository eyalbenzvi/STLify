"use client";

/**
 * Orientation-suggestion dialog and the base-mode switch explanation.
 */

import type { OrientationCandidate } from "@/lib/geometry/analysis/orientation";
import type { BaseMode } from "@/types/design";
import { Modal, ModalButton } from "@/components/ui/Modal";

export function OrientationDialog({
  candidates,
  onApply,
  onClose,
}: {
  candidates: OrientationCandidate[] | null;
  onApply: (candidate: OrientationCandidate) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="הצעות תנוחת הדפסה"
      open={candidates !== null}
      onClose={onClose}
      wide
      footer={<ModalButton onClick={onClose}>סגירה</ModalButton>}
    >
      <p className="text-xs text-slate-500">
        הציון משקלל שטח מגע, גובה ושטח משטחים תלויים — הנוסחה מוצגת לצד כל
        הצעה. הניתוח הוא המלצה. יש לבדוק תמיכות סופיות בתוכנת הסלייסר.
      </p>
      <ul className="flex flex-col gap-2">
        {(candidates ?? []).map((candidate, index) => (
          <li
            key={candidate.id}
            className="flex items-center justify-between gap-3 rounded-md border border-slate-200 p-2"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-700">
                {index + 1}. {candidate.nameHe}
                <span className="ms-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
                  ציון {candidate.score.toFixed(0)}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-slate-500">{candidate.explanationHe}</p>
            </div>
            <ModalButton variant="primary" onClick={() => onApply(candidate)}>
              החל
            </ModalButton>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-400">ניתן לבטל את ההחלה עם ביטול (Ctrl+Z).</p>
    </Modal>
  );
}

export function BaseModeSwitchDialog({
  targetMode,
  hasBaseLayer,
  onConfirm,
  onClose,
}: {
  targetMode: BaseMode | null;
  hasBaseLayer: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={targetMode === "baseless" ? "מעבר למצב ״ללא בסיס״" : "מעבר למצב ״עם בסיס״"}
      open={targetMode !== null}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>ביטול</ModalButton>
          <ModalButton variant="primary" onClick={onConfirm}>
            עבור מצב
          </ModalButton>
        </>
      }
    >
      {targetMode === "baseless" ? (
        <ul className="list-inside list-disc text-sm text-slate-600">
          <li>אף שכבה לא תימחק.</li>
          <li>שכבת הבסיס תפסיק להיבנות אך תישאר ברשימת השכבות.</li>
          <li>כל שכבת טקסט/SVG/תמונה תהפוך לגוף עצמאי סגור בעובי שהוגדר לה.</li>
          <li>חורים ימשיכו לחתוך את הגופים שהם חוצים.</li>
          <li>ניתן לחזור למצב ״עם בסיס״ בכל רגע, וגם לבטל (Ctrl+Z).</li>
        </ul>
      ) : (
        <ul className="list-inside list-disc text-sm text-slate-600">
          <li>אף שכבה לא תימחק.</li>
          {hasBaseLayer ? (
            <li>שכבת הבסיס הקיימת תחזור להיבנות.</li>
          ) : (
            <li>תיווצר שכבת בסיס חדשה בגודל ברירת מחדל.</li>
          )}
          <li>
            שכבות עם מצב ״מובלט/חרוט״ יוצמדו לפני הבסיס; שכבות ״עצמאי״ יישארו
            גופים נפרדים.
          </li>
          <li>הפעולה נרשמת בהיסטוריה וניתנת לביטול (Ctrl+Z).</li>
        </ul>
      )}
    </Modal>
  );
}
