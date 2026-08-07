"use client";

/**
 * Print aids and plate-level checks: supports, brim, raft, bridging,
 * warping and auto-arrange.
 *
 * What ties these together is their SCOPE. Each one acts on the selected
 * parts, or on the whole plate when nothing is selected, and each reports
 * per part by name — a verdict computed from one body out of five reads as
 * a verdict on the print, which is how this family got its bugs the first
 * time round.
 */

import { useCallback, useMemo } from "react";
import type { DesignLayer } from "@/types/design";
import { primaryMaterialSlotId } from "@/types/design";
import { getPrintabilityProfile, type PrinterProfile } from "@/types/profiles";
import type { BuiltPart } from "@/hooks/useDocumentBuilder";
import type { UseGeometryJobs } from "@/hooks/useGeometryJobs";
import type { EditorOps } from "@/hooks/useEditorOps";
import { getGeometryKernel } from "@/lib/geometry/kernel";
import { generatorToLayer } from "@/lib/geometry/operations/advancedOps";
import { buildBrim, buildRaft } from "@/lib/geometry/operations/brimRaft";
import { arrangePartsOnPlate } from "@/lib/geometry/operations/plateArrange";
import {
  analyzeBridging,
  BRIDGE_FAILURE_THRESHOLD_MM,
  BRIDGE_SAG_THRESHOLD_MM,
  DEFAULT_SUPPORT_SETTINGS,
} from "@/lib/geometry/analysis/supports";
import { analyzeWarping } from "@/lib/geometry/analysis/warping";
import { detectInterference, type InterferenceReport } from "@/lib/geometry/analysis/collision";

const WARPING_RISK_HE = { low: "נמוך", medium: "בינוני", high: "גבוה" } as const;

export interface PrintAidHandlers {
  handleGenerateSupports: () => void;
  handleGenerateBrim: () => void;
  handleGenerateRaft: () => void;
  handleCheckBridging: () => void;
  handleAnalyzeWarping: () => void;
  handleArrangePlate: () => void;
  handleCheckInterference: () => void;
}

