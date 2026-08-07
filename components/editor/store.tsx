"use client";

/**
 * Editor state store: the design document (with in-memory undo/redo) plus
 * ephemeral UI state (selection, active tool, snapping, overlays,
 * measurements). Session-only by design — nothing is persisted anywhere.
 */

import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import type {
  DesignDocument,
  DesignLayer,
  EditorHistoryState,
  Measurement,
  Transform3D,
} from "@/types/design";
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redo,
  replacePresent,
  undo,
} from "@/lib/history/history";
import { createTemplateDocument } from "@/lib/geometry/documentTemplates";

export type EditorTool =
  | "select"
  | "translate"
  | "rotate"
  | "scale"
  | "measure"
  | "placeOnSurface"
  | "drainHole";

export type OverlayMode = "none" | "thickness" | "overhang";

export interface SnapSettings {
  enabled: boolean;
  positionMm: number;
  rotationDeg: number;
  scaleStep: number;
}

export interface SectionPlaneState {
  enabled: boolean;
  axis: "x" | "y" | "z";
  offsetMm: number;
  flip: boolean;
}

export interface PrintPreviewState {
  enabled: boolean;
  layerHeightMm: number;
}

export interface EditorUiState {
  selection: string[];
  tool: EditorTool;
  transformSpace: "world" | "local";
  snap: SnapSettings;
  overlay: OverlayMode;
  xray: boolean;
  section: SectionPlaneState;
  printPreview: PrintPreviewState;
  measurements: Measurement[];
  /** Number of geometry operations currently running (busy indicator). */
  busyCount: number;
  busyLabelHe: string | null;
}

export interface EditorState {
  history: EditorHistoryState;
  ui: EditorUiState;
}

export type EditorAction =
  | { type: "document/apply"; document: DesignDocument; labelHe: string; record?: boolean }
  | { type: "document/replaceTransient"; document: DesignDocument }
  | { type: "layer/update"; layerId: string; patch: Partial<DesignLayer>; labelHe: string; record?: boolean }
  | { type: "layer/setTransform"; layerId: string; transform: Transform3D; labelHe: string; record?: boolean }
  | { type: "history/undo" }
  | { type: "history/redo" }
  /** Jump N steps back (negative) or forward (positive) in one action. */
  | { type: "history/jump"; delta: number }
  | { type: "ui/select"; selection: string[] }
  | { type: "ui/setTool"; tool: EditorTool }
  | { type: "ui/setTransformSpace"; space: "world" | "local" }
  | { type: "ui/setSnap"; snap: Partial<SnapSettings> }
  | { type: "ui/setOverlay"; overlay: OverlayMode }
  | { type: "ui/setXray"; xray: boolean }
  | { type: "ui/setSection"; section: Partial<SectionPlaneState> }
  | { type: "ui/setPrintPreview"; preview: Partial<PrintPreviewState> }
  | { type: "ui/addMeasurement"; measurement: Measurement }
  | { type: "ui/removeMeasurement"; id: string }
  | { type: "ui/clearMeasurements" }
  | { type: "ui/busyStart"; labelHe: string }
  | { type: "ui/busyEnd" };

const initialUi: EditorUiState = {
  selection: [],
  tool: "select",
  transformSpace: "world",
  snap: { enabled: false, positionMm: 1, rotationDeg: 15, scaleStep: 0.1 },
  overlay: "none",
  xray: false,
  section: { enabled: false, axis: "z", offsetMm: 5, flip: false },
  printPreview: { enabled: false, layerHeightMm: 0.2 },
  measurements: [],
  busyCount: 0,
  busyLabelHe: null,
};

function updateLayerInDocument(
  document: DesignDocument,
  layerId: string,
  patch: Partial<DesignLayer>
): DesignDocument {
  return {
    ...document,
    layers: document.layers.map((layer) =>
      layer.id === layerId ? ({ ...layer, ...patch } as DesignLayer) : layer
    ),
  };
}

