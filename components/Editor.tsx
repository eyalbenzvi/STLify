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
import * as THREE from "three";
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
import { defaultPrimitive, isShapeLayer, newId, type PrimitiveKind } from "@/types/design";
import { getPrintabilityProfile, getPrinterProfile, MATERIAL_PROFILES, USAGE_PROFILES } from "@/types/profiles";
import { useDocumentBuilder, type BuiltPart } from "@/hooks/useDocumentBuilder";
import { createTemplateDocument, makeBaseLayer, makeHoleLayer, makeTextLayer, PRODUCT_TEMPLATES } from "@/lib/geometry/documentTemplates";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import { meshDataBounds, transformMeshData } from "@/lib/geometry/meshData";
import { getMesh, storeMesh } from "@/lib/geometry/meshStore";
import { matrix4ToTransform, transformToMatrix4 } from "@/lib/geometry/transform";
import { performBoolean } from "@/lib/geometry/operations/booleans";
import { performPlaneCut, splitDisconnectedParts } from "@/lib/geometry/operations/cut";
import { addConnectors } from "@/lib/geometry/operations/connectors";
import { performDrainHoles, performHollow } from "@/lib/geometry/operations/hollow";
import { performSimplify, performSmooth, performThicken } from "@/lib/geometry/operations/meshRefine";
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
import { attemptMeshRepair } from "@/lib/geometry/repair/repair";
import {
  diagnoseMesh,
  repairMesh,
  type MeshDiagnosis,
  type MeshRepairReport,
  type RepairOptions,
} from "@/lib/geometry/repair/diagnose";
import {
  applyDeform,
  applyFillet,
  applyLattice,
  applyShell,
  generatorToLayer,
  type DeformRequest,
} from "@/lib/geometry/operations/advancedOps";
import type { FilletSettings, ShellSettings } from "@/lib/geometry/operations/fillet";
import type { LatticeSettings } from "@/lib/geometry/operations/lattice";
import { buildPattern, PatternError, type PatternSettings } from "@/lib/geometry/operations/pattern";
import {
  arrangeOnPlate,
  detectInterference,
  type InterferenceReport,
} from "@/lib/geometry/analysis/collision";
import {
  buildEnclosure,
  buildGear,
  buildLivingHinge,
  buildSnapFit,
  buildThread,
  buildToleranceTest,
  GeneratorError,
} from "@/lib/geometry/generators";
import {
  analyzeBuildVolume,
  analyzeContact,
  analyzeFloatingParts,
  analyzeOverhangs,
  analyzeThickness,
  overhangToVertexColors,
  suggestOrientations,
  thicknessToVertexColors,
  type OrientationCandidate,
} from "@/lib/geometry/analysis";
import { estimateDetailed, type DetailedEstimateResult } from "@/lib/geometry/analysis/estimateDetailed";
import { parseStl, StlImportError, summarizeStlMesh } from "@/lib/import/stl";
import { parseSvgToContours, SvgImportError } from "@/lib/import/svg";
import { sanitizeSvg } from "@/lib/import/svgSanitize";
import {
  decodeImageToGrid,
  gridToSilhouetteContours,
  heightFieldToClosedMesh,
  IMAGE_INPUT_ACCEPT,
  ImageImportError,
  smoothGrid,
  stripImageExtension,
  validateImageFile,
} from "@/lib/import/image";
import { downloadBlob } from "@/lib/export/stl";
import { meshDataToBinaryStl } from "@/lib/export/stlData";
import { buildMultiPartZip } from "@/lib/export/package";
import { buildThreeMf } from "@/lib/export/threeMF";
import { DESIGN_FILE_EXTENSION, DesignFileError, importDesignFile, serializeDesignFile } from "@/lib/serialization/designFile";
import { decodeShareHash, encodeShareHash, SHARE_HASH_PREFIX, shareLinkEligibility } from "@/lib/serialization/shareLink";
import type { ModelIssue } from "@/types/design";
import { Section } from "@/components/ui/Section";
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
  type ImageImportOptionsValue,
  type StlImportPreview,
  type SvgImportOptionsValue,
} from "@/components/dialogs/ImportDialogs";
import { ExportDialog, type ExportKind } from "@/components/dialogs/ExportDialog";
import { CreatePanel, type GeneratorKind } from "@/components/editor/CreatePanel";
import {
  DeformDialog,
  FilletDialog,
  GeneratorDialog,
  InterferenceDialog,
  LatticeDialog,
  MeshInspectorDialog,
  PatternDialog,
  ShellDialog,
  type GeneratorParams,
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

/** Read a File as ArrayBuffer. */
function readFileBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

function EditorInner() {
  const { state, dispatch, document: doc, selection, selectedLayers, canUndo, canRedo } =
    useEditor();
  const build = useDocumentBuilder(doc);
  const printer = getPrinterProfile(doc.printerProfileId);

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
  const [orientationCandidates, setOrientationCandidates] = useState<OrientationCandidate[] | null>(null);
  const [modeSwitchTarget, setModeSwitchTarget] = useState<"withBase" | "baseless" | null>(null);
  const [modelIssues, setModelIssues] = useState<ModelIssue[]>([]);
  const [overlayColors, setOverlayColors] = useState<Map<string, Float32Array>>(new Map());
  const [estimate, setEstimate] = useState<DetailedEstimateResult | null>(null);
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
  const [focusTarget, setFocusTarget] = useState<{ x: number; y: number; z: number } | null>(null);

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
        const result = await performDrainHoles(doc, layer, [
          {
            diameterMm,
            depthMm,
            position: pick.point,
            direction: { x: -pick.normal.x, y: -pick.normal.y, z: -pick.normal.z },
          },
        ]);
        applyOpResult("חור ניקוז", [result.layer], [layer.id], "hide", [
          ...result.warningsHe,
          result.reachedCavity[0]
            ? "החור הגיע לחלל הפנימי ✓"
            : "שימו לב: החור לא הגיע לחלל פנימי",
        ]);
      });
    },
    [drainPick, doc, runOp, applyOpResult, dispatch]
  );

  // ---- boolean / body operations -------------------------------------------

  const handleBooleanConfirm = useCallback(
    (sources: "keep" | "hide" | "replace") => {
      const kind = booleanKind;
      setBooleanKind(null);
      if (!kind || selectedShapeLayers.length < 2) return;
      void runOp("פעולה בוליאנית", async () => {
        const outcome = await performBoolean(doc, selectedShapeLayers, kind);
        applyOpResult(
          kind === "union" ? "איחוד" : kind === "difference" ? "חיסור" : "חיתוך משותף",
          [outcome.layer],
          selectedShapeLayers.map((l) => l.id),
          sources,
          outcome.warningsHe
        );
      });
    },
    [booleanKind, selectedShapeLayers, doc, runOp, applyOpResult]
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
        const outcome = await performHollow(doc, layer, settings);
        applyOpResult("חלול", [outcome.layer], [layer.id], "hide", [
          `נחסכו ${(outcome.savedFraction * 100).toFixed(0)}% מהחומר (${((outcome.originalVolumeMm3 - outcome.hollowVolumeMm3) / 1000).toFixed(1)} סמ״ק)`,
          ...outcome.warningsHe,
        ]);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult]
  );

  const handleThickenConfirm = useCallback(
    (thicknessMm: number) => {
      setThickenOpen(false);
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("עיבוי", async () => {
        const outcome = await performThicken(doc, layer, thicknessMm);
        applyOpResult("עיבוי", [outcome.layer], [layer.id], "hide", outcome.warningsHe);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult]
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
      const namesHe: Record<PrimitiveKind, string> = {
        box: "תיבה",
        cylinder: "גליל",
        sphere: "כדור",
        cone: "חרוט",
        torus: "טבעת",
        wedge: "טריז",
        tube: "צינור",
      };
      addLayer(
        {
          id: newId("layer"),
          type: "primitive",
          name: namesHe[kind],
          visible: true,
          locked: false,
          materialSlotId: doc.materialSlots[0]?.id ?? "slot1",
          transform: { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
          previewOpacity: 1,
          ...defaultPrimitive(kind),
        },
        `הוספת ${namesHe[kind]}`
      );
    },
    [addLayer, doc.materialSlots]
  );

  const handleAddSketch = useCallback(() => {
    addLayer(
      {
        id: newId("layer"),
        type: "sketch",
        name: "סקיצה",
        visible: true,
        locked: false,
        materialSlotId: doc.materialSlots[0]?.id ?? "slot1",
        transform: { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
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
  }, [addLayer, doc.materialSlots]);

  const handleGeneratorConfirm = useCallback(
    (kind: GeneratorKind, params: GeneratorParams) => {
      setGeneratorKind(null);
      const num = (key: string, fallback: number): number =>
        typeof params[key] === "number" ? (params[key] as number) : fallback;
      const bool = (key: string, fallback: boolean): boolean =>
        typeof params[key] === "boolean" ? (params[key] as boolean) : fallback;
      const slot = doc.materialSlots[0]?.id ?? "slot1";

      void runOp("יצירת חלק פרמטרי", async () => {
        const kernel = await getGeometryKernel();
        const layers: DesignLayer[] = [];
        switch (kind) {
          case "thread": {
            const internal = bool("internal", false);
            const solid = buildThread(kernel, {
              diameterMm: num("diameterMm", 8),
              pitchMm: num("pitchMm", 1.25),
              lengthMm: num("lengthMm", 20),
              internal,
              clearanceMm: num("clearanceMm", 0.4),
              segments: 48,
            });
            layers.push(
              generatorToLayer(
                solid,
                internal ? "כלי חיתוך להברגה פנימית" : "הברגה",
                slot,
                `הברגה M${num("diameterMm", 8)}×${num("pitchMm", 1.25)}`
              )
            );
            break;
          }
          case "gear": {
            const solid = buildGear(kernel, {
              teeth: num("teeth", 20),
              moduleMm: num("moduleMm", 2),
              thicknessMm: num("thicknessMm", 6),
              pressureAngleDeg: 20,
              boreDiameterMm: num("boreDiameterMm", 6),
              backlashMm: num("backlashMm", 0.1),
            });
            layers.push(
              generatorToLayer(
                solid,
                `גלגל שיניים ${num("teeth", 20)}Z`,
                slot,
                `מודול ${num("moduleMm", 2)}, ${num("teeth", 20)} שיניים`
              )
            );
            break;
          }
          case "enclosure": {
            const { box, lid } = buildEnclosure(kernel, {
              innerWidthMm: num("innerWidthMm", 60),
              innerDepthMm: num("innerDepthMm", 40),
              innerHeightMm: num("innerHeightMm", 25),
              wallMm: num("wallMm", 2),
              floorMm: num("floorMm", 2),
              cornerRadiusMm: num("cornerRadiusMm", 3),
              lipHeightMm: num("lipHeightMm", 4),
              clearanceMm: num("clearanceMm", 0.2),
            });
            layers.push(generatorToLayer(box, "מארז — קופסה", slot, "גוף המארז"));
            const lidLayer = generatorToLayer(lid, "מארז — מכסה", slot, "מכסה המארז");
            // Park the lid beside the box so both are visible and printable.
            lidLayer.transform.x += num("innerWidthMm", 60) + num("wallMm", 2) * 2 + 10;
            layers.push(lidLayer);
            break;
          }
          case "livingHinge": {
            const solid = buildLivingHinge(kernel, {
              widthMm: num("widthMm", 40),
              lengthMm: num("lengthMm", 30),
              thicknessMm: num("thicknessMm", 2),
              hingeThicknessMm: num("hingeThicknessMm", 0.5),
              grooveCount: num("grooveCount", 3),
              grooveWidthMm: num("grooveWidthMm", 1),
            });
            layers.push(generatorToLayer(solid, "ציר חי", slot, "פאנל מתקפל"));
            break;
          }
          case "snapFit": {
            const solid = buildSnapFit(kernel, {
              lengthMm: num("lengthMm", 15),
              widthMm: num("widthMm", 6),
              thicknessMm: num("thicknessMm", 1.5),
              hookDepthMm: num("hookDepthMm", 1),
              insertionAngleDeg: num("insertionAngleDeg", 30),
              retentionAngleDeg: num("retentionAngleDeg", 75),
            });
            layers.push(generatorToLayer(solid, "תפס", slot, "וו הצמדה גמיש"));
            break;
          }
          case "toleranceTest": {
            const { plate, pin, clearancesMm } = buildToleranceTest(kernel, {
              pinDiameterMm: num("pinDiameterMm", 5),
              clearancesMm: [0.1, 0.2, 0.3, 0.4, 0.5],
              thicknessMm: num("thicknessMm", 4),
              spacingMm: num("spacingMm", 12),
            });
            layers.push(
              generatorToLayer(
                plate,
                "מבחן סבולות — לוחית",
                slot,
                `מרווחים: ${clearancesMm.join(" / ")} מ״מ`
              )
            );
            const pinLayer = generatorToLayer(pin, "מבחן סבולות — פין", slot, "פין בדיקה");
            pinLayer.transform.y += num("spacingMm", 12);
            layers.push(pinLayer);
            break;
          }
        }
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
      void runOp("עיגול קצוות", async () => {
        const outcome = await applyFillet(doc, layer, settings);
        applyOpResult("עיגול קצוות", [outcome.layer], [layer.id], "hide", outcome.warningsHe);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult]
  );

  const handleShellConfirm = useCallback(
    (settings: ShellSettings) => {
      setShellOpen(false);
      const layer = singleSelectedShape;
      if (!layer) return;
      void runOp("קליפה עם פתח", async () => {
        const outcome = await applyShell(doc, layer, settings);
        const saved = outcome.volumeBeforeMm3 > 0
          ? 1 - outcome.volumeAfterMm3 / outcome.volumeBeforeMm3
          : 0;
        applyOpResult("קליפה עם פתח", [outcome.layer], [layer.id], "hide", [
          `חיסכון בחומר: ${(saved * 100).toFixed(0)}%`,
          ...outcome.warningsHe,
        ]);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult]
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
        const outcome = await applyLattice(doc, layer, settings);
        applyOpResult("מילוי סריג", [outcome.layer], [layer.id], "hide", [
          `חיסכון בחומר: ${(outcome.savedFraction * 100).toFixed(0)}%`,
          ...outcome.warningsHe,
        ]);
      });
    },
    [singleSelectedShape, doc, runOp, applyOpResult]
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
      setDiagnosis(await diagnoseMesh(mesh));
    });
  }, [selectedMeshLayers, runOp]);

  const handleAdvancedRepair = useCallback(
    (options: RepairOptions) => {
      const layer = selectedMeshLayers[0];
      if (!layer) return;
      void runOp("תיקון רשת", async () => {
        const mesh = getMesh(layer.meshId);
        if (!mesh) throw new OpError("נתוני הרשת חסרים");
        const report = await repairMesh(mesh, options);
        setRepairReport(report);
        if (report.succeeded && report.mesh) {
          const repairedId = storeMesh(report.mesh);
          updateLayer(
            layer.id,
            { meshId: repairedId, originalMeshId: layer.originalMeshId ?? layer.meshId },
            "תיקון רשת"
          );
          setDiagnosis(await diagnoseMesh(report.mesh));
        }
      });
    },
    [selectedMeshLayers, runOp, updateLayer]
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
    const items = build.parts.map((part) => ({
      layerId: part.primaryLayerId,
      widthMm: part.stats.dimensionsMm.x,
      depthMm: part.stats.dimensionsMm.y,
      currentX: (part.stats.bounds.min.x + part.stats.bounds.max.x) / 2,
      currentY: (part.stats.bounds.min.y + part.stats.bounds.max.y) / 2,
    }));
    if (items.length === 0) return;
    const result = arrangeOnPlate(items, {
      plateWidthMm: printer.buildVolumeMm.x,
      plateDepthMm: printer.buildVolumeMm.y,
      spacingMm: 5,
    });
    const byLayer = new Map(result.placements.map((p) => [p.layerId, p]));
    const layers = doc.layers.map((layer) => {
      const placement = byLayer.get(layer.id);
      if (!placement) return layer;
      const item = items.find((i) => i.layerId === layer.id);
      if (!item) return layer;
      // Placements are absolute plate positions; shift the layer transform by
      // the delta so any local offset baked into the mesh is preserved.
      return {
        ...layer,
        transform: {
          ...layer.transform,
          x: layer.transform.x + (placement.x - item.currentX),
          y: layer.transform.y + (placement.y - item.currentY),
        },
      } as DesignLayer;
    });
    applyDocument({ ...doc, layers }, "סידור אוטומטי על המשטח");
    setMessage({
      titleHe: "סידור אוטומטי",
      bodyHe: result.summaryHe,
      kind: result.unplaced.length > 0 ? "info" : "success",
    });
  }, [build.parts, doc, printer, applyDocument]);

  // ---- analysis ------------------------------------------------------------

  const runAnalysis = useCallback(() => {
    if (build.parts.length === 0) return;
    setAnalysisBusy(true);
    // Yield to paint the busy state before the synchronous analysis work.
    setTimeout(async () => {
      try {
        const kernel = await getGeometryKernel();
        const profile = getPrintabilityProfile(doc.printabilityProfileId);
        const custom = doc.customPrintability;
        const minWall = custom?.minWallMm ?? profile.minWallMm;
        const minFeature = custom?.minFeatureMm ?? profile.minFeatureMm;
        const maxOverhang = custom?.maxOverhangDeg ?? profile.maxOverhangDeg;

        const issues: ModelIssue[] = [];
        const colors = new Map<string, Float32Array>();
        let totalVolume = 0;
        let maxHeight = 0;

        for (const part of build.parts) {
          const mesh = part.worldMesh;
          totalVolume += part.stats.volumeMm3;
          maxHeight = Math.max(maxHeight, part.stats.bounds.max.z);

          const overhang = analyzeOverhangs(mesh, maxOverhang);
          const contact = analyzeContact(mesh);
          const floating = analyzeFloatingParts(mesh);
          const volume = analyzeBuildVolume(part.stats.bounds, printer);

          const { solid, status } = kernel.fromMeshData(mesh);
          let thicknessIssues: ModelIssue[] = [];
          if (status === "NoError") {
            const thickness = analyzeThickness(solid, mesh, {
              minWallMm: minWall,
              minFeatureMm: minFeature,
            });
            thicknessIssues = thickness.issues;
            colors.set(
              part.primaryLayerId,
              state.ui.overlay === "overhang"
                ? overhangToVertexColors(mesh, overhang.triangleFlags)
                : thicknessToVertexColors(mesh, thickness, minWall)
            );
          }
          solid.dispose();

          const prefix = build.parts.length > 1 ? `${part.nameHe}: ` : "";
          for (const issue of [
            ...overhang.issues,
            ...contact.issues,
            ...floating.issues,
            ...volume.issues,
            ...thicknessIssues,
          ]) {
            issues.push({ ...issue, titleHe: `${prefix}${issue.titleHe}` });
          }
        }

        setModelIssues(issues);
        setOverlayColors(colors);

        const usage = USAGE_PROFILES.find((u) => u.id === doc.usageProfileId);
        const material =
          MATERIAL_PROFILES.find((m) => m.id === usage?.suggestedMaterialId) ??
          MATERIAL_PROFILES[0];
        const layerHeight = custom?.layerHeightMm ?? profile.layerHeightMm;
        let bounds = { x: 0, y: 0, z: maxHeight };
        for (const part of build.parts) {
          bounds = {
            x: Math.max(bounds.x, part.stats.dimensionsMm.x),
            y: Math.max(bounds.y, part.stats.dimensionsMm.y),
            z: bounds.z,
          };
        }
        setEstimate(
          estimateDetailed({
            modelVolumeMm3: totalVolume,
            boundsMm: bounds,
            technology: profile.technology,
            layerHeightMm: layerHeight,
            nozzleDiameterMm: custom?.nozzleDiameterMm ?? profile.nozzleDiameterMm,
            infillPercent: usage?.suggestedInfillPct ?? 20,
            densityGCm3: material.densityGCm3,
            pricePerKgIls: material.pricePerKgIls,
          })
        );
      } catch (err) {
        showError(err, "ניתוח המודל נכשל");
      } finally {
        setAnalysisBusy(false);
      }
    }, 30);
  }, [build.parts, doc, printer, state.ui.overlay, showError]);

  // Invalidate analysis results when the geometry changes (state adjustment
  // derived from the build id, done during render — no effect cascade).
  const [lastBuildId, setLastBuildId] = useState(0);
  if (build.buildId !== lastBuildId) {
    setLastBuildId(build.buildId);
    setModelIssues([]);
    setOverlayColors(new Map());
    setEstimate(null);
  }

  const handleSuggestOrientation = useCallback(() => {
    const part = selectedParts[0] ?? build.parts[0];
    if (!part) return;
    setAnalysisBusy(true);
    setTimeout(() => {
      try {
        const profile = getPrintabilityProfile(doc.printabilityProfileId);
        const maxOverhang = doc.customPrintability?.maxOverhangDeg ?? profile.maxOverhangDeg;
        setOrientationCandidates(suggestOrientations(part.worldMesh, maxOverhang));
      } catch (err) {
        showError(err, "הצעת תנוחה נכשלה");
      } finally {
        setAnalysisBusy(false);
      }
    }, 30);
  }, [selectedParts, build.parts, doc, showError]);

  const handleApplyOrientation = useCallback(
    (candidate: OrientationCandidate) => {
      setOrientationCandidates(null);
      const part = selectedParts[0] ?? build.parts[0];
      if (!part) return;
      const layer = doc.layers.find((l) => l.id === part.primaryLayerId);
      if (!layer || layer.locked) return;
      const rotation = new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(
          (candidate.rotation.xDeg * Math.PI) / 180,
          (candidate.rotation.yDeg * Math.PI) / 180,
          (candidate.rotation.zDeg * Math.PI) / 180,
          "XYZ"
        )
      );
      const current = transformToMatrix4(layer.transform);
      const next = matrix4ToTransform(rotation.multiply(current));
      // Drop the rotated body onto the plate.
      const rotated = transformMeshData(part.localMesh, transformToMatrix4(next));
      const bounds = meshDataBounds(rotated);
      next.z -= bounds.min.z;
      commitTransform(layer.id, next);
    },
    [selectedParts, build.parts, doc.layers, commitTransform]
  );

  // ---- imports --------------------------------------------------------------

  const handleStlFile = useCallback(
    async (file: File) => {
      await runOp("ייבוא STL", async () => {
        const buffer = await readFileBuffer(file);
        const parsed = parseStl(buffer);
        // Rebase: centre XY, rest on Z=0.
        const bounds = meshDataBounds(parsed.mesh);
        const cx = (bounds.min.x + bounds.max.x) / 2;
        const cy = (bounds.min.y + bounds.max.y) / 2;
        const rebased = transformMeshData(
          parsed.mesh,
          new THREE.Matrix4().makeTranslation(-cx, -cy, -bounds.min.z)
        );
        const kernel = await getGeometryKernel();
        const { solid, status } = kernel.fromMeshData(rebased);
        solid.dispose();
        let manifold = status === "NoError";
        let repairMessageHe: string | null = null;
        let finalMesh = rebased;
        if (!manifold) {
          const repair = await attemptMeshRepair(rebased);
          if (repair.succeeded && repair.mesh) {
            finalMesh = repair.mesh;
            manifold = true;
            repairMessageHe = repair.messageHe;
          } else {
            repairMessageHe = repair.messageHe;
          }
        }
        const meshId = storeMesh(finalMesh);
        pendingStlRef.current = { meshId, fileName: file.name };
        setStlPreview({
          fileName: file.name,
          summary: summarizeStlMesh(finalMesh),
          manifold,
          repairMessageHe,
        });
      });
    },
    [runOp]
  );

  const confirmStlImport = useCallback(() => {
    const pending = pendingStlRef.current;
    setStlPreview(null);
    pendingStlRef.current = null;
    if (!pending) return;
    const layer: ImportedMeshLayer = {
      id: newId("layer"),
      type: "importedMesh",
      name: pending.fileName.replace(/\.stl$/i, ""),
      visible: true,
      locked: false,
      materialSlotId: doc.materialSlots[0]?.id ?? "slot1",
      transform: {
        x: 0, y: 0, z: 0,
        rotationX: 0, rotationY: 0, rotationZ: 0,
        scaleX: 1, scaleY: 1, scaleZ: 1,
      },
      previewOpacity: 1,
      meshId: pending.meshId,
      provenance: { kind: "stlImport", fileName: pending.fileName },
      originalMeshId: pending.meshId,
      combine: "standalone",
    };
    applyDocument({ ...doc, layers: [...doc.layers, layer] }, "ייבוא STL");
    dispatch({ type: "ui/select", selection: [layer.id] });
  }, [doc, applyDocument, dispatch]);

  const handleSvgConfirm = useCallback(
    (options: SvgImportOptionsValue) => {
      const pending = svgPending;
      setSvgPending(null);
      if (!pending) return;
      void runOp("ייבוא SVG", async () => {
        // Security first: strip scripts/external refs, collect Hebrew warnings.
        const sanitized = sanitizeSvg(pending.text);
        if (!sanitized.ok) {
          throw new SvgImportError(sanitized.error ?? "קובץ ה-SVG אינו תקין");
        }
        const result = parseSvgToContours(sanitized.svgText, {
          targetWidthMm: options.targetWidthMm,
        });
        result.warningsHe.push(...sanitized.warnings);
        const layer: DesignLayer = {
          id: newId("layer"),
          type: "svg",
          name: pending.fileName.replace(/\.svg$/i, ""),
          visible: true,
          locked: false,
          materialSlotId: doc.materialSlots[0]?.id ?? "slot1",
          transform: {
            x: 0, y: 0, z: 0,
            rotationX: 0, rotationY: 0, rotationZ: 0,
            scaleX: 1, scaleY: 1, scaleZ: 1,
          },
          previewOpacity: 1,
          sourceName: pending.fileName,
          contours: result.contours,
          extrudeMm: options.extrudeMm,
          combine: doc.baseMode === "withBase" ? "raised" : "standalone",
          bevel: { enabled: false, sizeMm: 0.6, segments: 4 },
        };
        applyDocument({ ...doc, layers: [...doc.layers, layer] }, "ייבוא SVG");
        dispatch({ type: "ui/select", selection: [layer.id] });
        if (result.warningsHe.length > 0) {
          setMessage({
            titleHe: "ייבוא SVG — הערות",
            bodyHe: result.warningsHe.join("\n"),
            kind: "info",
          });
        }
      });
    },
    [svgPending, doc, applyDocument, dispatch, runOp]
  );

  /**
   * The image input accepts `image/*` so mobile pickers expose every source
   * on the device, which means an unsuitable file can reach us — check it
   * here instead of relying on the picker's filter.
   */
  const handleImageFile = useCallback((file: File) => {
    const error = validateImageFile({ name: file.name, type: file.type, size: file.size });
    if (error) {
      setMessage({ titleHe: "ייבוא תמונה", bodyHe: error, kind: "error" });
      return;
    }
    setImagePending({ file, fileName: file.name });
  }, []);

  const handleImageConfirm = useCallback(
    (options: ImageImportOptionsValue) => {
      const pending = imagePending;
      setImagePending(null);
      if (!pending) return;
      void runOp("ייבוא תמונה", async () => {
        const decoded = await decodeImageToGrid(pending.file, options.resolution, {
          removeBackgroundTolerance: options.removeBackground ? options.bgToleranceMm : null,
          brightness: options.brightness,
          contrast: options.contrast,
        });
        if (options.removeBackground && decoded.backgroundRemovedFraction < 0.01) {
          setMessage({
            titleHe: "הסרת רקע",
            bodyHe: "כמעט שלא זוהה רקע להסרה — נסו להגדיל את סבילות הצבע",
            kind: "info",
          });
        }
        const grid = smoothGrid(decoded.grid, options.smoothingLevel);
        const pixelSizeMm = options.targetWidthMm / grid.width;
        let layer: DesignLayer;
        if (options.mode === "silhouette") {
          const contours = gridToSilhouetteContours(grid, {
            threshold: options.threshold,
            invert: options.invert,
            pixelSizeMm,
          });
          if (contours.length === 0) {
            throw new ImageImportError(
              "לא נמצאה צורה בתמונה — נסו לשנות את סף הבהירות או להפעיל היפוך"
            );
          }
          layer = {
            id: newId("layer"),
            type: "imageRelief",
            name: stripImageExtension(pending.fileName),
            visible: true,
            locked: false,
            materialSlotId: doc.materialSlots[0]?.id ?? "slot1",
            transform: { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
            previewOpacity: 1,
            sourceName: pending.fileName,
            mode: "silhouette",
            contours,
            meshId: null,
            settings: {
              targetWidthMm: options.targetWidthMm,
              threshold: options.threshold,
              invert: options.invert,
              reliefHeightMm: options.reliefHeightMm,
              minThicknessMm: options.minThicknessMm,
              resolution: options.resolution,
              smoothingLevel: options.smoothingLevel,
            },
            extrudeMm: options.extrudeMm,
            combine: doc.baseMode === "withBase" ? "raised" : "standalone",
            bevel: { enabled: false, sizeMm: 0.6, segments: 4 },
          };
        } else {
          const mesh = heightFieldToClosedMesh(grid, {
            pixelSizeMm,
            minThicknessMm: options.minThicknessMm,
            reliefHeightMm: options.reliefHeightMm,
            invert: options.invert,
          });
          const kernel = await getGeometryKernel();
          const { solid, status } = kernel.fromMeshData(mesh);
          solid.dispose();
          if (status !== "NoError") {
            throw new ImageImportError("יצירת גוף התבליט נכשלה — נסו רזולוציה אחרת");
          }
          const meshId = storeMesh(mesh);
          layer = {
            id: newId("layer"),
            type: "imageRelief",
            name: stripImageExtension(pending.fileName),
            visible: true,
            locked: false,
            materialSlotId: doc.materialSlots[0]?.id ?? "slot1",
            transform: { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
            previewOpacity: 1,
            sourceName: pending.fileName,
            mode: "relief",
            contours: [],
            meshId,
            settings: {
              targetWidthMm: options.targetWidthMm,
              threshold: options.threshold,
              invert: options.invert,
              reliefHeightMm: options.reliefHeightMm,
              minThicknessMm: options.minThicknessMm,
              resolution: options.resolution,
              smoothingLevel: options.smoothingLevel,
            },
            extrudeMm: options.extrudeMm,
            combine: "standalone",
            bevel: { enabled: false, sizeMm: 0.6, segments: 4 },
          };
        }
        applyDocument({ ...doc, layers: [...doc.layers, layer] }, "ייבוא תמונה");
        dispatch({ type: "ui/select", selection: [layer.id] });
      });
    },
    [imagePending, doc, applyDocument, dispatch, runOp]
  );

  const handleDesignFile = useCallback(
    async (file: File) => {
      await runOp("טעינת קובץ עיצוב", async () => {
        const text = await file.text();
        const { document: imported, warningsHe } = importDesignFile(text);
        applyDocument(imported, "טעינת קובץ עיצוב");
        dispatch({ type: "ui/select", selection: [] });
        if (warningsHe.length > 0) {
          setMessage({
            titleHe: "קובץ העיצוב נטען עם הערות",
            bodyHe: warningsHe.join("\n"),
            kind: "info",
          });
        }
      });
    },
    [runOp, applyDocument, dispatch]
  );

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
        if (kind === "threemf") {
          const usage = USAGE_PROFILES.find((u) => u.id === doc.usageProfileId);
          const material =
            MATERIAL_PROFILES.find((m) => m.id === usage?.suggestedMaterialId) ??
            MATERIAL_PROFILES[0];
          const blob = buildThreeMf(
            build.parts.map((part) => {
              const slot = doc.materialSlots.find((s) => s.id === part.materialSlotId);
              return {
                name: part.nameHe,
                colorHex: slot?.colorHex ?? "#8a8f98",
                materialName: slot ? `${slot.nameHe} (${material.nameHe})` : material.nameHe,
                vertices: part.worldMesh.positions,
                triangles: part.worldMesh.indices,
              };
            }),
            fileName
          );
          downloadBlob(blob, `${fileName}.3mf`);
          return;
        }
        if (kind === "stl") {
          // Merge all parts (world space) into one binary STL.
          let totalVerts = 0;
          let totalIdx = 0;
          for (const part of build.parts) {
            totalVerts += part.worldMesh.positions.length;
            totalIdx += part.worldMesh.indices.length;
          }
          const positions = new Float32Array(totalVerts);
          const indices = new Uint32Array(totalIdx);
          let vOffset = 0;
          let iOffset = 0;
          for (const part of build.parts) {
            positions.set(part.worldMesh.positions, vOffset * 3);
            for (let i = 0; i < part.worldMesh.indices.length; i++) {
              indices[iOffset + i] = part.worldMesh.indices[i] + vOffset;
            }
            vOffset += part.worldMesh.positions.length / 3;
            iOffset += part.worldMesh.indices.length;
          }
          downloadBlob(meshDataToBinaryStl({ positions, indices }), `${fileName}.stl`);
          return;
        }
        // ZIP of separate parts.
        const zip = await buildMultiPartZip(
          build.parts.map((part, index) => ({
            fileBaseName: `${fileName}-${index + 1}-${part.nameHe}`,
            nameHe: part.nameHe,
            mesh: part.worldMesh,
            materialSlot:
              doc.materialSlots.find((s) => s.id === part.materialSlotId) ?? null,
            triangleCount: part.stats.triangleCount,
          })),
          {
            designName: fileName,
            connectorsInfoHe: doc.layers
              .filter(
                (l): l is ImportedMeshLayer =>
                  l.type === "importedMesh" && l.provenance.kind === "connectorResult"
              )
              .map((l) => l.provenance.descriptionHe ?? "מחברים"),
          }
        );
        downloadBlob(zip, `${fileName}.zip`);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "history/redo" : "history/undo" });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyY") {
        e.preventDefault();
        dispatch({ type: "history/redo" });
        return;
      }
      if (e.code === "Delete" || e.code === "Backspace") {
        for (const layer of selectedLayers) {
          if (!layer.locked) handleDeleteLayer(layer.id);
        }
        return;
      }
      const toolByCode: Record<string, "select" | "translate" | "rotate" | "scale"> = {
        KeyQ: "select",
        KeyG: "translate",
        KeyR: "rotate",
        KeyS: "scale",
      };
      if (toolByCode[e.code] && !e.ctrlKey && !e.metaKey) {
        dispatch({ type: "ui/setTool", tool: toolByCode[e.code] });
        return;
      }
      if (e.code === "Escape") {
        dispatch({ type: "ui/setTool", tool: "select" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, selectedLayers, handleDeleteLayer]);

  // ---- derived UI -----------------------------------------------------------

  const paramIssues = build.validation.issues;
  const singleSelectedLayer = selectedLayers.length === 1 ? selectedLayers[0] : null;
  const selectedPartDims = selectedParts[0]?.stats.dimensionsMm ?? null;
  const cutBoundsZ = selectedParts[0]
    ? { min: selectedParts[0].stats.bounds.min.z, max: selectedParts[0].stats.bounds.max.z }
    : null;

  const totalDims = useMemo(() => {
    if (build.parts.length === 0) return null;
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const p of build.parts) {
      min.x = Math.min(min.x, p.stats.bounds.min.x);
      min.y = Math.min(min.y, p.stats.bounds.min.y);
      min.z = Math.min(min.z, p.stats.bounds.min.z);
      max.x = Math.max(max.x, p.stats.bounds.max.x);
      max.y = Math.max(max.y, p.stats.bounds.max.y);
      max.z = Math.max(max.z, p.stats.bounds.max.z);
    }
    return { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
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
        {/* Panels (start side = right in RTL) */}
        <aside className="max-h-[55dvh] w-full overflow-y-auto border-t border-slate-200 bg-white lg:max-h-none lg:w-[420px] lg:border-e lg:border-t-0">
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
              partCount={build.parts.length}
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
            onRemoveMeasurement={(id) => dispatch({ type: "ui/removeMeasurement", id })}
          />
          {totalDims && (
            <div
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
              {state.ui.busyLabelHe ?? "בונה מודל…"}
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
      <InterferenceDialog
        open={interference !== null}
        report={interference}
        onNavigate={handleNavigateTo}
        onClose={() => setInterference(null)}
      />
    </div>
  );
}
