# PrintCraft STL Studio — V7

A browser-only studio for designing genuinely 3D-printable models — text,
SVG artwork, image silhouettes/reliefs and imported STL, 3MF and OBJ files —
with a Hebrew, right-to-left UI. V3 added a layer-based 3D editor and print
preparation tools; V4 added real modelling — creating geometry from nothing,
reshaping it, and repairing broken meshes. V5 connected that engine to the
user, put a regression net under it, and made the output actually print.
V6 moved the hot path off the main thread, made exports slicer-honest,
and added the automation and persistence a small production shop needs.
V7 rebuilds the import boundary — the place where a photo, a scan or someone
else's model file becomes geometry.

Everything runs locally, on this device. There is **no AI, no server-side
generation, no accounts and no sync**: heuristics are deterministic and
explained in Hebrew, the working document lives in the browser session, and
the only storage is device-local — a single crash-recovery slot and an
optional local design library (IndexedDB), both of which can be switched
off entirely and wiped entirely. Portable `.formadesign.json` files are how
work leaves the device.

## Getting started

```bash
npm install
npm run dev        # development server
npm run build      # production build (includes TypeScript checking)
npm start          # serve the production build
npm test           # unit + geometry-pipeline tests (vitest)
npm run lint       # ESLint (flat config)
npm run typecheck  # tsc --noEmit
```

Open http://localhost:3000. A sample name-plate design is preloaded.

Two additional commands arrived with V6:

```bash
npm run bench      # performance budgets (fails above named thresholds)
npm run batch -- --design x.formadesign.json --csv rows.csv --out batch.zip
```

## V7 features

Everything in V7 sits at the import boundary (`docs/V7-PLAN.md` is the plan it
was executed against). That boundary was the weakest part of the app: the
silhouette threshold was a guess made before seeing a single contour,
"smoothing" quietly rounded off the corners it was meant to protect,
background removal compared colours in a space that does not match how they
look, the one escape hatch the code documented did not exist, and two
mainstream model formats could not be read at all.

### The image path

- **The brightness threshold is computed, not asked for.** Otsu's method
  derives it from the image at import time — deterministic, no model. The
  manual slider is still there behind an "אוטומטי / ידני" toggle, but nobody
  has to guess first. An image with no two populations to separate says so
  rather than letting you discover it in the geometry. The value Otsu picks is
  stored on the layer and the rebuild keeps reading the stored value, so no
  design already on disk changes shape on load.
- **Minimum feature size is checked while it can still be fixed.** After the
  silhouette is traced, an exact distance transform measures the narrowest
  stroke and compares it with two extrusion widths of the document's printer.
  The wall-thickness analysis finds the same defect, but only once the
  threshold, the resolution and the artwork are all behind you. Strokes under
  the minimum are thickened automatically (default on, switchable off) with a
  Hebrew notice naming the measured width and the machine's minimum.
- **Smoothing is edge-preserving.** The 3×3 box blur became a bilateral
  filter: noise still goes, corners stay. The control labelled "smoothing" is
  no longer also a control for "lose the corners".
- **Contours are curve-fitted, not decimated.** Douglas-Peucker could only
  keep points that sit ON the marching-squares staircase, so every letter and
  logo edge came out faceted. Least-squares cubics let the curve pass BETWEEN
  the samples: measured on traced disks, roughly half the deviation from a
  true circle at a fifth fewer points. Corners are found geometrically and
  pinned, so a right angle stays a right angle. No new setting.
- **Background removal compares colours perceptually.** Clustering and the
  tolerance test moved to CIELAB with a ΔE distance. Squared RGB distance put
  yellow and orange closer together than the default tolerance while splitting
  near-identical dark tones; both errors showed up as holes in the subject or
  background left standing. The 0..100 scale maps 1:1 onto ΔE so existing
  tolerance values keep their meaning.
