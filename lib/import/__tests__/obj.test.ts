/**
 * OBJ import: index forms, welding, polygon faces and hostile input.
 */

import { describe, expect, it } from "vitest";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import { ObjImportError, parseObj } from "../obj";

/** A closed tetrahedron with outward-facing windings. */
const TETRAHEDRON = `
# a tetrahedron
v 0 0 0
v 10 0 0
v 0 10 0
v 0 0 10
f 1 3 2
f 1 2 4
f 2 3 4
f 3 1 4
`;

describe("parseObj", () => {
  it("parses a closed solid the kernel accepts", async () => {
    const { mesh, triangleCount } = parseObj(TETRAHEDRON);
    expect(triangleCount).toBe(4);
    expect(mesh.positions.length / 3).toBe(4);
    const kernel = await getGeometryKernel();
    const { solid, status } = kernel.fromMeshData(mesh);
    expect(status).toBe("NoError");
    // Volume of the corner tetrahedron: (1/6)·a·b·c.
    expect(solid.volumeMm3()).toBeCloseTo((10 * 10 * 10) / 6, 3);
    solid.dispose();
  });

  it("accepts negative indices, which count back from the vertices seen so far", async () => {
    const negative = `
v 0 0 0
v 10 0 0
v 0 10 0
v 0 0 10
f -4 -2 -3
f -4 -3 -1
f -3 -2 -1
f -2 -4 -1
`;
    const { mesh } = parseObj(negative);
    const reference = parseObj(TETRAHEDRON);
    expect(mesh.positions).toEqual(reference.mesh.positions);
    expect(mesh.indices).toEqual(reference.mesh.indices);
  });

  it("reads every index form, ignoring texture and normal fields", () => {
    const forms = `
v 0 0 0
v 1 0 0
v 0 1 0
vt 0 0
vn 0 0 1
f 1/1/1 2/1/1 3/1/1
f 1//1 2//1 3//1
f 1/1 2/1 3/1
`;
    const { mesh, triangleCount } = parseObj(forms);
    expect(triangleCount).toBe(3);
    expect(mesh.positions.length / 3).toBe(3);
  });

  it("fan-triangulates a polygon face", () => {
    const quad = `
v 0 0 0
v 10 0 0
v 10 10 0
v 0 10 0
f 1 2 3 4
`;
    expect(parseObj(quad).triangleCount).toBe(2);
  });

  it("welds duplicated vertices, as the STL importer does", () => {
    // The same corner written twice: without welding the kernel sees two
    // disconnected triangles rather than a shared edge.
    const duplicated = `
v 0 0 0
v 10 0 0
v 0 10 0
v 0 0 0
v 10 0 0
v 0 0 10
f 1 2 3
f 4 5 6
`;
    const { mesh } = parseObj(duplicated);
    expect(mesh.positions.length / 3).toBe(4);
  });

  it("reports what it does not carry, rather than dropping it silently", () => {
    const withMaterials = `
mtllib scene.mtl
o part
usemtl red
v 0 0 0
v 1 0 0
v 0 1 0
f 1 2 3
`;
    const { warningsHe } = parseObj(withMaterials);
    expect(warningsHe.join(" ")).toMatch(/mtl/);
    expect(warningsHe.join(" ")).toMatch(/אוחדו/);
  });

  it("refuses a face pointing at a vertex that does not exist", () => {
    const bad = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99\n";
    expect(() => parseObj(bad)).toThrow(ObjImportError);
    expect(() => parseObj(bad)).toThrow(/קודקוד שאינו קיים/);
  });

  it("refuses a forward reference, which a negative index makes easy to write", () => {
    // "f 1 2 3" before the vertices exist: the indices are in range for the
    // finished file but not at the point the face is read.
    expect(() => parseObj("f 1 2 3\nv 0 0 0\nv 1 0 0\nv 0 1 0\n")).toThrow(/קודקוד שאינו קיים/);
  });

  it("refuses non-numeric coordinates and empty files with Hebrew messages", () => {
    expect(() => parseObj("v 0 0 0\nv nan_value 0 0\nv 0 1 0\nf 1 2 3\n")).toThrow(
      /קואורדינטות לא תקינות/
    );
    expect(() => parseObj("v 0 0 0\nv 1 0 0\nv 0 1 0\n")).toThrow(/אינו מכיל פאות/);
    expect(() => parseObj("# nothing at all\n")).toThrow(ObjImportError);
  });

  it("refuses a degenerate face outright rather than importing a sliver", () => {
    expect(() => parseObj("v 0 0 0\nv 1 0 0\nf 1 2\n")).toThrow(/פחות משלושה/);
  });
});
