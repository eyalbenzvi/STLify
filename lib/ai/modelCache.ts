/**
 * Model weight download + local cache.
 *
 * Weights are downloaded once, streamed with progress, and stored in the
 * Cache API so later sessions (and offline sessions) skip the network
 * entirely. The fetch and cache backends are injectable so tests never
 * touch either the network or a real Cache.
 *
 * The byte cap is enforced on the bytes that actually arrive, not on the
 * Content-Length header — the same "spend the budget on real bytes" rule
 * the ZIP reader follows, and for the same reason: headers can lie.
 */

import { AiError } from "./errors";
import { MAX_MODEL_BYTES, modelUrl, type AiModelSpec } from "./models";

export interface ModelCacheBackends {
  fetchImpl?: typeof fetch;
  /** `null` = no cache available (private browsing on some engines). */
  cacheImpl?: Promise<Cache | null>;
}

export interface ModelLoadOptions extends ModelCacheBackends {
  /** loaded/total bytes; total is null when the server sent no length. */
  onProgress?: (loadedBytes: number, totalBytes: number | null) => void;
  signal?: AbortSignal;
}

const CACHE_NAME = "stlify-ai-models-v1";

function defaultCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return Promise.resolve(null);
  return caches.open(CACHE_NAME).catch(() => null);
}

/** Cache key: the file name, so a base-URL change does not orphan entries. */
function cacheKey(spec: AiModelSpec): string {
  return `https://ai-models.invalid/${spec.fileName}`;
}

/** True when the model is already stored locally (no download needed). */
export async function isModelCached(
  spec: AiModelSpec,
  backends: ModelCacheBackends = {}
): Promise<boolean> {
  const cache = await (backends.cacheImpl ?? defaultCache());
  if (!cache) return false;
  const hit = await cache.match(cacheKey(spec)).catch(() => undefined);
  return hit !== undefined;
}

/** Drop a cached model (used when a cached file turns out to be corrupt). */
export async function evictCachedModel(
  spec: AiModelSpec,
  backends: ModelCacheBackends = {}
): Promise<void> {
  const cache = await (backends.cacheImpl ?? defaultCache());
  await cache?.delete(cacheKey(spec)).catch(() => false);
}

/**
 * Load a model's bytes: cache first, network second, cache the result.
 * Throws AiError (Hebrew) on failure and the signal's abort reason on abort.
 */
export async function loadModelBytes(
  spec: AiModelSpec,
  options: ModelLoadOptions = {}
): Promise<ArrayBuffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = await (options.cacheImpl ?? defaultCache());

  if (cache) {
    const hit = await cache.match(cacheKey(spec)).catch(() => undefined);
    if (hit) {
      const bytes = await hit.arrayBuffer();
      options.onProgress?.(bytes.byteLength, bytes.byteLength);
      return bytes;
    }
  }

  const url = modelUrl(spec);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: options.signal });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new AiError("הורדת מודל ה-AI נכשלה — בדקו את חיבור האינטרנט ונסו שוב");
  }
  if (!response.ok || !response.body) {
    throw new AiError(
      `הורדת מודל ה-AI נכשלה (שגיאת שרת ${response.status}) — נסו שוב מאוחר יותר`
    );
  }

  const lengthHeader = response.headers.get("content-length");
  const declared = lengthHeader ? Number(lengthHeader) : NaN;
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (total !== null && total > MAX_MODEL_BYTES) {
    throw new AiError("קובץ המודל גדול מהמותר — בדקו את כתובת המודל המוגדרת");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  options.onProgress?.(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    if (loaded > MAX_MODEL_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AiError("קובץ המודל גדול מהמותר — ההורדה הופסקה");
    }
    chunks.push(value);
    options.onProgress?.(loaded, total);
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (cache) {
    // Best effort: a full or unavailable cache just means a re-download next
    // session, which is not worth failing the current run over.
    await cache
      .put(
        cacheKey(spec),
        new Response(bytes.slice().buffer, {
          headers: { "content-type": "application/octet-stream" },
        })
      )
      .catch(() => undefined);
  }
  return bytes.buffer;
}
