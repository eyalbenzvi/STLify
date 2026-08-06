import { describe, expect, it } from "vitest";
import { containsRtl, toVisualOrder } from "../bidi";

describe("containsRtl", () => {
  it("detects Hebrew", () => {
    expect(containsRtl("שלום")).toBe(true);
    expect(containsRtl("hello")).toBe(false);
    expect(containsRtl("123")).toBe(false);
  });
});

describe("toVisualOrder", () => {
  it("leaves pure LTR text unchanged", () => {
    expect(toVisualOrder("Hello 123")).toBe("Hello 123");
  });

  it("reverses pure Hebrew text", () => {
    expect(toVisualOrder("שלום")).toBe("םולש");
  });

  it("keeps spaces between Hebrew words in place", () => {
    // "שלום עולם" visually: reversed word order and reversed letters.
    expect(toVisualOrder("שלום עולם")).toBe("םלוע םולש");
  });

  it("preserves embedded LTR runs", () => {
    // Hebrew text with an embedded Latin word: the Latin word keeps its
    // internal order while the whole line is laid out right-to-left.
    const result = toVisualOrder("שלום ABC");
    expect(result).toBe("ABC םולש");
  });

  it("preserves digits inside Hebrew text", () => {
    const result = toVisualOrder("גרסה 12");
    expect(result).toBe("12 הסרג");
  });
});
