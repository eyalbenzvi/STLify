/**
 * Performance budgets (V6 item 9). Run with `npm run bench`.
 *
 * 424+ correctness tests could not see a SPEED regression: a pick that
 * silently went back to a linear scan, a rebuild that stopped being
 * incremental. Each benchmark below measures a real code path on synthetic
 * meshes of 50K / 200K / 500K triangles, PRINTS the numbers, and fails
 * above a named budget.
 *
 * Budget philosophy (documented so future edits keep it): every budget is
 * set roughly an ORDER OF MAGNITUDE above a healthy measurement on a
 * mid-range machine. They exist to catch algorithmic regressions, not 10%
 * wobble — `npm test` stays wall-clock-free so the correctness gate never
 * flakes.
 */

import { describe, expect, it } from "vitest";
import { testBoxRow } from "@/lib/testing/fixtures";
import * as THREE from "three";
import type { DesignDocument, PrimitiveLayer } from "@/types/design";
import { MeshBvh } from "@/lib/geometry/bvh";
import { buildDocument, clearLayerSolidCache } from "@/lib/geometry/buildDocument";
import { emptyDocument } from "@/lib/geometry/documentTemplates";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import { analyzeThickness } from "@/lib/geometry/analysis/thickness";
import { geometryToMeshData, transformMeshData, type MeshData } from "@/lib/geometry/meshData";
import { meshDataToBinaryStl } from "@/lib/export/stlData";

/** Synthetic sphere with approximately the requested triangle count. */
function sphereMesh(targetTriangles: number): MeshData {
  // A UV sphere has ~2·w·h triangles.
  const width = Math.round(Math.sqrt(targetTriangles));
  const height = Math.max(3, Math.round(targetTriangles / (2 * width)));
  const geometry = new THREE.SphereGeometry(40, width, height);
  const mesh = geometryToMeshData(geometry);
  geometry.dispose();
  return mesh;
}

function ms(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

const report: { metric: string; triangles: number; ms: number; budgetMs: number }[] = [];

function assertBudget(metric: string, triangles: number, elapsed: number, budgetMs: number) {
  report.push({ metric, triangles, ms: Math.round(elapsed * 100) / 100, budgetMs });
  console.log(
    `[bench] ${metric} @ ${triangles.toLocaleString()} tris: ${elapsed.toFixed(1)}ms (budget ${budgetMs}ms)`
  );
  expect(elapsed, `${metric} @ ${triangles} triangles exceeded its budget`).toBeLessThan(budgetMs);
}

const SIZES = [50_000, 200_000, 500_000] as const;

describe("performance budgets", () => {
  it("BVH build + pick stay fast at every size", () => {
    // Budgets: build is a one-time cost per mesh identity; a pick happens on
    // every pointer move and must stay in single-digit milliseconds.
    const buildBudgets: Record<number, number> = { 50_000: 2_000, 200_000: 8_000, 500_000: 20_000 };
    const pickBudgetMs = 5;

    for (const size of SIZES) {
      const mesh = sphereMesh(size);
      const triangles = mesh.indices.length / 3;

      let bvh: MeshBvh | null = null;
      const buildTime = ms(() => {
        bvh = new MeshBvh(mesh);
      });
      assertBudget("bvh-build", triangles, buildTime, buildBudgets[size]);

      // 100 picks from a fan of directions; assert the WORST one.
      let worst = 0;
      for (let i = 0; i < 100; i++) {
        const angle = (i / 100) * Math.PI * 2;
        const origin = { x: Math.cos(angle) * 200, y: Math.sin(angle) * 200, z: 30 };
        const direction = { x: -Math.cos(angle), y: -Math.sin(angle), z: -0.1 };
        const t = ms(() => {
          (bvh as unknown as MeshBvh).raycastClosest(origin, direction);
        });
        worst = Math.max(worst, t);
      }
      assertBudget("pick-worst", triangles, worst, pickBudgetMs);
    }
  });

  it("document rebuild: full and incremental", async () => {
    clearLayerSolidCache();
    const doc: DesignDocument = {
      ...emptyDocument(),
      baseMode: "baseless",
      layers: testBoxRow(10, "bench_box_"),
    };

    const t0 = performance.now();
    await buildDocument(doc);
    assertBudget("rebuild-cold-10-layers", 10, performance.now() - t0, 5_000);

    // One layer changed: the incremental path must beat a full rebuild by
    // construction — its budget says "still incremental".
    const edited = {
      ...doc,
      layers: doc.layers.map((l) =>
        l.id === "bench_box_5" ? ({ ...l, widthMm: 25 } as PrimitiveLayer) : l
      ),
    };
    const t1 = performance.now();
    await buildDocument(edited);
    assertBudget("rebuild-incremental-1-of-10", 10, performance.now() - t1, 1_000);
    clearLayerSolidCache();
  });

  it("wall-thickness analysis on a heavy body", async () => {
    const kernel = await getGeometryKernel();
    // A real thin-walled body at ~50K triangles (refined shell).
    const outer = kernel.box(60, 60, 30, false);
    const inner = kernel.box(56, 56, 30, false).translate(2, 2, 2);
    const shell = outer.subtract(inner).refineToLength(0.8);
    const mesh = shell.toMeshData();
    const triangles = mesh.indices.length / 3;

    const t0 = performance.now();
    analyzeThickness(shell, mesh, { minWallMm: 3, minFeatureMm: 0.8 });
    assertBudget("thickness-analysis", triangles, performance.now() - t0, 20_000);
    shell.dispose();
  });

  it("export bake: world transform + binary STL at every size", () => {
    const matrix = new THREE.Matrix4()
      .makeRotationZ(0.4)
      .setPosition(new THREE.Vector3(10, -5, 3));
    // Budgets scale with size; the operation is linear by construction.
    const budgets: Record<number, number> = { 50_000: 1_000, 200_000: 3_000, 500_000: 8_000 };
    for (const size of SIZES) {
      const mesh = sphereMesh(size);
      const triangles = mesh.indices.length / 3;
      const elapsed = ms(() => {
        const world = transformMeshData(mesh, matrix);
        meshDataToBinaryStl(world);
      });
      assertBudget("export-bake-stl", triangles, elapsed, budgets[size]);
    }
  });

  it("prints the consolidated report", () => {
    console.table(report);
    expect(report.length).toBeGreaterThan(0);
  });
});
