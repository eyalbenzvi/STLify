"use client";

/**
 * The in-memory editor store: current design state + selection + undo/redo.
 *
 * Implemented with useSyncExternalStore (no external state library) to match
 * the project's dependency-light approach. All state is session-only; nothing
 * is persisted anywhere.
 */

import { useCallback, useSyncExternalStore } from "react";
import type { DesignDocument, DesignLayer, DesignState } from "@/types/design";
import {
  canRedo,
  canUndo,
  commit,
  emptyHistory,
  redo as historyRedo,
  undo as historyUndo,
  type HistoryStacks,
} from "@/lib/history/history";
import { HISTORY_LIMIT, createBlankState, newId } from "./defaults";

export interface EditorStoreState {
  state: DesignState;
  selectedLayerId: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

let current: DesignState = createBlankState();
let selectedLayerId: string | null = null;
let history: HistoryStacks<DesignState> = emptyHistory();
let snapshot: EditorStoreState = buildSnapshot();

const listeners = new Set<() => void>();

function buildSnapshot(): EditorStoreState {
  return {
    state: current,
    selectedLayerId,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
  };
}

function emit(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): EditorStoreState {
  return snapshot;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface CommitOptions {
  /**
   * Coalescing key: consecutive commits sharing a key within a short window
   * merge into one undo step (slider drags). Null = always a separate step.
   */
  coalesceKey?: string | null;
}

/** Apply an updater to the design state, recording an undo step. */
export function updateState(
  updater: (state: DesignState) => DesignState,
  options: CommitOptions = {}
): void {
  const next = updater(current);
  if (next === current) return;
  history = commit(
    history,
    current,
    options.coalesceKey ?? null,
    Date.now(),
    HISTORY_LIMIT
  );
  current = next;
  emit();
}

export function updateDoc(
  updater: (doc: DesignDocument) => DesignDocument,
  options: CommitOptions = {}
): void {
  updateState((state) => {
    const doc = updater(state.doc);
    return doc === state.doc ? state : { ...state, doc };
  }, options);
}

export function updateLayer<L extends DesignLayer>(
  layerId: string,
  patch: Partial<L>,
  options: CommitOptions = {}
): void {
  updateDoc((doc) => {
    const index = doc.layers.findIndex((l) => l.id === layerId);
    if (index < 0) return doc;
    const layers = [...doc.layers];
    layers[index] = { ...layers[index], ...patch } as DesignLayer;
    return { ...doc, layers };
  }, options);
}

export function addLayer(layer: DesignLayer, select = true): void {
  updateDoc((doc) => ({ ...doc, layers: [...doc.layers, layer] }));
  if (select) selectLayer(layer.id);
}

export function removeLayer(layerId: string): void {
  updateDoc((doc) => {
    const layer = doc.layers.find((l) => l.id === layerId);
    if (!layer || layer.type === "base") return doc;
    return { ...doc, layers: doc.layers.filter((l) => l.id !== layerId) };
  });
  if (selectedLayerId === layerId) selectLayer(null);
}

export function duplicateLayer(layerId: string): void {
  let newLayerId: string | null = null;
  updateDoc((doc) => {
    const index = doc.layers.findIndex((l) => l.id === layerId);
    const layer = doc.layers[index];
    if (!layer || layer.type === "base") return doc;
    const copy = structuredClone(layer);
    copy.id = newId(layer.type);
    copy.name = `${layer.name} (עותק)`;
    copy.transform = { ...copy.transform, x: copy.transform.x + 5, y: copy.transform.y - 5 };
    newLayerId = copy.id;
    const layers = [...doc.layers];
    layers.splice(index + 1, 0, copy);
    return { ...doc, layers };
  });
  if (newLayerId) selectLayer(newLayerId);
}

/** Move a layer up/down in the list. The base layer (index 0) never moves. */
export function moveLayer(layerId: string, direction: 1 | -1): void {
  updateDoc((doc) => {
    const index = doc.layers.findIndex((l) => l.id === layerId);
    const target = index + direction;
    if (index <= 0 || target <= 0 || target >= doc.layers.length) return doc;
    const layers = [...doc.layers];
    const [layer] = layers.splice(index, 1);
    layers.splice(target, 0, layer);
    return { ...doc, layers };
  });
}

export function selectLayer(layerId: string | null): void {
  if (selectedLayerId === layerId) return;
  selectedLayerId = layerId;
  emit();
}

export function undo(): void {
  const result = historyUndo(history, current);
  if (!result) return;
  history = result.history;
  current = result.state;
  reconcileSelection();
  emit();
}

export function redo(): void {
  const result = historyRedo(history, current);
  if (!result) return;
  history = result.history;
  current = result.state;
  reconcileSelection();
  emit();
}

/** Replace everything (new design / file open). Clears history + selection. */
export function replaceState(next: DesignState): void {
  current = next;
  history = emptyHistory();
  selectedLayerId = null;
  emit();
}

function reconcileSelection(): void {
  if (selectedLayerId && !current.doc.layers.some((l) => l.id === selectedLayerId)) {
    selectedLayerId = null;
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const serverSnapshot: EditorStoreState = {
  state: createBlankState(),
  selectedLayerId: null,
  canUndo: false,
  canRedo: false,
};

export function useEditorStore(): EditorStoreState {
  return useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
}

export function useSelectedLayer(): DesignLayer | null {
  const store = useEditorStore();
  return (
    store.state.doc.layers.find((l) => l.id === store.selectedLayerId) ?? null
  );
}

/** Stable convenience patcher bound to one layer id. */
export function useLayerPatcher<L extends DesignLayer>(layerId: string) {
  return useCallback(
    (patch: Partial<L>, coalesceKey?: string) =>
      updateLayer<L>(layerId, patch, { coalesceKey: coalesceKey ?? null }),
    [layerId]
  );
}
