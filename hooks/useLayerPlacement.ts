"use client";

/**
 * Moving bodies around the plate: drop, centre, mirror, align, distribute,
 * snap-to-object, duplicate, scale-to-size, fit-to-volume, place-on-surface.
 *
 * All of them read a part's world bounds and write a layer transform, and
 * all of them refuse to move a locked layer — which is why they share
 * `withSelectedPart` rather than each re-deriving the pair.
 */

import { useCallback } from "react";
import type { DesignLayer, Transform3D } from "@/types/design";
import { newId } from "@/types/design";
import { getPrintabilityProfile, type PrinterProfile } from "@/types/profiles";
import type { BuiltPart } from "@/hooks/useDocumentBuilder";
import type { EditorOps } from "@/hooks/useEditorOps";
import type { EditorTool } from "@/components/editor/store";
import type { SurfacePick } from "@/components/viewer/SceneView";
import { meshDataBounds } from "@/lib/geometry/meshData";
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

export type Axis = "x" | "y" | "z";

/** Offset given to a duplicate so it does not hide under its original, mm. */
const DUPLICATE_OFFSET_MM = { x: 10, y: -10, z: 0 };

/** Aligning needs two bodies; distributing needs three. */
const MIN_PARTS_TO_ALIGN = 2;
const MIN_PARTS_TO_DISTRIBUTE = 3;

/** Guards against dividing by a zero-sized axis when scaling to a target. */
const MIN_DIMENSION_MM = 0.001;

/** A new object sits ON the picked surface, not sunk into it. */
const PLACE_ON_SURFACE_GAP_MM = 0;

export interface LayerPlacementHandlers {
  handleDropToPlate: () => void;
  handleCenterOnPlate: () => void;
  handleMirror: (axis: Axis) => void;
  handleAlign: (axis: Axis, mode: "min" | "center" | "max") => void;
  handleDistribute: (axis: Axis) => void;
  handleSnapToCenter: () => void;
  handleSnapToEdge: (axis: Axis) => void;
  handleDuplicate: () => void;
  handleDuplicateLayer: (id: string) => void;
  handleScaleTo: (
    axis: Axis | "longest",
    targetMm: number,
    uniform: boolean
  ) => void;
  handleFitBuildVolume: () => void;
  handleSurfacePick: (pick: SurfacePick) => void;
}

