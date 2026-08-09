/**
 * Browser-side cloud client tests with a scripted fetch: the lifecycle, the
 * failure paths and the caps — no server, no timers beyond an instant fake
 * delay.
 */

import { describe, expect, it } from "vitest";
import { AiError } from "../errors";
import {
  CLOUD_MAX_IMAGE_BYTES,
  fetchCloudAvailability,
  generateCloudModel,
} from "../cloudClient";

const instantDelay = async () => {};

function scriptedFetch(script: Record<string, (call: number) => Response>): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const counts = new Map<string, number>();
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    calls.push(key);
    const handler = script[key];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    const call = (counts.get(key) ?? 0) + 1;
    counts.set(key, call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe("fetchCloudAvailability", () => {
  it("maps the endpoint's answer and treats failures as unavailable", async () => {
    const up = (async () => json({ enabled: true, providerNameHe: "Meshy" })) as typeof fetch;
    expect(await fetchCloudAvailability(up)).toEqual({
      enabled: true,
      providerNameHe: "Meshy",
    });
    const down = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    expect(await fetchCloudAvailability(down)).toEqual({
      enabled: false,
      providerNameHe: null,
    });
  });
});

describe("generateCloudModel", () => {
  const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

  it("uploads, polls to success and downloads the OBJ, reporting stages", async () => {
    const stages: string[] = [];
    const { fetchImpl } = scriptedFetch({
      "POST /api/image-to-3d": () => json({ taskId: "abc" }),
      "GET /api/image-to-3d/abc": (call) =>
        call === 1
          ? json({ state: "running", progress: 0.5 })
          : json({ state: "succeeded" }),
      "GET /api/image-to-3d/abc/model": () =>
        new Response("v 0 0 0\nf 1 1 1\n", { status: 200 }),
    });
    const result = await generateCloudModel(image, {
      fetchImpl,
      delay: instantDelay,
      onProgress: (stage) => {
        if (stages[stages.length - 1] !== stage) stages.push(stage);
      },
    });
    expect(result.taskId).toBe("abc");
    expect(result.objText).toContain("f 1 1 1");
    expect(stages).toEqual(["uploading", "generating", "downloading"]);
  });

  it("refuses an oversized image before uploading anything", async () => {
    const { fetchImpl, calls } = scriptedFetch({});
    const huge = new Blob([new Uint8Array(CLOUD_MAX_IMAGE_BYTES + 1)]);
    await expect(
      generateCloudModel(huge, { fetchImpl, delay: instantDelay })
    ).rejects.toThrow(/גדולה מדי/);
    expect(calls).toEqual([]);
  });

  it("surfaces the proxy's Hebrew message on failure responses", async () => {
    const { fetchImpl } = scriptedFetch({
      "POST /api/image-to-3d": () => json({ messageHe: "מכסה נגמרה" }, 402),
    });
    await expect(
      generateCloudModel(image, { fetchImpl, delay: instantDelay })
    ).rejects.toThrow("מכסה נגמרה");
  });

  it("surfaces a provider-side failure reported by the poll", async () => {
    const { fetchImpl } = scriptedFetch({
      "POST /api/image-to-3d": () => json({ taskId: "abc" }),
      "GET /api/image-to-3d/abc": () =>
        json({ state: "failed", messageHe: "יצירת המודל נכשלה אצל הספק: X" }),
    });
    await expect(
      generateCloudModel(image, { fetchImpl, delay: instantDelay })
    ).rejects.toThrow("יצירת המודל נכשלה אצל הספק: X");
  });

  it("times out a generation that never finishes", async () => {
    const { fetchImpl } = scriptedFetch({
      "POST /api/image-to-3d": () => json({ taskId: "abc" }),
      "GET /api/image-to-3d/abc": () => json({ state: "running", progress: 0.1 }),
    });
    await expect(
      generateCloudModel(image, {
        fetchImpl,
        timeoutMs: 15,
        delay: () => new Promise((resolve) => setTimeout(resolve, 8)),
      })
    ).rejects.toThrow(/ארכה יותר מדי/);
  });

  it("aborts cleanly mid-poll without inventing an error message", async () => {
    const controller = new AbortController();
    const { fetchImpl } = scriptedFetch({
      "POST /api/image-to-3d": () => json({ taskId: "abc" }),
      "GET /api/image-to-3d/abc": (call) => {
        if (call === 1) {
          controller.abort();
          return json({ state: "running", progress: 0 });
        }
        // A real fetch with an aborted signal rejects; mimic that.
        throw new DOMException("aborted", "AbortError");
      },
    });
    const error = await generateCloudModel(image, {
      fetchImpl,
      delay: instantDelay,
      signal: controller.signal,
    }).catch((e) => e);
    // The abort reason propagates; it must NOT be wrapped as an AiError.
    expect(error).not.toBeInstanceOf(AiError);
  });

  it("refuses an empty model file", async () => {
    const { fetchImpl } = scriptedFetch({
      "POST /api/image-to-3d": () => json({ taskId: "abc" }),
      "GET /api/image-to-3d/abc": () => json({ state: "succeeded" }),
      "GET /api/image-to-3d/abc/model": () => new Response("", { status: 200 }),
    });
    await expect(
      generateCloudModel(image, { fetchImpl, delay: instantDelay })
    ).rejects.toThrow(/ריק/);
  });
});