- **A manual mask brush, with a live silhouette preview.** When the automatic
  separation is wrong there is now somewhere to go: paint, erase, brush size,
  reset. Strokes are stored in image coordinates, so changing the resolution,
  brightness or contrast does not move or lose them. They apply to that import
  only and are not saved in the design file — the dialog says so, because the
  file stores traced contours, never the source image.

### More formats in

- **3MF and OBJ import**, through the same picker as STL ("ייבוא מודל").
  3MF reads multiple objects, build transforms, nested component hierarchies,
  units and materials — colours become material slots — so a multi-object
  build arrives as one layer per body, each where the file put it. A body the
  file marks as a support keeps that meaning through a re-export. OBJ reads
  all four index forms including negative indices, fan-triangulates polygon
  faces, and welds like the STL importer welds.
- **Imported files are treated as hostile.** The ZIP reader counts bytes as
  they arrive rather than trusting declared sizes (a 64 MB-of-zeros bomb is
  refused mid-stream); the XML is read by a scanner with no DTD subsystem and
  no resolver, so DOCTYPE and entity declarations are refused rather than
  skipped; object, vertex, triangle, depth and recursion counts are all
  capped; circular component graphs are detected. Every refusal is a Hebrew
  message, and none escape as a raw throw.
- **A triangle budget on import.** Above 250,000 triangles a mesh is
  simplified automatically, with a notice naming both counts and saying
  plainly that simplification loses fine detail. It runs after repair, since
  simplification needs a watertight mesh; when the mesh cannot be made
  watertight the notice says the reduction did not happen rather than quietly
  shipping the heavy mesh.

## V6 features

V6 came out of a five-expert review of V5 (`docs/V6-PLAN.md` is the plan it
was executed against). The governing findings: the hot path still ran on
the main thread, exports were not slicer-honest, and the tool had no
automation story despite a real expression engine.

### Wave 1 — immediate wins

- **BVH picking**: viewport face picking goes through the project's own
  triangle BVH instead of three's linear scan — a pick on a 500K-triangle
  import costs dozens of triangle tests, not half a million.
- **Demand frameloop**: the canvas renders only when something changed
  (`frameloop="demand"`, `dpr` capped at 2); every change point invalidates,
  and an e2e journey proves the viewport repaints in every tool mode.
- **Bounded history that actually frees memory**: 50 steps (a documented
  memory bound), with a sweep that releases the meshes only trimmed history
  entries referenced.
- **Zero lint warnings**: the nine hook-dependency warnings are closed for
  real, not silenced.

### Wave 2 — the hot path

- **The document build runs in the Web Worker** — the code path behind
  every keystroke, with progress, cancellation of superseded builds, and an
  honest `ranOn` report (pinned by an e2e assertion that fails on a silent
  fallback).
- **Incremental rebuilds**: derived per-layer solids are cached by a
  content hash; changing one layer rebuilds one layer, moving a layer
  rebuilds zero.
- **Booleans, Minkowski hollow/thicken, drain drilling, thickness sampling
  and support generation are worker jobs** with cancellation that stops
  at memory-accounted checkpoints.
- **The WASM memory contract is enforceable**: idempotent dispose, a live
  handle counter, and a solid scope that frees everything on success and
  throw alike — leak tests assert zero across boolean chains, error paths
  and cancellations.
- **Performance budgets** (`npm run bench`): synthetic 50K/200K/500K-triangle
  meshes, named thresholds, failure above them — kept out of `npm test` so
  the correctness gate never flakes on wall-clock.

### Wave 3 — printing and slicer compatibility

- **Supports export as SUPPORT objects in 3MF** (via a spec-compliant
  component wrapper), so a slicer prints removable aids instead of
  full-infill bodies; the ZIP README warns per support part.
- **Slice-measured estimates**: print time is priced per component —
  perimeters, skins/infill, travel, SLA exposure and area-dependent lift —
  from real kernel slices, with the breakdown shown in Hebrew and the
  "rough estimate" labelling kept everywhere.
