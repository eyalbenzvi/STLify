/**
 * STL import: parse binary and ASCII STL files into MeshData.
 *
 * Design decisions:
 * - Vertices are welded while parsing (coordinates quantized to 1e-4 mm).
 *   Raw STL stores every triangle's vertices independently; welding is what
 *   makes the result an indexed mesh where adjacent triangles share vertices,
 *   which the Manifold kernel requires to recognise a watertight solid.
 * - Format detection cannot rely on the "solid" prefix alone: many binary
 *   exporters write headers that start with "solid". A file is only treated
 *   as ASCII when it also contains the "facet" keyword near the start;
 *   otherwise the binary layout (84-byte header + 50 bytes per triangle)
 *   is authoritative.
 * - All failure modes throw StlImportError with a Hebrew, user-facing
 *   message so the UI can display it directly.
 */

import { type MeshData, meshDataBounds, meshDataVolume } from "@/lib/geometry/meshData";

/** Import failure with a Hebrew user-facing message. */
export class StlImportError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "StlImportError";
  }
}

/** Hard limits protecting the browser from pathological files. */
export const STL_LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxTriangles: 1_500_000,
} as const;

export interface StlParseResult {
  mesh: MeshData;
  format: "binary" | "ascii";
  triangleCount: number;
}

/** Binary STL layout constants. */
const BINARY_HEADER_BYTES = 84;
const BINARY_TRIANGLE_BYTES = 50;
/** Some exporters pad the file end; tolerate a little trailing slack. */
const BINARY_TRAILING_SLACK_BYTES = 8;
/** How much of the file start to scan for ASCII keywords. */
const ASCII_SNIFF_BYTES = 4096;
/** Welding quantum: coordinates within 1e-4 mm collapse to one vertex. */
const WELD_QUANTUM_INV = 10_000;

/**
 * Incremental vertex welder: maps quantized coordinates to indices so that
 * triangles touching the same point in space share a single vertex.
 */
class VertexWelder {
  private readonly indexByKey = new Map<string, number>();
  readonly positions: number[] = [];
  readonly indices: number[] = [];

  /** Register a vertex, returning its (possibly pre-existing) index. */
  addVertex(x: number, y: number, z: number): number {
    const key =
      Math.round(x * WELD_QUANTUM_INV) +
      "," +
      Math.round(y * WELD_QUANTUM_INV) +
      "," +
      Math.round(z * WELD_QUANTUM_INV);
    const existing = this.indexByKey.get(key);
    if (existing !== undefined) return existing;
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.indexByKey.set(key, index);
    return index;
  }

  /** Add a triangle unless welding made it degenerate. Returns true if kept. */
  addTriangle(i0: number, i1: number, i2: number): boolean {
    if (i0 === i1 || i1 === i2 || i0 === i2) return false;
    this.indices.push(i0, i1, i2);
    return true;
  }

  toMeshData(): MeshData {
    return {
      positions: new Float32Array(this.positions),
      indices: new Uint32Array(this.indices),
    };
  }
}

function assertFinite(x: number, y: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new StlImportError("קובץ ה-STL מכיל קואורדינטות לא תקינות");
  }
}

function assertTriangleCount(count: number): void {
  if (count <= 0) {
    throw new StlImportError("קובץ ה-STL ריק או פגום");
  }
  if (count > STL_LIMITS.maxTriangles) {
    throw new StlImportError("קובץ ה-STL מכיל יותר מדי משולשים");
  }
}

/** Parse an STL file (binary or ASCII) into an indexed, welded MeshData. */
export function parseStl(buffer: ArrayBuffer): StlParseResult {
  if (buffer.byteLength > STL_LIMITS.maxFileBytes) {
    throw new StlImportError("קובץ ה-STL גדול מדי (מקסימום 100MB)");
  }
  // Even a minimal ASCII file needs the "solid"/"facet" keywords; anything
  // shorter than a handful of bytes cannot be a valid STL of either flavour.
  if (buffer.byteLength < 15) {
    throw new StlImportError("קובץ ה-STL ריק או פגום");
  }
  return isAsciiStl(buffer) ? parseAsciiStl(buffer) : parseBinaryStl(buffer);
}

/**
 * A file is ASCII only when it starts with "solid" AND mentions "facet"
 * within the first few KB — binary files frequently start with "solid" too.
 */
function isAsciiStl(buffer: ArrayBuffer): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(
    new Uint8Array(buffer, 0, Math.min(buffer.byteLength, ASCII_SNIFF_BYTES))
  );
  return /^\s*solid\b/i.test(head) && /\bfacet\b/i.test(head);
}