function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "document/apply": {
      const history =
        action.record === false
          ? replacePresent(state.history, action.document, action.labelHe)
          : pushHistory(state.history, action.document, action.labelHe);
      // Drop selection entries that no longer exist.
      const ids = new Set(action.document.layers.map((l) => l.id));
      const selection = state.ui.selection.filter((id) => ids.has(id));
      return { history, ui: { ...state.ui, selection } };
    }
    case "document/replaceTransient":
      return { ...state, history: replacePresent(state.history, action.document) };
    case "layer/update": {
      const document = updateLayerInDocument(
        state.history.present.document,
        action.layerId,
        action.patch
      );
      const history =
        action.record === false
          ? replacePresent(state.history, document, action.labelHe)
          : pushHistory(state.history, document, action.labelHe);
      return { ...state, history };
    }
    case "layer/setTransform": {
      const document = updateLayerInDocument(
        state.history.present.document,
        action.layerId,
        { transform: action.transform }
      );
      const history =
        action.record === false
          ? replacePresent(state.history, document, action.labelHe)
          : pushHistory(state.history, document, action.labelHe);
      return { ...state, history };
    }
    case "history/undo": {
      const history = undo(state.history);
      const ids = new Set(history.present.document.layers.map((l) => l.id));
      return {
        history,
        ui: { ...state.ui, selection: state.ui.selection.filter((id) => ids.has(id)) },
      };
    }
    case "history/jump": {
      // Repeated undo/redo rather than index surgery: `undo` and `redo`
      // already maintain the past/present/future invariants, and a jump is
      // just several of them. Clamped by canUndo/canRedo so an out-of-range
      // delta lands on the nearest reachable state instead of throwing.
      let history = state.history;
      let remaining = Math.abs(action.delta);
      const step = action.delta < 0 ? undo : redo;
      const canStep = action.delta < 0 ? canUndo : canRedo;
      while (remaining > 0 && canStep(history)) {
        history = step(history);
        remaining--;
      }
      const ids = new Set(history.present.document.layers.map((l) => l.id));
      return {
        history,
        ui: { ...state.ui, selection: state.ui.selection.filter((id) => ids.has(id)) },
      };
    }

    case "history/redo": {
      const history = redo(state.history);
      const ids = new Set(history.present.document.layers.map((l) => l.id));
      return {
        history,
        ui: { ...state.ui, selection: state.ui.selection.filter((id) => ids.has(id)) },
      };
    }
    case "ui/select":
      return { ...state, ui: { ...state.ui, selection: action.selection } };
    case "ui/setTool":
      return { ...state, ui: { ...state.ui, tool: action.tool } };
    case "ui/setTransformSpace":
      return { ...state, ui: { ...state.ui, transformSpace: action.space } };
    case "ui/setSnap":
      return { ...state, ui: { ...state.ui, snap: { ...state.ui.snap, ...action.snap } } };
    case "ui/setOverlay":
      return { ...state, ui: { ...state.ui, overlay: action.overlay } };
    case "ui/setXray":
      return { ...state, ui: { ...state.ui, xray: action.xray } };
    case "ui/setSection":
      return {
        ...state,
        ui: { ...state.ui, section: { ...state.ui.section, ...action.section } },
      };
    case "ui/setPrintPreview":
      return {
        ...state,
        ui: {
          ...state.ui,
          printPreview: { ...state.ui.printPreview, ...action.preview },
        },
      };
    case "ui/addMeasurement":
      return {
        ...state,
        ui: { ...state.ui, measurements: [...state.ui.measurements, action.measurement] },
      };
    case "ui/removeMeasurement":
      return {
        ...state,
        ui: {
          ...state.ui,
          measurements: state.ui.measurements.filter((m) => m.id !== action.id),
        },
      };
    case "ui/clearMeasurements":
      return { ...state, ui: { ...state.ui, measurements: [] } };
    case "ui/busyStart":
      return {
        ...state,
        ui: { ...state.ui, busyCount: state.ui.busyCount + 1, busyLabelHe: action.labelHe },
      };
    case "ui/busyEnd": {
      const busyCount = Math.max(0, state.ui.busyCount - 1);
      return {
        ...state,
        ui: { ...state.ui, busyCount, busyLabelHe: busyCount === 0 ? null : state.ui.busyLabelHe },
      };
    }
  }
}

export interface EditorStore {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  document: DesignDocument;
  selection: string[];
  selectedLayers: DesignLayer[];
  canUndo: boolean;
  canRedo: boolean;
  undoLabelHe: string | null;
}

const EditorContext = createContext<EditorStore | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    history: createHistory(createTemplateDocument("namePlate")),
    ui: initialUi,
  }));

  const store = useMemo<EditorStore>(() => {
    const document = state.history.present.document;
    const selectedLayers = document.layers.filter((l) =>
      state.ui.selection.includes(l.id)
    );
    return {
      state,
      dispatch,
      document,
      selection: state.ui.selection,
      selectedLayers,
      canUndo: canUndo(state.history),
      canRedo: canRedo(state.history),
      undoLabelHe: canUndo(state.history) ? state.history.present.labelHe : null,
    };
  }, [state]);

  return <EditorContext.Provider value={store}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorStore {
  const store = useContext(EditorContext);
  if (!store) throw new Error("useEditor must be used inside EditorProvider");
  return store;
}
