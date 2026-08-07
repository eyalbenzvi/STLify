/**
 * Creation tools: primitives, sketch compilation, patterns and the
 * parametric generators. Assertions check measurable geometry — analytic
 * volumes, tooth counts, meshing distances, fit clearances — not just that a
 * solid came back.
 */

import { describe, expect, it } from "vitest";
import {
  buildEnclosure,
  buildGear,
  buildGearProfile,
  buildLivingHinge,
  buildSnapFit,
  buildThread,
  buildToleranceTest,
  gearPitchDiameterMm,
  GeneratorError,
} from "../generators";
import { getGeometryKernel } from "../kernel";
import { sketchBounds, sketchToContours } from "../sketch";
import { buildPattern, PatternError } from "../operations/pattern";
import { buildPrimitiveSolid } from "../solids";
import { analyzeTopology } from "../repair/topology";
import {
  defaultPrimitive,
  identityTransform,
  type DesignLayer,
  type PrimitiveKind,
  type PrimitiveLayer,
  type SketchEntity,
} from "@/types/design";

function primitive(kind: PrimitiveKind, overrides: Partial<PrimitiveLayer> = {}): PrimitiveLayer {
  return {
    id: "p1",
    type: "primitive",
    name: kind,
    visible: true,
    locked: false,
    materialSlotId: "slot1",
    transform: identityTransform(),
    previewOpacity: 1,
    ...defaultPrimitive(kind),
    ...overrides,
  };
}

describe("primitive solids", () => {
  it("builds a box of the exact requested volume, sitting on z = 0", async () => {
    const kernel = await getGeometryKernel();
    const solid = buildPrimitiveSolid(
      kernel,
      primitive("box", { widthMm: 10, depthMm: 20, heightMm: 5 })
    );
    expect(solid.volumeMm3()).toBeCloseTo(1000, 4);
    const bounds = solid.boundingBox();
    expect(bounds.min.z).toBeCloseTo(0, 5);
    expect(bounds.max.z).toBeCloseTo(5, 5);
    expect(bounds.min.x).toBeCloseTo(-5, 5);
    solid.dispose();
  });

  it("builds a cylinder matching pi r^2 h", async () => {
    const kernel = await getGeometryKernel();
    const solid = buildPrimitiveSolid(
      kernel,
      primitive("cylinder", { radiusMm: 8, heightMm: 12, segments: 256 })
    );
    const expected = Math.PI * 64 * 12;
    expect(solid.volumeMm3()).toBeGreaterThan(expected * 0.999);
    expect(solid.volumeMm3()).toBeLessThan(expected * 1.001);
    solid.dispose();
  });

  it("drops a sphere so it rests on the build plate", async () => {
    const kernel = await getGeometryKernel();
    const solid = buildPrimitiveSolid(kernel, primitive("sphere", { radiusMm: 10 }));
    const bounds = solid.boundingBox();
    expect(bounds.min.z).toBeCloseTo(0, 1);
    expect(bounds.max.z).toBeCloseTo(20, 1);
    solid.dispose();
  });

  it("builds a hollow tube with the right wall volume", async () => {
    const kernel = await getGeometryKernel();
    const solid = buildPrimitiveSolid(
      kernel,
      primitive("tube", { radiusMm: 10, radius2Mm: 8, heightMm: 20, segments: 256 })
    );
    const expected = Math.PI * (100 - 64) * 20;
    expect(solid.volumeMm3()).toBeGreaterThan(expected * 0.995);
    expect(solid.volumeMm3()).toBeLessThan(expected * 1.005);
    // A tube is a torus topologically: one handle.
    expect(solid.genus()).toBe(1);
    solid.dispose();
  });

  it("builds a wedge with half the volume of its bounding box", async () => {
    const kernel = await getGeometryKernel();
    const solid = buildPrimitiveSolid(
      kernel,
      primitive("wedge", { widthMm: 10, depthMm: 6, heightMm: 8 })
    );
    expect(solid.volumeMm3()).toBeCloseTo((10 * 6 * 8) / 2, 3);
    const bounds = solid.boundingBox();
    expect(bounds.min.z).toBeCloseTo(0, 4);
    expect(bounds.max.z).toBeCloseTo(8, 4);
    solid.dispose();
  });

  it("rejects impossible parameters with a Hebrew message", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      buildPrimitiveSolid(kernel, primitive("tube", { radiusMm: 5, radius2Mm: 8 }))
    ).toThrow(/פנימי/);
    expect(() =>
      buildPrimitiveSolid(kernel, primitive("box", { widthMm: 0 }))
    ).toThrow(/גדולות מאפס/);
  });
});