- **Warping analysis** with a deterministic, explained score (contact span,
  contact area, height-to-base), and **brim/raft as real deletable
  geometry** derived from the first-layer outline.
- **3MF production structure**: stable object ids, local geometry placed by
  build transforms, and the layer hierarchy exported as assemblies.

### Wave 4 — automation and production

- **Headless batch CLI**: a design file plus a CSV → a ZIP with a part per
  row (parameters and text-layer content per column), watertight-checked,
  with honest per-row failure reporting. Local only.
- **Better plate arrangement**: rotation candidates (15° steps; rectangles
  resolve to 0/90°) measured on the true convex hull of each part's
  projection — deterministic, as before.
- **A local design library** with names, tags and numbered versions per
  design, in IndexedDB on this device only; loading goes through the same
  validation as an untrusted file, and the whole feature can be disabled
  and wiped.

### Wave 5 — editing and UI

- **Face paint survives edits**: painted regions carry spatial anchors and
  are re-projected onto the rebuilt body by proximity + normal agreement
  (thin walls stay two-sided). Pre-V6 paint keeps the honest discard.
- **The full 3D-tool keyboard set**: F (frame selection), Ctrl+D, Ctrl+A,
  numeric view presets, a remappable keymap stored locally, and a help
  screen (Shift+?).
- **Responsive + touch**: a collapsible tool sheet below `lg`, finger-sized
  hit areas on coarse pointers, a touch-sized gizmo, and tap
  select/deselect — with phone and tablet e2e journeys.
- **Local fillet on a selected region**: cut-round-union through pure
  Manifold booleans, watertight by construction, gated by a validity check
  — with the boundary-step caveat stated in the UI (see limitations).

## V5 features

V5 came out of a three-expert review (senior frontend, 3D printing, design
engineering) whose governing finding was that the geometry engine had run
well ahead of the product: roughly a third of what existed could not be
reached by a user, and one subsystem — the geometry worker — had been built
but never called. The work is grouped in three waves; `docs/V5-PLAN.md` is
the plan they were executed against.

### Wave A — make what exists reachable

- **Primitive and sketch properties**: a created cube could not be resized,
  because nothing rendered its parameters. `PrimitiveProps` maps each kind to
  the parameters it actually reads, so the panel never offers a field the
  shape ignores.
- **The geometry worker is now called.** Fillet, shell, lattice, voxel
  remesh, repair and remesh run off the main thread with live progress and a
  cancel button. Where a worker cannot be created the operation still runs
  in-process and the overlay says so rather than pretending.
- **Sub-object editing UI**: face picking in the viewport with grow modes
  (single triangle / whole face / similar normal / whole body), push-pull,
  local smoothing, region delete and region split.
- **Error boundary**: a throw in the canvas or a panel shows a recovery card
  with an emergency design download, not a blank page.
- **Hierarchy, pivot and revolve**: re-parent from the layer list, edit the
  pivot a layer rotates and scales around, revolve a sketch or SVG profile.
- **Curved emboss dialog**: wrap or project a text/SVG layer onto a body.

### Wave B — keep it from breaking

- **UI regression suite** (Playwright, `e2e/`): sixteen journeys driven in a
  real browser. Each asserts a consequence in the geometry pipeline, not a
  DOM state — that is the failure mode unit tests structurally cannot see.
- **Editor decomposition**: import and analysis handling moved into
  `hooks/useImportHandlers.ts` and `hooks/useAnalysisRunner.ts`.
- **Accessibility**: labelled number fields, radio-group semantics on toggle
  groups, headed sections, and a real focus trap in modals.
- **Binding validation**: an expression bound to a field that does not exist
  is reported instead of silently ignored.

### Wave C — make prints succeed

- **Printer calibration**: print the tolerance coupon once, measure which
  hole fits, enter the number. Every fit in the document derives from it —
  sliding, close and press fits, holes, inlays, connectors, enclosures and
  threads — instead of each guessing separately.
