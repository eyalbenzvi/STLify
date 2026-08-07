"use client";

/**
 * The operations that turn one or more bodies into a replacement body:
 * booleans, cut, split, connectors, hollow, thicken, drain, smooth,
 * simplify, repair, fillet, shell, deform, lattice, pattern, revolve and
 * emboss.
 *
 * They all end the same way — new layers in, source layers hidden — so they
 * all end in `applyOpResult`. Where they differ is HOW they get there, and
 * that difference is worth keeping visible:
 *
 *  - `runDocOp` covers the ones the worker can run against the document
 *    itself (booleans, hollow, thicken, drain), which sync their operand
 *    meshes across the boundary and adopt the result back.
 *  - `runMeshOp` covers the ones that flatten a layer to a world mesh first
 *    (fillet, shell, lattice), because the operation is a Minkowski or a
 *    level set and has to leave the main thread.
 *  - The rest run inline, on this thread, because they are cheap.
 */

import { useCallback } from "react";
import type {
  BooleanOperationKind,
  ConnectorDefinition,
  CutPlaneDefinition,
  DesignLayer,
  HollowSettings,
  ImportedMeshLayer,
  ShapeLayer,
  SimplifySettings,
  SmoothSettings,
} from "@/types/design";
import { isShapeLayer } from "@/types/design";
import type { BuiltPart } from "@/hooks/useDocumentBuilder";
import type { UseGeometryJobs } from "@/hooks/useGeometryJobs";
import type { EditorOps, SourceDisposition } from "@/hooks/useEditorOps";
import type { SurfacePick } from "@/components/viewer/SceneView";
import { getMesh, storeMesh } from "@/lib/geometry/meshStore";
import { documentNozzleDiameterMm } from "@/lib/geometry/calibration";
import { OpError } from "@/lib/geometry/operations/layerOps";
import { adoptDocOpResult, docOpMeshSync } from "@/lib/geometry/jobs/docOpsClient";
import { performPlaneCut, splitDisconnectedParts } from "@/lib/geometry/operations/cut";
import { addConnectors } from "@/lib/geometry/operations/connectors";
import { performSimplify, performSmooth } from "@/lib/geometry/operations/meshRefine";
import { attemptMeshRepair } from "@/lib/geometry/repair/repair";
import {
  applyDeform,
  applyEmboss,
  applyRevolve,
  layerToWorldMesh,
  meshToResultLayer,
  type DeformRequest,
  type EmbossRequest,
  type RevolveSettings,
} from "@/lib/geometry/operations/advancedOps";
import type { FilletSettings, ShellSettings } from "@/lib/geometry/operations/fillet";
import type { LatticeSettings } from "@/lib/geometry/operations/lattice";
import { buildPattern, type PatternSettings } from "@/lib/geometry/operations/pattern";
import type { GeometryJobMap } from "@/lib/geometry/jobs/client";
import type { MeshData } from "@/lib/geometry/meshData";

/** Document-level jobs: they take the document plus synced operand meshes. */
type DocOpJobName = "docBoolean" | "docHollow" | "docThicken" | "docDrainHoles";

/** Mesh-level jobs: they take one flattened world mesh and return another. */
type MeshOpJobName = "fillet" | "shell" | "latticeFill";

type MeshSync = ReturnType<typeof docOpMeshSync>;

const BOOLEAN_LABELS_HE: Record<BooleanOperationKind, string> = {
  union: "איחוד",
  difference: "חיסור",
  intersection: "חיתוך משותף",
};

/** Cubic millimetres in a cubic centimetre, for the hollow report. */
const MM3_PER_CM3 = 1000;

/** Rendered as a whole-number percentage in operation reports. */
function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

function triangleDelta(before: number, after: number): string {
  return `משולשים: ${before.toLocaleString()} → ${after.toLocaleString()}`;
}

export interface BodyOperationHandlers {
  handleBooleanConfirm: (sources: SourceDisposition) => void;
  handleCutConfirm: (request: {
    plane: CutPlaneDefinition;
    keep: "top" | "bottom" | "both";
  }) => void;
  handleSplitComponents: () => void;
  handleConnectorsConfirm: (definition: ConnectorDefinition) => void;
  handleHollowConfirm: (settings: HollowSettings) => void;
  handleThickenConfirm: (thicknessMm: number) => void;
  handleDrainConfirm: (diameterMm: number, depthMm: number) => void;
  handleSmoothConfirm: (settings: SmoothSettings) => void;
  handleSimplifyConfirm: (settings: SimplifySettings) => void;
  handleRepair: () => void;
  handleFilletConfirm: (settings: FilletSettings) => void;
  handleShellConfirm: (settings: ShellSettings) => void;
  handleDeformConfirm: (request: DeformRequest) => void;
  handleLatticeConfirm: (settings: LatticeSettings) => void;
  handlePatternConfirm: (settings: PatternSettings) => void;
  handleRevolveConfirm: (settings: RevolveSettings) => void;
  handleEmbossConfirm: (targetLayerId: string, request: EmbossRequest) => void;
}

