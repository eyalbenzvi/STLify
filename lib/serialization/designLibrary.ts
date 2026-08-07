/**
 * Local design library with numbered versions (V6 item 16).
 *
 * THIS DEVICE ONLY, by charter: IndexedDB in this browser — no accounts, no
 * server, no sync, no telemetry, no identifiers. The library can be turned
 * off entirely and wiped entirely, exactly like crash recovery
 * (crashRecovery.ts), and the README privacy statement stays true word for
 * word: the portable `.formadesign.json` file remains the way work leaves
 * the device.
 *
 * What it adds over the single recovery slot is REPEATABILITY: named
 * designs, tags, duplication, and a numbered version history per design —
 * so a print shop can pull up last month's plate exactly as it was.
 *
 * Every stored payload is the portable design-file format, and loading
 * goes through `importDesignFile` — a corrupted or hand-edited record is
 * sanitized exactly like an untrusted file.
 */

import type { DesignDocument } from "@/types/design";
import {
  exportDesignFile,
  importDesignFile,
  type DesignFileImportResult,
} from "./designFile";

const DB_NAME = "printcraft-library";
const DB_VERSION = 1;
const DESIGNS_STORE = "designs";
const VERSIONS_STORE = "versions";
const DISABLED_KEY = "printcraft-library-disabled";

export interface LibraryDesignSummary {
  id: string;
  name: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  latestVersion: number;
  layerCount: number;
}

export interface LibraryVersionSummary {
  designId: string;
  version: number;
  savedAt: string;
  layerCount: number;
}

interface VersionRecord extends LibraryVersionSummary {
  /** Serialized portable design file. */
  payload: string;
}

