# V6 Implementation Plan — Waves 1–5

Derived from the five-expert review of V5. The governing findings: the hot
path (document rebuild) still runs on the main thread while the worker covers
only occasional jobs; the viewport pays linear-scan picking and a free-running
frame loop; print output is not slicer-honest about supports, estimates or
assembly structure; and the tool has no batch/automation story despite a real
expression engine.

Two absolute rules inherited from the project charter, restated because every
item below was checked against them:

1. **No AI.** No models, no cloud inference, no ML libraries. Every heuristic
   stays deterministic, transparent and explained to the user in Hebrew.
2. **No user management.** No accounts, no server, no sync, no telemetry.
   All storage is device-local (IndexedDB / files). The README privacy
   statement must remain true word for word.

## Wave 1 — immediate wins

| # | Item | Files | Definition of done |
| --- | --- | --- | --- |
| 1 | BVH-accelerated viewport picking | `lib/geometry/bvh.ts`, `components/viewer/SceneView.tsx` | Triangle tests per pick drop an order of magnitude on a heavy synthetic mesh; pick result identical to three's raycaster |
| 2 | Canvas tuning | `SceneView.tsx` | `frameloop="demand"` + `dpr=[1,2]`; e2e proves the scene visually updates in every tool mode |
| 3 | History depth cap | `lib/history/history.ts`, `components/Editor.tsx` | After 60 ops the depth is bounded at the documented cap and trimmed steps' meshes are actually freed |
| 4 | Close the 9 exhaustive-deps warnings | `hooks/useAnalysisRunner.ts`, `hooks/useImportHandlers.ts` | `npm run lint` returns 0 errors, 0 warnings — no eslint-disable, no removed dep arrays |

## Wave 2 — the hot path

| # | Item | Files | Definition of done |
| --- | --- | --- | --- |
| 5 | buildDocument in a Web Worker | `lib/geometry/jobs/*`, `hooks/useDocumentBuilder.ts` | Identical result on both paths (worker/in-process); e2e proves the UI stays responsive during a heavy build |
| 6 | Incremental per-layer build cache | `lib/geometry/buildDocument.ts` | 10-layer document, one layer change rebuilds one layer; final result identical to a full build |
| 7 | Remaining heavy ops through the registry | `lib/geometry/jobs/registry.ts`, callers | Per job: identical result on both paths + cancellation actually stops it |
| 8 | WASM memory scope enforcement | `lib/geometry/kernel.ts`, hot call sites | Live-solid count before/after a 20-boolean pipeline shows zero leaks |
| 9 | Benchmark suite + performance budget | `bench/` | Benchmarks report numbers and fail above named thresholds |

## Wave 3 — printing and slicer compatibility

| # | Item | Files | Definition of done |
| --- | --- | --- | --- |
| 10 | Mark supports as supports in 3MF | `lib/export/threeMF.ts` | Generated XML marks support parts distinct from model parts |
| 11 | Realistic time/cost estimate | `lib/geometry/analysis/estimate*.ts` | Analytic cases (solid cube, thin wide plate, hollow cylinder) — new model closer than old |
| 12 | Warping analysis + brim/raft | `lib/geometry/analysis/warping.ts`, generator | Geometric tests on brim area / raft height; analysis flags a thin wide plate and not a cube |
| 13 | 3MF production structure | `lib/export/threeMF.ts` | Component hierarchy, stable IDs, build transforms; existing 3MF tests stay green |

## Wave 4 — automation and production

| # | Item | Files | Definition of done |
| --- | --- | --- | --- |
| 14 | Headless batch CLI | `cli/` | 5-row CSV → 5 watertight parts in the archive with correct per-row dimensions |
| 15 | Better plate arrangement | `lib/geometry/analysis/collision.ts` | Better utilisation on elongated parts; determinism test stays green |
| 16 | Local design library with versions | `lib/serialization/designLibrary.ts`, UI | e2e: save, refresh, load, revert to a version, delete everything |

## Wave 5 — editing and UI

| # | Item | Files | Definition of done |
| --- | --- | --- | --- |
| 17 | Edit-resilient face paint | `lib/geometry/painting.ts` | Paint a body, reshape it, paint survives in the right region; split tests stay green |
| 18 | 3D-tool keyboard shortcuts | `components/Editor.tsx`, new keymap module | F/Ctrl+D/Ctrl+A/numeric views, editable persisted mapping, help screen; e2e per new shortcut |
| 19 | Responsive layout + touch | `components/**` | e2e at phone and tablet viewports on core journeys; RTL start-/end- only |
| 20 | Local fillet on a selected region | `lib/geometry/selection/*`, `operations/fillet.ts` | Selected region rounded, other edges untouched, watertight — or a reasoned failure report |

