"use client";

/**
 * "שיתוף עיצוב" — two honest methods, no cloud:
 *   A. Share as a portable design file (download + send manually).
 *   B. Compact link for small designs: the design data itself is encoded in
 *      the URL hash. Clearly labelled as not private and size-limited.
 */

import { useMemo, useState } from "react";
import { useEditorStore } from "@/lib/design/store";
import { collectAssets } from "@/lib/design/assets";
import { downloadBlob } from "@/lib/export/stl";
import { designFileName } from "@/lib/export/filenames";
import { getProductTemplate } from "@/lib/design/templates";
import {
  buildPortableFile,
  serializePortable,
} from "@/lib/serialization/portable";
import {
  encodeShareHash,
  shareLinkEligibility,
} from "@/lib/serialization/shareLink";
import { Modal, PrimaryButton, SecondaryButton } from "@/components/ui/Modal";

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
}

export function ShareDialog({ open, onClose }: ShareDialogProps) {
  const { state } = useEditorStore();
  const [copied, setCopied] = useState(false);
  const [fileDownloaded, setFileDownloaded] = useState(false);

  const template = getProductTemplate(state.doc.templateId);

  const { shareUrl, linkDisabledReason } = useMemo(() => {
    if (!open || typeof window === "undefined") {
      return { shareUrl: null as string | null, linkDisabledReason: null as string | null };
    }
    const eligibility = shareLinkEligibility(state);
    if (!eligibility.ok) {
      return { shareUrl: null, linkDisabledReason: eligibility.reasonHe };
    }
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    const hash = encodeShareHash(state, baseUrl.length);
    if (!hash) {
      return {
        shareUrl: null,
        linkDisabledReason: "העיצוב גדול מדי לשיתוף בקישור. יש לשתף אותו כקובץ עיצוב.",
      };
    }
    return { shareUrl: baseUrl + hash, linkDisabledReason: null };
  }, [open, state]);

  const downloadDesignFile = (): void => {
    const assetIds = state.doc.layers
      .filter((l) => l.type === "imageRelief")
      .map((l) => (l.type === "imageRelief" ? l.assetId : ""))
      .filter(Boolean);
    const portable = buildPortableFile({
      state,
      title: state.doc.title,
      assets: collectAssets(assetIds),
    });
    downloadBlob(
      new Blob([serializePortable(portable)], { type: "application/json" }),
      designFileName(state.doc.title, template.suggestedFilename)
    );
    setFileDownloaded(true);
  };

  const copyLink = async (): Promise<void> => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard API unavailable — show the URL for manual copying.
      window.prompt("העתיקו את הקישור:", shareUrl);
    }
  };

  return (
    <Modal title="שיתוף עיצוב" open={open} onClose={onClose} widthClass="max-w-xl">
      <div className="flex flex-col gap-5">
        <section className="rounded-lg border border-slate-200 p-3">
          <h3 className="mb-1 text-sm font-bold text-slate-800">שיתוף עיצוב כקובץ</h3>
          <p className="mb-2 text-xs leading-relaxed text-slate-500">
            אפשר לשלוח את קובץ העיצוב למשתמש אחר. הוא יוכל לפתוח אותו בכלי
            ולהמשיך לערוך אותו.
          </p>
          <div className="flex items-center gap-2">
            <PrimaryButton onClick={downloadDesignFile}>הורדת קובץ עיצוב</PrimaryButton>
            {fileDownloaded && (
              <span className="text-xs text-emerald-600">✓ הקובץ ירד — שלחו אותו בכל דרך שנוחה לכם</span>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 p-3">
          <h3 className="mb-1 text-sm font-bold text-slate-800">קישור קומפקטי (עיצובים קטנים בלבד)</h3>
          {shareUrl ? (
            <>
              <p className="mb-2 text-xs leading-relaxed text-slate-500">
                נתוני העיצוב מקודדים בתוך הקישור עצמו (בחלק ה-# של הכתובת) —
                שום דבר לא נשמר בשרת.
              </p>
              <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                הקישור מכיל את נתוני העיצוב עצמם ואינו קישור פרטי או מאובטח.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  dir="ltr"
                  aria-label="קישור שיתוף"
                  className="min-w-0 flex-1 truncate rounded-md border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs"
                  value={shareUrl}
                  onFocus={(e) => e.target.select()}
                />
                <SecondaryButton onClick={() => void copyLink()}>
                  {copied ? "✓ הועתק" : "העתקה"}
                </SecondaryButton>
              </div>
              <p className="mt-1 text-[10px] text-slate-400" dir="ltr">
                {shareUrl.length.toLocaleString()} תווים
              </p>
            </>
          ) : (
            <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
              {linkDisabledReason ?? "שיתוף בקישור אינו זמין לעיצוב זה."}
            </p>
          )}
        </section>

        <div className="flex justify-end">
          <SecondaryButton onClick={onClose}>סגירה</SecondaryButton>
        </div>
      </div>
    </Modal>
  );
}
