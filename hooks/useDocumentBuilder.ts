"use client";

/**
 * Rebuilds the printable parts whenever the design document changes
 * (debounced). Stale results are discarded by generation counter and
 * replaced three.js geometries are disposed. Parameter validation runs
 * first — blocking errors skip the geometry build entirely (V2 behaviour).
 *
 * V6: the build itself runs through the geometry job registry, so in a
 * browser it executes in the Web Worker (progress + cancellation included)
 * and the main thread keeps painting. Where a worker cannot exist the same
 * code runs in-process and `ranOn` says so honestly. A superseded build is
 * actively CANCELLED (not merely ignored) so the worker stops burning CPU
 * on a document the user already edited past.
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { DesignDocument } from "@/types/design";
import type { DocumentBuildResult, PrintablePart } from "@/lib/geometry/buildDocument";
import { buildDocumentViaJob } from "@/lib/geometry/jobs/buildDocumentClient";
import { JobCancelledError } from "@/lib/geometry/jobs/registry";
import { validateDocument } from "@/lib/geometry/documentValidation";
import { meshDataToGeometry } from "@/lib/geometry/meshData";
import type { ValidationResult } from "@/lib/geometry/types";

export type DocumentBuildStatus = "idle" | "building" | "ok" | "invalid" | "error" | "empty";

export interface BuiltPart extends PrintablePart {
  geometry: THREE.BufferGeometry;
}

export interface BuildProgress {
  fraction: number;
  labelHe: string;
}

export interface DocumentBuilderState {
  status: DocumentBuildStatus;
  parts: BuiltPart[];
  buildResult: DocumentBuildResult | null;
  validation: ValidationResult;
  /** Monotonic id of the last completed build (analysis cache key). */
  buildId: number;
  /** Live progress of the build in flight, when one is. */
  progress: BuildProgress | null;
  /** Where the LAST COMPLETED build ran — honest, never assumed. */
  ranOn: "worker" | "main" | null;
}

const DEBOUNCE_MS = 250;

export function useDocumentBuilder(document: DesignDocument): DocumentBuilderState {
  const [state, setState] = useState<DocumentBuilderState>({
    status: "idle",
    parts: [],
    buildResult: null,
    validation: { ok: true, issues: [] },
    buildId: 0,
    progress: null,
    ranOn: null,
  });
  const generationRef = useRef(0);
  const livePartsRef = useRef<BuiltPart[]>([]);

  // Flip to "building" the moment the document changes (state adjustment
  // derived from a prop change, done during render — no effect cascade).
  const [lastDocument, setLastDocument] = useState<DesignDocument | null>(null);
  if (document !== lastDocument) {
    setLastDocument(document);
    setState((prev) => (prev.status === "building" ? prev : { ...prev, status: "building" }));
  }

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();

    const timer = setTimeout(() => {
      const validation = validateDocument(document);
      if (!validation.ok) {
        if (generation !== generationRef.current) return;
        setState((prev) => ({
          ...prev,
          status: "invalid",
          validation,
          progress: null,
        }));
        return;
      }
      buildDocumentViaJob(document, {
        signal: controller.signal,
        onProgress: (fraction, labelHe) => {
          if (generation !== generationRef.current) return;
          setState((prev) =>
            prev.status === "building" ? { ...prev, progress: { fraction, labelHe } } : prev
          );
        },
      })
        .then(({ result, ranOn }) => {
          if (generation !== generationRef.current) return;
          const parts: BuiltPart[] = result.parts.map((part) => ({
            ...part,
            geometry: meshDataToGeometry(part.localMesh),
          }));
          for (const old of livePartsRef.current) old.geometry.dispose();
          livePartsRef.current = parts;
          setState((prev) => ({
            status:
              result.status === "ok" ? "ok" : result.status === "empty" ? "empty" : "error",
            parts,
            buildResult: result,
            validation,
            buildId: prev.buildId + 1,
            progress: null,
            ranOn,
          }));
        })
        // buildDocument catches per-layer and per-body failures itself, so a
        // rejection here means the pipeline broke in a way it did not expect.
        // Without this the editor simply stayed on "building" forever and the
        // only trace was an unhandled rejection in the console.
        .catch((err: unknown) => {
          // A cancelled build was superseded on purpose; the newer build owns
          // the state now.
          if (err instanceof JobCancelledError) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (generation !== generationRef.current) return;
          setState((prev) => ({
            ...prev,
            status: "error",
            buildResult: {
              status: "error",
              parts: [],
              issues: [
                {
                  code: "document/build-crashed",
                  severity: "critical",
                  titleHe: "בניית המודל נעצרה בשגיאה",
                  detailHe: err instanceof Error ? err.message : String(err),
                  actionHe: "בטלו את הפעולה האחרונה או שנו את הפרמטרים",
                },
              ],
            },
            validation,
            progress: null,
          }));
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      // Stop the superseded build where it is (the worker checks between
      // layers) rather than letting it run to completion and be discarded.
      controller.abort();
    };
  }, [document]);

  useEffect(() => {
    return () => {
      for (const part of livePartsRef.current) part.geometry.dispose();
      livePartsRef.current = [];
    };
  }, []);

  return state;
}
