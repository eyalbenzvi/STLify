/**
 * Server-side logic for the /api/image-to-3d proxy, kept out of the route
 * files so it is unit-testable as plain functions.
 *
 * Trust boundaries handled here:
 * - The uploaded image is hostile: capped on the bytes that actually arrive
 *   (headers can lie) and identified by magic bytes (content-type can lie).
 * - The provider's answers are hostile too: task ids returned to the client
 *   are OPAQUE server-minted ids mapped in memory, so provider ids never
 *   reach the browser and the model route cannot be pointed at arbitrary
 *   tasks; the model URL must be https on the provider's own asset hosts
 *   and the download is capped while streaming.
 * - Basic per-client rate limiting, in memory, per instance — this app is a
 *   single-instance workshop tool and .env.example says so.
 */

import { randomUUID } from "node:crypto";
import { ProviderError, type MeshGenProvider } from "@/lib/ai/providers";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_MODEL_DOWNLOAD_BYTES = 100 * 1024 * 1024;
/** Creations per client per hour. */
const CREATE_LIMIT = 6;
const CREATE_WINDOW_MS = 60 * 60 * 1000;
/** Status polls per client per minute (a 4s poll uses 15). */
const POLL_LIMIT = 120;
const POLL_WINDOW_MS = 60 * 1000;
/** How long a finished/abandoned task mapping is kept. */
const TASK_TTL_MS = 2 * 60 * 60 * 1000;
const TASK_MAP_CAP = 500;

const OPAQUE_ID_RE = /^[a-f0-9-]{36}$/;

interface TaskRecord {
  providerTaskId: string;
  createdAt: number;
}

interface ProxyState {
  tasks: Map<string, TaskRecord>;
  createHits: Map<string, number[]>;
  pollHits: Map<string, number[]>;
}

/**
 * Stashed on globalThis so dev-server module reloads do not orphan running
 * tasks. Single-instance by design.
 */
const state: ProxyState = ((globalThis as Record<string, unknown>).__stlifyImageTo3d ??= {
  tasks: new Map<string, TaskRecord>(),
  createHits: new Map<string, number[]>(),
  pollHits: new Map<string, number[]>(),
}) as ProxyState;

/** Test hook: wipe the in-memory maps between cases. */
export function resetImageTo3dStateForTests(): void {
  state.tasks.clear();
  state.createHits.clear();
  state.pollHits.clear();
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, messageHe: string): Response {
  return jsonResponse(status, { messageHe });
}

/** Best-effort client identity for the rate limiter. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "local";
}

function rateLimited(
  hits: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number
): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

function pruneTasks(): void {
  const now = Date.now();
  for (const [id, record] of state.tasks) {
    if (now - record.createdAt > TASK_TTL_MS) state.tasks.delete(id);
  }
  // Oldest-first eviction if something floods the map anyway.
  while (state.tasks.size > TASK_MAP_CAP) {
    const oldest = state.tasks.keys().next().value;
    if (oldest === undefined) break;
    state.tasks.delete(oldest);
  }
}

/** PNG / JPEG / WEBP by magic bytes; anything else is refused. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  return null;
}

function providerErrorResponse(error: ProviderError): Response {
  switch (error.kind) {
    case "auth":
      return errorResponse(502, "מפתח ה-API של השרת נדחה על ידי הספק — בדקו את ההגדרה בשרת");
    case "quota":
      return errorResponse(402, "מכסת השירות בענן נוצלה — בדקו את החשבון אצל הספק");
    case "rateLimited":
      return errorResponse(429, "יותר מדי בקשות מול הספק — המתינו מעט ונסו שוב");
    case "invalidInput":
      return errorResponse(415, "הספק דחה את התמונה — נסו תמונה אחרת בפורמט PNG, JPG או WEBP");
    case "network":
      return errorResponse(502, "לא ניתן להתחבר לשירות הענן — נסו שוב מאוחר יותר");
    case "protocol":
      return errorResponse(502, "תשובת שירות הענן לא הובנה — נסו שוב מאוחר יותר");
  }
}

const NO_PROVIDER_HE =
  "יצירת מודל בענן אינה מוגדרת בשרת — חסר מפתח API (משתנה הסביבה IMAGE_TO_3D_API_KEY, ראו .env.example)";

/** GET /api/image-to-3d — is the cloud mode configured, and who is behind it. */
export function handleAvailability(provider: MeshGenProvider | null): Response {
  return jsonResponse(200, {
    enabled: provider !== null,
    providerNameHe: provider?.nameHe ?? null,
  });
}

