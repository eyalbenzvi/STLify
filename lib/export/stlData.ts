/**
 * Binary STL export straight from MeshData, without going through three.js.
 * Same wire format as lib/export/stl.ts (84-byte header, computed facet
 * normals, little-endian), so both writers produce interchangeable files.
 * Useful in workers and tests where constructing a THREE.BufferGeometry
 * would be pointless overhead.
 */

import type { MeshData } from "@/lib/geometry/meshData";

/** Serialize an indexed mesh to a binary STL blob (1 STL unit = 1 mm). */
export function meshDataToBinaryStl(mesh: MeshData): Blob {
  const triangleCount = mesh.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);

  // 80-byte header (ASCII, informational only).
  const header = "PrintCraft STL Studio - units: mm";
  for (let i = 0; i < Math.min(header.length, 80); i++) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(80, triangleCount, true);

  const p = mesh.positions;
  const idx = mesh.indices;
  let offset = 84;
  for (let t = 0; t < triangleCount; t++) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;

    // Facet normal = normalized (b - a) x (c - a); zero for degenerates.
    const abx = p[b] - p[a];
    const aby = p[b + 1] - p[a + 1];
    const abz = p[b + 2] - p[a + 2];
    const acx = p[c] - p[a];
    const acy = p[c + 1] - p[a + 1];
    const acz = p[c + 2] - p[a + 2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) {
      nx /= length;
      ny /= length;
      nz /= length;
    }

    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    offset += 12;
    for (const base of [a, b, c]) {
      view.setFloat32(offset, p[base], true);
      view.setFloat32(offset + 4, p[base + 1], true);
      view.setFloat32(offset + 8, p[base + 2], true);
      offset += 12;
    }
    view.setUint16(offset, 0, true); // attribute byte count
    offset += 2;
  }

  return new Blob([buffer], { type: "model/stl" });
}
