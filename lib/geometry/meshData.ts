/**
 * MeshData: the app's transferable triangle-mesh payload — indexed positions
 * only, millimetres, Z-up. This is the bridge between the Manifold kernel,
 * three.js preview geometries, STL import/export and the portable design
 * file (where the arrays are base64-encoded).
 */

import * as THREE from "three";

export interface MeshData {
  /** xyz triples, mm. */
  positions: Float32Array;
  /** Triangle vertex indices (CCW from outside). */
  indices: Uint32Array;
}

export function meshDataTriangleCount(mesh: MeshData): number {
  return mesh.indices.length / 3;
}

/** Convert to a three.js geometry (positions are copied by reference). */
export function meshDataToGeometry(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Extract MeshData from a three.js geometry. Non-indexed geometries are
 * indexed trivially (no welding — use the kernel's fromMeshData for that).
 */
export function geometryToMeshData(geometry: THREE.BufferGeometry): MeshData {
  const position = geometry.getAttribute("position");
  const positions = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }
  let indices: Uint32Array;
  if (geometry.index) {
    indices = new Uint32Array(geometry.index.count);
    for (let i = 0; i < geometry.index.count; i++) {
      indices[i] = geometry.index.getX(i);
    }
  } else {
    indices = new Uint32Array(position.count);
    for (let i = 0; i < position.count; i++) indices[i] = i;
  }
  return { positions, indices };
}

/** Axis-aligned bounding box of the mesh, in mm. */
export function meshDataBounds(mesh: MeshData): {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
} {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < min.x) min.x = p[i];
    if (p[i] > max.x) max.x = p[i];
    if (p[i + 1] < min.y) min.y = p[i + 1];
    if (p[i + 1] > max.y) max.y = p[i + 1];
    if (p[i + 2] < min.z) min.z = p[i + 2];
    if (p[i + 2] > max.z) max.z = p[i + 2];
  }
  if (!Number.isFinite(min.x)) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  }
  return { min, max };
}

/**
 * Apply a column-major 4x4 matrix to the positions (CPU-side). Indices are
 * shared with the source mesh (positions are copied). If the matrix mirrors
 * (negative determinant), triangle winding is flipped to keep faces outward.
 */
export function transformMeshData(mesh: MeshData, matrix: THREE.Matrix4): MeshData {
  const e = matrix.elements;
  const src = mesh.positions;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i],
      y = src[i + 1],
      z = src[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  let indices = mesh.indices;
  if (matrix.determinant() < 0) {
    indices = new Uint32Array(mesh.indices.length);
    for (let i = 0; i < mesh.indices.length; i += 3) {
      indices[i] = mesh.indices[i];
      indices[i + 1] = mesh.indices[i + 2];
      indices[i + 2] = mesh.indices[i + 1];
    }
  }
  return { positions: out, indices };
}

// ---------------------------------------------------------------------------
// Triangle primitives
//
// The single home for the per-triangle arithmetic every mesh module needs.
// All three take VERTEX indices (not the ×3 float offsets) so callers never
// have to remember which convention a helper wants.
// ---------------------------------------------------------------------------

/**
 * Cross product of the triangle's two edge vectors (b−a) × (c−a). Its
 * direction is the face normal; its length is twice the triangle's area.
 * Written into `out` so hot loops allocate nothing.
 */
export function triangleCross(
  // ArrayLike, not Float32Array: some callers work in Float64 world space.
  positions: ArrayLike<number>,
  ia: number,
  ib: number,
  ic: number,
  out: [number, number, number] = [0, 0, 0]
): [number, number, number] {
  const a = ia * 3;
  const b = ib * 3;
  const c = ic * 3;
  const ux = positions[b] - positions[a];
  const uy = positions[b + 1] - positions[a + 1];
  const uz = positions[b + 2] - positions[a + 2];
  const vx = positions[c] - positions[a];
  const vy = positions[c + 1] - positions[a + 1];
  const vz = positions[c + 2] - positions[a + 2];
  out[0] = uy * vz - uz * vy;
  out[1] = uz * vx - ux * vz;
  out[2] = ux * vy - uy * vx;
  return out;
}

const scratchCross: [number, number, number] = [0, 0, 0];

/** Area of a single triangle, mm². */
export function triangleArea(
  positions: ArrayLike<number>,
  ia: number,
  ib: number,
  ic: number
): number {
  const [x, y, z] = triangleCross(positions, ia, ib, ic, scratchCross);
  return Math.hypot(x, y, z) / 2;
}

/**
 * Signed volume of the surface: the sum of tetrahedra from the origin.
 * Exact for closed meshes; the SIGN says which way the surface faces
 * (positive = outward-facing normals), so an inside-out mesh is detectable.
 */
export function signedMeshVolume(mesh: MeshData): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let volume = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    volume +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) +
        p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
  }
  return volume;
}

/** Exact volume for closed meshes, independent of overall orientation. */
export function meshDataVolume(mesh: MeshData): number {
  return Math.abs(signedMeshVolume(mesh));
}

/** Total surface area of the mesh. */
export function meshDataSurfaceArea(mesh: MeshData): number {
  const idx = mesh.indices;
  let area = 0;
  for (let i = 0; i < idx.length; i += 3) {
    area += triangleArea(mesh.positions, idx[i], idx[i + 1], idx[i + 2]);
  }
  return area;
}

// ---------------------------------------------------------------------------
// Base64 serialization (portable design files)
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  // Browser + Node without Buffer typing issues.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeMeshData(mesh: MeshData): {
  positions: string;
  indices: string;
} {
  return {
    positions: bytesToBase64(
      new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength)
    ),
    indices: bytesToBase64(
      new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength)
    ),
  };
}

export function decodeMeshData(encoded: {
  positions: string;
  indices: string;
}): MeshData {
  const posBytes = base64ToBytes(encoded.positions);
  const idxBytes = base64ToBytes(encoded.indices);
  if (posBytes.byteLength % 12 !== 0 || idxBytes.byteLength % 12 !== 0) {
    throw new Error("Invalid mesh payload length");
  }
  const positions = new Float32Array(posBytes.buffer, 0, posBytes.byteLength / 4);
  const indices = new Uint32Array(idxBytes.buffer, 0, idxBytes.byteLength / 4);
  const vertexCount = positions.length / 3;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertexCount) throw new Error("Mesh index out of range");
  }
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new Error("Mesh contains non-finite coordinates");
  }
  return { positions, indices };
}
