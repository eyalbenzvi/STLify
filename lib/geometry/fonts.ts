/**
 * Font registry and loader. Fonts are static TTF files served from
 * /public/fonts and parsed client-side with opentype.js. Parsed fonts are
 * cached per (fontId, bold) pair.
 */

import { parse, type Font } from "opentype.js";
import type { FontId } from "./types";

export interface FontInfo {
  id: FontId;
  /** Hebrew display name for the UI. */
  nameHe: string;
  regularUrl: string;
  /** URL of a true bold cut, when the family has one. */
  boldUrl: string | null;
}

export const FONTS: FontInfo[] = [
  {
    id: "alef",
    nameHe: "אלף (סנס)",
    regularUrl: "/fonts/Alef-Regular.ttf",
    boldUrl: "/fonts/Alef-Bold.ttf",
  },
  {
    id: "davidLibre",
    nameHe: "דוד ליברה (סריף)",
    regularUrl: "/fonts/DavidLibre-Regular.ttf",
    boldUrl: "/fonts/DavidLibre-Bold.ttf",
  },
  {
    id: "suezOne",
    nameHe: "סואץ וואן (כותרות)",
    regularUrl: "/fonts/SuezOne-Regular.ttf",
    boldUrl: null,
  },
  {
    id: "varelaRound",
    nameHe: "ורלה עגול",
    regularUrl: "/fonts/VarelaRound-Regular.ttf",
    boldUrl: null,
  },
];

export function getFontInfo(id: FontId): FontInfo {
  const info = FONTS.find((f) => f.id === id);
  if (!info) throw new Error(`Unknown font: ${id}`);
  return info;
}

/** True when the family ships a real bold cut. */
export function fontHasBold(id: FontId): boolean {
  return getFontInfo(id).boldUrl !== null;
}

const fontCache = new Map<string, Promise<Font>>();

/**
 * Load and parse a font. Falls back to the regular cut when bold is requested
 * but the family has no bold file.
 */
export function loadFont(id: FontId, bold: boolean): Promise<Font> {
  const info = getFontInfo(id);
  const url = bold && info.boldUrl ? info.boldUrl : info.regularUrl;
  const cached = fontCache.get(url);
  if (cached) return cached;

  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load font ${url}: ${res.status}`);
      return res.arrayBuffer();
    })
    .then((buffer) => parse(buffer));

  // Drop failed loads from the cache so a retry can succeed.
  promise.catch(() => fontCache.delete(url));
  fontCache.set(url, promise);
  return promise;
}
