import { describe, expect, it } from "vitest";
import {
  dateStamp,
  designFileName,
  partFileName,
  safeFilenameStem,
  stlFileName,
} from "../filenames";

describe("filename generation", () => {
  it("keeps Hebrew and Latin letters, strips unsafe characters", () => {
    expect(safeFilenameStem("שלט כניסה")).toBe("שלט-כניסה");
    expect(safeFilenameStem("My Sign v2")).toBe("My-Sign-v2");
    expect(safeFilenameStem('a/b\\c:d*e?"<>|')).toBe("abcde");
    expect(safeFilenameStem("../../etc/passwd")).toBe("etcpasswd");
  });

  it("falls back when empty and truncates long names", () => {
    expect(safeFilenameStem("", "keychain")).toBe("keychain");
    expect(safeFilenameStem("!!!", "x")).toBe("x");
    expect(safeFilenameStem("א".repeat(100)).length).toBeLessThanOrEqual(60);
  });

  it("builds dated design filenames", () => {
    const name = designFileName("שלט", "design", new Date("2026-08-06T12:00:00"));
    expect(name).toBe("שלט_2026-08-06.formadesign.json");
    expect(dateStamp(new Date("2026-01-05T00:00:00"))).toBe("2026-01-05");
  });

  it("builds stl and part filenames", () => {
    expect(stlFileName("My Sign", "design")).toBe("My-Sign.stl");
    expect(partFileName(0, "צבע 1 (בסיס)", "בסיס")).toMatch(/^01_.+\.stl$/);
    expect(partFileName(3, "", "")).toBe("04_color-4_part.stl");
  });
});
