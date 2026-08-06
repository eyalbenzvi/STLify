"use client";

/**
 * Rebuilds the V2 multi-part model whenever the design state changes
 * (debounced). Stale results are discarded and replaced geometries disposed.
 */

import { useEffect, useRef, useState } from "react";
import type { DesignState } from "@/types/design";
import { buildDesignParts, type BuildDesignResult, type BuiltPart } from "@/lib/geometry/buildDesign";
import { resolveAsset } from "@/lib/design/assetResolver";

export type DesignBuildStatus = "idle" | "building" | "ok" | "invalid" | "error";

export interface DesignBuilderState {
  status: DesignBuildStatus;
  result: BuildDesignResult | null;
  /** Convenience: parts of the latest successful build. */
  parts: BuiltPart[];
}

const DEBOUNCE_MS = 300;

function disposeParts(parts: BuiltPart[]): void {
  for (const part of parts) part.geometry.dispose();
}

export function useDesignBuilder(state: DesignState): DesignBuilderState {
  const [builder, setBuilder] = useState<DesignBuilderState>({
    status: "idle",
    result: null,
    parts: [],
  });
  const generationRef = useRef(0);
  const livePartsRef = useRef<BuiltPart[]>([]);

  useEffect(() => {
    const generation = ++generationRef.current;

    const timer = setTimeout(() => {
      setBuilder((prev) =>
        prev.status === "building" ? prev : { ...prev, status: "building" }
      );
      void buildDesignParts(state, { assetResolver: resolveAsset }).then((result) => {
        if (generation !== generationRef.current) {
          disposeParts(result.parts);
          return;
        }
        disposeParts(livePartsRef.current);
        livePartsRef.current = result.parts;
        setBuilder({
          status: result.status,
          result,
          parts: result.parts,
        });
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    return () => {
      disposeParts(livePartsRef.current);
      livePartsRef.current = [];
    };
  }, []);

  return builder;
}
