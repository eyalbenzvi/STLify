/**
 * Analysis suite tests, using real kernel geometry.
 */

import { describe, expect, it } from "vitest";
import { getPrinterProfile, MATERIAL_PROFILES } from "@/types/profiles";
import { getGeometryKernel } from "../../kernel";
import type { MeshData } from "../../meshData";
import { meshDataBounds } from "../../meshData";
import {
  analyzeBuildVolume,
  analyzeContact,
  analyzeFloatingParts,
  analyzeOverhangs,
  analyzeThickness,
  estimatePrint,
  overhangToVertexColors,
  suggestOrientations,
  thicknessToVertexColors,
} from "../index";

async function plateBox(x: number, y: number, z: number): Promise<MeshData> {
  const kernel = await getGeometryKernel();
  const box = kernel.box(x, y, z, true).translate(0, 0, z / 2);
  const mesh = box.toMeshData();
  box.dispose();
  return mesh;
}

/** T-shape: thin pillar + wide top slab (a classic support case). */
async function mushroom(): Promise<MeshData> {
  const kernel = await getGeometryKernel();
  const pillar = kernel.box(6, 6, 30, true).translate(0, 0, 15);
  const cap = kernel.box(40, 40, 6, true).translate(0, 0, 33);
  const solid = pillar.union(cap);
  const mesh = solid.toMeshData();
  solid.dispose();
  return mesh;
}

function expectValidIssues(issues: { titleHe: string; severity: string }[]) {
  for (const issue of issues) {
    expect(issue.titleHe.length).toBeGreaterThan(0);
    expect(["ok", "warning", "critical"]).toContain(issue.severity);
  }
}

