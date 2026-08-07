/**
 * Wave C printing corrections: calibration, supports, bridging, thread
 * chamfer and fit class, and the lattice nozzle check.
 *
 * These assert the printing CONSEQUENCE, not just that a function returned:
 * a compensated hole must actually be bigger, a support must actually reach
 * the overhang above it, and a bridge over open air must actually be found.
 */

import { describe, expect, it } from "vitest";
import {
  clearanceForFit,
  compensatedHoleDiameterMm,
  DEFAULT_CALIBRATION,
  describeCalibration,
  elephantFootInsetAtHeight,
  type CalibrationSettings,
} from "../calibration";
import { getGeometryKernel } from "../kernel";
import type { MeshData } from "../meshData";
import { analyzeBridging, buildSupports, findSupportPoints, DEFAULT_SUPPORT_SETTINGS } from "../analysis/supports";
import { buildThread, THREAD_FIT_MULTIPLIER } from "../generators";
import { latticeFill } from "../operations/lattice";
import { buildDocument } from "../buildDocument";
import {
  defaultPrimitive,
  identityTransform,
  type DesignDocument,
  type DesignLayer,
} from "@/types/design";

describe("calibration", () => {
  const calibration: CalibrationSettings = {
    measuredClearanceMm: 0.3,
    holeCompensationMm: 0.25,
    elephantFootCompensationMm: 0.2,
    elephantFootHeightMm: 0.6,
  };

  it("derives every fit from the one measured value", () => {
    expect(clearanceForFit(calibration, "sliding")).toBeCloseTo(0.3, 6);
    expect(clearanceForFit(calibration, "close")).toBeCloseTo(0.15, 6);
    // A press fit is an interference: the parts must overlap.
    expect(clearanceForFit(calibration, "press")).toBeLessThan(0);
  });

  it("scales every fit together when the measurement changes", () => {
    const looser = { ...calibration, measuredClearanceMm: 0.6 };
    expect(clearanceForFit(looser, "sliding")).toBeCloseTo(
      clearanceForFit(calibration, "sliding") * 2,
      6
    );
    expect(clearanceForFit(looser, "close")).toBeCloseTo(
      clearanceForFit(calibration, "close") * 2,
      6
    );
  });

  it("enlarges a modelled hole so the printed one matches nominal", () => {
    // The whole point: a 5mm hole must be MODELLED larger than 5mm.
    expect(compensatedHoleDiameterMm(calibration, 5)).toBeCloseTo(5.25, 6);
    expect(compensatedHoleDiameterMm(calibration, 5)).toBeGreaterThan(5);
  });

  it("never produces a non-positive diameter", () => {
    const negative = { ...calibration, holeCompensationMm: -10 };
    expect(compensatedHoleDiameterMm(negative, 1)).toBeGreaterThan(0);
  });

  it("fades the elephant-foot inset out with height", () => {
    expect(elephantFootInsetAtHeight(calibration, 0)).toBeCloseTo(0.2, 6);
    expect(elephantFootInsetAtHeight(calibration, 0.3)).toBeCloseTo(0.1, 6);
    expect(elephantFootInsetAtHeight(calibration, 0.6)).toBe(0);
    expect(elephantFootInsetAtHeight(calibration, 10)).toBe(0);
  });

  it("is inert when compensation is off", () => {
    expect(elephantFootInsetAtHeight(DEFAULT_CALIBRATION, 0)).toBe(0);
  });

  it("describes itself in Hebrew", () => {
    expect(describeCalibration(calibration)).toMatch(/[֐-׿]/);
    expect(describeCalibration(calibration)).toContain("0.3");
  });
});

/** A flat slab held up on two legs — a classic bridge and overhang case. */
async function bridgeShape(): Promise<MeshData> {
  const kernel = await getGeometryKernel();
  const legA = kernel.box(6, 10, 20, true).translate(-20, 0, 10);
  const legB = kernel.box(6, 10, 20, true).translate(20, 0, 10);
  const deck = kernel.box(46, 10, 4, true).translate(0, 0, 22);
  const solid = legA.union(legB).union(deck);
  const mesh = solid.toMeshData();
  solid.dispose();
  return mesh;
}

