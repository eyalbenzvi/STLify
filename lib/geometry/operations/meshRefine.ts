/**
 * Mesh refinement operations: thicken (morphological dilation), smooth
 * (Taubin λ/μ — volume-preserving compared to plain Laplacian), simplify
 * (Manifold edge-collapse) and a best-effort repair for imported meshes.
 *
 * Smoothing runs on raw MeshData and is re-validated by converting back
 * through the manifold gate — a smooth that breaks the mesh is rejected,
 * never silently exported.
 */

import type {
  DesignDocument,
  ImportedMeshLayer,
  ShapeLayer,
  SimplifySettings,
  SmoothSettings,
} from "@/types/design";
import { getGeometryKernel } from "../kernel";
import type { MeshData } from "../meshData";
import { materializeWorldSolid, OpError, solidToResultLayer, type OpHooks } from "./layerOps";

// ---------------------------------------------------------------------------
// Thicken
// ---------------------------------------------------------------------------

export interface ThickenOutcome {
  layer: ImportedMeshLayer;
  warningsHe: string[];
}

const DILATION_PROXY_MAX_TRIS = 6000;

/** Thicken a body by dilating it with a sphere of the given radius. */
export async function performThicken(
  document: DesignDocument,
  layer: ShapeLayer,
  thicknessMm: number,
  hooks: OpHooks = {}
): Promise<ThickenOutcome> {
  if (thicknessMm <= 0 || thicknessMm > 20) {
    throw new OpError("עובי ההוספה חייב להיות בין 0.1 ל-20 מ״מ");
  }
  const kernel = await getGeometryKernel();
  hooks.throwIfCancelled?.();
  hooks.onProgress?.(0.15, "מכין את הגוף");
  let solid = await materializeWorldSolid(kernel, document, layer);
  if (!solid || solid.isEmpty()) {
    solid?.dispose();
    throw new OpError(`לשכבה "${layer.name}" אין גאומטריה`);
  }
  const warningsHe: string[] = [
    "העיבוי מנפח את הגוף בכל הכיוונים — פרטים דקים עשויים להתעגל ולהתמזג",
  ];
  if (solid.numTriangles() > DILATION_PROXY_MAX_TRIS) {
    solid = solid.simplify(Math.min(thicknessMm * 0.25, 0.4));
    if (solid.numTriangles() > DILATION_PROXY_MAX_TRIS * 4) {
      solid.dispose();
      throw new OpError("המודל מורכב מדי לעיבוי בדפדפן", [
        "פשטו את הרשת ונסו שוב",
      ]);
    }
    warningsHe.push("המודל פושט מעט לפני העיבוי כדי לאפשר את החישוב");
  }
  // Last safe cancel point before the Minkowski dilation.
  try {
    hooks.throwIfCancelled?.();
  } catch (err) {
    solid.dispose();
    throw err;
  }
  hooks.onProgress?.(0.4, "מנפח את הגוף");
  const ball = kernel.sphere(thicknessMm, 8);
  const result = solid.minkowskiSum(ball);
  if (result.status() !== "NoError" || result.isEmpty()) {
    result.dispose();
    throw new OpError("העיבוי נכשל עקב גאומטריה מורכבת");
  }
  const resultLayer = solidToResultLayer(result, {
    nameHe: `${layer.name} — מעובה`,
    provenance: {
      kind: "thickenResult",
      descriptionHe: `עיבוי ב-${thicknessMm} מ״מ`,
      sourceLayerIds: [layer.id],
    },
    materialSlotId: layer.materialSlotId,
  });
  return { layer: resultLayer, warningsHe };
}

// ---------------------------------------------------------------------------
// Smooth (Taubin)
// ---------------------------------------------------------------------------

export const SMOOTH_ITERATIONS: Record<SmoothSettings["strength"], number> = {
  light: 2,
  standard: 5,
  strong: 10,
};

/**
 * Taubin smoothing on indexed mesh data. `lockedVertices` (from the feature
 * detection) are kept in place so sharp edges survive when requested.
 */
