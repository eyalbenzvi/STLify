/**
 * Mesh diagnosis and the staged repair pipeline.
 *
 * `diagnoseMesh` turns a mesh into a navigable list of `ModelIssue`s — each
 * with a Hebrew title, a concrete corrective action and, where meaningful, a
 * world-space location so the inspector can point the camera at the problem.
 *
 * `repairMesh` runs the fixes in increasing order of destructiveness and
 * stops as soon as the kernel accepts the result:
 *
 *   1. weld coincident vertices            (lossless)
 *   2. drop degenerate/duplicate triangles (lossless)
 *   3. split bowtie vertices               (lossless)
 *   4. make winding consistent + outward   (lossless)
 *   5. fill boundary loops                 (adds geometry, reported)
 *   6. drop loose and interior shells      (removes geometry, reported)
 *   7. voxel remesh                        (rebuilds everything, reported)
 *
 * Every stage that ran is listed in the result, so the report says what was
 * actually done rather than a bare "repaired!". A stage that cannot help is
 * skipped, and if the mesh is still not manifold at the end we say so.
 */

import type { ModelIssue } from "@/types/design";
import { getGeometryKernel } from "../kernel";
import type { MeshData } from "../meshData";
import { cleanupComponents } from "./cleanup";
import { fillHoles } from "./holeFill";
import { weldMesh } from "./repair";
import { findSelfIntersections } from "./selfIntersection";
import {
  analyzeTopology,
  orientConsistently,
  removeDegenerateTriangles,
  removeDuplicateTriangles,
  removeUnusedVertices,
  splitNonManifoldVertices,
  type TopologyReport,
} from "./topology";
import { voxelRemesh } from "./voxelRemesh";

export interface MeshDiagnosis {
  topology: TopologyReport;
  issues: ModelIssue[];
  /** True when the Manifold kernel accepts the mesh as-is. */
  kernelAccepts: boolean;
  kernelStatus: string;
  selfIntersectionCount: number;
}

function formatMm(value: number): string {
  return value.toFixed(value < 10 ? 2 : 1);
}