- **Hole compensation and elephant-foot compensation**: a printed hole comes
  out undersized and a first layer squashes outward; both are corrected in
  the model so the printed part measures what was designed. The first-layer
  correction moves each wall perpendicular to itself, so a bore OPENS by the
  compensation while the outer wall closes by it, and a corner lands where
  both of its faces say it should. Only the band below the fade height is
  touched, which is what keeps a rebuild cheap.
- **Support generation**: conical pillars under overhangs, wide at the base
  and narrow at the tip so they snap off.
- **Bridging analysis**: unsupported horizontal spans are found and reported
  across their SHORT direction — that is the distance the printer actually
  has to bridge.
- **Custom printers**: define your own machine; it travels inside the design
  file, so a design carries the printer it was made for.
- **Per-face material painting**: paint regions of a body with a material
  slot. The paint is metadata — the body stays one editable object — and at
  export each painted region is separated into its own watertight part, so a
  two-colour print is actually producible in ZIP or 3MF (a single STL carries
  no materials, and the export dialog says so before you download one). Every
  split is checked against the invariant it exists to serve: each piece must
  have positive volume and the pieces must add back up to the body. A split
  that fails is refused with a reason rather than shipped.
- **Lattice vs nozzle check**: struts thinner than two nozzle widths raise a
  warning naming the minimum the selected printer can actually resolve. It is
  a warning rather than a refusal because a slicer set to a smaller extrusion
  width can still print them; the nozzle comes from the document's printer,
  so the check reflects the machine the design targets.
- **Thread chamfer and fit class**: a lead-in chamfer at both ends so a nut
  starts straight instead of cross-threading, and tight / normal / loose fit
  classes (x0.5 / x1 / x1.75) scaling the clearance — which itself comes from
  the calibration when the document has one.

## V4 features

- **Sub-object selection**: face / edge / vertex picking with region growth
  by coplanarity, connectivity or normal similarity — a triangle mesh has no
  CAD notion of a "face", so logical faces are reconstructed by growing
  coplanar regions.
- **Direct editing**: push/pull a planar face along its normal, local
  smoothing with the region boundary pinned, delete a region (sealed by the
  hole filler), and split a painted region into its own closed body.
- **Curved-surface emboss**: cylindrical wrap (analytic, for mugs, rings and
  bottles) and ray-cast surface projection (for domes and scans), embossing
  or engraving through the normal boolean path.
- **Isotropic remesh**: incremental split / collapse / tangential relaxation
  with feature edges pinned, so triangle QUALITY improves rather than just
  triangle count.
- **Modifier stack**: fillet, shell, bend, twist, taper, stretch, lattice,
  remesh, simplify and smooth as re-editable records rather than baked
  meshes. Reorder, disable or retune any of them at any time; the result is
  re-derived from the source, never stacked on the previous result.
- **Named parameters**: a real expression parser (not `eval`) with
  arithmetic, functions and Hebrew identifiers. Bind any numeric field to an
  expression and one document becomes a product family.
- **Hierarchy and pivots**: parent-child layers so a group moves together,
  and a per-layer pivot so a lid rotates about its hinge.
- **Geometry snapping and measurements**: snap to vertices, edge midpoints,
  points along an edge and face centres; measure dihedral angle, radius from
  three points, and wall thickness at a point.
- **Off-thread geometry**: a job registry and Web Worker with progress and
  cancellation, plus an in-process fallback so a job always runs.
- **Session memory**: mesh-store byte accounting and a sweep against the full
  undo history.
- **Local crash recovery**: one IndexedDB slot on this device, restored
  through the normal import path. No accounts, no server, no sync — and it
  can be switched off.

