"use client";

/**
 * Sub-object editing: selecting triangles on a body, the operations that
 * act on that selection, and per-face material painting.
 *
 * Everything here is scoped to `state.ui.faceSelection` — a layer id plus a
 * triangle set. Two things follow from that and shape the whole module:
 *
 *  - Triangle indices are meaningless on a different body, so every
 *    operation resolves the selection's layer first and gives up quietly if
 *    it is gone or locked. That preamble is `runRegionOp`, not five copies.
 *  - Painting is METADATA, not geometry: it records which material each
 *    triangle belongs to and leaves the body alone. Splitting into
 *    per-colour printable parts happens at export.
 */

import { useCallback, useMemo, type Dispatch } from "react";
import type { DesignLayer } from "@/types/design";
import { FALLBACK_MATERIAL_SLOT_ID, isShapeLayer } from "@/types/design";
import type { EditorAction, FaceSelection } from "@/components/editor/store";
import type { EditorState } from "@/components/editor/store";
import type { BuiltPart } from "@/hooks/useDocumentBuilder";
import type { UseGeometryJobs } from "@/hooks/useGeometryJobs";
import type { EditorOps } from "@/hooks/useEditorOps";
import type { PaintInfo, RegionInfo } from "@/components/editor/SubObjectPanel";
import type { MeshData } from "@/lib/geometry/meshData";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import { OpError } from "@/lib/geometry/operations/layerOps";
import { meshToResultLayer } from "@/lib/geometry/operations/advancedOps";
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
  activePaints,
  hasStalePaint,
  paintedTriangleSlots,
  paintTriangles,
  unpaintTriangles,
} from "@/lib/geometry/painting";

/** Passes and strength of the local Laplacian smooth on a picked region. */
const REGION_SMOOTH = { iterations: 6, strength: 0.6 } as const;

export interface RegionTools {
  faceSelection: FaceSelection | null;
  faceSelectionPart: BuiltPart | null;
  regionInfo: RegionInfo | null;
  paintInfo: PaintInfo | null;
  /** The slot a paint action will use: never the body's own colour. */
  resolvedPaintSlotId: string;
  handleFacePick: (
    primaryLayerId: string,
    triangleIndex: number,
    additive: boolean
  ) => void;
  handleSelectAllFaces: () => void;
  handleFilletRegion: () => void;
  handlePushPull: () => void;
  handleRegionSmooth: () => void;
  handleRegionDelete: () => void;
  handleRegionSplit: () => void;
  handlePaintRegion: () => void;
  handleUnpaintRegion: () => void;
  handleClearPaint: () => void;
}