/** POST /api/image-to-3d — image bytes in, opaque task id out. */
export async function handleCreateTask(
  request: Request,
  provider: MeshGenProvider | null
): Promise<Response> {
  if (!provider) return errorResponse(503, NO_PROVIDER_HE);
  if (rateLimited(state.createHits, clientKey(request), CREATE_LIMIT, CREATE_WINDOW_MS)) {
    return errorResponse(429, "יותר מדי בקשות יצירה — המתינו מעט ונסו שוב");
  }

  // The header is only a fast-path refusal; the real cap is on actual bytes.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return errorResponse(413, "התמונה גדולה מדי לשליחה לענן (מקסימום 8MB)");
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return errorResponse(400, "לא ניתן היה לקרוא את גוף הבקשה");
  }
  if (bytes.byteLength === 0) return errorResponse(400, "לא נשלחה תמונה");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return errorResponse(413, "התמונה גדולה מדי לשליחה לענן (מקסימום 8MB)");
  }
  const mime = sniffImageMime(bytes);
  if (!mime) {
    return errorResponse(415, "רק PNG, JPG או WEBP נתמכים בשליחה לענן");
  }

  try {
    const providerTaskId = await provider.createTask({ bytes, mime });
    pruneTasks();
    const taskId = randomUUID();
    state.tasks.set(taskId, { providerTaskId, createdAt: Date.now() });
    return jsonResponse(200, { taskId });
  } catch (err) {
    if (err instanceof ProviderError) return providerErrorResponse(err);
    return errorResponse(502, "יצירת המשימה אצל הספק נכשלה — נסו שוב מאוחר יותר");
  }
}

function lookupTask(taskId: string): TaskRecord | null {
  if (!OPAQUE_ID_RE.test(taskId)) return null;
  pruneTasks();
  return state.tasks.get(taskId) ?? null;
}

/** GET /api/image-to-3d/[taskId] — provider state, without provider URLs. */
export async function handleTaskStatus(
  request: Request,
  taskId: string,
  provider: MeshGenProvider | null
): Promise<Response> {
  if (!provider) return errorResponse(503, NO_PROVIDER_HE);
  if (rateLimited(state.pollHits, clientKey(request), POLL_LIMIT, POLL_WINDOW_MS)) {
    return errorResponse(429, "יותר מדי בקשות סטטוס — האטו את הקצב");
  }
  const record = lookupTask(taskId);
  if (!record) return errorResponse(404, "המשימה לא נמצאה — ייתכן שפג תוקפה");

  try {
    const task = await provider.getTask(record.providerTaskId);
    switch (task.state) {
      case "pending":
        return jsonResponse(200, { state: "pending" });
      case "running":
        return jsonResponse(200, { state: "running", progress: task.progress });
      case "failed":
        return jsonResponse(200, {
          state: "failed",
          messageHe: `יצירת המודל נכשלה אצל הספק: ${task.reason}`,
        });
      case "succeeded":
        // The model URL stays server-side; the client fetches through the
        // model route below.
        return jsonResponse(200, { state: "succeeded" });
    }
  } catch (err) {
    if (err instanceof ProviderError) return providerErrorResponse(err);
    return errorResponse(502, "בדיקת מצב המשימה נכשלה — נסו שוב");
  }
}

/** Is this URL one the provider is allowed to hand us? https + host suffix. */
export function modelUrlAllowed(url: string, allowlist: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return allowlist.some(
    (suffix) => parsed.hostname === suffix.replace(/^\./, "") || parsed.hostname.endsWith(suffix)
  );
}

/**
 * GET /api/image-to-3d/[taskId]/model — stream the finished OBJ back,
 * capped while streaming.
 */
export async function handleTaskModel(
  request: Request,
  taskId: string,
  provider: MeshGenProvider | null,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  if (!provider) return errorResponse(503, NO_PROVIDER_HE);
  if (rateLimited(state.pollHits, clientKey(request), POLL_LIMIT, POLL_WINDOW_MS)) {
    return errorResponse(429, "יותר מדי בקשות — האטו את הקצב");
  }
  const record = lookupTask(taskId);
  if (!record) return errorResponse(404, "המשימה לא נמצאה — ייתכן שפג תוקפה");

  let modelUrl: string;
  try {
    const task = await provider.getTask(record.providerTaskId);
    if (task.state !== "succeeded") {
      return errorResponse(409, "המודל עדיין אינו מוכן להורדה");
    }
    modelUrl = task.modelUrl;
  } catch (err) {
    if (err instanceof ProviderError) return providerErrorResponse(err);
    return errorResponse(502, "בדיקת מצב המשימה נכשלה — נסו שוב");
  }

  if (!modelUrlAllowed(modelUrl, provider.modelHostAllowlist)) {
    return errorResponse(502, "כתובת קובץ המודל שהחזיר הספק אינה מאושרת — ההורדה נדחתה");
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(modelUrl);
  } catch {
    return errorResponse(502, "הורדת קובץ המודל מהספק נכשלה — נסו שוב");
  }
  if (!upstream.ok || !upstream.body) {
    return errorResponse(502, `הורדת קובץ המודל מהספק נכשלה (${upstream.status})`);
  }

  const declared = Number(upstream.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_MODEL_DOWNLOAD_BYTES) {
    return errorResponse(502, "קובץ המודל שהחזיר הספק גדול מהמותר (מעל 100MB)");
  }

  // Pass-through stream with a hard byte cap enforced on arriving bytes.
  const reader = upstream.body.getReader();
  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      received += value.byteLength;
      if (received > MAX_MODEL_DOWNLOAD_BYTES) {
        controller.error(new Error("model download exceeded the size cap"));
        await reader.cancel().catch(() => undefined);
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });

  const headers = new Headers({ "content-type": "application/octet-stream" });
  if (Number.isFinite(declared) && declared > 0) {
    headers.set("content-length", String(declared));
  }
  return new Response(body, { status: 200, headers });
}
