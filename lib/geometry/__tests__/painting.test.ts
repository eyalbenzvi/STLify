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
  type MaterialSlot,
} from "@/types/design";
import { testBoxLayer, testDocumentWith } from "@/lib/testing/fixtures";

/** Two slots: painting with the body's own colour would be a no-op. */
const PAINT_SLOTS: MaterialSlot[] = [
  { id: "slot1", nameHe: "גוף", colorHex: "#2f6feb" },
  { id: "slot2", nameHe: "כיתוב", colorHex: "#e0483e" },
];

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
  const baseDoc = (layers: DesignLayer[]): DesignDocument =>
    testDocumentWith(layers, { materialSlots: PAINT_SLOTS });

  const boxLayer = (facePaint?: FacePaint[]): DesignLayer =>
    testBoxLayer({ facePaint });

  it("leaves an unpainted part alone while splitting a painted one", async () => {
    // `toEqual(build.parts)` on an all-unpainted document compared the array
    // to itself: splitPartsByPaint early-returns a copy, so that assertion
    // could not fail. Mixing a painted and an unpainted body is the case that
    // actually exercises the loop.
    const plain = await buildDocument(baseDoc([boxLayer()]));
    const mesh = plain.parts[0].localMesh;
    const count = meshDataTriangleCount(mesh);
    const top: number[] = [];
    for (let t = 0; t < count; t++) {
      let onTop = true;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(mesh.positions[mesh.indices[t * 3 + k] * 3 + 2] - 20) > 1e-6) {
          onTop = false;
          break;
        }
      }
      if (onTop) top.push(t);
    }

    const other = {
      ...(boxLayer() as unknown as Record<string, unknown>),
      id: "other",
      name: "שנייה",
      transform: { ...identityTransform(), x: 60 },
    } as unknown as DesignLayer;
    const doc = baseDoc([
      boxLayer([
        { materialSlotId: "slot2", triangles: top, meshTriangleCount: count, depthMm: 1 },
      ]),
      other,
    ]);
    const build = await buildDocument(doc);
    const split = await splitPartsByPaint(doc, build.parts);

    // Painted body -> two parts; unpainted body -> the very same object.
    expect(split.parts).toHaveLength(3);
    const untouched = split.parts.find((p) => p.primaryLayerId === "other");
    expect(untouched).toBe(build.parts.find((p) => p.primaryLayerId === "other"));
    expect(split.parts.filter((p) => p.primaryLayerId === "box")).toHaveLength(2);
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

/**
 * Regressions from the external code review.
 *
 * Each of these shipped in the first version of the feature and was found by
 * an auditor rather than by the tests above — so each one is pinned here with
 * the measurement that exposes it.
 */
describe("paint regressions", () => {
  /** Indices of every triangle lying entirely on the plane z = height. */
  function topFace(mesh: { positions: Float32Array; indices: Uint32Array }, height: number) {
    const out: number[] = [];
    for (let t = 0; t < meshDataTriangleCount(mesh); t++) {
      let onTop = true;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(mesh.positions[mesh.indices[t * 3 + k] * 3 + 2] - height) > 1e-6) {
          onTop = false;
          break;
        }
      }
      if (onTop) out.push(t);
    }
    return out;
  }

  it("bounds a paint depth that would turn the shell inside out", async () => {
    const kernel = await getGeometryKernel();
    // A 2mm plate painted 6mm deep: the offset copy would pass through the
    // bottom face and the shell would come back with NEGATIVE volume, which
    // the kernel reports as NoError because it validates topology only.
    const plate = kernel.box(40, 20, 2, false);
    const mesh = plate.toMeshData();
    const warningsHe: string[] = [];
    const pieces = splitSolidByPaint(
      kernel,
      plate,
      mesh,
      [paint("red", topFace(mesh, 2), meshDataTriangleCount(mesh), 6)],
      warningsHe
    );

    expect(warningsHe.some((w) => w.includes("עומק הצביעה הוקטן"))).toBe(true);
    // Still a real two-way split, not a collapse into one body.
    expect(pieces).toHaveLength(2);
    const painted = pieces.find((p) => p.materialSlotId === "red")!;
    const body = pieces.find((p) => p.materialSlotId === null)!;
    expect(painted.solid.volumeMm3()).toBeGreaterThan(0);
    expect(body.solid.volumeMm3()).toBeGreaterThan(0);
    expect(painted.solid.volumeMm3() + body.solid.volumeMm3()).toBeCloseTo(1600, 1);
    for (const piece of pieces) piece.solid.dispose();
  });

  it("merges two paint entries that name the same material", () => {
    // Two entries for one slot cut the body twice, collide as React keys and
    // export as two files wanting the same filament.
    const merged = activePaints(
      [paint("red", [0, 1], 12, 0.8), paint("red", [1, 5], 12, 1.4)],
      12
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].triangles).toEqual([0, 1, 5]);
    expect(merged[0].depthMm).toBeCloseTo(1.4, 6);
  });
});