describe("support generation", () => {
  it("finds the unsupported underside of a bridge deck", async () => {
    const mesh = await bridgeShape();
    const points = findSupportPoints(mesh, DEFAULT_SUPPORT_SETTINGS);
    expect(points.length).toBeGreaterThan(0);
    // Every contact point sits under the deck (deck underside is at z = 20).
    for (const p of points) {
      expect(p.top.z).toBeGreaterThan(15);
      expect(p.heightMm).toBeGreaterThan(0);
    }
  });

  it("does not support a shape that rests flat on the plate", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(20, 20, 20, true).translate(0, 0, 10);
    const mesh = box.toMeshData();
    box.dispose();
    // A cube's only downward face is its bottom, which is on the plate.
    expect(findSupportPoints(mesh, DEFAULT_SUPPORT_SETTINGS)).toHaveLength(0);
  });

  it("builds pillars that reach from the plate to the overhang", async () => {
    const kernel = await getGeometryKernel();
    const mesh = await bridgeShape();
    const { solid, result } = buildSupports(kernel, mesh, DEFAULT_SUPPORT_SETTINGS);
    expect(solid).not.toBeNull();
    expect(result.pillars.length).toBeGreaterThan(0);
    expect(result.volumeMm3).toBeGreaterThan(0);

    const bounds = (solid as NonNullable<typeof solid>).boundingBox();
    // Supports start at the plate...
    expect(bounds.min.z).toBeCloseTo(0, 1);
    // ...and stop just short of the deck underside at z = 20.
    expect(bounds.max.z).toBeGreaterThan(15);
    expect(bounds.max.z).toBeLessThanOrEqual(20.01);
    (solid as NonNullable<typeof solid>).dispose();
  });

  it("tapers from a wide base to a narrow tip", async () => {
    const kernel = await getGeometryKernel();
    const mesh = await bridgeShape();
    const { solid } = buildSupports(kernel, mesh, {
      ...DEFAULT_SUPPORT_SETTINGS,
      spacingMm: 20,
      tipDiameterMm: 0.6,
      baseDiameterMm: 4,
    });
    expect(solid).not.toBeNull();
    const s = solid as NonNullable<typeof solid>;
    // A cone from r=2 to r=0.3 has far less volume than a straight r=2 pillar.
    const straightVolume = Math.PI * 4 * 20;
    expect(s.volumeMm3()).toBeLessThan(straightVolume);
    s.dispose();
  });

  it("reports honestly when nothing needs support", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(20, 20, 20, true).translate(0, 0, 10);
    const mesh = box.toMeshData();
    box.dispose();
    const { solid, result } = buildSupports(kernel, mesh, DEFAULT_SUPPORT_SETTINGS);
    expect(solid).toBeNull();
    expect(result.summaryHe).toContain("לא נמצאו");
  });

  it("caps the pillar count and says how many it dropped", async () => {
    const kernel = await getGeometryKernel();
    const mesh = await bridgeShape();
    const { solid, result } = buildSupports(kernel, mesh, {
      ...DEFAULT_SUPPORT_SETTINGS,
      spacingMm: 1,
      maxPillars: 3,
    });
    expect(result.pillars.length).toBeLessThanOrEqual(3);
    if (result.skipped > 0) expect(result.summaryHe).toContain("דולגו");
    solid?.dispose();
  });
});

/** A table top on four corner legs: unsupported in BOTH directions. */
async function tableShape(): Promise<MeshData> {
  const kernel = await getGeometryKernel();
  const leg = (x: number, y: number) =>
    kernel.box(6, 6, 20, true).translate(x, y, 10);
  const top = kernel.box(60, 60, 4, true).translate(0, 0, 22);
  const solid = leg(-25, -25)
    .union(leg(25, -25))
    .union(leg(-25, 25))
    .union(leg(25, 25))
    .union(top);
  const mesh = solid.toMeshData();
  solid.dispose();
  return mesh;
}

describe("bridging analysis", () => {
  it("reports the SHORT direction of an unsupported region", async () => {
    // The deck is 46mm between legs but only 10mm wide. A printer bridges
    // across the shorter direction, so 10mm — not 46 — is the number that
    // decides whether it prints. Reporting the long direction would condemn
    // a perfectly printable part.
    const mesh = await bridgeShape();
    const report = analyzeBridging(mesh, { minSpanMm: 5 });
    expect(report.spans.length).toBeGreaterThan(0);
    expect(report.longestMm).toBeGreaterThan(5);
    expect(report.longestMm).toBeLessThan(14);
    expect(report.summaryHe).toContain("גישור");
  });

  it("warns that a genuinely long bridge will probably fail", async () => {
    // A 60mm table top on corner legs is unsupported far in both directions,
    // so there is no short way across and it really will sag.
    const mesh = await tableShape();
    const report = analyzeBridging(mesh, { minSpanMm: 5 });
    expect(report.longestMm).toBeGreaterThan(20);
    expect(report.summaryHe).toContain("ייכשל");
  });

  it("describes a modest bridge as a sag rather than a failure", async () => {
    const mesh = await bridgeShape();
    const report = analyzeBridging(mesh, { minSpanMm: 5 });
    expect(report.summaryHe).toContain("שקע");
  });

  it("finds nothing on a solid block", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(30, 30, 30, true).translate(0, 0, 15);
    const mesh = box.toMeshData();
    box.dispose();
    const report = analyzeBridging(mesh);
    expect(report.spans).toHaveLength(0);
    expect(report.longestMm).toBe(0);
  });
});