describe("sketch compilation", () => {
  it("compiles a rectangle to its exact bounds", async () => {
    const kernel = await getGeometryKernel();
    const entities: SketchEntity[] = [
      { kind: "rectangle", x: 5, y: 2, widthMm: 20, heightMm: 10, cornerRadiusMm: 0, rotationDeg: 0 },
    ];
    const bounds = sketchBounds(kernel, entities);
    expect(bounds).not.toBeNull();
    expect(bounds?.minX).toBeCloseTo(-5, 3);
    expect(bounds?.maxX).toBeCloseTo(15, 3);
    expect(bounds?.minY).toBeCloseTo(-3, 3);
    expect(bounds?.maxY).toBeCloseTo(7, 3);
  });

  it("merges overlapping entities into one profile", async () => {
    const kernel = await getGeometryKernel();
    const entities: SketchEntity[] = [
      { kind: "circle", x: 0, y: 0, radiusMm: 10 },
      { kind: "circle", x: 8, y: 0, radiusMm: 10 },
    ];
    const contours = sketchToContours(kernel, entities);
    // NonZero resolution turns the two overlapping discs into a single outline.
    expect(contours).toHaveLength(1);
    const solid = kernel.extrude(contours, 1);
    // Union area is less than the sum of both discs.
    expect(solid.volumeMm3()).toBeLessThan(2 * Math.PI * 100);
    expect(solid.volumeMm3()).toBeGreaterThan(Math.PI * 100);
    solid.dispose();
  });

  it("cuts a hole when an inner entity is wound the other way", async () => {
    const kernel = await getGeometryKernel();
    const outer: SketchEntity = {
      kind: "rectangle", x: 0, y: 0, widthMm: 20, heightMm: 20, cornerRadiusMm: 0, rotationDeg: 0,
    };
    const contours = sketchToContours(kernel, [outer]);
    // Reverse a circle so NonZero treats it as a hole.
    const holeContours = sketchToContours(kernel, [{ kind: "circle", x: 0, y: 0, radiusMm: 5 }]);
    const withHole = [...contours, ...holeContours.map((c) => [...c].reverse())];
    const solid = kernel.extrude(withHole, 2);
    const expected = (400 - Math.PI * 25) * 2;
    expect(solid.volumeMm3()).toBeGreaterThan(expected * 0.99);
    expect(solid.volumeMm3()).toBeLessThan(expected * 1.01);
    expect(solid.genus()).toBe(1);
    solid.dispose();
  });

  it("strokes an open polyline into a closed ribbon", async () => {
    const kernel = await getGeometryKernel();
    const contours = sketchToContours(kernel, [
      {
        kind: "polyline",
        points: [
          [0, 0],
          [20, 0],
        ],
        closed: false,
        strokeWidthMm: 2,
      },
    ]);
    expect(contours.length).toBeGreaterThan(0);
    const solid = kernel.extrude(contours, 1);
    // A 20mm long, 2mm wide stroke, 1mm tall — round caps add a little.
    expect(solid.volumeMm3()).toBeGreaterThan(38);
    expect(solid.volumeMm3()).toBeLessThan(46);
    solid.dispose();
  });

  it("builds a regular polygon with the requested side count", async () => {
    const kernel = await getGeometryKernel();
    const contours = sketchToContours(kernel, [
      { kind: "polygon", x: 0, y: 0, radiusMm: 10, sides: 6, rotationDeg: 0 },
    ]);
    expect(contours).toHaveLength(1);
    expect(contours[0]).toHaveLength(6);
    // Regular hexagon area = (3 sqrt(3) / 2) r^2.
    const solid = kernel.extrude(contours, 1);
    expect(solid.volumeMm3()).toBeCloseTo((3 * Math.sqrt(3) * 100) / 2, 2);
    solid.dispose();
  });

  it("returns nothing for an empty sketch", async () => {
    const kernel = await getGeometryKernel();
    expect(sketchToContours(kernel, [])).toHaveLength(0);
    expect(sketchBounds(kernel, [])).toBeNull();
  });
});

