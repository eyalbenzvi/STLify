/**
 * Local crash recovery: ONE snapshot slot, on this device only.
 *
 * The app has no accounts, no projects and no server, and that constraint is
 * deliberate. This does not change it. What it fixes is a specific failure:
 * with the V4 tools a session can now represent an hour of modelling, and a
 * stray refresh, a crashed tab or a flat battery previously destroyed all of
 * it with no recourse.
 *
 * Scope, kept deliberately narrow so it stays a safety net rather than
 * becoming storage:
 *   • exactly one slot, overwritten every save — not a file list
 *   • IndexedDB in this browser only — no sync, no account, no upload
 *   • offered once on startup, then cleared — not a document you manage
 *   • user-disablable, and never written when disabled
 *
 * The snapshot reuses the portable design-file format, so a recovered
 * session goes through exactly the same validation as an imported file and
 * cannot inject anything the importer would reject.
 */

import type { DesignDocument } from "@/types/design";
import {
  exportDesignFile,
  importDesignFile,
  type DesignFileImportResult,
} from "./designFile";

const DB_NAME = "printcraft-recovery";
const DB_VERSION = 1;
const STORE_NAME = "snapshot";
/** The single slot's key. Always the same — that is the point. */
const SLOT_KEY = "current";
const DISABLED_KEY = "printcraft-recovery-disabled";

export interface RecoverySnapshot {
  savedAt: string;
  /** Serialized portable design file. */
  payload: string;
  /** Layer count, so the prompt can describe what is on offer. */
  layerCount: number;
}

/** True when the user has turned crash recovery off. */
export function recoveryDisabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(DISABLED_KEY) === "1";
  } catch {
    // Private-mode browsers can throw on access; treat as enabled.
    return false;
  }
}

export function setRecoveryDisabled(disabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (disabled) localStorage.setItem(DISABLED_KEY, "1");
    else localStorage.removeItem(DISABLED_KEY);
  } catch {
    // Nothing to do: recovery is best-effort by design.
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    // A blocked or failed open is not an error worth surfacing: the app
    // works fine without recovery.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest
): Promise<T | null> {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    let request: IDBRequest;
    try {
      request = fn(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
    } catch {
      db.close();
      resolve(null);
      return;
    }
    request.onsuccess = () => {
      resolve(request.result as T);
      db.close();
    };
    request.onerror = () => {
      resolve(null);
      db.close();
    };
  });
}

/**
 * Write the snapshot, replacing whatever was there.
 *
 * Never throws: a failed autosave must not interrupt editing. Returns false
 * when nothing was written so the caller can stop offering the feature.
 */
export async function saveSnapshot(document: DesignDocument): Promise<boolean> {
  if (recoveryDisabled()) return false;
  try {
    const file = exportDesignFile(document);
    const snapshot: RecoverySnapshot = {
      savedAt: new Date().toISOString(),
      payload: JSON.stringify(file),
      layerCount: document.layers.length,
    };
    const result = await withStore<IDBValidKey>("readwrite", (store) =>
      store.put(snapshot, SLOT_KEY)
    );
    return result !== null;
  } catch {
    // Most likely the document references a mesh that is no longer in the
    // store. Autosave is best-effort; the visible save path still reports.
    return false;
  }
}

/** Read the snapshot without consuming it. */
export async function peekSnapshot(): Promise<RecoverySnapshot | null> {
  if (recoveryDisabled()) return null;
  const value = await withStore<RecoverySnapshot | undefined>("readonly", (store) =>
    store.get(SLOT_KEY)
  );
  if (!value || typeof value.payload !== "string") return null;
  return value;
}

/** Discard the snapshot. Called once the user accepts or declines it. */
export async function clearSnapshot(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(SLOT_KEY));
}

/**
 * Restore a snapshot through the normal import path.
 *
 * Reusing `importDesignFile` means a corrupted or hand-edited snapshot is
 * sanitized exactly like an untrusted file, rather than being trusted because
 * it came from our own storage.
 */
export function restoreSnapshot(snapshot: RecoverySnapshot): DesignFileImportResult {
  return importDesignFile(snapshot.payload);
}

/** How long ago the snapshot was taken, in Hebrew. */
export function describeSnapshotAge(snapshot: RecoverySnapshot, now = Date.now()): string {
  const savedAt = Date.parse(snapshot.savedAt);
  if (!Number.isFinite(savedAt)) return "לא ידוע";
  const minutes = Math.max(0, Math.round((now - savedAt) / 60000));
  if (minutes < 1) return "לפני פחות מדקה";
  if (minutes === 1) return "לפני דקה";
  if (minutes < 60) return `לפני ${minutes} דקות`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return "לפני שעה";
  if (hours < 24) return `לפני ${hours} שעות`;
  const days = Math.round(hours / 24);
  return days === 1 ? "אתמול" : `לפני ${days} ימים`;
}
