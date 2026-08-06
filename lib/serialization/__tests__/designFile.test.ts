/**
 * Portable design file tests: round-trip fidelity, validation, and
 * hostile-input safety.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { identityTransform } from "@/types/design";
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