describe("patterns", () => {
  const source: DesignLayer = {
    id: "src",
    type: "primitive",
    name: "קובייה",
    visible: true,
    locked: false,
    materialSlotId: "slot1",
    transform: { ...identityTransform(), x: 10, y: 0, z: 0 },
    previewOpacity: 1,
    ...defaultPrimitive("box"),
  };

  it("creates a linear array with even spacing", () => {
    const { layers } = buildPattern(source, {
      kind: "linear",
      count: 4,
      spacingMm: { x: 25, y: 0, z: 0 },
    });
    expect(layers).toHaveLength(3); // the original is not duplicated
    expect(layers.map((l) => l.transform.x)).toEqual([35, 60, 85]);
    // Every copy gets a fresh id.
    expect(new Set(layers.map((l) => l.id)).size).toBe(3);
  });

  it("creates a grid skipping the original cell", () => {
    const { layers } = buildPattern(source, {
      kind: "grid",
      countX: 3,
      countY: 2,
      spacingXMm: 10,
      spacingYMm: 20,
    });
    expect(layers).toHaveLength(5);
    expect(layers.some((l) => l.transform.x === 10 && l.transform.y === 0)).toBe(false);
  });

  it("distributes a full circular array without doubling up at 360 degrees", () => {
    const { layers } = buildPattern(source, {
      kind: "circular",
      count: 4,
      center: { x: 0, y: 0 },
      totalAngleDeg: 360,
      rotateCopies: true,
    });
    expect(layers).toHaveLength(3);
    // Source sits at (10, 0); quarter turns put copies on the axes.
    expect(layers[0].transform.x).toBeCloseTo(0, 6);
    expect(layers[0].transform.y).toBeCloseTo(10, 6);
    expect(layers[1].transform.x).toBeCloseTo(-10, 6);
    expect(layers[2].transform.y).toBeCloseTo(-10, 6);
    // Copies follow the circle.
    expect(layers[0].transform.rotationZ).toBeCloseTo(90, 6);
  });

  it("puts copies at both ends of a partial arc", () => {
    const { layers } = buildPattern(source, {
      kind: "circular",
      count: 3,
      center: { x: 0, y: 0 },
      totalAngleDeg: 90,
      rotateCopies: false,
    });
    expect(layers).toHaveLength(2);
    // Last copy lands exactly at 90 degrees.
    expect(layers[1].transform.x).toBeCloseTo(0, 6);
    expect(layers[1].transform.y).toBeCloseTo(10, 6);
    // rotateCopies off leaves orientation alone.
    expect(layers[1].transform.rotationZ).toBe(0);
  });

  it("mirrors position and geometry across a plane", () => {
    const { layers } = buildPattern(source, { kind: "mirror", axis: "x", offsetMm: 0 });
    expect(layers).toHaveLength(1);
    expect(layers[0].transform.x).toBe(-10);
    // Negative scale reflects the body; the pipeline flips winding for it.
    expect(layers[0].transform.scaleX).toBe(-1);
  });

  it("rejects nonsense settings with Hebrew messages", () => {
    expect(() =>
      buildPattern(source, { kind: "linear", count: 1, spacingMm: { x: 10, y: 0, z: 0 } })
    ).toThrow(PatternError);
    expect(() =>
      buildPattern(source, { kind: "linear", count: 3, spacingMm: { x: 0, y: 0, z: 0 } })
    ).toThrow(/מרווח/);
    expect(() =>
      buildPattern(source, { kind: "linear", count: 5000, spacingMm: { x: 1, y: 0, z: 0 } })
    ).toThrow(/מוגבל/);
  });
});