export function usePrintAids({
  ops,
  jobs,
  parts,
  selectedParts,
  printer,
  setFocusTarget,
  setInterference,
}: {
  ops: EditorOps;
  jobs: UseGeometryJobs;
  parts: BuiltPart[];
  selectedParts: BuiltPart[];
  printer: PrinterProfile;
  setFocusTarget: (target: { x: number; y: number; z: number }) => void;
  setInterference: (report: InterferenceReport | null) => void;
}): PrintAidHandlers {
  const { document: doc, applyDocument, dispatch, runOp, showMessage } = ops;

  /** The selection, or the whole plate when nothing is selected. */
  const targets = useMemo(
    () => (selectedParts.length > 0 ? selectedParts : parts),
    [selectedParts, parts]
  );

  /**
   * Add generated aid layers in one undoable step, selecting them and
   * reporting one line per part. `patchLayers` lets the raft also lift the
   * parts it sits under, in the SAME history entry — so undo reverts the
   * raft and the lift together.
   */
  const commitAidLayers = useCallback(
    (
      report: { historyLabelHe: string; doneTitleHe: string; emptyTitleHe: string },
      aidLayers: DesignLayer[],
      lines: string[],
      patchLayers: (layers: DesignLayer[]) => DesignLayer[] = (l) => l
    ) => {
      const bodyHe = lines.join("\n");
      if (aidLayers.length === 0) {
        showMessage({ titleHe: report.emptyTitleHe, bodyHe, kind: "info" });
        return;
      }
      applyDocument(
        { ...doc, layers: [...patchLayers(doc.layers), ...aidLayers] },
        report.historyLabelHe
      );
      dispatch({ type: "ui/select", selection: aidLayers.map((l) => l.id) });
      showMessage({ titleHe: report.doneTitleHe, bodyHe, kind: "success" });
    },
    [doc, applyDocument, dispatch, showMessage]
  );

  const handleGenerateSupports = useCallback(() => {
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
      commitAidLayers(
        {
          historyLabelHe: "יצירת תמיכות",
          doneTitleHe: "תמיכות נוצרו",
          emptyTitleHe: "תמיכות",
        },
        layers,
        lines
      );
    });
  }, [targets, doc, runOp, jobs, commitAidLayers]);

  const handleGenerateBrim = useCallback(() => {
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
      commitAidLayers(
        { historyLabelHe: "הוספת Brim", doneTitleHe: "Brim נוסף", emptyTitleHe: "Brim" },
        layers,
        lines
      );
    });
  }, [targets, doc, runOp, commitAidLayers]);

  const handleGenerateRaft = useCallback(() => {
    if (targets.length === 0) return;
    void runOp("הוספת Raft", async () => {
      const kernel = await getGeometryKernel();
      const raftLayers: DesignLayer[] = [];
      const lines: string[] = [];
      const liftByLayerId = new Map<string, number>();

      for (const part of targets) {
        const outcome = await buildRaft(kernel, part.worldMesh);
        lines.push(`${part.nameHe}: ${outcome.summaryHe}`);
        raftLayers.push(
          generatorToLayer(
            outcome.solid,
            `${part.nameHe} — Raft`,
            primaryMaterialSlotId(doc),
            outcome.summaryHe,
            "raftResult"
          )
        );
        liftByLayerId.set(part.primaryLayerId, outcome.liftMm);
      }

      // Two changes in ONE history step: the raft layers appear and each
      // part is lifted onto its raft — undo reverts both together.
      commitAidLayers(
        { historyLabelHe: "הוספת Raft", doneTitleHe: "Raft נוסף", emptyTitleHe: "Raft" },
        raftLayers,
        lines,
        (layers) =>
          layers.map((layer) => {
            const liftMm = liftByLayerId.get(layer.id);
            return liftMm === undefined || layer.locked
              ? layer
              : { ...layer, transform: { ...layer.transform, z: layer.transform.z + liftMm } };
          })
      );
    });
  }, [targets, doc, runOp, commitAidLayers]);

  const handleCheckBridging = useCallback(() => {
    if (targets.length === 0) return;
    void runOp("בדיקת גישורים", async () => {
      const reports = targets.map((part) => ({
        part,
        report: analyzeBridging(part.worldMesh),
      }));
      const worst = reports.reduce((a, b) =>
        b.report.longestMm > a.report.longestMm ? b : a
      );
      const lines = reports.map((r) => `${r.part.nameHe}: ${r.report.summaryHe}`);
      const explanationHe =
        `גישור נדרש כאשר יש חומר ללא תמיכה מתחתיו. עד ${BRIDGE_SAG_THRESHOLD_MM} מ״מ ` +
        `המדפסת מגשרת ללא בעיה; מעל ${BRIDGE_FAILURE_THRESHOLD_MM} מ״מ סביר שהחוט יישבר.`;
      showMessage({
        titleHe: "בדיקת גישורים",
        bodyHe:
          worst.report.spans.length === 0
            ? lines.join("\n")
            : `${lines.join("\n")}\n\n${explanationHe}`,
        kind: worst.report.longestMm > BRIDGE_FAILURE_THRESHOLD_MM ? "error" : "info",
      });
      if (worst.report.spans[0]) setFocusTarget({ ...worst.report.spans[0].center });
    });
  }, [targets, runOp, showMessage, setFocusTarget]);

  const handleAnalyzeWarping = useCallback(() => {
    if (targets.length === 0) return;
    void runOp("ניתוח כיווץ", async () => {
      // Analysed ONCE per part: the summary and the severity both read the
      // same assessment, rather than each running the analysis again.
      const assessments = targets.map((part) => ({
        part,
        assessment: analyzeWarping(part.worldMesh),
      }));
      const sections = assessments.map(({ part, assessment }) => {
        const bullets = assessment.explanationHe.map((line) => `• ${line}`).join("\n");
        return (
          `${part.nameHe}: סיכון ${WARPING_RISK_HE[assessment.riskLevel]} ` +
          `(${assessment.riskScore}/100)\n${bullets}`
        );
      });
      showMessage({
        titleHe: "ניתוח כיווץ (Warping) — היוריסטיקה מוסברת",
        bodyHe: sections.join("\n\n"),
        kind: assessments.some((a) => a.assessment.riskLevel === "high") ? "error" : "info",
      });
    });
  }, [targets, runOp, showMessage]);

  const handleArrangePlate = useCallback(() => {
    const arranged = arrangePartsOnPlate(doc, parts, printer);
    if (!arranged) return;
    applyDocument({ ...doc, layers: arranged.layers }, "סידור אוטומטי על המשטח");
    showMessage({
      titleHe: "סידור אוטומטי",
      bodyHe: arranged.summaryHe,
      kind: arranged.unplacedCount > 0 ? "info" : "success",
    });
  }, [doc, parts, printer, applyDocument, showMessage]);

  const handleCheckInterference = useCallback(() => {
    void runOp("בדיקת חדירה", async () => {
      setInterference(await detectInterference(parts));
    });
  }, [parts, runOp, setInterference]);

  return {
    handleGenerateSupports,
    handleGenerateBrim,
    handleGenerateRaft,
    handleCheckBridging,
    handleAnalyzeWarping,
    handleArrangePlate,
    handleCheckInterference,
  };
}
