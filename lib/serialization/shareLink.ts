/**
 * Compact share links for SMALL designs only (ported from the V2 branch;
 * fflate replaced by the platform CompressionStream).
 *
 * The design data is deflate-compressed and base64url-encoded into the URL
 * HASH (never query parameters, so it is not sent to any server). Designs
 * containing mesh payloads (imported STL, image reliefs) or anything that
 * would exceed a conservative URL length are rejected — the UI then directs
 * the user to file sharing instead.
 *
 * There is deliberately NO server, no short link, no permissions: the link
 * IS the data. Opening it loads the design into memory for that session.
 */

import type { DesignDocument } from "@/types/design";
import {
  importDesignFile,
  serializeDesignFile,
  type DesignFileImportResult,
} from "./designFile";

/** Conservative maximum for the full URL (old browsers / chat apps). */
export const SHARE_MAX_URL_LENGTH = 8000;

export const SHARE_HASH_PREFIX = "#d=";

export type ShareEligibility = { ok: true } | { ok: false; reasonHe: string };

/** Check whether the design is small/simple enough for a share link. */
export function shareLinkEligibility(document: DesignDocument): ShareEligibility {
  for (const layer of document.layers) {
    if (layer.type === "importedMesh") {
      return {
        ok: false,
        reasonHe: "עיצובים עם רשתות מיובאות אינם נתמכים בקישור — יש לשתף כקובץ עיצוב",
      };
    }
    if (layer.type === "imageRelief" && layer.mode === "relief") {
      return {
        ok: false,
        reasonHe: "עיצובים עם תבליטי תמונה אינם נתמכים בקישור — יש לשתף כקובץ עיצוב",
      };
    }
  }
  return { ok: true };
}

async function pipeThrough(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(source).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encode the design into a URL hash fragment ("#d=...").
 * Returns null when the encoded link would be too long.
 */
export async function encodeShareHash(document: DesignDocument): Promise<string | null> {
  const json = serializeDesignFile(document);
  const compressed = await pipeThrough(
    new TextEncoder().encode(json),
    new CompressionStream("deflate-raw")
  );
  const hash = SHARE_HASH_PREFIX + toBase64Url(compressed);
  return hash.length <= SHARE_MAX_URL_LENGTH ? hash : null;
}

/** Decode a "#d=..." hash back into a validated design document. */
export async function decodeShareHash(hash: string): Promise<DesignFileImportResult> {
  if (!hash.startsWith(SHARE_HASH_PREFIX)) {
    throw new Error("not a share hash");
  }
  const bytes = fromBase64Url(hash.slice(SHARE_HASH_PREFIX.length));
  const json = new TextDecoder().decode(
    await pipeThrough(bytes, new DecompressionStream("deflate-raw"))
  );
  return importDesignFile(json);
}
