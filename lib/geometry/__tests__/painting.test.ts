/**
 * Per-face material painting.
 *
 * The assertions here are about the PRINT, not about the bookkeeping: a
 * painted region has to come out as its own watertight body of the right
 * volume, and the pieces have to add back up to the original part. A
 * multi-material export that loses or duplicates material is worse than no
 * export at all, so both are checked explicitly.
 */

import { describe, expect, it } from "vitest";
import {
  activePaints,
  buildPaintShellMesh,
  hasStalePaint,
  paintedTriangleSlots,
  paintTriangles,
  splitPartsByPaint,
  splitSolidByPaint,
  unpaintTriangles,
} from "../painting";
import { getGeometryKernel } from "../kernel";
import { buildDocument } from "../buildDocument";
import { meshDataTriangleCount } from "../meshData";
import {
  defaultPrimitive,
  identityTransform,
  type DesignDocument,
  type DesignLayer,
  type FacePaint,
} from "@/types/design";

function paint(
  materialSlotId: string,
  triangles: number[],
  meshTriangleCount = 12,
  depthMm = 0.8
): FacePaint {
  return { materialSlotId, triangles, meshTriangleCount, depthMm };
}

describe("paint bookkeeping", () => {
  it("gives a triangle to exactly one slot", () => {
    const first = paintTriangles(undefined, "red", [0, 1, 2], 12);
    const second = paintTriangles(first, "blue", [2, 3], 12);
    const owners = paintedTriangleSlots(second);
    expect(owners.get(2)).toBe("blue");
    expect(owners.get(1)).toBe("red");
    // Triangle 2 must not still be listed under red — the export would try to
    // carve the same material out twice.
    const red = second.find((p) => p.materialSlotId === "red");
    expect(red?.triangles).toEqual([0, 1]);
  });

  it("merges repeated painting of the same slot", () => {
    const once = paintTriangles(undefined, "red", [0, 1], 12);
    const twice = paintTriangles(once, "red", [1, 5], 12);
    expect(twice).toHaveLength(1);
    expect(twice[0].triangles).toEqual([0, 1, 5]);
  });

  it("drops a slot that loses all of its triangles", () => {
    const painted = paintTriangles(undefined, "red", [3], 12);
    expect(unpaintTriangles(painted, [3], 12)).toHaveLength(0);
  });

  it("ignores indices outside the mesh", () => {
    expect(paintTriangles(undefined, "red", [-1, 99, 4], 12)).toEqual([
      paint("red", [4]),
    ]);
  });

  it("discards paint recorded against a different body", () => {
    const stored = [paint("red", [0, 1], 12)];
    expect(activePaints(stored, 12)).toHaveLength(1);
    // The body was rebuilt into a different shape: those indices now point at
    // unrelated faces, so the paint has to go rather than scatter.
    expect(activePaints(stored, 240)).toHaveLength(0);
    expect(hasStalePaint(stored, 240)).toBe(true);
    expect(hasStalePaint(stored, 12)).toBe(false);
  });
});

describe("painted region → solid", () => {
  it("builds a closed prism of the painted area × depth", async () => {
    const kernel = await getGeometryKernel();
    const cube = kernel.box(20, 20, 20, false);
    const mesh = cube.toMeshData();

    // Every triangle whose vertices all sit on the top face.
    const top: number[] = [];
    for (let t = 0; t < meshDataTriangleCount(mesh); t++) {
      let onTop = true;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(mesh.positions[mesh.indices[t * 3 + k] * 3 + 2] - 20) > 1e-6) {
          onTop = false;
          break;
        }
      }
      if (onTop) top.push(t);
    }
    expect(top.length).toBeGreaterThan(0);

    const shell = buildPaintShellMesh(mesh, new Set(top), 0.8);
    expect(shell).not.toBeNull();
    const { solid, status } = kernel.fromMeshData(shell!);
    expect(status).toBe("NoError");
    // 20 × 20 face pushed 0.8mm in.
    expect(solid.volumeMm3()).toBeCloseTo(20 * 20 * 0.8, 1);
    solid.dispose();
    cube.dispose();
  });

  it("splits a cube into a painted skin and a remainder that add back up", async () => {
    const kernel = await getGeometryKernel();
    const cube = kernel.box(20, 20, 20, false);
    const mesh = cube.toMeshData();
    const totalVolume = cube.volumeMm3();

    const top: number[] = [];
    for (let t = 0; t < meshDataTriangleCount(mesh); t++) {
      let onTop = true;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(mesh.positions[mesh.indices[t * 3 + k] * 3 + 2] - 20) > 1e-6) {
          onTop = false;
          break;
        }
      }
      if (onTop) top.push(t);
    }

    const warningsHe: string[] = [];
    const pieces = splitSolidByPaint(
      kernel,
      cube,
      mesh,
      [paint("red", top, meshDataTriangleCount(mesh), 0.8)],
      warningsHe
    );
    expect(warningsHe).toEqual([]);
    expect(pieces).toHaveLength(2);

    const painted = pieces.find((p) => p.materialSlotId === "red");
    const body = pieces.find((p) => p.materialSlotId === null);
    expect(painted).toBeDefined();
    expect(body).toBeDefined();

    // Each half is printable on its own...
    expect(painted!.solid.status()).toBe("NoError");
    expect(body!.solid.status()).toBe("NoError");
    // ...the painted skin is the face × depth...
    expect(painted!.solid.volumeMm3()).toBeCloseTo(20 * 20 * 0.8, 1);
    // ...and nothing was lost or double-counted.
    expect(painted!.solid.volumeMm3() + body!.solid.volumeMm3()).toBeCloseTo(
      totalVolume,
      1
    );
    for (const piece of pieces) piece.solid.dispose();
  });

  it("leaves the body whole when nothing is painted", async () => {
    const kernel = await getGeometryKernel();
    const cube = kernel.box(10, 10, 10, false);
    const mesh = cube.toMeshData();
    const pieces = splitSolidByPaint(kernel, cube, mesh, []);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].materialSlotId).toBeNull();
    expect(pieces[0].solid.volumeMm3()).toBeCloseTo(1000, 3);
    pieces[0].solid.dispose();
  });
});

