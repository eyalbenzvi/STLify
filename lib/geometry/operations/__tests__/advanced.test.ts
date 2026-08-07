/**
 * Fillet/chamfer, open shell, deformers, lattice infill and build-plate
 * arrangement. Assertions measure the geometric consequence of each
 * operation (volume change, bounding box, topology) rather than just that a
 * solid came back.
 */

import { describe, expect, it } from "vitest";
import { arrangeOnPlate } from "../../analysis/collision";
import { getGeometryKernel } from "../../kernel";
import { analyzeTopology } from "../../repair/topology";
import { bendSolid, ffdSolid, stretchSolid, taperSolid, twistSolid } from "../deform";
import { roundEdges, shellSolid } from "../fillet";
import { latticeFill } from "../lattice";
import { OpError } from "../layerOps";

describe("fillet and chamfer", () => {
  it("rounds convex edges, removing volume from the corners", async () => {
    const kernel = await getGeometryKernel();
    const cube = kernel.box(20, 20, 20, true);
    const before = cube.volumeMm3();
    const { solid, volumeAfterMm3 } = roundEdges(kernel, cube, {
      sizeMm: 2,
      style: "fillet",
      scope: "convex",
    });
    // Rounding the outside can only remove material.
    expect(volumeAfterMm3).toBeLessThan(before);
    // ...but only from the edges, so most of the cube survives.
    expect(volumeAfterMm3).toBeGreaterThan(before * 0.9);
    // The overall size is preserved: an opening does not shrink flat faces.
    const bounds = solid.boundingBox();
    expect(bounds.max.x).toBeCloseTo(10, 0);
    expect(solid.status()).toBe("NoError");
    solid.dispose();
  });

  it("rounds concave edges, adding volume into inside corners", async () => {
    const kernel = await getGeometryKernel();
    // An L-shape has one concave edge.
    const big = kernel.box(20, 20, 20, true);
    const bite = kernel.box(12, 12, 30, true).translate(7, 7, 0);
    const shape = big.subtract(bite);
    const before = shape.volumeMm3();
    const { solid, volumeAfterMm3 } = roundEdges(kernel, shape, {
      sizeMm: 2,
      style: "fillet",
      scope: "concave",
    });
    // Filling an inside corner adds material.
    expect(volumeAfterMm3).toBeGreaterThan(before);
    expect(solid.status()).toBe("NoError");
    solid.dispose();
  });

  it("removes more volume as the radius grows", async () => {
    // Monotonicity is the invariant that proves the morphological opening is
    // wired up correctly: a bigger structuring element must round harder.
    const kernel = await getGeometryKernel();
    const small = roundEdges(kernel, kernel.box(20, 20, 20, true), {
      sizeMm: 1, style: "fillet", scope: "convex",
    });
    const large = roundEdges(kernel, kernel.box(20, 20, 20, true), {
      sizeMm: 4, style: "fillet", scope: "convex",
    });
    expect(large.volumeAfterMm3).toBeLessThan(small.volumeAfterMm3);
    small.solid.dispose();
    large.solid.dispose();
  });

  it("chamfer cuts flat faces where the fillet cuts curved ones", async () => {
    const kernel = await getGeometryKernel();
    const filleted = roundEdges(kernel, kernel.box(20, 20, 20, true), {
      sizeMm: 3, style: "fillet", scope: "convex",
    });
    const chamfered = roundEdges(kernel, kernel.box(20, 20, 20, true), {
      sizeMm: 3, style: "chamfer", scope: "convex",
    });
    // Both are valid solids that removed material from the corners...
    expect(filleted.solid.status()).toBe("NoError");
    expect(chamfered.solid.status()).toBe("NoError");
    expect(filleted.volumeAfterMm3).toBeLessThan(8000);
    expect(chamfered.volumeAfterMm3).toBeLessThan(8000);
    // ...but they are genuinely different shapes. The octahedral element
    // produces planar cuts, so it needs far fewer triangles than the ball's
    // curved scoops.
    expect(chamfered.solid.numTriangles()).toBeLessThan(
      filleted.solid.numTriangles()
    );
    filleted.solid.dispose();
    chamfered.solid.dispose();
  });

  it("refuses a radius larger than half the smallest dimension", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      roundEdges(kernel, kernel.box(20, 20, 4, true), {
        sizeMm: 5, style: "fillet", scope: "convex",
      })
    ).toThrow(/גדול מדי/);
  });
});

