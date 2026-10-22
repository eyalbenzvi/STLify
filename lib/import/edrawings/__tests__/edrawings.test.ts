/**
 * eDrawings import: container, HSF stream, model layout, placement, assembly.
 *
 * Most cases run against synthetic files from lib/testing/edrawingsFixture.ts,
 * which writes the stream layout found in a real SOLIDWORKS 2025 assembly.
 * The real file itself is a customer model and is not committed; set
 * EDRAWINGS_SAMPLE to its path to run the regression case at the bottom.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createZip } from "@/lib/export/zip";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import { signedMeshVolume, type MeshData } from "@/lib/geometry/meshData";
import { boxBody, buildEDrawingsFixture, type FixtureOptions } from "@/lib/testing/edrawingsFixture";
import { assembleBodies } from "../assemble";
import { readEDrawingsContainer } from "../container";
import { EDrawingsError } from "../errors";
import { parseHsf } from "../hsf";
import { appendStripTriangles, parseEDrawingsFile } from "../model";
import {
  concatMeshes,
  fitScale,
  placeGeometry,
  placedBounds,
  rebaseOffset,
} from "../placement";
import { shareTriangleBudget } from "@/hooks/useEDrawingsImport";

const asBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** Two components: a 10 cm cube at the origin and the same body moved 1 m along X. */
function twoCubes(extra: Partial<FixtureOptions> = {}): FixtureOptions {
  return {
    bodies: [boxBody([0, 0, 0], [0.1, 0.1, 0.1], [200, 30, 30])],
    components: [
      { name: "Cube-1", bodies: [0] },
      { name: "Cube-2", bodies: [0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0] },
    ],
    massVolumeM3: 0.002,
    ...extra,
  };
}

describe("eDrawings stream decoding", () => {
  it("decodes every face of an assembly and places instanced bodies", async () => {
    const file = await buildEDrawingsFixture(twoCubes());
    const model = await parseEDrawingsFile(asBuffer(file));

    expect(model.formatVersion).toBe("V20.90");
    expect(model.configurationName).toBe("Default");
    expect(model.facesDeclared).toBe(6);
    expect(model.facesDecoded).toBe(6);
    expect(model.complete).toBe(true);
    expect(model.components.map((c) => c.name)).toEqual(["Cube-1", "Cube-2"]);

    const [a, b] = model.components;
    expect(a.triangleCount).toBe(12);
    expect(a.colorHex).toBe("#c81e1e");
    expect(a.bounds.min[0]).toBeCloseTo(0, 6);
    expect(b.bounds.min[0]).toBeCloseTo(1, 6);
    expect(b.bounds.max[0]).toBeCloseTo(1.1, 6);
    // Faces share corner positions, so the exact weld closes the cube.
    expect(a.bodies[0].positions.length / 3).toBe(8);
    // Outward winding: positive volume, and it matches the mass properties.
    expect(signedMeshVolume(a.bodies[0])).toBeCloseTo(0.001, 6);
    expect(model.unitCheck).toBe("verified");
  });

  it("reports mass properties that disagree with the geometry", async () => {
    const file = await buildEDrawingsFixture(twoCubes({ massVolumeM3: 2_000_000 }));
    const model = await parseEDrawingsFile(asBuffer(file));
    expect(model.unitCheck).toBe("mismatch");
    expect(model.warningsHe.join(" ")).toContain("נתוני המסה");
  });

  it("honours the file's display state", async () => {
    const options = twoCubes();
    options.components[1].hidden = true;
    const model = await parseEDrawingsFile(asBuffer(await buildEDrawingsFixture(options)));
    expect(model.components.map((c) => c.visibleInFile)).toEqual([true, false]);
  });

  it("says how much is missing when placeholders are left unfilled", async () => {
    const file = await buildEDrawingsFixture(twoCubes({ omitTags: [0, 1] }));
    const model = await parseEDrawingsFile(asBuffer(file));
    expect(model.complete).toBe(false);
    expect(model.facesDecoded).toBe(4);
    expect(model.warningsHe[0]).toContain("4 מתוך 6");
  });

  it("stops on an unknown opcode before the geometry, keeping what it read", async () => {
    // 0xF0 is not an opcode this reader knows; nothing after it can be read.
    const file = await buildEDrawingsFixture(twoCubes({ injectBeforeGeometry: [0xf0] }));
    await expect(parseEDrawingsFile(asBuffer(file))).rejects.toThrow(EDrawingsError);
    const container = await readEDrawingsContainer(asBuffer(file));
    const scene = await parseHsf(container.eModel);
    expect(scene.stop?.opcodeHex).toBe("0xf0");
    expect(scene.stubs.size).toBe(6);
    expect(scene.shells.length).toBe(0);
  });

  it("accepts the pre-ZIP format (a bare HSF stream)", async () => {
    const file = await buildEDrawingsFixture({ ...twoCubes(), zip: false });
    const model = await parseEDrawingsFile(asBuffer(file));
    expect(model.facesDecoded).toBe(6);
  });

  it("decodes triangle strips with alternating winding", () => {
    const out: number[] = [];
    expect(appendStripTriangles(new Uint32Array([5, 0, 1, 2, 3, 4]), 5, 10, out)).toBe(true);
    expect(out).toEqual([10, 11, 12, 12, 11, 13, 12, 13, 14]);
    expect(appendStripTriangles(new Uint32Array([4, 0, 1, 2, 9]), 5, 0, [])).toBe(false);
    expect(appendStripTriangles(new Uint32Array([6, 0, 1]), 5, 0, [])).toBe(false);
  });
});

