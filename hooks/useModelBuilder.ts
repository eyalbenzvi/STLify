"use client";

import { useEffect, useRef, useState } from "react";
import type * as THREE from "three";
import { buildModel } from "@/lib/geometry/buildModel";
import type {
  DesignParams,
  MeshStats,
  ValidationIssue,
} from "@/lib/geometry/types";

export type BuildStatus = "idle" | "building" | "ok" | "invalid" | "error";

export interface ModelBuilderState {
  status: BuildStatus;
  geometry: THREE.BufferGeometry | null;
  stats: MeshStats | null;
  issues: ValidationIssue[];
}

const DEBOUNCE_MS = 250;

/**
 * Rebuilds the model whenever the design parameters change (debounced).
 * Stale results are discarded and replaced geometries are disposed.
 */
export function useModelBuilder(params: DesignParams): ModelBuilderState {
  const [state, setState] = useState<ModelBuilderState>({
    status: "idle",
    geometry: null,
    stats: null,
    issues: [],
  });
  const generationRef = useRef(0);
  const liveGeometryRef = useRef<THREE.BufferGeometry | null>(null);

  useEffect(() => {
    const generation = ++generationRef.current;
    setState((prev) => ({ ...prev, status: "building" }));

    const timer = setTimeout(() => {
      void buildModel(params).then((result) => {
        // Discard stale results (params changed while building).
        if (generation !== generationRef.current) {
          result.geometry?.dispose();
          return;
        }
        if (liveGeometryRef.current && liveGeometryRef.current !== result.geometry) {
          liveGeometryRef.current.dispose();
        }
        liveGeometryRef.current = result.geometry;
        setState({
          status: result.status,
          geometry: result.geometry,
          stats: result.stats,
          issues: result.issues,
        });
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [params]);

  // Dispose the last geometry on unmount.
  useEffect(() => {
    return () => {
      liveGeometryRef.current?.dispose();
      liveGeometryRef.current = null;
    };
  }, []);

  return state;
}
