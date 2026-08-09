/**
 * Same-origin proxy for the on-device AI model weights.
 *
 * The browser cannot download the weights from their public homes directly:
 * GitHub's release-asset chain (github.com 302 → release-assets host) sends
 * no Access-Control-Allow-Origin header at any hop, so a cross-origin fetch
 * is blocked before a single byte arrives. Serving the files through our own
 * origin removes CORS from the picture entirely — and as a side effect the
 * user's browser never talks to a third party at all; only this server does.
 *
 * Trust boundaries: the route accepts ONLY the file names in the model
 * registry (nothing client-supplied reaches a URL), and the upstream body is
 * size-capped while streaming — the same "spend the budget on bytes that
 * actually arrive" rule the model cache and the ZIP reader follow.
 */

import { AI_MODELS, MAX_MODEL_BYTES, type AiModelSpec } from "@/lib/ai/models";

/** Where the server fetches a model from: env base override, else default. */
export function upstreamModelUrl(
  spec: AiModelSpec,
  env: Record<string, string | undefined> = process.env
): string {
  const base = env.NEXT_PUBLIC_AI_MODEL_BASE_URL;
  if (base) return `${base.replace(/\/+$/, "")}/${spec.fileName}`;
  return spec.defaultUrl;
}

function errorResponse(status: number, messageHe: string): Response {
  return new Response(JSON.stringify({ messageHe }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** GET /api/ai-models/[fileName] — stream a registered model through. */
export async function handleModelDownload(
  fileName: string,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const spec = Object.values(AI_MODELS).find((model) => model.fileName === fileName);
  if (!spec) {
    return errorResponse(404, "קובץ מודל לא מוכר — ראו את רשימת המודלים ב-lib/ai/models.ts");
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamModelUrl(spec));
  } catch {
    return errorResponse(502, "הורדת מודל ה-AI מהמקור נכשלה — בדקו את חיבור השרת לאינטרנט");
  }
  if (!upstream.ok || !upstream.body) {
    return errorResponse(
      502,
      `הורדת מודל ה-AI מהמקור נכשלה (שגיאה ${upstream.status}) — נסו שוב מאוחר יותר`
    );
  }

  const declared = Number(upstream.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_MODEL_BYTES) {
    return errorResponse(502, "קובץ המודל במקור גדול מהמותר — בדקו את כתובת המודל המוגדרת");
  }

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
      if (received > MAX_MODEL_BYTES) {
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

  const headers = new Headers({
    "content-type": "application/octet-stream",
    // The client keeps its own Cache API copy, but letting the HTTP cache
    // hold it too makes a cleared-cache re-download cheap. The URLs are
    // version-pinned upstream, so immutable is honest.
    "cache-control": "public, max-age=31536000, immutable",
  });
  if (Number.isFinite(declared) && declared > 0) {
    headers.set("content-length", String(declared));
  }
  return new Response(body, { status: 200, headers });
}
