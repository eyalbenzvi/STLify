# AI Image-to-3D Plan (Milestones A + B)

The product owner has explicitly lifted the historical "no AI, no server"
policy for this work. The posture that replaces it: **local-first by
default** — on-device AI needs no consent beyond a model-download notice;
anything that sends data off-device is opt-in, in Hebrew, naming the
recipient.

This document is the plan the work was executed against, including every
autonomous decision and its rationale, and the changes made by the
adversarial review (§10).

---

## 0. Ground rules carried over from the codebase

- Reuse over rebuild: the silhouette tracer, the relief mesher
  (`heightFieldToClosedMesh` — the task brief calls it
  `imageGridToReliefSolid`; same function), the hardened OBJ importer, the
  staged repair pipeline, the triangle budget, the job/worker pattern and
  the import dialog all already exist and are the integration points.
- Backward compatibility is non-negotiable: the classic image import path
  (`thresholdMode: "auto" | "manual"`, modes `silhouette` / `relief`) is
  not modified — the new behaviour is additive options on the same dialog
  and handler, and no design-file schema change is needed (see §6).
- Every external byte is hostile: model weights are size-capped, provider
  meshes go through the existing hardened importer + repair funnel, uploads
  are validated by magic bytes and size on the server.
- All failure states are Hebrew and name the failing stage.

## 1. Branch note

The task text names branch `claude/image-to-3d-model-wlvnnx`; this session's
designated development branch is `claude/image-to-3d-model-ai-33vjh4`. The
harness forbids pushing to non-designated branches, so all work lands on
`claude/image-to-3d-model-ai-33vjh4`. (Autonomous decision #1.)

## 2. Module map

```
lib/ai/
  models.ts          model registry: URLs, sizes, licenses, input geometry
  modelCache.ts      download-with-progress + Cache API storage (injectable)
  onnx.ts            the ONLY module that imports onnxruntime-web;
                     WebGPU → WASM fallback, session cache, provider report
  imageTensor.ts     pure: RGBA ↔ CHW float tensors, bilinear resample,
                     ImageNet normalisation (node-testable, no DOM)
  segmentation.ts    pure: model output → probability mask → LuminanceGrid
  depth.ts           pure: model output → normalised depth → relief grid
  jobs.ts            AI job registry (segmentImage / estimateDepth)
  aiWorker.ts        Web Worker entry (mirrors lib/geometry/jobs/worker.ts)
  client.ts          runAiJob: worker-first, in-process fallback, progress,
                     cancellation, honest executionProvider report
  testMode.ts        deterministic fake inference, enabled ONLY by a
                     localStorage flag — the e2e boundary stub
  cloudClient.ts     browser client for the /api/image-to-3d proxy
  cloudErrors.ts     error taxonomy → Hebrew messages
  providers/
    types.ts         MeshGenProvider interface + ProviderError
    meshy.ts         Meshy implementation (injectable fetch)
    index.ts         provider selection from env

app/api/image-to-3d/
  route.ts                   GET availability / POST create task
  [taskId]/route.ts          GET task status
  [taskId]/model/route.ts    GET result mesh (server-side download)
lib/server/imageTo3d.ts      shared proxy logic: env, rate limit, validation

hooks/useCloudModelImport.ts cloud flow state machine (stages, cancel, funnel)
components/dialogs/ImportDialogs.tsx   extended image dialog (all new UI)
scripts/copyOrtAssets.mjs    copies ort WASM runtime into public/ort/
```

`Editor.tsx` stays composition: it wires `useCloudModelImport` and passes two
new props into the existing dialog block. All logic lives in hooks/lib.

## 3. Milestone A — on-device AI

### 3.1 Runtime: onnxruntime-web

- Dependency: `onnxruntime-web@1.27.x` (MIT). The unified bundle carries both
  the WASM EP and the WebGPU (JSEP) EP.
- The runtime's `.wasm`/`.mjs` artifacts must be served same-origin (strict
  local-first: no CDN). `scripts/copyOrtAssets.mjs` copies
  `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.{wasm,mjs}` into
  `public/ort/` on `predev`/`prebuild`; `public/ort/` is gitignored.
  `ort.env.wasm.wasmPaths = "/ort/"`.
