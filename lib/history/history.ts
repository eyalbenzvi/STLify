/**
 * Pure in-memory undo/redo history over immutable snapshots.
 *
 * Session-only by design: the stacks live in memory and are never persisted
 * (no localStorage / IndexedDB / cookies). Rapid consecutive edits that share
 * a coalescing key (e.g. dragging one slider) merge into a single entry.
 */

export interface HistoryStacks<T> {
  past: T[];
  future: T[];
  lastCommitKey: string | null;
  lastCommitAt: number;
}

export const COALESCE_WINDOW_MS = 800;

export function emptyHistory<T>(): HistoryStacks<T> {
  return { past: [], future: [], lastCommitKey: null, lastCommitAt: 0 };
}

/**
 * Record `current` into the past stack before applying a new change.
 * When `key` matches the previous commit within the coalescing window the
 * previous snapshot is kept as-is (the two edits merge into one undo step).
 */
export function commit<T>(
  history: HistoryStacks<T>,
  current: T,
  key: string | null,
  now: number,
  limit: number
): HistoryStacks<T> {
  const coalesce =
    key !== null &&
    key === history.lastCommitKey &&
    now - history.lastCommitAt < COALESCE_WINDOW_MS &&
    history.past.length > 0;

  const past = coalesce ? history.past : [...history.past, current];
  const trimmed = past.length > limit ? past.slice(past.length - limit) : past;
  return { past: trimmed, future: [], lastCommitKey: key, lastCommitAt: now };
}

export function canUndo<T>(history: HistoryStacks<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: HistoryStacks<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(
  history: HistoryStacks<T>,
  current: T
): { history: HistoryStacks<T>; state: T } | null {
  if (history.past.length === 0) return null;
  const state = history.past[history.past.length - 1];
  return {
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, current],
      lastCommitKey: null,
      lastCommitAt: 0,
    },
    state,
  };
}

export function redo<T>(
  history: HistoryStacks<T>,
  current: T
): { history: HistoryStacks<T>; state: T } | null {
  if (history.future.length === 0) return null;
  const state = history.future[history.future.length - 1];
  return {
    history: {
      past: [...history.past, current],
      future: history.future.slice(0, -1),
      lastCommitKey: null,
      lastCommitAt: 0,
    },
    state,
  };
}
