/**
 * Compact share links for SMALL designs only.
 *
 * The design data itself is deflate-compressed and base64url-encoded into
 * the URL HASH (never query parameters, so it is not sent to any server).
 * Only text / base / hole / small-SVG designs qualify; raster images and
 * anything that would exceed a conservative URL length are rejected — the
 * UI then directs the user to file sharing instead.
 *
 * There is deliberately NO server, no short link, no permissions: the link
 * IS the data. Opening it loads the design into memory for that session.
 */

import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import type { DesignState } from "@/types/design";
import { parsePortableDesign, PortableImportError } from "./portable";
import { buildPortableFile, serializePortable } from "./portable";

/** Conservative maximum for the full URL (old browsers / chat apps). */
export const SHARE_MAX_URL_LENGTH = 8000;
/** SVG markup above this size disqualifies link sharing. */
const SHARE_MAX_SVG_CHARS = 4000;

export const SHARE_HASH_PREFIX = "#d=";

export type ShareEligibility =
  | { ok: true }
  | { ok: false; reasonHe: string };

/** Check whether the design is small/simple enough for a share link. */
export function shareLinkEligibility(state: DesignState): ShareEligibility {
  for (const layer of state.doc.layers) {
    if (layer.type === "imageRelief") {
      return {
        ok: false,
        reasonHe: "עיצובים עם תמונות אינם נתמכים בקישור — יש לשתף כקובץ עיצוב",
      };
    }
    if (layer.type === "svg" && layer.svgText.length > SHARE_MAX_SVG_CHARS) {
      return {
        ok: false,
        reasonHe: "קובץ ה-SVG בעיצוב גדול מדי לשיתוף בקישור — יש לשתף כקובץ עיצוב",
      };
    }
  }
  return { ok: true };
}

/**
 * Encode the design into a hash fragment. Returns null when the encoded
 * result exceeds the URL budget.
 */
export function encodeShareHash(state: DesignState, baseUrlLength: number): string | null {
  const eligibility = shareLinkEligibility(state);
  if (!eligibility.ok) return null;

  const portable = buildPortableFile({ state, title: state.doc.title, assets: {} });
  const json = serializePortable(portable);
  const compressed = deflateSync(strToU8(json), { level: 9 });
  const encoded = base64UrlEncode(compressed);
  const hash = SHARE_HASH_PREFIX + encoded;
  if (baseUrlLength + hash.length > SHARE_MAX_URL_LENGTH) return null;
  return hash;
}

/**
 * Decode a share hash back into a design state. Returns null when the hash
 * is not a share link; throws PortableImportError for corrupt data.
 */
export function decodeShareHash(hash: string): DesignState | null {
  if (!hash.startsWith(SHARE_HASH_PREFIX)) return null;
  const encoded = hash.slice(SHARE_HASH_PREFIX.length);
  if (!encoded || encoded.length > SHARE_MAX_URL_LENGTH) return null;
  let json: string;
  try {
    const compressed = base64UrlDecode(encoded);
    json = strFromU8(inflateSync(compressed));
  } catch {
    throw new PortableImportError("הקישור פגום או חתוך — לא ניתן לטעון את העיצוב");
  }
  const parsed = parsePortableDesign(json);
  // Link designs never carry raster assets.
  if (Object.keys(parsed.assets).length > 0) {
    throw new PortableImportError("קישור השיתוף מכיל נתונים לא צפויים");
  }
  return parsed.state;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = typeof btoa !== "undefined" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): Uint8Array {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  if (typeof atob !== "undefined") {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(padded, "base64"));
}