- The page is not cross-origin-isolated, so ORT runs single-threaded WASM
  automatically; we set `numThreads = 1` explicitly rather than relying on
  the silent downgrade.
- EP selection: try `webgpu`, fall back to `wasm`. The provider that actually
  ran is reported to the UI exactly like the existing `ranOn` pattern
  (`מנוע: WebGPU` / `מנוע: WASM (איטי יותר)`).

### 3.2 Models (downloaded at runtime, never committed)

| Task | Model | File | Size | Input | License |
| --- | --- | --- | --- | --- | --- |
| Salient-object segmentation | U²-Netp | `u2netp.onnx` | 4.6 MB | 1×3×320×320, ImageNet mean/std | Apache-2.0 (U²-Net repo) |
| Monocular depth | Depth Anything V2 Small (vits) | `depth_anything_v2_vits.onnx` | 99.4 MB | 1×3×518×518, ImageNet mean/std | Apache-2.0 |

Default URLs (verified reachable, `Content-Length` checked):

- `https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx`
  — the canonical distribution the rembg project uses; the weights are the
  official U²-Net release (Apache-2.0,
  https://github.com/xuebinqin/U-2-Net).
- `https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits.onnx`
  — Apache-2.0 export of the official Apache-2.0 Depth Anything V2 Small
  checkpoint (https://github.com/DepthAnything/Depth-Anything-V2; only the
  Small variant is Apache-2.0 — Base/Large are CC-BY-NC and are NOT used).

Override: `NEXT_PUBLIC_AI_MODEL_BASE_URL` — when set, both models load from
`${base}/<file name>` (self-hosting). Constant + env override as required.

**Autonomous decision #2 — u2netp over ISNet-general-use:** ISNet
(~176 MB fp32) is somewhat better on hair/fuzz; u2netp is 4.6 MB and for
silhouette tracing (a binary solid/background decision that then goes through
marching squares + curve fitting + an optional manual brush) the quality
difference does not survive the pipeline. 4.6 MB downloads in seconds on any
connection; 176 MB does not. u2netp wins on quality-per-byte.

**Autonomous decision #3 — Depth Anything V2 Small fp32 (99 MB) over a
quantised HF build:** the Hugging Face `onnx-community` quantised files
(~25 MB) would be preferable by size, but huggingface.co was not reachable
from the build environment, so the exact file names/URLs could not be
verified — and an unverifiable default URL is a runtime 404 shipped to every
user. The GitHub release asset was verified byte-for-byte reachable. The
base-URL override lets any deployment switch to a quantised copy it hosts
itself. First-use download shows the honest size and is cancellable.

**Hostile-input stance for weights:** a model file is opaque bytes fed to a
sandboxed WASM/WebGPU runtime. We cap the download (256 MB), require
`https:`, verify nothing else about content (ORT's parser rejects garbage),
and treat session-creation failure as a normal Hebrew-reported error.

### 3.3 Model download + cache

`modelCache.ts` streams the fetch, reports progress (`content-length` when
present, indeterminate otherwise), enforces the byte cap while reading,
supports abort, and stores the validated bytes in the Cache API
(`stlify-ai-models-v1`). When the Cache API is unavailable (private
browsing on some engines) it degrades to an uncached fetch with a note. The
fetch/cache backends are constructor-injected so unit tests never touch the
network.

First-use UX (in the dialog, before anything downloads): model name, size,
"מורד פעם אחת ונשמר במטמון הדפדפן; ההרצה כולה מקומית במכשיר", a progress bar
and a cancel button.

### 3.4 AI worker + client

Mirrors `lib/geometry/jobs/*` exactly: a typed job map
(`segmentImage`, `estimateDepth`), a worker that answers
progress/result/error/cancelled, a client with lazy worker creation and an
in-process fallback (SSR, vitest, worker-creation failure), `AbortSignal`
cancellation, and transferable payloads (RGBA in, Float32 mask/depth out).
The worker caches ORT sessions per model id, so the download + session cost
is paid once per session. Job stages: download (0–0.6) → session (0.6–0.7) →
inference (0.7–1), each with a Hebrew label.

`testMode.ts`: when `localStorage["stlify.aiTestMode"] = "1"`, the client
bypasses the worker and returns deterministic fakes (segmentation: centred
disk; depth: radial gradient). This is the e2e mock boundary — the real ONNX
runner is never loaded under Playwright, matching "mock the ONNX runner at
the boundary". Production code paths cannot enter it without the flag.

### 3.5 Smart silhouette ("אוטומטי חכם (AI)")

- UI: the existing threshold ToggleGroup "סף בהירות" gains a third option —
  `אוטומטי חכם (AI)` (`thresholdMode: "ai"`). Everything else in silhouette
  mode (target width, extrude, thicken-thin-features, resolution, smoothing,
  brush) stays.
- Pipeline: decode the ORIGINAL image once to 320×320 RGBA (aspect squashed,
  as U²-Net expects) → u2netp → sigmoid-ish saliency map → min-max normalise
  → the dialog stores it. At trace time the mask is bilinearly resampled to
  the decode grid (restoring aspect) and becomes the luminance grid itself:
  `lum = 1 − p(solid)`, threshold fixed at 0.5, invert=false. Soft mask
  values land BETWEEN pixels under marching-squares interpolation, so edges
  stay sub-pixel smooth, same as the classic path.
- The manual mask brush works unchanged on top (strokes burn 0/1 into the
  grid before tracing, exactly as today), and the preview shows the AI grid.
- Brightness/contrast/background-removal settings do not affect the AI mask
  (it is computed from the original pixels); the dialog hides those controls
  in AI mode rather than showing controls that do nothing.
- Otsu is bypassed; the stored layer `threshold` is 0.5. The layer that
  results is a plain silhouette `imageRelief` layer storing traced contours —
  identical schema, loads in any version.
- The thin-feature check + auto-thicken run unchanged on the AI grid.
- Backward compatibility: `"auto"`/`"manual"` paths are untouched code.

### 3.6 Smart relief ("תבליט חכם")

- UI: the mode ToggleGroup gains `תבליט חכם (AI)` (`mode: "smartRelief"`).
  Controls (sliders/toggles only): גובה תבליט (mm), עובי בסיס (mm),
  היפוך עומק (lithophane-style inversion), החלקת עומק (0–5), הסרת רקע (AI)
  (mask the depth with the segmentation model), רזולוציה, רוחב יעד.
  Defaults: height 3 mm, base 1 mm, no invert, smoothing 1, mask on.
- Pipeline: decode original image to 518×518 → Depth Anything V2 Small →
  relative depth map → min-max normalise to 0..1 (near = 1) → optional
  segmentation mask (background depth → 0, i.e. floor) → bilinear resample
  to the chosen grid resolution at the image's aspect → bilateral smoothing
  (existing `smoothGrid`) → `LuminanceGrid` with `lum = 1 − depth` →
  existing `heightFieldToClosedMesh` (dark = high ⇒ near = high;
  invert flips) → kernel gate → mesh store → `imageRelief` layer with
  `mode: "relief"` and a `meshId`, exactly like the classic relief. No new
  layer fields; a design saved from this path loads everywhere.

## 4. Milestone B — cloud image → full 3D model

### 4.1 Provider decision (autonomous decision #4): **Meshy**

| Criterion | Meshy | Tripo3D |
| --- | --- | --- |
| Documented image-to-3D REST API | Yes (`POST /openapi/v1/image-to-3d`, task id + poll) | Yes (`POST /v2/openapi/task`, type `image_to_model`) |
| OBJ/STL delivery | **OBJ URL directly in the finished task** (`model_urls.obj`), alongside GLB/FBX/USDZ | Direct output is GLB; OBJ/STL require a SECOND `convert_model` task |
| Geometry-only generation | `should_texture: false` skips texturing (cheaper, faster) | texture flags exist but conversion still needed |
| Commercial use | Paid plans include commercial usage rights | Paid plans include commercial usage rights |
| Price (image→mesh, no texture) | 5 credits/task (~$0.05–0.10 depending on pack) | ~10–20 credits + conversion task |

The deciding factor is the CRITICAL SIMPLIFICATION in the brief: Meshy hands
back an OBJ in one task, so the mesh enters through the EXISTING hardened
`parseObj` and **no GLB/glTF reader is written at all**. Tripo would have
required either a GLB reader or a second server round-trip per generation.

Abstraction: `MeshGenProvider` (createTask / getTask / resultUrl selection)
so a second provider is a new file, not a refactor. Exactly one concrete
implementation ships (no multi-provider UI, per scope).

### 4.2 Server proxy (`app/api/image-to-3d/*`)

The API key lives ONLY in `IMAGE_TO_3D_API_KEY` (server env). The provider
name (default `meshy`) in `IMAGE_TO_3D_PROVIDER`. `.env.example` documents
both. The client never sees the key or any provider URL.

- `GET /api/image-to-3d` → `{ enabled, providerNameHe }` — the dialog uses
  this to disable the mode with an explanatory tooltip when no key is set.
- `POST /api/image-to-3d` — body: raw image bytes.
  Validation, in order: key configured (503, Hebrew); rate limit (429);
  `content-length` and actual byte length ≤ 8 MB (413); magic-byte sniff for
  PNG/JPEG/WEBP (415) — the declared content-type is checked but not
  trusted. The image is forwarded to the provider as a `data:` URI.
  Returns `{ taskId }` (the PROXY's task id — an opaque random id mapped
  server-side to the provider task id, so provider ids never reach the
  client and the model route cannot be pointed at arbitrary tasks).
- `GET /api/image-to-3d/:taskId` → `{ state, progress }`,
  state ∈ pending | running | succeeded | failed(+messageHe kind).
- `GET /api/image-to-3d/:taskId/model` — server fetches the OBJ from the
  provider URL and streams it back. SSRF stance: the URL is never
  client-supplied — it comes from the provider's own task response, and is
  additionally required to be `https:` on an allowlisted host suffix
  (`.meshy.ai`); the download is size-capped (100 MB) while streaming.
- Rate limiting (documented as basic, in-memory, per instance): 6 creates
  per hour and 120 status polls per minute per client IP.
- Task-id map is in-memory with TTL (2 h) and a size cap; this is a
  single-instance design, stated honestly in `.env.example`.

### 4.3 Client flow + funnel

`useCloudModelImport` state machine:

```
idle → uploading → generating(progress %) → downloading → repairing →
budgeting → done | failed(stage, messageHe) | cancelled
```

- Consent: before the FIRST upload of the browser session (sessionStorage
  flag), the cloud panel shows the explicit notice: the image will be sent
  to **Meshy** (a named third-party service), processed on their servers
  under their terms, and the mesh returned; approve ("אני מאשר לשלוח")
  or cancel. Decline = nothing leaves the device.
- Polling every 4 s (8 s after the first minute), hard timeout 15 min,
  cancellable at every stage (abort upload/poll/download; a task already
  running at the provider cannot be revoked and the UI says so).
- Funnel (all existing machinery):
  `parseObj` (hardened, caps) → rebase to plate → **staged repair pipeline**
  via `runGeometryJob("repairMesh")` (worker; voxel remesh fallback; honest
  stage report) → unrepairable ⇒ Hebrew failure naming the stage, nothing
  added to the document → `applyImportTriangleBudget` (250 K auto-simplify
  with notice) → mesh store → `ImportedMeshLayer` with provenance
  `{ kind: "stlImport", fileName, descriptionHe: "נוצר מתמונה בענן (Meshy)" }`
  (an existing kind — survives the design-file round trip unchanged) →
  uniform scale so the footprint matches the user's "גודל יעד" (the provider
  has no physical units; the dialog says so) → printability analysis is
  auto-triggered on the first successful build after the import
  (`runAnalysis`), surfacing issues immediately.
- Every failure path maps to the Hebrew error taxonomy (§7).

### 4.4 UI

Mode option `מודל מלא (AI, ענן)` in the same dialog. Panel shows: target
size field, the consent notice (first time), what the service does/keeps,
generation stages with progress + cancel, and on missing server key the mode
option is disabled with tooltip "השרת לא הוגדר עם מפתח API ליצירת מודלים —
ראו .env.example" — never a runtime crash.

## 5. Out of scope (enforced)

No free-text prompts (nothing in the UI accepts text; the provider call
sends the image only). No textures/materials from the provider
(`should_texture: false`, and only geometry is read from the OBJ). No
multi-provider UI. No GLB reader. No billing. No schema change.

## 6. Design-file / schema impact: none

- Smart silhouette ⇒ silhouette `imageRelief` layer (contours, threshold
  0.5) — existing schema.
- Smart relief ⇒ relief `imageRelief` layer (meshId + settings) — existing
  schema.
- Cloud model ⇒ `importedMesh` layer with provenance kind `stlImport` —
  existing schema.

Old files load identically; new files load in old versions.

## 7. Error taxonomy (Hebrew)

| Code | When | Message (essence) |
| --- | --- | --- |
| ai.download.failed | model fetch failed / offline | "הורדת מודל ה-AI נכשלה — בדקו את החיבור ונסו שוב" |
| ai.download.cancelled | user cancel | silent (not an error) |
| ai.session.failed | ORT refused model / EP init failed | "הפעלת מנוע ה-AI נכשלה בדפדפן זה — נסו את המצב הקלאסי" |
| ai.inference.failed | run() threw | "הרצת מודל ה-AI נכשלה — נסו רזולוציה נמוכה יותר או את המצב הקלאסי" |
| ai.emptyMask | mask found no subject | "ה-AI לא זיהה נושא בתמונה — נסו את המצב הקלאסי או ציירו ידנית" |
| cloud.disabled | no server key | "יצירת מודל בענן אינה מוגדרת בשרת (חסר מפתח API)" |
| cloud.consentDeclined | user declined | silent |
| cloud.imageTooBig | > 8 MB | "התמונה גדולה מדי לשליחה (מקסימום 8MB)" |
| cloud.badImage | magic bytes | "רק PNG, JPG או WEBP נתמכים בשליחה לענן" |
| cloud.rateLimited | 429 | "יותר מדי בקשות — המתינו מעט ונסו שוב" |
| cloud.quota | provider payment/quota | "מכסת השירות בענן נוצלה — בדקו את החשבון בספק" |
| cloud.providerFailed | task FAILED | "יצירת המודל נכשלה אצל הספק: <סיבה>" |
| cloud.timeout | 15 min | "יצירת המודל ארכה יותר מדי — נסו שוב מאוחר יותר" |
| cloud.network | fetch failed | "התקשורת עם השרת נכשלה — בדקו את החיבור" |
| cloud.meshUnrepairable | repair pipeline failed | the pipeline's own honest stage report |

## 8. Test plan

Unit (vitest, node, no network, no real weights — fakes injected):

- `imageTensor.test.ts` — resample correctness (identity, 2×, aspect),
  normalisation, CHW layout.
- `segmentation.test.ts` — min-max normalise, mask→grid orientation,
  degenerate (flat) map handling, resample round trip.
- `depth.test.ts` — depth normalise/invert, background masking, grid
  values feed `heightFieldToClosedMesh` and produce expected heights.
- `modelCache.test.ts` — injected fetch/cache: cache hit skips network,
  progress ticks, byte-cap abort, AbortSignal.
- `aiClient.test.ts` — in-process path with injected fake session factory:
  progress order, cancellation, error mapping.
- `meshyProvider.test.ts` — mocked fetch: create/poll/succeed, FAILED,
  quota (402/429), malformed JSON, timeout.
- `cloudRoutes.test.ts` — route handlers as functions: no key → 503 Hebrew;
  bad magic bytes → 415; oversize → 413; rate limit → 429; unknown task →
  404; model route host allowlist + size cap.
- `cloudFunnel.test.ts` — synthetic broken OBJ (holes/degenerate) through
  parse → repair → budget wiring; unrepairable input reports the stage.

e2e (Playwright, mocks at the boundary, geometry assertions):

- `aiImport.spec.ts` "smart relief": `stlify.aiTestMode` fake depth →
  import → תבליט חכם → create → assert the viewport dimensions match the
  target width and base+height (geometry consequence, not DOM).
- `aiImport.spec.ts` "cloud model": `page.route` stubs the three proxy
  endpoints (availability on, task lifecycle, tiny valid OBJ) → consent →
  generate → assert a mesh layer with the expected footprint exists.

Gates: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`,
`npm run test:e2e` all green.

## 9. Worker/job + memory notes

- AI worker mirrors the geometry worker protocol; payloads/results are
  transferable buffers.
- ORT sessions are cached per model in the worker (documented, bounded: two
  models). `dispose()` on worker teardown.
- The funnel never holds two copies of a mesh: repair/budget run in the
  worker on transferred copies; the main thread stores only the final mesh.
- Solid handles follow the existing scope/dispose contract
  (`withSolidScope`, `solid.dispose()` on all paths) — the leak tests'
  standard.

## 10. Adversarial review of this plan (changes applied)

1. **Proxy SSRF via provider-controlled URL** — the model URL comes from the
   provider's response, which is still external data. Added: https-only +
   host-suffix allowlist + streaming size cap. (Was: "trust the provider".)
2. **Provider task-id leak / IDOR** — returning provider task ids to the
   client would let anyone with a proxy instance poll arbitrary ids and have
   the server download attacker-influenced URLs for them. Changed to opaque
   server-minted ids with an in-memory map + TTL.
3. **`content-length` is a lie** — the upload cap is enforced on the actual
   received bytes, not just the header; the model download cap is enforced
   while streaming, not after.
4. **Content-type is a lie** — magic-byte sniffing for PNG/JPEG/WEBP on the
   server; the browser-side check remains the lenient existing one.
5. **Main-thread stalls** — inference and repair both run in workers; the
   dialog's AI preview stores results rather than re-running per keystroke;
   the only main-thread ORT path is the in-process fallback, which reports
   itself honestly like `ranOn: "main"` does today.
6. **Backward compatibility proof** — classic paths are untouched code, and
   the existing `imageImport.spec.ts` e2e + image unit tests run unchanged
   as the regression net.
7. **Offline behaviour** — cached models work offline (Cache API); an
   uncached model download fails with `ai.download.failed`; the cloud mode
   fails with `cloud.network`; the classic path is unaffected. No retry
   loops.
8. **RTL/accessibility** — all new controls reuse `NumberField` /
   `ToggleGroup` / `Modal` (labelled fields, radio-group semantics, focus
   trap). Progress bars get `role="progressbar"` with Hebrew labels.
9. **Dialog state staleness** — AI mask/depth results are keyed to the file
   and cleared when the file changes or the dialog closes; strokes already
   follow this rule.
10. **WASM asset drift** — ort runtime assets are copied by version at
    build time from the installed package, never vendored by hand;
    a missing `/ort/` asset surfaces as `ai.session.failed`, not a hang.
11. **Quota/abuse of the proxy** — basic per-IP rate limits + 8 MB body cap;
    the availability endpoint leaks nothing but a boolean and a name.
12. **Test-mode leakage** — the fake runner is reachable only through a
    localStorage flag no production code sets, and it still exercises the
    full downstream pipeline (grids → mesher → kernel → document).

## 11. Execution order

1. Plan (this doc) — commit.
2. Milestone A: `lib/ai/*` + dialog + handler wiring — commit.
3. Milestone B: proxy + provider + funnel + dialog — commit.
4. Tests (unit + e2e) — commit.
5. Review fixes — commit. QA doc — commit.
