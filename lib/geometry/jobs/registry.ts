/**
 * The geometry job registry: heavy operations addressable by name.
 *
 * README's standing limitation was that geometry runs on the main thread, so
 * a hollow or a lattice freezes the tab. Moving work off-thread needs one
 * thing first: operations that can be *named and parameterised* rather than
 * called directly, because a worker can only receive a message, not a
 * closure.
 *
 * Every job takes a plain JSON payload plus transferable `MeshData` and
 * returns the same, so the identical code runs in a worker or in-process.
 * `runGeometryJob` picks whichever is available (see ./client.ts).
 */

import type {
  BooleanOperation,
  DesignDocument,
  DrainHoleDefinition,
  HollowSettings,
  ImportedMeshLayer,
  ModelIssue,
  ShapeLayer,
} from "@/types/design";
import { isShapeLayer } from "@/types/design";
import { getGeometryKernel } from "../kernel";
import { buildDocument, type DocumentBuildStatus, type PrintablePart } from "../buildDocument";
import { getMesh, storeMesh } from "../meshStore";
import type { MeshData } from "../meshData";
import { performBoolean } from "../operations/booleans";
import { performDrainHoles, performHollow } from "../operations/hollow";
import { performThicken } from "../operations/meshRefine";
import { analyzeThickness, type ThicknessAnalysis } from "../analysis/thickness";
import { measureSliceMetrics, type SliceMetrics } from "../analysis/estimateSliced";
import { buildSupports, type SupportGenerationResult, type SupportSettings } from "../analysis/supports";
import { cleanupComponents } from "../repair/cleanup";
import { diagnoseMesh, repairMesh, type RepairOptions } from "../repair/diagnose";
import { voxelRemesh } from "../repair/voxelRemesh";
import { isotropicRemesh, type RemeshSettings } from "../operations/remesh";
import { findSelfIntersections } from "../repair/selfIntersection";
import { latticeFill, type LatticeSettings } from "../operations/lattice";
import { roundEdges, shellSolid, type FilletSettings, type ShellSettings } from "../operations/fillet";
import { filletRegion } from "../operations/filletRegion";

/** Progress callback shape shared by both execution paths. */
export type ProgressReporter = (fraction: number, labelHe: string) => void;

export interface JobContext {
  onProgress: ProgressReporter;
  /** Throws if the job has been cancelled; call between expensive stages. */
  throwIfCancelled: () => void;
}

/** Raised when a job is cancelled; callers treat it as "no result", not an error. */
export class JobCancelledError extends Error {
  constructor() {
    super("job cancelled");
    this.name = "JobCancelledError";
  }
}

/**
 * A PrintablePart in wire form: THREE.Matrix4 does not survive structured
 * clone (it would arrive as a plain object), so the placement crosses the
 * boundary as its 16 column-major elements and is revived by the client.
 */
export interface WirePrintablePart extends Omit<PrintablePart, "worldMatrix"> {
  worldMatrixElements: number[];
}

export interface BuildDocumentJobResult {
  status: DocumentBuildStatus;
  issues: ModelIssue[];
  parts: WirePrintablePart[];
}

/**
 * Wire form of an operation that produced a new ImportedMeshLayer: the layer
 * references its mesh by id, and `resultMesh` carries the payload so the
 * main thread can store it under the same id (the worker's store and the
 * main store are separate).
 */
export interface DocOpJobResult {
  layer: ImportedMeshLayer;
  resultMesh: MeshData;
  warningsHe: string[];
}

/** Payload core shared by the document-level operation jobs. */
interface DocOpPayloadBase {
  document: DesignDocument;
  /** Mesh payloads the executing side may not have yet (see meshSync.ts). */
  meshes: { id: string; mesh: MeshData }[];
}

/** Resolve layer ids to shape layers or fail with a clear message. */
function shapeLayersById(document: DesignDocument, layerIds: string[]): ShapeLayer[] {
  return layerIds.map((id) => {
    const layer = document.layers.find((l) => l.id === id);
    if (!layer || !isShapeLayer(layer)) {
      throw new Error("שכבת המקור לא נמצאה במסמך — רעננו ונסו שוב");
    }
    return layer;
  });
}

/** Package an op outcome layer + its mesh payload for the wire. */
function withResultMesh<T extends { layer: ImportedMeshLayer }>(
  outcome: T
): T & { resultMesh: MeshData } {
  const resultMesh = getMesh(outcome.layer.meshId);
  if (!resultMesh) throw new Error("תוצאת הפעולה לא נמצאה בזיכרון");
  return { ...outcome, resultMesh };
}

