/**
 * Edit-resilient face paint (V6 item 17).
 *
 * The old contract: any shape change discarded the paint (index
 * fingerprint mismatch). The new one: paint carries spatial anchors and is
 * re-projected onto the rebuilt body by proximity + normal agreement. The
 * tests paint a real region, RESHAPE the body through the kernel, and
 * assert geometrically that the paint survived exactly where it should —
 * and nowhere else (the thin-wall opposite side is the trap the normal
 * test exists for).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getGeometryKernel } from "../kernel";
import type { MeshData } from "../meshData";
import { paintAnchorsFor, paintTriangles, reanchorPaints } from "../painting";

let kernel: Awaited<ReturnType<typeof getGeometryKernel>>;

beforeAll(async () => {
  kernel = await getGeometryKernel();
});

/** Indices of triangles whose every vertex sits on the z = `plane` face. */
function faceTriangles(mesh: MeshData, plane: number, tolerance = 1e-4): number[] {
  const out: number[] = [];
  const count = mesh.indices.length / 3;
  for (let t = 0; t < count; t++) {
    let onFace = true;
    for (let k = 0; k < 3; k++) {
      const z = mesh.positions[mesh.indices[t * 3 + k] * 3 + 2];
      if (Math.abs(z - plane) > tolerance) {
        onFace = false;
        break;
      }
    }
    if (onFace) out.push(t);
  }
  return out;
}

describe("paint re-anchoring", () => {
  it("paint survives a reshape, lands on the right region and nowhere else", () => {
    // A refined box so the top face has a real triangulation.
    const original = kernel.box(20, 20, 10, false).refineToLength(3);
    const meshBefore = original.toMeshData();
    original.dispose();

    // Paint the TOP face.
    const topBefore = faceTriangles(meshBefore, 10);
    expect(topBefore.length).toBeGreaterThan(10);
    const paints = paintTriangles(
      undefined,
      "slot-red",
      topBefore,
      meshBefore.indices.length / 3,
      0.8,
      meshBefore
    );
    expect(paints[0].anchors?.length).toBe(topBefore.length * 7);

    // RESHAPE: cut a notch out of one side — different triangulation, the
    // top face itself survives (partially).
    const body = kernel.box(20, 20, 10, false).refineToLength(3);
    const notch = kernel.box(6, 6, 20, false).translate(-1, -1, -5);
    const reshaped = body.subtract(notch);
    const meshAfter = reshaped.toMeshData();
    reshaped.dispose();
    expect(meshAfter.indices.length).not.toBe(meshBefore.indices.length);

    const result = reanchorPaints(paints, meshAfter);
    expect(result.reanchored).toBe(1);
    expect(result.dropped).toBe(0);
    const region = result.paints.find((p) => p.materialSlotId === "slot-red");
    expect(region).toBeDefined();
    expect(region!.meshTriangleCount).toBe(meshAfter.indices.length / 3);

    // Geometric assertions on WHERE the paint landed: every painted
    // triangle lies on the top plane…
    const painted = new Set(region!.triangles);
    for (const t of painted) {
      for (let k = 0; k < 3; k++) {
        const z = meshAfter.positions[meshAfter.indices[t * 3 + k] * 3 + 2];
        expect(Math.abs(z - 10)).toBeLessThan(0.6);
      }
    }
    // …and it covers the surviving top face substantially (the notch area
    // is gone, everything else keeps its colour).
    const topAfter = faceTriangles(meshAfter, 10);
    const covered = topAfter.filter((t) => painted.has(t)).length;
    expect(covered / topAfter.length).toBeGreaterThan(0.85);
  }, 60_000);

  it("does not bleed through to the far side of a thin wall", () => {
    // A 1.2mm-thick plate: top at z=1.2, bottom at z=0 — well inside the
    // catch radius of the top's anchors. Only the normal test separates them.
    const plate = kernel.box(20, 20, 1.2, false).refineToLength(2.5);
    const meshBefore = plate.toMeshData();
    plate.dispose();
    const top = faceTriangles(meshBefore, 1.2);
    const paints = paintTriangles(
      undefined,
      "slot-red",
      top,
      meshBefore.indices.length / 3,
      0.4,
      meshBefore
    );

    // Reshape: trim one edge slightly.
    const body = kernel.box(20, 20, 1.2, false).refineToLength(2.5);
    const trimmed = body.trimByPlane(1, 0, 0, -9);
    const meshAfter = trimmed.toMeshData();
    trimmed.dispose();

    const result = reanchorPaints(paints, meshAfter);
    const region = result.paints.find((p) => p.materialSlotId === "slot-red");
    expect(region).toBeDefined();
    const bottomAfter = new Set(faceTriangles(meshAfter, 0));
    for (const t of region!.triangles) {
      expect(bottomAfter.has(t)).toBe(false);
    }
    // And the surviving top is still painted.
    const topAfter = faceTriangles(meshAfter, 1.2);
    const painted = new Set(region!.triangles);
    expect(topAfter.filter((t) => painted.has(t)).length / topAfter.length).toBeGreaterThan(0.8);
  }, 60_000);

  it("paint without anchors keeps the honest discard behaviour", () => {
    const box = kernel.box(10, 10, 10, false);
    const mesh = box.toMeshData();
    box.dispose();
    const legacy = [
      { materialSlotId: "slot-red", triangles: [0, 1], meshTriangleCount: 9999, depthMm: 0.8 },
    ];
    const result = reanchorPaints(legacy, mesh);
    expect(result.reanchored).toBe(0);
    expect(result.dropped).toBe(1);
    expect(result.paints).toEqual([]);
  });

  it("anchors describe the painted triangles (centroid on the face)", () => {
    const box = kernel.box(10, 10, 10, false);
    const mesh = box.toMeshData();
    box.dispose();
    const top = faceTriangles(mesh, 10);
    const anchors = paintAnchorsFor(mesh, top);
    for (let i = 0; i < anchors.length; i += 7) {
      expect(anchors[i + 2]).toBeCloseTo(10, 5); // centroid z on the face
      expect(anchors[i + 5]).toBeCloseTo(1, 5); // normal +z
      expect(anchors[i + 6]).toBeGreaterThan(0); // a real size
    }
  });
});
