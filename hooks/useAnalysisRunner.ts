"use client";

/**
 * Printability analysis and orientation suggestion.
 *
 * Extracted from Editor.tsx as part of decomposing a 2,800-line component.
 * Analysis is a natural unit: it reads the built parts, produces issues and
 * overlay colours, and writes nothing back into the document except when the
 * user applies a suggested orientation.
 *
 * Behaviour is unchanged — the UI regression suite is what proves it.
 */

import { useCallback, useState } from "react";
import * as THREE from "three";
import type { DesignDocument, ModelIssue, Transform3D } from "@/types/design";
import {
  getPrintabilityProfile,
  MATERIAL_PROFILES,
  USAGE_PROFILES,
  type PrinterProfile,
} from "@/types/profiles";
import type { DocumentBuilderState } from "@/hooks/useDocumentBuilder";
import { runGeometryJob } from "@/lib/geometry/jobs/client";
import { meshDataBounds, transformMeshData } from "@/lib/geometry/meshData";
import type { BuiltPart } from "@/hooks/useDocumentBuilder";
import { matrix4ToTransform, transformToMatrix4 } from "@/lib/geometry/transform";
import {
  analyzeBuildVolume,
  analyzeContact,
  analyzeFloatingParts,
  analyzeOverhangs,
  overhangToVertexColors,
  suggestOrientations,
  thicknessToVertexColors,
  type OrientationCandidate,
} from "@/lib/geometry/analysis";
import { estimateDetailed, type DetailedEstimateResult } from "@/lib/geometry/analysis/estimateDetailed";

/** Everything the analysis runner needs from the editor shell. */
export interface AnalysisContext {
  doc: DesignDocument;
  build: DocumentBuilderState;
  /** Active printer profile — build volume checks need its dimensions. */
  printer: PrinterProfile;
  /** Which overlay is showing, so only the needed colour map is computed. */
  overlay: "none" | "thickness" | "overhang";
  /** Orientation suggestion targets the selection, falling back to part one. */
  selectedParts: BuiltPart[];
  showError: (err: unknown, titleHe: string) => void;
  commitTransform: (layerId: string, transform: Transform3D) => void;
  setAnalysisBusy: (busy: boolean) => void;
  setModelIssues: (issues: ModelIssue[]) => void;
  setOverlayColors: (colors: Map<string, Float32Array>) => void;
  setEstimate: (estimate: DetailedEstimateResult | null) => void;
  setOrientationCandidates: (candidates: OrientationCandidate[] | null) => void;
}

export function useAnalysisRunner(context: AnalysisContext) {
  const {
    doc,
    build,
    printer,
    overlay,
    selectedParts,
    showError,
    commitTransform,
    setAnalysisBusy,
    setModelIssues,
    setOverlayColors,
    setEstimate,
    setOrientationCandidates,
  } = context;


  const runAnalysis = useCallback(() => {
    if (build.parts.length === 0) return;
    setAnalysisBusy(true);
    // Yield to paint the busy state before the synchronous analysis work.
    setTimeout(async () => {
      try {
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

          // Ray-sampled wall thickness is the expensive analysis — it runs
          // as a job (in the worker when one exists). transferables=[]: the
          // worldMesh stays live on this thread for export and later runs.
          let thicknessIssues: ModelIssue[] = [];
          try {
            const { result: thickness } = await runGeometryJob(
              "analyzeThickness",
              { mesh, minWallMm: minWall, minFeatureMm: minFeature },
              { transferables: [] }
            );
            thicknessIssues = thickness.issues;
            colors.set(
              part.primaryLayerId,
              overlay === "overhang"
                ? overhangToVertexColors(mesh, overhang.triangleFlags)
                : thicknessToVertexColors(mesh, thickness, minWall)
            );
          } catch {
            // A body the kernel refuses (non-manifold) simply reports no
            // thickness data — the same silent skip as before V6.
          }

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
  }, [
    build.parts,
    doc,
    printer,
    overlay,
    showError,
    setAnalysisBusy,
    setEstimate,
    setModelIssues,
    setOverlayColors,
  ]);

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
  }, [selectedParts, build.parts, doc, showError, setAnalysisBusy, setOrientationCandidates]);

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
    [selectedParts, build.parts, doc.layers, commitTransform, setOrientationCandidates]
  );

  return { runAnalysis, handleSuggestOrientation, handleApplyOrientation };
}
