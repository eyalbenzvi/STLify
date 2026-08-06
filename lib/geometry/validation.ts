/**
 * Pure numeric-input helpers shared by validation and the UI controls.
 * Intentionally free of three.js (or other heavy) imports so it can be
 * unit-tested in isolation and reused everywhere.
 * Document-level validation lives in documentValidation.ts.
 */

/** Clamp a number into [min, max]; returns fallback for non-finite input. */
export function clampNumber(
  value: number,
  min: number,
  max: number,
  fallback: number = min
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Parse user text into a finite number, or return null when invalid. */
export function parseNumericInput(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Maximum corner radius that keeps a rounded rectangle well-formed. */
export function maxCornerRadius(widthMm: number, heightMm: number): number {
  return Math.max(0, Math.min(widthMm, heightMm) / 2 - 0.01);
}

/** True when the string contains at least one non-whitespace character. */
export function hasVisibleText(content: string): boolean {
  return content.trim().length > 0;
}
