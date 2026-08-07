/**
 * Serve the bundled fonts from disk when the geometry pipeline runs outside
 * a browser.
 *
 * lib/geometry/fonts.ts loads typefaces with `fetch("/fonts/…")`, which is a
 * same-origin URL the dev server resolves against ./public. Node has no
 * origin, so every headless caller — the batch CLI, the benchmark suite and
 * the geometry tests — has to bridge that gap before it can build a document
 * containing text. They each carried their own copy of this shim; this is it,
 * once.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Patch `globalThis.fetch` so `/fonts/*` reads from ./public and everything
 * else falls through untouched. Returns a function that restores the
 * original fetch, for callers that care.
 */
export function installNodeFontFetch(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/fonts/")) {
      const buffer = readFileSync(join(process.cwd(), "public", url));
      return new Response(new Uint8Array(buffer), { status: 200 });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}
