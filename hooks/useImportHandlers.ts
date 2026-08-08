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
import { meshDataBounds, transformMeshData, type MeshData } from "@/lib/geometry/meshData";
import { storeMesh } from "@/lib/geometry/meshStore";
import { parseStl, summarizeStlMesh } from "@/lib/import/stl";
import { parseObj } from "@/lib/import/obj";
import { parseThreeMf } from "@/lib/import/threeMF";
import { applyImportTriangleBudget } from "@/lib/import/triangleBudget";
import { attemptMeshRepair } from "@/lib/geometry/repair/repair";
import { parseSvgToContours, SvgImportError } from "@/lib/import/svg";
import { sanitizeSvg } from "@/lib/import/svgSanitize";
import {
  applyMaskStrokes,
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


  /**
   * A 3MF carries a whole build, so it does not go through the single-mesh
   * preview: it becomes one layer per body, each at the position the file's
   * build transform put it, with colours resolved into material slots.
   */
  const importThreeMf = useCallback(
    async (file: File) => {
      const buffer = await readFileBuffer(file);
      const parsed = await parseThreeMf(buffer);
      const kernel = await getGeometryKernel();
      const noticesHe = [...parsed.warningsHe];

      const slots = [...doc.materialSlots];
      /** Reuse a slot with the same colour before adding one. */
      const slotFor = (colorHex: string | null, nameHe: string | null): string => {
        if (!colorHex) return primaryMaterialSlotId(doc);
        const existing = slots.find(
          (slot) => slot.colorHex.toLowerCase() === colorHex.toLowerCase()
        );
        if (existing) return existing.id;
        const slot = {
          id: newId("slot"),
          nameHe: nameHe || `חומר ${slots.length + 1}`,
          colorHex,
        };
        slots.push(slot);
        return slot.id;
      };

      const layers: DesignLayer[] = [];
      for (const object of parsed.objects) {
        const budgeted = await applyImportTriangleBudget(kernel, object.mesh);
        if (budgeted.noticeHe) noticesHe.push(`${object.name}: ${budgeted.noticeHe}`);
        const meshId = storeMesh(budgeted.mesh);
        layers.push({
          id: newId("layer"),
          type: "importedMesh",
          name: object.name,
          visible: true,
          locked: false,
          materialSlotId: slotFor(object.colorHex, object.materialName),
          transform: {
            x: object.position.x,
            y: object.position.y,
            z: object.position.z,
            rotationX: 0, rotationY: 0, rotationZ: 0,
            scaleX: 1, scaleY: 1, scaleZ: 1,
          },
          previewOpacity: 1,
          meshId,
          // A body the file marks as SUPPORT keeps that meaning, so
          // re-exporting it still tells the slicer to print a removable aid
          // rather than a solid part. Everything else is a plain mesh import;
          // the design file collapses other kinds to "stlImport" anyway.
          provenance: {
            kind: object.role === "support" ? "supportResult" : "stlImport",
            fileName: file.name,
          },
          originalMeshId: meshId,
          combine: "standalone",
        });
      }

      applyDocument(
        { ...doc, materialSlots: slots, layers: [...doc.layers, ...layers] },
        "ייבוא 3MF"
      );
      dispatch({ type: "ui/select", selection: layers.map((l) => l.id) });
      if (layers.length > 1) {
        noticesHe.unshift(`הקובץ הכיל ${layers.length} גופים — כל אחד יובא כשכבה נפרדת.`);
      }
      if (noticesHe.length > 0) {
        setMessage({
          titleHe: "ייבוא 3MF — הערות",
          bodyHe: noticesHe.join("\n\n"),
          kind: "info",
        });
      }
    },
    [doc, applyDocument, dispatch, setMessage]
  );

  /**
   * STL, OBJ and 3MF arrive through one picker. STL and OBJ are single meshes
   * and share the summary dialog; 3MF is a build and takes its own path.
   */
  const handleMeshFile = useCallback(
    async (file: File) => {
      const name = file.name.toLowerCase();
      await runOp("ייבוא מודל", async () => {
        if (name.endsWith(".3mf")) {
          await importThreeMf(file);
          return;
        }
        const buffer = await readFileBuffer(file);
        const warningsHe: string[] = [];
        let mesh: MeshData;
        if (name.endsWith(".obj")) {
          const parsed = parseObj(new TextDecoder("utf-8", { fatal: false }).decode(buffer));
          mesh = parsed.mesh;
          warningsHe.push(...parsed.warningsHe);
        } else {
          mesh = parseStl(buffer).mesh;
        }
        // Rebase: centre XY, rest on Z=0.
        const bounds = meshDataBounds(mesh);
        const cx = (bounds.min.x + bounds.max.x) / 2;
        const cy = (bounds.min.y + bounds.max.y) / 2;
        const rebased = transformMeshData(
          mesh,
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
        // The budget runs on the REPAIRED mesh: simplification is an
        // edge-collapse on a manifold, so trying it before repair would
        // decline on exactly the files that need it most.
        const budgeted = await applyImportTriangleBudget(kernel, finalMesh);
        if (budgeted.noticeHe) warningsHe.push(budgeted.noticeHe);
        const meshId = storeMesh(budgeted.mesh);
        pendingStlRef.current = { meshId, fileName: file.name };
        const summary = summarizeStlMesh(budgeted.mesh);
        summary.warningsHe.push(...warningsHe);
        setStlPreview({ fileName: file.name, summary, manifold, repairMessageHe });
      });
    },
    [runOp, pendingStlRef, setStlPreview, importThreeMf]
  );

  const confirmStlImport = useCallback(() => {
    const pending = pendingStlRef.current;
    setStlPreview(null);
    pendingStlRef.current = null;
    if (!pending) return;
    const layer: ImportedMeshLayer = {
      id: newId("layer"),
      type: "importedMesh",
      name: pending.fileName.replace(/\.(stl|obj)$/i, ""),
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
    applyDocument({ ...doc, layers: [...doc.layers, layer] }, "ייבוא מודל");
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
        const smoothed = smoothGrid(decoded.grid, options.smoothingLevel);
        const pixelSizeMm = options.targetWidthMm / smoothed.width;
        let layer: DesignLayer;
        if (options.mode === "silhouette") {
          // Otsu runs HERE and nowhere else: the value it produces is stored
          // on the layer, and the rebuild path keeps reading the stored
          // value. Re-deriving it on rebuild would reshape every saved design.
          // It reads the grid BEFORE the brush, so hand corrections — which
          // are extreme black and white by construction — cannot skew it.
          const threshold =
            options.thresholdMode === "auto"
              ? otsuThreshold(smoothed)
              : options.threshold;
          // Same order the dialog's preview uses, so the preview is the file.
          const grid = applyMaskStrokes(smoothed, options.maskStrokes, {
            threshold,
            invert: options.invert,
          });
          if (options.thresholdMode === "auto" && !isBimodalEnough(smoothed, threshold)) {
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
          // Relief reads the height field itself, so there is no silhouette
          // mask for the brush to correct; the dialog hides it in this mode.
          const mesh = heightFieldToClosedMesh(smoothed, {
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
    handleMeshFile,
    confirmStlImport,
    handleSvgConfirm,
    handleImageFile,
    handleImageConfirm,
    handleDesignFile,
  };
}