export interface GeometryJobMap {
  docBoolean: {
    payload: DocOpPayloadBase & { layerIds: string[]; kind: BooleanOperation["kind"] };
    result: DocOpJobResult;
  };
  docHollow: {
    payload: DocOpPayloadBase & { layerId: string; settings: HollowSettings };
    result: DocOpJobResult & {
      originalVolumeMm3: number;
      hollowVolumeMm3: number;
      savedFraction: number;
    };
  };
  docThicken: {
    payload: DocOpPayloadBase & { layerId: string; thicknessMm: number };
    result: DocOpJobResult;
  };
  docDrainHoles: {
    payload: DocOpPayloadBase & { layerId: string; holes: DrainHoleDefinition[] };
    result: DocOpJobResult & { reachedCavity: boolean[] };
  };
  analyzeThickness: {
    payload: {
      mesh: MeshData;
      minWallMm: number;
      minFeatureMm: number;
      maxSamples?: number;
    };
    result: ThicknessAnalysis;
  };
  measureSlices: {
    payload: { mesh: MeshData; layerHeightMm: number };
    result: SliceMetrics;
  };
  buildSupports: {
    payload: { mesh: MeshData; settings: SupportSettings };
    result: { mesh: MeshData | null; result: SupportGenerationResult };
  };
  buildDocument: {
    payload: {
      document: DesignDocument;
      /**
       * Mesh payloads the executing side may not have yet. The worker keeps
       * its own mesh store, so a mesh travels across ONCE per session; the
       * in-process path re-stores them under the same ids (idempotent).
       */
      meshes: { id: string; mesh: MeshData }[];
    };
    result: BuildDocumentJobResult;
  };
  repairMesh: {
    payload: { mesh: MeshData; options: RepairOptions };
    result: Awaited<ReturnType<typeof repairMesh>>;
  };
  diagnoseMesh: {
    payload: { mesh: MeshData };
    result: Awaited<ReturnType<typeof diagnoseMesh>>;
  };
  voxelRemesh: {
    payload: { mesh: MeshData; voxelSizeMm?: number; offsetMm?: number };
    result: { mesh: MeshData; voxelSizeMm: number; triangleCount: number };
  };
  isotropicRemesh: {
    payload: { mesh: MeshData; settings: RemeshSettings };
    result: ReturnType<typeof isotropicRemesh>;
  };
  selfIntersections: {
    payload: { mesh: MeshData };
    result: ReturnType<typeof findSelfIntersections>;
  };
  cleanupComponents: {
    payload: { mesh: MeshData };
    result: ReturnType<typeof cleanupComponents>;
  };
  latticeFill: {
    payload: { mesh: MeshData; settings: LatticeSettings };
    result: { mesh: MeshData; savedFraction: number; warningsHe: string[] };
  };
  fillet: {
    payload: { mesh: MeshData; settings: FilletSettings };
    result: { mesh: MeshData; warningsHe: string[] };
  };
  filletRegion: {
    payload: { mesh: MeshData; regionTriangles: number[]; settings: FilletSettings };
    result: { mesh: MeshData; warningsHe: string[] };
  };
  shell: {
    payload: { mesh: MeshData; settings: ShellSettings };
    result: { mesh: MeshData; warningsHe: string[] };
  };
}

export type GeometryJobName = keyof GeometryJobMap;

type JobHandler<K extends GeometryJobName> = (
  payload: GeometryJobMap[K]["payload"],
  context: JobContext
) => Promise<GeometryJobMap[K]["result"]>;

type Handlers = { [K in GeometryJobName]: JobHandler<K> };

/** Load a mesh into the kernel or fail with a clear message. */
async function solidFrom(mesh: MeshData) {
  const kernel = await getGeometryKernel();
  const { solid, status } = kernel.fromMeshData(mesh);
  if (status !== "NoError" || solid.isEmpty()) {
    solid.dispose();
    throw new Error(`הרשת אינה תקינה (${status}) — הפעילו ״תיקון רשת״ תחילה`);
  }
  return { kernel, solid };
}

