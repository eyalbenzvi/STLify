/**
 * Geometric snapping, extended measurements, the mesh-store sweep, and the
 * geometry job runner's in-process fallback.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { MeshBvh } from "../bvh";
import { getGeometryKernel } from "../kernel";
import type { MeshData } from "../meshData";
import {
  clearMeshStore,
  garbageCollect,
  getMesh,
  listMeshIds,
  meshStoreStats,
  storeMesh,
} from "../meshStore";
import {
  DEFAULT_SNAP_OPTIONS,
  findSnapCandidate,
  measureAngleBetweenFaces,
  measureRadiusFromThreePoints,
  measureThicknessAtPoint,
} from "../snapping";
import { runGeometryJob } from "../jobs/client";

function cube(s = 20): MeshData {
  const h = s / 2;
  return {
    positions: new Float32Array([
      -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
      -h, -h, h, h, -h, h, h, h, h, -h, h, h,
    ]),
    indices: new Uint32Array([
      0, 3, 2, 0, 2, 1,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6,
      3, 0, 4, 3, 4, 7,
    ]),
  };
}

describe("geometric snapping", () => {
  const mesh = cube(20);
  const bvh = new MeshBvh(mesh);

  it("snaps to the nearest corner", () => {
    const candidate = findSnapCandidate(mesh, bvh, { x: 9.4, y: 9.4, z: 9.4 });
    expect(candidate).not.toBeNull();
    expect(candidate?.feature).toBe("vertex");
    expect(candidate?.point.x).toBeCloseTo(10, 5);
    expect(candidate?.point.y).toBeCloseTo(10, 5);
    expect(candidate?.point.z).toBeCloseTo(10, 5);
    expect(candidate?.labelHe).toBe("קודקוד");
  });

  it("prefers a corner over a closer face centre", () => {
    // A point near a corner is geometrically closer to several face centres
    // on a small cube, but the corner is what the user means.
    const candidate = findSnapCandidate(mesh, bvh, { x: 8.5, y: 8.5, z: 10 }, {
      ...DEFAULT_SNAP_OPTIONS,
      radiusMm: 8,
    });
    expect(candidate?.feature).toBe("vertex");
  });

  it("snaps to an edge midpoint when no corner is in range", () => {
    const candidate = findSnapCandidate(mesh, bvh, { x: 0.2, y: 10, z: 10.2 }, {
      ...DEFAULT_SNAP_OPTIONS,
      radiusMm: 2,
      vertices: false,
    });
    expect(candidate?.feature).toBe("edgeMidpoint");
  });

  it("returns nothing when everything is out of range", () => {
    expect(findSnapCandidate(mesh, bvh, { x: 500, y: 500, z: 500 })).toBeNull();
  });

  it("respects disabled feature types", () => {
    const candidate = findSnapCandidate(mesh, bvh, { x: 9.9, y: 9.9, z: 9.9 }, {
      radiusMm: 3,
      vertices: false,
      edgeMidpoints: false,
      faceCenters: false,
      edgeProjections: false,
    });
    expect(candidate).toBeNull();
  });
});

describe("extended measurements", () => {
  const mesh = cube(20);
  const bvh = new MeshBvh(mesh);

  it("measures a 90-degree inside corner between two cube faces", () => {
    // A point on the +X face and a point on the +Y face.
    const result = measureAngleBetweenFaces(
      mesh,
      bvh,
      { x: 10, y: 0, z: 0 },
      { x: 0, y: 10, z: 0 }
    );
    expect(result).not.toBeNull();
    expect(result?.degrees).toBeCloseTo(90, 3);
  });

  it("measures 180 degrees across a flat face", () => {
    const result = measureAngleBetweenFaces(
      mesh,
      bvh,
      { x: 3, y: 3, z: 10 },
      { x: -3, y: -3, z: 10 }
    );
    expect(result?.degrees).toBeCloseTo(180, 3);
  });

  it("measures 0 degrees across opposite faces", () => {
    const result = measureAngleBetweenFaces(
      mesh,
      bvh,
      { x: 0, y: 0, z: 10 },
      { x: 0, y: 0, z: -10 }
    );
    expect(result?.degrees).toBeCloseTo(0, 3);
  });

  it("recovers a circle's radius from three points on it", () => {
    const radius = 7.5;
    const points = [0, 1, 2].map((i) => {
      const a = (i / 3) * Math.PI * 2;
      return { x: Math.cos(a) * radius, y: Math.sin(a) * radius, z: 4 };
    });
    const result = measureRadiusFromThreePoints(points[0], points[1], points[2]);
    expect(result?.radiusMm).toBeCloseTo(radius, 6);
    expect(result?.center.x).toBeCloseTo(0, 6);
    expect(result?.center.z).toBeCloseTo(4, 6);
  });

  it("recovers the radius of a real cylinder's rim", async () => {
    const kernel = await getGeometryKernel();
    const cylinder = kernel.cylinder(12, 10, 128);
    const rim = cylinder.slicePolygons(5);
    cylinder.dispose();
    const outline = rim[0];
    const pick = (i: number) => ({
      x: outline[i][0],
      y: outline[i][1],
      z: 5,
    });
    const result = measureRadiusFromThreePoints(
      pick(0),
      pick(Math.floor(outline.length / 3)),
      pick(Math.floor((outline.length * 2) / 3))
    );
    expect(result?.radiusMm).toBeGreaterThan(11.9);
    expect(result?.radiusMm).toBeLessThan(12.01);
    // The centre must land on the cylinder's axis, not mirrored off it.
    // Tolerance is float32 slice precision; a mirrored centre would be ~24mm
    // out, so this still catches the operand-order bug by four orders of
    // magnitude.
    expect(Math.hypot(result?.center.x ?? 99, result?.center.y ?? 99)).toBeLessThan(0.01);
  });

  it("returns null for collinear points", () => {
    expect(
      measureRadiusFromThreePoints({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 })
    ).toBeNull();
  });

  it("measures the wall thickness of a solid cube", () => {
    // From the top face straight down: 20mm of solid.
    const result = measureThicknessAtPoint(mesh, bvh, { x: 0, y: 0, z: 10 });
    expect(result).not.toBeNull();
    expect(result?.thicknessMm).toBeCloseTo(20, 2);
  });

  it("measures the thin wall of a hollow box", async () => {
    const kernel = await getGeometryKernel();
    const outer = kernel.box(30, 30, 30, true);
    const inner = kernel.box(26, 26, 26, true);
    const hollow = outer.subtract(inner);
    const hollowMesh = hollow.toMeshData();
    hollow.dispose();
    const hollowBvh = new MeshBvh(hollowMesh);
    // On the outer top face, pointing inward: the wall is 2mm.
    const result = measureThicknessAtPoint(hollowMesh, hollowBvh, { x: 0, y: 0, z: 15 });
    expect(result?.thicknessMm).toBeCloseTo(2, 2);
  });
});

describe("mesh store garbage collection", () => {
  beforeEach(() => clearMeshStore());

  it("frees meshes nothing references", () => {
    const keep = storeMesh(cube(10));
    const drop = storeMesh(cube(10));
    expect(listMeshIds()).toHaveLength(2);
    const before = meshStoreStats().bytes;
    expect(before).toBeGreaterThan(0);

    const result = garbageCollect(new Set([keep]));
    expect(result.removed).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(result.remaining).toBe(1);
    expect(getMesh(keep)).not.toBeNull();
    expect(getMesh(drop)).toBeNull();
  });

  it("keeps everything still referenced by history", () => {
    const a = storeMesh(cube(10));
    const b = storeMesh(cube(10));
    const result = garbageCollect(new Set([a, b]));
    expect(result.removed).toBe(0);
    expect(result.remaining).toBe(2);
  });

  it("reports accurate byte totals", () => {
    const mesh = cube(10);
    storeMesh(mesh);
    const expected = mesh.positions.byteLength + mesh.indices.byteLength;
    expect(meshStoreStats().bytes).toBe(expected);
    expect(meshStoreStats().count).toBe(1);
  });
});

describe("geometry job runner", () => {
  it("runs a job in-process when no worker is available", async () => {
    const outcome = await runGeometryJob(
      "selfIntersections",
      { mesh: cube(10) },
      { forceInProcess: true }
    );
    // Under vitest there is no module worker, so this MUST fall back rather
    // than silently doing nothing.
    expect(outcome.ranOn).toBe("main");
    expect(outcome.result.pairCount).toBe(0);
  });

  it("reports progress", async () => {
    const seen: number[] = [];
    await runGeometryJob(
      "cleanupComponents",
      { mesh: cube(10) },
      { forceInProcess: true, onProgress: (fraction) => seen.push(fraction) }
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBeGreaterThan(0);
  });

  it("aborts before starting when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runGeometryJob("cleanupComponents", { mesh: cube(10) }, {
        forceInProcess: true,
        signal: controller.signal,
      })
    ).rejects.toThrow(/cancelled/);
  });

  it("runs a real repair through the job registry", async () => {
    const base = cube(20);
    const broken = { positions: base.positions, indices: base.indices.slice(0, 30) };
    const outcome = await runGeometryJob(
      "repairMesh",
      { mesh: broken, options: {} },
      { forceInProcess: true }
    );
    expect(outcome.result.succeeded).toBe(true);
    expect(outcome.result.mesh).not.toBeNull();
  });
});
