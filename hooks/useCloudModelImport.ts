"use client";

/**
 * The cloud image→3D flow: consent, upload, generation progress, download,
 * and the print-readiness funnel every generated mesh must pass —
 * hardened OBJ parse → staged repair pipeline (voxel remesh fallback) →
 * triangle budget → mesh layer → printability analysis.
 *
 * Nothing leaves the device before the user approves the Hebrew consent
 * notice naming the provider; approval is remembered for the browser
 * SESSION only (sessionStorage), so a new session asks again.
 */

import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import * as THREE from "three";
import type { DesignDocument, ImportedMeshLayer } from "@/types/design";
import { newId, primaryMaterialSlotId } from "@/types/design";
import type { EditorAction } from "@/components/editor/store";
import type { OpMessage } from "@/components/dialogs/OperationDialogs";
import type { CloudModeAvailability } from "@/components/dialogs/ImportDialogs";
import type { JobProgress } from "@/hooks/useGeometryJobs";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import { meshDataBounds, transformMeshData } from "@/lib/geometry/meshData";
import { storeMesh } from "@/lib/geometry/meshStore";
import { runGeometryJob, JobCancelledError } from "@/lib/geometry/jobs/client";
import { applyImportTriangleBudget } from "@/lib/import/triangleBudget";
import { stripImageExtension } from "@/lib/import/image";
import { fetchCloudAvailability, generateCloudModel } from "@/lib/ai/cloudClient";
import { AiError } from "@/lib/ai/errors";

/** Session-scoped consent flag — a fresh browser session asks again. */
const CONSENT_KEY = "stlify.cloudConsent.v1";

