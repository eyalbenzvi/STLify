"use client";

/**
 * Font browser: search, category filter, Hebrew/English support and
 * 3D-printing suitability indicators, session favourites and recents, and
 * a live preview using the current layer text.
 */

import { useMemo, useState } from "react";
import {
  CATEGORY_LABELS,
  FONT_LIBRARY,
  type FontCategory,
  type FontLibraryEntry,
} from "@/lib/fonts/library";
import {
  pushRecentFont,
  toggleFavoriteFont,
  useSessionPrefs,
} from "@/lib/design/sessionPrefs";
import { Modal, SecondaryButton } from "@/components/ui/Modal";

/** CSS families matching the bundled TTFs (same files, loaded via globals.css). */
const PREVIEW_FAMILIES: Record<string, string> = {
  alef: "'Alef Preview', sans-serif",
  davidLibre: "'David Libre Preview', serif",
  suezOne: "'Suez One Preview', serif",
  varelaRound: "'Varela Round Preview', sans-serif",
};

interface FontBrowserDialogProps {
  open: boolean;
  currentFontId: string;
  previewText: string;
  onSelect: (fontId: string) => void;
  onClose: () => void;
}

export function FontBrowserDialog({
  open,
  currentFontId,
  previewText,
  onSelect,
  onClose,
}: FontBrowserDialogProps) {
  const prefs = useSessionPrefs();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<FontCategory | "all" | "favorites">("all");

  const fonts = useMemo(() => {
    let list = FONT_LIBRARY;
    if (category === "favorites") {
      list = list.filter((f) => prefs.favoriteFonts.includes(f.id));
    } else if (category !== "all") {
      list = list.filter((f) => f.category === category);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (f) => f.nameHe.includes(query.trim()) || f.nameEn.toLowerCase().includes(q)
      );
    }
    // Recent fonts first.
    return [...list].sort(
      (a, b) => rank(a, prefs.recentFonts) - rank(b, prefs.recentFonts)
    );
  }, [category, query, prefs.favoriteFonts, prefs.recentFonts]);

  const sample = previewText.trim() ? previewText.split("\n")[0].slice(0, 24) : "אבג ABC 123";

  return (
    <Modal title="ספריית גופנים" open={open} onClose={onClose} widthClass="max-w-2xl">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            dir="rtl"
            placeholder="חיפוש גופן…"
            aria-label="חיפוש גופן"
            className="min-w-40 flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="סינון לפי קטגוריה"
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={category}
            onChange={(e) => setCategory(e.target.value as FontCategory | "all" | "favorites")}
          >
            <option value="all">כל הקטגוריות</option>
            <option value="favorites">★ מועדפים</option>
            {Object.entries(CATEGORY_LABELS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {fonts.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">לא נמצאו גופנים מתאימים</p>
        )}

        <div className="flex flex-col gap-2">
          {fonts.map((font) => (
            <div
              key={font.id}
              className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                font.id === currentFontId
                  ? "border-blue-400 bg-blue-50"
                  : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-start"
                onClick={() => {
                  pushRecentFont(font.id);
                  onSelect(font.id);
                  onClose();
                }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-slate-800">{font.nameHe}</span>
                  <span className="text-xs text-slate-400" dir="ltr">
                    {font.nameEn}
                  </span>
                  <Tag ok={font.supportsHebrew}>עברית</Tag>
                  <Tag ok={font.supportsEnglish}>English</Tag>
                  {font.recommendedFor3D ? (
                    <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
                      מומלץ להדפסה
                    </span>
                  ) : (
                    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                      קווים דקים — זהירות בגדלים קטנים
                    </span>
                  )}
                  {prefs.recentFonts.includes(font.id) && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                      בשימוש לאחרונה
                    </span>
                  )}
                </div>
                <div
                  className="mt-1 truncate text-2xl text-slate-700"
                  style={{ fontFamily: PREVIEW_FAMILIES[font.id] ?? "sans-serif" }}
                >
                  {sample}
                </div>
              </button>
              <button
                type="button"
                aria-label={
                  prefs.favoriteFonts.includes(font.id) ? "הסרה מהמועדפים" : "הוספה למועדפים"
                }
                className={`text-xl ${prefs.favoriteFonts.includes(font.id) ? "text-amber-400" : "text-slate-300 hover:text-amber-300"}`}
                onClick={() => toggleFavoriteFont(font.id)}
              >
                ★
              </button>
            </div>
          ))}
        </div>

        <p className="text-xs text-slate-400">
          המועדפים והגופנים האחרונים נשמרים רק להפעלה הנוכחית של הדפדפן.
        </p>
        <div className="flex justify-end">
          <SecondaryButton onClick={onClose}>סגירה</SecondaryButton>
        </div>
      </div>
    </Modal>
  );
}

function Tag({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] ${ok ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-400 line-through"}`}
    >
      {children}
    </span>
  );
}

function rank(font: FontLibraryEntry, recent: string[]): number {
  const idx = recent.indexOf(font.id);
  return idx === -1 ? 999 : idx;
}
