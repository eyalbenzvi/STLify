# PrintCraft STL Studio — V4

A browser-only studio for designing genuinely 3D-printable models — text,
SVG artwork, image silhouettes/reliefs and imported STL files — with a
Hebrew, right-to-left UI. V3 added a layer-based 3D editor and print
preparation tools; V4 adds real modelling — creating geometry from nothing,
reshaping it, and repairing broken meshes.

Everything runs locally in the browser. There is **no AI, no server-side
generation, no accounts and no persistence**: the active design exists only
in the current browser session, and users save/restore work via portable
`.formadesign.json` files.

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

## V4 features

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
| Import | `lib/import/{stl,svg,image}.ts` | Validated STL/SVG/image parsing → mesh data / contours |
| Export | `lib/export/{stl,stlData,zip,package}.ts` | Binary STL, dependency-free ZIP (STORE), multi-part package |
| Serialization | `lib/serialization/designFile.ts` | Portable `.formadesign.json` v3 with strict validation |
| History | `lib/history/history.ts` | In-memory undo/redo (session only) |
| Repair | `lib/geometry/repair/*` | Topology analysis, hole filling, self-intersection, voxel remesh, component cleanup, staged repair pipeline |
| Spatial index | `lib/geometry/bvh.ts` | Triangle BVH: closest point, ray crossings, overlap pairs |
| Sketch | `lib/geometry/sketch.ts` | 2D sketch entities compiled to contours |
| Generators | `lib/geometry/generators/*` | Threads, gears, enclosures, hinges, clips, tolerance coupons |
| UI | `components/**`, `hooks/useDocumentBuilder.ts` | RTL Hebrew editor, R3F viewer, dialogs |

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
- Geometry runs on the main thread (no Web Workers yet): very heavy
  operations (hollow on complex meshes) show a busy indicator and may pause
  the UI briefly; complexity caps refuse pathological inputs with a clear
  Hebrew message.
- Hollow/thicken simplify very dense meshes before the Minkowski step, so
  the effective wall thickness may deviate slightly on complex models (a
  warning says so).
- Orientation/support analysis is a transparent heuristic, not slicer
  output, and the UI says so everywhere it appears.
- No 3MF export (no tested implementation existed); dovetail connectors
  assemble by sliding sideways (the UI explains this).

### Not yet implemented (planned)

These were scoped for V4 but are not in this release:

- Sub-object (face / edge / vertex) selection, and the direct-editing tools
  that depend on it: push/pull, per-edge fillet, local smoothing, split by
  paint.
- Projecting or wrapping text and SVG onto curved surfaces.
- A non-destructive modifier stack and named parameters with expressions —
  operations still bake to meshes.
- Layer grouping / parent-child hierarchy and pivot editing.
- Isotropic remeshing (the kernel exposes refinement and smoothing, but
  there is no edge-split/collapse/flip remesher).
- Moving geometry off the main thread into a Web Worker, mesh-store
  reference counting, and local crash recovery.
- Viewport snapping to vertices/edges/faces, angle and radius measurements,
  and an undo-history panel.