describe("open shell", () => {
  it("hollows a box and opens the top", async () => {
    const kernel = await getGeometryKernel();
    const cube = kernel.box(30, 30, 30, true).translate(0, 0, 15);
    const before = cube.volumeMm3();
    const { solid, volumeAfterMm3 } = shellSolid(kernel, cube, {
      wallThicknessMm: 2,
      opening: "top",
    });
    // A 2mm shell on a 30mm cube keeps well under half the material.
    expect(volumeAfterMm3).toBeLessThan(before * 0.5);
    expect(volumeAfterMm3).toBeGreaterThan(0);
    expect(solid.status()).toBe("NoError");
    // An open box is still a closed SURFACE (a tray has an inside and an
    // outside), so it must remain watertight and printable.
    expect(analyzeTopology(solid.toMeshData()).boundaryEdgeCount).toBe(0);
    solid.dispose();
  });

  it("a sealed shell keeps more material than an opened one", async () => {
    const kernel = await getGeometryKernel();
    const sealed = shellSolid(kernel, kernel.box(30, 30, 30, true).translate(0, 0, 15), {
      wallThicknessMm: 2, opening: "none",
    });
    const opened = shellSolid(kernel, kernel.box(30, 30, 30, true).translate(0, 0, 15), {
      wallThicknessMm: 2, opening: "top",
    });
    expect(opened.volumeAfterMm3).toBeLessThan(sealed.volumeAfterMm3);
    sealed.solid.dispose();
    opened.solid.dispose();
  });

  it("refuses a wall thicker than half the body", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      shellSolid(kernel, kernel.box(10, 10, 4, true), {
        wallThicknessMm: 3, opening: "top",
      })
    ).toThrow(OpError);
  });
});

describe("deformers", () => {
  it("twist preserves volume and rotates the top", async () => {
    const kernel = await getGeometryKernel();
    const bar = kernel.box(10, 10, 40, true);
    const before = bar.volumeMm3();
    const twisted = twistSolid(bar, { axis: "z", degrees: 90 });
    // A rigid rotation per slice preserves volume to within facet error.
    expect(twisted.volumeMm3()).toBeGreaterThan(before * 0.97);
    expect(twisted.volumeMm3()).toBeLessThan(before * 1.03);
    // Twisting a square makes the silhouette wider than the original 10mm.
    const bounds = twisted.boundingBox();
    expect(bounds.max.x).toBeGreaterThan(5.5);
    twisted.dispose();
  });

  it("taper shrinks the top and reduces volume", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(20, 20, 20, true).translate(0, 0, 10);
    const before = box.volumeMm3();
    const tapered = taperSolid(box, { axis: "z", endScale: 0.5 });
    expect(tapered.volumeMm3()).toBeLessThan(before);
    // The base is untouched, the top is halved.
    const top = tapered.slicePolygons(19.5);
    const xs = top.flat().map((p) => p[0]);
    expect(Math.max(...xs)).toBeLessThan(6);
    const bottom = tapered.slicePolygons(0.5);
    const bxs = bottom.flat().map((p) => p[0]);
    expect(Math.max(...bxs)).toBeGreaterThan(9);
    tapered.dispose();
  });

  it("bend curls a long bar without changing its volume much", async () => {
    const kernel = await getGeometryKernel();
    const bar = kernel.box(60, 10, 3, true);
    const before = bar.volumeMm3();
    const bent = bendSolid(bar, { axis: "x", towards: "z", degrees: 90 });
    expect(bent.status()).toBe("NoError");
    // Bending conserves material.
    expect(bent.volumeMm3()).toBeGreaterThan(before * 0.95);
    expect(bent.volumeMm3()).toBeLessThan(before * 1.05);
    // A 90-degree bend must shorten the X extent well below the flat length.
    const bounds = bent.boundingBox();
    expect(bounds.max.x - bounds.min.x).toBeLessThan(60 * 0.95);
    // ...and give it real height it did not have before.
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(5);
    bent.dispose();
  });

  it("bend rejects using the same axis twice", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      bendSolid(kernel.box(10, 10, 10, true), { axis: "x", towards: "x", degrees: 45 })
    ).toThrow(/שונים/);
  });

  it("stretch bulges only the middle", async () => {
    const kernel = await getGeometryKernel();
    const bar = kernel.box(10, 10, 40, true).translate(0, 0, 20);
    const before = bar.volumeMm3();
    const stretched = stretchSolid(bar, {
      axis: "z", center: 0.5, amount: 1.5, falloff: 0.4,
    });
    expect(stretched.volumeMm3()).toBeGreaterThan(before);
    // The middle is wider than the original half-width of 5mm...
    const middle = stretched.slicePolygons(20);
    expect(Math.max(...middle.flat().map((p) => p[0]))).toBeGreaterThan(6);
    // ...while the ends are untouched.
    const end = stretched.slicePolygons(1);
    expect(Math.max(...end.flat().map((p) => p[0]))).toBeCloseTo(5, 1);
    stretched.dispose();
  });

  it("FFD with zero displacement is a no-op", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(10, 10, 10, true);
    const tris = box.numTriangles();
    const result = ffdSolid(box, {
      resolution: { x: 2, y: 2, z: 2 },
      displacements: Array.from({ length: 8 }, () => ({ x: 0, y: 0, z: 0 })),
    });
    expect(result.numTriangles()).toBe(tris);
    result.dispose();
  });

  it("FFD moves the cage corner it is told to", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(20, 20, 20, true);
    // Displace only the (max x, max y, max z) corner outward in X.
    const displacements = Array.from({ length: 8 }, () => ({ x: 0, y: 0, z: 0 }));
    displacements[1 + 2 * (1 + 2 * 1)] = { x: 10, y: 0, z: 0 };
    const result = ffdSolid(box, { resolution: { x: 2, y: 2, z: 2 }, displacements });
    expect(result.boundingBox().max.x).toBeGreaterThan(15);
    // The opposite corner stays where it was.
    expect(result.boundingBox().min.x).toBeCloseTo(-10, 1);
    result.dispose();
  });

  it("FFD rejects a displacement list that does not match the cage", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      ffdSolid(kernel.box(10, 10, 10, true), {
        resolution: { x: 2, y: 2, z: 2 },
        displacements: [{ x: 1, y: 0, z: 0 }],
      })
    ).toThrow(/נקודות הבקרה/);
  });
});

