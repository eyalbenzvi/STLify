/**
 * Proxy route-handler tests: the handlers are plain functions over Request/
 * Response, driven here with a fake provider. Covers the trust boundaries —
 * missing key, size caps, magic bytes, rate limits, opaque ids, and the
 * model-download allowlist + streaming cap.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  handleAvailability,
  handleCreateTask,
  handleTaskModel,
  handleTaskStatus,
  modelUrlAllowed,
  resetImageTo3dStateForTests,
  MAX_UPLOAD_BYTES,
} from "@/lib/server/imageTo3d";
import type { MeshGenProvider, ProviderTaskState } from "@/lib/ai/providers";
import { ProviderError } from "@/lib/ai/providers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function fakeProvider(overrides: Partial<MeshGenProvider> = {}): MeshGenProvider {
  return {
    id: "fake",
    nameHe: "ספק בדיקה",
    modelHostAllowlist: [".example.com"],
    async createTask() {
      return "provider-task-1";
    },
    async getTask(): Promise<ProviderTaskState> {
      return { state: "pending" };
    },
    ...overrides,
  };
}

function createRequest(body: Uint8Array, ip = "10.0.0.1"): Request {
  return new Request("http://localhost/api/image-to-3d", {
    method: "POST",
    body: body.slice().buffer as ArrayBuffer,
    headers: { "x-forwarded-for": ip },
  });
}

function getRequest(ip = "10.0.0.1"): Request {
  return new Request("http://localhost/api/image-to-3d/x", {
    headers: { "x-forwarded-for": ip },
  });
}

async function createdTaskId(provider: MeshGenProvider, ip = "10.0.0.1"): Promise<string> {
  const response = await handleCreateTask(createRequest(PNG, ip), provider);
  expect(response.status).toBe(200);
  const { taskId } = (await response.json()) as { taskId: string };
  return taskId;
}

beforeEach(() => resetImageTo3dStateForTests());

describe("availability", () => {
  it("reports enabled + provider name, or disabled without one", async () => {
    expect(await handleAvailability(fakeProvider()).json()).toEqual({
      enabled: true,
      providerNameHe: "ספק בדיקה",
    });
    expect(await handleAvailability(null).json()).toEqual({
      enabled: false,
      providerNameHe: null,
    });
  });
});

describe("create task", () => {
  it("answers 503 with a Hebrew message when no key is configured", async () => {
    const response = await handleCreateTask(createRequest(PNG), null);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { messageHe: string };
    expect(body.messageHe).toContain("IMAGE_TO_3D_API_KEY");
  });

  it("mints an OPAQUE task id — the provider's id never reaches the client", async () => {
    const taskId = await createdTaskId(fakeProvider());
    expect(taskId).toMatch(/^[a-f0-9-]{36}$/);
    expect(taskId).not.toContain("provider-task-1");
  });

  it("refuses a body over the cap — by header and by actual bytes", async () => {
    const headerLie = new Request("http://localhost/api/image-to-3d", {
      method: "POST",
      body: PNG.slice().buffer as ArrayBuffer,
      headers: { "content-length": String(MAX_UPLOAD_BYTES + 1) },
    });
    expect((await handleCreateTask(headerLie, fakeProvider())).status).toBe(413);

    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(PNG);
    expect((await handleCreateTask(createRequest(big), fakeProvider())).status).toBe(413);
  });

  it("sniffs magic bytes instead of trusting a content type", async () => {
    const notAnImage = new TextEncoder().encode("<script>alert(1)</script>");
    const response = await handleCreateTask(createRequest(notAnImage), fakeProvider());
    expect(response.status).toBe(415);
    expect((await handleCreateTask(createRequest(new Uint8Array()), fakeProvider())).status).toBe(400);
  });

  it("rate limits creations per client", async () => {
    const provider = fakeProvider();
    for (let i = 0; i < 6; i++) {
      expect((await handleCreateTask(createRequest(PNG, "1.2.3.4"), provider)).status).toBe(200);
    }
    expect((await handleCreateTask(createRequest(PNG, "1.2.3.4"), provider)).status).toBe(429);
    // A different client is unaffected.
    expect((await handleCreateTask(createRequest(PNG, "5.6.7.8"), provider)).status).toBe(200);
  });

  it("caps creations globally, so spoofed client keys buy nothing", async () => {
    const provider = fakeProvider();
    // 30 creations across freshly-invented "clients" exhaust the global
    // budget; the 31st is refused even from a never-seen key.
    for (let i = 0; i < 30; i++) {
      const response = await handleCreateTask(createRequest(PNG, `10.9.${i}.1`), provider);
      expect(response.status).toBe(200);
    }
    expect(
      (await handleCreateTask(createRequest(PNG, "99.99.99.99"), provider)).status
    ).toBe(429);
  });

  it("maps provider errors to statuses with Hebrew messages", async () => {
    const quota = fakeProvider({
      async createTask() {
        throw new ProviderError("quota", "out of credits");
      },
    });
    const response = await handleCreateTask(createRequest(PNG), quota);
    expect(response.status).toBe(402);
    expect(((await response.json()) as { messageHe: string }).messageHe).toContain("מכסת");
  });
});

describe("task status", () => {
  it("404s unknown and malformed ids without asking the provider", async () => {
    let asked = 0;
    const provider = fakeProvider({
      async getTask() {
        asked++;
        return { state: "pending" };
      },
    });
    const missing = await handleTaskStatus(
      getRequest(),
      "123e4567-e89b-12d3-a456-426614174000",
      provider
    );
    expect(missing.status).toBe(404);
    expect((await handleTaskStatus(getRequest(), "../../secrets", provider)).status).toBe(404);
    expect(asked).toBe(0);
  });

  it("reports states and never leaks the provider's model URL", async () => {
    const provider = fakeProvider({
      async getTask(): Promise<ProviderTaskState> {
        return {
          state: "succeeded",
          modelUrl: "https://cdn.example.com/secret.obj",
          format: "obj",
        };
      },
    });
    const taskId = await createdTaskId(provider);
    const response = await handleTaskStatus(getRequest(), taskId, provider);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ state: "succeeded" });
    expect(text).not.toContain("secret.obj");
  });

  it("passes provider failure reasons through in Hebrew", async () => {
    const provider = fakeProvider({
      async getTask(): Promise<ProviderTaskState> {
        return { state: "failed", reason: "nsfw content" };
      },
    });
    const taskId = await createdTaskId(provider);
    const body = (await (await handleTaskStatus(getRequest(), taskId, provider)).json()) as {
      state: string;
      messageHe: string;
    };
    expect(body.state).toBe("failed");
    expect(body.messageHe).toContain("nsfw content");
  });
});

describe("model download", () => {
  const succeeded = (url: string) =>
    fakeProvider({
      async getTask(): Promise<ProviderTaskState> {
        return { state: "succeeded", modelUrl: url, format: "obj" };
      },
    });

  it("modelUrlAllowed: https + host suffix only", () => {
    const allow = [".example.com"];
    expect(modelUrlAllowed("https://cdn.example.com/a.obj", allow)).toBe(true);
    expect(modelUrlAllowed("https://example.com/a.obj", allow)).toBe(true);
    expect(modelUrlAllowed("http://cdn.example.com/a.obj", allow)).toBe(false);
    expect(modelUrlAllowed("https://evil.com/a.obj", allow)).toBe(false);
    expect(modelUrlAllowed("https://example.com.evil.com/a.obj", allow)).toBe(false);
    expect(modelUrlAllowed("file:///etc/passwd", allow)).toBe(false);
    expect(modelUrlAllowed("not a url", allow)).toBe(false);
  });

  it("streams an allowed model through", async () => {
    const provider = succeeded("https://cdn.example.com/model.obj");
    const taskId = await createdTaskId(provider);
    const fetchImpl = (async () =>
      new Response("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", { status: 200 })) as typeof fetch;
    const response = await handleTaskModel(getRequest(), taskId, provider, fetchImpl);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("f 1 2 3");
  });

  it("refuses a URL outside the provider's allowlist (SSRF guard)", async () => {
    const provider = succeeded("https://169.254.169.254/latest/meta-data");
    const taskId = await createdTaskId(provider);
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched++;
      return new Response("x");
    }) as typeof fetch;
    const response = await handleTaskModel(getRequest(), taskId, provider, fetchImpl);
    expect(response.status).toBe(502);
    expect(fetched).toBe(0);
  });

  it("409s while the task is not finished", async () => {
    const provider = fakeProvider();
    const taskId = await createdTaskId(provider);
    const response = await handleTaskModel(getRequest(), taskId, provider);
    expect(response.status).toBe(409);
  });

  it("kills a download that exceeds the cap mid-stream", async () => {
    const provider = succeeded("https://cdn.example.com/huge.obj");
    const taskId = await createdTaskId(provider);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      },
    });
    const fetchImpl = (async () => new Response(endless, { status: 200 })) as typeof fetch;
    const response = await handleTaskModel(getRequest(), taskId, provider, fetchImpl);
    expect(response.status).toBe(200); // headers are already out; the STREAM errors
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("refuses an upstream that declares an oversized model", async () => {
    const provider = succeeded("https://cdn.example.com/huge.obj");
    const taskId = await createdTaskId(provider);
    const fetchImpl = (async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(200 * 1024 * 1024) },
      })) as typeof fetch;
    const response = await handleTaskModel(getRequest(), taskId, provider, fetchImpl);
    expect(response.status).toBe(502);
  });
});
