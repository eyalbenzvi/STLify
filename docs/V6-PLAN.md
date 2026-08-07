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

(Recorded as work progresses; completed at the end.)
