"use client";

/**
 * V3 editor shell: header (templates, base mode, undo/redo, import/export),
 * layer/properties/tools/analysis/inspection panels, the 3D viewport and
 * all operation dialogs. Geometry work is delegated to lib/geometry; this
 * component owns wiring, busy state and Hebrew messaging.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as THREE from "three";
import type {
  CutPlaneDefinition,
  DesignLayer,
  ImportedMeshLayer,
  Measurement,
  ModelIssue,
  ShapeLayer,
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
import { getPrinterProfile, type PrinterProfile } from "@/types/profiles";

// Hooks: the editor's own logic, one family of operations each.
import { useDocumentBuilder, type BuiltPart } from "@/hooks/useDocumentBuilder";
import { useGeometryJobs } from "@/hooks/useGeometryJobs";
import { useEditorOps } from "@/hooks/useEditorOps";
import { useEditorDialogs } from "@/hooks/useEditorDialogs";
import { useLayerPlacement } from "@/hooks/useLayerPlacement";
import { useBodyOperations } from "@/hooks/useBodyOperations";
import { usePrintAids } from "@/hooks/usePrintAids";
import { useRegionTools } from "@/hooks/useRegionTools";
import { useImportHandlers } from "@/hooks/useImportHandlers";
import { useCloudModelImport } from "@/hooks/useCloudModelImport";
import { useAnalysisRunner } from "@/hooks/useAnalysisRunner";
import { useSessionPersistence } from "@/hooks/useSessionPersistence";
import { usePaintReanchor } from "@/hooks/usePaintReanchor";
import {
  useEditorShortcuts,
  type FocusTarget,
  type ViewPreset,
} from "@/hooks/useEditorShortcuts";

// Geometry and serialization the shell itself still calls.
import { getGeometryKernel } from "@/lib/geometry/kernel";
import { boundsSize, unionBounds } from "@/lib/geometry/bounds";
import { getMesh, storeMesh } from "@/lib/geometry/meshStore";
import { OpError } from "@/lib/geometry/operations/layerOps";
import { buildGeneratorLayers } from "@/lib/geometry/generators/buildGeneratorLayers";
import type { GeneratorKind, GeneratorParams } from "@/lib/geometry/generators/specs";
import {
  makeBaseLayer,
  makeHoleLayer,
  makeTextLayer,
} from "@/lib/geometry/documentTemplates";
import { DEFAULT_PAINT_DEPTH_MM, splitPartsByPaint } from "@/lib/geometry/painting";
import { defaultModifier, type Modifier, type ModifierKind } from "@/lib/geometry/modifiers";
import { resolveParameters, type ParameterDefinition } from "@/lib/geometry/expression";
import type { CalibrationSettings } from "@/lib/geometry/calibration";
import type { PrintablePart } from "@/lib/geometry/buildDocument";
import type { InterferenceReport } from "@/lib/geometry/analysis/collision";
import type { OrientationCandidate } from "@/lib/geometry/analysis";
import type { DetailedEstimateResult } from "@/lib/geometry/analysis/estimateDetailed";
import type { SlicedEstimateResult } from "@/lib/geometry/analysis/estimateSliced";
import type { MeshDiagnosis, MeshRepairReport, RepairOptions } from "@/lib/geometry/repair/diagnose";
import { downloadBlob } from "@/lib/export/download";
import {
  buildStlExport,
  buildThreeMfExport,
  buildZipExport,
} from "@/lib/export/exportDocument";
import {
  DESIGN_FILE_EXTENSION,
  serializeDesignFile,
} from "@/lib/serialization/designFile";
import { describeSnapshotAge } from "@/lib/serialization/crashRecovery";
import { loadKeymap, type Keymap } from "@/lib/keyboard/keymap";

// Panels and dialogs.
import { Section } from "@/components/ui/Section";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { EditorProvider, useEditor } from "@/components/editor/store";
import { LayerListPanel } from "@/components/editor/LayerListPanel";
import { PropertiesPanel } from "@/components/editor/PropertiesPanel";
import { ToolsPanel } from "@/components/editor/ToolsPanel";
import { AnalysisPanel } from "@/components/editor/AnalysisPanel";
import { InspectPanel } from "@/components/editor/InspectPanel";
import { CreatePanel } from "@/components/editor/CreatePanel";
import { SubObjectPanel } from "@/components/editor/SubObjectPanel";
import { CalibrationPanel, CustomPrinterPanel } from "@/components/editor/CalibrationPanel";
import { JobProgressOverlay } from "@/components/editor/JobProgressOverlay";
import { EditorHeader } from "@/components/editor/EditorHeader";
import {
  HistoryPanel,
  MemoryPanel,
  ModifierStackPanel,
  ParametersPanel,
} from "@/components/editor/HistoryPanel";
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
  CloudConsentDialog,
  ImageImportDialog,
  StlImportDialog,
  SvgImportDialog,
  type StlImportPreview,
} from "@/components/dialogs/ImportDialogs";
import { ExportDialog, type ExportKind } from "@/components/dialogs/ExportDialog";
import { LibraryDialog } from "@/components/dialogs/LibraryDialog";
import { ShortcutsDialog } from "@/components/dialogs/ShortcutsDialog";
import { GeneratorDialog } from "@/components/dialogs/GeneratorDialog";
import {
  EmbossDialog,
  FilletDialog,
  RevolveDialog,
  ShellDialog,
} from "@/components/dialogs/ReshapeDialogs";
import { DeformDialog } from "@/components/dialogs/DeformDialog";
import { LatticeDialog } from "@/components/dialogs/LatticeDialog";
import { PatternDialog } from "@/components/dialogs/PatternDialog";
import {
  InterferenceDialog,
  MeshInspectorDialog,
} from "@/components/dialogs/MeshHealthDialogs";
import { ModifierEditDialog } from "@/components/dialogs/ModifierEditDialog";
import { RecoveryDialog } from "@/components/dialogs/RecoveryDialog";
import { BaseModeSwitchDialog, OrientationDialog } from "@/components/dialogs/MiscDialogs";

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

/** Where a fresh cut plane sits before the selection's bounds move it. */
const DEFAULT_CUT_OFFSET_MM = 5;

