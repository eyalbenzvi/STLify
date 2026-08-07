/**
 * LOCAL fillet on a selected region (V6 item 20).
 *
 * Manifold still has no per-edge fillet operator, so this does not pretend
 * to add one. It composes what the kernel CAN do soundly:
 *
 *   1. round a duplicate of the WHOLE body morphologically (fillet.ts),
 *   2. keep the rounded surface only inside a ZONE box around the selected
 *      region (rounded ∩ zone),
 *   3. keep the ORIGINAL body everywhere else (original ∖ zone),
 *   4. union the two.
 *
 * Every step is a Manifold boolean, so the result is WATERTIGHT BY
 * CONSTRUCTION — the feasibility risk named in the plan (seams at the
 * region boundary) resolves as a COSMETIC step where a rounded edge meets
 * its unrounded continuation at the zone boundary, not as broken topology.
 * A validity gate (kernel status + a volume-delta bound) still refuses any
 * result that violates the contract, and the UI says the seam caveat out
 * loud rather than shipping it silently.
 */

import type { GeometryKernel } from "../kernel";
import type { MeshData } from "../meshData";
import { withSolidScopeSync } from "../solidScope";
import { OpError } from "./layerOps";
import { roundEdges, type FilletSettings } from "./fillet";

export interface FilletRegionOutcome {
  mesh: MeshData;
  warningsHe: string[];
}

export function filletRegion(
  kernel: GeometryKernel,
  mesh: MeshData,
  regionTriangles: ReadonlySet<number>,
  settings: FilletSettings
): FilletRegionOutcome {
  if (regionTriangles.size === 0) {
    throw new OpError("בחרו אזור (פאות) לעיגול תחילה");
  }
  if (!(settings.sizeMm > 0)) {
    throw new OpError("רדיוס העיגול חייב להיות גדול מאפס");
  }

  // Zone: the region's bounding box, expanded so the rounding has room to
  // act on every edge the selection touches.
  const p = mesh.positions;
  const idx = mesh.indices;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const t of regionTriangles) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      min.x = Math.min(min.x, p[v]);
      min.y = Math.min(min.y, p[v + 1]);
      min.z = Math.min(min.z, p[v + 2]);
      max.x = Math.max(max.x, p[v]);
      max.y = Math.max(max.y, p[v + 1]);
      max.z = Math.max(max.z, p[v + 2]);
    }
  }
  if (!Number.isFinite(min.x)) {
    throw new OpError("האזור שנבחר ריק");
  }
  const pad = settings.sizeMm * 3;

  return withSolidScopeSync((scope) => {
    const { solid, status } = kernel.fromMeshData(mesh);
    scope.track(solid);
    if (status !== "NoError" || solid.isEmpty()) {
      throw new OpError(`הגוף אינו תקין (${status}) — הפעילו ״תיקון רשת״ תחילה`);
    }
    const originalVolume = solid.volumeMm3();

    const zoneBox = () =>
      scope.track(
        kernel
          .box(max.x - min.x + pad * 2, max.y - min.y + pad * 2, max.z - min.z + pad * 2, false)
          .translate(min.x - pad, min.y - pad, min.z - pad)
      );

    // 1. Round the whole body on a duplicate (roundEdges consumes it).
    const rounded = roundEdges(kernel, solid.duplicate(), settings);
    scope.track(rounded.solid);
    const warningsHe = [...rounded.warningsHe];

    // 2 + 3. The rounded surface inside the zone; the original elsewhere.
    const roundedInZone = scope.track(rounded.solid.intersect(zoneBox()));
    const [insideZone, outsideZone] = solid.splitBySolid(zoneBox());
    scope.track(insideZone);
    scope.track(outsideZone);

    // 4. Union — a boolean of manifolds, watertight by construction.
    const result = scope.track(outsideZone.union(roundedInZone));

    // The gate the plan demanded: refuse rather than ship a broken body.
    if (result.status() !== "NoError" || result.isEmpty()) {
      throw new OpError(
        `העיגול המקומי נכשל בשער התקינות (${result.status()}) — התוצאה לא נשמרה`,
        ["נסו רדיוס קטן יותר או אזור גדול יותר"]
      );
    }
    const resultVolume = result.volumeMm3();
    const zoneVolume =
      (max.x - min.x + pad * 2) * (max.y - min.y + pad * 2) * (max.z - min.z + pad * 2);
    if (Math.abs(resultVolume - originalVolume) > zoneVolume) {
      throw new OpError("העיגול המקומי שינה את הגוף מעבר לאזור שנבחר — התוצאה לא נשמרה");
    }

    warningsHe.push(
      "מקצוע שנמשך אל מחוץ לאזור הנבחר יציג מדרגה קטנה בגבול האזור — זו מגבלה מתועדת של העקיפה (ל-Manifold אין עיגול לפי מקצוע)"
    );
    return { mesh: result.toMeshData(), warningsHe };
  });
}
