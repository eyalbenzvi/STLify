// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeSvg, validateSvgFile } from "../sanitize";

const SIMPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M0 0h100v50H0z" fill="#f00"/></svg>`;

describe("SVG file validation", () => {
  it("checks extension, type and size", () => {
    expect(validateSvgFile({ name: "logo.svg", type: "image/svg+xml", size: 100 })).toBeNull();
    expect(validateSvgFile({ name: "logo.png", type: "image/png", size: 100 })).toMatch(/סיומת/);
    expect(validateSvgFile({ name: "logo.svg", type: "text/html", size: 100 })).toMatch(/סוג/);
    expect(validateSvgFile({ name: "logo.svg", type: "", size: 0 })).toMatch(/ריק/);
    expect(validateSvgFile({ name: "logo.svg", type: "", size: 99_999_999 })).toMatch(/גדול/);
  });
});

describe("SVG sanitization", () => {
  it("accepts a simple filled SVG and derives the aspect ratio", () => {
    const result = sanitizeSvg(SIMPLE);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.aspectRatio).toBeCloseTo(2, 5);
    expect(result.svgText).toContain("<path");
  });

  it("rejects malformed XML and non-SVG documents", () => {
    expect(sanitizeSvg("<svg><path").ok).toBe(false);
    expect(sanitizeSvg("<html><body>hi</body></html>").ok).toBe(false);
  });

  it("strips scripts and event handlers", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10" onclick="alert(2)" fill="#000"/></svg>`;
    const result = sanitizeSvg(dirty);
    expect(result.ok).toBe(true);
    expect(result.svgText).not.toContain("<script");
    expect(result.svgText).not.toContain("onclick");
  });

  it("removes foreignObject, embedded images and external references", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <foreignObject><body>x</body></foreignObject>
      <image href="https://evil.example/x.png"/>
      <use xlink:href="https://evil.example/defs.svg#a"/>
      <rect width="5" height="5" fill="#000"/>
    </svg>`;
    const result = sanitizeSvg(dirty);
    expect(result.ok).toBe(true);
    expect(result.svgText).not.toContain("foreignObject");
    expect(result.svgText).not.toContain("<image");
    expect(result.svgText).not.toContain("evil.example");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("keeps local references but strips javascript: urls", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="5" height="5"/></a><use href="#local"/></svg>`;
    const result = sanitizeSvg(svg);
    expect(result.ok).toBe(true);
    expect(result.svgText).not.toContain("javascript:");
    expect(result.svgText).toContain('href="#local"');
  });

  it("warns about gradients, filters, masks, text and stroke-only paths", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <linearGradient id="g"/>
      <filter id="f"/>
      <mask id="m"/>
      <text>שלום</text>
      <path d="M0 0h5" fill="none" stroke="#000"/>
    </svg>`;
    const result = sanitizeSvg(svg);
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toContain("גרדיאנט");
    expect(result.warnings.join("\n")).toContain("Filter");
    expect(result.warnings.join("\n")).toContain("mask");
    expect(result.warnings.join("\n")).toContain("טקסט");
    expect(result.warnings.join("\n")).toContain("stroke");
  });

  it("removes embedded stylesheets", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example);</style><rect width="5" height="5"/></svg>`;
    const result = sanitizeSvg(svg);
    expect(result.ok).toBe(true);
    expect(result.svgText).not.toContain("@import");
  });
});
