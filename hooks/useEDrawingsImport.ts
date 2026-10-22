"use client";

/**
 * The eDrawings (.easm / .eprt) import flow.
 *
 * Unlike STL/OBJ/3MF this does not drop straight into the document: an
 * assembly can hold hundreds of components at real-world size in metres, and
 * the user has to decide which of them to bring in, at what scale and in
 * which orientation BEFORE the editor fills up. So the flow is:
 *
 *   1. parse (worker job) → the import screen opens with the decoded model;
 *   2. the user picks components, unit, up axis, scale and layer mode, and
 *      confirms they may use the model;
 *   3. each selected component goes through the same funnel as every other
 *      mesh import — staged repair, triangle budget — and lands as a layer.
 */

import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import type { DesignDocument, ImportedMeshLayer, MaterialSlot } from "@/types/design";
import { newId, primaryMaterialSlotId } from "@/types/design";
import type { EditorAction } from "@/components/editor/store";
import type { OpMessage } from "@/components/dialogs/OperationDialogs";
import type { JobProgress } from "@/hooks/useGeometryJobs";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import type { MeshData } from "@/lib/geometry/meshData";
import { storeMesh } from "@/lib/geometry/meshStore";
import { geometryWorkerAvailable, runGeometryJob, JobCancelledError } from "@/lib/geometry/jobs/client";
import { applyImportTriangleBudget, IMPORT_TRIANGLE_BUDGET } from "@/lib/import/triangleBudget";
import type { EDrawingsModel } from "@/lib/import/edrawings/model";
import {
  placeGeometry,
  placedBounds,
  rebaseOffset,
  type EDrawingsPlacement,
} from "@/lib/import/edrawings/placement";

export type EDrawingsLayerMode = "layers" | "merged";

export interface EDrawingsImportChoice {
  componentIds: string[];
  placement: EDrawingsPlacement;
  mode: EDrawingsLayerMode;
}

export interface EDrawingsPending {
  fileName: string;
  model: EDrawingsModel;
}

/** File extensions this flow owns. */
export const EDRAWINGS_EXTENSIONS = [".easm", ".eprt", ".edrw"];

export function isEDrawingsFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return EDRAWINGS_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Per-component triangle budgets: the editor-wide budget shared in
 * proportion to each component's size, so one heavy part cannot spend the
 * whole allowance while a dozen small ones keep theirs.
 */
export function shareTriangleBudget(counts: number[], budget = IMPORT_TRIANGLE_BUDGET): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= budget) return counts.map(() => budget);
  return counts.map((c) => Math.max(2_000, Math.floor((budget * c) / total)));
}

export interface EDrawingsImportContext {
  doc: DesignDocument;
  dispatch: Dispatch<EditorAction>;
  applyDocument: (next: DesignDocument, labelHe: string) => void;
  setMessage: (message: OpMessage | null) => void;
  showError: (error: unknown, titleHe: string) => void;
  requestAutoAnalysis: () => void;
}

