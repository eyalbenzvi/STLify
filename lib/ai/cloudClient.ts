/**
 * Browser client for the /api/image-to-3d proxy.
 *
 * Talks ONLY to our own server (which holds the key and talks to the
 * provider); knows nothing about which provider is behind it beyond the
 * display name the availability endpoint reports. Fetch is injectable so
 * the whole lifecycle — polling, failure, timeout, cancellation — is
 * unit-testable with fakes.
 */

import { AiError } from "./errors";

export interface CloudAvailability {
  enabled: boolean;
  providerNameHe: string | null;
}

export type CloudStage = "uploading" | "generating" | "downloading";

export interface CloudGenerateOptions {
  signal?: AbortSignal;
  onProgress?: (stage: CloudStage, fraction: number | null) => void;
  fetchImpl?: typeof fetch;
  /** Injectable clock/delay for tests. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Poll cadence; widens after the first minute. */
  pollIntervalMs?: number;
  /** Hard ceiling on the whole generation. */
  timeoutMs?: number;
}

/** Generation typically lands in 1–3 minutes; 15 is a hung task. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 4_000;
const SLOW_POLL_AFTER_MS = 60_000;
/** Client-side echo of the server's upload cap, to fail before uploading. */
export const CLOUD_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Client-side echo of the server's model cap. */
const MAX_MODEL_BYTES = 100 * 1024 * 1024;

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Pull the proxy's Hebrew message out of an error response, if it sent one. */
async function messageOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { messageHe?: unknown };
    return typeof body.messageHe === "string" ? body.messageHe : null;
  } catch {
    return null;
  }
}

async function throwFor(response: Response, fallbackHe: string): Promise<never> {
  throw new AiError((await messageOf(response)) ?? fallbackHe);
}

/** Probe GET /api/image-to-3d. Failure means "not available", not a crash. */
export async function fetchCloudAvailability(
  fetchImpl: typeof fetch = fetch
): Promise<CloudAvailability> {
  try {
    const response = await fetchImpl("/api/image-to-3d", { method: "GET" });
    if (!response.ok) return { enabled: false, providerNameHe: null };
    const body = (await response.json()) as {
      enabled?: unknown;
      providerNameHe?: unknown;
    };
    return {
      enabled: body.enabled === true,
      providerNameHe: typeof body.providerNameHe === "string" ? body.providerNameHe : null,
    };
  } catch {
    return { enabled: false, providerNameHe: null };
  }
}

export interface CloudModelResult {
  taskId: string;
  /** The OBJ file's text, ready for the hardened importer. */
  objText: string;
}

/** Upload → poll to completion → download the OBJ. Throws AiError (Hebrew). */
export async function generateCloudModel(
  image: Blob,
  options: CloudGenerateOptions = {}
): Promise<CloudModelResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delay = options.delay ?? abortableDelay;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const { signal, onProgress } = options;

  if (image.size > CLOUD_MAX_IMAGE_BYTES) {
    throw new AiError("התמונה גדולה מדי לשליחה לענן (מקסימום 8MB)");
  }

  // 1. Upload.
  onProgress?.("uploading", null);
  let created: Response;
  try {
    created = await fetchImpl("/api/image-to-3d", {
      method: "POST",
      body: image,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new AiError("התקשורת עם השרת נכשלה — בדקו את החיבור ונסו שוב");
  }
  if (!created.ok) await throwFor(created, "יצירת המשימה נכשלה — נסו שוב");
  const { taskId } = (await created.json()) as { taskId?: unknown };
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new AiError("השרת לא החזיר מזהה משימה — נסו שוב");
  }

  // 2. Poll.
  const startedAt = Date.now();
  onProgress?.("generating", 0);
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new AiError("יצירת המודל ארכה יותר מדי — נסו שוב מאוחר יותר");
    }
    const elapsed = Date.now() - startedAt;
    await delay(elapsed > SLOW_POLL_AFTER_MS ? pollMs * 2 : pollMs, signal);

    let polled: Response;
    try {
      polled = await fetchImpl(`/api/image-to-3d/${taskId}`, { signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new AiError("התקשורת עם השרת נכשלה במהלך ההמתנה — בדקו את החיבור");
    }
    if (!polled.ok) await throwFor(polled, "בדיקת מצב המשימה נכשלה");
    const status = (await polled.json()) as {
      state?: unknown;
      progress?: unknown;
      messageHe?: unknown;
    };
    if (status.state === "succeeded") break;
    if (status.state === "failed") {
      throw new AiError(
        typeof status.messageHe === "string"
          ? status.messageHe
          : "יצירת המודל נכשלה אצל הספק"
      );
    }
    if (status.state === "running") {
      const progress = typeof status.progress === "number" ? status.progress : 0;
      onProgress?.("generating", Math.max(0, Math.min(1, progress)));
    }
  }

  // 3. Download the OBJ through the proxy.
  onProgress?.("downloading", null);
  let download: Response;
  try {
    download = await fetchImpl(`/api/image-to-3d/${taskId}/model`, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new AiError("הורדת המודל נכשלה — בדקו את החיבור ונסו שוב");
  }
  if (!download.ok) await throwFor(download, "הורדת המודל נכשלה — נסו שוב");

  const lengthHeader = Number(download.headers.get("content-length") ?? "");
  const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;
  let objText: string;
  if (download.body) {
    const reader = download.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_MODEL_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AiError("קובץ המודל שהתקבל גדול מהמותר (מעל 100MB)");
      }
      chunks.push(value);
      onProgress?.("downloading", total ? Math.min(1, received / total) : null);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    objText = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } else {
    objText = await download.text();
    if (objText.length > MAX_MODEL_BYTES) {
      throw new AiError("קובץ המודל שהתקבל גדול מהמותר (מעל 100MB)");
    }
  }
  if (objText.trim().length === 0) {
    throw new AiError("קובץ המודל שהתקבל ריק — נסו שוב");
  }
  return { taskId, objText };
}