export function useBodyOperations({
  ops,
  jobs,
  selectedShapeLayers,
  selectedMeshLayers,
  selectedLayers,
  singleSelectedShape,
  partByLayer,
  booleanKind,
  lastCutPlane,
  drainPick,
  closeDialogs,
  onCutPlaneUsed,
}: {
  ops: EditorOps;
  jobs: UseGeometryJobs;
  selectedShapeLayers: ShapeLayer[];
  selectedMeshLayers: ImportedMeshLayer[];
  selectedLayers: DesignLayer[];
  singleSelectedShape: ShapeLayer | null;
  partByLayer: Map<string, BuiltPart>;
  booleanKind: BooleanOperationKind | null;
  lastCutPlane: CutPlaneDefinition | null;
  drainPick: SurfacePick | null;
  /** Called first by every confirm handler, to dismiss its dialog. */
  closeDialogs: () => void;
  /**
   * Records the plane a cut was made on. Connectors are placed on the last
   * cut by default, which is the only thing that makes that dialog usable.
   */
  onCutPlaneUsed: (plane: CutPlaneDefinition) => void;
}): BodyOperationHandlers {
  const {
    document: doc,
    dispatch,
    applyDocument,
    updateLayer,
    runOp,
    showMessage,
    showError,
    applyOpResult,
  } = ops;

  /**
   * Run a document-level operation in the worker: sync the operand meshes
   * across, adopt the result back, and commit it. Returns silently when the
   * user cancelled the job.
   */
  const runDocOp = useCallback(
    <K extends DocOpJobName>(request: {
      /** Busy-indicator label. */
      labelHe: string;
      /** History-entry label; usually shorter than the busy label. */
      resultLabelHe: string;
      sourceLayers: ShapeLayer[];
      job: K;
      payload: (sync: MeshSync) => GeometryJobMap[K]["payload"];
      sources?: SourceDisposition;
      /** Extra report lines derived from the job's own result fields. */
      reportHe?: (result: GeometryJobMap[K]["result"]) => string[];
    }) => {
      void runOp(request.labelHe, async () => {
        const sync = docOpMeshSync(request.sourceLayers);
        const result = await jobs.run(
          request.job,
          request.payload(sync),
          request.labelHe,
          { transferables: sync.transferables }
        );
        if (!result) return; // cancelled
        const outcome = adoptDocOpResult(result);
        applyOpResult(
          request.resultLabelHe,
          [outcome.layer],
          request.sourceLayers.map((l) => l.id),
          request.sources ?? "hide",
          [...(request.reportHe?.(result) ?? []), ...outcome.warningsHe]
        );
      });
    },
    [runOp, jobs, applyOpResult]
  );

  /**
   * Run a mesh-level operation in the worker: flatten the layer to a world
   * mesh, hand it over, and package what comes back as a replacement layer.
   */
  const runMeshOp = useCallback(
    <K extends MeshOpJobName>(request: {
      labelHe: string;
      layer: ShapeLayer;
      job: K;
      payload: (mesh: MeshData) => GeometryJobMap[K]["payload"];
      describe: (result: GeometryJobMap[K]["result"]) => {
        nameHe: string;
        descriptionHe: string;
        kind?: ImportedMeshLayer["provenance"]["kind"];
        reportHe?: string[];
      };
    }) => {
      const { layer } = request;
      void runOp(request.labelHe, async () => {
        const mesh = await layerToWorldMesh(doc, layer);
        const result = await jobs.run(request.job, request.payload(mesh), request.labelHe);
        if (!result) return; // cancelled
        const described = request.describe(result);
        const resultLayer = await meshToResultLayer(result.mesh, {
          nameHe: described.nameHe,
          descriptionHe: described.descriptionHe,
          materialSlotId: layer.materialSlotId,
          sourceLayerId: layer.id,
          kind: described.kind,
        });
        applyOpResult(request.labelHe, [resultLayer], [layer.id], "hide", [
          ...(described.reportHe ?? []),
          ...result.warningsHe,
        ]);
      });
    },
    [doc, runOp, jobs, applyOpResult]
  );

  // ---- booleans and cutting -------------------------------------------------

  const handleBooleanConfirm = useCallback(
    (sources: SourceDisposition) => {
      closeDialogs();
      if (!booleanKind || selectedShapeLayers.length < 2) return;
      // Runs as a registry job: in the worker where one exists, with progress
      // and a cancel button; operand meshes sync on demand.
      runDocOp({
        labelHe: "פעולה בוליאנית",
        resultLabelHe: BOOLEAN_LABELS_HE[booleanKind],
        sourceLayers: selectedShapeLayers,
        job: "docBoolean",
        payload: (sync) => ({
          document: doc,
          meshes: sync.meshes,
          layerIds: selectedShapeLayers.map((l) => l.id),
          kind: booleanKind,
        }),
        sources,
      });
    },
    [closeDialogs, booleanKind, selectedShapeLayers, doc, runDocOp]
  );

  const handleCutConfirm = useCallback(
    (request: { plane: CutPlaneDefinition; keep: "top" | "bottom" | "both" }) => {
      closeDialogs();
      const layer = singleSelectedShape;
      if (!layer) return;
      onCutPlaneUsed(request.plane);
      void runOp("חיתוך מישור", async () => {
        const outcome = await performPlaneCut(doc, layer, request.plane, request.keep);
        applyOpResult("חיתוך מישור", outcome.layers, [layer.id], "hide", outcome.warningsHe);
      });
    },
    [closeDialogs, singleSelectedShape, doc, runOp, applyOpResult, onCutPlaneUsed]
  );

  const handleSplitComponents = useCallback(() => {
    const layer = singleSelectedShape;
    if (!layer) return;
    void runOp("פיצול לרכיבים", async () => {
      const outcome = await splitDisconnectedParts(doc, layer);
      applyOpResult("פיצול לרכיבים", outcome.layers, [layer.id], "hide", outcome.warningsHe);
    });
  }, [singleSelectedShape, doc, runOp, applyOpResult]);

  const handleConnectorsConfirm = useCallback(
    (definition: ConnectorDefinition) => {
      closeDialogs();
      if (selectedMeshLayers.length !== 2) return;
      const plane =
        lastCutPlane ??
        ({ orientation: "xy", offsetMm: 0, rotationX: 0, rotationY: 0 } as const);
      // Male = the part whose centre is below the plane (bottom).
      const [a, b] = selectedMeshLayers;
      const centerZ = (layerId: string) => {
        const part = partByLayer.get(layerId);
        return part ? (part.stats.bounds.min.z + part.stats.bounds.max.z) / 2 : 0;
      };
      const [male, female] = centerZ(a.id) <= centerZ(b.id) ? [a, b] : [b, a];
      void runOp("הוספת מחברים", async () => {
        const outcome = await addConnectors(doc, male, female, plane, definition);
        applyOpResult(
          "מחברים",
          [outcome.maleLayer, outcome.femaleLayer],
          [male.id, female.id],
          "hide",
          outcome.warningsHe
        );
      });
    },
    [closeDialogs, selectedMeshLayers, lastCutPlane, partByLayer, doc, runOp, applyOpResult]
  );

  // ---- hollowing and thickening ---------------------------------------------

  const handleHollowConfirm = useCallback(
    (settings: HollowSettings) => {
      closeDialogs();
      const layer = singleSelectedShape;
      if (!layer) return;
      // Minkowski erosion — the slowest operation in the app; run it as a job
      // so the tab keeps painting and the user can cancel.
      runDocOp({
        labelHe: "חלול",
        resultLabelHe: "חלול",
        sourceLayers: [layer],
        job: "docHollow",
        payload: (sync) => ({
          document: doc,
          meshes: sync.meshes,
          layerId: layer.id,
          settings,
        }),
        reportHe: (result) => [
          `נחסכו ${percent(result.savedFraction)} מהחומר ` +
            `(${((result.originalVolumeMm3 - result.hollowVolumeMm3) / MM3_PER_CM3).toFixed(1)} סמ״ק)`,
        ],
      });
    },
    [closeDialogs, singleSelectedShape, doc, runDocOp]
  );

  const handleThickenConfirm = useCallback(
    (thicknessMm: number) => {
      closeDialogs();
      const layer = singleSelectedShape;
      if (!layer) return;
      // Minkowski dilation — same treatment as hollow: worker + cancel.
      runDocOp({
        labelHe: "עיבוי",
        resultLabelHe: "עיבוי",
        sourceLayers: [layer],
        job: "docThicken",
        payload: (sync) => ({
          document: doc,
          meshes: sync.meshes,
          layerId: layer.id,
          thicknessMm,
        }),
      });
    },
    [closeDialogs, singleSelectedShape, doc, runDocOp]
  );

  const handleDrainConfirm = useCallback(
    (diameterMm: number, depthMm: number) => {
      const pick = drainPick;
      closeDialogs();
      dispatch({ type: "ui/setTool", tool: "select" });
      if (!pick) return;
      const layer = doc.layers.find(
        (l): l is ShapeLayer => l.id === pick.primaryLayerId && isShapeLayer(l)
      );
      if (!layer) return;
      runDocOp({
        labelHe: "קדיחת חור ניקוז",
        resultLabelHe: "חור ניקוז",
        sourceLayers: [layer],
        job: "docDrainHoles",
        payload: (sync) => ({
          document: doc,
          meshes: sync.meshes,
          layerId: layer.id,
          holes: [
            {
              diameterMm,
              depthMm,
              position: pick.point,
              // Drill INTO the body: opposite the surface normal we picked.
              direction: { x: -pick.normal.x, y: -pick.normal.y, z: -pick.normal.z },
            },
          ],
        }),
        reportHe: (result) => [
          result.reachedCavity[0]
            ? "החור הגיע לחלל הפנימי ✓"
            : "שימו לב: החור לא הגיע לחלל פנימי",
        ],
      });
    },
    [drainPick, closeDialogs, dispatch, doc, runDocOp]
  );

  // ---- mesh quality ---------------------------------------------------------

  const handleSmoothConfirm = useCallback(
    (settings: SmoothSettings) => {
      closeDialogs();
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("החלקה", async () => {
        const outcome = await performSmooth(doc, layer, settings);
        applyOpResult("החלקה", [outcome.layer], [layer.id], "hide", [
          triangleDelta(outcome.trianglesBefore, outcome.trianglesAfter),
          ...outcome.warningsHe,
        ]);
      });
    },
    [closeDialogs, singleSelectedShape, doc, runOp, applyOpResult]
  );

  const handleSimplifyConfirm = useCallback(
    (settings: SimplifySettings) => {
      closeDialogs();
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("פישוט", async () => {
        const outcome = await performSimplify(doc, layer, settings);
        applyOpResult("פישוט", [outcome.layer], [layer.id], "hide", [
          triangleDelta(outcome.trianglesBefore, outcome.trianglesAfter),
          ...outcome.warningsHe,
        ]);
      });
    },
    [closeDialogs, singleSelectedShape, doc, runOp, applyOpResult]
  );

  const handleRepair = useCallback(() => {
    const layer = selectedMeshLayers[0];
    if (!layer) return;
    void runOp("תיקון רשת", async () => {
      const mesh = getMesh(layer.meshId);
      if (!mesh) throw new OpError("נתוני הרשת חסרים");
      const result = await attemptMeshRepair(mesh);
      if (!result.succeeded || !result.mesh) {
        showMessage({ titleHe: "תיקון רשת", bodyHe: result.messageHe, kind: "error" });
        return;
      }
      updateLayer(
        layer.id,
        {
          meshId: storeMesh(result.mesh),
          originalMeshId: layer.originalMeshId ?? layer.meshId,
        },
        "תיקון רשת"
      );
      showMessage({ titleHe: "תיקון רשת", bodyHe: result.messageHe, kind: "success" });
    });
  }, [selectedMeshLayers, runOp, updateLayer, showMessage]);

  // ---- reshaping ------------------------------------------------------------

  const handleFilletConfirm = useCallback(
    (settings: FilletSettings) => {
      closeDialogs();
      const layer = singleSelectedShape;
      if (!layer) return;
      const styleHe = settings.style === "fillet" ? "עיגול" : "שיפוע";
      // Minkowski is the slowest operation in the app; route it through the
      // worker so the viewport keeps responding and the user can cancel.
      runMeshOp({
        labelHe: "עיגול קצוות",
        layer,
        job: "fillet",
        payload: (mesh) => ({ mesh, settings }),
        describe: () => ({
          nameHe: `${layer.name} — ${styleHe} ${settings.sizeMm} מ״מ`,
          descriptionHe: `${styleHe} קצוות ברדיוס ${settings.sizeMm} מ״מ`,
        }),
      });
    },
    [closeDialogs, singleSelectedShape, runMeshOp]
  );

  const handleShellConfirm = useCallback(
    (settings: ShellSettings) => {
      closeDialogs();
      const layer = singleSelectedShape;
      if (!layer) return;
      runMeshOp({
        labelHe: "קליפה עם פתח",
        layer,
        job: "shell",
        payload: (mesh) => ({ mesh, settings }),
        describe: () => ({
          nameHe: `${layer.name} — קליפה ${settings.wallThicknessMm} מ״מ`,
          descriptionHe: `קליפה בעובי ${settings.wallThicknessMm} מ״מ`,
          kind: "hollowResult",
        }),
      });
    },
    [closeDialogs, singleSelectedShape, runMeshOp]
  );

  const handleLatticeConfirm = useCallback(
    (settings: LatticeSettings) => {
      closeDialogs();
      const layer = singleSelectedShape;
      if (!layer) return;
      runMeshOp({
        labelHe: "מילוי סריג",
        layer,
        job: "latticeFill",
        payload: (mesh) => ({
          mesh,
          // The printability check is only real if the nozzle reaches it; the
          // dialog cannot know which printer the document targets.
          settings: { ...settings, nozzleDiameterMm: documentNozzleDiameterMm(doc) },
        }),
        describe: (result) => ({
          nameHe: `${layer.name} — סריג`,
          descriptionHe: `מילוי סריג, תא ${settings.cellSizeMm} מ״מ`,
          kind: "hollowResult",
          reportHe: [`חיסכון בחומר: ${percent(result.savedFraction)}`],
        }),
      });
    },
    [closeDialogs, singleSelectedShape, doc, runMeshOp]
  );

  const handleDeformConfirm = useCallback(
    (request: DeformRequest) => {
      closeDialogs();
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("עיוות גוף", async () => {
        const outcome = await applyDeform(doc, layer, request);
        applyOpResult("עיוות גוף", [outcome.layer], [layer.id], "hide", outcome.warningsHe);
      });
    },
    [closeDialogs, singleSelectedShape, doc, runOp, applyOpResult]
  );

  const handleRevolveConfirm = useCallback(
    (settings: RevolveSettings) => {
      closeDialogs();
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("סיבוב פרופיל", async () => {
        const outcome = await applyRevolve(doc, layer, settings);
        applyOpResult("סיבוב פרופיל", [outcome.layer], [layer.id], "hide", outcome.warningsHe);
      });
    },
    [closeDialogs, singleSelectedShape, doc, runOp, applyOpResult]
  );

  const handleEmbossConfirm = useCallback(
    (targetLayerId: string, request: EmbossRequest) => {
      closeDialogs();
      const artwork = singleSelectedShape;
      const target = doc.layers.find((l) => l.id === targetLayerId);
      if (!artwork || !target || !isShapeLayer(target)) return;
      void runOp("הטבעה על משטח", async () => {
        const outcome = await applyEmboss(doc, artwork, target, request);
        // The artwork is consumed into the target, so both sources are hidden.
        applyOpResult(
          "הטבעה על משטח",
          [outcome.layer],
          [target.id, artwork.id],
          "hide",
          outcome.warningsHe
        );
      });
    },
    [closeDialogs, singleSelectedShape, doc, runOp, applyOpResult]
  );

  const handlePatternConfirm = useCallback(
    (settings: PatternSettings) => {
      closeDialogs();
      const source = selectedLayers[0];
      if (!source) return;
      // Pure transform maths, no kernel: no reason to go through runOp.
      try {
        const { layers, labelHe } = buildPattern(source, settings);
        applyDocument({ ...doc, layers: [...doc.layers, ...layers] }, labelHe);
        dispatch({ type: "ui/select", selection: layers.map((l) => l.id) });
      } catch (err) {
        showError(err, "מערך עותקים");
      }
    },
    [closeDialogs, selectedLayers, doc, applyDocument, dispatch, showError]
  );

  return {
    handleBooleanConfirm,
    handleCutConfirm,
    handleSplitComponents,
    handleConnectorsConfirm,
    handleHollowConfirm,
    handleThickenConfirm,
    handleDrainConfirm,
    handleSmoothConfirm,
    handleSimplifyConfirm,
    handleRepair,
    handleFilletConfirm,
    handleShellConfirm,
    handleDeformConfirm,
    handleLatticeConfirm,
    handlePatternConfirm,
    handleRevolveConfirm,
    handleEmbossConfirm,
  };
}
