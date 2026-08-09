/**
 * Same-origin model-proxy tests: only registered file names are served, the
 * upstream is size-capped while streaming, and failures come back as Hebrew
 * JSON. Injected fetch — no network.
 */

import { describe, expect, it } from "vitest";
import { handleModelDownload, upstreamModelUrl } from "@/lib/server/aiModelProxy";
import { AI_MODELS } from "@/lib/ai/models";

describe("upstreamModelUrl", () => {
  it("uses the default URL, or the env base when configured", () => {
    expect(upstreamModelUrl(AI_MODELS.segmentation, {})).toBe(
      AI_MODELS.segmentation.defaultUrl
    );
    expect(
      upstreamModelUrl(AI_MODELS.segmentation, {
        NEXT_PUBLIC_AI_MODEL_BASE_URL: "https://models.example.com/ai/",
      })
    ).toBe("https://models.example.com/ai/u2netp.onnx");
  });
});

describe("handleModelDownload", () => {
  it("refuses file names outside the registry without fetching anything", async () => {
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched++;
      return new Response("x");
    }) as typeof fetch;
    for (const name of ["evil.onnx", "../../etc/passwd", "u2netp.onnx.exe"]) {
      const response = await handleModelDownload(name, fetchImpl);
      expect(response.status).toBe(404);
    }
    expect(fetched).toBe(0);
  });

  it("streams a registered model through with cache headers", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchImpl = (async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(AI_MODELS.segmentation.defaultUrl);
      return new Response(payload.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { "content-length": "5" },
      });
    }) as typeof fetch;
    const response = await handleModelDownload("u2netp.onnx", fetchImpl);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("content-length")).toBe("5");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
  });

  it("turns an upstream failure into Hebrew JSON", async () => {
    const down = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    const response = await handleModelDownload("u2netp.onnx", down);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { messageHe: string };
    expect(body.messageHe).toContain("נכשלה");
  });

  it("refuses an upstream that declares an oversized file", async () => {
    const fetchImpl = (async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(10 ** 12) },
      })) as typeof fetch;
    const response = await handleModelDownload("u2netp.onnx", fetchImpl);
    expect(response.status).toBe(502);
  });

  it("kills a stream that exceeds the cap even when the header lied", async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(32 * 1024 * 1024));
      },
    });
    const fetchImpl = (async () =>
      new Response(endless, { status: 200, headers: { "content-length": "10" } })) as typeof fetch;
    const response = await handleModelDownload("depth_anything_v2_vits.onnx", fetchImpl);
    expect(response.status).toBe(200); // headers already sent; the STREAM errors
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
});
