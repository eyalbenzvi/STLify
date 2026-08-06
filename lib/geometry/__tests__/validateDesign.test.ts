import { describe, expect, it } from "vitest";
import {
  createBaseLayer,
  createBlankState,
  createHoleLayer,
  createSvgLayer,
  createTextLayer,
} from "@/lib/design/defaults";
import type { DesignState } from "@/types/design";
import { computeAutoFixes, applyAutoFixes } from "../autofix";
import { validateDesignState } from "../validateDesign";

function state(...layers: Parameters<typeof validateDesignState>[0]["doc"]["layers"]): DesignState {
  const s = createBlankState();
  s.doc.layers = layers.length ? layers : [createBaseLayer()];
  return s;
}

const codes = (s: DesignState): string[] => validateDesignState(s).map((i) => i.code);

describe("V2 design validation", () => {
  it("accepts a sane default design", () => {
    const s = state(createBaseLayer(), createTextLayer({ content: "שלום" }));
    const issues = validateDesignState(s);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("requires a base layer", () => {
    const s = createBlankState();
    s.doc.layers = [];
    expect(codes(s)).toContain("doc/no-base");
  });

  it("flags engraving deeper than the base as an error", () => {
    const s = state(
      createBaseLayer({ thicknessMm: 2 }),
      createTextLayer({ content: "א", mode: "engraved", depthMm: 3 })
    );
    expect(codes(s)).toContain("relief/engrave-through");
  });

  it("warns on a thin engrave floor", () => {
    const s = state(
      createBaseLayer({ thicknessMm: 2 }),
      createTextLayer({ content: "א", mode: "engraved", depthMm: 1.8 })
    );
    const issues = validateDesignState(s);
    const issue = issues.find((i) => i.code === "relief/engrave-floor");
    expect(issue?.severity).toBe("warning");
    expect(issue?.layerId).toBeDefined();
  });

  it("warns on small text and small holes", () => {
    const s = state(
      createBaseLayer(),
      createTextLayer({ content: "א", sizeMm: 3 }),
      createHoleLayer({ diameterMm: 1 })
    );
    const c = codes(s);
    expect(c).toContain("text/small");
    expect(c).toContain("hole/small");
  });

  it("warns when a hole is too close to the edge", () => {
    const s = state(
      createBaseLayer({ widthMm: 60, heightMm: 30 }),
      createHoleLayer({
        diameterMm: 5,
        transform: { x: 26, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
      })
    );
    expect(codes(s)).toContain("hole/near-edge");
  });

  it("errors when a blind pocket goes through the base", () => {
    const s = state(
      createBaseLayer({ thicknessMm: 3 }),
      createHoleLayer({ through: false, depthMm: 3.5, fromBottom: true })
    );
    expect(codes(s)).toContain("hole/pocket-through");
  });

  it("ignores hidden layers", () => {
    const s = state(
      createBaseLayer({ thicknessMm: 2 }),
      createTextLayer({ content: "א", mode: "engraved", depthMm: 5, visible: false })
    );
    expect(codes(s)).not.toContain("relief/engrave-through");
  });

  it("warns when the model exceeds the printer build volume", () => {
    const s = state(createBaseLayer({ widthMm: 300, heightMm: 300 }));
    expect(codes(s)).toContain("printer/build-volume");
  });

  it("validates svg layer sizes", () => {
    const s = state(
      createBaseLayer(),
      createSvgLayer({ svgText: "<svg/>", targetWidthMm: 1, targetHeightMm: 1 })
    );
    expect(codes(s)).toContain("svg/size-range");
  });
});

describe("automatic parameter fixes", () => {
  it("proposes and applies fixes that clear the issues", () => {
    const s = state(
      createBaseLayer({ thicknessMm: 3 }),
      createTextLayer({ content: "א", sizeMm: 3, mode: "engraved", depthMm: 2.8 }),
      createHoleLayer({ diameterMm: 1 })
    );
    const issues = validateDesignState(s);
    const fixes = computeAutoFixes(s, issues);
    expect(fixes.length).toBeGreaterThanOrEqual(3);
    expect(fixes.every((f) => f.descriptionHe.length > 0)).toBe(true);

    const fixed = applyAutoFixes(s, fixes);
    const after = validateDesignState(fixed);
    expect(after.map((i) => i.code)).not.toContain("text/small");
    expect(after.map((i) => i.code)).not.toContain("hole/small");
    expect(after.map((i) => i.code)).not.toContain("relief/engrave-floor");
    // The original state is untouched (immutability).
    expect(validateDesignState(s).map((i) => i.code)).toContain("text/small");
  });

  it("returns no fixes for a clean design", () => {
    const s = state(createBaseLayer(), createTextLayer({ content: "שלום" }));
    expect(computeAutoFixes(s, validateDesignState(s))).toHaveLength(0);
  });
});
