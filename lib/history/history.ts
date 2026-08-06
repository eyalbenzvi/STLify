/**
 * In-memory undo/redo for design documents. Documents are immutable plain
 * values, so history entries are cheap references (structural sharing).
 * Session-only by design: nothing here is ever persisted.
 */

import type { DesignDocument, EditorHistoryState, HistoryEntry } from "@/types/design";

/** Bounded history depth (memory safety with imported meshes referenced). */
export const HISTORY_CAPACITY = 100;

export function createHistory(document: DesignDocument): EditorHistoryState {
  return {
    past: [],
    present: { document, labelHe: "מצב התחלתי" },
    future: [],
  };
}

/** Record a new state. Clears the redo stack. */
export function pushHistory(
  state: EditorHistoryState,
  document: DesignDocument,
  labelHe: string
): EditorHistoryState {
  const past = [...state.past, state.present];
  if (past.length > HISTORY_CAPACITY) past.shift();
  return { past, present: { document, labelHe }, future: [] };
}

/**
 * Replace the present state without creating an undo step (used for
 * continuous edits like gizmo drags; the drag start pushes one entry).
 */
export function replacePresent(
  state: EditorHistoryState,
  document: DesignDocument,
  labelHe?: string
): EditorHistoryState {
  return {
    ...state,
    present: { document, labelHe: labelHe ?? state.present.labelHe },
  };
}

export function canUndo(state: EditorHistoryState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: EditorHistoryState): boolean {
  return state.future.length > 0;
}

export function undo(state: EditorHistoryState): EditorHistoryState {
  if (state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1];
  return {
    past: state.past.slice(0, -1),
    present: previous,
    future: [state.present, ...state.future],
  };
}

export function redo(state: EditorHistoryState): EditorHistoryState {
  if (state.future.length === 0) return state;
  const [next, ...rest] = state.future;
  return {
    past: [...state.past, state.present],
    present: next,
    future: rest,
  };
}

/** All mesh ids referenced anywhere in history (for mesh-store GC). */
export function referencedMeshIds(state: EditorHistoryState): Set<string> {
  const ids = new Set<string>();
  const collect = (entry: HistoryEntry) => {
    for (const layer of entry.document.layers) {
      if (layer.type === "importedMesh") {
        ids.add(layer.meshId);
        if (layer.originalMeshId) ids.add(layer.originalMeshId);
      } else if (layer.type === "imageRelief" && layer.meshId) {
        ids.add(layer.meshId);
      }
    }
  };
  state.past.forEach(collect);
  collect(state.present);
  state.future.forEach(collect);
  return ids;
}