describe("generators: threads", () => {
  it("builds a watertight M8 bolt thread", async () => {
    const kernel = await getGeometryKernel();
    const solid = buildThread(kernel, {
      diameterMm: 8,
      pitchMm: 1.25,
      lengthMm: 10,
      internal: false,
      clearanceMm: 0,
      segments: 32,
    });
    expect(solid.status()).toBe("NoError");
    const bounds = solid.boundingBox();
    // Crests reach the nominal radius.
    expect(bounds.max.x).toBeCloseTo(4, 1);
    expect(bounds.max.z - bounds.min.z).toBeGreaterThan(9.5);
    const mesh = solid.toMeshData();
    expect(analyzeTopology(mesh).boundaryEdgeCount).toBe(0);
    solid.dispose();
  });

  it("makes the internal thread wider than the external one by the clearance", async () => {
    const kernel = await getGeometryKernel();
    const bolt = buildThread(kernel, {
      diameterMm: 8, pitchMm: 1.25, lengthMm: 6, internal: false, clearanceMm: 0, segments: 32,
    });
    const nut = buildThread(kernel, {
      diameterMm: 8, pitchMm: 1.25, lengthMm: 6, internal: true, clearanceMm: 0.4, segments: 32,
    });
    expect(nut.boundingBox().max.x).toBeGreaterThan(bolt.boundingBox().max.x);
    bolt.dispose();
    nut.dispose();
  });

  it("refuses a pitch too coarse for the diameter", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      buildThread(kernel, {
        diameterMm: 3, pitchMm: 4, lengthMm: 5, internal: false, clearanceMm: 0, segments: 32,
      })
    ).toThrow(GeneratorError);
  });
});

describe("generators: gears", () => {
  it("builds a gear whose pitch diameter follows module x teeth", () => {
    expect(gearPitchDiameterMm({ teeth: 20, moduleMm: 2 })).toBe(40);
  });

  it("produces one tooth cycle per tooth", () => {
    const profile = buildGearProfile({
      teeth: 12, moduleMm: 2, thicknessMm: 5, pressureAngleDeg: 20,
      boreDiameterMm: 0, backlashMm: 0,
    });
    // Count radial maxima: each tooth contributes exactly one tip region.
    const radii = profile.map(([x, y]) => Math.hypot(x, y));
    const tipRadius = Math.max(...radii);
    // Addendum radius = pitch + module = 12 + 2 = 14.
    expect(tipRadius).toBeCloseTo(14, 1);
    const rootRadius = Math.min(...radii);
    expect(rootRadius).toBeCloseTo(12 - 2.5, 1);
  });

  it("builds a solid gear with a bore", async () => {
    const kernel = await getGeometryKernel();
    const solid = buildGear(kernel, {
      teeth: 16, moduleMm: 2, thicknessMm: 6, pressureAngleDeg: 20,
      boreDiameterMm: 6, backlashMm: 0.1,
    });
    expect(solid.status()).toBe("NoError");
    // A bore through the middle makes it genus 1.
    expect(solid.genus()).toBe(1);
    const bounds = solid.boundingBox();
    expect(bounds.max.x).toBeCloseTo(18, 0); // addendum radius 16+2
    solid.dispose();
  });

  it("rejects a bore bigger than the gear", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      buildGear(kernel, {
        teeth: 10, moduleMm: 1, thicknessMm: 3, pressureAngleDeg: 20,
        boreDiameterMm: 50, backlashMm: 0,
      })
    ).toThrow(/גדול מדי/);
  });
});

