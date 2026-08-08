/**
 * Wavefront OBJ import: plain text vertices and faces → welded MeshData.
 *
 * Welded on the same terms as the STL importer, and for the same reason: OBJ
 * lets a file share vertices but does not require it, and exporters routinely
 * emit a separate vertex per face corner. Without welding, the Manifold kernel
 * sees a pile of disconnected triangles rather than a solid.
 *
 * Deliberately narrow: `v` and `f` are read, `vt`/`vn`/`vp` are skipped,
 * `mtllib`/`usemtl` are reported as unsupported rather than silently dropped,
 * and `o`/`g` groups are merged into one body — a printable mesh does not
 * need texture coordinates, and the summary already reports how many
 * disconnected components came out.
 *
 * Untrusted input: size, vertex and triangle counts are all bounded, and every
 * refusal is a Hebrew message.
 */

import type { MeshData } from "@/lib/geometry/meshData";

/** Import failure with a Hebrew user-facing message. */
export class ObjImportError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "ObjImportError";
  }
}

export const OBJ_LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxVertices: 2_000_000,
  maxTriangles: 1_500_000,
  /** A single face this large is malformed, not a model. */
  maxFaceCorners: 1024,
  /**
   * A single line this long is malformed too, and the cap has to come BEFORE
   * the line is split: `maxFaceCorners` was checked after `split()` had already
   * materialised the array, so one `f` line of five million tokens allocated
   * tens of megabytes and burned a second before being refused. A 1024-corner
   * face needs a few kilobytes; 64 KB is generous.
   */
  maxLineChars: 64 * 1024,
} as const;

/** Welding quantum: coordinates within 1e-4 mm collapse to one vertex. */
const WELD_QUANTUM_INV = 10_000;

export interface ObjParseResult {
  mesh: MeshData;
  triangleCount: number;
  warningsHe: string[];
}

/**
 * Resolve an OBJ face index. OBJ is 1-based, and a NEGATIVE index counts back
 * from the vertices seen SO FAR — which is why this needs the running count
 * rather than the final one.
 */
function resolveIndex(raw: number, seen: number): number {
  if (!Number.isInteger(raw) || raw === 0) return -1;
  const index = raw > 0 ? raw - 1 : seen + raw;
  return index >= 0 && index < seen ? index : -1;
}

export function parseObj(text: string): ObjParseResult {
  if (text.length > OBJ_LIMITS.maxFileBytes) {
    throw new ObjImportError("קובץ ה-OBJ גדול מדי (מקסימום 100MB)");
  }

  const sourceX: number[] = [];
  const sourceY: number[] = [];
  const sourceZ: number[] = [];
  /** Welded index per source vertex, filled lazily (-1 = not yet welded). */
  const weldedIndex: number[] = [];
  const indexByKey = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const warnings = new Set<string>();

  const weld = (source: number): number => {
    const existing = weldedIndex[source];
    if (existing >= 0) return existing;
    const x = sourceX[source];
    const y = sourceY[source];
    const z = sourceZ[source];
    const key =
      Math.round(x * WELD_QUANTUM_INV) +
      "," +
      Math.round(y * WELD_QUANTUM_INV) +
      "," +
      Math.round(z * WELD_QUANTUM_INV);
    let index = indexByKey.get(key);
    if (index === undefined) {
      index = positions.length / 3;
      positions.push(x, y, z);
      indexByKey.set(key, index);
    }
    weldedIndex[source] = index;
    return index;
  };

  // Walked by index rather than `text.split(/\r?\n/)`: the split materialises
  // one array entry per line before any of them is looked at, so a 20 MB file
  // of nothing but newlines cost 300 MB of heap on the way to being refused.
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    const rawLength = lineEnd - lineStart;
    if (rawLength > OBJ_LIMITS.maxLineChars) {
      throw new ObjImportError("קובץ ה-OBJ פגום — שורה ארוכה מדי");
    }
    const rawLine = text.slice(lineStart, lineEnd);
    lineStart = lineEnd + 1;

    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const space = line.search(/\s/);
    const keyword = space < 0 ? line : line.slice(0, space);

    if (keyword === "v") {
      const parts = line.slice(space + 1).trim().split(/\s+/);
      if (parts.length < 3) {
        throw new ObjImportError("קובץ ה-OBJ פגום — שורת קודקוד חסרה קואורדינטות");
      }
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const z = Number(parts[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new ObjImportError("קובץ ה-OBJ מכיל קואורדינטות לא תקינות");
      }
      if (sourceX.length >= OBJ_LIMITS.maxVertices) {
        throw new ObjImportError("קובץ ה-OBJ מכיל יותר מדי קודקודים");
      }
      sourceX.push(x);
      sourceY.push(y);
      sourceZ.push(z);
      weldedIndex.push(-1);
      continue;
    }

    if (keyword === "f") {
      const corners = line.slice(space + 1).trim().split(/\s+/);
      if (corners.length < 3) {
        throw new ObjImportError("קובץ ה-OBJ פגום — פאה עם פחות משלושה קודקודים");
      }
      if (corners.length > OBJ_LIMITS.maxFaceCorners) {
        throw new ObjImportError("קובץ ה-OBJ מכיל פאה עם יותר מדי קודקודים");
      }
      const resolved: number[] = [];
      for (const corner of corners) {
        // "v", "v/vt", "v//vn", "v/vt/vn" — only the first field matters.
        const index = resolveIndex(Number(corner.split("/")[0]), sourceX.length);
        if (index < 0) {
          throw new ObjImportError("קובץ ה-OBJ פגום — פאה מפנה לקודקוד שאינו קיים");
        }
        resolved.push(weld(index));
      }
      // Fan triangulation, which is what an OBJ polygon means for a planar,
      // convex face — the only kind a printable mesh should contain.
      for (let i = 1; i + 1 < resolved.length; i++) {
        const a = resolved[0];
        const b = resolved[i];
        const c = resolved[i + 1];
        if (a === b || b === c || a === c) continue; // degenerate after welding
        if (indices.length / 3 >= OBJ_LIMITS.maxTriangles) {
          throw new ObjImportError("קובץ ה-OBJ מכיל יותר מדי משולשים");
        }
        indices.push(a, b, c);
      }
      continue;
    }

    if (keyword === "mtllib" || keyword === "usemtl") {
      warnings.add("חומרים מקובץ ‎.mtl אינם נתמכים — הגוף יובא בחומר ברירת המחדל");
    } else if (keyword === "o" || keyword === "g") {
      warnings.add("קבוצות ואובייקטים בקובץ ה-OBJ אוחדו לגוף אחד");
    }
  }

  if (indices.length === 0) {
    throw new ObjImportError("קובץ ה-OBJ אינו מכיל פאות — אין ממה ליצור גוף");
  }

  return {
    mesh: {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
    },
    triangleCount: indices.length / 3,
    warningsHe: [...warnings],
  };
}