export function useLayerPlacement({
  ops,
  tool,
  selectedLayers,
  selectedParts,
  printer,
  onDrainPick,
}: {
  ops: EditorOps;
  tool: EditorTool;
  selectedLayers: DesignLayer[];
  selectedParts: BuiltPart[];
  printer: PrinterProfile;
  /** Where a drain-hole pick goes while the drain tool is active. */
  onDrainPick: (pick: SurfacePick) => void;
}): LayerPlacementHandlers {
  const {
    document: doc,
    dispatch,
    applyDocument,
    commitTransform,
    showMessage,
  } = ops;

  /** Run `fn` against the first selected part, unless its layer is locked. */
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

  /** Rewrite several layers' transforms as ONE undoable step. */
  const commitTransforms = useCallback(
    (transformByLayerId: Map<string, Transform3D>, labelHe: string) => {
      const layers = doc.layers.map((layer) => {
        const transform = transformByLayerId.get(layer.id);
        return transform ? ({ ...layer, transform } as DesignLayer) : layer;
      });
      applyDocument({ ...doc, layers }, labelHe);
    },
    [doc, applyDocument]
  );

  /** The selected parts paired with their layers, for the multi-body ops. */
  const selectedItems = useCallback(() => {
    const byId = new Map(doc.layers.map((l) => [l.id, l]));
    return selectedParts.flatMap((part) => {
      const layer = byId.get(part.primaryLayerId);
      return layer
        ? [{ layer, transform: layer.transform, bounds: part.stats.bounds }]
        : [];
    });
  }, [selectedParts, doc.layers]);

  const handleDropToPlate = useCallback(() => {
    withSelectedPart((part, layer) =>
      commitTransform(layer.id, dropToPlate(layer.transform, part.stats.bounds))
    );
  }, [withSelectedPart, commitTransform]);

  const handleCenterOnPlate = useCallback(() => {
    withSelectedPart((part, layer) =>
      commitTransform(layer.id, centerOnPlate(layer.transform, part.stats.bounds))
    );
  }, [withSelectedPart, commitTransform]);

  const handleMirror = useCallback(
    (axis: Axis) => {
      withSelectedPart((part, layer) =>
        commitTransform(layer.id, mirrorTransform(layer.transform, part.stats.bounds, axis))
      );
    },
    [withSelectedPart, commitTransform]
  );

  const handleAlign = useCallback(
    (axis: Axis, mode: "min" | "center" | "max") => {
      const items = selectedItems();
      if (items.length < MIN_PARTS_TO_ALIGN) return;
      const aligned = alignTransforms(items, axis, mode);
      commitTransforms(
        new Map(items.map((item, i) => [item.layer.id, aligned[i]])),
        "יישור שכבות"
      );
    },
    [selectedItems, commitTransforms]
  );

  const handleDistribute = useCallback(
    (axis: Axis) => {
      const items = selectedItems();
      if (items.length < MIN_PARTS_TO_DISTRIBUTE) return;
      const distributed = distributeTransforms(items, axis);
      commitTransforms(
        new Map(items.map((item, i) => [item.layer.id, distributed[i]])),
        "פיזור שכבות"
      );
    },
    [selectedItems, commitTransforms]
  );

  /** Snapping is between exactly two bodies: the first moves onto the second. */
  const withSnapPair = useCallback(
    (fn: (moving: BuiltPart, target: BuiltPart, layer: DesignLayer) => void) => {
      if (selectedParts.length !== 2) return;
      const [moving, target] = selectedParts;
      const layer = doc.layers.find((l) => l.id === moving.primaryLayerId);
      if (!layer || layer.locked) return;
      fn(moving, target, layer);
    },
    [selectedParts, doc.layers]
  );

  const handleSnapToCenter = useCallback(() => {
    withSnapPair((moving, target, layer) =>
      commitTransform(
        layer.id,
        snapToObjectCenter(layer.transform, moving.stats.bounds, target.stats.bounds)
      )
    );
  }, [withSnapPair, commitTransform]);

  const handleSnapToEdge = useCallback(
    (axis: Axis) => {
      withSnapPair((moving, target, layer) =>
        commitTransform(
          layer.id,
          snapToObjectEdge(layer.transform, moving.stats.bounds, target.stats.bounds, axis)
        )
      );
    },
    [withSnapPair, commitTransform]
  );

  /** Copy layers, offset so the copies do not hide under their originals. */
  const duplicateLayers = useCallback(
    (layers: DesignLayer[], labelHe: string) => {
      if (layers.length === 0) return;
      const copies = layers.map(
        (layer) =>
          ({
            ...structuredClone(layer),
            id: newId("layer"),
            name: `${layer.name} (עותק)`,
            transform: duplicateTransform(layer.transform, DUPLICATE_OFFSET_MM),
          }) as DesignLayer
      );
      applyDocument({ ...doc, layers: [...doc.layers, ...copies] }, labelHe);
      dispatch({ type: "ui/select", selection: copies.map((l) => l.id) });
    },
    [doc, applyDocument, dispatch]
  );

  const handleDuplicate = useCallback(
    () => duplicateLayers(selectedLayers, "שכפול שכבות"),
    [duplicateLayers, selectedLayers]
  );

  /** Duplicate one named layer — the layer list's own button. */
  const handleDuplicateLayer = useCallback(
    (id: string) => {
      const layer = doc.layers.find((l) => l.id === id);
      if (layer) duplicateLayers([layer], "שכפול שכבה");
    },
    [doc.layers, duplicateLayers]
  );

  const handleScaleTo = useCallback(
    (axis: Axis | "longest", targetMm: number, uniform: boolean) => {
      withSelectedPart((part, layer) => {
        const before = part.stats.dimensionsMm;
        commitTransform(
          layer.id,
          scaleToSize(layer.transform, part.stats.bounds, { axis, targetMm, uniform })
        );
        // Only a uniform shrink can take EVERY thin feature below the wall
        // minimum, so that is the only case worth warning about.
        const scalesEveryAxis = axis === "longest" || uniform;
        if (!scalesEveryAxis) return;
        const longest = Math.max(before.x, before.y, before.z, MIN_DIMENSION_MM);
        const factor = targetMm / longest;
        if (factor <= 0 || factor >= 1) return;
        const profile = getPrintabilityProfile(doc.printabilityProfileId);
        showMessage({
          titleHe: "שינוי גודל",
          bodyHe:
            `הוקטן פי ${(1 / factor).toFixed(2)} — ודאו שפרטים דקים לא ירדו ` +
            `מתחת ל-${profile.minWallMm} מ״מ (בדקו במפת עובי הדפנות)`,
          kind: "info",
        });
      });
    },
    [withSelectedPart, commitTransform, doc.printabilityProfileId, showMessage]
  );

  const handleFitBuildVolume = useCallback(() => {
    withSelectedPart((part, layer) => {
      const factor = fitToBuildVolumeFactor(part.stats.bounds, printer.buildVolumeMm);
      if (factor >= 1) {
        showMessage({
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
  }, [withSelectedPart, commitTransform, printer, showMessage]);

  const handleSurfacePick = useCallback(
    (pick: SurfacePick) => {
      if (tool === "drainHole") {
        onDrainPick(pick);
        return;
      }
      if (tool !== "placeOnSurface") return;
      const part = selectedParts[0];
      if (!part) return;
      if (pick.primaryLayerId === part.primaryLayerId) {
        showMessage({
          titleHe: "הנחה על משטח",
          bodyHe: "לא ניתן להניח אובייקט על עצמו — לחצו על משטח של אובייקט אחר",
          kind: "info",
        });
        return;
      }
      const layer = doc.layers.find((l) => l.id === part.primaryLayerId);
      if (!layer || layer.locked) return;
      commitTransform(
        layer.id,
        placeOnSurface(
          layer.transform,
          meshDataBounds(part.localMesh),
          pick.point,
          pick.normal,
          PLACE_ON_SURFACE_GAP_MM
        )
      );
      dispatch({ type: "ui/setTool", tool: "select" });
    },
    [tool, selectedParts, doc.layers, commitTransform, dispatch, showMessage, onDrainPick]
  );

  return {
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
  };
}
