/**
 * Best-effort mesh repair for imported STL files.
 *
 * Strategy (each step is a real geometric attempt — no fake "repaired!"):
 *   1. Exact weld + Manifold merge vectors (kernel.fromMeshData does this).
 *   2. Re-weld vertices at progressively coarser tolerances and retry.
 *   3. As a last resort, report failure honestly — not every STL can be
 *      repaired automatically, and we never pretend otherwise.
 */

import { getGeometryKernel } from "../kernel";
import type { MeshData } from "../meshData";

export interface MeshRepairResult {
  attempted: true;
  succeeded: boolean;
  messageHe: string;
  /** The repaired, manifold mesh (only when succeeded). */
  mesh: MeshData | null;
  triangleCount: number;
}

/** Re-index the mesh, welding vertices within `toleranceMm`. */
export function weldMesh(mesh: MeshData, toleranceMm: number): MeshData {
  const inv = 1 / toleranceMm;
  const map = new Map<string, number>();
  const remap = new Uint32Array(mesh.positions.length / 3);
  const outPositions: number[] = [];
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const x = mesh.positions[v * 3];
    const y = mesh.positions[v * 3 + 1];
    const z = mesh.positions[v * 3 + 2];
    const key = `${Math.round(x * inv)}_${Math.round(y * inv)}_${Math.round(z * inv)}`;
    let index = map.get(key);
    if (index === undefined) {
      index = outPositions.length / 3;
      map.set(key, index);
      outPositions.push(x, y, z);
    }
    remap[v] = index;
  }
  const outIndices: number[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = remap[mesh.indices[i]];
    const b = remap[mesh.indices[i + 1]];
    const c = remap[mesh.indices[i + 2]];
    if (a === b || b === c || c === a) continue; // drop degenerate triangles
    outIndices.push(a, b, c);
  }
  return {
    positions: new Float32Array(outPositions),
    indices: new Uint32Array(outIndices),
  };
}

/** Attempt to turn a broken mesh into a valid manifold solid. */
export async function attemptMeshRepair(mesh: MeshData): Promise<MeshRepairResult> {
  const kernel = await getGeometryKernel();

  // Attempt 1: as-is (fromMeshData already merges near-coincident verts).
  {
    const { solid, status } = kernel.fromMeshData(mesh);
    if (status === "NoError" && !solid.isEmpty()) {
      const repaired = solid.toMeshData();
      const triangleCount = solid.numTriangles();
      solid.dispose();
      return {
        attempted: true,
        succeeded: true,
        messageHe: "הרשת אוחתה בהצלחה (איחוי קודקודים)",
        mesh: repaired,
        triangleCount,
      };
    }
    solid.dispose();
  }

  // Attempt 2+: coarser welds.
  for (const tolerance of [0.001, 0.01, 0.05]) {
    const welded = weldMesh(mesh, tolerance);
    if (welded.indices.length === 0) continue;
    const { solid, status } = kernel.fromMeshData(welded);
    if (status === "NoError" && !solid.isEmpty()) {
      const repaired = solid.toMeshData();
      const triangleCount = solid.numTriangles();
      solid.dispose();
      return {
        attempted: true,
        succeeded: true,
        messageHe: `הרשת תוקנה באיחוי קודקודים בסבילות ${tolerance} מ״מ — ייתכנו שינויים זעירים בפרטים`,
        mesh: repaired,
        triangleCount,
      };
    }
    solid.dispose();
  }

  return {
    attempted: true,
    succeeded: false,
    messageHe:
      "לא ניתן לתקן את הרשת אוטומטית — הקובץ מכיל חורים או צמתים לא תקינים. נסו לתקן בתוכנה ייעודית (למשל Meshmixer / Netfabb)",
    mesh: null,
    triangleCount: mesh.indices.length / 3,
  };
}