/** Full diagnosis: topology, self-intersections and the kernel's verdict. */
export async function diagnoseMesh(
  mesh: MeshData,
  options: { checkSelfIntersections?: boolean } = {}
): Promise<MeshDiagnosis> {
  const topology = analyzeTopology(mesh);
  const issues: ModelIssue[] = [];

  const kernel = await getGeometryKernel();
  const { solid, status } = kernel.fromMeshData(mesh);
  const kernelAccepts = status === "NoError" && !solid.isEmpty();
  solid.dispose();

  if (topology.boundaryLoops.length > 0) {
    const total = topology.boundaryLoops.length;
    const biggest = topology.boundaryLoops[0];
    issues.push({
      code: "mesh.holes",
      severity: "critical",
      titleHe: `${total} ${total === 1 ? "חור" : "חורים"} ברשת`,
      detailHe:
        `נמצאו ${topology.boundaryEdgeCount} קצוות פתוחים ב-${total} ` +
        `${total === 1 ? "לולאה" : "לולאות"}. החור הגדול ביותר בהיקף ` +
        `${formatMm(biggest.perimeterMm)} מ״מ. מודל עם חורים אינו גוף סגור ולא ניתן להדפסה.`,
      actionHe: "הפעילו ״סגירת חורים״ בתיקון הרשת",
      location: biggest.center,
    });
  }

  if (topology.nonManifoldEdgeCount > 0) {
    issues.push({
      code: "mesh.nonManifoldEdges",
      severity: "critical",
      titleHe: `${topology.nonManifoldEdgeCount} קצוות לא־תקינים`,
      detailHe:
        "קצוות שבהם נפגשים שלושה משטחים או יותר. זה אינו משטח תקין ומבלבל " +
        "את הסלייסר.",
      actionHe: "הפעילו תיקון רשת; אם לא נפתר, נסו ״בנייה מחדש (Voxel)״",
    });
  }

  if (topology.inconsistentEdgeCount > 0) {
    issues.push({
      code: "mesh.winding",
      severity: "critical",
      titleHe: "כיווני משטחים סותרים",
      detailHe:
        `${topology.inconsistentEdgeCount} קצוות שבהם שני המשטחים הסמוכים ` +
        "פונים לכיוונים מנוגדים — חלק מהמודל ״הפוך מבפנים״.",
      actionHe: "הפעילו תיקון רשת (תיקון כיוונים אוטומטי)",
    });
  }

  if (topology.signedVolumeMm3 < 0) {
    issues.push({
      code: "mesh.inverted",
      severity: "critical",
      titleHe: "המודל הפוך מבפנים",
      detailHe:
        "כל המשטחים פונים פנימה במקום החוצה. הסלייסר עלול להדפיס את החלל " +
        "במקום את הגוף.",
      actionHe: "הפעילו תיקון רשת (היפוך כיוונים)",
    });
  }

  if (topology.invalidTriangleCount > 0) {
    issues.push({
      code: "mesh.invalidTriangles",
      severity: "critical",
      titleHe: `${topology.invalidTriangleCount} משולשים פגומים`,
      detailHe:
        "משולשים שבהם אותו קודקוד מופיע פעמיים. אין להם משטח והם שוברים את " +
        "מבנה הרשת.",
      actionHe: "הפעילו תיקון רשת (ניקוי אוטומטי)",
    });
  }

  if (topology.degenerateTriangleCount > 0) {
    issues.push({
      code: "mesh.degenerate",
      severity: "warning",
      titleHe: `${topology.degenerateTriangleCount} משולשים דקיקים`,
      detailHe:
        "משולשים בעלי שטח אפס. הם אינם פוגמים באטימות המודל, אך מנפחים את " +
        "הקובץ ועלולים לגרום לשגיאות דיוק בחישובים.",
      actionHe: "הפעילו תיקון רשת (ניקוי אוטומטי)",
    });
  }

  if (topology.duplicateTriangleCount > 0) {
    issues.push({
      code: "mesh.duplicates",
      severity: "warning",
      titleHe: `${topology.duplicateTriangleCount} משולשים כפולים`,
      detailHe: "אותו משולש מופיע יותר מפעם אחת — מנפח את הקובץ ופוגע בתקינות.",
      actionHe: "הפעילו תיקון רשת (ניקוי אוטומטי)",
    });
  }

  if (topology.unusedVertexCount > 0) {
    issues.push({
      code: "mesh.unusedVertices",
      severity: "warning",
      titleHe: `${topology.unusedVertexCount} קודקודים יתומים`,
      detailHe: "קודקודים שאף משולש אינו משתמש בהם. מנפחים את הקובץ ללא צורך.",
      actionHe: "הפעילו תיקון רשת (ניקוי אוטומטי)",
    });
  }

  if (topology.componentCount > 1) {
    issues.push({
      code: "mesh.components",
      severity: "warning",
      titleHe: `${topology.componentCount} גופים נפרדים`,
      detailHe:
        "המודל מורכב מכמה חלקים שאינם מחוברים. ייתכן שאלו שאריות קטנות או " +
        "קליפות כלואות בתוך הגוף.",
      actionHe: "בדקו בכלי ״ניקוי רכיבים״ אילו חלקים למחוק",
    });
  }

  let selfIntersectionCount = 0;
  if (options.checkSelfIntersections !== false) {
    const result = findSelfIntersections(mesh);
    selfIntersectionCount = result.pairCount;
    if (result.pairCount > 0) {
      issues.push({
        code: "mesh.selfIntersection",
        severity: "critical",
        titleHe: `${result.truncated ? "מעל " : ""}${result.pairCount} חיתוכים עצמיים`,
        detailHe:
          "משטחים במודל חוצים זה את זה. הליבה הגאומטרית דוחה מודלים כאלה " +
          "והסלייסר יפיק תוצאה בלתי צפויה.",
        actionHe: "הפעילו ״בנייה מחדש (Voxel)״ — היא מפרקת חיתוכים עצמיים",
        location: result.locations[0],
      });
    }
  }

  if (!kernelAccepts && issues.length === 0) {
    // The structure looks fine but Manifold still refuses it — say so plainly
    // instead of implying the model is healthy.
    issues.push({
      code: "mesh.kernelRejected",
      severity: "critical",
      titleHe: "הליבה הגאומטרית דחתה את המודל",
      detailHe: `סטטוס: ${status}. לא זוהתה תקלה מבנית מוכרת.`,
      actionHe: "נסו ״בנייה מחדש (Voxel)״",
    });
  }

  return { topology, issues, kernelAccepts, kernelStatus: status, selfIntersectionCount };
}

export type RepairStage =
  | "weld"
  | "cleanTriangles"
  | "splitVertices"
  | "orient"
  | "fillHoles"
  | "removeShells"
  | "voxelRemesh";