export function taubinSmooth(
  mesh: MeshData,
  iterations: number,
  locked: Uint8Array | null
): MeshData {
  const vertexCount = mesh.positions.length / 3;
  const neighbors: number[][] = Array.from({ length: vertexCount }, () => []);
  const seen = new Set<number>();
  const addEdge = (a: number, b: number) => {
    const key = a < b ? a * vertexCount + b : b * vertexCount + a;
    if (seen.has(key)) return;
    seen.add(key);
    neighbors[a].push(b);
    neighbors[b].push(a);
  };
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i];
    const b = mesh.indices[i + 1];
    const c = mesh.indices[i + 2];
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  let positions = new Float32Array(mesh.positions);
  let scratch = new Float32Array(positions.length);
  const LAMBDA = 0.5;
  const MU = -0.53;

  const pass = (factor: number) => {
    for (let v = 0; v < vertexCount; v++) {
      const base = v * 3;
      const nbrs = neighbors[v];
      if (nbrs.length === 0 || (locked && locked[v])) {
        scratch[base] = positions[base];
        scratch[base + 1] = positions[base + 1];
        scratch[base + 2] = positions[base + 2];
        continue;
      }
      let ax = 0,
        ay = 0,
        az = 0;
      for (const n of nbrs) {
        ax += positions[n * 3];
        ay += positions[n * 3 + 1];
        az += positions[n * 3 + 2];
      }
      ax /= nbrs.length;
      ay /= nbrs.length;
      az /= nbrs.length;
      scratch[base] = positions[base] + factor * (ax - positions[base]);
      scratch[base + 1] = positions[base + 1] + factor * (ay - positions[base + 1]);
      scratch[base + 2] = positions[base + 2] + factor * (az - positions[base + 2]);
    }
    const tmp = positions;
    positions = scratch;
    scratch = tmp;
  };

  for (let i = 0; i < iterations; i++) {
    pass(LAMBDA);
    pass(MU);
  }
  return { positions, indices: new Uint32Array(mesh.indices) };
}

/** Mark vertices on edges whose dihedral angle exceeds the threshold. */
export function detectFeatureVertices(mesh: MeshData, angleDeg: number): Uint8Array {
  const vertexCount = mesh.positions.length / 3;
  const locked = new Uint8Array(vertexCount);
  const triCount = mesh.indices.length / 3;
  const normals = new Float32Array(triCount * 3);
  const p = mesh.positions;
  for (let t = 0; t < triCount; t++) {
    const a = mesh.indices[t * 3] * 3;
    const b = mesh.indices[t * 3 + 1] * 3;
    const c = mesh.indices[t * 3 + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[t * 3] = nx / len;
    normals[t * 3 + 1] = ny / len;
    normals[t * 3 + 2] = nz / len;
  }
  // Edge → adjacent triangles.
  const edgeTri = new Map<string, number>();
  const threshold = Math.cos((angleDeg * Math.PI) / 180);
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = mesh.indices[t * 3 + e];
      const b = mesh.indices[t * 3 + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const other = edgeTri.get(key);
      if (other === undefined) {
        edgeTri.set(key, t);
        continue;
      }
      const dot =
        normals[t * 3] * normals[other * 3] +
        normals[t * 3 + 1] * normals[other * 3 + 1] +
        normals[t * 3 + 2] * normals[other * 3 + 2];
      if (dot < threshold) {
        locked[a] = 1;
        locked[b] = 1;
      }
    }
  }
  return locked;
}

export interface SmoothOutcome {
  layer: ImportedMeshLayer;
  trianglesBefore: number;
  trianglesAfter: number;
  warningsHe: string[];
}