- **Create from nothing**: parametric primitives (box, cylinder, sphere,
  cone, torus, wedge, tube) and a 2D sketch layer (polyline, rectangle,
  circle, ellipse, regular polygon, quadratic Bezier) that extrudes down the
  same path as imported SVG. Before V4 there was no way to make a cube.
- **Real mesh repair**: hole filling by ear clipping, non-manifold and
  winding repair, bowtie-vertex splitting, degenerate/duplicate cleanup,
  self-intersection detection, loose-fragment and trapped-shell removal, and
  a voxel rebuild that turns almost any broken file into a printable solid.
  A staged pipeline escalates from lossless fixes to destructive ones and
  reports exactly which stages ran.
- **Mesh inspector**: every defect listed in Hebrew with a corrective action
  and, where known, a camera-navigable location.
- **Fillet / chamfer**: morphological rounding of convex or concave edges
  (sphere = radius, octahedron = 45-degree cut).
- **Open shell**: hollow with an opening in a chosen face — a real box, tray
  or cup rather than a sealed cavity needing a drain hole.
- **Deformers**: bend, twist, taper and localised stretch, each refining the
  mesh to its own curvature so a bent cube is a smooth arc, plus a trilinear
  FFD cage.
- **Lattice infill**: gyroid, Schwarz-P and honeycomb interiors via level
  sets. Unlike slicer infill this is real exported geometry.
- **Array patterns**: linear, grid, circular and mirror. Copies share the
  source mesh payload, so a large array costs one mesh.
- **Parametric generators**: ISO threads, involute spur gears, two-part
  enclosures with a fitted lid, living hinges, snap-fit clips and a printer
  tolerance-test coupon.
- **Interference detection**: every pair of parts checked for genuine
  interpenetration, with overlap volume and location.
- **Auto-arrange**: shelf-packs part footprints onto the build plate;
  anything that will not fit is reported rather than silently stacked.

## V3 features

- **Layer-based documents**: base plate, text, SVG, image (silhouette /
  relief), imported meshes and hole layers, each with visibility, lock,
  material slot and a full 3D transform (X/Y/Z translate, rotate, scale).
- **Base modes**: "עם בסיס" (V2-compatible: raised/engraved layers riding a
  base plate) and "ללא בסיס" (every layer is an independent closed solid).
  Switching modes never deletes content and is undoable.
- **3D editing**: transform gizmos (drei TransformControls) with position/
  rotation/scale snapping, world/local spaces, numeric mm/deg panel;
  placement tools (drop to plate, center, mirror, align, distribute,
  duplicate, snap to object, place-on-surface by clicking a target face).
- **Booleans**: union/difference/intersection via the Manifold kernel, with
  overlap warnings, source keep/hide/replace, and validated results.
- **STL import/edit**: binary + ASCII parsing with welding, validation,
  summary dialog, automatic weld-based repair attempts (honest failure
  reporting), then the full toolset (booleans, cut, hollow, smooth, …).
- **Cut / split / connectors**: capped plane cuts (XY/XZ/YZ/custom),
  component splitting, and pin/key/sliding-dovetail/magnet-pocket connector
  pairs with configurable clearance and edge margin.
- **Hollow / drain / thicken**: true morphological erosion/dilation
  (Manifold Minkowski ops) with base preservation, material-saving report,
  and drain holes whose cavity reach is ray-verified.
- **Smooth / simplify**: Taubin smoothing with sharp-feature locking,
  Manifold edge-collapse simplification with presets — both re-validated
  through the manifold gate.
- **Printability analysis**: profiles (FDM PLA/PETG/TPU, SLA resin) with
  editable thresholds; overhang, plate-contact, floating-component,
  build-volume and ray-sampled wall-thickness analyses; thickness/overhang
  heatmap overlays; orientation suggestions with a transparent score; rough
  time/weight/cost estimates (clearly labelled as estimates).
- **Inspection**: two-point measurements (editor-only), clipping-plane
  section view (preview-only), per-layer transparency + X-ray, exact
  scale-to-size and fit-to-build-volume.