export interface RepairStageReport {
  stage: RepairStage;
  /** Hebrew description of what this stage actually changed. */
  messageHe: string;
  changed: boolean;
}

export interface MeshRepairReport {
  succeeded: boolean;
  mesh: MeshData | null;
  stages: RepairStageReport[];
  messageHe: string;
  triangleCountBefore: number;
  triangleCountAfter: number;
}

export interface RepairOptions {
  /** Allow adding patch geometry to close holes. Default true. */
  fillHoles?: boolean;
  /** Allow deleting loose/interior shells. Default true. */
  removeShells?: boolean;
  /**
   * Allow the voxel rebuild when nothing else works. Default true. This is
   * the only stage that changes the whole surface, so the UI offers it as an
   * explicit opt-in for detail-sensitive models.
   */
  allowVoxelRemesh?: boolean;
  /** Voxel size for the rebuild stage, mm. */
  voxelSizeMm?: number;
  /** Skip filling holes bigger than this perimeter, mm. 0 = no limit. */
  maxHolePerimeterMm?: number;
  /**
   * Treat self-intersection as a defect worth repairing. Default true.
   *
   * This matters because Manifold's `ofMesh` validates TOPOLOGY only: two
   * interpenetrating shells are accepted as "NoError" even though the solid
   * they describe is ambiguous and slicers will double-count the overlap. So
   * kernel acceptance alone is not a sufficient success test, and when
   * self-intersections are present the pipeline must run through to the voxel
   * rebuild — the only stage that actually resolves them.
   */
  resolveSelfIntersections?: boolean;
}

/** True when the Manifold kernel accepts the mesh. */
async function kernelAccepts(mesh: MeshData): Promise<boolean> {
  if (mesh.indices.length === 0) return false;
  const kernel = await getGeometryKernel();
  const { solid, status } = kernel.fromMeshData(mesh);
  const ok = status === "NoError" && !solid.isEmpty();
  solid.dispose();
  return ok;
}