describe("eDrawings import refuses hostile and malformed input", () => {
  it("rejects a file that is neither ZIP nor HSF", async () => {
    await expect(readEDrawingsContainer(asBuffer(new TextEncoder().encode("hello")))).rejects.toThrow(
      EDrawingsError
    );
  });

  it("rejects an archive whose model is not an HSF stream (e.g. password-protected)", async () => {
    const zip = createZip([{ name: "eModel", data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }]);
    const error = await readEDrawingsContainer(await zip.arrayBuffer()).catch((e) => e);
    expect(error).toBeInstanceOf(EDrawingsError);
    expect((error as EDrawingsError).messageHe).toContain("סיסמה");
  });

  it("rejects an archive without a model", async () => {
    const zip = createZip([{ name: "preview.jpg", data: new Uint8Array([1]) }]);
    await expect(readEDrawingsContainer(await zip.arrayBuffer())).rejects.toThrow(EDrawingsError);
  });

  it("caps the inflated size", async () => {
    const file = await buildEDrawingsFixture({ ...twoCubes(), zip: false });
    const error = await parseHsf(file, {
      maxInflatedBytes: 64,
      maxShells: 1000,
      maxPointsTotal: 1000,
      maxSegments: 1000,
      maxDepth: 64,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(EDrawingsError);
  });

  it("caps vertex counts a shell claims", async () => {
    const file = await buildEDrawingsFixture({ ...twoCubes(), zip: false });
    const scene = await parseHsf(file, {
      maxInflatedBytes: 1 << 20,
      maxShells: 1000,
      maxPointsTotal: 10,
      maxSegments: 1000,
      maxDepth: 64,
    });
    expect(scene.stop?.reasonHe).toContain("קודקודים");
  });

  it("caps the vertices that instancing may multiply out", async () => {
    // A body included many times costs memory per instance, not per file byte.
    const file = await buildEDrawingsFixture(twoCubes());
    await expect(
      parseEDrawingsFile(asBuffer(file), { buildLimits: { maxInstanceVertices: 30, maxDepth: 64 } })
    ).rejects.toThrow(EDrawingsError);
  });

  it("survives random corruption without hanging or throwing foreign errors", async () => {
    const pristine = await buildEDrawingsFixture({ ...twoCubes(), zip: false });
    // Deterministic PRNG so a failure reproduces.
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const container = await readEDrawingsContainer(asBuffer(pristine));
    const inner = await parseHsf(container.eModel);
    expect(inner.shells.length).toBe(6);
    for (let round = 0; round < 60; round++) {
      // Corrupt the HEADER region and, separately, truncate — the compressed
      // body is covered by the inflate check.
      const bytes = pristine.slice(0, Math.max(20, Math.floor(pristine.length * random())));
      for (let k = 0; k < 4; k++) {
        const at = Math.floor(random() * bytes.length);
        bytes[at] = Math.floor(random() * 256);
      }
      try {
        await parseEDrawingsFile(asBuffer(bytes));
      } catch (error) {
        expect(error).toBeInstanceOf(EDrawingsError);
      }
    }
  });
});

describe("eDrawings placement", () => {
  const unitCube: MeshData = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2]),
    indices: new Uint32Array([0, 1, 2]),
  };

  it("converts metres to millimetres and applies the model scale", () => {
    const placed = placeGeometry(unitCube, { unit: "m", upAxis: "z", scale: 0.01 }, [0, 0, 0]);
    expect(Array.from(placed.positions.slice(9, 12))).toEqual([0, 0, 20]);
  });

  it("rotates a Y-up file onto Z-up without mirroring", () => {
    const placed = placeGeometry(unitCube, { unit: "mm", upAxis: "y", scale: 1 }, [0, 0, 0]);
    // +Y (vertex 2) becomes +Z; +Z (vertex 3) becomes -Y.
    const at = (i: number) => Array.from(placed.positions.slice(i * 3, i * 3 + 3)).map((v) => v + 0);
    expect(at(2)).toEqual([0, 0, 1]);
    expect(at(3)).toEqual([0, -2, 0]);
  });

  it("rebases the selection onto the plate as a whole", () => {
    const bounds = placedBounds(
      [{ min: [1, 1, 1], max: [2, 3, 4] }],
      { unit: "mm", upAxis: "z", scale: 1 }
    );
    expect(bounds).not.toBeNull();
    expect(rebaseOffset(bounds!)).toEqual([-1.5, -2, -1]);
  });

  it("fits the largest dimension to a target size", () => {
    const scale = fitScale([{ min: [0, 0, 0], max: [30, 10, 5] }], "m", 200);
    expect(scale * 30 * 1000).toBeCloseTo(200, 6);
  });

  it("shares the triangle budget in proportion", () => {
    expect(shareTriangleBudget([100, 200], 1000)).toEqual([1000, 1000]);
    const shares = shareTriangleBudget([900_000, 100_000], 250_000);
    expect(shares[0]).toBe(225_000);
    expect(shares[1]).toBe(25_000);
  });
});

