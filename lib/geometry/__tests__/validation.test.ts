import { describe, expect, it } from "vitest";
import type { DesignParams } from "../types";
import {
  clampNumber,
  hasVisibleText,
  maxCornerRadius,
  parseNumericInput,
  validateDesignParams,
} from "../validation";

function makeParams(overrides: Partial<DesignParams> = {}): DesignParams {
  return {
    template: "namePlate",
    base: {
      shape: "roundedRectangle",
      widthMm: 120,
      heightMm: 40,
      thicknessMm: 3,
      cornerRadiusMm: 5,
    },
    text: {
      content: "שלום",
      fontId: "alef",
      sizeMm: 20,
      bold: false,
      align: "center",
      mode: "raised",
      depthMm: 1.5,
      offsetXMm: 0,
      offsetYMm: 0,
      lineSpacing: 1,
    },
    hole: { enabled: false, diameterMm: 4, edgeMarginMm: 5, position: "right" },
    materialColor: "#2f6feb",
    ...overrides,
  };
}

describe("clampNumber", () => {
  it("clamps into the range", () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
    expect(clampNumber(-3, 0, 10)).toBe(0);
    expect(clampNumber(42, 0, 10)).toBe(10);
  });

  it("returns the fallback for non-finite input", () => {
    expect(clampNumber(NaN, 0, 10, 7)).toBe(7);
    expect(clampNumber(Infinity, 0, 10, 7)).toBe(7);
  });
});

describe("parseNumericInput", () => {
  it("parses plain and decimal numbers", () => {
    expect(parseNumericInput("12")).toBe(12);
    expect(parseNumericInput(" 3.5 ")).toBe(3.5);
    expect(parseNumericInput("-2")).toBe(-2);
  });

  it("accepts comma as a decimal separator", () => {
    expect(parseNumericInput("3,5")).toBe(3.5);
  });

  it("rejects invalid input", () => {
    expect(parseNumericInput("")).toBeNull();
    expect(parseNumericInput("abc")).toBeNull();
    expect(parseNumericInput("1.2.3")).toBeNull();
  });
});

describe("maxCornerRadius", () => {
  it("is half the smaller side (minus epsilon)", () => {
    expect(maxCornerRadius(100, 40)).toBeCloseTo(19.99, 2);
  });

  it("never goes negative", () => {
    expect(maxCornerRadius(0, 0)).toBe(0);
  });
});

describe("hasVisibleText", () => {
  it("detects visible text", () => {
    expect(hasVisibleText("א")).toBe(true);
    expect(hasVisibleText("  \n ")).toBe(false);
    expect(hasVisibleText("")).toBe(false);
  });
});

describe("validateDesignParams", () => {
  it("accepts a sane design", () => {
    const result = validateDesignParams(makeParams());
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("rejects out-of-range base dimensions", () => {
    const params = makeParams();
    params.base.widthMm = 5;
    const result = validateDesignParams(params);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "base/width-range")).toBe(true);
  });

  it("rejects a corner radius larger than the plate allows", () => {
    const params = makeParams();
    params.base.cornerRadiusMm = 30; // > min(120, 40) / 2
    const result = validateDesignParams(params);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "base/corner-too-large")).toBe(
      true
    );
  });

  it("rejects engraving deeper than the base thickness", () => {
    const params = makeParams();
    params.text.mode = "engraved";
    params.text.depthMm = 4; // base is 3mm thick
    const result = validateDesignParams(params);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "text/engrave-through")).toBe(
      true
    );
  });

  it("warns about a thin engraving floor", () => {
    const params = makeParams();
    params.text.mode = "engraved";
    params.text.depthMm = 2.7; // leaves 0.3mm < 0.6mm floor
    const result = validateDesignParams(params);
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.code === "text/engrave-floor")).toBe(
      true
    );
  });

  it("warns about shallow relief depth", () => {
    const params = makeParams();
    params.text.depthMm = 0.3; // below the 0.4mm minimum relief
    const result = validateDesignParams(params);
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.code === "text/shallow-relief")).toBe(
      true
    );
  });

  it("warns (not errors) on empty text", () => {
    const params = makeParams();
    params.text.content = "   ";
    const result = validateDesignParams(params);
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.code === "text/empty")).toBe(true);
  });

  it("rejects a hole that falls outside the base", () => {
    const params = makeParams();
    params.hole = {
      enabled: true,
      diameterMm: 10,
      edgeMarginMm: 2, // wall = 2 - 5 < 0
      position: "right",
    };
    const result = validateDesignParams(params);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "hole/outside")).toBe(true);
  });

  it("warns about a thin wall around the hole", () => {
    const params = makeParams();
    params.hole = {
      enabled: true,
      diameterMm: 8,
      edgeMarginMm: 4.5, // wall = 0.5mm < 0.8mm
      position: "right",
    };
    const result = validateDesignParams(params);
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.code === "hole/thin-wall")).toBe(true);
  });

  it("rejects non-finite values", () => {
    const params = makeParams();
    params.base.thicknessMm = NaN;
    const result = validateDesignParams(params);
    expect(result.ok).toBe(false);
  });
});
