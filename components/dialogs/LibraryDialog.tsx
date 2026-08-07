"use client";

/**
 * The local design library dialog (V6 item 16).
 *
 * Device-local IndexedDB only — no accounts, no sync, no server. The
 * dialog says so, can turn the whole feature off, and can wipe everything,
 * mirroring the crash-recovery contract.
 */

import { useCallback, useState } from "react";
import type { DesignDocument } from "@/types/design";
import {
  deleteEntireLibrary,
  deleteLibraryDesign,
  duplicateLibraryDesign,
  libraryDisabled,
  listLibraryDesigns,
  listLibraryVersions,
  loadFromLibrary,
  saveToLibrary,
  setLibraryDisabled,
  updateLibraryDesign,
  type LibraryDesignSummary,
  type LibraryVersionSummary,
} from "@/lib/serialization/designLibrary";
import { Modal, ModalButton } from "@/components/ui/Modal";

export interface LibraryDialogProps {
  open: boolean;
  document: DesignDocument;
  onClose: () => void;
  /** Load a document through the shell (history push + selection reset). */
  onLoad: (document: DesignDocument, labelHe: string, warningsHe: string[]) => void;
  onError: (messageHe: string) => void;
}

export function LibraryDialog({ open, document, onClose, onLoad, onError }: LibraryDialogProps) {
  const [designs, setDesigns] = useState<LibraryDesignSummary[]>([]);
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const [versions, setVersions] = useState<LibraryVersionSummary[]>([]);
  const [saveName, setSaveName] = useState("");
  const [saveTags, setSaveTags] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const rows = await listLibraryDesigns();
    setDisabled(libraryDisabled());
    setDesigns(rows);
  }, []);

  // Reset the expanded-versions view and refresh the list when the dialog
  // (re)opens — state adjustment derived from a prop change, done during
  // render; the refresh itself only writes state after its await.
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setVersionsFor(null);
      void refresh();
    }
  }

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onError]
  );

  const handleSaveNew = useCallback(() => {
    void run(async () => {
      const tags = saveTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const saved = await saveToLibrary(document, { name: saveName, tags });
      if (!saved) {
        onError("השמירה לספרייה נכשלה — ייתכן שהאחסון המקומי חסום או שהספרייה כבויה");
        return;
      }
      setSaveName("");
      setSaveTags("");
      await refresh();
    });
  }, [run, document, saveName, saveTags, onError, refresh]);

  const handleSaveVersion = useCallback(
    (design: LibraryDesignSummary) => {
      void run(async () => {
        const saved = await saveToLibrary(document, {
          name: design.name,
          tags: design.tags,
          designId: design.id,
        });
        if (!saved) {
          onError("שמירת הגרסה נכשלה");
          return;
        }
        await refresh();
        if (versionsFor === design.id) {
          setVersions(await listLibraryVersions(design.id));
        }
      });
    },
    [run, document, onError, refresh, versionsFor]
  );

  const handleLoad = useCallback(
    (designId: string, version?: number) => {
      void run(async () => {
        const result = await loadFromLibrary(designId, version);
        if (!result) {
          onError("טעינת העיצוב מהספרייה נכשלה");
          return;
        }
        onLoad(
          result.document,
          version === undefined ? "טעינה מהספרייה" : `שחזור גרסה ${version}`,
          result.warningsHe
        );
        onClose();
      });
    },
    [run, onError, onLoad, onClose]
  );

  const handleShowVersions = useCallback(
    (designId: string) => {
      void run(async () => {
        setVersionsFor(designId);
        setVersions(await listLibraryVersions(designId));
      });
    },
    [run]
  );

  const handleToggleDisabled = useCallback(() => {
    const next = !disabled;
    setLibraryDisabled(next);
    setDisabled(next);
    if (!next) void refresh();
  }, [disabled, refresh]);

  const handleDeleteAll = useCallback(() => {
    void run(async () => {
      await deleteEntireLibrary();
      setVersionsFor(null);
      await refresh();
    });
  }, [run, refresh]);

  return (
    <Modal
      title="ספריית עיצובים (במכשיר זה בלבד)"
      open={open}
      onClose={onClose}
      wide
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={disabled}
                onChange={handleToggleDisabled}
                aria-label="כיבוי ספריית העיצובים"
              />
              כבויה
            </label>
            <button
              type="button"
              className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
              onClick={handleDeleteAll}
              disabled={busy}
            >
              מחיקת כל הספרייה
            </button>
          </div>
          <ModalButton onClick={onClose}>סגירה</ModalButton>
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-slate-500">
          הספרייה נשמרת ב-IndexedDB בדפדפן הזה בלבד — אין חשבון, אין שרת ואין
          סנכרון. לגיבוי חיצוני השתמשו בייצוא קובץ עיצוב.
        </p>

        {/* Save current design */}
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 p-2">
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            שם העיצוב
            <input
              className="rounded-md border border-slate-300 px-2 py-1 text-sm"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="למשל: שלט דלת"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            תגיות (מופרדות בפסיק)
            <input
              className="rounded-md border border-slate-300 px-2 py-1 text-sm"
              value={saveTags}
              onChange={(e) => setSaveTags(e.target.value)}
              placeholder="שלטים, לקוח-א"
            />
          </label>
          <ModalButton variant="primary" onClick={handleSaveNew} disabled={busy || disabled}>
            שמירת העיצוב הנוכחי
          </ModalButton>
        </div>

        {/* Designs list */}
        {designs.length === 0 ? (
          <p className="text-xs text-slate-400">
            {disabled ? "הספרייה כבויה." : "הספרייה ריקה — שמרו את העיצוב הנוכחי כדי להתחיל."}
          </p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {designs.map((design) => (
              <li
                key={design.id}
                className="rounded-md border border-slate-200 p-2"
                data-testid="library-design"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-bold text-slate-700">{design.name}</p>
                    <p className="text-xs text-slate-500">
                      גרסה {design.latestVersion} · {design.layerCount} שכבות
                      {design.tags.length > 0 && ` · ${design.tags.join(", ")}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <ModalButton onClick={() => handleLoad(design.id)} disabled={busy}>
                      טעינה
                    </ModalButton>
                    <ModalButton onClick={() => handleSaveVersion(design)} disabled={busy || disabled}>
                      שמירת גרסה
                    </ModalButton>
                    <ModalButton onClick={() => handleShowVersions(design.id)} disabled={busy}>
                      גרסאות
                    </ModalButton>
                    <ModalButton
                      onClick={() =>
                        void run(async () => {
                          await duplicateLibraryDesign(design.id);
                          await refresh();
                        })
                      }
                      disabled={busy || disabled}
                    >
                      שכפול
                    </ModalButton>
                    <ModalButton
                      onClick={() =>
                        void run(async () => {
                          await deleteLibraryDesign(design.id);
                          if (versionsFor === design.id) setVersionsFor(null);
                          await refresh();
                        })
                      }
                      disabled={busy}
                    >
                      מחיקה
                    </ModalButton>
                  </div>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    className="text-xs text-slate-400 underline hover:text-slate-600"
                    onClick={() =>
                      void run(async () => {
                        const name = window.prompt("שם חדש לעיצוב:", design.name);
                        if (name === null) return;
                        await updateLibraryDesign(design.id, { name });
                        await refresh();
                      })
                    }
                  >
                    שינוי שם
                  </button>
                </div>
                {versionsFor === design.id && (
                  <ul className="mt-2 flex flex-col gap-1 border-t border-slate-100 pt-2">
                    {versions.map((v) => (
                      <li
                        key={v.version}
                        className="flex items-center justify-between text-xs text-slate-600"
                        data-testid="library-version"
                      >
                        <span>
                          גרסה {v.version} · {new Date(v.savedAt).toLocaleString("he-IL")} ·{" "}
                          {v.layerCount} שכבות
                        </span>
                        <ModalButton onClick={() => handleLoad(design.id, v.version)} disabled={busy}>
                          שחזור גרסה זו
                        </ModalButton>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
