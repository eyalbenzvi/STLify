import { describe, expect, it } from "vitest";
import {
  createBaseLayer,
  createBlankState,
  createImageReliefLayer,
  createTextLayer,
} from "@/lib/design/defaults";
import { PortableImportError } from "../portable";
import {
  decodeShareHash,
  encodeShareHash,
  SHARE_HASH_PREFIX,
  shareLinkEligibility,
} from "../shareLink";

describe("compact share links", () => {
  it("encodes and decodes a small text design", () => {
    const state = createBlankState();
    state.doc.layers = [
      createBaseLayer({ id: "b1" }),
      createTextLayer({ id: "t1", content: "מזל טוב" }),
    ];
    state.doc.title = "שלט";

    const hash = encodeShareHash(state, 40);
    expect(hash).not.toBeNull();
    expect(hash!.startsWith(SHARE_HASH_PREFIX)).toBe(true);

    const decoded = decodeShareHash(hash!);
    expect(decoded).not.toBeNull();
    expect(decoded!.doc.title).toBe("שלט");
    const text = decoded!.doc.layers[1];
    expect(text.type === "text" && text.content).toBe("מזל טוב");
  });

  it("refuses designs with raster images", () => {
    const state = createBlankState();
    state.doc.layers = [
      createBaseLayer(),
      createImageReliefLayer({ assetId: "a1" }),
    ];
    expect(shareLinkEligibility(state).ok).toBe(false);
    expect(encodeShareHash(state, 40)).toBeNull();
  });

  it("refuses when the URL would be too long", () => {
    const state = createBlankState();
    state.doc.layers = [createBaseLayer(), createTextLayer({ content: "אבג" })];
    expect(encodeShareHash(state, 7999)).toBeNull();
  });

  it("returns null for non-share hashes", () => {
    expect(decodeShareHash("")).toBeNull();
    expect(decodeShareHash("#other")).toBeNull();
  });

  it("throws a Hebrew error for corrupt data", () => {
    expect(() => decodeShareHash("#d=corrupt-data-123")).toThrow(PortableImportError);
  });
});