function parseBinaryStl(buffer: ArrayBuffer): StlParseResult {
  if (buffer.byteLength < BINARY_HEADER_BYTES) {
    throw new StlImportError("קובץ ה-STL ריק או פגום");
  }
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  assertTriangleCount(triangleCount);

  const expectedBytes = BINARY_HEADER_BYTES + triangleCount * BINARY_TRIANGLE_BYTES;
  if (
    buffer.byteLength < expectedBytes ||
    buffer.byteLength > expectedBytes + BINARY_TRAILING_SLACK_BYTES
  ) {
    throw new StlImportError("קובץ ה-STL פגום — גודל הקובץ אינו תואם למספר המשולשים");
  }

  const welder = new VertexWelder();
  let keptTriangles = 0;
  for (let t = 0; t < triangleCount; t++) {
    // Skip the 12-byte facet normal; recomputed on export anyway.
    let offset = BINARY_HEADER_BYTES + t * BINARY_TRIANGLE_BYTES + 12;
    const tri: number[] = [];
    for (let v = 0; v < 3; v++) {
      const x = view.getFloat32(offset, true);
      const y = view.getFloat32(offset + 4, true);
      const z = view.getFloat32(offset + 8, true);
      assertFinite(x, y, z);
      tri.push(welder.addVertex(x, y, z));
      offset += 12;
    }
    if (welder.addTriangle(tri[0], tri[1], tri[2])) keptTriangles++;
  }
  assertTriangleCount(keptTriangles);
  return { mesh: welder.toMeshData(), format: "binary", triangleCount: keptTriangles };
}

function parseAsciiStl(buffer: ArrayBuffer): StlParseResult {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const welder = new VertexWelder();
  let keptTriangles = 0;
  // Vertices arrive in facet order; every 3 form one triangle.
  let pending: number[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.toLowerCase().startsWith("vertex")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) {
      throw new StlImportError("קובץ ה-STL פגום — שורת קודקוד חסרה קואורדינטות");
    }
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    const z = Number(parts[3]);
    assertFinite(x, y, z);
    pending.push(welder.addVertex(x, y, z));
    if (pending.length === 3) {
      if (welder.addTriangle(pending[0], pending[1], pending[2])) keptTriangles++;
      pending = [];
    }
  }

  if (pending.length !== 0) {
    throw new StlImportError("קובץ ה-STL פגום — מספר הקודקודים אינו מתחלק במשולשים");
  }
  assertTriangleCount(keptTriangles);
  return { mesh: welder.toMeshData(), format: "ascii", triangleCount: keptTriangles };
}

// ---------------------------------------------------------------------------
// Import summary (shown to the user before committing the import)
// ---------------------------------------------------------------------------

export interface StlImportSummary {
  triangleCount: number;
  dimensionsMm: { x: number; y: number; z: number };
  approxVolumeMm3: number;
  componentCount: number;
  warningsHe: string[];
}

/** Thresholds for import warnings. */
const WARN_MAX_DIMENSION_MM = 500;
const WARN_MAX_TRIANGLES = 500_000;

/** Union-find with path halving, for counting connected components. */
class UnionFind {
  private readonly parent: Int32Array;

  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * Compute display statistics for an imported mesh: bounding size, an
 * approximate volume (signed tetrahedron sum — exact for watertight meshes),
 * connected-component count, and Hebrew warnings for suspicious inputs.
 */
export function summarizeStlMesh(mesh: MeshData): StlImportSummary {
  const triangleCount = mesh.indices.length / 3;
  const bounds = meshDataBounds(mesh);
  const dimensionsMm = {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
    z: bounds.max.z - bounds.min.z,
  };

  const approxVolumeMm3 = meshDataVolume(mesh);

  // Components: vertices connected through shared triangles (welding makes
  // vertex sharing equivalent to geometric adjacency).
  const idx = mesh.indices;
  const vertexCount = mesh.positions.length / 3;
  const uf = new UnionFind(vertexCount);
  const used = new Uint8Array(vertexCount);
  for (let i = 0; i < idx.length; i += 3) {
    uf.union(idx[i], idx[i + 1]);
    uf.union(idx[i + 1], idx[i + 2]);
    used[idx[i]] = used[idx[i + 1]] = used[idx[i + 2]] = 1;
  }
  const roots = new Set<number>();
  for (let v = 0; v < vertexCount; v++) {
    if (used[v]) roots.add(uf.find(v));
  }
  const componentCount = roots.size;

  const warningsHe: string[] = [];
  const maxDimension = Math.max(dimensionsMm.x, dimensionsMm.y, dimensionsMm.z);
  if (maxDimension > WARN_MAX_DIMENSION_MM) {
    warningsHe.push("המודל גדול מאוד — ודאו שהקובץ ביחידות מילימטרים");
  }
  if (triangleCount > WARN_MAX_TRIANGLES) {
    warningsHe.push("מספר משולשים גבוה — ביצועי העריכה עלולים להיות איטיים");
  }
  if (componentCount > 1) {
    warningsHe.push(`הקובץ מכיל ${componentCount} חלקים נפרדים`);
  }

  return { triangleCount, dimensionsMm, approxVolumeMm3, componentCount, warningsHe };
}