## Verification standard

Same as V5: every item ships with tests that assert a measurable consequence —
geometry against analytic values, or a real browser journey. A test that
verifies a call happened does not count. `npm test`, `npm run lint`,
`npm run typecheck` and `npm run build` must pass after every item;
`npm run test:e2e` at the end of every wave.

## Outcome

All twenty items are implemented and each landed as its own commit with
tests that measure results. Verification at the end of Wave 5: 482 unit
tests across 39 files, 26 Playwright journeys, `eslint` clean (0 errors,
0 warnings), `tsc --noEmit` clean, `next build` clean, plus the separate
`npm run bench` performance budgets. The places where the result differs
from the plan, recorded rather than quietly dropped:

- **The review document itself was missing.** The plan named
  `docs/EXPERT-REVIEW-V5.md` as an input; it does not exist in the
  repository. The findings embedded in the work order (file references
  included) were used as the authoritative source.
- **Item 3 was half-done already.** A history cap existed (100) and so did
  the memory readout; what was genuinely missing was the sweep — nothing
  freed the meshes trimmed entries had referenced. The cap moved to a
  documented 50 and `lib/history/retention.ts` now sweeps on every history
  change, with pending-import meshes protected as extra GC roots.
- **Item 7's "export bake" needed no new job.** World meshes are baked
  inside `buildDocument`, which item 5 already moved to the worker. The
  one export-time kernel task still in-process is the PAINT SPLIT
  (`splitPartsByPaint`): export is a one-shot user action and its meshes
  double as live viewport buffers that must not be transferred. Recorded
  as a residual, not hidden.
- **Worker-path identity is proven in the browser, not in vitest.** vitest
  cannot spawn module workers, so the "identical result on both paths"
  tests execute the exact registry handler in-process; the worker path
  itself is pinned end-to-end by Playwright, including a
  `data-build-ran-on="worker"` assertion that fails the suite on a silent
  fallback to the main thread.
- **Item 11's "closer than the old model" needed a reference.** No slicer
  runs in the test environment, so the reference is a perimeter-aware
  ANALYTIC computation (exact per-layer perimeter/area of a plate,
  hand-derived) sharing the model's speed constants but none of its
  measurement code. The slice measurements themselves are verified against
  closed-form values (cube, plate, hollow cylinder: perimeter 2π(R+r),
  area π(R²−r²)). On the thin-plate case the old model missed the
  reference by ~20%; the new one lands within minutes of it.
- **Item 15 implements 15° candidates, but rectangles use only 0°/90°** —
  by construction: a rotated rectangle's bounding box only grows at
  intermediate angles, and the deterministic (fits, depth, width, angle)
  ordering never picks a worse box. Real convex hulls do use the finer
  steps (the diagonal-rod test chooses 135°).
- **Item 18's F frames by pan + distance fit** along the current viewing
  direction (radius-based), not a full aspect-aware zoom-to-fit. En route
  it exposed and fixed a real bug: multi-select Delete looped the
  single-delete handler over the same stale document, so only the last
  deletion survived.
- **Item 20 SHIPPED — the feasibility risk resolved in favour.** Because
  the workaround composes only Manifold booleans (round a whole-body
  duplicate, intersect with a zone box, union with the original outside
  the zone), the result is watertight by construction. The feared seam
  exists but as a small COSMETIC step where a rounded edge crosses the
  zone boundary — named in the tooltip, the panel text and the operation's
  warnings — and a validity gate (kernel status + volume-delta bound)
  refuses anything worse rather than saving it.
- **Item 16 has no unit tests, by environment.** vitest's node environment
  has no IndexedDB; the DoD journey (save → reload the page → load →
  revert to version 1 → delete everything) runs in a real browser instead,
  asserting geometry consequences at every step.
- **The README privacy paragraph was reworded, because item 16 made the
  old wording false.** "No persistence" stopped being literally true the
  moment the local design library existed. The paragraph now promises what
  is actually kept: no AI, no server, no accounts, no sync — every byte on
  this device, switchable off and wipeable. Substance preserved, wording
  honest.
- **One new dev dependency**: `tsx`, to run the batch CLI as TypeScript.
  It is a build-time tool only; nothing ships to the browser.