export function useRegionTools({
  ops,
  jobs,
  uiState,
  dispatch,
  selection,
  selectedParts,
  partByLayer,
  pushPullMm,
  filletRegionMm,
  paintSlotId,
  paintDepthMm,
}: {
  ops: EditorOps;
  jobs: UseGeometryJobs;
  uiState: EditorState["ui"];
  dispatch: Dispatch<EditorAction>;
  selection: string[];
  selectedParts: BuiltPart[];
  partByLayer: Map<string, BuiltPart>;
  pushPullMm: number;
  filletRegionMm: number;
  paintSlotId: string | null;
  paintDepthMm: number;
}): RegionTools {
  const { document: doc, runOp, applyOpResult, updateLayer } = ops;
  const faceSelection = uiState.faceSelection;

  /** The part whose faces are currently selected. */
  const faceSelectionPart = useMemo(
    () => (faceSelection ? partByLayer.get(faceSelection.layerId) ?? null : null),
    [faceSelection, partByLayer]
  );

  /** The layer the face selection belongs to, if it is still editable. */
  const selectedFaceLayer = useMemo(
    () =>
      faceSelection
        ? doc.layers.find((l) => l.id === faceSelection.layerId) ?? null
        : null,
    [faceSelection, doc.layers]
  );

  const regionInfo: RegionInfo | null = useMemo(() => {
    if (!faceSelection || !faceSelectionPart || faceSelection.triangles.length === 0) {
      return null;
    }
    const mesh = faceSelectionPart.worldMesh;
    const adjacency = buildAdjacency(mesh);
    const triangles = new Set(faceSelection.triangles);
    return {
      triangleCount: triangles.size,
      areaMm2: selectionArea(adjacency, triangles),
      planar: isSelectionPlanarForUi(mesh, adjacency, triangles),
    };
  }, [faceSelection, faceSelectionPart]);

  const handleFacePick = useCallback(
    (primaryLayerId: string, triangleIndex: number, additive: boolean) => {
      const part = partByLayer.get(primaryLayerId);
      if (!part) return;
      const adjacency = buildAdjacency(part.worldMesh);
      const grown = growSelection(adjacency, triangleIndex, {
        mode: uiState.faceGrowMode,
        angleToleranceDeg: uiState.faceGrowAngleDeg,
      });
      // Additive picking only merges within the SAME body; picking on a
      // different body replaces, because triangle indices do not transfer.
      const merged =
        additive && faceSelection && faceSelection.layerId === primaryLayerId
          ? new Set([...faceSelection.triangles, ...grown])
          : grown;
      // Keep the body selected too, so the properties panel stays in
      // context. Selecting resets the face selection, so it is re-applied.
      if (!selection.includes(primaryLayerId)) {
        dispatch({ type: "ui/select", selection: [primaryLayerId] });
      }
      dispatch({
        type: "ui/setFaceSelection",
        selection: { layerId: primaryLayerId, triangles: [...merged] },
      });
    },
    [
      partByLayer,
      uiState.faceGrowMode,
      uiState.faceGrowAngleDeg,
      faceSelection,
      dispatch,
      selection,
    ]
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

  /**
   * Run an operation over the picked region and replace its source layer.
   * The callback returns null when the user cancelled the job, in which
   * case nothing changes — not even the selection.
   */
  const runRegionOp = useCallback(
    (
      labelHe: string,
      fn: (
        layer: DesignLayer,
        mesh: MeshData,
        triangles: Set<number>
      ) => Promise<{ layers: DesignLayer[]; warningsHe: string[] } | null>
    ) => {
      const sel = faceSelection;
      const layer = selectedFaceLayer;
      if (!sel || sel.triangles.length === 0 || !layer || layer.locked) return;
      const part = partByLayer.get(sel.layerId);
      if (!part) return;
      void runOp(labelHe, async () => {
        const outcome = await fn(layer, part.worldMesh, new Set(sel.triangles));
        if (!outcome) return;
        dispatch({ type: "ui/setFaceSelection", selection: null });
        applyOpResult(labelHe, outcome.layers, [layer.id], "hide", outcome.warningsHe);
      });
    },
    [faceSelection, selectedFaceLayer, partByLayer, runOp, applyOpResult, dispatch]
  );

  const handleFilletRegion = useCallback(() => {
    if (!selectedFaceLayer || !isShapeLayer(selectedFaceLayer)) return;
    runRegionOp("עיגול אזור", async (layer, mesh, triangles) => {
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
  }, [selectedFaceLayer, runRegionOp, filletRegionMm, jobs]);

  const handlePushPull = useCallback(() => {
    if (!selectedFaceLayer || !isShapeLayer(selectedFaceLayer)) return;
    runRegionOp("הזזת פאה", async (layer, mesh, triangles) => {
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
  }, [selectedFaceLayer, runRegionOp, pushPullMm]);

  const handleRegionSmooth = useCallback(() => {
    runRegionOp("החלקה מקומית", async (layer, mesh, triangles) => {
      const smoothed = smoothRegion(mesh, triangles, REGION_SMOOTH);
      const resultLayer = await meshToResultLayer(smoothed, {
        nameHe: `${layer.name} — החלקה מקומית`,
        descriptionHe: "החלקה של אזור נבחר",
        materialSlotId: layer.materialSlotId,
        sourceLayerId: layer.id,
      });
      return { layers: [resultLayer], warningsHe: [] };
    });
  }, [runRegionOp]);

  const handleRegionDelete = useCallback(() => {
    runRegionOp("מחיקת אזור", async (layer, mesh, triangles) => {
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
  }, [runRegionOp]);

  const handleRegionSplit = useCallback(() => {
    runRegionOp("הפרדת אזור", async (layer, mesh, triangles) => {
      const { regionMesh, remainderMesh } = splitByRegion(mesh, triangles);
      const common = {
        materialSlotId: layer.materialSlotId,
        sourceLayerId: layer.id,
        kind: "splitPart" as const,
      };
      return {
        layers: [
          await meshToResultLayer(regionMesh, {
            ...common,
            nameHe: `${layer.name} — אזור`,
            descriptionHe: "אזור שהופרד",
          }),
          await meshToResultLayer(remainderMesh, {
            ...common,
            nameHe: `${layer.name} — שארית`,
            descriptionHe: "שארית אחרי הפרדה",
          }),
        ],
        warningsHe: [],
      };
    });
  }, [runRegionOp]);

  // ---- painting ------------------------------------------------------------

  const paintTriangleCount = faceSelectionPart
    ? faceSelectionPart.localMesh.indices.length / 3
    : 0;

  // Default to the SECOND slot: painting with the body's own colour is a
  // no-op, and the whole point of the tool is contrast.
  const resolvedPaintSlotId =
    paintSlotId && doc.materialSlots.some((s) => s.id === paintSlotId)
      ? paintSlotId
      : doc.materialSlots[1]?.id ??
        doc.materialSlots[0]?.id ??
        FALLBACK_MATERIAL_SLOT_ID;

  const paintInfo: PaintInfo | null = useMemo(() => {
    if (!selectedFaceLayer || !faceSelectionPart) return null;
    const active = activePaints(selectedFaceLayer.facePaint, paintTriangleCount);
    const owners = paintedTriangleSlots(active);
    const selected = faceSelection?.triangles ?? [];
    return {
      countBySlot: active.map((p) => ({
        slotId: p.materialSlotId,
        triangles: p.triangles.length,
      })),
      stale: hasStalePaint(selectedFaceLayer.facePaint, paintTriangleCount),
      selectionPainted: selected.length > 0 && selected.some((t) => owners.has(t)),
    };
  }, [selectedFaceLayer, faceSelectionPart, paintTriangleCount, faceSelection]);

  const handlePaintRegion = useCallback(() => {
    const layer = selectedFaceLayer;
    if (!faceSelection || faceSelection.triangles.length === 0) return;
    if (!layer || layer.locked) return;
    updateLayer(
      layer.id,
      {
        facePaint: paintTriangles(
          layer.facePaint,
          resolvedPaintSlotId,
          faceSelection.triangles,
          paintTriangleCount,
          paintDepthMm,
          // Spatial anchors: what lets the paint survive a rebuild (V6).
          faceSelectionPart?.localMesh
        ),
      },
      "צביעת אזור"
    );
  }, [
    faceSelection,
    selectedFaceLayer,
    resolvedPaintSlotId,
    paintTriangleCount,
    paintDepthMm,
    updateLayer,
    faceSelectionPart,
  ]);

  const handleUnpaintRegion = useCallback(() => {
    const layer = selectedFaceLayer;
    if (!faceSelection || !layer || layer.locked) return;
    updateLayer(
      layer.id,
      {
        facePaint: unpaintTriangles(
          layer.facePaint,
          faceSelection.triangles,
          paintTriangleCount,
          faceSelectionPart?.localMesh
        ),
      },
      "הסרת צבע מאזור"
    );
  }, [faceSelection, selectedFaceLayer, paintTriangleCount, updateLayer, faceSelectionPart]);

  const handleClearPaint = useCallback(() => {
    const layer = selectedFaceLayer;
    if (!layer || layer.locked) return;
    updateLayer(layer.id, { facePaint: [] }, "ניקוי צביעה");
  }, [selectedFaceLayer, updateLayer]);

  return {
    faceSelection,
    faceSelectionPart,
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
  };
}
