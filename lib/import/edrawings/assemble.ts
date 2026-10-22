/**
 * Turn one eDrawings component — several SOLIDWORKS bodies of display
 * tessellation — into one printable solid, losing as little detail as
 * possible.
 *
 * Handing the whole component to the staged repair treats overlapping bodies
 * as self-intersection, which only the voxel rebuild resolves: a 11,000-
 * triangle part came back as 220,000 triangles with its fine detail gone.
 * Bodies are closed solids that happen to overlap, and overlap is exactly
 * what a boolean union resolves losslessly. So:
 *
 *   1. each body on its own: accepted as is, or repaired WITHOUT the voxel
 *      stage (weld, winding, holes, shells);
 *   2. the bodies that are now solid are united exactly;
 *   3. only bodies still broken (open sheets, damaged faces) go through the
 *      full repair, voxel rebuild included, and join the union afterwards.
 *
 * Detail loss is therefore confined to the bodies that could not be closed,
 * and the report says how many those were.
 */

import { getGeometryKernel, type Solid } from "@/lib/geometry/kernel";
import type { MeshData } from "@/lib/geometry/meshData";
import { repairMesh } from "@/lib/geometry/repair/diagnose";
import { concatMeshes } from "./placement";

export interface AssembleResult {
  mesh: MeshData;
  /** True when the result is a closed solid the kernel accepts. */
  closed: boolean;
  bodies: number;
  /** Bodies that needed a (non-voxel) repair. */
  bodiesRepaired: number;
  /** Bodies that only the full repair (voxel rebuild) could close. */
  bodiesRebuilt: number;
  /** Bodies nothing could close — kept as raw geometry. */
  bodiesUnresolved: number;
  messageHe: string;
}

export async function assembleBodies(
  bodies: MeshData[],
  onProgress: (fraction: number) => void = () => undefined,
  shouldStop: () => void = () => undefined
): Promise<AssembleResult> {
  const kernel = await getGeometryKernel();
  const solids: Solid[] = [];
  const broken: MeshData[] = [];
  let bodiesRepaired = 0;
  let bodiesRebuilt = 0;
  let bodiesUnresolved = 0;
  const unresolved: MeshData[] = [];

  const adopt = (mesh: MeshData): boolean => {
    const { solid, status } = kernel.fromMeshData(mesh);
    if (status === "NoError" && !solid.isEmpty()) {
      solids.push(solid);
      return true;
    }
    solid.dispose();
    return false;
  };

  try {
    for (let i = 0; i < bodies.length; i++) {
      shouldStop();
      onProgress((0.7 * i) / Math.max(bodies.length, 1));
      const body = bodies[i];
      if (adopt(body)) continue;
      const report = await repairMesh(body, {
        allowVoxelRemesh: false,
        resolveSelfIntersections: false,
      });
      if (report.succeeded && report.mesh && adopt(report.mesh)) {
        bodiesRepaired++;
      } else {
        broken.push(body);
      }
    }

    if (broken.length > 0) {
      shouldStop();
      onProgress(0.75);
      const report = await repairMesh(concatMeshes(broken));
      if (report.succeeded && report.mesh && adopt(report.mesh)) {
        bodiesRebuilt = broken.length;
      } else {
        bodiesUnresolved = broken.length;
        unresolved.push(...broken);
      }
    }

    shouldStop();
    onProgress(0.9);
    let united: MeshData | null = null;
    if (solids.length > 0) {
      // unionAll consumes its operands.
      const result = kernel.unionAll(solids.splice(0));
      united = result.toMeshData();
      result.dispose();
    }

    const parts: string[] = [];
    if (bodiesRepaired > 0) parts.push(`${bodiesRepaired} גופים תוקנו`);
    if (bodiesRebuilt > 0) {
      parts.push(`${bodiesRebuilt} גופים פתוחים נבנו מחדש ברשת ווקסלים (פרטים דקים בהם אבדו)`);
    }
    if (bodiesUnresolved > 0) parts.push(`${bodiesUnresolved} גופים לא נסגרו ונשארו כפי שהם`);

    if (unresolved.length > 0) {
      return {
        mesh: concatMeshes(united ? [united, ...unresolved] : unresolved),
        closed: false,
        bodies: bodies.length,
        bodiesRepaired,
        bodiesRebuilt,
        bodiesUnresolved,
        messageHe: parts.join("; "),
      };
    }
    if (!united) throw new Error("לא נותרה גאומטריה לאחר התיקון");
    return {
      mesh: united,
      closed: true,
      bodies: bodies.length,
      bodiesRepaired,
      bodiesRebuilt,
      bodiesUnresolved,
      messageHe:
        parts.length > 0
          ? `${bodies.length} גופים אוחדו לגוף אחד: ${parts.join("; ")}`
          : `${bodies.length} גופים אוחדו לגוף אחד ללא צורך בתיקון`,
    };
  } finally {
    for (const solid of solids) solid.dispose();
  }
}
