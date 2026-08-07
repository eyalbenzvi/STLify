"use client";

/**
 * Keep face paint attached to a body that has been rebuilt.
 *
 * Paint is recorded as triangle indices plus SPATIAL anchors (a centroid, a
 * normal and a radius per painted triangle). Indices are invalidated by any
 * shape change, but the anchors are not — so after each completed build, a
 * layer whose paint no longer matches its body is re-projected onto the new
 * mesh instead of being thrown away.
 *
 * The re-anchoring is a derived value, not an edit: it goes in through
 * `document/replaceTransient`, so it creates no history entry and undo does
 * not have to step over it. Paint written before anchors existed has
 * nothing to re-project from and keeps the old discard-with-warning
 * behaviour.
 */

import { useEffect, type Dispatch } from "react";
import type { EditorAction } from "@/components/editor/store";
import type { DesignDocument } from "@/types/design";
import type { BuiltPart } from "@/hooks/useDocumentBuilder";
import { hasStalePaint, reanchorPaints } from "@/lib/geometry/painting";

export function usePaintReanchor({
  document,
  parts,
  buildId,
  dispatch,
}: {
  /** The committed document — NOT a derived copy, or this would loop. */
  document: DesignDocument;
  parts: BuiltPart[];
  /** Changes once per completed build. */
  buildId: number | string;
  dispatch: Dispatch<EditorAction>;
}): void {
  useEffect(() => {
    if (parts.length === 0) return;
    const partByLayerId = new Map(parts.map((part) => [part.primaryLayerId, part]));
    let changed = false;

    const layers = document.layers.map((layer) => {
      if (!layer.facePaint || layer.facePaint.length === 0) return layer;
      const part = partByLayerId.get(layer.id);
      if (!part) return layer;
      const triangleCount = part.localMesh.indices.length / 3;
      if (!hasStalePaint(layer.facePaint, triangleCount)) return layer;
      const result = reanchorPaints(layer.facePaint, part.localMesh);
      if (result.reanchored === 0 && result.dropped === 0) return layer;
      changed = true;
      return { ...layer, facePaint: result.paints };
    });

    if (changed) {
      dispatch({ type: "document/replaceTransient", document: { ...document, layers } });
    }
  }, [buildId, parts, document, dispatch]);
}
