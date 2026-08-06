import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  COALESCE_WINDOW_MS,
  commit,
  emptyHistory,
  redo,
  undo,
} from "../history";

describe("history stacks", () => {
  it("starts empty", () => {
    const h = emptyHistory<number>();
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undo(h, 1)).toBeNull();
    expect(redo(h, 1)).toBeNull();
  });

  it("commits push the current state and clear the future", () => {
    let h = emptyHistory<number>();
    h = commit(h, 1, null, 1000, 50);
    h = commit(h, 2, null, 2000, 50);
    expect(h.past).toEqual([1, 2]);

    const undone = undo(h, 3);
    expect(undone).not.toBeNull();
    expect(undone!.state).toBe(2);
    expect(undone!.history.future).toEqual([3]);

    // A new commit after undo clears redo.
    const afterCommit = commit(undone!.history, 2, null, 3000, 50);
    expect(afterCommit.future).toEqual([]);
  });

  it("undo/redo round-trips", () => {
    let h = emptyHistory<string>();
    h = commit(h, "a", null, 0, 50);
    const u = undo(h, "b")!;
    expect(u.state).toBe("a");
    const r = redo(u.history, "a")!;
    expect(r.state).toBe("b");
    expect(canRedo(r.history)).toBe(false);
    expect(r.history.past).toEqual(["a"]);
  });

  it("coalesces rapid commits sharing a key", () => {
    let h = emptyHistory<number>();
    h = commit(h, 1, "slider", 1000, 50);
    h = commit(h, 2, "slider", 1000 + COALESCE_WINDOW_MS - 1, 50);
    h = commit(h, 3, "slider", 1000 + COALESCE_WINDOW_MS * 2 - 1, 50);
    // First commit recorded; the rapid follow-ups merged into it, then a new
    // window started.
    expect(h.past).toEqual([1, 3]);
  });

  it("does not coalesce across different keys", () => {
    let h = emptyHistory<number>();
    h = commit(h, 1, "a", 1000, 50);
    h = commit(h, 2, "b", 1001, 50);
    expect(h.past).toEqual([1, 2]);
  });

  it("caps the past stack at the limit", () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < 60; i++) {
      h = commit(h, i, null, i * 10_000, 50);
    }
    expect(h.past.length).toBe(50);
    expect(h.past[0]).toBe(10);
    expect(h.past[49]).toBe(59);
  });
});