export async function performSmooth(
  document: DesignDocument,
  layer: ShapeLayer,
  settings: SmoothSettings
): Promise<SmoothOutcome> {
  const iterations =
    settings.iterations > 0 ? Math.min(settings.iterations, 30) : SMOOTH_ITERATIONS[settings.strength];
  const kernel = await getGeometryKernel();
  const solid = await materializeWorldSolid(kernel, document, layer);
  if (!solid || solid.isEmpty()) {
    solid?.dispose();
    throw new OpError(`לשכבה "${layer.name}" אין גאומטריה`);
  }
  const mesh = solid.toMeshData();
  const trianglesBefore = solid.numTriangles();
  solid.dispose();

  if (mesh.indices.length / 3 > 400_000) {
    throw new OpError("הרשת גדולה מדי להחלקה בדפדפן (מעל 400 אלף משולשים)", [
      "פשטו את הרשת תחילה",
    ]);
  }

  const locked = settings.preserveFeatures ? detectFeatureVertices(mesh, 40) : null;
  const smoothed = taubinSmooth(mesh, iterations, locked);
  const { solid: resultSolid, status } = kernel.fromMeshData(smoothed);
  if (status !== "NoError" || resultSolid.isEmpty()) {
    resultSolid.dispose();
    throw new OpError("ההחלקה שברה את אטימות הרשת — הפעולה בוטלה", [
      "נסו פחות איטרציות או הפעילו ״שימור פינות״",
    ]);
  }

  const warningsHe: string[] = [];
  if (!settings.preserveFeatures) {
    warningsHe.push("החלקה ללא שימור פינות מעגלת קצוות חדים");
  }

  const resultLayer = solidToResultLayer(resultSolid, {
    nameHe: `${layer.name} — מוחלק`,
    provenance: {
      kind: "smoothResult",
      descriptionHe: `החלקה (${iterations} איטרציות)`,
      sourceLayerIds: [layer.id],
    },
    materialSlotId: layer.materialSlotId,
  });
  return {
    layer: resultLayer,
    trianglesBefore,
    trianglesAfter: resultLayer ? smoothed.indices.length / 3 : 0,
    warningsHe,
  };
}

// ---------------------------------------------------------------------------
// Simplify
// ---------------------------------------------------------------------------

export const SIMPLIFY_PRESET_TOLERANCE: Record<
  Exclude<SimplifySettings["preset"], "custom">,
  number
> = {
  draft: 0.05,
  standard: 0.15,
  aggressive: 0.5,
};

export interface SimplifyOutcome {
  layer: ImportedMeshLayer;
  trianglesBefore: number;
  trianglesAfter: number;
  warningsHe: string[];
}

export async function performSimplify(
  document: DesignDocument,
  layer: ShapeLayer,
  settings: SimplifySettings,
  targetTriangles?: number
): Promise<SimplifyOutcome> {
  const kernel = await getGeometryKernel();
  let solid = await materializeWorldSolid(kernel, document, layer);
  if (!solid || solid.isEmpty()) {
    solid?.dispose();
    throw new OpError(`לשכבה "${layer.name}" אין גאומטריה`);
  }
  const trianglesBefore = solid.numTriangles();
  let tolerance =
    settings.preset === "custom"
      ? settings.toleranceMm
      : SIMPLIFY_PRESET_TOLERANCE[settings.preset];
  if (!(tolerance > 0) || tolerance > 5) {
    solid.dispose();
    throw new OpError("סבילות הפישוט חייבת להיות בין 0.01 ל-5 מ״מ");
  }

  solid = solid.simplify(tolerance);
  // Optional triangle-count target: raise tolerance until reached (bounded).
  if (targetTriangles && targetTriangles > 100) {
    let rounds = 0;
    while (solid.numTriangles() > targetTriangles && rounds < 6) {
      tolerance *= 1.8;
      solid = solid.simplify(tolerance);
      rounds++;
    }
  }

  if (solid.status() !== "NoError" || solid.isEmpty()) {
    solid.dispose();
    throw new OpError("הפישוט יצר גאומטריה לא תקינה — הפעולה בוטלה");
  }

  const trianglesAfter = solid.numTriangles();
  const warningsHe: string[] = [];
  if (tolerance >= 0.3) {
    warningsHe.push("פישוט אגרסיבי עלול לפגוע בטקסט קטן, חורים ופרטים עדינים");
  }
  if (trianglesAfter >= trianglesBefore) {
    warningsHe.push("הפישוט לא הקטין את מספר המשולשים — הרשת כבר פשוטה");
  }

  const resultLayer = solidToResultLayer(solid, {
    nameHe: `${layer.name} — מפושט`,
    provenance: {
      kind: "simplifyResult",
      descriptionHe: `פישוט (סבילות ${tolerance.toFixed(2)} מ״מ)`,
      sourceLayerIds: [layer.id],
    },
    materialSlotId: layer.materialSlotId,
  });
  return { layer: resultLayer, trianglesBefore, trianglesAfter, warningsHe };
}
