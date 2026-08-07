"use client";

/**
 * V3 editor shell: header (templates, base mode, undo/redo, import/export),
 * layer/properties/tools/analysis/inspection panels, the 3D viewport and
 * all operation dialogs. Geometry work is delegated to lib/geometry; this
 * component owns wiring, busy state and Hebrew messaging.
 */

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type * as THREE from "three";
import type {
  BooleanOperationKind,
  ConnectorDefinition,
  CutPlaneDefinition,
  DesignDocument,
  DesignLayer,
  HollowSettings,
  ImportedMeshLayer,
  Measurement,
  ShapeLayer,
  SimplifySettings,
  SmoothSettings,
  Transform3D,
} from "@/types/design";
import {
  defaultPrimitive,
  identityTransform,
  isShapeLayer,
  newId,
  PRIMITIVE_NAMES_HE,
  primaryMaterialSlotId,
  type PrimitiveKind,
} from "@/types/design";
import {
  getPrintabilityProfile,
  getPrinterProfile,
  type PrinterProfile,
} from "@/types/profiles";
import { useDocumentBuilder, type BuiltPart } from "@/hooks/useDocumentBuilder";
import { createTemplateDocument, makeBaseLayer, makeHoleLayer, makeTextLayer, PRODUCT_TEMPLATES } from "@/lib/geometry/documentTemplates";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import { meshDataBounds } from "@/lib/geometry/meshData";
import { boundsCenter, boundsRadius, boundsSize, unionBounds } from "@/lib/geometry/bounds";
import { getMesh, storeMesh } from "@/lib/geometry/meshStore";
import { performPlaneCut, splitDisconnectedParts } from "@/lib/geometry/operations/cut";
import { addConnectors } from "@/lib/geometry/operations/connectors";
import { performSimplify, performSmooth } from "@/lib/geometry/operations/meshRefine";
import { adoptDocOpResult, docOpMeshSync } from "@/lib/geometry/jobs/docOpsClient";
import { OpError } from "@/lib/geometry/operations/layerOps";
import {
  alignTransforms,
  centerOnPlate,
  distributeTransforms,
  dropToPlate,
  duplicateTransform,
  fitToBuildVolumeFactor,
  mirrorTransform,
  placeOnSurface,
  scaleToSize,
  snapToObjectCenter,
  snapToObjectEdge,
} from "@/lib/geometry/operations/placement";
import type { OrientationCandidate } from "@/lib/geometry/analysis";
import type { DetailedEstimateResult } from "@/lib/geometry/analysis/estimateDetailed";
import type { SlicedEstimateResult } from "@/lib/geometry/analysis/estimateSliced";
import { attemptMeshRepair } from "@/lib/geometry/repair/repair";
import { StlImportError } from "@/lib/import/stl";
import { SvgImportError } from "@/lib/import/svg";
import { IMAGE_INPUT_ACCEPT, ImageImportError } from "@/lib/import/image";
import type {
  MeshDiagnosis,
  MeshRepairReport,
  RepairOptions,
} from "@/lib/geometry/repair/diagnose";
import {
  applyDeform,
  applyEmboss,
  applyRevolve,
  generatorToLayer,
  layerToWorldMesh,
  meshToResultLayer,
  type DeformRequest,
  type EmbossRequest,
  type RevolveSettings,
} from "@/lib/geometry/operations/advancedOps";
import { useGeometryJobs } from "@/hooks/useGeometryJobs";
import { useImportHandlers } from "@/hooks/useImportHandlers";
import { useAnalysisRunner } from "@/hooks/useAnalysisRunner";
import { JobProgressOverlay } from "@/components/editor/JobProgressOverlay";
import type { FilletSettings, ShellSettings } from "@/lib/geometry/operations/fillet";
import type { LatticeSettings } from "@/lib/geometry/operations/lattice";
import { buildPattern, PatternError, type PatternSettings } from "@/lib/geometry/operations/pattern";
import {
  detectInterference,
  type InterferenceReport,
} from "@/lib/geometry/analysis/collision";
import { arrangePartsOnPlate } from "@/lib/geometry/operations/plateArrange";
import { GeneratorError } from "@/lib/geometry/generators";
import { downloadBlob } from "@/lib/export/download";
import type { PrintablePart } from "@/lib/geometry/buildDocument";
import {
  buildStlExport,
  buildThreeMfExport,
  buildZipExport,
} from "@/lib/export/exportDocument";
import { DESIGN_FILE_EXTENSION, DesignFileError, serializeDesignFile } from "@/lib/serialization/designFile";
import { decodeShareHash, encodeShareHash, SHARE_HASH_PREFIX, shareLinkEligibility } from "@/lib/serialization/shareLink";
import type { ModelIssue } from "@/types/design";
import { Section } from "@/components/ui/Section";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { EditorProvider, useEditor } from "@/components/editor/store";
import { LayerListPanel } from "@/components/editor/LayerListPanel";
import { PropertiesPanel } from "@/components/editor/PropertiesPanel";
import { ToolsPanel } from "@/components/editor/ToolsPanel";
import { AnalysisPanel } from "@/components/editor/AnalysisPanel";
import { InspectPanel } from "@/components/editor/InspectPanel";
import {
  BooleanDialog,
  ConnectorsDialog,
  CutDialog,
  DrainHoleDialog,
  HollowDialog,
  MessageDialog,
  SimplifyDialog,
  SmoothDialog,
  ThickenDialog,
  type OpMessage,
} from "@/components/dialogs/OperationDialogs";
import {
  ImageImportDialog,
  StlImportDialog,
  SvgImportDialog,
  type StlImportPreview,
} from "@/components/dialogs/ImportDialogs";
import { ExportDialog, type ExportKind } from "@/components/dialogs/ExportDialog";
import { LibraryDialog } from "@/components/dialogs/LibraryDialog";
import { ShortcutsDialog } from "@/components/dialogs/ShortcutsDialog";
import { actionForEvent, loadKeymap, type Keymap } from "@/lib/keyboard/keymap";
import { CreatePanel } from "@/components/editor/CreatePanel";
import { buildGeneratorLayers } from "@/lib/geometry/generators/buildGeneratorLayers";
import {
  type GeneratorKind,
  type GeneratorParams,
} from "@/lib/geometry/generators/specs";
import { GeneratorDialog } from "@/components/dialogs/GeneratorDialog";
import {
  SubObjectPanel,
  type PaintInfo,
  type RegionInfo,
} from "@/components/editor/SubObjectPanel";
import {
  activePaints,
  DEFAULT_PAINT_DEPTH_MM,
  hasStalePaint,
  paintedTriangleSlots,
  paintTriangles,
  reanchorPaints,
  splitPartsByPaint,
  unpaintTriangles,
} from "@/lib/geometry/painting";
import { CalibrationPanel, CustomPrinterPanel } from "@/components/editor/CalibrationPanel";
import {
  documentNozzleDiameterMm,
  type CalibrationSettings,
} from "@/lib/geometry/calibration";
import {
  analyzeBridging,
  DEFAULT_SUPPORT_SETTINGS,
} from "@/lib/geometry/analysis/supports";
import { analyzeWarping } from "@/lib/geometry/analysis/warping";
import { buildBrim, buildRaft } from "@/lib/geometry/operations/brimRaft";
import {
  buildAdjacency,
  growSelection,
  selectionArea,
} from "@/lib/geometry/selection/meshAdjacency";
import {
  deleteRegion,
  isSelectionPlanarForUi,
  pushPullRegion,
  smoothRegion,
  splitByRegion,
} from "@/lib/geometry/selection/regionOps";
import {
  HistoryPanel,
  MemoryPanel,
  ModifierStackPanel,
  ParametersPanel,
} from "@/components/editor/HistoryPanel";
import {
  defaultModifier,
  type Modifier,
  type ModifierKind,
} from "@/lib/geometry/modifiers";
import { resolveParameters, type ParameterDefinition } from "@/lib/geometry/expression";
import { garbageCollect, meshStoreStats, type MeshStoreStats } from "@/lib/geometry/meshStore";
import { referencedMeshIds } from "@/lib/history/history";
import { sweepUnreferencedMeshes } from "@/lib/history/retention";
import {
  clearSnapshot,
  describeSnapshotAge,
  peekSnapshot,
  restoreSnapshot,
  saveSnapshot,
  setRecoveryDisabled,
  type RecoverySnapshot,
} from "@/lib/serialization/crashRecovery";
import {
  DeformDialog,
  EmbossDialog,
  FilletDialog,
  ModifierEditDialog,
  RecoveryDialog,
  RevolveDialog,
  InterferenceDialog,
  LatticeDialog,
  MeshInspectorDialog,
  PatternDialog,
  ShellDialog,
} from "@/components/dialogs/AdvancedDialogs";
import { BaseModeSwitchDialog, OrientationDialog } from "@/components/dialogs/MiscDialogs";
import type { SurfacePick } from "@/components/viewer/SceneView";

// react-three-fiber requires the browser; skip server rendering entirely.
const SceneView = dynamic(
  () => import("@/components/viewer/SceneView").then((m) => m.SceneView),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        טוען תצוגה תלת־ממדית…
      </div>
    ),
  }
);

export function Editor() {
  return (
    <EditorProvider>
      <EditorInner />
    </EditorProvider>
  );
}