function sessionConsentGiven(): boolean {
  try {
    return sessionStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberSessionConsent(): void {
  try {
    sessionStorage.setItem(CONSENT_KEY, "1");
  } catch {
    // Consent still applies to this run; it will just be asked again.
  }
}

export interface CloudModelImportContext {
  doc: DesignDocument;
  dispatch: Dispatch<EditorAction>;
  applyDocument: (next: DesignDocument, labelHe: string) => void;
  setMessage: (message: OpMessage | null) => void;
  showError: (error: unknown, titleHe: string) => void;
  /** Ask the editor to run printability analysis on the next finished build. */
  requestAutoAnalysis: () => void;
}

export function useCloudModelImport(context: CloudModelImportContext) {
  const { doc, dispatch, applyDocument, setMessage, showError, requestAutoAnalysis } =
    context;

  const [availability, setAvailability] = useState<CloudModeAvailability | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [consentPending, setConsentPending] = useState<{
    file: File;
    targetSizeMm: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Generation takes minutes and the user keeps editing meanwhile. The new
  // layer must land on the document as it is THEN, not as it was at upload
  // time — a captured `doc` would silently revert every edit made while the
  // provider worked. The ref tracks the latest committed document.
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  // One availability probe per editor mount; the dialog shows "checking…"
  // until it lands and a disabled mode with the reason when it says no.
  useEffect(() => {
    let live = true;
    fetchCloudAvailability().then((result) => {
      if (!live) return;
      setAvailability({
        enabled: result.enabled,
        providerNameHe: result.providerNameHe ?? "",
      });
    });
    return () => {
      live = false;
    };
  }, []);

  // Abort any run in flight when the editor unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const providerNameHe = availability?.providerNameHe || "ספק הענן";

  const run = useCallback(
    async (file: File, targetSizeMm: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const labelHe = "מודל מלא מתמונה (ענן)";
      const stage = (fraction: number | null, stageHe: string) =>
        setProgress({ labelHe, fraction, stageHe, offThread: true });

      try {
        stage(0.02, "מעלה את התמונה…");
        const { objText } = await generateCloudModel(file, {
          signal: controller.signal,
          onProgress: (cloudStage, fraction) => {
            if (cloudStage === "uploading") stage(0.02, "מעלה את התמונה…");
            else if (cloudStage === "generating") {
              stage(
                0.05 + (fraction ?? 0) * 0.6,
                "מייצר מודל בענן (בדרך כלל דקה עד שלוש דקות)…"
              );
            } else stage(0.68 + (fraction ?? 0) * 0.07, "מוריד את המודל…");
          },
        });
        if (controller.signal.aborted) return;

        // --- The print-readiness funnel -----------------------------------
        // 1. Hardened import: the provider's bytes go through the same
        //    validated OBJ parser as any user file — as a job, because a
        //    generated OBJ can be tens of megabytes and parsing that much
        //    text on the main thread would freeze the editor right after a
        //    minutes-long wait.
        stage(0.76, "קורא את קובץ המודל…");
        const { result: parsed } = await runGeometryJob(
          "parseObjText",
          { text: objText },
          {
            signal: controller.signal,
            onProgress: (fraction, stageHe) => stage(0.76 + fraction * 0.03, stageHe),
          }
        );
        const noticesHe = [...parsed.warningsHe];

        // 2. Physical size: the provider has no units, so the footprint is
        //    set to the size the user chose, then rebased onto the plate.
        const rawBounds = meshDataBounds(parsed.mesh);
        const footprint = Math.max(
          rawBounds.max.x - rawBounds.min.x,
          rawBounds.max.y - rawBounds.min.y
        );
        if (!(footprint > 0)) {
          throw new AiError("המודל שהתקבל מהספק ריק — נסו תמונה אחרת");
        }
        const scale = targetSizeMm / footprint;
        const scaled = transformMeshData(
          parsed.mesh,
          new THREE.Matrix4().makeScale(scale, scale, scale)
        );
        const bounds = meshDataBounds(scaled);
        const rebased = transformMeshData(
          scaled,
          new THREE.Matrix4().makeTranslation(
            -(bounds.min.x + bounds.max.x) / 2,
            -(bounds.min.y + bounds.max.y) / 2,
            -bounds.min.z
          )
        );

        // 3. Staged repair pipeline (voxel remesh fallback), off-thread.
        const { result: repair } = await runGeometryJob(
          "repairMesh",
          { mesh: rebased, options: {} },
          {
            signal: controller.signal,
            onProgress: (fraction, stageHe) => stage(0.8 + fraction * 0.14, stageHe),
          }
        );
        if (!repair.succeeded || !repair.mesh) {
          // The report names the stage that failed; pass it through honestly.
          throw new AiError(`המודל שהתקבל לא ניתן לתיקון: ${repair.messageHe}`);
        }
        if (repair.stages.some((s) => s.changed)) {
          noticesHe.push(repair.messageHe);
        }

        // 4. Triangle budget (auto-simplify above 250K, with the honest cap
        //    notice when simplification could not run).
        stage(0.95, "בודק תקציב משולשים…");
        const kernel = await getGeometryKernel();
        const budgeted = await applyImportTriangleBudget(kernel, repair.mesh);
        if (budgeted.noticeHe) noticesHe.push(budgeted.noticeHe);
        if (controller.signal.aborted) return;

        // 5. Into the document as a mesh layer — the document as it is NOW,
        //    after whatever the user edited while the provider worked.
        const currentDoc = docRef.current;
        const meshId = storeMesh(budgeted.mesh);
        const baseName = stripImageExtension(file.name) || "מודל מתמונה";
        const layer: ImportedMeshLayer = {
          id: newId("layer"),
          type: "importedMesh",
          name: `${baseName} (ענן)`,
          visible: true,
          locked: false,
          materialSlotId: primaryMaterialSlotId(currentDoc),
          transform: {
            x: 0, y: 0, z: 0,
            rotationX: 0, rotationY: 0, rotationZ: 0,
            scaleX: 1, scaleY: 1, scaleZ: 1,
          },
          previewOpacity: 1,
          meshId,
          // "stlImport" is the kind the design-file sanitizer stores, so the
          // layer survives a save/load round trip unchanged.
          provenance: {
            kind: "stlImport",
            fileName: `${baseName}.obj`,
            descriptionHe: `נוצר מתמונה בשירות ענן (${providerNameHe})`,
          },
          originalMeshId: meshId,
          combine: "standalone",
        };
        applyDocument(
          { ...currentDoc, layers: [...currentDoc.layers, layer] },
          "מודל מתמונה (ענן)"
        );
        dispatch({ type: "ui/select", selection: [layer.id] });

        // 6. Printability analysis, as soon as the rebuild lands.
        requestAutoAnalysis();

        noticesHe.unshift(
          `המודל נוצר בשירות ${providerNameHe} וגודלו נקבע ל-${targetSizeMm} מ״מ ` +
            `בצידו הארוך (לספק אין קנה מידה פיזי). צבעים ומרקמים אינם מיובאים.`
        );
        setMessage({
          titleHe: "מודל מתמונה (ענן) — הערות",
          bodyHe: noticesHe.join("\n\n"),
          kind: "info",
        });
      } catch (err) {
        if (
          controller.signal.aborted ||
          err instanceof JobCancelledError ||
          (err instanceof DOMException && err.name === "AbortError")
        ) {
          return; // the user changed their mind — not an error
        }
        showError(err, "יצירת מודל בענן נכשלה");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setProgress(null);
      }
    },
    [dispatch, applyDocument, setMessage, showError, requestAutoAnalysis, providerNameHe]
  );

  /** Entry point from the dialog: consent gate first, then the run. */
  const start = useCallback(
    async (file: File, targetSizeMm: number) => {
      if (!sessionConsentGiven()) {
        setConsentPending({ file, targetSizeMm });
        return;
      }
      await run(file, targetSizeMm);
    },
    [run]
  );

  const approveConsent = useCallback(() => {
    const pending = consentPending;
    setConsentPending(null);
    if (!pending) return;
    rememberSessionConsent();
    void run(pending.file, pending.targetSizeMm);
  }, [consentPending, run]);

  const declineConsent = useCallback(() => {
    // Decline = nothing leaves the device, silently.
    setConsentPending(null);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    availability,
    progress,
    consentPending: consentPending !== null,
    providerNameHe,
    start,
    approveConsent,
    declineConsent,
    cancel,
  };
}
