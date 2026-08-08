/**
 * Triangle budget for imported meshes.
 *
 * A 900,000-triangle scan is not a better print than a 200,000-triangle one;
 * it is the same print with an editor that has become unusable. Above a named
 * threshold the mesh is simplified on the way in, with a Hebrew notice giving
 * the counts and the honest caveat about lost detail.
 *
 * Automatic with a notice, not a dialog with a decision: the user has no way
 * to answer "how many triangles do you want" before seeing the model, and
 * whatever they answered they would then have to undo. Simplification is
 * lossy, so the notice says so and names the numbers rather than hiding them.
 */

import type { GeometryKernel } from "@/lib/geometry/kernel";
import type { MeshData } from "@/lib/geometry/meshData";
import { meshDataBounds } from "@/lib/geometry/meshData";
import { withSolidScope } from "@/lib/geometry/solidScope";

/** Above this a mesh is simplified on import. */
export const IMPORT_TRIANGLE_BUDGET = 250_000;
/** Simplification passes before we accept whatever we have. */
const MAX_PASSES = 6;
/** First tolerance, as a fraction of the model's diagonal. */
const START_TOLERANCE_FRACTION = 0.0004;

export interface TriangleBudgetResult {
  mesh: MeshData;
  /** Hebrew notice when the mesh was reduced, otherwise null. */
  noticeHe: string | null;
}

/**
 * Simplify `mesh` down toward the budget if it is over it.
 *
 * Requires a mesh the kernel accepts: simplification is an edge-collapse on a
 * manifold, and a broken import has to go through repair first. When the
 * kernel refuses the mesh, the original is returned untouched with a notice
 * that says the reduction did not happen — quietly shipping the heavy mesh
 * while the user believes it was reduced is the one outcome worth avoiding.
 */
export async function applyImportTriangleBudget(
  kernel: GeometryKernel,
  mesh: MeshData,
  budget: number = IMPORT_TRIANGLE_BUDGET
): Promise<TriangleBudgetResult> {
  const before = mesh.indices.length / 3;
  if (before <= budget) return { mesh, noticeHe: null };

  const bounds = meshDataBounds(mesh);
  const diagonal = Math.hypot(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z
  );
  if (!(diagonal > 0)) return { mesh, noticeHe: null };

  // The kernel's own instruction (kernel.ts): new multi-step pipelines use the
  // scope rather than a manual dispose chain. `simplify` CONSUMES its receiver,
  // and dispose() is idempotent, so tracking each handle frees whatever is
  // still live — including when the kernel throws mid-chain, which a manual
  // chain would have leaked.
  return withSolidScope(async (scope) => {
    const { solid, status } = kernel.fromMeshData(mesh);
    scope.track(solid);
    if (status !== "NoError") {
      return {
        mesh,
        noticeHe:
          `הקובץ מכיל ${before.toLocaleString()} משולשים, יותר מהמומלץ ` +
          `(${budget.toLocaleString()}), אך לא ניתן היה לפשט אותו כי הרשת אינה ` +
          `אטומה. נסו ״תיקון״ ואז ״פישוט״ מתפריט הכלים אם העריכה איטית.`,
      };
    }

    let current = solid;
    let tolerance = diagonal * START_TOLERANCE_FRACTION;
    let best: MeshData | null = null;
    let after = before;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      current = scope.track(current.simplify(tolerance));
      best = current.toMeshData();
      after = best.indices.length / 3;
      if (after <= budget) break;
      tolerance *= 2;
    }

    // Nothing actually came off: keep the original rather than swap in an
    // equivalent mesh and claim a reduction that did not happen.
    if (!best || after >= before) return { mesh, noticeHe: null };
    return {
      mesh: best,
      noticeHe:
        `הקובץ הכיל ${before.toLocaleString()} משולשים, יותר מהמומלץ ` +
        `(${budget.toLocaleString()}), ולכן פושט אוטומטית ל-${after.toLocaleString()} ` +
        `משולשים כדי שהעריכה תישאר זריזה. פישוט מאבד פרטים דקים — אם חשוב ` +
        `לכם הפירוט המלא, בטלו את הייבוא וייבאו קובץ קל יותר.`,
    };
  });
}
