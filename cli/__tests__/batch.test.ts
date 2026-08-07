/**
 * Headless batch CLI (V6 item 14).
 *
 * The DoD: a 5-row CSV produces 5 watertight parts in the archive with the
 * CORRECT dimensions per row. The test builds a parametric design (a box
 * whose width is bound to a parameter, riding a base plate with a text
 * layer), runs the batch core, then walks the resulting ZIP's STORE
 * entries and MEASURES each binary STL's bounding box — the verification
 * is on the produced files, not on the code that produced them.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { installNodeFontFetch } from "@/lib/geometry/nodeFontFetch";
import type { DesignDocument, PrimitiveLayer, TextLayer } from "@/types/design";
import { createTemplateDocument } from "@/lib/geometry/documentTemplates";
import { defaultPrimitive, identityTransform } from "@/types/design";
import { serializeDesignFile } from "@/lib/serialization/designFile";
import { applyRow, parseCsv, runBatch } from "../batchCore";

beforeAll(installNodeFontFetch);

/** Walk a STORE-only ZIP into name → bytes. */
function readStoreZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  const decoder = new TextDecoder();
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const dataStart = offset + 30 + nameLength + extraLength;
    files.set(name, bytes.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return files;
}

/** Bounding box of a binary STL (measures the FILE, not our data model). */
function stlBounds(bytes: Uint8Array): { min: number[]; max: number[]; triangles: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < triangles; t++) {
    const base = 84 + t * 50 + 12; // skip the normal
    for (let v = 0; v < 3; v++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = view.getFloat32(base + v * 12 + axis * 4, true);
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  }
  return { min, max, triangles };
}

/** A parametric single-part design: a box whose width follows "רוחב". */
function parametricDesign(): string {
  const doc: DesignDocument = createTemplateDocument("blank");
  doc.baseMode = "baseless";
  const box: PrimitiveLayer = {
    id: "layer_box",
    type: "primitive",
    name: "גוף",
    visible: true,
    locked: false,
    materialSlotId: doc.materialSlots[0]?.id ?? "slot1",
    transform: identityTransform(),
    previewOpacity: 1,
    ...defaultPrimitive("box"),
    depthMm: 12,
    heightMm: 6,
    bindings: { widthMm: "רוחב" },
  };
  doc.layers = [box];
  doc.parameters = [{ name: "רוחב", value: 20, expression: "", noteHe: "" }];
  return serializeDesignFile(doc);
}

describe("batch CLI core", () => {
  it("a 5-row CSV yields 5 watertight parts with the correct per-row dimensions", async () => {
    const csv = [
      "name,רוחב",
      "a,10",
      "b,20",
      "c,35",
      "d,42.5",
      "e,60",
    ].join("\n");

    const result = await runBatch(parametricDesign(), csv);
    expect(result.ok).toBe(true);
    expect(result.rows.length).toBe(5);
    for (const row of result.rows) {
      expect(row.ok).toBe(true);
      expect(row.parts.every((p) => p.watertight)).toBe(true);
    }

    const files = readStoreZip(result.zip);
    expect(files.has("README.md")).toBe(true);
    const widths: Record<string, number> = { a: 10, b: 20, c: 35, "d": 42.5, e: 60 };
    for (const [label, width] of Object.entries(widths)) {
      const entry = files.get(`${label}.stl`);
      expect(entry, `${label}.stl in archive`).toBeDefined();
      const bounds = stlBounds(entry!);
      expect(bounds.triangles).toBeGreaterThanOrEqual(12);
      // MEASURED from the STL bytes: width follows the CSV, depth/height fixed.
      expect(bounds.max[0] - bounds.min[0]).toBeCloseTo(width, 3);
      expect(bounds.max[1] - bounds.min[1]).toBeCloseTo(12, 3);
      expect(bounds.max[2] - bounds.min[2]).toBeCloseTo(6, 3);
    }
  }, 120_000);

  it("drives a name plate's TEXT per row (the print-shop case)", async () => {
    const doc = createTemplateDocument("namePlate");
    const text = doc.layers.find((l): l is TextLayer => l.type === "text");
    expect(text).toBeDefined();
    const design = serializeDesignFile(doc);

    const csv = ["name,text:טקסט", "dana,דנה", "omer,עומר"].join("\n");
    const result = await runBatch(design, csv);
    expect(result.ok).toBe(true);
    expect(result.rows.length).toBe(2);

    const files = readStoreZip(result.zip);
    const dana = files.get("dana.stl");
    const omer = files.get("omer.stl");
    expect(dana).toBeDefined();
    expect(omer).toBeDefined();
    // Different names → different glyph geometry in the produced files.
    expect(stlBounds(dana!).triangles).not.toBe(stlBounds(omer!).triangles);
  }, 120_000);

  it("reports honest per-row failures without aborting the batch", async () => {
    const csv = ["name,רוחב", "good,15", "bad,not-a-number", "also-good,25"].join("\n");
    const result = await runBatch(parametricDesign(), csv);
    expect(result.ok).toBe(false);
    expect(result.rows.map((r) => r.ok)).toEqual([true, false, true]);
    expect(result.rows[1].errorsHe.join(" ")).toContain("אינו מספר");
    const files = readStoreZip(result.zip);
    expect(files.has("good.stl")).toBe(true);
    expect(files.has("also-good.stl")).toBe(true);
    expect(files.has("bad.stl")).toBe(false);
  }, 120_000);

  it("CSV parsing handles quotes, CRLF and a BOM", () => {
    const rows = parseCsv('﻿name,"text:טקסט"\r\n"שם, עם פסיק","ער""ך"\r\n');
    expect(rows).toEqual([
      ["name", "text:טקסט"],
      ["שם, עם פסיק", 'ער"ך'],
    ]);
  });

  it("applyRow rejects unknown columns with a Hebrew message", () => {
    const doc = createTemplateDocument("blank");
    const { errorsHe } = applyRow(doc, ["לא-קיים"], ["5"]);
    expect(errorsHe.join(" ")).toContain("אין פרמטר בשם");
  });
});