- **Print preview**: approximate layer-line shading at a configurable layer
  height, labelled "תצוגה מקדימה בלבד — יש לאמת בסלייסר לפני הדפסה".
- **Export**: single binary STL, ZIP with one STL per part + bilingual
  README, tested 3MF (per-part colours/materials), portable design file.
  Export is blocked on critical geometry failures and requires
  acknowledgement for warnings.

### Ported from the V2 branch

- **Text**: letter spacing, LTR direction override, arc (curved) text for
  medals, mirrored text for stamps.
- **Inlay combine mode**: flush inserts — the base gets a clearance pocket
  and the inlay exports as a separate coloured part.
- **Bases**: circle shape and a raised rim (coasters, medals, plaques).
- **Templates**: round medal, name tag (rear magnet pocket), fridge magnet,
  mirrored stamp, coaster, wall plaque with mounting holes, blank.
- **SVG sanitization**: scripts, event handlers and external references are
  always stripped before parsing; unsupported features produce Hebrew warnings.
- **Image import**: fully client-side automatic background removal
  (border-seeded flood fill) plus brightness/contrast adjustments.
- **Estimation**: infill/shell-aware material+cost breakdown and a print-time
  range with a confidence level (labelled as estimates).
- **Share links**: small designs compress into the URL hash (`#d=…`) — the
  link IS the data; no server involved. Mesh-bearing designs fall back to
  file sharing with a clear Hebrew notice.

## Architecture

