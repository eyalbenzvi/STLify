/**
 * Minimal bidirectional-text handling for glyph layout.
 *
 * opentype.js lays glyphs out in string order, left to right. Hebrew is
 * stored in logical order but rendered right to left, so before layout we
 * reorder each line: RTL runs are reversed while embedded LTR runs (Latin
 * letters, digits) keep their internal order.
 *
 * This is a simplified algorithm (not full UAX#9). Known limitation:
 * complex mixed-direction nesting and combining marks (niqqud) are not
 * fully supported.
 */

const RTL_CHAR = /[\u0590-\u05FF\u0600-\u06FF\uFB1D-\uFB4F]/;
const LTR_CHAR = /[A-Za-z0-9\u00C0-\u024F]/;

/** True when the text contains at least one RTL (Hebrew/Arabic) character. */
export function containsRtl(text: string): boolean {
  return RTL_CHAR.test(text);
}

/**
 * Reorder a single line of text into visual order for LTR glyph layout.
 * Returns the input unchanged when it contains no RTL characters.
 */
export function toVisualOrder(line: string): string {
  if (!containsRtl(line)) return line;

  type Run = { dir: "rtl" | "ltr" | "neutral"; text: string };
  const runs: Run[] = [];

  for (const char of line) {
    const dir: Run["dir"] = RTL_CHAR.test(char)
      ? "rtl"
      : LTR_CHAR.test(char)
        ? "ltr"
        : "neutral";
    const last = runs[runs.length - 1];
    if (last && last.dir === dir) {
      last.text += char;
    } else {
      runs.push({ dir, text: char });
    }
  }

  // Attach neutral runs (spaces, punctuation) to the surrounding direction:
  // a neutral run between two runs of the same direction joins them;
  // otherwise it resolves to the paragraph direction (RTL here).
  const resolved: Run[] = runs.map((run, i) => {
    if (run.dir !== "neutral") return run;
    const prev = runs[i - 1];
    const next = runs[i + 1];
    if (prev && next && prev.dir === next.dir && prev.dir !== "neutral") {
      return { ...run, dir: prev.dir };
    }
    return { ...run, dir: "rtl" };
  });

  // Merge adjacent same-direction runs, reverse RTL run contents, then
  // reverse the run order (paragraph direction is RTL).
  const merged: Run[] = [];
  for (const run of resolved) {
    const last = merged[merged.length - 1];
    if (last && last.dir === run.dir) {
      last.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }

  return merged
    .map((run) =>
      run.dir === "rtl" ? [...run.text].reverse().join("") : run.text
    )
    .reverse()
    .join("");
}