/** True when the user has turned the library off. */
export function libraryDisabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(DISABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLibraryDisabled(disabled: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (disabled) localStorage.setItem(DISABLED_KEY, "1");
    else localStorage.removeItem(DISABLED_KEY);
  } catch {
    // Best-effort by design.
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
      if (!db.objectStoreNames.contains(DESIGNS_STORE)) {
        db.createObjectStore(DESIGNS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(VERSIONS_STORE)) {
        const store = db.createObjectStore(VERSIONS_STORE, {
          keyPath: ["designId", "version"],
        });
        store.createIndex("byDesign", "designId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** Run one transaction over both stores; resolves null on any failure. */
function withTransaction<T>(
  mode: IDBTransactionMode,
  fn: (designs: IDBObjectStore, versions: IDBObjectStore) => Promise<T>
): Promise<T | null> {
  return openDatabase().then((db) => {
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      let settled = false;
      const settle = (value: T | null) => {
        if (settled) return;
        settled = true;
        db.close();
        resolve(value);
      };
      try {
        const tx = db.transaction([DESIGNS_STORE, VERSIONS_STORE], mode);
        let result: T | null = null;
        // The callback's promise resolves on its last request's success
        // (a microtask); the transaction completes in a later task — so by
        // the time oncomplete fires, `result` is already in place.
        tx.oncomplete = () => settle(result);
        tx.onerror = () => settle(null);
        tx.onabort = () => settle(null);
        fn(tx.objectStore(DESIGNS_STORE), tx.objectStore(VERSIONS_STORE))
          .then((value) => {
            result = value;
          })
          .catch(() => {
            try {
              tx.abort();
            } catch {
              settle(null);
            }
          });
      } catch {
        settle(null);
      }
    });
  });
}

function requestAsPromise<T>(request: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

function newDesignId(): string {
  return `design_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Save the document into the library. Without `designId` a new design is
 * created; with it, a NEW NUMBERED VERSION is appended to that design.
 * Returns the design id, or null when storage is unavailable/disabled.
 */
export async function saveToLibrary(
  document: DesignDocument,
  options: { name: string; tags?: string[]; designId?: string }
): Promise<{ designId: string; version: number } | null> {
  if (libraryDisabled()) return null;
  let payload: string;
  try {
    payload = JSON.stringify(exportDesignFile(document));
  } catch {
    return null;
  }
  const now = new Date().toISOString();

  return withTransaction("readwrite", async (designs, versions) => {
    let record: LibraryDesignSummary | undefined;
    if (options.designId) {
      record = await requestAsPromise<LibraryDesignSummary | undefined>(
        designs.get(options.designId)
      );
    }
    if (!record) {
      record = {
        id: options.designId ?? newDesignId(),
        name: options.name.trim() || "עיצוב ללא שם",
        tags: options.tags ?? [],
        createdAt: now,
        updatedAt: now,
        latestVersion: 0,
        layerCount: document.layers.length,
      };
    }
    const version = record.latestVersion + 1;
    const versionRecord: VersionRecord = {
      designId: record.id,
      version,
      savedAt: now,
      layerCount: document.layers.length,
      payload,
    };
    const updated: LibraryDesignSummary = {
      ...record,
      name: options.name.trim() || record.name,
      tags: options.tags ?? record.tags,
      updatedAt: now,
      latestVersion: version,
      layerCount: document.layers.length,
    };
    await requestAsPromise(versions.put(versionRecord));
    await requestAsPromise(designs.put(updated));
    return { designId: record.id, version };
  });
}

/** All designs, most recently updated first. */
export async function listLibraryDesigns(): Promise<LibraryDesignSummary[]> {
  if (libraryDisabled()) return [];
  const rows = await withTransaction("readonly", async (designs) =>
    requestAsPromise<LibraryDesignSummary[]>(designs.getAll())
  );
  return (rows ?? []).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Version summaries of one design, newest first (payloads omitted). */
export async function listLibraryVersions(
  designId: string
): Promise<LibraryVersionSummary[]> {
  const rows = await withTransaction("readonly", async (_designs, versions) =>
    requestAsPromise<VersionRecord[]>(versions.index("byDesign").getAll(designId))
  );
  return (rows ?? [])
    .map(({ designId: id, version, savedAt, layerCount }) => ({
      designId: id,
      version,
      savedAt,
      layerCount,
    }))
    .sort((a, b) => b.version - a.version);
}

/**
 * Load one version (default: latest) through the normal import path — the
 * same validation as an untrusted file.
 */
export async function loadFromLibrary(
  designId: string,
  version?: number
): Promise<DesignFileImportResult | null> {
  const record = await withTransaction("readonly", async (designs, versions) => {
    let target = version;
    if (target === undefined) {
      const summary = await requestAsPromise<LibraryDesignSummary | undefined>(
        designs.get(designId)
      );
      if (!summary) return null;
      target = summary.latestVersion;
    }
    return requestAsPromise<VersionRecord | undefined>(
      versions.get([designId, target])
    );
  });
  if (!record || typeof record.payload !== "string") return null;
  return importDesignFile(record.payload);
}

/** Duplicate a design's LATEST version into a new design. */
export async function duplicateLibraryDesign(designId: string): Promise<string | null> {
  const source = await withTransaction("readonly", async (designs, versions) => {
    const summary = await requestAsPromise<LibraryDesignSummary | undefined>(
      designs.get(designId)
    );
    if (!summary) return null;
    const latest = await requestAsPromise<VersionRecord | undefined>(
      versions.get([designId, summary.latestVersion])
    );
    return latest ? { summary, latest } : null;
  });
  if (!source) return null;
  const now = new Date().toISOString();
  const copy: LibraryDesignSummary = {
    id: newDesignId(),
    name: `עותק של ${source.summary.name}`,
    tags: source.summary.tags,
    createdAt: now,
    updatedAt: now,
    latestVersion: 1,
    layerCount: source.latest.layerCount,
  };
  const result = await withTransaction("readwrite", async (designs, versions) => {
    await requestAsPromise(
      versions.put({ ...source.latest, designId: copy.id, version: 1, savedAt: now })
    );
    await requestAsPromise(designs.put(copy));
    return copy.id;
  });
  return result;
}

/** Update a design's name/tags without touching its versions. */
export async function updateLibraryDesign(
  designId: string,
  patch: { name?: string; tags?: string[] }
): Promise<boolean> {
  const result = await withTransaction("readwrite", async (designs) => {
    const record = await requestAsPromise<LibraryDesignSummary | undefined>(
      designs.get(designId)
    );
    if (!record) return false;
    await requestAsPromise(
      designs.put({
        ...record,
        name: patch.name?.trim() || record.name,
        tags: patch.tags ?? record.tags,
      })
    );
    return true;
  });
  return result === true;
}

/** Delete one design and all its versions. */
export async function deleteLibraryDesign(designId: string): Promise<void> {
  await withTransaction("readwrite", async (designs, versions) => {
    const keys = await requestAsPromise<IDBValidKey[]>(
      versions.index("byDesign").getAllKeys(designId)
    );
    for (const key of keys) await requestAsPromise(versions.delete(key));
    await requestAsPromise(designs.delete(designId));
    return true;
  });
}

/** Wipe the whole library from this device. */
export function deleteEntireLibrary(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve();
      return;
    }
    try {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