describe("lattice infill", () => {
  it("replaces the interior with a gyroid, saving material", async () => {
    const kernel = await getGeometryKernel();
    const cube = kernel.box(30, 30, 30, true).translate(0, 0, 15);
    const result = latticeFill(kernel, cube, {
      kind: "gyroid",
      cellSizeMm: 8,
      thicknessMm: 1.2,
      shellThicknessMm: 1.5,
    });
    expect(result.savedFraction).toBeGreaterThan(0.2);
    expect(result.savedFraction).toBeLessThan(0.95);
    expect(result.solid.status()).toBe("NoError");
    // The outer size is untouched — only the inside changed.
    const bounds = result.solid.boundingBox();
    expect(bounds.max.x).toBeCloseTo(15, 0);
    expect(bounds.max.z).toBeCloseTo(30, 0);
    result.solid.dispose();
  });

  it("saves less material than a full hollow would", async () => {
    const kernel = await getGeometryKernel();
    const lattice = latticeFill(kernel, kernel.box(30, 30, 30, true).translate(0, 0, 15), {
      kind: "gyroid", cellSizeMm: 8, thicknessMm: 1.2, shellThicknessMm: 1.5,
    });
    // A gyroid leaves struts behind, so it must retain more than an empty
    // shell of the same wall thickness.
    const shell = shellSolid(kernel, kernel.box(30, 30, 30, true).translate(0, 0, 15), {
      wallThicknessMm: 1.5, opening: "none",
    });
    expect(lattice.solid.volumeMm3()).toBeGreaterThan(shell.volumeAfterMm3);
    lattice.solid.dispose();
    shell.solid.dispose();
  });

  it("rejects struts too thick for the cell", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      latticeFill(kernel, kernel.box(30, 30, 30, true), {
        kind: "gyroid", cellSizeMm: 4, thicknessMm: 3, shellThicknessMm: 1,
      })
    ).toThrow(/עובי הסריג גדול מדי/);
  });

  it("rejects a shell that leaves no room", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      latticeFill(kernel, kernel.box(10, 10, 10, true), {
        kind: "gyroid", cellSizeMm: 3, thicknessMm: 0.8, shellThicknessMm: 6,
      })
    ).toThrow(/מעטפת גדול מדי/);
  });
});

describe("build-plate arrangement", () => {
  const settings = { plateWidthMm: 200, plateDepthMm: 200, spacingMm: 5 };

  it("lays parts out without overlapping", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      layerId: `l${i}`,
      widthMm: 40,
      depthMm: 30,
      currentX: 0,
      currentY: 0,
    }));
    const result = arrangeOnPlate(items, settings);
    expect(result.placements).toHaveLength(6);
    expect(result.unplaced).toHaveLength(0);
    // No two footprints may overlap.
    for (let i = 0; i < result.placements.length; i++) {
      for (let j = i + 1; j < result.placements.length; j++) {
        const a = result.placements[i];
        const b = result.placements[j];
        const separated = Math.abs(a.x - b.x) >= 40 || Math.abs(a.y - b.y) >= 30;
        expect(separated).toBe(true);
      }
    }
  });

  it("keeps everything inside the plate", () => {
    const items = Array.from({ length: 4 }, (_, i) => ({
      layerId: `l${i}`, widthMm: 60, depthMm: 60, currentX: 0, currentY: 0,
    }));
    const result = arrangeOnPlate(items, settings);
    for (const p of result.placements) {
      expect(Math.abs(p.x) + 30).toBeLessThanOrEqual(100);
      expect(Math.abs(p.y) + 30).toBeLessThanOrEqual(100);
    }
  });

  it("reports parts that cannot fit rather than stacking them", () => {
    const result = arrangeOnPlate(
      [{ layerId: "huge", widthMm: 500, depthMm: 20, currentX: 0, currentY: 0 }],
      settings
    );
    expect(result.placements).toHaveLength(0);
    expect(result.unplaced).toEqual(["huge"]);
    expect(result.summaryHe).toContain("לא נכנסו");
  });

  it("is deterministic", () => {
    const items = [
      { layerId: "a", widthMm: 30, depthMm: 50, currentX: 0, currentY: 0 },
      { layerId: "b", widthMm: 40, depthMm: 20, currentX: 0, currentY: 0 },
      { layerId: "c", widthMm: 25, depthMm: 35, currentX: 0, currentY: 0 },
    ];
    expect(arrangeOnPlate(items, settings)).toEqual(arrangeOnPlate(items, settings));
  });
});
