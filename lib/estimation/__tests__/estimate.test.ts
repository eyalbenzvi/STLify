import { describe, expect, it } from "vitest";
import { defaultEstimateSettings } from "@/lib/design/defaults";
import { estimateCost, fdmMaterialVolumeMm3 } from "../cost";
import { estimatePrintTime, formatMinutesHe } from "../time";

const BOUNDS = { x: 120, y: 40, z: 4.5 };
const VOLUME_MM3 = 120 * 40 * 3; // a 3mm plate

describe("cost estimation", () => {
  it("produces a coherent breakdown that sums to the total", () => {
    const settings = defaultEstimateSettings();
    const cost = estimateCost({ modelVolumeMm3: VOLUME_MM3, boundsMm: BOUNDS, settings });
    expect(cost.totalCost).toBeCloseTo(
      cost.materialCost + cost.electricityCost + cost.machineCost + cost.laborCost + cost.packagingCost,
      1
    );
    expect(cost.materialWeightGrams).toBeGreaterThan(0);
    expect(cost.currency).toBe("ILS");
  });

  it("infill percentage increases FDM material use", () => {
    const settings = defaultEstimateSettings();
    settings.printer.infillPercent = 10;
    const low = fdmMaterialVolumeMm3(VOLUME_MM3, BOUNDS, settings);
    settings.printer.infillPercent = 80;
    const high = fdmMaterialVolumeMm3(VOLUME_MM3, BOUNDS, settings);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(VOLUME_MM3);
  });

  it("resin printing is priced per litre with full volume", () => {
    const settings = defaultEstimateSettings();
    settings.printer.technology = "Resin";
    settings.material.name = "Resin";
    settings.material.costPerLitre = 200;
    settings.material.costPerKg = 0;
    const cost = estimateCost({ modelVolumeMm3: VOLUME_MM3, boundsMm: BOUNDS, settings });
    // 14.4 cm³ + waste ⇒ ≈ 0.016 L × 200
    expect(cost.materialCost).toBeGreaterThan(2);
    expect(cost.materialCost).toBeLessThan(5);
  });

  it("suggested prices respect markup and margin", () => {
    const settings = defaultEstimateSettings();
    settings.markupPercent = 100;
    settings.targetMarginPercent = 50;
    const cost = estimateCost({ modelVolumeMm3: VOLUME_MM3, boundsMm: BOUNDS, settings });
    expect(cost.suggestedPriceMarkup).toBeCloseTo(cost.totalCost * 2, 1);
    expect(cost.suggestedPriceMargin).toBeCloseTo(cost.totalCost * 2, 1);
  });

  it("bigger models cost more", () => {
    const settings = defaultEstimateSettings();
    const small = estimateCost({ modelVolumeMm3: VOLUME_MM3, boundsMm: BOUNDS, settings });
    const large = estimateCost({
      modelVolumeMm3: VOLUME_MM3 * 4,
      boundsMm: { x: 240, y: 80, z: 4.5 },
      settings,
    });
    expect(large.totalCost).toBeGreaterThan(small.totalCost);
  });
});

describe("time estimation", () => {
  it("returns a range, never a single value", () => {
    const settings = defaultEstimateSettings();
    const time = estimatePrintTime({
      modelVolumeMm3: VOLUME_MM3,
      materialVolumeMm3: VOLUME_MM3 * 0.5,
      boundsMm: BOUNDS,
      settings,
    });
    expect(time.printMinutesMax).toBeGreaterThan(time.printMinutesMin);
    expect(time.totalMinutesMin).toBe(time.printMinutesMin + time.setupMinutes + time.postProcessingMinutes);
    expect(time.layerCount).toBe(Math.ceil(BOUNDS.z / settings.printer.layerHeightMm));
    expect(["low", "medium", "high"]).toContain(time.confidence);
  });

  it("flat plates get high confidence, tall parts low", () => {
    const settings = defaultEstimateSettings();
    const flat = estimatePrintTime({
      modelVolumeMm3: VOLUME_MM3,
      materialVolumeMm3: VOLUME_MM3,
      boundsMm: { x: 100, y: 100, z: 3 },
      settings,
    });
    const tall = estimatePrintTime({
      modelVolumeMm3: VOLUME_MM3,
      materialVolumeMm3: VOLUME_MM3,
      boundsMm: { x: 20, y: 20, z: 120 },
      settings,
    });
    expect(flat.confidence).toBe("high");
    expect(tall.confidence).toBe("low");
  });

  it("resin time scales with layer count, not volume", () => {
    const settings = defaultEstimateSettings();
    settings.printer.technology = "Resin";
    settings.printer.layerHeightMm = 0.05;
    const a = estimatePrintTime({
      modelVolumeMm3: 1000,
      materialVolumeMm3: 1000,
      boundsMm: { x: 30, y: 30, z: 10 },
      settings,
    });
    const b = estimatePrintTime({
      modelVolumeMm3: 100_000,
      materialVolumeMm3: 100_000,
      boundsMm: { x: 100, y: 100, z: 10 },
      settings,
    });
    expect(a.layerCount).toBe(b.layerCount);
    expect(a.printMinutesMin).toBe(b.printMinutesMin);
  });

  it("formats Hebrew durations", () => {
    expect(formatMinutesHe(45)).toBe("45 דקות");
    expect(formatMinutesHe(60)).toBe("שעה");
    expect(formatMinutesHe(130)).toBe("שעתיים ו-10 דקות");
    expect(formatMinutesHe(185)).toBe("3 שעות ו-5 דקות");
  });
});
