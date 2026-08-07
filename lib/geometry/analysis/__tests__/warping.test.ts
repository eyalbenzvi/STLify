/**
 * Warping analysis + brim/raft generation (V6 item 12).
 *
 * The analysis must flag the CLASSIC warping case (a thin wide plate) and
 * must NOT flag a small cube; the score must be explained in Hebrew with
 * its numbers. Brim/raft are verified geometrically: exact ring area for a
 * rectangular footprint (miter joins), exact raft height and margin, and
 * both come out watertight.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getGeometryKernel } from "../../kernel";
import { analyzeWarping } from "../warping";
import {
  buildBrim,
  buildRaft,
  DEFAULT_BRIM_SETTINGS,
} from "../../operations/brimRaft";

let kernel: Awaited<ReturnType<typeof getGeometryKernel>>;

beforeAll(async () => {
  kernel = await getGeometryKernel();
});

describe("warping analysis", () => {
  it("flags a thin wide plate and not a cube", () => {
    const plate = kernel.box(120, 100, 2, false);
    const plateMesh = plate.toMeshData();
    plate.dispose();
    const cube = kernel.box(20, 20, 20, false);
    const cubeMesh = cube.toMeshData();
    cube.dispose();

    const plateRisk = analyzeWarping(plateMesh);
    const cubeRisk = analyzeWarping(cubeMesh);

    expect(plateRisk.riskLevel).not.toBe("low");
    expect(plateRisk.issues.length).toBeGreaterThan(0);
    expect(cubeRisk.riskLevel).toBe("low");
    expect(cubeRisk.issues).toEqual([]);
    expect(plateRisk.riskScore).toBeGreaterThan(cubeRisk.riskScore + 20);

    // The measurements behind the score are real geometry.
    expect(plateRisk.contactAreaMm2).toBeCloseTo(120 * 100, -2);
    expect(plateRisk.contactSpanMm).toBeCloseTo(120, 0);
    // And the score is explained, in Hebrew, with its numbers.
    expect(plateRisk.explanationHe.length).toBeGreaterThanOrEqual(4);
    expect(plateRisk.explanationHe.join(" ")).toContain("נק׳");
  });

  it("scores a tall tower on a narrow base above a cube", () => {
    const tower = kernel.box(15, 15, 120, false);
    const towerMesh = tower.toMeshData();
    tower.dispose();
    const risk = analyzeWarping(towerMesh);
    expect(risk.heightToBaseRatio).toBeCloseTo(8, 0);
    expect(risk.riskLevel).not.toBe("low");
  });
});

describe("brim generation", () => {
  it("builds a watertight ring of the exact analytic area", async () => {
    const box = kernel.box(20, 30, 10, false);
    const mesh = box.toMeshData();
    box.dispose();

    const brim = await buildBrim(kernel, mesh, { widthMm: 5, heightMm: 0.3 });
    // Miter joins keep the rectangle rectangular:
    // ring area = (20+10)(30+10) − 20·30 = 1200 − 600 = 600 mm².
    expect(brim.areaMm2).toBeCloseTo(600, 0);
    expect(brim.solid.status()).toBe("NoError");
    const bounds = brim.solid.boundingBox();
    expect(bounds.min.z).toBeCloseTo(0, 5);
    expect(bounds.max.z).toBeCloseTo(0.3, 5);
    // The ring hugs the part: outer extent grows by exactly the width.
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(30, 1);
    expect(bounds.max.y - bounds.min.y).toBeCloseTo(40, 1);
    // And it must not interpenetrate the part it hugs.
    const { solid: part } = kernel.fromMeshData(mesh);
    const overlap = part.intersect(brim.solid);
    expect(overlap.isEmpty() || overlap.volumeMm3() < 1e-6).toBe(true);
    overlap.dispose();
  });

  it("derives from the FIRST layer, not the shadow", async () => {
    // A T-shape: narrow column with a wide top. The brim must follow the
    // 10×10 column footprint, not the 40×40 overhanging roof.
    const column = kernel.box(10, 10, 20, false).translate(15, 15, 0);
    const roof = kernel.box(40, 40, 5, false).translate(0, 0, 20);
    const tee = column.union(roof);
    const mesh = tee.toMeshData();
    tee.dispose();

    const brim = await buildBrim(kernel, mesh, DEFAULT_BRIM_SETTINGS);
    // Footprint 10×10 + 5mm brim → 20×20 ring: area 400−100=300.
    expect(brim.areaMm2).toBeCloseTo(300, 0);
    brim.solid.dispose();
  });
});

describe("raft generation", () => {
  it("builds a slab of the exact height and margin, and reports the lift", async () => {
    const box = kernel.box(20, 30, 10, false);
    const mesh = box.toMeshData();
    box.dispose();

    const raft = await buildRaft(kernel, mesh, { marginMm: 3, heightMm: 2 });
    expect(raft.liftMm).toBe(2);
    expect(raft.solid.status()).toBe("NoError");
    const bounds = raft.solid.boundingBox();
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(2, 5);
    expect(bounds.min.z).toBeCloseTo(0, 5);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(26, 1);
    expect(bounds.max.y - bounds.min.y).toBeCloseTo(36, 1);
    // Slab volume = (20+6)(30+6)·2 with miter joins.
    expect(raft.solid.volumeMm3()).toBeCloseTo(26 * 36 * 2, 0);
    raft.solid.dispose();
  });
});
