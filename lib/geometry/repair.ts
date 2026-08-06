/**
 * Mesh-level inspection and automatic repair.
 *
 * The V2 pipeline generates geometry through the Manifold kernel, which is
 * manifold by construction — so repair usually finds nothing. It exists as
 * defence in depth for edge cases (numerically degenerate outputs) and to
 * report honest before/after numbers. Repair never runs silently: the UI
 * explains what will be attempted, records an undo step first, and reports
 * the outcome.
 */

import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getGeometryKernel } from "./kernel";

export interface MeshInspection {
  triangleCount: number;
  duplicateVertexCount: number;
  degenerateTriangleCount: number;
  openEdgeCount: number;
  nonManifoldEdgeCount: number;
  watertight: boolean;
}

export interface RepairOutcome {
  ok: boolean;
  before: MeshInspection;
  after: MeshInspection | null;
  /** Hebrew description of what happened. */
  message: string;
  /** Repaired geometry (new object) when a change was made. */
  geometry: THREE.BufferGeometry | null;
}

const WELD_TOLERANCE = 1e-4;
const DEGENERATE_AREA = 1e-10;

/** Inspect a geometry without changing it. */
export function inspectMesh(geometry: THREE.BufferGeometry): MeshInspection {
  const welded = weldedCopy(geometry);
  const index = welded.index;
  const position = welded.getAttribute("position");
  const originalVerts = geometry.index
    ? geometry.getAttribute("position").count
    : geometry.getAttribute("position").count;
  const duplicateVertexCount = Math.max(0, originalVerts - position.count);

  let triangleCount = 0;
  let degenerate = 0;
  let openEdges = 0;
  let nonManifoldEdges = 0;

  if (index) {
    triangleCount = index.count / 3;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const edgeUse = new Map<string, number>();
    for (let i = 0; i < index.count; i += 3) {
      const ia = index.getX(i);
      const ib = index.getX(i + 1);
      const ic = index.getX(i + 2);
      a.fromBufferAttribute(position, ia);
      b.fromBufferAttribute(position, ib);
      c.fromBufferAttribute(position, ic);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const area = ab.cross(ac).length() / 2;
      if (area < DEGENERATE_AREA || ia === ib || ib === ic || ia === ic) degenerate++;
      for (const [u, v] of [
        [ia, ib],
        [ib, ic],
        [ic, ia],
      ]) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
      }
    }
    for (const count of edgeUse.values()) {
      if (count === 1) openEdges++;
      else if (count > 2) nonManifoldEdges++;
    }
  }

  welded.dispose();
  return {
    triangleCount,
    duplicateVertexCount,
    degenerateTriangleCount: degenerate,
    openEdgeCount: openEdges,
    nonManifoldEdgeCount: nonManifoldEdges,
    watertight: openEdges === 0 && nonManifoldEdges === 0,
  };
}

/** Steps the repair attempts, in order (shown to the user beforehand). */
export const REPAIR_STEPS_HE = [
  "איחוד קודקודים כפולים",
  "הסרת משולשים מנוונים (שטח אפסי)",
  "חישוב מחדש של נורמלים",
  "המרה מחדש דרך מנוע Manifold לקבלת מודל אטום",
];

/**
 * Attempt to repair a geometry. Returns a NEW geometry when changes were
 * made; the input is never mutated.
 */
export async function repairGeometry(
  geometry: THREE.BufferGeometry
): Promise<RepairOutcome> {
  const before = inspectMesh(geometry);
  if (before.watertight && before.degenerateTriangleCount === 0) {
    return {
      ok: true,
      before,
      after: before,
      message: "לא נמצאו בעיות ברשת המשולשים — אין צורך בתיקון",
      geometry: null,
    };
  }

  try {
    // 1+2: weld and drop degenerates.
    const welded = weldedCopy(geometry);
    const cleaned = dropDegenerateTriangles(welded);
    welded.dispose();

    // 4: round-trip through Manifold when possible (guarantees manifoldness).
    let repaired = cleaned;
    try {
      const kernel = await getGeometryKernel();
      const position = cleaned.getAttribute("position");
      const index = cleaned.index;
      if (index) {
        const solid = kernel.fromMeshArrays({
          vertProperties: new Float32Array(position.array),
          triVerts: new Uint32Array(index.array),
        });
        repaired = solid.toGeometry();
        solid.dispose();
        cleaned.dispose();
      }
    } catch {
      // Manifold rejected the mesh — keep the weld/degenerate cleanup result.
    }

    repaired.computeVertexNormals(); // step 3
    const after = inspectMesh(repaired);

    if (!after.watertight) {
      repaired.dispose();
      return {
        ok: false,
        before,
        after,
        message:
          "התיקון האוטומטי לא הצליח לסגור את המודל. העיצוב לא שונה — נסו לשנות פרמטרים (עומק, מיקום או גודל)",
        geometry: null,
      };
    }

    return {
      ok: true,
      before,
      after,
      message: "התיקון הושלם בהצלחה",
      geometry: repaired,
    };
  } catch (err) {
    return {
      ok: false,
      before,
      after: null,
      message: `התיקון נכשל: ${err instanceof Error ? err.message : String(err)}. העיצוב לא שונה`,
      geometry: null,
    };
  }
}

function weldedCopy(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const positionOnly = new THREE.BufferGeometry();
  positionOnly.setAttribute("position", geometry.getAttribute("position").clone());
  if (geometry.index) positionOnly.setIndex(geometry.index.clone());
  const nonIndexed = positionOnly.index ? positionOnly : positionOnly;
  return mergeVertices(nonIndexed, WELD_TOLERANCE);
}

function dropDegenerateTriangles(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const index = geometry.index;
  if (!index) return geometry.clone();
  const position = geometry.getAttribute("position");
  const kept: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i);
    const ib = index.getX(i + 1);
    const ic = index.getX(i + 2);
    if (ia === ib || ib === ic || ia === ic) continue;
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    if (ab.cross(ac).length() / 2 < DEGENERATE_AREA) continue;
    kept.push(ia, ib, ic);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", position.clone());
  out.setIndex(kept);
  return out;
}