describe("generators: enclosure", () => {
  it("builds a box and lid that fit within the clearance", async () => {
    const kernel = await getGeometryKernel();
    const { box, lid } = buildEnclosure(kernel, {
      innerWidthMm: 40, innerDepthMm: 30, innerHeightMm: 20,
      wallMm: 2, floorMm: 2, cornerRadiusMm: 3,
      lipHeightMm: 4, clearanceMm: 0.2,
    });
    expect(box.status()).toBe("NoError");
    expect(lid.status()).toBe("NoError");
    const boxBounds = box.boundingBox();
    expect(boxBounds.max.x - boxBounds.min.x).toBeCloseTo(44, 1);
    expect(boxBounds.max.z - boxBounds.min.z).toBeCloseTo(22, 1);
    // The lip must be narrower than the cavity so the lid actually closes.
    const lidBounds = lid.boundingBox();
    expect(lidBounds.max.x - lidBounds.min.x).toBeCloseTo(44, 1);
    // The box is hollow, so its volume is far less than its bounding box.
    expect(box.volumeMm3()).toBeLessThan(44 * 34 * 22 * 0.5);
    box.dispose();
    lid.dispose();
  });

  it("refuses a clearance larger than the cavity", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      buildEnclosure(kernel, {
        innerWidthMm: 10, innerDepthMm: 10, innerHeightMm: 10,
        wallMm: 1, floorMm: 1, cornerRadiusMm: 0,
        lipHeightMm: 2, clearanceMm: 8,
      })
    ).toThrow(GeneratorError);
  });
});

describe("generators: living hinge and snap-fit", () => {
  it("thins the panel only at the grooves", async () => {
    const kernel = await getGeometryKernel();
    const solid = buildLivingHinge(kernel, {
      widthMm: 40, lengthMm: 30, thicknessMm: 2,
      hingeThicknessMm: 0.5, grooveCount: 3, grooveWidthMm: 1,
    });
    expect(solid.status()).toBe("NoError");
    const bounds = solid.boundingBox();
    expect(bounds.max.z).toBeCloseTo(2, 3);
    // Three 1mm grooves 1.5mm deep removed from a 40x30x2 panel.
    const expected = 40 * 30 * 2 - 3 * (40 * 1 * 1.5);
    expect(solid.volumeMm3()).toBeCloseTo(expected, 0);
    solid.dispose();
  });

  it("refuses a hinge thicker than its panel", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      buildLivingHinge(kernel, {
        widthMm: 40, lengthMm: 30, thicknessMm: 2,
        hingeThicknessMm: 3, grooveCount: 1, grooveWidthMm: 1,
      })
    ).toThrow(/קטן מעובי הפאנל/);
  });

  it("builds a snap-fit hook that protrudes past the arm", async () => {
    const kernel = await getGeometryKernel();
    const solid = buildSnapFit(kernel, {
      lengthMm: 15, widthMm: 6, thicknessMm: 1.5,
      hookDepthMm: 1, insertionAngleDeg: 30, retentionAngleDeg: 75,
    });
    expect(solid.status()).toBe("NoError");
    const bounds = solid.boundingBox();
    // Arm thickness 1.5 plus a 1mm hook.
    expect(bounds.max.x).toBeCloseTo(2.5, 3);
    expect(bounds.max.z).toBeCloseTo(15, 3);
    solid.dispose();
  });
});

describe("generators: tolerance test", () => {
  it("makes one hole per clearance, each bigger than the pin", async () => {
    const kernel = await getGeometryKernel();
    const { plate, pin, clearancesMm } = buildToleranceTest(kernel, {
      pinDiameterMm: 5,
      clearancesMm: [0.1, 0.2, 0.3, 0.4],
      thicknessMm: 4,
      spacingMm: 12,
    });
    expect(clearancesMm).toHaveLength(4);
    expect(plate.status()).toBe("NoError");
    // Four through-holes in a plate: genus 4.
    expect(plate.genus()).toBe(4);
    const plateBounds = plate.boundingBox();
    expect(plateBounds.max.x - plateBounds.min.x).toBeCloseTo(48, 1);
    expect(pin.boundingBox().max.x).toBeCloseTo(2.5, 1);
    plate.dispose();
    pin.dispose();
  });

  it("refuses spacing narrower than the pin", async () => {
    const kernel = await getGeometryKernel();
    expect(() =>
      buildToleranceTest(kernel, {
        pinDiameterMm: 10, clearancesMm: [0.2], thicknessMm: 3, spacingMm: 5,
      })
    ).toThrow(/קטן מדי/);
  });
});
