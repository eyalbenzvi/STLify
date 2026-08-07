"use client";

/**
 * Everything that outlives, or leaks out of, a single edit: the mesh
 * store's memory, the crash-recovery slot, and the shareable URL hash.
 *
 * The privacy contract matters here and is what shapes the module. There is
 * no server: recovery is ONE slot in this browser's IndexedDB, which the
 * user can switch off permanently, and a share link carries the design
 * inside the URL rather than pointing at anything stored anywhere.
 */

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { DesignDocument } from "@/types/design";
import type { EditorState } from "@/components/editor/store";
import type { EditorOps } from "@/hooks/useEditorOps";
import { garbageCollect, meshStoreStats, type MeshStoreStats } from "@/lib/geometry/meshStore";
import { referencedMeshIds } from "@/lib/history/history";
import { sweepUnreferencedMeshes } from "@/lib/history/retention";
import {
  clearSnapshot,
  peekSnapshot,
  restoreSnapshot,
  saveSnapshot,
  setRecoveryDisabled,
  type RecoverySnapshot,
} from "@/lib/serialization/crashRecovery";
import {
  decodeShareHash,
  encodeShareHash,
  SHARE_HASH_PREFIX,
  shareLinkEligibility,
} from "@/lib/serialization/shareLink";

/**
 * How long editing has to pause before the recovery slot is rewritten.
 * Long enough that typing a name does not thrash IndexedDB; short enough
 * that a crash costs one sentence, not one session.
 */
const AUTOSAVE_DEBOUNCE_MS = 4000;

const BYTES_PER_MEGABYTE = 1024 * 1024;

export interface SessionPersistence {
  memoryStats: MeshStoreStats;
  handleCollectGarbage: () => void;
  recovery: RecoverySnapshot | null;
  handleAcceptRecovery: () => void;
  handleDismissRecovery: (disableFuture: boolean) => void;
  handleShareLink: () => void;
}