/** Starting distance for the push/pull and region-fillet tools, in mm. */
const DEFAULT_PUSH_PULL_MM = 2;
const DEFAULT_REGION_FILLET_MM = 2;

function EditorInner() {
  const { state, dispatch, document: doc, selection, selectedLayers, canUndo, canRedo } =
    useEditor();
  const build = useDocumentBuilder(doc);
  const jobs = useGeometryJobs();
  const printer = getPrinterProfile(doc.printerProfileId, doc.customPrinters ?? []);

  // ---- dialogs and local UI state -----------------------------------------

  /** Which modal is showing; see hooks/useEditorDialogs.ts. */
  const dialogs = useEditorDialogs();
  // Stable: the keyboard hook keeps its listener registered across renders
  // only if the callbacks it depends on keep their identity.
  const { open: openDialog } = dialogs;
  const openShortcutHelp = useCallback(() => openDialog("shortcuts"), [openDialog]);
  const [message, setMessage] = useState<OpMessage | null>(null);

  /** Cut-plane definition: edited live in the dialog, remembered after. */
  const [cutPlane, setCutPlane] = useState<CutPlaneDefinition>({
    orientation: "xy",
    offsetMm: DEFAULT_CUT_OFFSET_MM,
    rotationX: 0,
    rotationY: 0,
  });
  /** The last cut, which is where connectors are placed by default. */
  const [lastCutPlane, setLastCutPlane] = useState<CutPlaneDefinition | null>(null);

  // Import dialogs are driven by their pending payload, not by a flag.
  const [stlPreview, setStlPreview] = useState<StlImportPreview | null>(null);
  const pendingStlRef = useRef<{ meshId: string; fileName: string } | null>(null);
  const [svgPending, setSvgPending] = useState<{ text: string; fileName: string } | null>(null);
  const [imagePending, setImagePending] = useState<{ file: File; fileName: string } | null>(null);

  /** Below lg the tool panel is a collapsible bottom sheet. */
  const [panelOpen, setPanelOpen] = useState(true);
  const [keymap, setKeymap] = useState<Keymap>(() => loadKeymap());
  const [viewPreset, setViewPreset] = useState<ViewPreset | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);

  // Analysis results.
  const [orientationCandidates, setOrientationCandidates] = useState<OrientationCandidate[] | null>(null);
  const [modeSwitchTarget, setModeSwitchTarget] = useState<"withBase" | "baseless" | null>(null);
  const [modelIssues, setModelIssues] = useState<ModelIssue[]>([]);
  const [overlayColors, setOverlayColors] = useState<Map<string, Float32Array>>(new Map());
  const [estimate, setEstimate] = useState<DetailedEstimateResult | SlicedEstimateResult | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [diagnosis, setDiagnosis] = useState<MeshDiagnosis | null>(null);
  const [repairReport, setRepairReport] = useState<MeshRepairReport | null>(null);
  const [interference, setInterference] = useState<InterferenceReport | null>(null);

  const [editingModifierId, setEditingModifierId] = useState<string | null>(null);

  // Sub-object tool settings.
  const [pushPullMm, setPushPullMm] = useState(DEFAULT_PUSH_PULL_MM);
  const [filletRegionMm, setFilletRegionMm] = useState(DEFAULT_REGION_FILLET_MM);
  const [paintSlotId, setPaintSlotId] = useState<string | null>(null);
  const [paintDepthMm, setPaintDepthMm] = useState(DEFAULT_PAINT_DEPTH_MM);

  const busy = state.ui.busyCount > 0;

  // ---- shared operation plumbing -----------------------------------------

  const ops = useEditorOps({ document: doc, dispatch, setMessage });
  const { applyDocument, updateLayer, commitTransform, showError, runOp } = ops;

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

  // ---- transforms, placement, body operations -----------------------------

  const {
    handleDropToPlate,
    handleCenterOnPlate,
    handleMirror,
    handleAlign,
    handleDistribute,
    handleSnapToCenter,
    handleSnapToEdge,
    handleDuplicate,
    handleDuplicateLayer,
    handleScaleTo,
    handleFitBuildVolume,
    handleSurfacePick,
  } = useLayerPlacement({
    ops,
    tool: state.ui.tool,
    selectedLayers,
    selectedParts,
    printer,
    onDrainPick: dialogs.setDrainPick,
  });

  const {
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
  } = useBodyOperations({
    ops,
    jobs,
    selectedShapeLayers,
    selectedMeshLayers,
    selectedLayers,
    singleSelectedShape,
    partByLayer,
    booleanKind: dialogs.booleanKind,
    lastCutPlane,
    drainPick: dialogs.drainPick,
    closeDialogs: dialogs.close,
    onCutPlaneUsed: setLastCutPlane,
  });

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
      dialogs.close();
      void runOp("יצירת חלק פרמטרי", async () => {
        const kernel = await getGeometryKernel();
        const layers = buildGeneratorLayers(kernel, doc, kind, params);
        applyDocument({ ...doc, layers: [...doc.layers, ...layers] }, "יצירת חלק פרמטרי");
        dispatch({ type: "ui/select", selection: layers.map((l) => l.id) });
      });
    },
    [doc, dialogs, runOp, applyDocument, dispatch]
  );

  // ---- V4: inspection --------------------------------------------------------

  const handleOpenInspector = useCallback(() => {
    const layer = selectedMeshLayers[0];
    if (!layer) return;
    setRepairReport(null);
    setDiagnosis(null);
    dialogs.open("inspector");
    void runOp("בדיקת רשת", async () => {
      const mesh = getMesh(layer.meshId);
      if (!mesh) throw new OpError("נתוני הרשת חסרים");
      const result = await jobs.run("diagnoseMesh", { mesh }, "בדיקת רשת");
      if (result) setDiagnosis(result);
    });
  }, [selectedMeshLayers, dialogs, runOp, jobs]);

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

  // ---- V5: revolve, emboss, hierarchy ----------------------------------------

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

  const {
    handleGenerateSupports,
    handleGenerateBrim,
    handleGenerateRaft,
    handleCheckBridging,
    handleAnalyzeWarping,
    handleArrangePlate,
    handleCheckInterference,
  } = usePrintAids({
    ops,
    jobs,
    parts: build.parts,
    selectedParts,
    printer,
    setFocusTarget,
    setInterference,
  });

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

  // ---- V5: sub-object selection and painting ---------------------------------

  const {
    faceSelection,
    regionInfo,
    paintInfo,
    resolvedPaintSlotId,
    handleFacePick,
    handleSelectAllFaces,
    handleFilletRegion,
    handlePushPull,
    handleRegionSmooth,
    handleRegionDelete,
    handleRegionSplit,
    handlePaintRegion,
    handleUnpaintRegion,
    handleClearPaint,
  } = useRegionTools({
    ops,
    jobs,
    uiState: state.ui,
    dispatch,
    selection,
    selectedParts,
    partByLayer,
    pushPullMm,
    filletRegionMm,
    paintSlotId,
    paintDepthMm,
  });

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

  // Paint survives a rebuild by re-projection (V6 item 17).
  usePaintReanchor({
    document: state.history.present.document,
    parts: build.parts,
    buildId: build.buildId,
    dispatch,
  });

  const {
    memoryStats,
    handleCollectGarbage,
    recovery,
    handleAcceptRecovery,
    handleDismissRecovery,
    handleShareLink,
  } = useSessionPersistence({ ops, history: state.history, pendingStlRef });

  const handleHistoryJump = useCallback(
    (delta: number) => {
      if (delta !== 0) dispatch({ type: "history/jump", delta });
    },
    [dispatch]
  );

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

  // ---- cloud image→3D ------------------------------------------------------

  // A generated mesh must surface its printability immediately, but analysis
  // needs the rebuilt parts — so the import raises a flag and the first
  // finished build after it runs the analysis once.
  const autoAnalysisRef = useRef(false);
  const requestAutoAnalysis = useCallback(() => {
    autoAnalysisRef.current = true;
  }, []);
  useEffect(() => {
    if (!autoAnalysisRef.current) return;
    if (build.status !== "ok" || build.parts.length === 0) return;
    autoAnalysisRef.current = false;
    runAnalysis();
  }, [build.buildId, build.status, build.parts.length, runAnalysis]);

  const cloudImport = useCloudModelImport({
    doc,
    dispatch,
    applyDocument,
    setMessage,
    showError,
    requestAutoAnalysis,
  });

  // ---- imports --------------------------------------------------------------

  // Extracted to hooks/useImportHandlers.ts: STL, SVG, image and design-file
  // loading is a self-contained domain, and Editor.tsx had grown past 2,800
  // lines holding every concern at once.
  const {
    handleMeshFile,
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
      dialogs.close();
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
    [doc, build.parts, dialogs, runOp]
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

  // ---- keyboard shortcuts ---------------------------------------------------

  useEditorShortcuts({
    ops,
    history: state.history,
    keymap,
    dispatch,
    parts: build.parts,
    selectedParts,
    selectedLayers,
    onDuplicate: handleDuplicate,
    onShowShortcutHelp: openShortcutHelp,
    setFocusTarget,
    setViewPreset,
  });

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
      <EditorHeader
        document={doc}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => dispatch({ type: "history/undo" })}
        onRedo={() => dispatch({ type: "history/redo" })}
        onApplyTemplate={(template) => applyDocument(template, "טעינת תבנית")}
        onRequestBaseMode={setModeSwitchTarget}
        onMeshFile={(file) => void handleMeshFile(file)}
        onSvgFile={(file) =>
          void file.text().then((text) => setSvgPending({ text, fileName: file.name }))
        }
        onImageFile={handleImageFile}
        onDesignFile={(file) => void handleDesignFile(file)}
        onOpenLibrary={() => dialogs.open("library")}
        onOpenShortcuts={() => dialogs.open("shortcuts")}
        onShareLink={handleShareLink}
        onOpenExport={() => dialogs.open("export")}
      />

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
              onOpenGenerator={dialogs.openGenerator}
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
              onBoolean={dialogs.openBoolean}
              onCut={() => {
                if (cutBoundsZ) {
                  setCutPlane((p) => ({
                    ...p,
                    offsetMm: (cutBoundsZ.min + cutBoundsZ.max) / 2,
                  }));
                }
                dialogs.open("cut");
              }}
              onSplitComponents={handleSplitComponents}
              onConnectors={() => dialogs.open("connectors")}
              onHollow={() => dialogs.open("hollow")}
              onDrain={() =>
                dispatch({
                  type: "ui/setTool",
                  tool: state.ui.tool === "drainHole" ? "select" : "drainHole",
                })
              }
              onThicken={() => dialogs.open("thicken")}
              onSmooth={() => dialogs.open("smooth")}
              onSimplify={() => dialogs.open("simplify")}
              onRepair={handleRepair}
              onFillet={() => dialogs.open("fillet")}
              onShell={() => dialogs.open("shell")}
              onDeform={() => dialogs.open("deform")}
              onLattice={() => dialogs.open("lattice")}
              onPattern={() => dialogs.open("pattern")}
              onInspectMesh={handleOpenInspector}
              onCheckInterference={handleCheckInterference}
              onArrangePlate={handleArrangePlate}
              onGenerateSupports={handleGenerateSupports}
              onCheckBridging={handleCheckBridging}
              onAnalyzeWarping={handleAnalyzeWarping}
              onGenerateBrim={handleGenerateBrim}
              onGenerateRaft={handleGenerateRaft}
              onRevolve={() => dialogs.open("revolve")}
              onEmboss={() => dialogs.open("emboss")}
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
              onGenerateCoupon={() => dialogs.openGenerator("toleranceTest")}
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
          {/* The cloud generation reuses the same overlay: stages, fraction
              where known, and a cancel that actually aborts the flow. */}
          <JobProgressOverlay progress={cloudImport.progress} onCancel={cloudImport.cancel} />
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

      {/* Dialogs */}
      <MessageDialog message={message} onClose={() => setMessage(null)} />
      <BooleanDialog
        kind={dialogs.booleanKind}
        layerNames={selectedShapeLayers.map((l) => l.name)}
        onConfirm={handleBooleanConfirm}
        onClose={dialogs.close}
      />
      <CutDialog
        open={dialogs.isOpen("cut")}
        layerName={singleSelectedShape?.name ?? ""}
        boundsZ={cutBoundsZ}
        plane={cutPlane}
        onPlaneChange={setCutPlane}
        onConfirm={handleCutConfirm}
        onClose={dialogs.close}
      />
      <ConnectorsDialog
        open={dialogs.isOpen("connectors")}
        maleName={selectedMeshLayers[0]?.name ?? ""}
        femaleName={selectedMeshLayers[1]?.name ?? ""}
        onConfirm={handleConnectorsConfirm}
        onClose={dialogs.close}
      />
      <HollowDialog
        open={dialogs.isOpen("hollow")}
        layerName={singleSelectedShape?.name ?? ""}
        onConfirm={handleHollowConfirm}
        onClose={dialogs.close}
      />
      <DrainHoleDialog
        open={dialogs.drainPick !== null}
        onConfirm={handleDrainConfirm}
        onClose={dialogs.close}
      />
      <ThickenDialog
        open={dialogs.isOpen("thicken")}
        layerName={singleSelectedShape?.name ?? ""}
        onConfirm={handleThickenConfirm}
        onClose={dialogs.close}
      />
      <SmoothDialog
        open={dialogs.isOpen("smooth")}
        layerName={singleSelectedShape?.name ?? ""}
        onConfirm={handleSmoothConfirm}
        onClose={dialogs.close}
      />
      <SimplifyDialog
        open={dialogs.isOpen("simplify")}
        layerName={singleSelectedShape?.name ?? ""}
        currentTriangles={selectedParts[0]?.stats.triangleCount ?? 0}
        onConfirm={handleSimplifyConfirm}
        onClose={dialogs.close}
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
        file={imagePending?.file ?? null}
        fileName={imagePending?.fileName ?? ""}
        cloudAvailability={cloudImport.availability}
        onConfirm={(imageOptions) => {
          // The cloud mode uploads the ORIGINAL file, not the processed
          // grid, so it leaves the image pipeline and takes its own flow
          // (consent gate → provider → repair funnel).
          if (imageOptions.mode === "cloud") {
            const pending = imagePending;
            setImagePending(null);
            if (pending) {
              void cloudImport.start(pending.file, imageOptions.cloudTargetSizeMm);
            }
            return;
          }
          handleImageConfirm(imageOptions);
        }}
        onClose={() => setImagePending(null)}
      />
      <CloudConsentDialog
        open={cloudImport.consentPending}
        providerNameHe={cloudImport.providerNameHe}
        onApprove={cloudImport.approveConsent}
        onCancel={cloudImport.declineConsent}
      />
      <ExportDialog
        open={dialogs.isOpen("export")}
        document={doc}
        parts={build.parts}
        issues={[...(build.buildResult?.issues ?? []), ...modelIssues]}
        buildOk={build.status === "ok"}
        onExport={handleExport}
        onClose={dialogs.close}
      />
      <ShortcutsDialog
        open={dialogs.isOpen("shortcuts")}
        keymap={keymap}
        onClose={dialogs.close}
        onChange={setKeymap}
      />
      <LibraryDialog
        open={dialogs.isOpen("library")}
        document={doc}
        onClose={dialogs.close}
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
        open={dialogs.isOpen("fillet")}
        onConfirm={handleFilletConfirm}
        onClose={dialogs.close}
      />
      <ShellDialog
        open={dialogs.isOpen("shell")}
        onConfirm={handleShellConfirm}
        onClose={dialogs.close}
      />
      <DeformDialog
        open={dialogs.isOpen("deform")}
        onConfirm={handleDeformConfirm}
        onClose={dialogs.close}
      />
      <LatticeDialog
        open={dialogs.isOpen("lattice")}
        onConfirm={handleLatticeConfirm}
        onClose={dialogs.close}
      />
      <PatternDialog
        open={dialogs.isOpen("pattern")}
        onConfirm={handlePatternConfirm}
        onClose={dialogs.close}
      />
      <GeneratorDialog
        kind={dialogs.generatorKind}
        onConfirm={handleGeneratorConfirm}
        onClose={dialogs.close}
      />
      <MeshInspectorDialog
        open={dialogs.isOpen("inspector")}
        diagnosis={diagnosis}
        report={repairReport}
        busy={busy}
        onNavigate={handleNavigateTo}
        onRepair={handleAdvancedRepair}
        onClose={dialogs.close}
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
        open={dialogs.isOpen("revolve")}
        onConfirm={handleRevolveConfirm}
        onClose={dialogs.close}
      />
      <EmbossDialog
        open={dialogs.isOpen("emboss")}
        artworkName={singleSelectedShape?.name ?? ""}
        targetOptions={embossTargets}
        onConfirm={handleEmbossConfirm}
        onClose={dialogs.close}
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
