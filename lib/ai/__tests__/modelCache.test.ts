/**
 * Model download + cache tests. The fetch and cache backends are injected
 * fakes — no test touches the network or a real Cache, per the "never load
 * real weights in tests" rule.
 */

import { describe, expect, it } from "vitest";
import { AiError } from "../errors";
import { isModelCached, loadModelBytes } from "../modelCache";
import { AI_MODELS } from "../models";

const spec = AI_MODELS.segmentation;

/** Minimal Cache API fake over a Map. */
function fakeCache() {
  const store = new Map<string, Uint8Array>();
  const cache = {
    async match(key: string) {
      const hit = store.get(key);
      return hit ? new Response(hit.slice().buffer as ArrayBuffer) : undefined;
    },
    async put(key: string, response: Response) {
      store.set(key, new Uint8Array(await response.arrayBuffer()));
    },
    async delete(key: string) {
      return store.delete(key);
    },
  } as unknown as Cache;
  return { store, cacheImpl: Promise.resolve<Cache | null>(cache) };
}

function streamedResponse(bytes: Uint8Array, chunkSize: number, length?: string | null) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  const headers = new Headers();
  if (length !== null) headers.set("content-length", length ?? String(bytes.length));
  return new Response(stream, { status: 200, headers });
}

describe("loadModelBytes", () => {
  it("downloads with progress and stores the result in the cache", async () => {
    const payload = new Uint8Array(100).map((_, i) => i % 251);
    const { store, cacheImpl } = fakeCache();
    const ticks: [number, number | null][] = [];
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount++;
      return streamedResponse(payload, 32);
    }) as typeof fetch;

    const bytes = await loadModelBytes(spec, {
      fetchImpl,
      cacheImpl,
      onProgress: (loaded, total) => ticks.push([loaded, total]),
    });
    expect(new Uint8Array(bytes)).toEqual(payload);
    expect(fetchCount).toBe(1);
    expect(store.size).toBe(1);
    expect(ticks[0]).toEqual([0, 100]);
    expect(ticks[ticks.length - 1]).toEqual([100, 100]);
    // Loaded counts only ever grow.
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i][0]).toBeGreaterThanOrEqual(ticks[i - 1][0]);
    }

    // Second load: cache hit, no network.
    const again = await loadModelBytes(spec, { fetchImpl, cacheImpl });
    expect(new Uint8Array(again)).toEqual(payload);
    expect(fetchCount).toBe(1);
    expect(await isModelCached(spec, { cacheImpl })).toBe(true);
  });

  it("reports an unknown total when the server sends no length", async () => {
    const { cacheImpl } = fakeCache();
    const ticks: (number | null)[] = [];
    const fetchImpl = (async () =>
      streamedResponse(new Uint8Array(10), 4, null)) as typeof fetch;
    await loadModelBytes(spec, {
      fetchImpl,
      cacheImpl,
      onProgress: (_, total) => ticks.push(total),
    });
    expect(ticks.every((t) => t === null)).toBe(true);
  });

  it("refuses a declared size over the cap before downloading", async () => {
    const { cacheImpl } = fakeCache();
    const fetchImpl = (async () =>
      streamedResponse(new Uint8Array(4), 4, String(10 ** 12))) as typeof fetch;
    await expect(loadModelBytes(spec, { fetchImpl, cacheImpl })).rejects.toThrow(AiError);
  });

  it("stops a download whose real size exceeds the header's claim and the cap", async () => {
    // Headers can lie: claim 10 bytes, stream forever.
    const { cacheImpl, store } = fakeCache();
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const fetchImpl = (async () =>
      new Response(endless, {
        status: 200,
        headers: { "content-length": "10" },
      })) as typeof fetch;
    await expect(loadModelBytes(spec, { fetchImpl, cacheImpl })).rejects.toThrow(
      /גדול מהמותר/
    );
    expect(store.size).toBe(0);
  });

  it("turns a server error into a Hebrew AiError", async () => {
    const { cacheImpl } = fakeCache();
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(loadModelBytes(spec, { fetchImpl, cacheImpl })).rejects.toThrow(/הורדת מודל/);
  });

  it("works without any cache (private browsing) — just uncached", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    let fetchCount = 0;
    const fetchImpl = (async () => {
      fetchCount++;
      return streamedResponse(payload, 2);
    }) as typeof fetch;
    const none = Promise.resolve<Cache | null>(null);
    await loadModelBytes(spec, { fetchImpl, cacheImpl: none });
    await loadModelBytes(spec, { fetchImpl, cacheImpl: none });
    expect(fetchCount).toBe(2);
    expect(await isModelCached(spec, { cacheImpl: none })).toBe(false);
  });
});
