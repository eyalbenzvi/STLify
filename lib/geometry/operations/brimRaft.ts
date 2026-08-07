/**
 * Brim and raft generation as REAL geometry (V6 item 12).
 *
 * Like the support pillars, these are honest bodies the user can see,
 * move and delete — not slicer settings. A brim is a one-layer ring
 * hugging the first-layer outline; a raft is a slab under the whole
 * footprint (the part itself is lifted onto it by the caller).
 *
 * Both derive from the FIRST-LAYER outline (a kernel slice just above the
 * lowest point), not from the shadow projection — an overhanging top must
 * not inflate the brim.
 */

import type { GeometryKernel, Solid } from "../kernel";
import type { MeshData } from "../meshData";
import { withSolidScopeSync } from "../solidScope";
import { OpError } from "./layerOps";

export interface BrimSettings {
  /** Ring width around the first layer outline, mm. */
  widthMm: number;
  /** Brim thickness — typically one first-layer height, mm. */
  heightMm: number;
}

export const DEFAULT_BRIM_SETTINGS: BrimSettings = { widthMm: 5, heightMm: 0.3 };

export interface RaftSettings {
  /** Extra margin around the footprint, mm. */
  marginMm: number;
  /** Raft slab thickness, mm. */
  heightMm: number;
}

export const DEFAULT_RAFT_SETTINGS: RaftSettings = { marginMm: 3, heightMm: 2 };

/** First-layer outline contours of a world-space mesh. */
function firstLayerContours(kernel: GeometryKernel, mesh: MeshData) {
  return withSolidScopeSync((scope) => {
    const { solid, status } = kernel.fromMeshData(mesh);
    scope.track(solid);
    if (status !== "NoError" || solid.isEmpty()) {
      throw new OpError("לא ניתן לחלץ את קו המתאר של השכבה הראשונה — הרשת אינה תקינה");
    }
    const minZ = solid.boundingBox().min.z;
    const contours = solid.slicePolygons(minZ + 0.05);
    if (contours.length === 0) {
      throw new OpError("לגוף אין מגע עם משטח ההדפסה — אין ממה לגזור Brim/Raft");
    }
    return contours;
  });
}

export interface BrimOutcome {
  solid: Solid;
  /** Ring area, mm² (volume / height). */
  areaMm2: number;
  summaryHe: string;
}

/**
 * Build a brim ring for a world-space mesh. The ring TOUCHES the part's
 * first-layer outline (shared boundary, no interpenetration) and sits on
 * the bed: z ∈ [0, heightMm].
 */
export async function buildBrim(
  kernel: GeometryKernel,
  mesh: MeshData,
  settings: BrimSettings = DEFAULT_BRIM_SETTINGS
): Promise<BrimOutcome> {
  if (settings.widthMm <= 0 || settings.heightMm <= 0) {
    throw new OpError("רוחב וגובה ה-Brim חייבים להיות גדולים מאפס");
  }
  const contours = firstLayerContours(kernel, mesh);
  // Miter join keeps a rectangular footprint rectangular — a brim's corners
  // are exactly where warping lifts, so they must not be cut off.
  const outer = kernel.offsetContours(contours, settings.widthMm, "miter");
  if (outer.length === 0) {
    throw new OpError("יצירת ה-Brim נכשלה — קו המתאר התרוקן בהרחבה");
  }
  return withSolidScopeSync((scope) => {
    const outerSolid = scope.track(kernel.extrude(outer, settings.heightMm));
    const innerSolid = scope.track(kernel.extrude(contours, settings.heightMm + 1));
    const ring = scope.track(outerSolid.subtract(innerSolid));
    if (ring.status() !== "NoError" || ring.isEmpty()) {
      throw new OpError("יצירת ה-Brim נכשלה");
    }
    const areaMm2 = ring.volumeMm3() / settings.heightMm;
    return {
      solid: scope.keep(ring),
      areaMm2,
      summaryHe: `Brim ברוחב ${settings.widthMm} מ״מ, שטח ${areaMm2.toFixed(0)} ממ״ר — מחקו אותו מהשכבות כדי לוותר עליו`,
    };
  });
}

export interface RaftOutcome {
  solid: Solid;
  /** How much the part must be lifted so it sits ON the raft, mm. */
  liftMm: number;
  summaryHe: string;
}

/** Build a raft slab under a world-space mesh: z ∈ [0, heightMm]. */
export async function buildRaft(
  kernel: GeometryKernel,
  mesh: MeshData,
  settings: RaftSettings = DEFAULT_RAFT_SETTINGS
): Promise<RaftOutcome> {
  if (settings.heightMm <= 0) {
    throw new OpError("גובה ה-Raft חייב להיות גדול מאפס");
  }
  const contours = firstLayerContours(kernel, mesh);
  const outer =
    settings.marginMm > 0
      ? kernel.offsetContours(contours, settings.marginMm, "miter")
      : contours;
  if (outer.length === 0) {
    throw new OpError("יצירת ה-Raft נכשלה — קו המתאר התרוקן בהרחבה");
  }
  const slab = kernel.extrude(outer, settings.heightMm);
  if (slab.status() !== "NoError" || slab.isEmpty()) {
    slab.dispose();
    throw new OpError("יצירת ה-Raft נכשלה");
  }
  return {
    solid: slab,
    liftMm: settings.heightMm,
    summaryHe: `Raft בעובי ${settings.heightMm} מ״מ; החלק הורם ב-${settings.heightMm} מ״מ כדי לשבת עליו — מחיקת ה-Raft מחזירה אתכם להוריד אותו חזרה`,
  };
}
