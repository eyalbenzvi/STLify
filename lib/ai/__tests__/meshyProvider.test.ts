/**
 * Meshy provider tests against a mocked fetch: task lifecycle, error
 * classification and hostile-response handling. No network, ever.
 */

import { describe, expect, it } from "vitest";
import { createMeshyProvider } from "../providers/meshy";
import { ProviderError } from "../providers/types";

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as typeof fetch;
}

const image = { bytes: new Uint8Array([1, 2, 3]), mime: "image/png" };

describe("createMeshyProvider", () => {
  it("creates a task and returns the provider task id", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ result: "task-abc_123" }), { status: 200 });
    }) as typeof fetch;
    const provider = createMeshyProvider("key", fetchImpl);
    const id = await provider.createTask(image);
    expect(id).toBe("task-abc_123");
    const body = calls[0].body as Record<string, unknown>;
    // Geometry only — texturing must be off, and the image travels as a data URI.
    expect(body.should_texture).toBe(false);
    expect(String(body.image_url)).toMatch(/^data:image\/png;base64,/);
  });

  it.each([
    [401, "auth"],
    [402, "quota"],
    [429, "rateLimited"],
    [400, "invalidInput"],
    [500, "protocol"],
  ] as const)("classifies HTTP %s as %s", async (status, kind) => {
    const provider = createMeshyProvider("key", jsonFetch(status, {}));
    const error = await provider.createTask(image).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe(kind);
  });

  it("classifies an unreachable provider as a network error", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const provider = createMeshyProvider("key", fetchImpl);
    const error = await provider.createTask(image).catch((e) => e);
    expect((error as ProviderError).kind).toBe("network");
  });

  it("refuses invalid JSON and a missing task id", async () => {
    const bad = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    await expect(createMeshyProvider("k", bad).createTask(image)).rejects.toThrow(
      ProviderError
    );
    const noId = createMeshyProvider("k", jsonFetch(200, { result: 42 }));
    await expect(noId.createTask(image)).rejects.toThrow(ProviderError);
  });

  it("maps the task lifecycle states", async () => {
    const provider = (body: unknown) => createMeshyProvider("k", jsonFetch(200, body));
    expect(await provider({ status: "PENDING" }).getTask("t")).toEqual({
      state: "pending",
    });
    expect(await provider({ status: "IN_PROGRESS", progress: 40 }).getTask("t")).toEqual({
      state: "running",
      progress: 0.4,
    });
    expect(
      await provider({
        status: "SUCCEEDED",
        model_urls: { obj: "https://assets.meshy.ai/x.obj" },
      }).getTask("t")
    ).toEqual({ state: "succeeded", modelUrl: "https://assets.meshy.ai/x.obj", format: "obj" });
    expect(
      await provider({ status: "FAILED", task_error: { message: "boom" } }).getTask("t")
    ).toEqual({ state: "failed", reason: "boom" });
    expect(await provider({ status: "CANCELED" }).getTask("t")).toEqual({
      state: "failed",
      reason: "CANCELED",
    });
  });

  it("treats success without an OBJ URL and unknown statuses as protocol errors", async () => {
    const noObj = createMeshyProvider("k", jsonFetch(200, { status: "SUCCEEDED", model_urls: {} }));
    await expect(noObj.getTask("t")).rejects.toThrow(ProviderError);
    const weird = createMeshyProvider("k", jsonFetch(200, { status: "SPINNING" }));
    await expect(weird.getTask("t")).rejects.toThrow(ProviderError);
  });

  it("refuses task ids that could not have come from Meshy", async () => {
    const provider = createMeshyProvider("k", jsonFetch(200, { status: "PENDING" }));
    await expect(provider.getTask("../../etc/passwd")).rejects.toThrow(ProviderError);
  });
});
