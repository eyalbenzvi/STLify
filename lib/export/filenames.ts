/**
 * Safe, clean filename generation for exports.
 */

/** Sanitize a user-supplied name into a safe filename stem. */
export function safeFilenameStem(raw: string, fallback = "design"): string {
  const cleaned = raw
    .trim()
    // Keep letters (incl. Hebrew), digits, spaces, dashes, underscores.
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
}

/** yyyy-mm-dd stamp for filenames. */
export function dateStamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "my-sign_2026-08-06.formadesign.json" style names. */
export function designFileName(title: string, fallbackStem: string, date?: Date): string {
  return `${safeFilenameStem(title, fallbackStem)}_${dateStamp(date)}.formadesign.json`;
}

export function stlFileName(title: string, fallbackStem: string): string {
  return `${safeFilenameStem(title, fallbackStem)}.stl`;
}

export function zipFileName(title: string, fallbackStem: string): string {
  return `${safeFilenameStem(title, fallbackStem)}_parts.zip`;
}

export function threeMfFileName(title: string, fallbackStem: string): string {
  return `${safeFilenameStem(title, fallbackStem)}.3mf`;
}

/** Per-part STL name inside the multi-colour ZIP. */
export function partFileName(index: number, slotName: string, partName: string): string {
  const slot = safeFilenameStem(slotName, `color-${index + 1}`);
  const part = safeFilenameStem(partName, "part");
  return `${String(index + 1).padStart(2, "0")}_${slot}_${part}.stl`;
}
