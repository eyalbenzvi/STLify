/**
 * The print-readiness funnel a generated mesh passes through, driven with
 * synthetic provider output: hardened OBJ parse → staged repair (voxel
 * fallback) → triangle budget — verified through the real kernel.
 */

import { describe, expect, it } from "vitest";
import { parseObj, ObjImportError } from "@/lib/import/obj";
import { repairMesh } from "@/lib/geometry/repair/diagnose";
import { applyImportTriangleBudget } from "@/lib/import/triangleBudget";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import { meshDataBounds } from "@/lib/geometry/meshData";

/** A unit cube as an OBJ string, optionally missing faces (open mesh). */
function cubeObj(dropFaces = 0): string {
  const lines = [
    "v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0",
    "v 0 0 1", "v 1 0 1", "v 1 1 1", "v 0 1 1",
    "f 1 3 2", "f 1 4 3", // bottom
    "f 5 6 7", "f 5 7 8", // top
    "f 1 2 6", "f 1 6 5", // front
    "f 2 3 7", "f 2 7 6", // right
    "f 3 4 8", "f 3 8 7", // back
    "f 4 1 5", "f 4 5 8", // left
  ];
  return lines.slice(0, lines.length - dropFaces).join("\n");
}

describe("cloud mesh funnel", () => {
  it("passes a healthy provider mesh straight through", async () => {
    const { mesh } = parseObj(cubeObj());
    const report = await repairMesh(mesh, {});
    expect(report.succeeded).toBe(true);
    expect(report.mesh).not.toBeNull();
    expect(report.stages.filter((s) => s.changed)).toEqual([]);
    const kernel = await getGeometryKernel();
    const budgeted = await applyImportTriangleBudget(kernel, report.mesh!);
    expect(budgeted.noticeHe).toBeNull();
    const bounds = meshDataBounds(budgeted.mesh);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(1, 5);
  });

  it("repairs a provider mesh with holes and says which stage did it", async () => {
    const { mesh } = parseObj(cubeObj(2)); // one missing side
    const report = await repairMesh(mesh, {});
    expect(report.succeeded).toBe(true);
    const changed = report.stages.filter((s) => s.changed).map((s) => s.stage);
    expect(changed.length).toBeGreaterThan(0);
    expect(report.messageHe).toContain("הרשת תוקנה");
    // The repaired result is a closed solid the kernel accepts.
    const kernel = await getGeometryKernel();
    const { solid, status } = kernel.fromMeshData(report.mesh!);
    expect(status).toBe("NoError");
    expect(solid.isEmpty()).toBe(false);
    solid.dispose();
  });

  it("reports failure honestly when even the voxel fallback is forbidden", async () => {
    const { mesh } = parseObj(cubeObj(6)); // half a cube — badly open
    const report = await repairMesh(mesh, {
      fillHoles: false,
      allowVoxelRemesh: false,
    });
    expect(report.succeeded).toBe(false);
    expect(report.mesh).toBeNull();
    expect(report.messageHe).toContain("לא ניתן היה");
  });

  it("rejects hostile provider output at the parser, in Hebrew", () => {
    expect(() => parseObj("f 1 2 999999999")).toThrow(ObjImportError);
    expect(() => parseObj("not an obj at all")).toThrow(ObjImportError);
  });
});