describe("eDrawings component assembly", () => {
  const box = (min: [number, number, number], max: [number, number, number]): MeshData => {
    const faces = boxBody(min, max).faces;
    const meshes = faces.map((f) => {
      const out: number[] = [];
      appendStripTriangles(new Uint32Array(f.strips), 4, 0, out);
      return { positions: new Float32Array(f.positions), indices: new Uint32Array(out) };
    });
    return concatMeshes(meshes);
  };

  it("unites overlapping closed bodies exactly, without a voxel rebuild", async () => {
    const result = await assembleBodies([box([0, 0, 0], [20, 20, 20]), box([10, 10, 10], [30, 30, 30])]);
    expect(result.closed).toBe(true);
    expect(result.bodiesRebuilt).toBe(0);
    const kernel = await getGeometryKernel();
    const { solid, status } = kernel.fromMeshData(result.mesh);
    expect(status).toBe("NoError");
    solid.dispose();
    // 8000 + 8000 − 1000 overlap.
    expect(signedMeshVolume(result.mesh)).toBeCloseTo(15_000, 0);
  });

  it("closes an open body and still reports it", async () => {
    const open = box([0, 0, 0], [20, 20, 20]);
    // Drop the last face (two triangles): a box with a missing lid.
    const lidless: MeshData = { positions: open.positions, indices: open.indices.slice(0, -6) };
    const result = await assembleBodies([lidless, box([40, 0, 0], [50, 10, 10])]);
    expect(result.closed).toBe(true);
    expect(result.bodiesRepaired + result.bodiesRebuilt).toBe(1);
  });
});

const SAMPLE = process.env.EDRAWINGS_SAMPLE;
describe.skipIf(!SAMPLE || !existsSync(SAMPLE))("real SOLIDWORKS 2025 assembly (local file)", () => {
  it("decodes all 5,204 faces and matches the file's mass properties", async () => {
    const bytes = readFileSync(SAMPLE!);
    const model = await parseEDrawingsFile(asBuffer(bytes));
    expect(model.formatVersion).toBe("V20.90");
    expect(model.facesDecoded).toBe(5204);
    expect(model.complete).toBe(true);
    expect(model.components).toHaveLength(12);
    expect(model.unitCheck).toBe("verified");
    const printer = model.components.find((c) => c.name === "sf900 floor model-1")!;
    const size = printer.bounds.max.map((v, i) => v - printer.bounds.min[i]);
    // Stratasys F900 published footprint: 2772 × 1685 × 2281 mm.
    expect(size[0]).toBeCloseTo(2.772, 3);
    expect(size[1]).toBeCloseTo(1.685, 3);
    expect(size[2]).toBeCloseTo(2.281, 3);
  });
});
