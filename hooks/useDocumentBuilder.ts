"use client";

/**
 * Rebuilds the printable parts whenever the design document changes
 * (debounced). Stale results are discarded by generation counter and
 * replaced three.js geometries are disposed. Parameter validation runs
 * first — blocking errors skip the geometry build entirely (V2 behaviour).
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { DesignDocument } from "@/types/design";
import { buildDocument, type DocumentBuildResult, type PrintablePart } from "@/lib/geometry/buildDocument";
import { validateDocument } from "@/lib/geometry/documentValidation";
import { meshDataToGeometry } from "@/lib/geometry/meshData";
import type { ValidationResult } from "@/lib/geometry/types";

export type DocumentBuildStatus = "idle" | "building" | "ok" | "invalid" | "error" | "empty";

export interface BuiltPart extends PrintablePart {
  geometry: THREE.BufferGeometry;
}

export interface DocumentBuilderState {
  status: DocumentBuildStatus;
  parts: BuiltPart[];
  buildResult: DocumentBuildResult | null;
  validation: ValidationResult;
  /** Monotonic id of the last completed build (analysis cache key). */
  buildId: number;
}

const DEBOUNCE_MS = 250;

export function useDocumentBuilder(document: DesignDocument): DocumentBuilderState {
  const [state, setState] = useState<DocumentBuilderState>({
    status: "idle",
    parts: [],
    buildResult: null,
    validation: { ok: true, issues: [] },
    buildId: 0,
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

    const timer = setTimeout(() => {
      const validation = validateDocument(document);
      if (!validation.ok) {
        if (generation !== generationRef.current) return;
        setState((prev) => ({
          ...prev,
          status: "invalid",
          validation,
        }));
        return;
      }
      buildDocument(document).then((result) => {
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
        }));
      })
      // buildDocument catches per-layer and per-body failures itself, so a
      // rejection here means the pipeline broke in a way it did not expect.
      // Without this the editor simply stayed on "building" forever and the
      // only trace was an unhandled rejection in the console.
      .catch((err: unknown) => {
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
        }));
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [document]);

  useEffect(() => {
    return () => {
      for (const part of livePartsRef.current) part.geometry.dispose();
      livePartsRef.current = [];
    };
  }, []);

  return state;
}