describe("thread fit class and chamfer", () => {
  const base = {
    diameterMm: 10,
    pitchMm: 1.5,
    lengthMm: 12,
    clearanceMm: 0.4,
    segments: 32,
  };

  it("makes a looser class produce a wider nut cutter", async () => {
    const kernel = await getGeometryKernel();
    const tight = buildThread(kernel, { ...base, internal: true, fitClass: "tight" });
    const loose = buildThread(kernel, { ...base, internal: true, fitClass: "loose" });
    expect(loose.boundingBox().max.x).toBeGreaterThan(tight.boundingBox().max.x);
    expect(THREAD_FIT_MULTIPLIER.loose).toBeGreaterThan(THREAD_FIT_MULTIPLIER.tight);
    tight.dispose();
    loose.dispose();
  });

  it("fit class does not affect an external thread", async () => {
    const kernel = await getGeometryKernel();
    const a = buildThread(kernel, { ...base, internal: false, fitClass: "tight" });
    const b = buildThread(kernel, { ...base, internal: false, fitClass: "loose" });
    // A bolt is the reference; only the nut moves to create the fit.
    expect(a.volumeMm3()).toBeCloseTo(b.volumeMm3(), 3);
    a.dispose();
    b.dispose();
  });

  it("chamfers a bolt's ends, removing material", async () => {
    const kernel = await getGeometryKernel();
    const plain = buildThread(kernel, { ...base, internal: false, chamferMm: 0 });
    const chamfered = buildThread(kernel, { ...base, internal: false, chamferMm: 1 });
    expect(chamfered.volumeMm3()).toBeLessThan(plain.volumeMm3());
    expect(chamfered.status()).toBe("NoError");
    // The overall length is untouched; only the end crests are cut back.
    expect(chamfered.boundingBox().max.z).toBeCloseTo(plain.boundingBox().max.z, 1);
    plain.dispose();
    chamfered.dispose();
  });

  it("flares a nut cutter's ends, adding material", async () => {
    const kernel = await getGeometryKernel();
    const plain = buildThread(kernel, { ...base, internal: true, chamferMm: 0 });
    const flared = buildThread(kernel, { ...base, internal: true, chamferMm: 1 });
    // The cutter grows so the carved nut gets a funnel at each end.
    expect(flared.volumeMm3()).toBeGreaterThan(plain.volumeMm3());
    expect(flared.status()).toBe("NoError");
    plain.dispose();
    flared.dispose();
  });

  it("a chamfered bolt still threads into its matching nut", async () => {
    const kernel = await getGeometryKernel();
    const bolt = buildThread(kernel, {
      ...base, internal: false, chamferMm: 0.8,
    });
    const cutter = buildThread(kernel, {
      ...base, internal: true, chamferMm: 0.8, fitClass: "normal",
    });
    const blank = kernel.cylinder(9, 12, 64);
    const nut = blank.subtract(cutter);
    expect(nut.status()).toBe("NoError");
    // The bolt must fit inside the nut's bore without interference: their
    // intersection should be a small fraction of the bolt.
    const boltVolume = bolt.volumeMm3();
    const overlap = bolt.intersect(nut);
    expect(overlap.volumeMm3()).toBeLessThan(boltVolume * 0.35);
    overlap.dispose();
  });
});

describe("lattice nozzle check", () => {
  it("warns when struts are thinner than two extrusion widths", async () => {
    const kernel = await getGeometryKernel();
    const cube = kernel.box(30, 30, 30, true).translate(0, 0, 15);
    const result = latticeFill(kernel, cube, {
      kind: "gyroid",
      cellSizeMm: 8,
      thicknessMm: 0.5,
      shellThicknessMm: 1.5,
      nozzleDiameterMm: 0.4,
    });
    expect(result.warningsHe.some((w) => w.includes("קוטר הפיה"))).toBe(true);
    result.solid.dispose();
  });

  it("stays quiet when the struts are printable", async () => {
    const kernel = await getGeometryKernel();
    const cube = kernel.box(30, 30, 30, true).translate(0, 0, 15);
    const result = latticeFill(kernel, cube, {
      kind: "gyroid",
      cellSizeMm: 8,
      thicknessMm: 1.2,
      shellThicknessMm: 1.5,
      nozzleDiameterMm: 0.4,
    });
    expect(result.warningsHe.some((w) => w.includes("קוטר הפיה"))).toBe(false);
    result.solid.dispose();
  });

  it("skips the check when no nozzle is supplied", async () => {
    const kernel = await getGeometryKernel();
    const cube = kernel.box(30, 30, 30, true).translate(0, 0, 15);
    const result = latticeFill(kernel, cube, {
      kind: "gyroid",
      cellSizeMm: 8,
      thicknessMm: 0.3,
      shellThicknessMm: 1.5,
    });
    expect(result.warningsHe.some((w) => w.includes("קוטר הפיה"))).toBe(false);
    result.solid.dispose();
  });
});