describe("export split", () => {
  function baseDoc(layers: DesignLayer[]): DesignDocument {
    return {
      schemaVersion: 3,
      baseMode: "baseless",
      layers,
      materialSlots: [
        { id: "slot1", nameHe: "גוף", colorHex: "#2f6feb" },
        { id: "slot2", nameHe: "כיתוב", colorHex: "#e0483e" },
      ],
      printerProfileId: "genericFdm220",
      printabilityProfileId: "fdmPla",
      customPrintability: null,
      usageProfileId: null,
      templateId: null,
    } as DesignDocument;
  }

  function boxLayer(facePaint?: FacePaint[]): DesignLayer {
    return {
      id: "box",
      type: "primitive",
      name: "תיבה",
      visible: true,
      locked: false,
      materialSlotId: "slot1",
      transform: identityTransform(),
      previewOpacity: 1,
      facePaint,
      ...defaultPrimitive("box"),
      widthMm: 20,
      depthMm: 20,
      heightMm: 20,
    } as DesignLayer;
  }

  it("passes unpainted parts through untouched", async () => {
    const doc = baseDoc([boxLayer()]);
    const build = await buildDocument(doc);
    const split = await splitPartsByPaint(doc, build.parts);
    expect(split.parts).toEqual(build.parts);
    expect(split.warningsHe).toEqual([]);
  });

  it("separates a painted face into its own part with its own material", async () => {
    const plain = await buildDocument(baseDoc([boxLayer()]));
    const mesh = plain.parts[0].localMesh;
    const triangleCount = meshDataTriangleCount(mesh);

    const top: number[] = [];
    for (let t = 0; t < triangleCount; t++) {
      let onTop = true;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(mesh.positions[mesh.indices[t * 3 + k] * 3 + 2] - 20) > 1e-6) {
          onTop = false;
          break;
        }
      }
      if (onTop) top.push(t);
    }
    expect(top.length).toBeGreaterThan(0);

    const doc = baseDoc([
      boxLayer([
        { materialSlotId: "slot2", triangles: top, meshTriangleCount: triangleCount, depthMm: 1 },
      ]),
    ]);
    const build = await buildDocument(doc);
    const split = await splitPartsByPaint(doc, build.parts);

    expect(split.warningsHe).toEqual([]);
    expect(split.parts).toHaveLength(2);

    const painted = split.parts.find((p) => p.materialSlotId === "slot2");
    const body = split.parts.find((p) => p.materialSlotId === "slot1");
    expect(painted).toBeDefined();
    expect(body).toBeDefined();
    expect(painted!.stats.volumeMm3).toBeCloseTo(20 * 20 * 1, 1);
    expect(painted!.stats.volumeMm3 + body!.stats.volumeMm3).toBeCloseTo(
      build.parts[0].stats.volumeMm3,
      1
    );
    // The painted part must carry the slot's name so the export README and
    // the ZIP file names say which filament it wants.
    expect(painted!.nameHe).toContain("כיתוב");
    // Distinct ids, or the ZIP writer would collide them into one file.
    expect(new Set(split.parts.map((p) => p.id)).size).toBe(2);
  });

  it("ignores paint left over from a differently-shaped body", async () => {
    const doc = baseDoc([
      boxLayer([
        { materialSlotId: "slot2", triangles: [0, 1], meshTriangleCount: 9999, depthMm: 1 },
      ]),
    ]);
    const build = await buildDocument(doc);
    const split = await splitPartsByPaint(doc, build.parts);
    expect(split.parts).toHaveLength(1);
  });
});