export function useSessionPersistence({
  ops,
  history,
  /** A stored-but-not-yet-committed STL import, which must survive a sweep. */
  pendingStlRef,
}: {
  ops: EditorOps;
  history: EditorState["history"];
  pendingStlRef: RefObject<{ meshId: string; fileName: string } | null>;
}): SessionPersistence {
  const { document: doc, applyDocument, runOp, showMessage, showError } = ops;

  /** Bumped by a sweep or a GC, which change the store but not the document. */
  const [memoryVersion, setMemoryVersion] = useState(0);
  const [recovery, setRecovery] = useState<RecoverySnapshot | null>(null);

  // ---- mesh-store memory ---------------------------------------------------

  // The mesh store is an external mutable source, but it only ever changes
  // alongside the document (or when the GC handler runs), so deriving the
  // readout is correct and avoids a setState-in-effect cascade.
  const memoryStats: MeshStoreStats = useMemo(() => {
    void doc;
    void memoryVersion;
    return meshStoreStats();
  }, [doc, memoryVersion]);

  // The history is bounded (HISTORY_CAPACITY): entries that fall off the old
  // end may hold the last reference to a stored mesh, so every history change
  // sweeps the store. A pending STL import (stored, previewed, not yet a
  // layer) is passed as an extra root, or an edit made while its dialog is
  // open would free it out from under the confirm button.
  useEffect(() => {
    const pendingStl = pendingStlRef.current;
    const result = sweepUnreferencedMeshes(history, pendingStl ? [pendingStl.meshId] : []);
    if (result.removed > 0) setMemoryVersion((v) => v + 1);
  }, [history, pendingStlRef]);

  const handleCollectGarbage = useCallback(() => {
    // Sweep against the union of every state in the history: a mesh that only
    // a past state references must survive, or undo would produce an empty
    // layer.
    const result = garbageCollect(referencedMeshIds(history));
    setMemoryVersion((v) => v + 1);
    showMessage({
      titleHe: "פינוי זיכרון",
      bodyHe:
        result.removed === 0
          ? "לא נמצאו גופים מיותרים בזיכרון"
          : `שוחררו ${result.removed} גופים ` +
            `(${(result.freedBytes / BYTES_PER_MEGABYTE).toFixed(1)} מ״ב). ` +
            `נותרו ${result.remaining}.`,
      kind: "success",
    });
  }, [history, showMessage]);

  // ---- crash recovery ------------------------------------------------------

  // Offer crash recovery once, on startup.
  useEffect(() => {
    let cancelled = false;
    void peekSnapshot().then((snapshot) => {
      if (!cancelled && snapshot) setRecovery(snapshot);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Autosave the single recovery slot, debounced. Failures are silent by
  // design — this is a safety net, not a save button.
  useEffect(() => {
    const timer = setTimeout(() => void saveSnapshot(doc), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [doc]);

  const handleAcceptRecovery = useCallback(() => {
    const snapshot = recovery;
    if (!snapshot) return;
    setRecovery(null);
    try {
      const result = restoreSnapshot(snapshot);
      applyDocument(result.document, "שחזור עבודה");
      if (result.warningsHe.length > 0) {
        showMessage({
          titleHe: "העבודה שוחזרה עם הערות",
          bodyHe: result.warningsHe.join("\n"),
          kind: "info",
        });
      }
    } catch (err) {
      showError(err, "שחזור העבודה נכשל");
    }
  }, [recovery, applyDocument, showMessage, showError]);

  const handleDismissRecovery = useCallback((disableFuture: boolean) => {
    setRecovery(null);
    if (disableFuture) setRecoveryDisabled(true);
    void clearSnapshot();
  }, []);

  // ---- share links ---------------------------------------------------------

  const handleShareLink = useCallback(() => {
    const eligibility = shareLinkEligibility(doc);
    if (!eligibility.ok) {
      showMessage({ titleHe: "שיתוף בקישור", bodyHe: eligibility.reasonHe, kind: "info" });
      return;
    }
    void runOp("יצירת קישור שיתוף", async () => {
      const hash = await encodeShareHash(doc);
      if (!hash) {
        showMessage({
          titleHe: "שיתוף בקישור",
          bodyHe: "העיצוב גדול מדי לקישור — יש לשתף כקובץ עיצוב",
          kind: "info",
        });
        return;
      }
      await navigator.clipboard.writeText(
        `${window.location.origin}${window.location.pathname}${hash}`
      );
      showMessage({
        titleHe: "הקישור הועתק",
        bodyHe:
          "הקישור מכיל את העיצוב עצמו (אין שרת ואין שמירה בענן) — כל מי שמקבל " +
          "אותו רואה את העיצוב. פתיחת הקישור טוענת את העיצוב לזיכרון הדפדפן בלבד.",
        kind: "success",
      });
    });
  }, [doc, runOp, showMessage]);

  // Load a shared design from the URL hash once, on startup. The hash is
  // then cleared, so a reload does not re-import over the user's edits.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith(SHARE_HASH_PREFIX)) return;
    window.history.replaceState(null, "", window.location.pathname);
    void (async () => {
      try {
        const { document: shared, warningsHe } = await decodeShareHash(hash);
        applyDocument(shared, "טעינת עיצוב מקישור");
        if (warningsHe.length > 0) {
          showMessage({
            titleHe: "העיצוב מהקישור נטען עם הערות",
            bodyHe: warningsHe.join("\n"),
            kind: "info",
          });
        }
      } catch {
        showMessage({
          titleHe: "טעינת קישור",
          bodyHe: "הקישור אינו מכיל עיצוב תקין",
          kind: "error",
        });
      }
    })();
    // Startup only: re-running on a document change would re-import the hash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    memoryStats,
    handleCollectGarbage,
    recovery,
    handleAcceptRecovery,
    handleDismissRecovery,
    handleShareLink,
  };
}

export type { DesignDocument };
