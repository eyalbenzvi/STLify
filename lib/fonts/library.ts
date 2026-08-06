/**
 * V2 font library: metadata for the font browser (categories, language
 * support, 3D-printing suitability) on top of the V1 loader. All fonts are
 * static TTFs served from /public/fonts — nothing is fetched from external
 * hosts, so export never depends on third-party availability.
 */

import type { Font } from "opentype.js";
import { FONTS, loadFont as loadFontV1, type FontInfo } from "@/lib/geometry/fonts";
import type { FontId } from "@/lib/geometry/types";

export type FontCategory = "sans" | "serif" | "display" | "rounded";

export interface FontLibraryEntry {
  id: string;
  nameHe: string;
  nameEn: string;
  category: FontCategory;
  supportsHebrew: boolean;
  supportsEnglish: boolean;
  /** Sturdy stroke widths that survive FDM printing at small sizes. */
  recommendedFor3D: boolean;
  hasBold: boolean;
}

export const FONT_LIBRARY: FontLibraryEntry[] = [
  {
    id: "alef",
    nameHe: "אלף",
    nameEn: "Alef",
    category: "sans",
    supportsHebrew: true,
    supportsEnglish: true,
    recommendedFor3D: true,
    hasBold: true,
  },
  {
    id: "varelaRound",
    nameHe: "ורלה עגול",
    nameEn: "Varela Round",
    category: "rounded",
    supportsHebrew: true,
    supportsEnglish: true,
    recommendedFor3D: true,
    hasBold: false,
  },
  {
    id: "suezOne",
    nameHe: "סואץ וואן",
    nameEn: "Suez One",
    category: "display",
    supportsHebrew: true,
    supportsEnglish: true,
    recommendedFor3D: true,
    hasBold: false,
  },
  {
    id: "davidLibre",
    nameHe: "דוד ליברה",
    nameEn: "David Libre",
    category: "serif",
    supportsHebrew: true,
    supportsEnglish: true,
    // Serif hairlines get fragile below ~6mm text.
    recommendedFor3D: false,
    hasBold: true,
  },
];

export const CATEGORY_LABELS: Record<FontCategory, string> = {
  sans: "ללא עיטור (Sans)",
  serif: "עם עיטור (Serif)",
  display: "כותרות",
  rounded: "מעוגל",
};

const DEFAULT_FONT_ID: FontId = "alef";

function isV1FontId(id: string): id is FontId {
  return FONTS.some((f: FontInfo) => f.id === id);
}

/** Resolve an arbitrary font-id string to a loadable id (safe fallback). */
export function resolveFontId(id: string): FontId {
  return isV1FontId(id) ? id : DEFAULT_FONT_ID;
}

export function getFontEntry(id: string): FontLibraryEntry {
  return FONT_LIBRARY.find((f) => f.id === id) ?? FONT_LIBRARY[0];
}

/** Load a font by V2 id (falls back to the default family when unknown). */
export function loadFontById(id: string, bold: boolean): Promise<Font> {
  return loadFontV1(resolveFontId(id), bold);
}

/** Characters in the text that the font cannot render. */
export function findUnsupportedChars(font: Font, text: string): string[] {
  const missing = new Set<string>();
  for (const char of text) {
    if (char === "\n" || char === " " || char === "\t") continue;
    if (!font.hasChar(char)) missing.add(char);
  }
  return [...missing];
}
