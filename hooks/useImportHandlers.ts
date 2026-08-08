"use client";

/**
 * File-import handlers: STL, SVG, raster images and portable design files.
 *
 * Extracted from Editor.tsx, which had grown past 2,800 lines and held every
 * concern in the application at once. Imports are a genuinely separable
 * domain — they take a File, validate and parse it, and append a layer — so
 * they move out as a unit with an explicit dependency object rather than by
 * reaching into component scope.
 *
 * The behaviour is unchanged; the UI regression suite written before this
 * refactor is what proves that.
 */

import { useCallback, type Dispatch, type RefObject } from "react";
import * as THREE from "three";
import type { DesignDocument, DesignLayer, ImportedMeshLayer } from "@/types/design";
import { newId, primaryMaterialSlotId } from "@/types/design";
import type { EditorAction } from "@/components/editor/store";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import { meshDataBounds, transformMeshData } from "@/lib/geometry/meshData";
import { storeMesh } from "@/lib/geometry/meshStore";
import { parseStl, summarizeStlMesh } from "@/lib/import/stl";
import { attemptMeshRepair } from "@/lib/geometry/repair/repair";
import { parseSvgToContours, SvgImportError } from "@/lib/import/svg";
import { sanitizeSvg } from "@/lib/import/svgSanitize";
import {
  decodeImageToGrid,
  dilateSilhouetteGrid,
  gridToSilhouetteContours,
  heightFieldToClosedMesh,
  ImageImportError,
  isBimodalEnough,
  measureThinnestFeature,
  otsuThreshold,
  smoothGrid,
  stripImageExtension,
  thinFeatureMessageHe,
  validateImageFile,
} from "@/lib/import/image";
import { documentNozzleDiameterMm } from "@/lib/geometry/calibration";
import { importDesignFile } from "@/lib/serialization/designFile";
import type {
  ImageImportOptionsValue,
  StlImportPreview,
  SvgImportOptionsValue,
} from "@/components/dialogs/ImportDialogs";
import type { OpMessage } from "@/components/dialogs/OperationDialogs";

/** Everything the import handlers need from the editor shell. */
export interface ImportHandlersContext {
  doc: DesignDocument;
  dispatch: Dispatch<EditorAction>;
  runOp: (labelHe: string, fn: () => Promise<void>) => Promise<void>;
  applyDocument: (next: DesignDocument, labelHe: string) => void;
  setMessage: (message: OpMessage | null) => void;
  setStlPreview: (preview: StlImportPreview | null) => void;
  pendingStlRef: RefObject<{ meshId: string; fileName: string } | null>;
  svgPending: { text: string; fileName: string } | null;
  setSvgPending: (pending: { text: string; fileName: string } | null) => void;
  imagePending: { file: File; fileName: string } | null;
  setImagePending: (pending: { file: File; fileName: string } | null) => void;
}

/** Read a File into an ArrayBuffer. */
function readFileBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

export function useImportHandlers(context: ImportHandlersContext) {
  const {
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
  } = context;


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
    [runOp, pendingStlRef, setStlPreview]
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
      materialSlotId: primaryMaterialSlotId(doc),
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
  }, [doc, applyDocument, dispatch, pendingStlRef, setStlPreview]);

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
          materialSlotId: primaryMaterialSlotId(doc),
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
    [svgPending, setSvgPending, doc, applyDocument, dispatch, runOp, setMessage]
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
  }, [setImagePending, setMessage]);

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
        const noticesHe: string[] = [];
        if (options.removeBackground && decoded.backgroundRemovedFraction < 0.01) {
          noticesHe.push("כמעט שלא זוהה רקע להסרה — נסו להגדיל את סבילות הצבע");
        }
        const grid = smoothGrid(decoded.grid, options.smoothingLevel);
        const pixelSizeMm = options.targetWidthMm / grid.width;
        let layer: DesignLayer;
        if (options.mode === "silhouette") {
          // Otsu runs HERE and nowhere else: the value it produces is stored
          // on the layer, and the rebuild path keeps reading the stored
          // value. Re-deriving it on rebuild would reshape every saved design.
          const threshold =
            options.thresholdMode === "auto"
              ? otsuThreshold(grid)
              : options.threshold;
          if (options.thresholdMode === "auto" && !isBimodalEnough(grid, threshold)) {
            noticesHe.push(
              "לתמונה אין הפרדה ברורה בין כהה לבהיר, כך שהסף האוטומטי הוא ניחוש — " +
                "עברו ל״סף בהירות: ידני״ בחלון הייבוא, או הגדילו את הניגודיות."
            );
          }
          const silhouette = {
            threshold,
            invert: options.invert,
            pixelSizeMm,
          };
          let contours = gridToSilhouetteContours(grid, silhouette);
          // Minimum-feature check while the threshold, the resolution and the
          // artwork are all still changeable — the wall-thickness analysis
          // finds the same defect, but only once none of them are.
          const thin = measureThinnestFeature(grid, {
            ...silhouette,
            minimumMm: documentNozzleDiameterMm(doc) * 2,
          });
          if (thin.violates) {
            if (options.thickenThinFeatures) {
              const thickened = dilateSilhouetteGrid(
                grid,
                silhouette,
                thin.suggestedDilationMm
              );
              const retraced = gridToSilhouetteContours(thickened, silhouette);
              if (retraced.length > 0) contours = retraced;
            }
            noticesHe.push(thinFeatureMessageHe(thin, options.thickenThinFeatures));
          }
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
            materialSlotId: primaryMaterialSlotId(doc),
            transform: { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
            previewOpacity: 1,
            sourceName: pending.fileName,
            mode: "silhouette",
            contours,
            meshId: null,
            settings: {
              targetWidthMm: options.targetWidthMm,
              // The value Otsu produced, not the dialog's unused default —
              // this is what the layer reports and what a regeneration reuses.
              threshold,
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
            materialSlotId: primaryMaterialSlotId(doc),
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
        if (noticesHe.length > 0) {
          setMessage({
            titleHe: "ייבוא תמונה — הערות",
            bodyHe: noticesHe.join("\n\n"),
            kind: "info",
          });
        }
      });
    },
    [imagePending, setImagePending, doc, applyDocument, dispatch, runOp, setMessage]
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
    [runOp, applyDocument, dispatch, setMessage]
  );
  return {
    handleStlFile,
    confirmStlImport,
    handleSvgConfirm,
    handleImageFile,
    handleImageConfirm,
    handleDesignFile,
  };
}
