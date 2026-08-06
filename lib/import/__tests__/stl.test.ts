/**
 * STL import tests: format detection, welding, validation and summary.
 */

import { describe, expect, it } from "vitest";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import type { MeshData } from "@/lib/geometry/meshData";
import { meshDataToBinaryStl } from "@/lib/export/stlData";
import { parseStl, StlImportError, summarizeStlMesh } from "../stl";

async function kernelBoxMesh(size: number, offsetX = 0): Promise<MeshData> {
  const kernel = await getGeometryKernel();
  const box = kernel.box(size, size, size, true).translate(offsetX, 0, 0);
  const mesh = box.toMeshData();
  box.dispose();
  return mesh;
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

const ASCII_TETRA = `solid tetra
facet normal 0 0 -1
  outer loop
    vertex 0 0 0
    vertex 10 0 0
    vertex 0 10 0
  endloop
endfacet
facet normal 0 -1 0
  outer loop
    vertex 0 0 0
    vertex 0 0 10
    vertex 10 0 0
  endloop
endfacet
facet normal -1 0 0
  outer loop
    vertex 0 0 0
    vertex 0 10 0
    vertex 0 0 10
  endloop
endfacet
facet normal 1 1 1
  outer loop
    vertex 10 0 0
    vertex 0 0 10
    vertex 0 10 0
  endloop
endfacet
endsolid tetra
`;

describe("parseStl", () => {
  it("round-trips a binary cube with welding (8 unique vertices)", async () => {
    const mesh = await kernelBoxMesh(10);
    const blob = meshDataToBinaryStl(mesh);
    const parsed = parseStl(await blobToArrayBuffer(blob));
    expect(parsed.format).toBe("binary");
    expect(parsed.triangleCount).toBe(12);
    expect(parsed.mesh.positions.length / 3).toBe(8);
  });

  it("parsed meshes convert cleanly to manifold solids", async () => {
    const mesh = await kernelBoxMesh(10);
    const parsed = parseStl(await blobToArrayBuffer(meshDataToBinaryStl(mesh)));
    const kernel = await getGeometryKernel();
    const { solid, status } = kernel.fromMeshData(parsed.mesh);
    expect(status).toBe("NoError");
    expect(solid.volumeMm3()).toBeCloseTo(1000, 0);
    solid.dispose();
  });

  it("parses ASCII STL", async () => {
    const buffer = new TextEncoder().encode(ASCII_TETRA).buffer as ArrayBuffer;
    const parsed = parseStl(buffer);
    expect(parsed.format).toBe("ascii");
    expect(parsed.triangleCount).toBe(4);
    expect(parsed.mesh.positions.length / 3).toBe(4);
    const summary = summarizeStlMesh(parsed.mesh);
    expect(summary.approxVolumeMm3).toBeGreaterThan(100);
    const kernel = await getGeometryKernel();
    const { status } = kernel.fromMeshData(parsed.mesh);
    expect(status).toBe("NoError");
  });

  it("rejects empty buffers", () => {
    expect(() => parseStl(new ArrayBuffer(0))).toThrow(StlImportError);
  });

  it("rejects binary files whose size mismatches the declared count", async () => {
    const mesh = await kernelBoxMesh(10);
    const blob = meshDataToBinaryStl(mesh);
    const buffer = await blobToArrayBuffer(blob);
    new DataView(buffer).setUint32(80, 500, true); // lie about the count
    expect(() => parseStl(buffer)).toThrow(StlImportError);
  });

  it("rejects non-finite coordinates", async () => {
    const mesh = await kernelBoxMesh(10);
    const buffer = await blobToArrayBuffer(meshDataToBinaryStl(mesh));
    new DataView(buffer).setFloat32(84 + 12, Number.NaN, true); // first vertex x
    expect(() => parseStl(buffer)).toThrow(StlImportError);
  });

  it("summary counts disjoint components and warns in Hebrew", async () => {
    const a = await kernelBoxMesh(10);
    const b = await kernelBoxMesh(10, 50);
    const merged: MeshData = {
      positions: new Float32Array([...a.positions, ...b.positions]),
      indices: new Uint32Array([
        ...a.indices,
        ...[...b.indices].map((i) => i + a.positions.length / 3),
      ]),
    };
    const summary = summarizeStlMesh(merged);
    expect(summary.componentCount).toBe(2);
    expect(summary.warningsHe.some((w) => w.includes("2"))).toBe(true);
  });
});
