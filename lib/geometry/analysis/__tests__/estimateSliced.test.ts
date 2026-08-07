/**
 * Slice-based estimation (V6 item 11).
 *
 * Two layers of verification, both geometric:
 *
 * 1. MEASUREMENT — the slice metrics must match ANALYTIC values on bodies
 *    whose per-layer perimeter and area are known exactly: a cube, a thin
 *    wide plate, a hollow cylinder.
 * 2. MODEL BEHAVIOUR — the failure cases the old volume-only model was
 *    called out for: a thin wide plate (time dominated by perimeters and
 *    travel, underestimated by volume·flow) and SLA cross-section
 *    dependence (the old model timed a hollow ring exactly like a solid
 *    disc of the same height). The new model must be closer to the
 *    perimeter-aware reference than the old one on the plate, and must
 *    order the SLA cases correctly.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getGeometryKernel } from "../../kernel";
import {
  estimateFromSlices,
  measureSliceMetrics,
  mergeSliceMetrics,
  SLICED_ESTIMATE_CONSTANTS,
} from "../estimateSliced";
import {
  estimateDetailed,
  type DetailedEstimateInputs,
} from "../estimateDetailed";

let kernel: Awaited<ReturnType<typeof getGeometryKernel>>;

beforeAll(async () => {
  kernel = await getGeometryKernel();
});

function inputs(overrides: Partial<DetailedEstimateInputs>): DetailedEstimateInputs {
  return {
    modelVolumeMm3: 0,
    boundsMm: { x: 10, y: 10, z: 10 },
    technology: "fdm",
    layerHeightMm: 0.2,
    nozzleDiameterMm: 0.4,
    infillPercent: 20,
    densityGCm3: 1.24,
    pricePerKgIls: 90,
    ...overrides,
  };
}

describe("slice metrics vs analytic values", () => {
  it("cube 20³: perimeter 80/layer, area 400/layer, 100 layers", () => {
    const solid = kernel.box(20, 20, 20, false);
    const m = measureSliceMetrics(solid, 0.2);
    solid.dispose();
    expect(m.layerCount).toBe(100);
    expect(m.totalPerimeterMm).toBeCloseTo(80 * 100, -2); // within ~50mm of 8000
    expect(m.totalPerimeterMm / m.layerCount).toBeCloseTo(80, 1);
    expect(m.totalAreaMm2 / m.layerCount).toBeCloseTo(400, 1);
    expect(m.totalIslands / m.layerCount).toBeCloseTo(1, 2);
  });

  it("thin wide plate 100×100×2: perimeter 400/layer, area 10000/layer", () => {
    const solid = kernel.box(100, 100, 2, false);
    const m = measureSliceMetrics(solid, 0.2);
    solid.dispose();
    expect(m.layerCount).toBe(10);
    expect(m.sampledLayers).toBe(10); // few layers → every one measured
    expect(m.totalPerimeterMm / m.layerCount).toBeCloseTo(400, 1);
    expect(m.totalAreaMm2 / m.layerCount).toBeCloseTo(10_000, 0);
  });

  it("hollow cylinder R20/r16: perimeter 2π(R+r), area π(R²−r²)", () => {
    const outer = kernel.cylinder(20, 20, 256);
    const inner = kernel.cylinder(16, 20, 256).translate(0, 0, -1);
    const ring = outer.subtract(inner.scale(1, 1, 1.2));
    const m = measureSliceMetrics(ring, 0.2);
    ring.dispose();
    // 256-segment polygons underestimate the circle by <0.01%.
    expect(m.totalPerimeterMm / m.layerCount).toBeCloseTo(2 * Math.PI * (20 + 16), 0);
    expect(m.totalAreaMm2 / m.layerCount).toBeCloseTo(Math.PI * (400 - 256), 0);
    // One outline island per layer (the hole is not an island).
    expect(m.totalIslands / m.layerCount).toBeCloseTo(1, 2);
  });
});

describe("model behaviour on the old model's failure cases", () => {
  it("thin wide plate: the new model is closer to the perimeter-aware reference", () => {
    const solid = kernel.box(100, 100, 2, false);
    const volume = solid.volumeMm3();
    const metrics = measureSliceMetrics(solid, 0.2);
    solid.dispose();
    const shared = inputs({
      modelVolumeMm3: volume,
      boundsMm: { x: 100, y: 100, z: 2 },
    });

    // Perimeter-aware reference from ANALYTIC geometry (nothing measured):
    // the plate is 10 layers of a 400mm outline around a 10,000mm² section.
    // 3 walls at 45mm/s; 8 of the 10 layers are solid skin (4 top + 4
    // bottom) inside the wall band; the remaining 2 layers print at 20%
    // infill; plus per-layer overhead. Same constants — independent
    // geometry, so it verifies both the slice MEASUREMENT and the model.
    const C = SLICED_ESTIMATE_CONSTANTS;
    const lineWidth = 0.4 * 1.15;
    const ribbon = C.wallCount * lineWidth;
    const flow = C.infillSpeedMmS * lineWidth * 0.2;
    const perimeterS = (10 * 400 * C.wallCount) / C.perimeterSpeedMmS;
    const wallVolume = 10 * 400 * ribbon * 0.2;
    const skinVolume = (10_000 - 400 * ribbon) * 8 * 0.2;
    const interiorVolume = Math.max(0, volume - wallVolume - skinVolume);
    const fillS = (skinVolume + interiorVolume * 0.2) / flow;
    const travelS = 10 * C.layerOverheadS + 10 * C.islandOverheadS;
    const referenceMinutes = (perimeterS + fillS + travelS) / 60;

    const oldModel = estimateDetailed(shared);
    const newModel = estimateFromSlices(shared, metrics);
    const mid = (r: { time: { printMinutesMin: number; printMinutesMax: number } }) =>
      (r.time.printMinutesMin + r.time.printMinutesMax) / 2;

    expect(Math.abs(mid(newModel) - referenceMinutes)).toBeLessThan(
      Math.abs(mid(oldModel) - referenceMinutes)
    );
    // And the breakdown is exposed for the UI, in Hebrew.
    expect(newModel.componentsHe.map((c) => c.labelHe)).toContain("קווי מתאר (היקפים)");
    expect(newModel.componentsHe.length).toBe(3);
  });

  it("SLA: lift time follows the cross-section (old model was blind to it)", () => {
    const disc = kernel.cylinder(40, 20, 128);
    const discMetrics = measureSliceMetrics(disc, 0.05);
    const discVolume = disc.volumeMm3();
    disc.dispose();

    const ringOuter = kernel.cylinder(40, 20, 128);
    const ringInner = kernel.cylinder(36, 22, 128).translate(0, 0, -1);
    const ring = ringOuter.subtract(ringInner);
    const ringMetrics = measureSliceMetrics(ring, 0.05);
    const ringVolume = ring.volumeMm3();
    ring.dispose();

    const discInputs = inputs({
      technology: "sla",
      layerHeightMm: 0.05,
      modelVolumeMm3: discVolume,
      boundsMm: { x: 80, y: 80, z: 20 },
    });
    const ringInputs = { ...discInputs, modelVolumeMm3: ringVolume };

    // Old model: identical print time for both (same height, fixed s/layer).
    const oldDisc = estimateDetailed(discInputs);
    const oldRing = estimateDetailed(ringInputs);
    expect(oldDisc.time.printMinutesMax).toBe(oldRing.time.printMinutesMax);

    // New model: the thin ring peels faster than the full disc.
    const newDisc = estimateFromSlices(discInputs, discMetrics);
    const newRing = estimateFromSlices(ringInputs, ringMetrics);
    expect(newRing.time.printMinutesMax).toBeLessThan(newDisc.time.printMinutesMax);
    expect(newDisc.componentsHe.map((c) => c.labelHe)).toContain(
      "הרמות ופילינג (לפי שטח חתך)"
    );
  });

  it("merging metrics of two parts sums geometry and keeps max layer count", () => {
    const a = kernel.box(10, 10, 10, false);
    const b = kernel.box(10, 10, 20, false);
    const ma = measureSliceMetrics(a, 0.2);
    const mb = measureSliceMetrics(b, 0.2);
    a.dispose();
    b.dispose();
    const merged = mergeSliceMetrics([ma, mb])!;
    expect(merged.layerCount).toBe(100);
    expect(merged.totalPerimeterMm).toBeCloseTo(
      ma.totalPerimeterMm + mb.totalPerimeterMm,
      6
    );
  });
});