| Layer | Files | Responsibility |
| --- | --- | --- |
| Domain model | `types/design.ts`, `types/profiles.ts` | Layer documents, transforms, operations, printer/material/printability/usage profiles |
| Kernel | `lib/geometry/kernel.ts` | **Geometry service abstraction** over Manifold (WASM): extrude, booleans, plane cuts, slicing, Minkowski, simplify, ray casts |
| Pipeline | `lib/geometry/buildDocument.ts`, `solids.ts` | Document → printable parts (built in each part's local frame; world matrices carry placement so gizmo drags never rebuild geometry) |
| Validation | `lib/geometry/documentValidation.ts` | Pure parameter checks with Hebrew messages |
| Operations | `lib/geometry/operations/*` | Booleans, cut/split, connectors, hollow/drain, thicken/smooth/simplify, placement math |
| Analysis | `lib/geometry/analysis/*` | Overhang, contact, floating parts, build volume, wall thickness, orientation scoring, estimates |
| Import | `lib/import/{stl,obj,threeMF,svg,image}.ts` + `{zipRead,xmlLite,triangleBudget}.ts` | Validated STL/OBJ/3MF/SVG/image parsing → mesh data / contours, with bounded readers for untrusted archives and XML |
| Export | `lib/export/{stlData,threeMF,zip,package,exportDocument}.ts` | Binary STL, 3MF, dependency-free ZIP (STORE), multi-part package; `exportDocument.ts` picks between them |
| Serialization | `lib/serialization/designFile.ts` | Portable `.formadesign.json` v3 with strict validation |
| History | `lib/history/history.ts` | In-memory undo/redo (session only) |
| Repair | `lib/geometry/repair/*` | Topology analysis, hole filling, self-intersection, voxel remesh, component cleanup, staged repair pipeline |
| Spatial index | `lib/geometry/bvh.ts` | Triangle BVH: closest point, ray crossings, overlap pairs |
| Sketch | `lib/geometry/sketch.ts` | 2D sketch entities compiled to contours |
| Generators | `lib/geometry/generators/*` | Threads, gears, enclosures, hinges, clips, tolerance coupons |
| Sub-object | `lib/geometry/selection/*` | Adjacency, region growth, push/pull, local ops, split by paint |
| Parametric | `lib/geometry/expression.ts`, `modifiers.ts` | Expression parser, named parameters, re-editable modifier stack |
| Snapping | `lib/geometry/snapping.ts` | Vertex/edge/face snapping, angle, radius and thickness measurement |
| Jobs | `lib/geometry/jobs/*` | Named geometry jobs, Web Worker, in-process fallback |
| Recovery | `lib/serialization/crashRecovery.ts` | Single-slot local snapshot |
| Library | `lib/serialization/designLibrary.ts` | Device-local design library with numbered versions (IndexedDB) |
| Batch | `cli/batch.ts`, `cli/batchCore.ts` | Headless CSV → ZIP production runs (local Node process) |
| Keyboard | `lib/keyboard/keymap.ts` | Editable, locally persisted shortcut map |
| Benchmarks | `bench/perf.bench.ts` | Performance budgets (`npm run bench`) |
| UI shell | `components/Editor.tsx`, `components/editor/**` | Composition: panels, viewport, dialogs. Owns wiring, not operations |
| UI logic | `hooks/**` | One hook per family: ops plumbing, dialogs, placement, body operations, print aids, region tools, persistence, shortcuts |
| UI | `components/dialogs/**`, `components/viewer/**` | RTL Hebrew dialogs and the R3F viewport |

### Why Manifold (manifold-3d)

The pipeline needs true solid booleans and cuts: Manifold is a
guaranteed-manifold kernel — every boolean/cut result is watertight by
construction — and its Clipper2 2D layer (NonZero fill) resolves overlapping
font contours and SVG holes robustly. V3 additionally uses `splitByPlane`
(capped cuts), `minkowskiSum/Difference` (real hollow/thicken), `simplify`,
`decompose`, `slice` and exact `rayCast` (thickness sampling, drain-hole
verification). The kernel is isolated behind `GeometryKernel`/`Solid`
interfaces so it can be swapped without touching the pipeline.

### Geometry conventions

- Units: millimetres everywhere (1 STL unit = 1 mm). Model space: Z-up.
- Parts are built in their primary layer's local frame; `worldMatrix`
  places them. Export bakes world-space meshes.
- Text/extrusion prisms overlap their base by 0.05 mm before booleans to
  avoid coplanar-face ambiguity.
- Nothing non-manifold is ever exported: parts carry the kernel status and
  the export dialog blocks critical failures.

### V4 implementation notes

- **Fillet is global, not per-edge.** Manifold has no edge-select fillet
  operator, so rounding uses morphological opening/closing and affects every
  convex (or concave) edge at once. The dialog says so.
- **Voxel rebuild loses detail** finer than the chosen voxel size, and the
  repair report states the resolution used.
- **Self-intersection is invisible to the kernel.** `Manifold.ofMesh`
  validates topology only and accepts interpenetrating shells as `NoError`,
  double-counting the overlap volume. The repair pipeline therefore does not
  treat kernel acceptance as sufficient and escalates to the voxel rebuild
  when overlaps are present.
- **Deformers can fold a body through itself.** Parameters are bounded and
  the result goes through the manifold gate, which produces an explicit
  Hebrew error rather than a silently broken model.

## Known limitations

- Niqqud / combining marks and full bidi nesting are not supported in text
  layout; kerning uses the `kern` table only.
- Heavy geometry — including the document rebuild behind every edit — runs
  in a Web Worker with progress and cancel. Where the worker cannot start,
  the operation falls back to the main thread and says so honestly
  (`ranOn`); complexity caps refuse pathological inputs with a clear Hebrew
  message.
- Hollow/thicken simplify very dense meshes before the Minkowski step, so
  the effective wall thickness may deviate slightly on complex models (a
  warning says so).
- Orientation/support/warping analyses and the print estimates are
  transparent heuristics, not slicer output, and the UI says so everywhere
  they appear. The V6 estimate measures real slice geometry, but its speeds
  are documented workshop constants — always verify in your slicer.
- Dovetail connectors assemble by sliding sideways (the UI explains this).
- **Image import cannot see finer than one grid pixel.** The minimum-feature
  check measures on the downsampled grid, so at 60 mm across 200 px it reads
  in steps of 0.3 mm and cannot report anything thinner than that. Raise the
  resolution when the artwork has hair-fine strokes; the cap is 512 px.
- **The edge-preserving smoothing keeps 1-bit dither.** Amplitude alone cannot
  tell a dither pattern from real structure, so a hard alternating pattern
  survives where the old box blur merged it. In practice the decode
  downsamples to at most 512 px first, which turns a scanned halftone into
  greys before the filter runs.
- **Mask-brush strokes are session-only.** The design file stores the traced
  contours, not the source image, so strokes reloaded without the pixels they
  were painted on would have nothing to apply to. The dialog says so before
  you paint.
- **3MF import bakes rotation into the mesh.** Each body is rebased (centred
  in XY, resting on z=0) with the offset kept as the layer position, so a
  multi-object file keeps its arrangement and every layer has a usable pivot —
  but any rotation from the build transform lives in the geometry afterwards.
  A mesh layer has no original rotation to preserve.
- **OBJ groups are merged into one body**, and `.mtl` materials are not read;
  both are reported as notes at import. 3MF is the format to use when
  per-object colours matter.
- **GLB/glTF is not imported.** Binary glTF means accessors, a node hierarchy
  and possibly Draco; the use case that would have justified that weight does
  not exist here. Export from your tool as 3MF, OBJ or STL.
- **ZIP64 archives are refused.** A 3MF that large is past every other limit
  in the importer anyway; the message says to save it smaller.

### Remaining caveats

All V4/V5 features, all five V6 waves and all seven V7 items are implemented.
The honest limits worth repeating:

- **Per-edge fillet still does not exist — the local fillet is a
  workaround.** Manifold has no edge-select fillet operator. V6's "round
  the selected region" composes booleans (round a whole-body duplicate,
  keep it only inside the region's zone, keep the original elsewhere), so
  the result is watertight by construction — but an edge that continues
  past the region boundary shows a small STEP where rounded meets sharp.
  The UI says this before you click. True per-edge filleting would need a
  different kernel.
- **Booleans, cuts and connectors stay destructive.** The modifier stack
  covers unary operations on one body. Multi-body operations produce a
  different SET of layers rather than a different shape for one layer, so
  they are not expressible as a modifier.
- **Face paint now survives edits — within a catch radius.** Painted
  regions carry spatial anchors and re-project onto the rebuilt body by
  proximity and normal agreement. A region that MOVES far beyond its own
  triangle size (a large push-pull of the painted face itself) is dropped
  with the old honest warning rather than guessed at, and paint saved
  before V6 (no anchors) keeps the old discard behaviour.
- **The paint split at export runs in-process.** Everything else heavy is
  a worker job; the export-time split is a one-shot user action whose
  meshes double as live viewport buffers, which must not be transferred.
- **The incremental build cache is per-layer, not per-assembly.** Changing
  one layer rebuilds only that layer, but the assembly stage (base
  booleans, holes, first-layer compensation) always re-runs — it genuinely
  depends on multiple layers.
- **The batch CLI drives parameters and text content.** Other layer fields
  (colours, transforms) are not CSV-addressable; bind them to parameters
  where the field supports it.
- **`Editor.tsx` is composition, not logic** (1,384 lines, down from
  3,242). Its operations live in `hooks/**`, one hook per family, sharing
  the `EditorOps` object (`hooks/useEditorOps.ts`) rather than a web of
  closures. What remains is the panel layout, the viewport, and the dialog
  block — declarative JSX over state the shell owns, which would only get
  worse behind a component taking forty-five props.
- **`lib/serialization/designFile.ts` is long** (896 lines) but cohesive:
  one function per untrusted field, all serving the single job of turning
  arbitrary JSON into a valid document. Splitting it would scatter the
  primitives its sanitizers share.