export function useEDrawingsImport(context: EDrawingsImportContext) {
  const { doc, dispatch, applyDocument, setMessage, showError, requestAutoAnalysis } = context;
  const [pending, setPending] = useState<EDrawingsPending | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The import runs for a while; it lands on the document as it is THEN.
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const start = useCallback(
    async (file: File) => {
      if (file.name.toLowerCase().endsWith(".edrw")) {
        setMessage({
          titleHe: "ייבוא eDrawings",
          bodyHe:
            "קובצי ‎.edrw הם שרטוטים דו־ממדיים ואין בהם מודל להדפסה. ייבאו את קובץ ההרכבה (‎.easm) או החלק (‎.eprt) במקומו.",
          kind: "info",
        });
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const labelHe = "ייבוא eDrawings";
      try {
        setProgress({ labelHe, fraction: null, stageHe: "קורא את הקובץ…", offThread: geometryWorkerAvailable() });
        const buffer = await file.arrayBuffer();
        const { result: model } = await runGeometryJob(
          "parseEDrawings",
          { buffer },
          {
            signal: controller.signal,
            onProgress: (fraction, stageHe) =>
              setProgress({ labelHe, fraction, stageHe, offThread: geometryWorkerAvailable() }),
          }
        );
        if (controller.signal.aborted) return;
        setPending({ fileName: file.name, model });
      } catch (error) {
        if (error instanceof JobCancelledError || controller.signal.aborted) return;
        showError(error, "ייבוא eDrawings");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setProgress(null);
      }
    },
    [setMessage, showError]
  );

  const close = useCallback(() => setPending(null), []);

  const confirm = useCallback(
    async (choice: EDrawingsImportChoice) => {
      const current = pending;
      if (!current) return;
      setPending(null);
      const selected = current.model.components.filter((c) => choice.componentIds.includes(c.id));
      if (selected.length === 0) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const labelHe = "ייבוא eDrawings";
      const stage = (fraction: number | null, stageHe: string) =>
        setProgress({ labelHe, fraction, stageHe, offThread: geometryWorkerAvailable() });
      const noticesHe: string[] = [...current.model.warningsHe];

      try {
        const bounds = placedBounds(
          selected.map((c) => c.bounds),
          choice.placement
        );
        if (!bounds) return;
        const offset = rebaseOffset(bounds);
        const budgets = shareTriangleBudget(selected.map((c) => c.triangleCount));
        const kernel = await getGeometryKernel();

        const prepared: { name: string; colorHex: string | null; mesh: MeshData; closed: boolean }[] = [];
        for (let i = 0; i < selected.length; i++) {
          const component = selected[i];
          const base = i / selected.length;
          const span = 1 / selected.length;
          stage(base, `מתקן את ״${component.name}״ (${i + 1}/${selected.length})…`);
          const placedBodies = component.bodies.map((body) =>
            placeGeometry(body, choice.placement, offset)
          );
          // Display tessellation: each body is repaired on its own and the
          // bodies united exactly; only bodies that stay open are rebuilt
          // (assemble.ts explains why the whole-component repair is wrong).
          const { result: assembled } = await runGeometryJob(
            "assembleEDrawingsComponent",
            { bodies: placedBodies },
            {
              signal: controller.signal,
              onProgress: (fraction, stageHe) =>
                stage(base + span * 0.9 * fraction, `${component.name}: ${stageHe}`),
            }
          );
          if (controller.signal.aborted) return;
          let mesh = assembled.mesh;
          const closed = assembled.closed;
          if (closed) {
            if (assembled.bodiesRepaired + assembled.bodiesRebuilt > 0) {
              noticesHe.push(`${component.name}: ${assembled.messageHe}`);
            }
            const budgeted = await applyImportTriangleBudget(kernel, mesh, budgets[i]);
            if (budgeted.noticeHe) noticesHe.push(`${component.name}: ${budgeted.noticeHe}`);
            mesh = budgeted.mesh;
          } else {
            noticesHe.push(
              `${component.name}: ${assembled.messageHe}. הרכיב יובא כפי שהוא — השתמשו ב״תיקון רשת״ לפני הדפסה.`
            );
          }
          prepared.push({ name: component.name, colorHex: component.colorHex, mesh, closed });
        }

        let finalParts = prepared;
        if (choice.mode === "merged" && prepared.length > 1) {
          if (prepared.every((p) => p.closed)) {
            stage(0.95, "מאחד את הרכיבים לגוף אחד…");
            try {
              const { result } = await runGeometryJob(
                "unionMeshes",
                { meshes: prepared.map((p) => p.mesh) },
                { signal: controller.signal }
              );
              const baseName = current.fileName.replace(/\.(easm|eprt)$/i, "");
              finalParts = [{ name: baseName, colorHex: prepared[0].colorHex, mesh: result.mesh, closed: true }];
            } catch (error) {
              if (error instanceof JobCancelledError) throw error;
              noticesHe.push(
                `האיחוד לגוף אחד נכשל (${error instanceof Error ? error.message : String(error)}) — הרכיבים יובאו כשכבות נפרדות.`
              );
            }
          } else {
            noticesHe.push("לא כל הרכיבים נסגרו לגוף אטום, ולכן לא אוחדו — הם יובאו כשכבות נפרדות.");
          }
        }
        if (controller.signal.aborted) return;

        // Colours become material slots, reusing an existing slot of the same colour.
        const currentDoc = docRef.current;
        const slots: MaterialSlot[] = [...currentDoc.materialSlots];
        const slotFor = (colorHex: string | null): string => {
          if (!colorHex) return primaryMaterialSlotId(currentDoc);
          const existing = slots.find((s) => s.colorHex.toLowerCase() === colorHex.toLowerCase());
          if (existing) return existing.id;
          const slot = { id: newId("slot"), nameHe: `חומר ${slots.length + 1}`, colorHex };
          slots.push(slot);
          return slot.id;
        };

        const layers: ImportedMeshLayer[] = finalParts.map((part) => {
          const meshId = storeMesh(part.mesh);
          return {
            id: newId("layer"),
            type: "importedMesh",
            name: part.name,
            visible: true,
            locked: false,
            materialSlotId: slotFor(part.colorHex),
            transform: {
              x: 0, y: 0, z: 0,
              rotationX: 0, rotationY: 0, rotationZ: 0,
              scaleX: 1, scaleY: 1, scaleZ: 1,
            },
            previewOpacity: 1,
            meshId,
            // "stlImport" is what the design-file sanitizer stores for every
            // mesh file; the format lives in fileName.
            provenance: { kind: "stlImport", fileName: current.fileName },
            originalMeshId: meshId,
            combine: "standalone",
          };
        });

        applyDocument(
          { ...currentDoc, materialSlots: slots, layers: [...currentDoc.layers, ...layers] },
          "ייבוא eDrawings"
        );
        dispatch({ type: "ui/select", selection: layers.map((l) => l.id) });
        requestAutoAnalysis();
        if (layers.length > 1) {
          noticesHe.unshift(`יובאו ${layers.length} רכיבים — כל אחד כשכבה נפרדת, במיקומו בהרכבה.`);
        }
        if (noticesHe.length > 0) {
          setMessage({ titleHe: "ייבוא eDrawings — הערות", bodyHe: noticesHe.join("\n\n"), kind: "info" });
        }
      } catch (error) {
        if (error instanceof JobCancelledError || controller.signal.aborted) return;
        showError(error, "ייבוא eDrawings");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setProgress(null);
      }
    },
    [pending, applyDocument, dispatch, requestAutoAnalysis, setMessage, showError]
  );

  return { pending, progress, start, confirm, close, cancel };
}
