/**
 * Scoped lifetime management for kernel solids.
 *
 * The kernel contract (kernel.ts) — "an operation consumes its inputs; call
 * dispose() on whatever you abandon" — was enforced by human discipline
 * across dozens of call sites. This wrapper makes the discipline structural:
 * every solid registered with `scope.track()` is disposed when the block
 * exits, on success and on throw alike.
 *
 * The pattern is safe BECAUSE dispose() is idempotent (kernel.ts marks a
 * handle dead the moment it is consumed): a tracked solid that was later
 * consumed by a boolean is simply skipped by the final sweep — no
 * double-free is possible. Whatever must outlive the block passes through
 * `scope.keep()`.
 *
 *   const layer = await withSolidScope(async (scope) => {
 *     const a = scope.track(await materialize(...));
 *     const b = scope.track(kernel.sphere(2));
 *     const result = scope.track(a.union(b));       // consumed a and b
 *     hooks.throwIfCancelled?.();                    // throw ⇒ all freed
 *     return scope.keep(result);                     // escapes the scope
 *   });
 */

import type { Solid } from "./kernel";

export interface SolidScope {
  /** Register a solid for automatic disposal when the scope exits. */
  track<S extends Solid>(solid: S): S;
  /** Register a possibly-null solid (materializers may return null). */
  trackMaybe<S extends Solid | null>(solid: S): S;
  /** Un-register a solid so it survives the scope (the escape hatch). */
  keep<S extends Solid>(solid: S): S;
}

function makeScope(): { scope: SolidScope; sweep: () => void } {
  const tracked = new Set<Solid>();
  return {
    scope: {
      track(solid) {
        tracked.add(solid);
        return solid;
      },
      trackMaybe(solid) {
        if (solid) tracked.add(solid);
        return solid;
      },
      keep(solid) {
        tracked.delete(solid);
        return solid;
      },
    },
    // dispose() is idempotent, so consumed handles are safe to sweep.
    sweep: () => {
      for (const solid of tracked) solid.dispose();
    },
  };
}

/**
 * Run `fn` with a scope; dispose everything still tracked when it settles.
 * The return value is awaited, so async callbacks are covered.
 */
export async function withSolidScope<T>(
  fn: (scope: SolidScope) => T | Promise<T>
): Promise<T> {
  const { scope, sweep } = makeScope();
  try {
    return await fn(scope);
  } finally {
    sweep();
  }
}

/** Synchronous variant for code paths that never await. */
export function withSolidScopeSync<T>(fn: (scope: SolidScope) => T): T {
  const { scope, sweep } = makeScope();
  try {
    return fn(scope);
  } finally {
    sweep();
  }
}
