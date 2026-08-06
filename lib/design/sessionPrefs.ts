"use client";

/**
 * Session-only UI preferences: recent colours, favourite / recently-used
 * fonts. Kept in module memory ONLY (no localStorage / cookies) — they
 * reset when the tab closes, by design.
 */

import { useSyncExternalStore } from "react";

interface SessionPrefs {
  recentColors: string[];
  favoriteFonts: string[];
  recentFonts: string[];
}

let prefs: SessionPrefs = { recentColors: [], favoriteFonts: [], recentFonts: [] };
const listeners = new Set<() => void>();

function emit(): void {
  prefs = { ...prefs };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = (): SessionPrefs => prefs;
const serverPrefs: SessionPrefs = { recentColors: [], favoriteFonts: [], recentFonts: [] };

export function useSessionPrefs(): SessionPrefs {
  return useSyncExternalStore(subscribe, getSnapshot, () => serverPrefs);
}

export function pushRecentColor(hex: string): void {
  const clean = hex.toLowerCase();
  prefs.recentColors = [clean, ...prefs.recentColors.filter((c) => c !== clean)].slice(0, 10);
  emit();
}

export function toggleFavoriteFont(id: string): void {
  prefs.favoriteFonts = prefs.favoriteFonts.includes(id)
    ? prefs.favoriteFonts.filter((f) => f !== id)
    : [...prefs.favoriteFonts, id];
  emit();
}

export function pushRecentFont(id: string): void {
  prefs.recentFonts = [id, ...prefs.recentFonts.filter((f) => f !== id)].slice(0, 6);
  emit();
}
