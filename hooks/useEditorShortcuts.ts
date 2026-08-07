"use client";

/**
 * Keyboard shortcuts and the camera framing they drive.
 *
 * The bindings themselves live in an editable keymap stored on this device
 * (lib/keyboard/keymap.ts). Two rules are hardcoded on purpose:
 *
 *  - Typing always wins. A form field or contenteditable keeps every key,
 *    so a shortcut can never eat a character the user meant to type.
 *  - Esc is not remappable. A panic key that can be bound into oblivion is
 *    not a panic key.
 */

import { useCallback, useEffect, type Dispatch } from "react";
import type { EditorAction, EditorState } from "@/components/editor/store";
import type { BuiltPart } from "@/hooks/useDocumentBuilder";
import type { EditorOps } from "@/hooks/useEditorOps";
import { actionForEvent, type Keymap } from "@/lib/keyboard/keymap";
import { boundsCenter, boundsRadius, unionBounds } from "@/lib/geometry/bounds";

/** Elements that own every keystroke while focused. */
const TEXT_ENTRY_TAGS = ["INPUT", "TEXTAREA", "SELECT"];

export type ViewPresetKind = "top" | "front" | "side" | "iso";

export interface ViewPreset {
  kind: ViewPresetKind;
  center: { x: number; y: number; z: number };
  radius: number;
  /** Bumped on every request so asking twice re-runs the camera move. */
  nonce: number;
}

export interface FocusTarget {
  x: number;
  y: number;
  z: number;
  fitRadius?: number;
}

export interface EditorShortcuts {
  handleFrameSelection: () => void;
  handleViewPreset: (kind: ViewPresetKind) => void;
  handleSelectAll: () => void;
}

export function useEditorShortcuts({
  ops,
  history,
  keymap,
  dispatch,
  parts,
  selectedParts,
  selectedLayers,
  onDuplicate,
  onShowShortcutHelp,
  setFocusTarget,
  setViewPreset,
}: {
  ops: EditorOps;
  history: EditorState["history"];
  keymap: Keymap;
  dispatch: Dispatch<EditorAction>;
  parts: BuiltPart[];
  selectedParts: BuiltPart[];
  selectedLayers: import("@/types/design").DesignLayer[];
  onDuplicate: () => void;
  onShowShortcutHelp: () => void;
  setFocusTarget: (target: FocusTarget) => void;
  setViewPreset: (update: (previous: ViewPreset | null) => ViewPreset) => void;
}): EditorShortcuts {
  const { applyDocument } = ops;

  /** Bounds of the selection, or of every part when nothing is selected. */
  const selectionFrame = useCallback(() => {
    const framed = selectedParts.length > 0 ? selectedParts : parts;
    const bounds = unionBounds(framed.map((part) => part.stats.bounds));
    if (!bounds) return null;
    return { center: boundsCenter(bounds), radius: boundsRadius(bounds) };
  }, [selectedParts, parts]);

  const handleFrameSelection = useCallback(() => {
    const frame = selectionFrame();
    if (frame) setFocusTarget({ ...frame.center, fitRadius: frame.radius });
  }, [selectionFrame, setFocusTarget]);

  const handleViewPreset = useCallback(
    (kind: ViewPresetKind) => {
      const frame = selectionFrame();
      if (!frame) return;
      setViewPreset((previous) => ({
        kind,
        center: frame.center,
        radius: frame.radius,
        nonce: (previous?.nonce ?? 0) + 1,
      }));
    },
    [selectionFrame, setViewPreset]
  );

  const handleSelectAll = useCallback(() => {
    dispatch({ type: "ui/select", selection: parts.map((p) => p.primaryLayerId) });
  }, [dispatch, parts]);

  /**
   * Delete the whole selection in ONE document update. A per-layer loop
   * over the single-delete handler re-read the SAME stale document each
   * time, so only the last deletion survived.
   */
  const deleteSelection = useCallback(() => {
    const doomed = new Set(selectedLayers.filter((l) => !l.locked).map((l) => l.id));
    if (doomed.size === 0) return;
    const current = history.present.document;
    applyDocument(
      { ...current, layers: current.layers.filter((l) => !doomed.has(l.id)) },
      doomed.size === 1 ? "מחיקת שכבה" : `מחיקת ${doomed.size} שכבות`
    );
  }, [selectedLayers, history, applyDocument]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (TEXT_ENTRY_TAGS.includes(target.tagName) || target.isContentEditable)) {
        return;
      }
      if (e.code === "Escape") {
        dispatch({ type: "ui/setTool", tool: "select" });
        return;
      }
      const action = actionForEvent(e, keymap);
      if (!action) return;

      switch (action) {
        case "undo":
          e.preventDefault();
          dispatch({ type: "history/undo" });
          break;
        case "redo":
          e.preventDefault();
          dispatch({ type: "history/redo" });
          break;
        case "delete":
          deleteSelection();
          break;
        case "toolSelect":
          dispatch({ type: "ui/setTool", tool: "select" });
          break;
        case "toolTranslate":
          dispatch({ type: "ui/setTool", tool: "translate" });
          break;
        case "toolRotate":
          dispatch({ type: "ui/setTool", tool: "rotate" });
          break;
        case "toolScale":
          dispatch({ type: "ui/setTool", tool: "scale" });
          break;
        case "frameSelection":
          handleFrameSelection();
          break;
        case "duplicate":
          e.preventDefault();
          onDuplicate();
          break;
        case "selectAll":
          e.preventDefault();
          handleSelectAll();
          break;
        case "viewTop":
        case "viewFront":
        case "viewSide":
        case "viewIso":
          // The action names are "view" + the preset, so one branch covers
          // all four and adding a fifth view needs no code here.
          handleViewPreset(
            (action.slice("view".length).toLowerCase()) as ViewPresetKind
          );
          break;
        case "shortcutHelp":
          e.preventDefault();
          onShowShortcutHelp();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    dispatch,
    keymap,
    deleteSelection,
    handleFrameSelection,
    handleViewPreset,
    handleSelectAll,
    onDuplicate,
    onShowShortcutHelp,
  ]);

  return { handleFrameSelection, handleViewPreset, handleSelectAll };
}