describe("calibration in the build pipeline", () => {
  function baseDoc(calibration?: CalibrationSettings): DesignDocument {
    return {
      schemaVersion: 3,
      baseMode: "baseless",
      layers: [],
      materialSlots: [{ id: "slot1", nameHe: "חומר", colorHex: "#888888" }],
      printerProfileId: "genericFdm220",
      printabilityProfileId: "fdmPla",
      customPrintability: null,
      usageProfileId: null,
      templateId: null,
      calibration,
    };
  }

  function boxLayer(): DesignLayer {
    return {
      id: "box",
      type: "primitive",
      name: "תיבה",
      visible: true,
      locked: false,
      materialSlotId: "slot1",
      transform: identityTransform(),
      previewOpacity: 1,
      ...defaultPrimitive("box"),
      widthMm: 20,
      depthMm: 20,
      heightMm: 20,
    } as DesignLayer;
  }

  function holeLayer(diameterMm: number): DesignLayer {
    return {
      id: "hole",
      type: "hole",
      name: "חור",
      visible: true,
      locked: false,
      materialSlotId: "slot1",
      transform: identityTransform(),
      previewOpacity: 1,
      diameterMm,
      depthMode: "through",
      depthMm: 30,
    } as DesignLayer;
  }

  it("enlarges a modelled hole so the printed one matches nominal", async () => {
    const uncompensated = await buildDocument({
      ...baseDoc(),
      layers: [boxLayer(), holeLayer(6)],
    });
    const compensated = await buildDocument({
      ...baseDoc({
        measuredClearanceMm: 0.2,
        holeCompensationMm: 0.4,
        elephantFootCompensationMm: 0,
        elephantFootHeightMm: 0.6,
      }),
      layers: [boxLayer(), holeLayer(6)],
    });
    expect(uncompensated.status).toBe("ok");
    expect(compensated.status).toBe("ok");
    // A bigger hole removes more material, so the part weighs less.
    const plain = uncompensated.parts[0].stats.volumeMm3;
    const fixed = compensated.parts[0].stats.volumeMm3;
    expect(fixed).toBeLessThan(plain);
    // The extra removal is the difference between a 6mm and a 6.4mm bore.
    const expectedDelta = Math.PI * (3.2 ** 2 - 3 ** 2) * 20;
    expect(plain - fixed).toBeGreaterThan(expectedDelta * 0.85);
    expect(plain - fixed).toBeLessThan(expectedDelta * 1.15);
  });

  it("shrinks the base of a part when elephant-foot compensation is on", async () => {
    const plain = await buildDocument({ ...baseDoc(), layers: [boxLayer()] });
    const fixed = await buildDocument({
      ...baseDoc({
        measuredClearanceMm: 0.2,
        holeCompensationMm: 0,
        elephantFootCompensationMm: 0.4,
        elephantFootHeightMm: 0.8,
      }),
      layers: [boxLayer()],
    });
    expect(fixed.status).toBe("ok");
    // Material is removed only near the bed, so the part gets slightly
    // lighter without changing its overall height.
    expect(fixed.parts[0].stats.volumeMm3).toBeLessThan(plain.parts[0].stats.volumeMm3);
    expect(fixed.parts[0].stats.dimensionsMm.z).toBeCloseTo(
      plain.parts[0].stats.dimensionsMm.z,
      1
    );
  });

  it("leaves geometry untouched when calibration is absent", async () => {
    const a = await buildDocument({ ...baseDoc(), layers: [boxLayer()] });
    const b = await buildDocument({
      ...baseDoc({
        measuredClearanceMm: 0.2,
        holeCompensationMm: 0,
        elephantFootCompensationMm: 0,
        elephantFootHeightMm: 0.6,
      }),
      layers: [boxLayer()],
    });
    expect(b.parts[0].stats.volumeMm3).toBeCloseTo(a.parts[0].stats.volumeMm3, 3);
  });
});
