"use client";

/**
 * Error boundary.
 *
 * Without one, a single throw anywhere in the tree unmounts the whole app and
 * takes the session with it — and this session is not persisted anywhere the
 * user manages. With hours of modelling now possible, a WebGL context loss, a
 * malformed mesh reaching a renderer, or a bug in one panel must not be a
 * total loss.
 *
 * Two deliberate choices:
 *
 *  - The boundary is placed AROUND SUBTREES, not just at the root. A crash in
 *    the 3D canvas leaves the panels (and the export button) alive, so the
 *    user can still save their work.
 *  - "Try again" only resets the boundary. It does not touch the document,
 *    because the document is almost never what crashed and discarding it
 *    would cause the very loss this exists to prevent.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Hebrew name of the area, shown in the fallback. */
  areaHe: string;
  /** Optional extra action, e.g. "download your work". */
  action?: { labelHe: string; onClick: () => void };
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No telemetry: the app has no server and sends nothing anywhere. The
    // console is the only honest place for the stack.
    console.error(`[${this.props.areaHe}] רכיב קרס:`, error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <p className="text-sm font-bold text-red-700">
          אירעה תקלה ב{this.props.areaHe}
        </p>
        <p className="max-w-md text-xs leading-snug text-slate-500">
          שאר חלקי התוכנה ממשיכים לעבוד, והעיצוב שלכם לא נמחק. מומלץ להוריד
          קובץ עיצוב לפני שממשיכים.
        </p>
        <p className="max-w-md break-words rounded bg-slate-50 p-2 text-[11px] text-slate-400" dir="ltr">
          {error.message}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            onClick={this.reset}
          >
            נסה שוב
          </button>
          {this.props.action && (
            <button
              type="button"
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700"
              onClick={this.props.action.onClick}
            >
              {this.props.action.labelHe}
            </button>
          )}
        </div>
      </div>
    );
  }
}
