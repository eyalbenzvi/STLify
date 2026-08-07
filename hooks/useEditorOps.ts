"use client";

/**
 * The plumbing every editor operation shares.
 *
 * Almost every handler in the editor does the same four things: put the app
 * in a busy state, run some geometry, turn whatever came back into a new
 * document, and report failure in Hebrew. Those four lived as loose
 * closures inside the editor component, which is why every operation had to
 * live there too. Passing this object instead lets each family of
 * operations move into its own hook.
 */

import { useCallback, useMemo, type Dispatch } from "react";
import type {
  DesignDocument,
  DesignLayer,
  Transform3D,
} from "@/types/design";
import type { EditorAction } from "@/components/editor/store";
import type { OpMessage } from "@/components/dialogs/OperationDialogs";
import { OpError } from "@/lib/geometry/operations/layerOps";
import { GeneratorError } from "@/lib/geometry/generators";
import { PatternError } from "@/lib/geometry/operations/pattern";
import { StlImportError } from "@/lib/import/stl";
import { SvgImportError } from "@/lib/import/svg";
import { ImageImportError } from "@/lib/import/image";
import { DesignFileError } from "@/lib/serialization/designFile";

/** What happens to the layers an operation consumed. */
export type SourceDisposition = "keep" | "hide" | "replace";

export interface EditorOps {
  document: DesignDocument;
  dispatch: Dispatch<EditorAction>;
  /** Commit a whole new document as one undoable step. */
  applyDocument: (next: DesignDocument, labelHe: string) => void;
  /** Patch a single layer as one undoable step. */
  updateLayer: (
    layerId: string,
    patch: Partial<DesignLayer>,
    labelHe: string
  ) => void;
  /** Move one layer, as its own undo step. */
  commitTransform: (layerId: string, transform: Transform3D) => void;
  /** Show a dialog. */
  showMessage: (message: OpMessage) => void;
  /** Show a failure, unwrapping the Hebrew message our error types carry. */
  showError: (error: unknown, titleHe: string) => void;
  /** Run async geometry work with a busy indicator and an error dialog. */
  runOp: (labelHe: string, fn: () => Promise<void>) => Promise<void>;
  /**
   * Commit the outcome of an operation that produced replacement layers:
   * add the results, dispose of the sources, select the results, and report
   * any warnings.
   */
  applyOpResult: (
    labelHe: string,
    newLayers: DesignLayer[],
    sourceIds: string[],
    sources: SourceDisposition,
    warningsHe?: string[]
  ) => void;
}

/** Error types that carry a user-facing Hebrew message of their own. */
function hebrewMessageOf(error: unknown): string | null {
  if (
    error instanceof OpError ||
    error instanceof StlImportError ||
    error instanceof SvgImportError ||
    error instanceof ImageImportError ||
    error instanceof DesignFileError ||
    error instanceof GeneratorError ||
    error instanceof PatternError
  ) {
    return error.messageHe;
  }
  return null;
}

export function useEditorOps({
  document,
  dispatch,
  setMessage,
}: {
  document: DesignDocument;
  dispatch: Dispatch<EditorAction>;
  setMessage: (message: OpMessage | null) => void;
}): EditorOps {
  const applyDocument = useCallback(
    (next: DesignDocument, labelHe: string) =>
      dispatch({ type: "document/apply", document: next, labelHe }),
    [dispatch]
  );

  const updateLayer = useCallback(
    (layerId: string, patch: Partial<DesignLayer>, labelHe: string) =>
      dispatch({ type: "layer/update", layerId, patch, labelHe }),
    [dispatch]
  );

  const commitTransform = useCallback(
    (layerId: string, transform: Transform3D) =>
      dispatch({ type: "layer/setTransform", layerId, transform, labelHe: "טרנספורמציה" }),
    [dispatch]
  );

  const showMessage = useCallback(
    (message: OpMessage) => setMessage(message),
    [setMessage]
  );

  const showError = useCallback(
    (error: unknown, titleHe: string) => {
      if (error instanceof OpError) {
        setMessage({
          titleHe,
          bodyHe: error.messageHe,
          suggestionsHe: error.suggestionsHe,
          kind: "error",
        });
        return;
      }
      const hebrew = hebrewMessageOf(error);
      setMessage({
        titleHe,
        bodyHe:
          hebrew ?? (error instanceof Error ? error.message : String(error)),
        kind: "error",
      });
    },
    [setMessage]
  );

  const runOp = useCallback(
    async (labelHe: string, fn: () => Promise<void>) => {
      dispatch({ type: "ui/busyStart", labelHe });
      try {
        await fn();
      } catch (err) {
        showError(err, `${labelHe} — הפעולה נכשלה`);
      } finally {
        dispatch({ type: "ui/busyEnd" });
      }
    },
    [dispatch, showError]
  );

  const applyOpResult = useCallback(
    (
      labelHe: string,
      newLayers: DesignLayer[],
      sourceIds: string[],
      sources: SourceDisposition,
      warningsHe: string[] = []
    ) => {
      const doomed = new Set(sourceIds);
      let layers = document.layers;
      if (sources === "replace") {
        layers = layers.filter((l) => !doomed.has(l.id));
      } else if (sources === "hide") {
        layers = layers.map((l) =>
          doomed.has(l.id) ? ({ ...l, visible: false } as DesignLayer) : l
        );
      }
      applyDocument({ ...document, layers: [...layers, ...newLayers] }, labelHe);
      dispatch({ type: "ui/select", selection: newLayers.map((l) => l.id) });
      if (warningsHe.length > 0) {
        setMessage({
          titleHe: `${labelHe} — הושלם עם הערות`,
          bodyHe: warningsHe.join("\n"),
          kind: "info",
        });
      }
    },
    [document, applyDocument, dispatch, setMessage]
  );

  return useMemo(
    () => ({
      document,
      dispatch,
      applyDocument,
      updateLayer,
      commitTransform,
      showMessage,
      showError,
      runOp,
      applyOpResult,
    }),
    [
      document,
      dispatch,
      applyDocument,
      updateLayer,
      commitTransform,
      showMessage,
      showError,
      runOp,
      applyOpResult,
    ]
  );
}
