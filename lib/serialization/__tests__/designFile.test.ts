/**
 * Portable design file tests: round-trip fidelity, validation, and
 * hostile-input safety.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { identityTransform } from "@/types/design";
import { getPrinterProfile } from "@/types/profiles";
import {
  createTemplateDocument,
  emptyDocument,
  makeTextLayer,
} from "@/lib/geometry/documentTemplates";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import { clearMeshStore, getMesh, storeMesh } from "@/lib/geometry/meshStore";
import { DesignFileError, importDesignFile, serializeDesignFile } from "../designFile";

beforeEach(() => clearMeshStore());

describe("design file round-trip", () => {
  it("preserves a classic template document", () => {
    const doc = createTemplateDocument("keychain");
    const json = serializeDesignFile(doc);
    const { document, warningsHe } = importDesignFile(json);
    expect(warningsHe.length).toBe(0);
    expect(document.baseMode).toBe("withBase");
    expect(document.layers.length).toBe(doc.layers.length);
    const text = document.layers.find((l) => l.type === "text");
    expect(text).toBeDefined();
    if (text && text.type === "text") {
      expect(text.content).toBe("אייל");
      expect(text.transform.x).toBeCloseTo(-3);
    }
  });

  it("preserves full 3D transforms and baseless mode", () => {
    const doc = emptyDocument();
    doc.layers = [
      makeTextLayer({
        content: "בדיקה",
        combine: "standalone",
        transform: {
          x: 5,
          y: -3,
          z: 12,
          rotationX: 45,
          rotationY: -30,
          rotationZ: 90,
          scaleX: 2,
          scaleY: 1,
          scaleZ: 0.5,
        },
      }),
    ];
    const { document } = importDesignFile(serializeDesignFile(doc));
    expect(document.baseMode).toBe("baseless");
    const t = document.layers[0].transform;
    expect(t.rotationX).toBe(45);
    expect(t.rotationY).toBe(-30);
    expect(t.scaleZ).toBe(0.5);
  });

  it("round-trips imported meshes byte-exactly", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(10, 20, 30, true);
    const mesh = box.toMeshData();
    box.dispose();
    const meshId = storeMesh(mesh);
    const doc = emptyDocument();
    doc.layers = [
      {
        id: "l1",
        type: "importedMesh",
        name: "מיובא",
        visible: true,
        locked: false,
        materialSlotId: "slot1",
        transform: identityTransform(),
        previewOpacity: 1,
        meshId,
        provenance: { kind: "stlImport", fileName: "box.stl" },
        originalMeshId: null,
        combine: "standalone",
      },
    ];
    const { document } = importDesignFile(serializeDesignFile(doc));
    const imported = document.layers[0];
    expect(imported.type).toBe("importedMesh");
    if (imported.type === "importedMesh") {
      const restored = getMesh(imported.meshId);
      expect(restored).not.toBeNull();
      expect(restored!.positions).toEqual(mesh.positions);
      expect(restored!.indices).toEqual(mesh.indices);
    }
  });
});

describe("design file validation", () => {
  it("rejects non-JSON", () => {
    expect(() => importDesignFile("not json {{")).toThrow(DesignFileError);
  });

  it("rejects foreign formats", () => {
    expect(() => importDesignFile(JSON.stringify({ format: "other" }))).toThrow(
      DesignFileError
    );
  });

  it("rejects newer schema versions with a clear message", () => {
    expect(() =>
      importDesignFile(
        JSON.stringify({ format: "formadesign", schemaVersion: 99, document: {}, meshes: [] })
      )
    ).toThrow(/גרסה חדשה/);
  });

  it("skips unknown layer types with a warning instead of failing", () => {
    const json = JSON.stringify({
      format: "formadesign",
      schemaVersion: 3,
      document: {
        baseMode: "baseless",
        layers: [{ type: "evilLayer", code: "alert(1)" }],
        materialSlots: [],
      },
      meshes: [],
    });
    const { document, warningsHe } = importDesignFile(json);
    expect(document.layers.length).toBe(0);
    expect(warningsHe.length).toBeGreaterThan(0);
  });

  it("sanitizes non-finite numbers instead of importing NaN", () => {
    const json = JSON.stringify({
      format: "formadesign",
      schemaVersion: 3,
      document: {
        baseMode: "withBase",
        layers: [
          {
            type: "text",
            name: "t",
            content: "א",
            transform: { x: "Infinity", scaleX: null },
            sizeMm: 20,
            extrudeMm: 2,
          },
        ],
        materialSlots: [],
      },
      meshes: [],
    });
    const { document } = importDesignFile(json);
    const t = document.layers[0].transform;
    expect(t.x).toBe(0);
    expect(t.scaleX).toBe(1);
  });

  it("drops mesh layers whose mesh payload is missing", () => {
    const json = JSON.stringify({
      format: "formadesign",
      schemaVersion: 3,
      document: {
        baseMode: "baseless",
        layers: [
          {
            type: "importedMesh",
            name: "רשת",
            meshId: "missing",
            combine: "standalone",
          },
        ],
        materialSlots: [],
      },
      meshes: [],
    });
    const { document, warningsHe } = importDesignFile(json);
    expect(document.layers.length).toBe(0);
    expect(warningsHe.some((w) => w.includes("רשת"))).toBe(true);
  });
});

describe("wave C fields survive a round-trip", () => {
  it("keeps calibration, custom printers and face paint", () => {
    const doc = emptyDocument();
    doc.layers = [makeTextLayer({ content: "צבע", combine: "standalone" })];
    doc.layers[0].facePaint = [
      { materialSlotId: "slot2", triangles: [4, 2, 2, 0], meshTriangleCount: 12, depthMm: 1.2 },
    ];
    doc.calibration = {
      measuredClearanceMm: 0.35,
      holeCompensationMm: 0.2,
      elephantFootCompensationMm: 0.15,
      elephantFootHeightMm: 0.8,
    };
    doc.customPrinters = [
      {
        id: "custom_1",
        nameHe: "המדפסת שלי",
        technology: "fdm",
        buildVolumeMm: { x: 256, y: 256, z: 256 },
        nozzleDiameterMm: 0.6,
        defaultLayerHeightMm: 0.28,
      },
    ];

    const { document } = importDesignFile(serializeDesignFile(doc));
    expect(document.calibration?.measuredClearanceMm).toBeCloseTo(0.35, 6);
    expect(document.calibration?.elephantFootCompensationMm).toBeCloseTo(0.15, 6);
    expect(document.customPrinters?.[0].buildVolumeMm.x).toBe(256);
    expect(document.customPrinters?.[0].nozzleDiameterMm).toBeCloseTo(0.6, 6);
    const paint = document.layers[0].facePaint;
    expect(paint).toHaveLength(1);
    // Duplicates collapse and the list comes back sorted, so the export split
    // never carves the same triangle twice.
    expect(paint?.[0].triangles).toEqual([0, 2, 4]);
    expect(paint?.[0].depthMm).toBeCloseTo(1.2, 6);
  });

  it("rejects paint indices that cannot belong to the recorded body", () => {
    const doc = emptyDocument();
    doc.layers = [makeTextLayer({ content: "צבע", combine: "standalone" })];
    doc.layers[0].facePaint = [
      { materialSlotId: "slot2", triangles: [0, 99, -3], meshTriangleCount: 12, depthMm: 0.8 },
    ];
    const { document } = importDesignFile(serializeDesignFile(doc));
    expect(document.layers[0].facePaint?.[0].triangles).toEqual([0]);
  });

  it("drops paint with no body fingerprint rather than guessing one", () => {
    const json = JSON.stringify({
      format: "formadesign",
      schemaVersion: 3,
      document: {
        baseMode: "baseless",
        layers: [
          {
            type: "text",
            name: "טקסט",
            content: "א",
            combine: "standalone",
            facePaint: [{ materialSlotId: "slot2", triangles: [0, 1, 2] }],
          },
        ],
        materialSlots: [],
      },
      meshes: [],
    });
    const { document } = importDesignFile(json);
    expect(document.layers[0].facePaint).toBeUndefined();
  });
});

describe("hostile input to the wave C fields", () => {
  function fileWith(document: Record<string, unknown>): string {
    return JSON.stringify({
      format: "formadesign",
      schemaVersion: 3,
      document: { baseMode: "baseless", layers: [], materialSlots: [], ...document },
      meshes: [],
    });
  }

  it("does not switch calibration on from an empty object", () => {
    // Materialising the defaults here silently enlarges every hole cutter in
    // the document. "Not calibrated" has to survive the round trip.
    const { document } = importDesignFile(fileWith({ calibration: {} }));
    expect(document.calibration).toBeUndefined();
  });

  it("keeps a calibration that names at least one real value", () => {
    const { document } = importDesignFile(
      fileWith({ calibration: { measuredClearanceMm: 0.35 } })
    );
    expect(document.calibration?.measuredClearanceMm).toBeCloseTo(0.35, 6);
  });

  it("refuses to let a custom printer impersonate a built-in one", () => {
    // Custom printers are looked up first, so this would redefine the stock
    // profile — here shrinking its build volume to nothing.
    const { document } = importDesignFile(
      fileWith({
        customPrinters: [
          { id: "genericFdm220", nameHe: "זדוני", buildVolumeMm: { x: 1, y: 1, z: 1 } },
        ],
      })
    );
    expect(document.customPrinters?.[0].id).not.toBe("genericFdm220");
    expect(getPrinterProfile("genericFdm220", document.customPrinters).buildVolumeMm.x)
      .toBeGreaterThan(100);
  });

  it("keeps a resin printer nozzle-less across a round trip", () => {
    // Clamping null to 0.4 made the new lattice check warn about extrusion
    // width on a machine that does not extrude.
    const { document } = importDesignFile(
      fileWith({
        customPrinters: [
          {
            id: "myResin",
            nameHe: "שרף",
            technology: "sla",
            buildVolumeMm: { x: 143, y: 90, z: 175 },
            nozzleDiameterMm: null,
          },
        ],
      })
    );
    expect(document.customPrinters?.[0].technology).toBe("sla");
    expect(document.customPrinters?.[0].nozzleDiameterMm).toBeNull();
  });

  it("merges paint entries that claim the same material slot", () => {
    const { document } = importDesignFile(
      fileWith({
        layers: [
          {
            type: "text",
            name: "טקסט",
            content: "א",
            combine: "standalone",
            facePaint: [
              { materialSlotId: "slot2", triangles: [0, 1], meshTriangleCount: 12, depthMm: 0.8 },
              { materialSlotId: "slot2", triangles: [1, 5], meshTriangleCount: 12, depthMm: 1.4 },
            ],
          },
        ],
      })
    );
    const paint = document.layers[0].facePaint;
    expect(paint).toHaveLength(1);
    expect(paint?.[0].triangles).toEqual([0, 1, 5]);
  });

  it("rejects a file that tries to allocate a huge paint region", () => {
    const triangles = Array.from({ length: 300_000 }, (_, i) => i);
    expect(() =>
      importDesignFile(
        fileWith({
          layers: [
            {
              type: "text",
              name: "טקסט",
              content: "א",
              combine: "standalone",
              facePaint: Array.from({ length: 16 }, (_, k) => ({
                materialSlotId: `slot${k}`,
                triangles,
                meshTriangleCount: 300_000,
                depthMm: 1,
              })),
            },
          ],
        })
      )
    ).toThrow(DesignFileError);
  });

  it("drops paint whose fingerprint is absurd", () => {
    const { document } = importDesignFile(
      fileWith({
        layers: [
          {
            type: "text",
            name: "טקסט",
            content: "א",
            combine: "standalone",
            facePaint: [
              { materialSlotId: "slot2", triangles: [0], meshTriangleCount: 1e12, depthMm: 1 },
            ],
          },
        ],
      })
    );
    expect(document.layers[0].facePaint).toBeUndefined();
  });
});