export const JOB_HANDLERS: Handlers = {
  docBoolean: async ({ document, meshes, layerIds, kind }, ctx) => {
    for (const { id, mesh } of meshes) storeMesh(mesh, id);
    const layers = shapeLayersById(document, layerIds);
    const outcome = await performBoolean(document, layers, kind, {
      onProgress: ctx.onProgress,
      throwIfCancelled: ctx.throwIfCancelled,
    });
    ctx.onProgress(1, "הושלם");
    return withResultMesh(outcome);
  },

  docHollow: async ({ document, meshes, layerId, settings }, ctx) => {
    for (const { id, mesh } of meshes) storeMesh(mesh, id);
    const [layer] = shapeLayersById(document, [layerId]);
    const outcome = await performHollow(document, layer, settings, {
      onProgress: ctx.onProgress,
      throwIfCancelled: ctx.throwIfCancelled,
    });
    ctx.onProgress(1, "הושלם");
    return withResultMesh(outcome);
  },

  docThicken: async ({ document, meshes, layerId, thicknessMm }, ctx) => {
    for (const { id, mesh } of meshes) storeMesh(mesh, id);
    const [layer] = shapeLayersById(document, [layerId]);
    const outcome = await performThicken(document, layer, thicknessMm, {
      onProgress: ctx.onProgress,
      throwIfCancelled: ctx.throwIfCancelled,
    });
    ctx.onProgress(1, "הושלם");
    return withResultMesh(outcome);
  },

  docDrainHoles: async ({ document, meshes, layerId, holes }, ctx) => {
    for (const { id, mesh } of meshes) storeMesh(mesh, id);
    const [layer] = shapeLayersById(document, [layerId]);
    const outcome = await performDrainHoles(document, layer, holes, {
      onProgress: ctx.onProgress,
      throwIfCancelled: ctx.throwIfCancelled,
    });
    ctx.onProgress(1, "הושלם");
    return withResultMesh(outcome);
  },

  analyzeThickness: async ({ mesh, minWallMm, minFeatureMm, maxSamples }, ctx) => {
    ctx.onProgress(0.1, "טוען את הגוף");
    const kernel = await getGeometryKernel();
    const { solid, status } = kernel.fromMeshData(mesh);
    if (status !== "NoError") {
      solid.dispose();
      throw new Error(`הרשת אינה תקינה (${status}) — לא ניתן לדגום עובי`);
    }
    ctx.throwIfCancelled();
    ctx.onProgress(0.3, "דוגם עובי דופן");
    try {
      const analysis = analyzeThickness(solid, mesh, { minWallMm, minFeatureMm, maxSamples });
      ctx.onProgress(1, "הושלם");
      return analysis;
    } finally {
      solid.dispose();
    }
  },

  measureSlices: async ({ mesh, layerHeightMm }, ctx) => {
    ctx.onProgress(0.1, "פורס את הגוף");
    const kernel = await getGeometryKernel();
    const { solid, status } = kernel.fromMeshData(mesh);
    if (status !== "NoError") {
      solid.dispose();
      throw new Error(`הרשת אינה תקינה (${status}) — לא ניתן לפרוס`);
    }
    ctx.throwIfCancelled();
    try {
      const metrics = measureSliceMetrics(solid, layerHeightMm);
      ctx.onProgress(1, "הושלם");
      return metrics;
    } finally {
      solid.dispose();
    }
  },

  buildSupports: async ({ mesh, settings }, ctx) => {
    const kernel = await getGeometryKernel();
    const { solid, result } = buildSupports(kernel, mesh, settings, {
      onProgress: ctx.onProgress,
      throwIfCancelled: ctx.throwIfCancelled,
    });
    const out = solid ? solid.toMeshData() : null;
    solid?.dispose();
    ctx.onProgress(1, "הושלם");
    return { mesh: out, result };
  },

  buildDocument: async ({ document, meshes }, ctx) => {
    // Seed this thread's mesh store with payloads it has not seen. Layers
    // reference meshes by id; the store is thread-local module state.
    for (const { id, mesh } of meshes) storeMesh(mesh, id);
    ctx.throwIfCancelled();
    const result = await buildDocument(document, {
      onProgress: ctx.onProgress,
      throwIfCancelled: ctx.throwIfCancelled,
    });
    ctx.onProgress(1, "הושלם");
    return {
      status: result.status,
      issues: result.issues,
      parts: result.parts.map((part) => {
        const { worldMatrix, ...rest } = part;
        return { ...rest, worldMatrixElements: worldMatrix.toArray() as number[] };
      }),
    };
  },

  repairMesh: async ({ mesh, options }, ctx) => {
    ctx.onProgress(0.05, "מנתח את הרשת");
    ctx.throwIfCancelled();
    const report = await repairMesh(mesh, options);
    ctx.onProgress(1, "הושלם");
    return report;
  },

  diagnoseMesh: async ({ mesh }, ctx) => {
    ctx.onProgress(0.1, "בודק טופולוגיה");
    ctx.throwIfCancelled();
    const diagnosis = await diagnoseMesh(mesh);
    ctx.onProgress(1, "הושלם");
    return diagnosis;
  },

  voxelRemesh: async ({ mesh, voxelSizeMm, offsetMm }, ctx) => {
    ctx.onProgress(0.1, "בונה שדה מרחק");
    ctx.throwIfCancelled();
    const result = await voxelRemesh(mesh, { voxelSizeMm, offsetMm });
    ctx.onProgress(1, "הושלם");
    return {
      mesh: result.mesh,
      voxelSizeMm: result.voxelSizeMm,
      triangleCount: result.triangleCount,
    };
  },

  isotropicRemesh: async ({ mesh, settings }, ctx) => {
    ctx.onProgress(0.1, "מרשת מחדש");
    ctx.throwIfCancelled();
    return isotropicRemesh(mesh, settings);
  },

  selfIntersections: async ({ mesh }, ctx) => {
    ctx.onProgress(0.1, "מחפש חיתוכים עצמיים");
    ctx.throwIfCancelled();
    return findSelfIntersections(mesh);
  },

  cleanupComponents: async ({ mesh }, ctx) => {
    ctx.onProgress(0.1, "מנקה רכיבים");
    ctx.throwIfCancelled();
    return cleanupComponents(mesh);
  },

  latticeFill: async ({ mesh, settings }, ctx) => {
    ctx.onProgress(0.1, "מכין את הגוף");
    const { kernel, solid } = await solidFrom(mesh);
    ctx.throwIfCancelled();
    ctx.onProgress(0.3, "בונה סריג");
    const outcome = latticeFill(kernel, solid, settings);
    const out = outcome.solid.toMeshData();
    outcome.solid.dispose();
    ctx.onProgress(1, "הושלם");
    return {
      mesh: out,
      savedFraction: outcome.savedFraction,
      warningsHe: outcome.warningsHe,
    };
  },

  fillet: async ({ mesh, settings }, ctx) => {
    ctx.onProgress(0.1, "מכין את הגוף");
    const { kernel, solid } = await solidFrom(mesh);
    ctx.throwIfCancelled();
    ctx.onProgress(0.3, "מעגל קצוות");
    const outcome = roundEdges(kernel, solid, settings);
    const out = outcome.solid.toMeshData();
    outcome.solid.dispose();
    ctx.onProgress(1, "הושלם");
    return { mesh: out, warningsHe: outcome.warningsHe };
  },

  filletRegion: async ({ mesh, regionTriangles, settings }, ctx) => {
    ctx.onProgress(0.1, "מכין את הגוף");
    const kernel = await getGeometryKernel();
    ctx.throwIfCancelled();
    ctx.onProgress(0.3, "מעגל את האזור הנבחר");
    const outcome = filletRegion(kernel, mesh, new Set(regionTriangles), settings);
    ctx.onProgress(1, "הושלם");
    return outcome;
  },

  shell: async ({ mesh, settings }, ctx) => {
    ctx.onProgress(0.1, "מכין את הגוף");
    const { kernel, solid } = await solidFrom(mesh);
    ctx.throwIfCancelled();
    ctx.onProgress(0.3, "מחלל");
    const outcome = shellSolid(kernel, solid, settings);
    const out = outcome.solid.toMeshData();
    outcome.solid.dispose();
    ctx.onProgress(1, "הושלם");
    return { mesh: out, warningsHe: outcome.warningsHe };
  },
};

/** Run a job in the current thread. Used by the worker AND as the fallback. */
export async function executeJob<K extends GeometryJobName>(
  name: K,
  payload: GeometryJobMap[K]["payload"],
  context: JobContext
): Promise<GeometryJobMap[K]["result"]> {
  const handler = JOB_HANDLERS[name] as JobHandler<K>;
  if (!handler) throw new Error(`Unknown geometry job: ${name}`);
  return handler(payload, context);
}

/**
 * Transferable buffers inside a job payload or result.
 *
 * Passing these to postMessage moves the memory instead of copying it, which
 * matters for meshes measured in tens of megabytes.
 */
export function collectTransferables(value: unknown): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (ArrayBuffer.isView(node)) {
      const buffer = node.buffer;
      if (buffer instanceof ArrayBuffer && !buffers.includes(buffer)) buffers.push(buffer);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const item of Object.values(node)) walk(item);
  };
  walk(value);
  return buffers;
}