describe("export split regressions", () => {
  const doc = (layers: DesignLayer[]): DesignDocument =>
    testDocumentWith(layers, { materialSlots: PAINT_SLOTS });

  const plate = (facePaint?: FacePaint[]): DesignLayer =>
    testBoxLayer({
      id: "plate",
      name: "לוחית",
      facePaint,
      widthMm: 40,
      depthMm: 20,
      heightMm: 2,
    });

  /**
   * A thin-WALLED body. The depth bound is derived from the bounding box, so
   * a 1mm wall inside a 40mm envelope is the case where a legal depth can
   * still swallow the whole part.
   */
  function tube(facePaint?: FacePaint[]): DesignLayer {
    return {
      id: "tube",
      type: "primitive",
      name: "צינור",
      visible: true,
      locked: false,
      materialSlotId: "slot1",
      transform: identityTransform(),
      previewOpacity: 1,
      facePaint,
      ...defaultPrimitive("tube"),
      radiusMm: 20,
      radius2Mm: 19,
      heightMm: 20,
    } as DesignLayer;
  }

  it("refuses a split that would not add back up to the body", async () => {
    // A 1mm wall inside a 40mm envelope: the depth bound is derived from the
    // bounding box, so 9mm of paint is "legal" and yet passes clean through
    // the wall. The resulting shell self-intersects in a way the kernel
    // accepts silently, and the split invented material — 2,446mm3 of tube
    // came back as 7,102mm3 of parts.
    const plain = await buildDocument(doc([tube()]));
    const mesh = plain.parts[0].localMesh;
    const count = meshDataTriangleCount(mesh);
    const originalVolume = plain.parts[0].stats.volumeMm3;

    const document = doc([
      tube([
        {
          materialSlotId: "slot2",
          triangles: Array.from({ length: count }, (_, i) => i),
          meshTriangleCount: count,
          depthMm: 9,
        },
      ]),
    ]);
    const build = await buildDocument(document);
    const split = await splitPartsByPaint(document, build.parts);

    const total = split.parts.reduce((sum, p) => sum + p.stats.volumeMm3, 0);
    expect(total).toBeCloseTo(originalVolume, 1);
    // Refused rather than silently wrong, and the user is told why.
    expect(split.parts).toHaveLength(1);
    expect(split.warningsHe.some((w) => w.includes("הפרדה נקייה"))).toBe(true);
  });

  it("warns at export when the body outgrew its paint", async () => {
    const document = doc([
      plate([
        { materialSlotId: "slot2", triangles: [0, 1], meshTriangleCount: 99999, depthMm: 1 },
      ]),
    ]);
    const build = await buildDocument(document);
    const split = await splitPartsByPaint(document, build.parts);
    expect(split.parts).toHaveLength(1);
    expect(split.warningsHe.some((w) => w.includes("בוטלה"))).toBe(true);
  });

  it("reports stale paint as a build issue, not only at export", async () => {
    const document = doc([
      plate([
        { materialSlotId: "slot2", triangles: [0], meshTriangleCount: 99999, depthMm: 1 },
      ]),
    ]);
    const build = await buildDocument(document);
    expect(build.issues.some((i) => i.code === "paint/stale")).toBe(true);
  });
});