function EditorInner() {
  const { state, dispatch, document: doc, selection, selectedLayers, canUndo, canRedo } =
    useEditor();
  const build = useDocumentBuilder(doc);
  const jobs = useGeometryJobs();
  const printer = getPrinterProfile(doc.printerProfileId, doc.customPrinters ?? []);

  // ---- dialog state ----------------------------------------------------
  const [message, setMessage] = useState<OpMessage | null>(null);
  const [booleanKind, setBooleanKind] = useState<BooleanOperationKind | null>(null);
  const [cutOpen, setCutOpen] = useState(false);
  const [cutPlane, setCutPlane] = useState<CutPlaneDefinition>({
    orientation: "xy",
    offsetMm: 5,
    rotationX: 0,
    rotationY: 0,
  });
  const [lastCutPlane, setLastCutPlane] = useState<CutPlaneDefinition | null>(null);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [hollowOpen, setHollowOpen] = useState(false);
  const [thickenOpen, setThickenOpen] = useState(false);
  const [smoothOpen, setSmoothOpen] = useState(false);
  const [simplifyOpen, setSimplifyOpen] = useState(false);
  const [drainPick, setDrainPick] = useState<SurfacePick | null>(null);
  const [stlPreview, setStlPreview] = useState<StlImportPreview | null>(null);
  const pendingStlRef = useRef<{ meshId: string; fileName: string } | null>(null);
  const [svgPending, setSvgPending] = useState<{ text: string; fileName: string } | null>(null);
  const [imagePending, setImagePending] = useState<{ file: File; fileName: string } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Below lg the tool panel is a collapsible bottom sheet. */
  const [panelOpen, setPanelOpen] = useState(true);
  const [keymap, setKeymap] = useState<Keymap>(() => loadKeymap());
  const [viewPreset, setViewPreset] = useState<{
    kind: "top" | "front" | "side" | "iso";
    center: { x: number; y: number; z: number };
    radius: number;
    nonce: number;
  } | null>(null);
  const [orientationCandidates, setOrientationCandidates] = useState<OrientationCandidate[] | null>(null);
  const [modeSwitchTarget, setModeSwitchTarget] = useState<"withBase" | "baseless" | null>(null);
  const [modelIssues, setModelIssues] = useState<ModelIssue[]>([]);
  const [overlayColors, setOverlayColors] = useState<Map<string, Float32Array>>(new Map());
  const [estimate, setEstimate] = useState<DetailedEstimateResult | SlicedEstimateResult | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [filletOpen, setFilletOpen] = useState(false);
  const [shellOpen, setShellOpen] = useState(false);
  const [deformOpen, setDeformOpen] = useState(false);
  const [latticeOpen, setLatticeOpen] = useState(false);
  const [patternOpen, setPatternOpen] = useState(false);
  const [generatorKind, setGeneratorKind] = useState<GeneratorKind | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [diagnosis, setDiagnosis] = useState<MeshDiagnosis | null>(null);
  const [repairReport, setRepairReport] = useState<MeshRepairReport | null>(null);
  const [interference, setInterference] = useState<InterferenceReport | null>(null);
  const [focusTarget, setFocusTarget] = useState<{
    x: number;
    y: number;
    z: number;
    fitRadius?: number;
  } | null>(null);
  /** Bumped by the GC handler, which changes the store without changing doc. */
  const [memoryVersion, setMemoryVersion] = useState(0);
  const [recovery, setRecovery] = useState<RecoverySnapshot | null>(null);
  const [editingModifierId, setEditingModifierId] = useState<string | null>(null);
  const [pushPullMm, setPushPullMm] = useState(2);
  const [filletRegionMm, setFilletRegionMm] = useState(2);
  const [paintSlotId, setPaintSlotId] = useState<string | null>(null);
  const [paintDepthMm, setPaintDepthMm] = useState(DEFAULT_PAINT_DEPTH_MM);
  const [revolveOpen, setRevolveOpen] = useState(false);
  const [embossOpen, setEmbossOpen] = useState(false);

  const stlInputRef = useRef<HTMLInputElement>(null);
  const svgInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const designInputRef = useRef<HTMLInputElement>(null);

  const busy = state.ui.busyCount > 0;

  // ---- helpers -----------------------------------------------------------

  const applyDocument = useCallback(
    (next: DesignDocument, labelHe: string) =>
      dispatch({ type: "document/apply", document: next, labelHe }),
    [dispatch]
  );

  const updateLayer = useCallback(
    (layerId: string, patch: Partial<DesignLayer>, labelHe: string) =>
      dispatch({ type: "layer/update", layerId, patch, labelHe }),
    [dispatch]
  );

  const showError = useCallback((err: unknown, titleHe: string) => {
    if (err instanceof OpError) {
      setMessage({ titleHe, bodyHe: err.messageHe, suggestionsHe: err.suggestionsHe, kind: "error" });
    } else if (
      err instanceof StlImportError ||
      err instanceof SvgImportError ||
      err instanceof ImageImportError ||
      err instanceof DesignFileError ||
      err instanceof GeneratorError ||
      err instanceof PatternError
    ) {
      setMessage({ titleHe, bodyHe: err.messageHe, kind: "error" });
    } else {
      setMessage({
        titleHe,
        bodyHe: err instanceof Error ? err.message : String(err),
        kind: "error",
      });
    }
  }, []);

  /** Run an async geometry operation with a busy indicator + error dialog. */
  const runOp = useCallback(
    async (labelHe: string, fn: () => Promise<void>) => {
      dispatch({ type: "ui/busyStart", labelHe });
      try {
        await fn();
      } catch (err) {
        showError(err, `${labelHe} — הפעולה נכשלה`);
      } finally {
        dispatch({ type: "ui/busyEnd" });
      }
    },
    [dispatch, showError]
  );

  const selectedShapeLayers = useMemo(
    () => selectedLayers.filter(isShapeLayer),
    [selectedLayers]
  );
  const selectedMeshLayers = useMemo(
    () => selectedLayers.filter((l): l is ImportedMeshLayer => l.type === "importedMesh"),
    [selectedLayers]
  );
  const partByLayer = useMemo(() => {
    const map = new Map<string, BuiltPart>();
    for (const part of build.parts) map.set(part.primaryLayerId, part);
    return map;
  }, [build.parts]);
  const selectedParts = useMemo(
    () => selection.map((id) => partByLayer.get(id)).filter((p): p is BuiltPart => Boolean(p)),
    [selection, partByLayer]
  );
  const singleSelectedShape: ShapeLayer | null =
    selectedShapeLayers.length === 1 ? selectedShapeLayers[0] : null;

  /**
   * Apply the outcome of an operation that produced replacement layers:
   * add results, then keep/hide/remove sources.
   */
  const applyOpResult = useCallback(
    (
      labelHe: string,
      newLayers: DesignLayer[],
      sourceIds: string[],
      sources: "keep" | "hide" | "replace",
      warningsHe: string[] = []
    ) => {
      let layers = [...doc.layers];
      if (sources === "replace") {
        layers = layers.filter((l) => !sourceIds.includes(l.id));
      } else if (sources === "hide") {
        layers = layers.map((l) =>
          sourceIds.includes(l.id) ? ({ ...l, visible: false } as DesignLayer) : l
        );
      }
      layers.push(...newLayers);
      applyDocument({ ...doc, layers }, labelHe);
      dispatch({ type: "ui/select", selection: newLayers.map((l) => l.id) });
      if (warningsHe.length > 0) {
        setMessage({
          titleHe: `${labelHe} — הושלם עם הערות`,
          bodyHe: warningsHe.join("\n"),
          kind: "info",
        });
      }
    },
    [doc, applyDocument, dispatch]
  );

  // ---- transforms / placement -------------------------------------------

  const commitTransform = useCallback(
    (layerId: string, transform: Transform3D) => {
      dispatch({
        type: "layer/setTransform",
        layerId,
        transform,
        labelHe: "טרנספורמציה",
      });
    },
    [dispatch]
  );

  const withSelectedPart = useCallback(
    (fn: (part: BuiltPart, layer: DesignLayer) => void) => {
      const part = selectedParts[0];
      if (!part) return;
      const layer = doc.layers.find((l) => l.id === part.primaryLayerId);
      if (!layer || layer.locked) return;
      fn(part, layer);
    },
    [selectedParts, doc.layers]
  );

  const handleDropToPlate = useCallback(() => {
    withSelectedPart((part, layer) => {
      commitTransform(layer.id, dropToPlate(layer.transform, part.stats.bounds));
    });
  }, [withSelectedPart, commitTransform]);

  const handleCenterOnPlate = useCallback(() => {
    withSelectedPart((part, layer) => {
      commitTransform(layer.id, centerOnPlate(layer.transform, part.stats.bounds));
    });
  }, [withSelectedPart, commitTransform]);

  const handleMirror = useCallback(
    (axis: "x" | "y" | "z") => {
      withSelectedPart((part, layer) => {
        commitTransform(layer.id, mirrorTransform(layer.transform, part.stats.bounds, axis));
      });
    },
    [withSelectedPart, commitTransform]
  );

  const handleAlign = useCallback(
    (axis: "x" | "y" | "z", mode: "min" | "center" | "max") => {
      const items = selectedParts.map((part) => {
        const layer = doc.layers.find((l) => l.id === part.primaryLayerId)!;
        return { layer, transform: layer.transform, bounds: part.stats.bounds };
      });
      if (items.length < 2) return;
      const aligned = alignTransforms(items, axis, mode);
      let layers = doc.layers;
      items.forEach((item, i) => {
        layers = layers.map((l) =>
          l.id === item.layer.id ? ({ ...l, transform: aligned[i] } as DesignLayer) : l
        );
      });
      applyDocument({ ...doc, layers }, "יישור שכבות");
    },
    [selectedParts, doc, applyDocument]
  );

  const handleDistribute = useCallback(
    (axis: "x" | "y" | "z") => {
      const items = selectedParts.map((part) => {
        const layer = doc.layers.find((l) => l.id === part.primaryLayerId)!;
        return { layer, transform: layer.transform, bounds: part.stats.bounds };
      });
      if (items.length < 3) return;
      const distributed = distributeTransforms(items, axis);
      let layers = doc.layers;
      items.forEach((item, i) => {
        layers = layers.map((l) =>
          l.id === item.layer.id ? ({ ...l, transform: distributed[i] } as DesignLayer) : l
        );
      });
      applyDocument({ ...doc, layers }, "פיזור שכבות");
    },
    [selectedParts, doc, applyDocument]
  );

  const handleSnapToCenter = useCallback(() => {
    if (selectedParts.length !== 2) return;
    const [moving, target] = selectedParts;
    const layer = doc.layers.find((l) => l.id === moving.primaryLayerId);
    if (!layer || layer.locked) return;
    commitTransform(
      layer.id,
      snapToObjectCenter(layer.transform, moving.stats.bounds, target.stats.bounds)
    );
  }, [selectedParts, doc.layers, commitTransform]);

  const handleSnapToEdge = useCallback(
    (axis: "x" | "y" | "z") => {
      if (selectedParts.length !== 2) return;
      const [moving, target] = selectedParts;
      const layer = doc.layers.find((l) => l.id === moving.primaryLayerId);
      if (!layer || layer.locked) return;
      commitTransform(
        layer.id,
        snapToObjectEdge(layer.transform, moving.stats.bounds, target.stats.bounds, axis)
      );
    },
    [selectedParts, doc.layers, commitTransform]
  );

  const handleDuplicate = useCallback(() => {
    const newLayers: DesignLayer[] = [];
    for (const layer of selectedLayers) {
      newLayers.push({
        ...structuredClone(layer),
        id: newId("layer"),
        name: `${layer.name} (עותק)`,
        transform: duplicateTransform(layer.transform, { x: 10, y: -10, z: 0 }),
      } as DesignLayer);
    }
    if (newLayers.length === 0) return;
    applyDocument({ ...doc, layers: [...doc.layers, ...newLayers] }, "שכפול שכבות");
    dispatch({ type: "ui/select", selection: newLayers.map((l) => l.id) });
  }, [selectedLayers, doc, applyDocument, dispatch]);

  const handleScaleTo = useCallback(
    (axis: "x" | "y" | "z" | "longest", targetMm: number, uniform: boolean) => {
      withSelectedPart((part, layer) => {
        const before = part.stats.dimensionsMm;
        const next = scaleToSize(layer.transform, part.stats.bounds, {
          axis,
          targetMm,
          uniform,
        });
        commitTransform(layer.id, next);
        const profile = getPrintabilityProfile(doc.printabilityProfileId);
        const factor = axis === "longest" || uniform ? targetMm / Math.max(before.x, before.y, before.z, 0.001) : 1;
        if (factor < 1 && factor > 0) {
          setMessage({
            titleHe: "שינוי גודל",
            bodyHe: `הוקטן פי ${(1 / factor).toFixed(2)} — ודאו שפרטים דקים לא ירדו מתחת ל-${profile.minWallMm} מ״מ (בדקו במפת עובי הדפנות)`,
            kind: "info",
          });
        }
      });
    },
    [withSelectedPart, commitTransform, doc.printabilityProfileId]
  );

  const handleFitBuildVolume = useCallback(() => {
    withSelectedPart((part, layer) => {
      const factor = fitToBuildVolumeFactor(part.stats.bounds, printer.buildVolumeMm);
      if (factor >= 1) {
        setMessage({
          titleHe: "התאמה לנפח המדפסת",
          bodyHe: "האובייקט כבר נכנס בנפח ההדפסה — לא נדרש שינוי",
          kind: "info",
        });
        return;
      }
      const t = layer.transform;
      commitTransform(layer.id, {
        ...t,
        scaleX: t.scaleX * factor,
        scaleY: t.scaleY * factor,
        scaleZ: t.scaleZ * factor,
      });
    });
  }, [withSelectedPart, commitTransform, printer]);

  // ---- surface picking ----------------------------------------------------

  const handleSurfacePick = useCallback(
    (pick: SurfacePick) => {
      if (state.ui.tool === "placeOnSurface") {
        const part = selectedParts[0];
        if (!part) return;
        if (pick.primaryLayerId === part.primaryLayerId) {
          setMessage({
            titleHe: "הנחה על משטח",
            bodyHe: "לא ניתן להניח אובייקט על עצמו — לחצו על משטח של אובייקט אחר",
            kind: "info",
          });
          return;
        }
        const layer = doc.layers.find((l) => l.id === part.primaryLayerId);
        if (!layer || layer.locked) return;
        const localBounds = meshDataBounds(part.localMesh);
        commitTransform(
          layer.id,
          placeOnSurface(layer.transform, localBounds, pick.point, pick.normal, 0)
        );
        dispatch({ type: "ui/setTool", tool: "select" });
        return;
      }
      if (state.ui.tool === "drainHole") {
        setDrainPick(pick);
      }
    },
    [state.ui.tool, selectedParts, doc.layers, commitTransform, dispatch]
  );

  const handleDrainConfirm = useCallback(
    (diameterMm: number, depthMm: number) => {
      const pick = drainPick;
      setDrainPick(null);
      dispatch({ type: "ui/setTool", tool: "select" });
      if (!pick) return;
      const layer = doc.layers.find(
        (l): l is ShapeLayer => l.id === pick.primaryLayerId && isShapeLayer(l)
      );
      if (!layer) return;
      void runOp("קדיחת חור ניקוז", async () => {
        const sync = docOpMeshSync([layer]);
        const jobResult = await jobs.run(
          "docDrainHoles",
          {
            document: doc,
            meshes: sync.meshes,
            layerId: layer.id,
            holes: [
              {
                diameterMm,
                depthMm,
                position: pick.point,
                direction: { x: -pick.normal.x, y: -pick.normal.y, z: -pick.normal.z },
              },
            ],
          },
          "קדיחת חור ניקוז",
          { transferables: sync.transferables }
        );
        if (!jobResult) return; // cancelled
        const result = adoptDocOpResult(jobResult);
        applyOpResult("חור ניקוז", [result.layer], [layer.id], "hide", [
          ...result.warningsHe,
          result.reachedCavity[0]
            ? "החור הגיע לחלל הפנימי ✓"
            : "שימו לב: החור לא הגיע לחלל פנימי",
        ]);
      });
    },
    [drainPick, doc, runOp, applyOpResult, dispatch, jobs]
  );

  // ---- boolean / body operations -------------------------------------------

  const handleBooleanConfirm = useCallback(
    (sources: "keep" | "hide" | "replace") => {
      const kind = booleanKind;
      setBooleanKind(null);
      if (!kind || selectedShapeLayers.length < 2) return;
      void runOp("פעולה בוליאנית", async () => {
        // Runs as a registry job: in the worker where one exists, with
        // progress and a cancel button; operand meshes sync on demand.
        const sync = docOpMeshSync(selectedShapeLayers);
        const result = await jobs.run(
          "docBoolean",
          {
            document: doc,
            meshes: sync.meshes,
            layerIds: selectedShapeLayers.map((l) => l.id),
            kind,
          },
          "פעולה בוליאנית",
          { transferables: sync.transferables }
        );
        if (!result) return; // cancelled
        const outcome = adoptDocOpResult(result);
        applyOpResult(
          kind === "union" ? "איחוד" : kind === "difference" ? "חיסור" : "חיתוך משותף",
          [outcome.layer],
          selectedShapeLayers.map((l) => l.id),
          sources,
          outcome.warningsHe
        );
      });
    },
    [booleanKind, selectedShapeLayers, doc, runOp, applyOpResult, jobs]
  );

  const handleCutConfirm = useCallback(
    (request: { plane: CutPlaneDefinition; keep: "top" | "bottom" | "both" }) => {
      setCutOpen(false);
      const layer = singleSelectedShape;
      if (!layer) return;
      setLastCutPlane(request.plane);
      void runOp("חיתוך מישור", async () => {
        const outcome = await performPlaneCut(doc, layer, request.plane, request.keep);
        applyOpResult("חיתוך מישור", outcome.layers, [layer.id], "hide", outcome.warningsHe);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult]
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
    (def: ConnectorDefinition) => {
      setConnectorsOpen(false);
      if (selectedMeshLayers.length !== 2) return;
      const plane = lastCutPlane ?? {
        orientation: "xy" as const,
        offsetMm: 0,
        rotationX: 0,
        rotationY: 0,
      };
      // Male = the part whose centre is below the plane (bottom).
      const [a, b] = selectedMeshLayers;
      const partA = partByLayer.get(a.id);
      const partB = partByLayer.get(b.id);
      const centerZ = (p: BuiltPart | undefined) =>
        p ? (p.stats.bounds.min.z + p.stats.bounds.max.z) / 2 : 0;
      const [male, female] = centerZ(partA) <= centerZ(partB) ? [a, b] : [b, a];
      void runOp("הוספת מחברים", async () => {
        const outcome = await addConnectors(doc, male, female, plane, def);
        applyOpResult(
          "מחברים",
          [outcome.maleLayer, outcome.femaleLayer],
          [male.id, female.id],
          "hide",
          outcome.warningsHe
        );
      });
    },
    [selectedMeshLayers, lastCutPlane, partByLayer, doc, runOp, applyOpResult]
  );

  const handleHollowConfirm = useCallback(
    (settings: HollowSettings) => {
      setHollowOpen(false);
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("חלול", async () => {
        // Minkowski erosion — the slowest operation in the app; run it as a
        // job so the tab keeps painting and the user can cancel.
        const sync = docOpMeshSync([layer]);
        const result = await jobs.run(
          "docHollow",
          { document: doc, meshes: sync.meshes, layerId: layer.id, settings },
          "חלול",
          { transferables: sync.transferables }
        );
        if (!result) return; // cancelled
        const outcome = adoptDocOpResult(result);
        applyOpResult("חלול", [outcome.layer], [layer.id], "hide", [
          `נחסכו ${(outcome.savedFraction * 100).toFixed(0)}% מהחומר (${((outcome.originalVolumeMm3 - outcome.hollowVolumeMm3) / 1000).toFixed(1)} סמ״ק)`,
          ...outcome.warningsHe,
        ]);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult, jobs]
  );

  const handleThickenConfirm = useCallback(
    (thicknessMm: number) => {
      setThickenOpen(false);
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("עיבוי", async () => {
        // Minkowski dilation — same treatment as hollow: worker + cancel.
        const sync = docOpMeshSync([layer]);
        const result = await jobs.run(
          "docThicken",
          { document: doc, meshes: sync.meshes, layerId: layer.id, thicknessMm },
          "עיבוי",
          { transferables: sync.transferables }
        );
        if (!result) return; // cancelled
        const outcome = adoptDocOpResult(result);
        applyOpResult("עיבוי", [outcome.layer], [layer.id], "hide", outcome.warningsHe);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult, jobs]
  );

  const handleSmoothConfirm = useCallback(
    (settings: SmoothSettings) => {
      setSmoothOpen(false);
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("החלקה", async () => {
        const outcome = await performSmooth(doc, layer, settings);
        applyOpResult("החלקה", [outcome.layer], [layer.id], "hide", [
          `משולשים: ${outcome.trianglesBefore.toLocaleString()} → ${outcome.trianglesAfter.toLocaleString()}`,
          ...outcome.warningsHe,
        ]);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult]
  );

  const handleSimplifyConfirm = useCallback(
    (settings: SimplifySettings) => {
      setSimplifyOpen(false);
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("פישוט", async () => {
        const outcome = await performSimplify(doc, layer, settings);
        applyOpResult("פישוט", [outcome.layer], [layer.id], "hide", [
          `משולשים: ${outcome.trianglesBefore.toLocaleString()} → ${outcome.trianglesAfter.toLocaleString()}`,
          ...outcome.warningsHe,
        ]);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult]
  );

  const handleRepair = useCallback(() => {
    const layer = selectedMeshLayers[0];
    if (!layer) return;
    void runOp("תיקון רשת", async () => {
      const mesh = getMesh(layer.meshId);
      if (!mesh) throw new OpError("נתוני הרשת חסרים");
      const result = await attemptMeshRepair(mesh);
      if (!result.succeeded || !result.mesh) {
        setMessage({ titleHe: "תיקון רשת", bodyHe: result.messageHe, kind: "error" });
        return;
      }
      const repairedId = storeMesh(result.mesh);
      updateLayer(
        layer.id,
        { meshId: repairedId, originalMeshId: layer.originalMeshId ?? layer.meshId },
        "תיקון רשת"
      );
      setMessage({ titleHe: "תיקון רשת", bodyHe: result.messageHe, kind: "success" });
    });
  }, [selectedMeshLayers, runOp, updateLayer]);

  // ---- V4: creation ---------------------------------------------------------

  const addLayer = useCallback(
    (layer: DesignLayer, labelHe: string) => {
      applyDocument({ ...doc, layers: [...doc.layers, layer] }, labelHe);
      dispatch({ type: "ui/select", selection: [layer.id] });
    },
    [doc, applyDocument, dispatch]
  );

  const handleAddPrimitive = useCallback(
    (kind: PrimitiveKind) => {
      const nameHe = PRIMITIVE_NAMES_HE[kind];
      addLayer(
        {
          id: newId("layer"),
          type: "primitive",
          name: nameHe,
          visible: true,
          locked: false,
          materialSlotId: primaryMaterialSlotId(doc),
          transform: identityTransform(),
          previewOpacity: 1,
          ...defaultPrimitive(kind),
        },
        `הוספת ${nameHe}`
      );
    },
    [addLayer, doc]
  );

  const handleAddSketch = useCallback(() => {
    addLayer(
      {
        id: newId("layer"),
        type: "sketch",
        name: "סקיצה",
        visible: true,
        locked: false,
        materialSlotId: primaryMaterialSlotId(doc),
        transform: identityTransform(),
        previewOpacity: 1,
        // Seeded with one rectangle so the layer produces geometry
        // immediately; the properties panel edits the entity list.
        entities: [
          { kind: "rectangle", x: 0, y: 0, widthMm: 30, heightMm: 20, cornerRadiusMm: 2, rotationDeg: 0 },
        ],
        extrudeMm: 3,
        combine: "standalone",
        bevel: { enabled: false, sizeMm: 0.6, segments: 4 },
      },
      "הוספת סקיצה"
    );
  }, [addLayer, doc]);

  const handleGeneratorConfirm = useCallback(
    (kind: GeneratorKind, params: GeneratorParams) => {
      setGeneratorKind(null);
      void runOp("יצירת חלק פרמטרי", async () => {
        const kernel = await getGeometryKernel();
        const layers = buildGeneratorLayers(kernel, doc, kind, params);
        applyDocument({ ...doc, layers: [...doc.layers, ...layers] }, "יצירת חלק פרמטרי");
        dispatch({ type: "ui/select", selection: layers.map((l) => l.id) });
      });
    },
    [doc, runOp, applyDocument, dispatch]
  );

  // ---- V4: body operations ---------------------------------------------------

  const handleFilletConfirm = useCallback(
    (settings: FilletSettings) => {
      setFilletOpen(false);
      const layer = singleSelectedShape;
      if (!layer) return;
      const styleHe = settings.style === "fillet" ? "עיגול" : "שיפוע";
      void runOp("עיגול קצוות", async () => {
        // Minkowski is the slowest operation in the app; route it through the
        // worker so the viewport keeps responding and the user can cancel.
        const mesh = await layerToWorldMesh(doc, layer);
        const result = await jobs.run("fillet", { mesh, settings }, "עיגול קצוות");
        if (!result) return; // cancelled
        const resultLayer = await meshToResultLayer(result.mesh, {
          nameHe: `${layer.name} — ${styleHe} ${settings.sizeMm} מ״מ`,
          descriptionHe: `${styleHe} קצוות ברדיוס ${settings.sizeMm} מ״מ`,
          materialSlotId: layer.materialSlotId,
          sourceLayerId: layer.id,
        });
        applyOpResult("עיגול קצוות", [resultLayer], [layer.id], "hide", result.warningsHe);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult, jobs]
  );

  const handleShellConfirm = useCallback(
    (settings: ShellSettings) => {
      setShellOpen(false);
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("קליפה עם פתח", async () => {
        const mesh = await layerToWorldMesh(doc, layer);
        const result = await jobs.run("shell", { mesh, settings }, "קליפה עם פתח");
        if (!result) return;
        const resultLayer = await meshToResultLayer(result.mesh, {
          nameHe: `${layer.name} — קליפה ${settings.wallThicknessMm} מ״מ`,
          descriptionHe: `קליפה בעובי ${settings.wallThicknessMm} מ״מ`,
          materialSlotId: layer.materialSlotId,
          sourceLayerId: layer.id,
          kind: "hollowResult",
        });
        applyOpResult("קליפה עם פתח", [resultLayer], [layer.id], "hide", result.warningsHe);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult, jobs]
  );

  const handleDeformConfirm = useCallback(
    (request: DeformRequest) => {
      setDeformOpen(false);
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("עיוות גוף", async () => {
        const outcome = await applyDeform(doc, layer, request);
        applyOpResult("עיוות גוף", [outcome.layer], [layer.id], "hide", outcome.warningsHe);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult]
  );

  const handleLatticeConfirm = useCallback(
    (settings: LatticeSettings) => {
      setLatticeOpen(false);
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("מילוי סריג", async () => {
        const mesh = await layerToWorldMesh(doc, layer);
        // The printability check is only real if the nozzle reaches it; the
        // dialog cannot know which printer the document targets.
        const result = await jobs.run(
          "latticeFill",
          {
            mesh,
            settings: { ...settings, nozzleDiameterMm: documentNozzleDiameterMm(doc) },
          },
          "מילוי סריג"
        );
        if (!result) return;
        const resultLayer = await meshToResultLayer(result.mesh, {
          nameHe: `${layer.name} — סריג`,
          descriptionHe: `מילוי סריג, תא ${settings.cellSizeMm} מ״מ`,
          materialSlotId: layer.materialSlotId,
          sourceLayerId: layer.id,
          kind: "hollowResult",
        });
        applyOpResult("מילוי סריג", [resultLayer], [layer.id], "hide", [
          `חיסכון בחומר: ${(result.savedFraction * 100).toFixed(0)}%`,
          ...result.warningsHe,
        ]);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult, jobs]
  );

  const handlePatternConfirm = useCallback(
    (settings: PatternSettings) => {
      setPatternOpen(false);
      const source = selectedLayers[0];
      if (!source) return;
      try {
        const { layers, labelHe } = buildPattern(source, settings);
        applyDocument({ ...doc, layers: [...doc.layers, ...layers] }, labelHe);
        dispatch({ type: "ui/select", selection: layers.map((l) => l.id) });
      } catch (err) {
        if (err instanceof PatternError) {
          setMessage({ titleHe: "מערך עותקים", bodyHe: err.messageHe, kind: "error" });
        } else {
          showError(err, "מערך עותקים");
        }
      }
    },
    [selectedLayers, doc, applyDocument, dispatch, showError]
  );

  // ---- V4: inspection --------------------------------------------------------

  const handleOpenInspector = useCallback(() => {
    const layer = selectedMeshLayers[0];
    if (!layer) return;
    setRepairReport(null);
    setDiagnosis(null);
    setInspectorOpen(true);
    void runOp("בדיקת רשת", async () => {
      const mesh = getMesh(layer.meshId);
      if (!mesh) throw new OpError("נתוני הרשת חסרים");
      const result = await jobs.run("diagnoseMesh", { mesh }, "בדיקת רשת");
      if (result) setDiagnosis(result);
    });
  }, [selectedMeshLayers, runOp, jobs]);

  const handleAdvancedRepair = useCallback(
    (options: RepairOptions) => {
      const layer = selectedMeshLayers[0];
      if (!layer) return;
      void runOp("תיקון רשת", async () => {
        const mesh = getMesh(layer.meshId);
        if (!mesh) throw new OpError("נתוני הרשת חסרים");
        // The voxel rebuild stage can take tens of seconds on a dense mesh.
        const report = await jobs.run("repairMesh", { mesh, options }, "תיקון רשת");
        if (!report) return;
        setRepairReport(report);
        if (report.succeeded && report.mesh) {
          const repairedId = storeMesh(report.mesh);
          updateLayer(
            layer.id,
            { meshId: repairedId, originalMeshId: layer.originalMeshId ?? layer.meshId },
            "תיקון רשת"
          );
          const rediagnosed = await jobs.run(
            "diagnoseMesh",
            { mesh: report.mesh },
            "בדיקה חוזרת"
          );
          if (rediagnosed) setDiagnosis(rediagnosed);
        }
      });
    },
    [selectedMeshLayers, runOp, updateLayer, jobs]
  );

  /**
   * Point the camera at a reported problem. A fresh object identity is
   * always stored so clicking the same issue twice re-centres the view.
   */
  const handleNavigateTo = useCallback((location: { x: number; y: number; z: number }) => {
    setFocusTarget({ ...location });
  }, []);

  const handleCheckInterference = useCallback(() => {
    void runOp("בדיקת חדירה", async () => {
      setInterference(await detectInterference(build.parts));
    });
  }, [build.parts, runOp]);

  const handleArrangePlate = useCallback(() => {
    const arranged = arrangePartsOnPlate(doc, build.parts, printer);
    if (!arranged) return;
    applyDocument({ ...doc, layers: arranged.layers }, "סידור אוטומטי על המשטח");
    setMessage({
      titleHe: "סידור אוטומטי",
      bodyHe: arranged.summaryHe,
      kind: arranged.unplacedCount > 0 ? "info" : "success",
    });
  }, [build.parts, doc, printer, applyDocument]);

  // ---- V5: revolve, emboss, hierarchy ----------------------------------------

  const handleRevolveConfirm = useCallback(
    (settings: RevolveSettings) => {
      setRevolveOpen(false);
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("סיבוב פרופיל", async () => {
        const outcome = await applyRevolve(doc, layer, settings);
        applyOpResult("סיבוב פרופיל", [outcome.layer], [layer.id], "hide", outcome.warningsHe);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult]
  );

  /** Bodies that can receive an emboss (everything but the artwork itself). */
  const embossTargets = useMemo(
    () =>
      doc.layers
        .filter(
          (l) => isShapeLayer(l) && l.id !== singleSelectedShape?.id && partByLayer.has(l.id)
        )
        .map((l) => ({ id: l.id, nameHe: l.name })),
    [doc.layers, singleSelectedShape, partByLayer]
  );

  const handleEmbossConfirm = useCallback(
    (targetLayerId: string, request: EmbossRequest) => {
      setEmbossOpen(false);
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
    [singleSelectedShape, doc, runOp, applyOpResult]
  );

  /**
   * Emergency save. Used by the error boundary, so it must not depend on the
   * export dialog or any other UI that might be the thing that crashed.
   */
  const handleDownloadDesign = useCallback(() => {
    try {
      const json = serializeDesignFile(doc);
      downloadBlob(
        new Blob([json], { type: "application/json" }),
        `printcraft-recovery${DESIGN_FILE_EXTENSION}`
      );
    } catch (err) {
      showError(err, "שמירת קובץ העיצוב נכשלה");
    }
  }, [doc, showError]);

  // ---- Wave C: calibration, supports, bridging --------------------------------

  const handleCalibrationChange = useCallback(
    (calibration: CalibrationSettings) => {
      applyDocument({ ...doc, calibration }, "כיול מדפסת");
    },
    [doc, applyDocument]
  );

  const handleCustomPrintersChange = useCallback(
    (customPrinters: PrinterProfile[]) => {
      applyDocument({ ...doc, customPrinters }, "מדפסות מותאמות");
    },
    [doc, applyDocument]
  );

  /**
   * Supports for every part on the plate, or just the selected ones.
   *
   * Taking `parts[0]` and calling it done left the other four parts of a
   * plate unsupported with nothing said about them — the report read as a
   * verdict on the whole print.
   */
  const handleGenerateSupports = useCallback(() => {
    const targets = selectedParts.length > 0 ? selectedParts : build.parts;
    if (targets.length === 0) return;
    void runOp("יצירת תמיכות", async () => {
      const profile = getPrintabilityProfile(doc.printabilityProfileId);
      const maxOverhangDeg =
        doc.customPrintability?.maxOverhangDeg ?? profile.maxOverhangDeg;

      const layers: DesignLayer[] = [];
      const lines: string[] = [];
      for (const part of targets) {
        // Off-thread with progress + cancel. transferables=[] on purpose:
        // worldMesh doubles as live analysis/export data on this thread and
        // must not be detached by the postMessage.
        const jobResult = await jobs.run(
          "buildSupports",
          {
            mesh: part.worldMesh,
            settings: { ...DEFAULT_SUPPORT_SETTINGS, maxOverhangDeg },
          },
          `יצירת תמיכות — ${part.nameHe}`,
          { transferables: [] }
        );
        if (!jobResult) return; // cancelled
        lines.push(`${part.nameHe}: ${jobResult.result.summaryHe}`);
        if (!jobResult.mesh) continue;
        const kernel = await getGeometryKernel();
        const { solid, status } = kernel.fromMeshData(jobResult.mesh);
        if (status !== "NoError" || solid.isEmpty()) {
          solid.dispose();
          continue;
        }
        layers.push(
          generatorToLayer(
            solid,
            `${part.nameHe} — תמיכות`,
            primaryMaterialSlotId(doc),
            jobResult.result.summaryHe,
            "supportResult"
          )
        );
      }
      if (layers.length === 0) {
        setMessage({ titleHe: "תמיכות", bodyHe: lines.join("\n"), kind: "info" });
        return;
      }
      applyDocument({ ...doc, layers: [...doc.layers, ...layers] }, "יצירת תמיכות");
      dispatch({ type: "ui/select", selection: layers.map((l) => l.id) });
      setMessage({ titleHe: "תמיכות נוצרו", bodyHe: lines.join("\n"), kind: "success" });
    });
  }, [selectedParts, build.parts, doc, runOp, applyDocument, dispatch, jobs]);

  const handleCheckBridging = useCallback(() => {
    const targets = selectedParts.length > 0 ? selectedParts : build.parts;
    if (targets.length === 0) return;
    void runOp("בדיקת גישורים", async () => {
      // Every part, named. A verdict computed from one body out of five read
      // as a verdict on the print.
      const reports = targets.map((part) => ({
        part,
        report: analyzeBridging(part.worldMesh),
      }));
      const worst = reports.reduce((a, b) =>
        b.report.longestMm > a.report.longestMm ? b : a
      );
      const lines = reports.map((r) => `${r.part.nameHe}: ${r.report.summaryHe}`);
      setMessage({
        titleHe: "בדיקת גישורים",
        bodyHe:
          worst.report.spans.length === 0
            ? lines.join("\n")
            : `${lines.join("\n")}\n\nגישור נדרש כאשר יש חומר ללא תמיכה מתחתיו. עד 5 מ״מ המדפסת מגשרת ללא בעיה; מעל 20 מ״מ סביר שהחוט יישבר.`,
        kind: worst.report.longestMm > 20 ? "error" : "info",
      });
      if (worst.report.spans[0]) setFocusTarget({ ...worst.report.spans[0].center });
    });
  }, [selectedParts, build.parts, runOp]);

  const handleAnalyzeWarping = useCallback(() => {
    const targets = selectedParts.length > 0 ? selectedParts : build.parts;
    if (targets.length === 0) return;
    void runOp("ניתוח כיווץ", async () => {
      const levelHe = { low: "נמוך", medium: "בינוני", high: "גבוה" } as const;
      const sections = targets.map((part) => {
        const a = analyzeWarping(part.worldMesh);
        return `${part.nameHe}: סיכון ${levelHe[a.riskLevel]} (${a.riskScore}/100)\n${a.explanationHe.map((line) => `• ${line}`).join("\n")}`;
      });
      const worstHigh = targets.some(
        (part) => analyzeWarping(part.worldMesh).riskLevel === "high"
      );
      setMessage({
        titleHe: "ניתוח כיווץ (Warping) — היוריסטיקה מוסברת",
        bodyHe: sections.join("\n\n"),
        kind: worstHigh ? "error" : "info",
      });
    });
  }, [selectedParts, build.parts, runOp]);

  const handleGenerateBrim = useCallback(() => {
    const targets = selectedParts.length > 0 ? selectedParts : build.parts;
    if (targets.length === 0) return;
    void runOp("הוספת Brim", async () => {
      const kernel = await getGeometryKernel();
      const layers: DesignLayer[] = [];
      const lines: string[] = [];
      for (const part of targets) {
        const outcome = await buildBrim(kernel, part.worldMesh);
        lines.push(`${part.nameHe}: ${outcome.summaryHe}`);
        layers.push(
          generatorToLayer(
            outcome.solid,
            `${part.nameHe} — Brim`,
            primaryMaterialSlotId(doc),
            outcome.summaryHe,
            "brimResult"
          )
        );
      }
      applyDocument({ ...doc, layers: [...doc.layers, ...layers] }, "הוספת Brim");
      dispatch({ type: "ui/select", selection: layers.map((l) => l.id) });
      setMessage({ titleHe: "Brim נוסף", bodyHe: lines.join("\n"), kind: "success" });
    });
  }, [selectedParts, build.parts, doc, runOp, applyDocument, dispatch]);

  const handleGenerateRaft = useCallback(() => {
    const targets = selectedParts.length > 0 ? selectedParts : build.parts;
    if (targets.length === 0) return;
    void runOp("הוספת Raft", async () => {
      const kernel = await getGeometryKernel();
      const raftLayers: DesignLayer[] = [];
      const lines: string[] = [];
      // Two changes in ONE history step: the raft layers appear and each
      // part is lifted onto its raft — undo reverts both together.
      let layers = doc.layers;
      for (const part of targets) {
        const outcome = await buildRaft(kernel, part.worldMesh);
        lines.push(`${part.nameHe}: ${outcome.summaryHe}`);
        const raftLayer = generatorToLayer(
          outcome.solid,
          `${part.nameHe} — Raft`,
          primaryMaterialSlotId(doc),
          outcome.summaryHe,
          "raftResult"
        );
        raftLayers.push(raftLayer);
        layers = layers.map((l) =>
          l.id === part.primaryLayerId && !l.locked
            ? { ...l, transform: { ...l.transform, z: l.transform.z + outcome.liftMm } }
            : l
        );
      }
      applyDocument({ ...doc, layers: [...layers, ...raftLayers] }, "הוספת Raft");
      dispatch({ type: "ui/select", selection: raftLayers.map((l) => l.id) });
      setMessage({ titleHe: "Raft נוסף", bodyHe: lines.join("\n"), kind: "success" });
    });
  }, [selectedParts, build.parts, doc, runOp, applyDocument, dispatch]);

  const handleReparent = useCallback(
    (childId: string, parentId: string | null) => {
      if (childId === parentId) return;
      // Refuse a cycle: walking up from the proposed parent must not reach
      // the child. The build defends against cycles too, but rejecting here
      // means the document never holds an invalid state at all.
      const byId = new Map(doc.layers.map((l) => [l.id, l]));
      let cursor = parentId ? byId.get(parentId) : undefined;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor.id === childId) {
          setMessage({
            titleHe: "קישור הורה נדחה",
            bodyHe: "לא ניתן להפוך שכבה לבן של אחד מצאצאיה — ייווצר מעגל.",
            kind: "error",
          });
          return;
        }
        if (seen.has(cursor.id)) break;
        seen.add(cursor.id);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
      updateLayer(childId, { parentId } as Partial<DesignLayer>, "שינוי היררכיה");
    },
    [doc.layers, updateLayer]
  );

  // ---- V5: sub-object selection ----------------------------------------------

  const faceSelection = state.ui.faceSelection;

  /** The part whose faces are currently selected. */
  const faceSelectionPart = useMemo(
    () => (faceSelection ? partByLayer.get(faceSelection.layerId) ?? null : null),
    [faceSelection, partByLayer]
  );

  const regionInfo: RegionInfo | null = useMemo(() => {
    if (!faceSelection || !faceSelectionPart || faceSelection.triangles.length === 0) {
      return null;
    }
    const mesh = faceSelectionPart.worldMesh;
    const adjacency = buildAdjacency(mesh);
    const set = new Set(faceSelection.triangles);
    return {
      triangleCount: set.size,
      areaMm2: selectionArea(adjacency, set),
      planar: isSelectionPlanarForUi(mesh, adjacency, set),
    };
  }, [faceSelection, faceSelectionPart]);

  const handleFacePick = useCallback(
    (primaryLayerId: string, triangleIndex: number, additive: boolean) => {
      const part = partByLayer.get(primaryLayerId);
      if (!part) return;
      const adjacency = buildAdjacency(part.worldMesh);
      const grown = growSelection(adjacency, triangleIndex, {
        mode: state.ui.faceGrowMode,
        angleToleranceDeg: state.ui.faceGrowAngleDeg,
      });
      // Additive picking only merges within the SAME body; picking on a
      // different body replaces, because triangle indices do not transfer.
      const merged =
        additive && faceSelection && faceSelection.layerId === primaryLayerId
          ? new Set([...faceSelection.triangles, ...grown])
          : grown;
      dispatch({
        type: "ui/setFaceSelection",
        selection: { layerId: primaryLayerId, triangles: [...merged] },
      });
      // Keep the body selected too, so the properties panel stays in context.
      if (!selection.includes(primaryLayerId)) {
        dispatch({ type: "ui/select", selection: [primaryLayerId] });
        dispatch({
          type: "ui/setFaceSelection",
          selection: { layerId: primaryLayerId, triangles: [...merged] },
        });
      }
    },
    [partByLayer, state.ui.faceGrowMode, state.ui.faceGrowAngleDeg, faceSelection, dispatch, selection]
  );

  const handleSelectAllFaces = useCallback(() => {
    const part = selectedParts[0];
    if (!part) return;
    const count = part.worldMesh.indices.length / 3;
    dispatch({
      type: "ui/setFaceSelection",
      selection: {
        layerId: part.primaryLayerId,
        triangles: Array.from({ length: count }, (_, i) => i),
      },
    });
  }, [selectedParts, dispatch]);

  /** Shared plumbing: run a region operation and replace the source layer. */
  const runRegionOp = useCallback(
    (
      labelHe: string,
      fn: (
        mesh: import("@/lib/geometry/meshData").MeshData,
        triangles: Set<number>
      ) => Promise<{ layers: DesignLayer[]; warningsHe: string[] } | null>
    ) => {
      const sel = state.ui.faceSelection;
      if (!sel || sel.triangles.length === 0) return;
      const part = partByLayer.get(sel.layerId);
      const layer = doc.layers.find((l) => l.id === sel.layerId);
      if (!part || !layer || layer.locked) return;
      void runOp(labelHe, async () => {
        const outcome = await fn(part.worldMesh, new Set(sel.triangles));
        // null = the user cancelled the job; nothing must change.
        if (!outcome) return;
        dispatch({ type: "ui/setFaceSelection", selection: null });
        applyOpResult(labelHe, outcome.layers, [layer.id], "hide", outcome.warningsHe);
      });
    },
    [state.ui.faceSelection, partByLayer, doc.layers, runOp, applyOpResult, dispatch]
  );

  const handleFilletRegion = useCallback(() => {
    const sel = state.ui.faceSelection;
    const layer = sel ? doc.layers.find((l) => l.id === sel.layerId) : null;
    if (!layer || !isShapeLayer(layer)) return;
    runRegionOp("עיגול אזור", async (mesh, triangles) => {
      // Runs as a job (worker + cancel): whole-body rounding is Minkowski.
      // transferables=[]: the worldMesh must stay live on this thread.
      const result = await jobs.run(
        "filletRegion",
        {
          mesh,
          regionTriangles: [...triangles],
          settings: { sizeMm: filletRegionMm, style: "fillet", scope: "both" },
        },
        "עיגול אזור",
        { transferables: [] }
      );
      if (!result) return null; // cancelled — nothing changes
      const resultLayer = await meshToResultLayer(result.mesh, {
        nameHe: `${layer.name} — עיגול אזור`,
        descriptionHe: `עיגול אזור נבחר ברדיוס ${filletRegionMm} מ״מ`,
        materialSlotId: layer.materialSlotId,
        sourceLayerId: layer.id,
      });
      return { layers: [resultLayer], warningsHe: result.warningsHe };
    });
  }, [state.ui.faceSelection, doc.layers, runRegionOp, filletRegionMm, jobs]);

  const handlePushPull = useCallback(() => {
    const sel = state.ui.faceSelection;
    const layer = sel ? doc.layers.find((l) => l.id === sel.layerId) : null;
    if (!layer || !isShapeLayer(layer)) return;
    runRegionOp("הזזת פאה", async (mesh, triangles) => {
      const kernel = await getGeometryKernel();
      const { solid, status } = kernel.fromMeshData(mesh);
      if (status !== "NoError") {
        solid.dispose();
        throw new OpError(`הגוף אינו תקין (${status}) — הפעילו ״תיקון רשת״ תחילה`);
      }
      const result = pushPullRegion(kernel, solid, mesh, triangles, {
        distanceMm: pushPullMm,
      });
      const resultMesh = result.toMeshData();
      result.dispose();
      const resultLayer = await meshToResultLayer(resultMesh, {
        nameHe: `${layer.name} — הזזת פאה`,
        descriptionHe: `הזזת פאה ב-${pushPullMm} מ״מ`,
        materialSlotId: layer.materialSlotId,
        sourceLayerId: layer.id,
      });
      return { layers: [resultLayer], warningsHe: [] };
    });
  }, [state.ui.faceSelection, doc.layers, runRegionOp, pushPullMm]);

  const handleRegionSmooth = useCallback(() => {
    const sel = state.ui.faceSelection;
    const layer = sel ? doc.layers.find((l) => l.id === sel.layerId) : null;
    if (!layer) return;
    runRegionOp("החלקה מקומית", async (mesh, triangles) => {
      const smoothed = smoothRegion(mesh, triangles, { iterations: 6, strength: 0.6 });
      const resultLayer = await meshToResultLayer(smoothed, {
        nameHe: `${layer.name} — החלקה מקומית`,
        descriptionHe: "החלקה של אזור נבחר",
        materialSlotId: layer.materialSlotId,
        sourceLayerId: layer.id,
      });
      return { layers: [resultLayer], warningsHe: [] };
    });
  }, [state.ui.faceSelection, doc.layers, runRegionOp]);

  const handleRegionDelete = useCallback(() => {
    const sel = state.ui.faceSelection;
    const layer = sel ? doc.layers.find((l) => l.id === sel.layerId) : null;
    if (!layer) return;
    runRegionOp("מחיקת אזור", async (mesh, triangles) => {
      const result = deleteRegion(mesh, triangles, { cap: true });
      const resultLayer = await meshToResultLayer(result.mesh, {
        nameHe: `${layer.name} — אזור הוסר`,
        descriptionHe: `הוסרו ${result.trianglesRemoved} משולשים`,
        materialSlotId: layer.materialSlotId,
        sourceLayerId: layer.id,
      });
      return {
        layers: [resultLayer],
        warningsHe: result.capped ? [] : ["החור שנוצר לא נאטם — הפעילו ״תיקון רשת״"],
      };
    });
  }, [state.ui.faceSelection, doc.layers, runRegionOp]);

  const handleRegionSplit = useCallback(() => {
    const sel = state.ui.faceSelection;
    const layer = sel ? doc.layers.find((l) => l.id === sel.layerId) : null;
    if (!layer) return;
    runRegionOp("הפרדת אזור", async (mesh, triangles) => {
      const { regionMesh, remainderMesh } = splitByRegion(mesh, triangles);
      const regionLayer = await meshToResultLayer(regionMesh, {
        nameHe: `${layer.name} — אזור`,
        descriptionHe: "אזור שהופרד",
        materialSlotId: layer.materialSlotId,
        sourceLayerId: layer.id,
        kind: "splitPart",
      });
      const remainderLayer = await meshToResultLayer(remainderMesh, {
        nameHe: `${layer.name} — שארית`,
        descriptionHe: "שארית אחרי הפרדה",
        materialSlotId: layer.materialSlotId,
        sourceLayerId: layer.id,
        kind: "splitPart",
      });
      return { layers: [regionLayer, remainderLayer], warningsHe: [] };
    });
  }, [state.ui.faceSelection, doc.layers, runRegionOp]);

  // ---- V5: per-face material painting ---------------------------------------

  /**
   * Painting is metadata, not geometry: it records which material each
   * triangle belongs to and leaves the body alone. The separation into
   * per-colour printable parts happens in the export handler.
   */
  const paintTargetLayer = useMemo(
    () => (faceSelection ? doc.layers.find((l) => l.id === faceSelection.layerId) ?? null : null),
    [faceSelection, doc.layers]
  );

  const paintTriangleCount = faceSelectionPart
    ? faceSelectionPart.localMesh.indices.length / 3
    : 0;

  // Default to the SECOND slot: painting with the body's own colour is a
  // no-op, and the whole point of the tool is contrast.
  const resolvedPaintSlotId =
    paintSlotId && doc.materialSlots.some((s) => s.id === paintSlotId)
      ? paintSlotId
      : (doc.materialSlots[1]?.id ?? primaryMaterialSlotId(doc));

  const paintInfo: PaintInfo | null = useMemo(() => {
    if (!paintTargetLayer || !faceSelectionPart) return null;
    const active = activePaints(paintTargetLayer.facePaint, paintTriangleCount);
    const owners = paintedTriangleSlots(active);
    const selected = faceSelection?.triangles ?? [];
    return {
      countBySlot: active.map((p) => ({
        slotId: p.materialSlotId,
        triangles: p.triangles.length,
      })),
      stale: hasStalePaint(paintTargetLayer.facePaint, paintTriangleCount),
      selectionPainted: selected.length > 0 && selected.some((t) => owners.has(t)),
    };
  }, [paintTargetLayer, faceSelectionPart, paintTriangleCount, faceSelection]);

  const handlePaintRegion = useCallback(() => {
    const sel = state.ui.faceSelection;
    if (!sel || sel.triangles.length === 0 || !paintTargetLayer) return;
    if (paintTargetLayer.locked) return;
    updateLayer(
      paintTargetLayer.id,
      {
        facePaint: paintTriangles(
          paintTargetLayer.facePaint,
          resolvedPaintSlotId,
          sel.triangles,
          paintTriangleCount,
          paintDepthMm,
          // Spatial anchors: what lets the paint survive a rebuild (V6).
          faceSelectionPart?.localMesh
        ),
      },
      "צביעת אזור"
    );
  }, [
    state.ui.faceSelection,
    paintTargetLayer,
    resolvedPaintSlotId,
    paintTriangleCount,
    paintDepthMm,
    updateLayer,
    faceSelectionPart,
  ]);

  const handleUnpaintRegion = useCallback(() => {
    const sel = state.ui.faceSelection;
    if (!sel || !paintTargetLayer || paintTargetLayer.locked) return;
    updateLayer(
      paintTargetLayer.id,
      {
        facePaint: unpaintTriangles(
          paintTargetLayer.facePaint,
          sel.triangles,
          paintTriangleCount,
          faceSelectionPart?.localMesh
        ),
      },
      "הסרת צבע מאזור"
    );
  }, [state.ui.faceSelection, paintTargetLayer, paintTriangleCount, updateLayer, faceSelectionPart]);

  const handleClearPaint = useCallback(() => {
    if (!paintTargetLayer || paintTargetLayer.locked) return;
    updateLayer(paintTargetLayer.id, { facePaint: [] }, "ניקוי צביעה");
  }, [paintTargetLayer, updateLayer]);

  // ---- V4: parameters, modifiers, history, memory, recovery ------------------

  const parameterTable = useMemo(
    () => resolveParameters(doc.parameters ?? []),
    [doc.parameters]
  );

  const handleParametersChange = useCallback(
    (parameters: ParameterDefinition[]) => {
      applyDocument({ ...doc, parameters }, "עדכון פרמטרים");
    },
    [doc, applyDocument]
  );

  const singleSelectedLayerForModifiers = selectedLayers.length === 1 ? selectedLayers[0] : null;

  const handleModifiersChange = useCallback(
    (modifiers: Modifier[]) => {
      const layer = singleSelectedLayerForModifiers;
      if (!layer) return;
      updateLayer(layer.id, { modifiers } as Partial<DesignLayer>, "עדכון מודיפיירים");
    },
    [singleSelectedLayerForModifiers, updateLayer]
  );

  const handleAddModifier = useCallback(
    (kind: ModifierKind) => {
      const layer = singleSelectedLayerForModifiers;
      if (!layer) return;
      const next = [...(layer.modifiers ?? []), defaultModifier(kind, newId("mod"))];
      updateLayer(layer.id, { modifiers: next } as Partial<DesignLayer>, "הוספת מודיפייר");
    },
    [singleSelectedLayerForModifiers, updateLayer]
  );

  const handleEditModifier = useCallback((id: string) => {
    // Editing opens the same dialog the one-shot operation uses; the dialog
    // writes back into the stack entry rather than baking a new mesh.
    setEditingModifierId(id);
  }, []);

  // The mesh store is an external mutable source, but it only ever changes
  // alongside the document (or when the GC handler runs), so deriving the
  // readout is correct and avoids a setState-in-effect cascade.
  const memoryStats: MeshStoreStats = useMemo(() => {
    void doc;
    void memoryVersion;
    return meshStoreStats();
  }, [doc, memoryVersion]);

  // The history is bounded (HISTORY_CAPACITY): entries that fall off the old
  // end may hold the last reference to a stored mesh, so every history change
  // sweeps the store. A pending STL import (stored, previewed, not yet a
  // layer) is passed as an extra root or an edit made while its dialog is
  // open would free it out from under the confirm button.
  useEffect(() => {
    const pendingStl = pendingStlRef.current;
    const result = sweepUnreferencedMeshes(
      state.history,
      pendingStl ? [pendingStl.meshId] : []
    );
    if (result.removed > 0) setMemoryVersion((v) => v + 1);
  }, [state.history]);

  // Paint recorded with spatial anchors survives a rebuild by re-projection
  // (V6 item 17): after each completed build, a layer whose paint no longer
  // matches its body is re-anchored onto the new mesh — quietly, with no
  // history entry, exactly like a derived value. Entries without anchors
  // (pre-V6 paint) keep the old discard-with-warning behaviour.
  useEffect(() => {
    if (build.parts.length === 0) return;
    let changed = false;
    const document = state.history.present.document;
    const layers = document.layers.map((layer) => {
      if (!layer.facePaint || layer.facePaint.length === 0) return layer;
      const part = build.parts.find((p) => p.primaryLayerId === layer.id);
      if (!part) return layer;
      const count = part.localMesh.indices.length / 3;
      if (!hasStalePaint(layer.facePaint, count)) return layer;
      const result = reanchorPaints(layer.facePaint, part.localMesh);
      if (result.reanchored === 0 && result.dropped === 0) return layer;
      changed = true;
      return { ...layer, facePaint: result.paints };
    });
    if (changed) {
      dispatch({ type: "document/replaceTransient", document: { ...document, layers } });
    }
  }, [build.buildId, build.parts, state.history.present.document, dispatch]);

  const handleCollectGarbage = useCallback(() => {
    // Sweep against the union of every state in the history: a mesh that only
    // a past state references must survive, or undo would produce an empty
    // layer.
    const result = garbageCollect(referencedMeshIds(state.history));
    setMemoryVersion((v) => v + 1);
    setMessage({
      titleHe: "פינוי זיכרון",
      bodyHe:
        result.removed === 0
          ? "לא נמצאו גופים מיותרים בזיכרון"
          : `שוחררו ${result.removed} גופים (${(result.freedBytes / 1048576).toFixed(1)} מ״ב). נותרו ${result.remaining}.`,
      kind: "success",
    });
  }, [state.history]);

  const handleHistoryJump = useCallback(
    (delta: number) => {
      if (delta !== 0) dispatch({ type: "history/jump", delta });
    },
    [dispatch]
  );

  // Offer crash recovery once, on startup.
  useEffect(() => {
    let cancelled = false;
    void peekSnapshot().then((snapshot) => {
      if (!cancelled && snapshot) setRecovery(snapshot);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Autosave the single recovery slot, debounced so typing does not thrash
  // IndexedDB. Failures are silent by design — this is a safety net, not a
  // save button.
  useEffect(() => {
    const timer = setTimeout(() => {
      void saveSnapshot(doc);
    }, 4000);
    return () => clearTimeout(timer);
  }, [doc]);

  const handleAcceptRecovery = useCallback(() => {
    const snapshot = recovery;
    if (!snapshot) return;
    setRecovery(null);
    try {
      const result = restoreSnapshot(snapshot);
      applyDocument(result.document, "שחזור עבודה");
      if (result.warningsHe.length > 0) {
        setMessage({
          titleHe: "העבודה שוחזרה עם הערות",
          bodyHe: result.warningsHe.join("\n"),
          kind: "info",
        });
      }
    } catch (err) {
      showError(err, "שחזור העבודה נכשל");
    }
  }, [recovery, applyDocument, showError]);

  const handleDismissRecovery = useCallback((disableFuture: boolean) => {
    setRecovery(null);
    if (disableFuture) setRecoveryDisabled(true);
    void clearSnapshot();
  }, []);

  // ---- analysis ------------------------------------------------------------

  // Extracted to hooks/useAnalysisRunner.ts.
  const { runAnalysis, handleSuggestOrientation, handleApplyOrientation } =
    useAnalysisRunner({
      doc,
      build,
      printer,
      overlay: state.ui.overlay,
      selectedParts,
      showError,
      commitTransform,
      setAnalysisBusy,
      setModelIssues,
      setOverlayColors,
      setEstimate,
      setOrientationCandidates,
    });

  // ---- imports --------------------------------------------------------------

  // Extracted to hooks/useImportHandlers.ts: STL, SVG, image and design-file
  // loading is a self-contained domain, and Editor.tsx had grown past 2,800
  // lines holding every concern at once.
  const {
    handleStlFile,
    confirmStlImport,
    handleSvgConfirm,
    handleImageFile,
    handleImageConfirm,
    handleDesignFile,
  } = useImportHandlers({
    doc,
    dispatch,
    runOp,
    applyDocument,
    setMessage,
    setStlPreview,
    pendingStlRef,
    svgPending,
    setSvgPending,
    imagePending,
    setImagePending,
  });


  // ---- export ---------------------------------------------------------------

  const handleExport = useCallback(
    (kind: ExportKind, fileName: string) => {
      setExportOpen(false);
      void runOp("ייצוא", async () => {
        if (kind === "design") {
          const json = serializeDesignFile(doc);
          downloadBlob(
            new Blob([json], { type: "application/json" }),
            `${fileName}${DESIGN_FILE_EXTENSION}`
          );
          return;
        }
        if (build.parts.length === 0) throw new OpError("אין חלקים לייצוא");

        // Painted regions become their own printable bodies — but only in the
        // formats that can carry more than one material. A single merged STL
        // has nowhere to put the second colour, so splitting it there would
        // just add seams to a file nobody can print in two colours anyway.
        let parts: PrintablePart[] = build.parts;
        if (kind !== "stl") {
          const split = await splitPartsByPaint(doc, build.parts);
          parts = split.parts;
          if (split.warningsHe.length > 0) {
            setMessage({
              titleHe: "הפרדת אזורים צבועים",
              bodyHe: split.warningsHe.join("\n"),
              kind: "info",
            });
          }
        }

        const output =
          kind === "threemf"
            ? buildThreeMfExport(doc, parts, fileName)
            : kind === "stl"
              ? buildStlExport(parts, fileName)
              : await buildZipExport(doc, parts, fileName);
        downloadBlob(output.blob, output.fileName);
      });
    },
    [doc, build.parts, runOp]
  );

  // ---- layers / mode -----------------------------------------------------------

  const handleDeleteLayer = useCallback(
    (id: string) => {
      const layer = doc.layers.find((l) => l.id === id);
      if (!layer || layer.locked) return;
      applyDocument(
        { ...doc, layers: doc.layers.filter((l) => l.id !== id) },
        `מחיקת "${layer.name}"`
      );
    },
    [doc, applyDocument]
  );

  const handleMoveLayer = useCallback(
    (id: string, direction: -1 | 1) => {
      const index = doc.layers.findIndex((l) => l.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= doc.layers.length) return;
      const layers = [...doc.layers];
      [layers[index], layers[target]] = [layers[target], layers[index]];
      applyDocument({ ...doc, layers }, "סידור שכבות");
    },
    [doc, applyDocument]
  );

  const handleDuplicateLayer = useCallback(
    (id: string) => {
      const layer = doc.layers.find((l) => l.id === id);
      if (!layer) return;
      const copy = {
        ...structuredClone(layer),
        id: newId("layer"),
        name: `${layer.name} (עותק)`,
        transform: duplicateTransform(layer.transform, { x: 10, y: -10, z: 0 }),
      } as DesignLayer;
      applyDocument({ ...doc, layers: [...doc.layers, copy] }, "שכפול שכבה");
      dispatch({ type: "ui/select", selection: [copy.id] });
    },
    [doc, applyDocument, dispatch]
  );

  const confirmModeSwitch = useCallback(() => {
    const target = modeSwitchTarget;
    setModeSwitchTarget(null);
    if (!target) return;
    let layers = doc.layers;
    if (target === "withBase" && !layers.some((l) => l.type === "base")) {
      layers = [makeBaseLayer(), ...layers];
    }
    applyDocument(
      { ...doc, baseMode: target, layers },
      target === "baseless" ? "מעבר למצב ללא בסיס" : "מעבר למצב עם בסיס"
    );
  }, [modeSwitchTarget, doc, applyDocument]);

  const handleApplyUsageProfile = useCallback(
    (profileId: string) => {
      applyDocument({ ...doc, usageProfileId: profileId }, "פרופיל שימוש");
    },
    [doc, applyDocument]
  );

  const addTextLayer = useCallback(() => {
    const layer = makeTextLayer({
      combine: doc.baseMode === "withBase" ? "raised" : "standalone",
      extrudeMm: doc.baseMode === "withBase" ? 1.5 : 4,
    });
    applyDocument({ ...doc, layers: [...doc.layers, layer] }, "הוספת טקסט");
    dispatch({ type: "ui/select", selection: [layer.id] });
  }, [doc, applyDocument, dispatch]);

  const addHoleLayer = useCallback(() => {
    const layer = makeHoleLayer({});
    applyDocument({ ...doc, layers: [...doc.layers, layer] }, "הוספת חור");
    dispatch({ type: "ui/select", selection: [layer.id] });
  }, [doc, applyDocument, dispatch]);

  // ---- measurements ---------------------------------------------------------

  const handleAddMeasurement = useCallback(
    (a: THREE.Vector3, b: THREE.Vector3) => {
      const measurement: Measurement = {
        id: newId("measure"),
        kind: "distance",
        a: { x: a.x, y: a.y, z: a.z },
        b: { x: b.x, y: b.y, z: b.z },
        valueMm: a.distanceTo(b),
      };
      dispatch({ type: "ui/addMeasurement", measurement });
    },
    [dispatch]
  );

  // ---- share links -----------------------------------------------------------

  const handleShareLink = useCallback(() => {
    const eligibility = shareLinkEligibility(doc);
    if (!eligibility.ok) {
      setMessage({ titleHe: "שיתוף בקישור", bodyHe: eligibility.reasonHe, kind: "info" });
      return;
    }
    void runOp("יצירת קישור שיתוף", async () => {
      const hash = await encodeShareHash(doc);
      if (!hash) {
        setMessage({
          titleHe: "שיתוף בקישור",
          bodyHe: "העיצוב גדול מדי לקישור — יש לשתף כקובץ עיצוב",
          kind: "info",
        });
        return;
      }
      const url = `${window.location.origin}${window.location.pathname}${hash}`;
      await navigator.clipboard.writeText(url);
      setMessage({
        titleHe: "הקישור הועתק",
        bodyHe:
          "הקישור מכיל את העיצוב עצמו (אין שרת ואין שמירה בענן) — כל מי שמקבל אותו רואה את העיצוב. פתיחת הקישור טוענת את העיצוב לזיכרון הדפדפן בלבד.",
        kind: "success",
      });
    });
  }, [doc, runOp]);

  // Load a shared design from the URL hash once, on startup.
  const hashLoadedRef = useRef(false);
  useEffect(() => {
    if (hashLoadedRef.current) return;
    hashLoadedRef.current = true;
    const hash = window.location.hash;
    if (!hash.startsWith(SHARE_HASH_PREFIX)) return;
    void (async () => {
      try {
        const { document: shared, warningsHe } = await decodeShareHash(hash);
        applyDocument(shared, "טעינת עיצוב מקישור");
        window.history.replaceState(null, "", window.location.pathname);
        if (warningsHe.length > 0) {
          setMessage({
            titleHe: "העיצוב מהקישור נטען עם הערות",
            bodyHe: warningsHe.join("\n"),
            kind: "info",
          });
        }
      } catch {
        setMessage({
          titleHe: "טעינת קישור",
          bodyHe: "הקישור אינו מכיל עיצוב תקין",
          kind: "error",
        });
      }
    })();
  }, [applyDocument]);

  // ---- keyboard shortcuts -----------------------------------------------------
  // The full 3D-tool set (V6 item 18), driven by an EDITABLE keymap stored
  // on this device (lib/keyboard/keymap.ts). Esc stays hardcoded — a panic
  // key must not be remappable into oblivion.

  /** Bounds of the selection (fallback: all parts) for framing and views. */
  const selectionFrame = useCallback(() => {
    const parts = selectedParts.length > 0 ? selectedParts : build.parts;
    const bounds = unionBounds(parts.map((part) => part.stats.bounds));
    if (!bounds) return null;
    return { center: boundsCenter(bounds), radius: boundsRadius(bounds) };
  }, [selectedParts, build.parts]);

  const handleFrameSelection = useCallback(() => {
    const frame = selectionFrame();
    if (!frame) return;
    setFocusTarget({ ...frame.center, fitRadius: frame.radius });
  }, [selectionFrame]);

  const handleViewPreset = useCallback(
    (kind: "top" | "front" | "side" | "iso") => {
      const frame = selectionFrame();
      if (!frame) return;
      setViewPreset((prev) => ({
        kind,
        center: frame.center,
        radius: frame.radius,
        nonce: (prev?.nonce ?? 0) + 1,
      }));
    },
    [selectionFrame]
  );

  const handleSelectAll = useCallback(() => {
    dispatch({
      type: "ui/select",
      selection: build.parts.map((p) => p.primaryLayerId),
    });
  }, [dispatch, build.parts]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Never swallow typing: form fields and editable content keep every key.
      if (
        target &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)
      ) {
        return;
      }
      if (e.code === "Escape") {
        dispatch({ type: "ui/setTool", tool: "select" });
        return;
      }
      const action = actionForEvent(e, keymap);
      if (!action) return;
      switch (action) {
        case "undo":
          e.preventDefault();
          dispatch({ type: "history/undo" });
          break;
        case "redo":
          e.preventDefault();
          dispatch({ type: "history/redo" });
          break;
        case "delete": {
          // One document update for the whole selection. The old per-layer
          // loop called the single-delete handler repeatedly over the SAME
          // stale document, so only the last deletion survived.
          const doomed = new Set(
            selectedLayers.filter((l) => !l.locked).map((l) => l.id)
          );
          if (doomed.size > 0) {
            const current = state.history.present.document;
            applyDocument(
              { ...current, layers: current.layers.filter((l) => !doomed.has(l.id)) },
              doomed.size === 1 ? "מחיקת שכבה" : `מחיקת ${doomed.size} שכבות`
            );
          }
          break;
        }
        case "toolSelect":
          dispatch({ type: "ui/setTool", tool: "select" });
          break;
        case "toolTranslate":
          dispatch({ type: "ui/setTool", tool: "translate" });
          break;
        case "toolRotate":
          dispatch({ type: "ui/setTool", tool: "rotate" });
          break;
        case "toolScale":
          dispatch({ type: "ui/setTool", tool: "scale" });
          break;
        case "frameSelection":
          handleFrameSelection();
          break;
        case "duplicate":
          e.preventDefault();
          handleDuplicate();
          break;
        case "selectAll":
          e.preventDefault();
          handleSelectAll();
          break;
        case "viewTop":
          handleViewPreset("top");
          break;
        case "viewFront":
          handleViewPreset("front");
          break;
        case "viewSide":
          handleViewPreset("side");
          break;
        case "viewIso":
          handleViewPreset("iso");
          break;
        case "shortcutHelp":
          e.preventDefault();
          setShortcutsOpen(true);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    dispatch,
    keymap,
    selectedLayers,
    state.history.present.document,
    applyDocument,
    handleFrameSelection,
    handleViewPreset,
    handleDuplicate,
    handleSelectAll,
  ]);

  // ---- derived UI -----------------------------------------------------------

  const paramIssues = build.validation.issues;
  const singleSelectedLayer = selectedLayers.length === 1 ? selectedLayers[0] : null;
  const selectedPartDims = selectedParts[0]?.stats.dimensionsMm ?? null;
  const cutBoundsZ = selectedParts[0]
    ? { min: selectedParts[0].stats.bounds.min.z, max: selectedParts[0].stats.bounds.max.z }
    : null;

  const totalDims = useMemo(() => {
    const bounds = unionBounds(build.parts.map((p) => p.stats.bounds));
    return bounds ? boundsSize(bounds) : null;
  }, [build.parts]);

  return (
    <div className="flex h-dvh flex-col bg-slate-100">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 shadow-sm">
        <h1 className="text-lg font-bold text-slate-800">PrintCraft STL Studio</h1>

        <select
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={doc.templateId ?? ""}
          aria-label="בחירת תבנית"
          onChange={(e) => {
            if (!e.target.value) return;
            applyDocument(createTemplateDocument(e.target.value), "טעינת תבנית");
          }}
        >
          <option value="">תבנית…</option>
          {PRODUCT_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.icon} {t.nameHe}
            </option>
          ))}
        </select>

        {/* Base mode selector */}
        <div className="flex overflow-hidden rounded-md border border-slate-300" role="group" aria-label="מצב בסיס">
          {(
            [
              ["withBase", "עם בסיס"],
              ["baseless", "ללא בסיס"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={doc.baseMode === mode}
              className={`px-3 py-1 text-sm ${
                doc.baseMode === mode
                  ? "bg-blue-600 text-white"
                  : "bg-white text-slate-600 hover:bg-slate-100"
              }`}
              onClick={() => doc.baseMode !== mode && setModeSwitchTarget(mode)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={!canUndo}
            title="ביטול (Ctrl+Z)"
            aria-label="ביטול"
            className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-30"
            onClick={() => dispatch({ type: "history/undo" })}
          >
            ↶
          </button>
          <button
            type="button"
            disabled={!canRedo}
            title="ביצוע מחדש (Ctrl+Y)"
            aria-label="ביצוע מחדש"
            className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-30"
            onClick={() => dispatch({ type: "history/redo" })}
          >
            ↷
          </button>
        </div>

        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          <button type="button" className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50" onClick={() => stlInputRef.current?.click()}>
            ייבוא STL
          </button>
          <button type="button" className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50" onClick={() => svgInputRef.current?.click()}>
            ייבוא SVG
          </button>
          <button type="button" className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50" onClick={() => imageInputRef.current?.click()}>
            ייבוא תמונה
          </button>
          <button type="button" className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50" onClick={() => designInputRef.current?.click()}>
            טעינת עיצוב
          </button>
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50"
            title="ספריית עיצובים עם גרסאות — במכשיר זה בלבד, ללא חשבון וללא סנכרון"
            onClick={() => setLibraryOpen(true)}
          >
            ספרייה
          </button>
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50"
            title="קיצורי מקלדת (Shift+?)"
            aria-label="קיצורי מקלדת"
            onClick={() => setShortcutsOpen(true)}
          >
            ⌨
          </button>
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50"
            title="קישור שמכיל את העיצוב עצמו — לעיצובים קטנים בלבד"
            onClick={handleShareLink}
          >
            שיתוף בקישור
          </button>
          <button
            type="button"
            className="rounded-md bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-700"
            onClick={() => setExportOpen(true)}
          >
            ייצוא ⬇
          </button>
        </div>
      </header>

      {/* Session-only notice */}
      <div className="border-b border-amber-100 bg-amber-50 px-4 py-1 text-center text-xs text-amber-800">
        העיצוב נשמר זמנית בדפדפן בלבד. רענון הדף או סגירתו עלולים למחוק שינויים. כדי
        לשמור להמשך עבודה, הורד קובץ עיצוב.
      </div>

      <main className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        {/* Panels (start side = right in RTL). Below lg the panel column is
            a COLLAPSIBLE bottom sheet, so a phone can give the whole screen
            to the viewport and pull the tools up only when needed. */}
        <aside
          data-testid="panel-drawer"
          className={`${panelOpen ? "max-h-[55dvh]" : "hidden"} w-full overflow-y-auto border-t border-slate-200 bg-white lg:block lg:max-h-none lg:w-[420px] lg:border-e lg:border-t-0`}
        >
          <Section title="יצירה">
            <CreatePanel
              busy={busy}
              onAddPrimitive={handleAddPrimitive}
              onAddSketch={handleAddSketch}
              onOpenGenerator={setGeneratorKind}
            />
          </Section>

          <Section title="שכבות">
            <div className="mb-1 flex gap-1">
              <button type="button" className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50" onClick={addTextLayer}>
                + טקסט
              </button>
              <button type="button" className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50" onClick={addHoleLayer}>
                + חור
              </button>
              {doc.baseMode === "withBase" && !doc.layers.some((l) => l.type === "base") && (
                <button
                  type="button"
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                  onClick={() => {
                    const base = makeBaseLayer();
                    applyDocument({ ...doc, layers: [base, ...doc.layers] }, "הוספת בסיס");
                  }}
                >
                  + בסיס
                </button>
              )}
            </div>
            <LayerListPanel
              document={doc}
              selection={selection}
              onSelect={(ids, additive) =>
                dispatch({
                  type: "ui/select",
                  selection: additive ? [...new Set([...selection, ...ids])] : ids,
                })
              }
              onUpdateLayer={updateLayer}
              onDeleteLayer={handleDeleteLayer}
              onDuplicateLayer={handleDuplicateLayer}
              onMoveLayer={handleMoveLayer}
              onReparent={handleReparent}
            />
          </Section>

          {singleSelectedLayer && (
            <Section title={`מאפיינים — ${singleSelectedLayer.name}`}>
              <PropertiesPanel
                document={doc}
                layer={singleSelectedLayer}
                onUpdate={(patch, labelHe) =>
                  updateLayer(singleSelectedLayer.id, patch, labelHe)
                }
              />
            </Section>
          )}

          <Section title="כלים">
            <ToolsPanel
              tool={state.ui.tool}
              transformSpace={state.ui.transformSpace}
              snap={state.ui.snap}
              selectedCount={selectedLayers.length}
              selectedShapeCount={selectedShapeLayers.length}
              selectedMeshCount={selectedMeshLayers.length}
              selectedPartCount={selectedParts.length}
              busy={busy}
              onSetTool={(tool) => dispatch({ type: "ui/setTool", tool })}
              onSetSpace={(space) => dispatch({ type: "ui/setTransformSpace", space })}
              onSetSnap={(snap) => dispatch({ type: "ui/setSnap", snap })}
              onDropToPlate={handleDropToPlate}
              onCenterOnPlate={handleCenterOnPlate}
              onMirror={handleMirror}
              onDuplicate={handleDuplicate}
              onAlign={handleAlign}
              onDistribute={handleDistribute}
              onSnapToCenter={handleSnapToCenter}
              onSnapToEdge={handleSnapToEdge}
              onBoolean={setBooleanKind}
              onCut={() => {
                if (cutBoundsZ) {
                  setCutPlane((p) => ({
                    ...p,
                    offsetMm: (cutBoundsZ.min + cutBoundsZ.max) / 2,
                  }));
                }
                setCutOpen(true);
              }}
              onSplitComponents={handleSplitComponents}
              onConnectors={() => setConnectorsOpen(true)}
              onHollow={() => setHollowOpen(true)}
              onDrain={() =>
                dispatch({
                  type: "ui/setTool",
                  tool: state.ui.tool === "drainHole" ? "select" : "drainHole",
                })
              }
              onThicken={() => setThickenOpen(true)}
              onSmooth={() => setSmoothOpen(true)}
              onSimplify={() => setSimplifyOpen(true)}
              onRepair={handleRepair}
              onFillet={() => setFilletOpen(true)}
              onShell={() => setShellOpen(true)}
              onDeform={() => setDeformOpen(true)}
              onLattice={() => setLatticeOpen(true)}
              onPattern={() => setPatternOpen(true)}
              onInspectMesh={handleOpenInspector}
              onCheckInterference={handleCheckInterference}
              onArrangePlate={handleArrangePlate}
              onGenerateSupports={handleGenerateSupports}
              onCheckBridging={handleCheckBridging}
              onAnalyzeWarping={handleAnalyzeWarping}
              onGenerateBrim={handleGenerateBrim}
              onGenerateRaft={handleGenerateRaft}
              onRevolve={() => setRevolveOpen(true)}
              onEmboss={() => setEmbossOpen(true)}
              canRevolve={
                singleSelectedShape !== null &&
                ["sketch", "svg", "text", "imageRelief"].includes(singleSelectedShape.type)
              }
              partCount={build.parts.length}
            />
          </Section>

          {singleSelectedLayerForModifiers && (
            <Section title={`מודיפיירים — ${singleSelectedLayerForModifiers.name}`}>
              <ModifierStackPanel
                modifiers={singleSelectedLayerForModifiers.modifiers ?? []}
                disabled={busy || singleSelectedLayerForModifiers.locked}
                onChange={handleModifiersChange}
                onAdd={handleAddModifier}
                onEdit={handleEditModifier}
              />
            </Section>
          )}

          <Section title="כיול מדפסת">
            <CalibrationPanel
              calibration={doc.calibration}
              onChange={handleCalibrationChange}
              onGenerateCoupon={() => setGeneratorKind("toleranceTest")}
            />
            <div className="mt-2 border-t border-slate-200 pt-2">
              <p className="mb-1.5 text-xs font-bold text-slate-500">מדפסות מותאמות</p>
              <CustomPrinterPanel
                printers={doc.customPrinters ?? []}
                onChange={handleCustomPrintersChange}
              />
            </div>
          </Section>

          <Section title="פרמטרים">
            <ParametersPanel
              parameters={doc.parameters ?? []}
              resolved={parameterTable.values}
              errors={parameterTable.errors}
              onChange={handleParametersChange}
            />
          </Section>

          <Section title="היסטוריה">
            <HistoryPanel history={state.history} onJump={handleHistoryJump} />
            <div className="mt-2 border-t border-slate-200 pt-2">
              <MemoryPanel stats={memoryStats} onCollect={handleCollectGarbage} />
            </div>
          </Section>

          <Section title="עריכת פאות (תת־אובייקט)">
            <SubObjectPanel
              active={state.ui.tool === "faceSelect"}
              growMode={state.ui.faceGrowMode}
              growAngleDeg={state.ui.faceGrowAngleDeg}
              region={regionInfo}
              busy={busy}
              pushPullMm={pushPullMm}
              onToggleActive={() =>
                dispatch({
                  type: "ui/setTool",
                  tool: state.ui.tool === "faceSelect" ? "select" : "faceSelect",
                })
              }
              onSetGrowMode={(mode) => dispatch({ type: "ui/setFaceGrowMode", mode })}
              onSetGrowAngle={(degrees) => dispatch({ type: "ui/setFaceGrowAngle", degrees })}
              onSetPushPull={setPushPullMm}
              onPushPull={handlePushPull}
              filletRegionMm={filletRegionMm}
              onSetFilletRegionMm={setFilletRegionMm}
              onFilletRegion={handleFilletRegion}
              onSmooth={handleRegionSmooth}
              onDelete={handleRegionDelete}
              onSplit={handleRegionSplit}
              onSelectAll={handleSelectAllFaces}
              onClear={() => dispatch({ type: "ui/setFaceSelection", selection: null })}
              materialSlots={doc.materialSlots}
              paintSlotId={resolvedPaintSlotId}
              paintDepthMm={paintDepthMm}
              paint={paintInfo}
              onSetPaintSlot={setPaintSlotId}
              onSetPaintDepth={setPaintDepthMm}
              onPaint={handlePaintRegion}
              onUnpaint={handleUnpaintRegion}
              onClearPaint={handleClearPaint}
            />
          </Section>

          <Section title="בדיקת הדפסה וניתוח חזותי">
            <AnalysisPanel
              document={doc}
              paramIssues={paramIssues}
              modelIssues={[...(build.buildResult?.issues ?? []), ...build.parts.flatMap((p) => p.issues), ...modelIssues]}
              overlay={state.ui.overlay}
              analysisBusy={analysisBusy}
              estimate={estimate}
              onSetOverlay={(overlay) => {
                dispatch({ type: "ui/setOverlay", overlay });
                if (overlay !== "none") runAnalysis();
              }}
              onRunAnalysis={runAnalysis}
              onSuggestOrientation={handleSuggestOrientation}
              onUpdateDocument={(patch, labelHe) =>
                applyDocument({ ...doc, ...patch }, labelHe)
              }
              onApplyUsageProfile={handleApplyUsageProfile}
            />
          </Section>

          <Section title="בחינה ומדידה">
            <InspectPanel
              tool={state.ui.tool}
              section={state.ui.section}
              xray={state.ui.xray}
              printPreview={state.ui.printPreview}
              measurementCount={state.ui.measurements.length}
              selectedDims={selectedPartDims}
              busy={busy}
              onSetTool={(tool) => dispatch({ type: "ui/setTool", tool })}
              onSetSection={(section) => dispatch({ type: "ui/setSection", section })}
              onSetXray={(xray) => dispatch({ type: "ui/setXray", xray })}
              onSetPrintPreview={(preview) => dispatch({ type: "ui/setPrintPreview", preview })}
              onClearMeasurements={() => dispatch({ type: "ui/clearMeasurements" })}
              onScaleTo={handleScaleTo}
              onFitBuildVolume={handleFitBuildVolume}
            />
          </Section>
        </aside>

        {/* 3D viewport */}
        <section className="relative min-h-[45dvh] flex-1">
          {/* Phone/tablet: pull the tool sheet up or give the viewport the
              whole screen. Hidden on lg, where the panel is a fixed column. */}
          <button
            type="button"
            data-testid="panel-toggle"
            className="absolute bottom-3 end-3 z-10 rounded-full border border-slate-300 bg-white/95 px-4 py-2 text-sm font-medium text-slate-700 shadow lg:hidden"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            {panelOpen ? "הסתרת לוח הכלים ⌄" : "לוח הכלים ⌃"}
          </button>
          <JobProgressOverlay progress={jobs.progress} onCancel={jobs.cancel} />
          <ErrorBoundary
            areaHe="תצוגה התלת־ממדית"
            action={{ labelHe: "הורד קובץ עיצוב", onClick: handleDownloadDesign }}
          >
          <SceneView
            document={doc}
            parts={build.parts}
            selection={selection}
            tool={state.ui.tool}
            transformSpace={state.ui.transformSpace}
            snap={state.ui.snap}
            xray={state.ui.xray}
            section={state.ui.section}
            printPreview={state.ui.printPreview}
            overlay={state.ui.overlay}
            overlayColors={overlayColors}
            measurements={state.ui.measurements}
            printer={printer}
            building={build.status === "building"}
            onSelect={(ids, additive) =>
              dispatch({
                type: "ui/select",
                selection: additive ? [...new Set([...selection, ...ids])] : ids,
              })
            }
            onCommitTransform={commitTransform}
            onSurfacePick={handleSurfacePick}
            onAddMeasurement={handleAddMeasurement}
            focusTarget={focusTarget}
            viewPreset={viewPreset}
            faceSelection={faceSelection}
            onFacePick={handleFacePick}
            onRemoveMeasurement={(id) => dispatch({ type: "ui/removeMeasurement", id })}
          />
          </ErrorBoundary>
          {totalDims && (
            <div
              // Stable hook for the UI regression suite: this readout is
              // driven by the real geometry pipeline, so watching it is how
              // the tests prove an operation actually ran.
              data-testid="viewport-dimensions"
              // Honest execution-path report of the last completed build:
              // "worker" or "main". The e2e suite pins the worker path here —
              // a silent fallback would otherwise be invisible.
              data-build-ran-on={build.ranOn ?? ""}
              className="pointer-events-none absolute bottom-3 start-3 rounded-md bg-white/85 px-3 py-1.5 font-mono text-xs text-slate-700 shadow-sm"
              dir="ltr"
            >
              {totalDims.x.toFixed(1)} × {totalDims.y.toFixed(1)} × {totalDims.z.toFixed(1)} mm
              {build.parts.length > 1 && ` · ${build.parts.length} parts`}
            </div>
          )}
          {(busy || build.status === "building") && (
            <div className="pointer-events-none absolute end-3 top-3 flex items-center gap-2 rounded-md bg-white/90 px-3 py-1.5 text-xs text-slate-600 shadow">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
              {state.ui.busyLabelHe ??
                (build.progress
                  ? `${build.progress.labelHe} · ${Math.round(build.progress.fraction * 100)}%`
                  : // ranOn reports the LAST completed build; when it fell back
                    // to the main thread the next builds will too, so say so.
                    build.ranOn === "main"
                    ? "בונה מודל… (בחלון הראשי)"
                    : "בונה מודל…")}
            </div>
          )}
          {build.status === "invalid" && (
            <div className="pointer-events-none absolute start-1/2 top-3 -translate-x-1/2 rounded-md bg-red-600/90 px-3 py-1 text-xs text-white shadow">
              יש שגיאות בפרמטרים — ראו ״בדיקת הדפסה״
            </div>
          )}
        </section>
      </main>

      {/* Hidden file inputs */}
      <input ref={stlInputRef} type="file" accept=".stl" className="hidden" aria-label="קובץ STL" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void handleStlFile(f); }} />
      <input ref={svgInputRef} type="file" accept=".svg" className="hidden" aria-label="קובץ SVG" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { void f.text().then((text) => setSvgPending({ text, fileName: f.name })); } }} />
      <input ref={imageInputRef} type="file" accept={IMAGE_INPUT_ACCEPT} className="hidden" aria-label="קובץ תמונה" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleImageFile(f); }} />
      <input ref={designInputRef} type="file" accept=".json,.formadesign.json" className="hidden" aria-label="קובץ עיצוב" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void handleDesignFile(f); }} />

      {/* Dialogs */}
      <MessageDialog message={message} onClose={() => setMessage(null)} />
      <BooleanDialog
        kind={booleanKind}
        layerNames={selectedShapeLayers.map((l) => l.name)}
        onConfirm={handleBooleanConfirm}
        onClose={() => setBooleanKind(null)}
      />
      <CutDialog
        open={cutOpen}
        layerName={singleSelectedShape?.name ?? ""}
        boundsZ={cutBoundsZ}
        plane={cutPlane}
        onPlaneChange={setCutPlane}
        onConfirm={handleCutConfirm}
        onClose={() => setCutOpen(false)}
      />
      <ConnectorsDialog
        open={connectorsOpen}
        maleName={selectedMeshLayers[0]?.name ?? ""}
        femaleName={selectedMeshLayers[1]?.name ?? ""}
        onConfirm={handleConnectorsConfirm}
        onClose={() => setConnectorsOpen(false)}
      />
      <HollowDialog
        open={hollowOpen}
        layerName={singleSelectedShape?.name ?? ""}
        onConfirm={handleHollowConfirm}
        onClose={() => setHollowOpen(false)}
      />
      <DrainHoleDialog
        open={drainPick !== null}
        onConfirm={handleDrainConfirm}
        onClose={() => setDrainPick(null)}
      />
      <ThickenDialog
        open={thickenOpen}
        layerName={singleSelectedShape?.name ?? ""}
        onConfirm={handleThickenConfirm}
        onClose={() => setThickenOpen(false)}
      />
      <SmoothDialog
        open={smoothOpen}
        layerName={singleSelectedShape?.name ?? ""}
        onConfirm={handleSmoothConfirm}
        onClose={() => setSmoothOpen(false)}
      />
      <SimplifyDialog
        open={simplifyOpen}
        layerName={singleSelectedShape?.name ?? ""}
        currentTriangles={selectedParts[0]?.stats.triangleCount ?? 0}
        onConfirm={handleSimplifyConfirm}
        onClose={() => setSimplifyOpen(false)}
      />
      <StlImportDialog
        preview={stlPreview}
        onConfirm={confirmStlImport}
        onClose={() => {
          setStlPreview(null);
          pendingStlRef.current = null;
        }}
      />
      <SvgImportDialog
        open={svgPending !== null}
        fileName={svgPending?.fileName ?? ""}
        onConfirm={handleSvgConfirm}
        onClose={() => setSvgPending(null)}
      />
      <ImageImportDialog
        open={imagePending !== null}
        fileName={imagePending?.fileName ?? ""}
        onConfirm={handleImageConfirm}
        onClose={() => setImagePending(null)}
      />
      <ExportDialog
        open={exportOpen}
        document={doc}
        parts={build.parts}
        issues={[...(build.buildResult?.issues ?? []), ...modelIssues]}
        buildOk={build.status === "ok"}
        onExport={handleExport}
        onClose={() => setExportOpen(false)}
      />
      <ShortcutsDialog
        open={shortcutsOpen}
        keymap={keymap}
        onClose={() => setShortcutsOpen(false)}
        onChange={setKeymap}
      />
      <LibraryDialog
        open={libraryOpen}
        document={doc}
        onClose={() => setLibraryOpen(false)}
        onLoad={(loaded, labelHe, warningsHe) => {
          applyDocument(loaded, labelHe);
          dispatch({ type: "ui/select", selection: [] });
          if (warningsHe.length > 0) {
            setMessage({ titleHe: labelHe, bodyHe: warningsHe.join("\n"), kind: "info" });
          }
        }}
        onError={(messageHe) =>
          setMessage({ titleHe: "ספריית עיצובים", bodyHe: messageHe, kind: "error" })
        }
      />
      <OrientationDialog
        candidates={orientationCandidates}
        onApply={handleApplyOrientation}
        onClose={() => setOrientationCandidates(null)}
      />
      <BaseModeSwitchDialog
        targetMode={modeSwitchTarget}
        hasBaseLayer={doc.layers.some((l) => l.type === "base")}
        onConfirm={confirmModeSwitch}
        onClose={() => setModeSwitchTarget(null)}
      />
      <FilletDialog
        open={filletOpen}
        onConfirm={handleFilletConfirm}
        onClose={() => setFilletOpen(false)}
      />
      <ShellDialog
        open={shellOpen}
        onConfirm={handleShellConfirm}
        onClose={() => setShellOpen(false)}
      />
      <DeformDialog
        open={deformOpen}
        onConfirm={handleDeformConfirm}
        onClose={() => setDeformOpen(false)}
      />
      <LatticeDialog
        open={latticeOpen}
        onConfirm={handleLatticeConfirm}
        onClose={() => setLatticeOpen(false)}
      />
      <PatternDialog
        open={patternOpen}
        onConfirm={handlePatternConfirm}
        onClose={() => setPatternOpen(false)}
      />
      <GeneratorDialog
        kind={generatorKind}
        onConfirm={handleGeneratorConfirm}
        onClose={() => setGeneratorKind(null)}
      />
      <MeshInspectorDialog
        open={inspectorOpen}
        diagnosis={diagnosis}
        report={repairReport}
        busy={busy}
        onNavigate={handleNavigateTo}
        onRepair={handleAdvancedRepair}
        onClose={() => setInspectorOpen(false)}
      />
      <ModifierEditDialog
        modifier={
          (singleSelectedLayerForModifiers?.modifiers ?? []).find(
            (m) => m.id === editingModifierId
          ) ?? null
        }
        onClose={() => setEditingModifierId(null)}
        onChange={(next) =>
          handleModifiersChange(
            (singleSelectedLayerForModifiers?.modifiers ?? []).map((m) =>
              m.id === next.id ? next : m
            )
          )
        }
      />
      <RevolveDialog
        open={revolveOpen}
        onConfirm={handleRevolveConfirm}
        onClose={() => setRevolveOpen(false)}
      />
      <EmbossDialog
        open={embossOpen}
        artworkName={singleSelectedShape?.name ?? ""}
        targetOptions={embossTargets}
        onConfirm={handleEmbossConfirm}
        onClose={() => setEmbossOpen(false)}
      />
      <RecoveryDialog
        snapshot={recovery}
        ageHe={recovery ? describeSnapshotAge(recovery) : ""}
        onRestore={handleAcceptRecovery}
        onDismiss={handleDismissRecovery}
      />
      <InterferenceDialog
        open={interference !== null}
        report={interference}
        onNavigate={handleNavigateTo}
        onClose={() => setInterference(null)}
      />
    </div>
  );
}