describe("contact analysis", () => {
  it("box on the plate: full contact, stable", async () => {
    const mesh = await plateBox(20, 20, 10);
    const contact = analyzeContact(mesh);
    expect(contact.onPlate).toBe(true);
    expect(contact.contactAreaMm2).toBeCloseTo(400, 0);
    expect(contact.stable).toBe(true);
    expectValidIssues(contact.issues);
  });

  it("floating box: critical off-plate issue", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(10, 10, 10, true).translate(0, 0, 25);
    const mesh = box.toMeshData();
    box.dispose();
    const contact = analyzeContact(mesh);
    expect(contact.onPlate).toBe(false);
    expect(contact.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("sphere resting on the plate has tiny, unstable contact", async () => {
    const kernel = await getGeometryKernel();
    const sphere = kernel.sphere(15, 48).translate(0, 0, 15);
    const mesh = sphere.toMeshData();
    sphere.dispose();
    const contact = analyzeContact(mesh);
    expect(contact.stable).toBe(false);
  });
});

describe("overhang analysis", () => {
  it("plain box has no overhangs (bottom rests on plate)", async () => {
    const mesh = await plateBox(20, 20, 10);
    const overhang = analyzeOverhangs(mesh, 50);
    expect(overhang.supportRisk).toBe("low");
    expect(overhang.overhangAreaMm2).toBeLessThan(1);
  });

  it("mushroom cap is flagged as high/medium support risk", async () => {
    const mesh = await mushroom();
    const overhang = analyzeOverhangs(mesh, 50);
    expect(overhang.supportRisk).not.toBe("low");
    // ~40×40 cap minus 6×6 pillar ≈ 1564 mm² of ceiling.
    expect(overhang.overhangAreaMm2).toBeGreaterThan(1000);
    expect(overhang.issues.some((i) => i.severity === "warning")).toBe(true);
    expectValidIssues(overhang.issues);
    const colors = overhangToVertexColors(mesh, overhang.triangleFlags);
    expect(colors.length).toBe(mesh.positions.length);
  });
});

describe("floating components", () => {
  it("detects a part hovering above the plate", async () => {
    const kernel = await getGeometryKernel();
    const grounded = kernel.box(10, 10, 10, true).translate(0, 0, 5);
    const floater = kernel.box(5, 5, 5, true).translate(30, 0, 22);
    const merged = grounded.union(floater);
    const mesh = merged.toMeshData();
    merged.dispose();
    const analysis = analyzeFloatingParts(mesh);
    expect(analysis.componentCount).toBe(2);
    expect(analysis.floatingCount).toBe(1);
    expect(analysis.issues.length).toBeGreaterThan(0);
    expectValidIssues(analysis.issues);
  });
});

describe("build volume", () => {
  it("fits and exceeds correctly", async () => {
    const mesh = await plateBox(20, 20, 10);
    const bounds = meshDataBounds(mesh);
    expect(analyzeBuildVolume(bounds, getPrinterProfile("genericFdm220")).fits).toBe(true);
    const bigBounds = {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 300, y: 100, z: 100 },
    };
    const result = analyzeBuildVolume(bigBounds, getPrinterProfile("miniFdm180"));
    expect(result.fits).toBe(false);
    expect(result.excessMm.x).toBeCloseTo(120, 0);
    expect(result.issues[0].severity).toBe("critical");
  });
});

describe("thickness analysis", () => {
  it("samples a box's smallest wall", async () => {
    const kernel = await getGeometryKernel();
    const box = kernel.box(20, 20, 10, true).translate(0, 0, 5);
    const mesh = box.toMeshData();
    const analysis = analyzeThickness(box, mesh, { minWallMm: 0.8, minFeatureMm: 0.6 });
    // Thinnest ray through a 20×20×10 box is the 10mm z-wall.
    expect(analysis.minSampledMm).toBeGreaterThan(9);
    expect(analysis.minSampledMm).toBeLessThan(21);
    expect(analysis.issues.some((i) => i.code === "thickness/ok")).toBe(true);
    const colors = thicknessToVertexColors(mesh, analysis, 0.8);
    expect(colors.length).toBe(mesh.positions.length);
    box.dispose();
  });

  it("flags a thin plate", async () => {
    const kernel = await getGeometryKernel();
    const plate = kernel.box(30, 30, 0.3, true).translate(0, 0, 0.15);
    const mesh = plate.toMeshData();
    const analysis = analyzeThickness(plate, mesh, { minWallMm: 0.8, minFeatureMm: 0.6 });
    expect(analysis.minSampledMm).toBeLessThan(0.4);
    expect(analysis.issues.some((i) => i.severity === "critical")).toBe(true);
    plate.dispose();
  });
});

describe("orientation suggestions", () => {
  it("returns 3 scored candidates with Hebrew explanations", async () => {
    const mesh = await mushroom();
    const candidates = suggestOrientations(mesh, 50);
    expect(candidates.length).toBe(3);
    for (const c of candidates) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
      expect(c.explanationHe).toContain("שטח מגע");
      expect(c.nameHe.length).toBeGreaterThan(0);
    }
    // Flipping the mushroom (cap down) must beat the current orientation.
    const current = candidates.find((c) => c.nameHe === "התנוחה הנוכחית");
    const best = candidates[0];
    if (current) expect(best.score).toBeGreaterThanOrEqual(current.score);
  });
});

describe("print estimates", () => {
  it("is monotonic in volume and infill, and positive", () => {
    const pla = MATERIAL_PROFILES[0];
    const small = estimatePrint(1000, 10, pla, 0.2, 20);
    const large = estimatePrint(10000, 10, pla, 0.2, 20);
    const dense = estimatePrint(1000, 10, pla, 0.2, 90);
    expect(small.weightGrams).toBeGreaterThan(0);
    expect(large.weightGrams).toBeGreaterThan(small.weightGrams);
    expect(dense.weightGrams).toBeGreaterThan(small.weightGrams);
    expect(small.timeMinutes).toBeGreaterThan(0);
    expect(small.costIls).toBeGreaterThan(0);
  });
});