/** Run the staged repair pipeline. */
export async function repairMesh(
  input: MeshData,
  options: RepairOptions = {}
): Promise<MeshRepairReport> {
  const stages: RepairStageReport[] = [];
  const triangleCountBefore = input.indices.length / 3;
  let mesh = input;

  // Detected once up front: the scan is expensive and the earlier stages
  // (welding, winding, hole filling) cannot create or remove intersections.
  const checkIntersections = options.resolveSelfIntersections !== false;
  const initialIntersections = checkIntersections
    ? findSelfIntersections(input, 1).pairCount
    : 0;
  /** Set once the voxel rebuild has run, which is what resolves overlaps. */
  let intersectionsResolved = false;

  const finish = async (): Promise<MeshRepairReport | null> => {
    // Kernel acceptance is necessary but NOT sufficient — see
    // `resolveSelfIntersections`.
    if (initialIntersections > 0 && !intersectionsResolved) return null;
    if (!(await kernelAccepts(mesh))) return null;
    const changedStages = stages.filter((s) => s.changed);
    return {
      succeeded: true,
      mesh,
      stages,
      messageHe:
        changedStages.length === 0
          ? "הרשת הייתה תקינה — לא נדרש תיקון"
          : `הרשת תוקנה: ${changedStages.map((s) => s.messageHe).join("; ")}`,
      triangleCountBefore,
      triangleCountAfter: mesh.indices.length / 3,
    };
  };

  // Stage 0: already valid?
  const early = await finish();
  if (early) return early;

  // Stage 1 — weld coincident vertices (STL files share no vertices at all).
  {
    const before = mesh.positions.length / 3;
    const welded = weldMesh(mesh, 1e-5);
    const changed = welded.positions.length / 3 !== before;
    if (changed) mesh = welded;
    stages.push({
      stage: "weld",
      messageHe: changed
        ? `אוחו ${before - welded.positions.length / 3} קודקודים כפולים`
        : "לא נדרש איחוי קודקודים",
      changed,
    });
    const done = await finish();
    if (done) return done;
  }

  // Stage 2 — drop degenerate, duplicate and orphaned geometry.
  {
    const degenerate = removeDegenerateTriangles(mesh);
    const duplicates = removeDuplicateTriangles(degenerate.mesh);
    const orphans = removeUnusedVertices(duplicates.mesh);
    mesh = orphans.mesh;
    const parts: string[] = [];
    if (degenerate.removed > 0) parts.push(`${degenerate.removed} משולשים מנוונים`);
    if (duplicates.removed > 0) parts.push(`${duplicates.removed} משולשים כפולים`);
    if (orphans.removed > 0) parts.push(`${orphans.removed} קודקודים יתומים`);
    stages.push({
      stage: "cleanTriangles",
      messageHe: parts.length > 0 ? `הוסרו ${parts.join(", ")}` : "לא נמצאה פסולת גאומטרית",
      changed: parts.length > 0,
    });
    const done = await finish();
    if (done) return done;
  }

  // Stage 3 — split bowtie vertices.
  {
    const { mesh: split, split: count } = splitNonManifoldVertices(mesh);
    mesh = split;
    stages.push({
      stage: "splitVertices",
      messageHe:
        count > 0 ? `הופרדו ${count} קודקודי ״עניבת פרפר״` : "לא נמצאו קודקודים בעייתיים",
      changed: count > 0,
    });
    const done = await finish();
    if (done) return done;
  }

  // Stage 4 — consistent, outward-facing winding.
  {
    const { mesh: oriented, flipped } = orientConsistently(mesh);
    mesh = oriented;
    stages.push({
      stage: "orient",
      messageHe:
        flipped > 0 ? `תוקן כיוונם של ${flipped} משולשים` : "כיווני המשטחים היו תקינים",
      changed: flipped > 0,
    });
    const done = await finish();
    if (done) return done;
  }

  // Stage 5 — close the holes.
  if (options.fillHoles !== false) {
    const result = fillHoles(mesh, { maxPerimeterMm: options.maxHolePerimeterMm ?? 0 });
    mesh = result.mesh;
    const parts: string[] = [];
    if (result.filled > 0) {
      parts.push(`נסגרו ${result.filled} חורים (${result.trianglesAdded} משולשים חדשים)`);
    }
    if (result.skipped > 0) parts.push(`${result.skipped} חורים גדולים מדי — לא נסגרו`);
    stages.push({
      stage: "fillHoles",
      messageHe: parts.length > 0 ? parts.join(", ") : "לא נמצאו חורים",
      changed: result.filled > 0,
    });
    const done = await finish();
    if (done) return done;
  }

  // Stage 6 — drop loose fragments and trapped interior shells.
  if (options.removeShells !== false) {
    const result = cleanupComponents(mesh);
    mesh = result.mesh;
    const parts: string[] = [];
    if (result.smallShellsRemoved > 0) parts.push(`${result.smallShellsRemoved} שאריות קטנות`);
    if (result.interiorShellsRemoved > 0) {
      parts.push(`${result.interiorShellsRemoved} קליפות פנימיות כלואות`);
    }
    stages.push({
      stage: "removeShells",
      messageHe: parts.length > 0 ? `הוסרו ${parts.join(" ו-")}` : "לא נמצאו רכיבים מיותרים",
      changed: parts.length > 0,
    });
    const done = await finish();
    if (done) return done;
  }

  // Stage 7 — rebuild from a distance field. Always works, always costs detail.
  if (options.allowVoxelRemesh !== false) {
    try {
      const result = await voxelRemesh(mesh, { voxelSizeMm: options.voxelSizeMm });
      mesh = result.mesh;
      intersectionsResolved = true;
      const intersectionNote =
        initialIntersections > 0 ? " ופורקו החיתוכים העצמיים" : "";
      stages.push({
        stage: "voxelRemesh",
        messageHe:
          `המודל נבנה מחדש ברזולוציית ${formatMm(result.voxelSizeMm)} מ״מ ` +
          `(${result.triangleCount.toLocaleString("he-IL")} משולשים)${intersectionNote} — ` +
          "פרטים דקים מרזולוציה זו אבדו",
        changed: true,
      });
      const done = await finish();
      if (done) return done;
    } catch (err) {
      stages.push({
        stage: "voxelRemesh",
        messageHe: `הבנייה מחדש נכשלה: ${err instanceof Error ? err.message : "שגיאה"}`,
        changed: false,
      });
    }
  }

  return {
    succeeded: false,
    mesh: null,
    stages,
    messageHe:
      "לא ניתן היה להפוך את המודל לגוף תקין. נסו להקטין את רזולוציית הבנייה " +
      "מחדש, או לתקן את הקובץ בתוכנה ייעודית.",
    triangleCountBefore,
    triangleCountAfter: 0,
  };
}
