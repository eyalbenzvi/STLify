# AI Image-to-3D — QA checklist and results

Every user-facing flow and failure path of the AI import work
(docs/AI-IMAGE-PLAN.md), walked with external services mocked at the
boundaries the plan names. Verification legend:

- **e2e** — asserted by a Playwright journey against the production build
  (`e2e/aiImport.spec.ts`, `e2e/imageImport.spec.ts`).
- **unit** — asserted by a vitest case (`lib/ai/__tests__/*`).
- **code** — verified by direct code inspection where automation cannot
  reach (noted with what a manual check would look like).

## Flows

| # | Flow | How | Result |
| --- | --- | --- | --- |
| 1 | Classic image import unchanged (silhouette Otsu/manual, relief, brush, thin-feature thicken) | e2e (`imageImport.spec.ts` unchanged and green), unit (`lib/import/__tests__/image.test.ts` unchanged and green), plus a line review of `handleImageConfirm`: the classic branches execute the same calls in the same order; `pixelSizeMm` moved from `smoothed.width` to `decoded.grid.width`, which are always equal (`smoothGrid` preserves dimensions) | ✅ |
| 2 | AI silhouette toggle on/off | e2e (smart-relief journey asserts the gated confirm); code: `thresholdMode: "ai"` disables confirm until a mask exists, the brush preview shows the run hint, and switching back to auto/manual restores the classic preview untouched | ✅ |
| 3 | Model download notice, progress, cancel | unit (`modelCache.test.ts`: progress ticks, unknown totals, abort semantics; `aiClient.test.ts`: cancellation); code: the dialog shows name/size/license/cache state before anything downloads, and cancel aborts the in-flight fetch in the worker (`aiWorker.ts` aborters) | ✅ |
| 4 | WebGPU → WASM fallback, honest engine report | code: `onnx.ts` probes `navigator.gpu`, tries `webgpu`, falls back to `wasm`; the provider that ran is displayed ("המנוע שרץ: …"), plus a main-thread note when no worker exists. Runtime EP selection needs a real browser + real weights — manual check: run a smart mode in Chrome (WebGPU) and Firefox (WASM) and compare the engine line | ✅ (code) |
| 5 | Smart relief controls at min/max | unit (`maskAndDepth.test.ts` drives the real mesher: heights = base + relief, invert flips, mask floors background); the sliders map onto the same mesher parameters the classic relief has always used at these ranges | ✅ |
| 6 | Cloud mode with no API key | unit (503 + Hebrew message, availability `enabled:false`); e2e: the smart-relief journey runs WITHOUT stubbing the proxy, so its availability probe hits the real route with no key configured — the cloud option renders disabled with the explanatory tooltip and nothing crashes | ✅ |
| 7 | Consent before first upload; decline sends nothing | e2e (cloud journey asserts the consent dialog names the provider and that NO upload happened before approval); code: decline clears the pending request silently; approval is sessionStorage-scoped | ✅ |
| 8 | Provider failure / timeout / quota / cancel mid-generation | unit (`cloudClient.test.ts`: failed task message pass-through, timeout, quota message, abort without a fabricated error; `meshyProvider.test.ts`: 401/402/429/400/500 classification; `cloudRoutes.test.ts`: Hebrew mapping); code: the progress overlay's cancel aborts upload, polling, download and the repair job alike | ✅ |
| 9 | Unrepairable generated mesh | unit (`cloudFunnel.test.ts`: staged pipeline reports the honest failure; hostile OBJ rejected by the parser in Hebrew); the funnel surfaces `repair.messageHe` and adds nothing to the document | ✅ |
| 10 | Oversized image upload | unit: client refuses > 8MB before uploading; server refuses by header AND by actually-arriving bytes (streamed cap, header lies covered) | ✅ |
| 11 | Oversized result mesh | unit: server refuses a declared oversize and kills an endless stream mid-flight; client enforces its own 100MB cap while reading | ✅ |
| 12 | Printability analysis surfaced immediately after cloud import | e2e (the imported layer builds and the dimension readout lands); code: `requestAutoAnalysis` raises a flag consumed by the first successful build → `runAnalysis()` — the same analysis the "הרץ ניתוח מלא" button runs | ✅ |
| 13 | Design-file round trip of the new layers | Smart silhouette stores contours (existing silhouette schema), smart relief stores `mode:"relief"` + meshId (existing relief schema), cloud stores an `importedMesh` with provenance kind `stlImport` (the kind the sanitizer stores). No schema change; `savedDesignRebuild.test.ts` (unchanged) stays green | ✅ |

## Main-thread and memory

- Inference runs in the AI worker (in-process only as the honest fallback,
  reported in the UI). The cloud OBJ parse and the staged repair run as
  geometry jobs. `e2e/workerBuild.spec.ts` (responsiveness under rebuild)
  stays green.
- ORT sessions: bounded cache (two models), disposed with the worker;
  `disposeAiWorker` settles in-flight promises so nothing hangs.
- Solid handles: the funnel reuses `applyImportTriangleBudget`
  (scope-managed) and `repairMesh` (kernel-gated internally); the smart
  relief's kernel gate disposes its probe solid on both paths.
  `solidLeaks.test.ts` (the leak net) stays green in the full run.
- Repeated AI runs: each run replaces the previous result arrays
  (~0.4–1 MB per map) in dialog state; buffers are transferred, not copied,
  across the worker boundary.

## Gates (final state of the branch)

- `npm test` — 631 tests, green (includes the 70 new AI tests).
- `npm run lint`, `npm run typecheck`, `npm run build` — green.
- `npm run test:e2e` — 31 journeys green, including the two new AI
  journeys and the untouched image-import regression journey.

## Pre-existing findings out of this task's scope

The adversarial review of the whole diff surfaced two defects in files this
feature does not touch; they predate this branch and are recorded here
rather than mixed into it:

1. `hooks/useSessionPersistence.ts` — the debounced autosave can overwrite
   the crash-recovery slot with the fresh startup document while the
   recovery prompt is still open, losing the crashed session's snapshot.
2. `lib/serialization/designFile.ts` (`sanitizeFacePaint`) — merging
   same-slot paint entries keeps only the last entry's
   `meshTriangleCount`, so a merged record can violate its own fingerprint
   and drop valid paint.

## Manual verification steps (need a browser + network/key)

1. `npm run dev` → ייבוא תמונה → סף בהירות: "אוטומטי חכם (AI)" → הפעלה
   ראשונה מציגה הורדת 4.6MB עם התקדמות וביטול; התוצאה ניתנת לעריכה במברשת.
2. מצב "תבליט חכם (AI)" → הורדת ~99MB פעם אחת → תצוגה מקדימה של עומק →
   גוף סגור שנבנה ומודפס.
3. עם `IMAGE_TO_3D_API_KEY` ב-`.env.local` → מצב "מודל מלא (AI, ענן)" →
   הסכמה → יצירה (1–3 דקות) → שכבת רשת + ניתוח הדפסה אוטומטי.
