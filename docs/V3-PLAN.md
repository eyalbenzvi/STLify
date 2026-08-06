# V3 Implementation Plan — Advanced 3D Editor and Print Preparation

## Reality of the codebase (Phase 0 audit)

The repository contains the Phase 1 ("V2 core") application only:

- Text→STL pipeline: opentype.js → contours → Manifold (WASM) kernel → watertight solid.
- Templates (name plate / keychain / logo plaque / relief tile), base plate, keychain hole.
- Parameter validation (Hebrew messages), mesh stats + edge-manifold gate, binary STL export.
- R3F viewer (Z-up), debounced rebuild hook, RTL Hebrew UI (Tailwind 4).
- 33 passing vitest tests (validation, bidi, pipeline smoke).

Features the V3 brief attributes to "V2" that do **not** exist in the repo (SVG upload,
image relief, layer editing, undo/redo, portable design files, cost estimation,
multi-color export) are treated as *new* work, built as part of the V3 layer
architecture. Nothing existing is removed; the template flows are preserved as
documents in the new model and covered by regression tests.

## Architecture

- `types/design.ts` — full domain model: `DesignDocument`, layer union
  (`BaseLayer | TextLayer | SvgLayer | ImageReliefLayer | ImportedMeshLayer | HoleLayer`),
  `Transform3D` (mm/deg TRS), operations, measurements, portable-file types.
- `types/profiles.ts` — printer / material / printability / usage profiles.
- `lib/geometry/kernel.ts` — extended Manifold wrapper: union/subtract/intersect,
  `transform(Mat4)`, `splitByPlane`, `trimByPlane`, `slice`+`offset` (hollow/thicken),
  `decompose`, `simplify`, `hull`, mesh⇄solid conversion, volume/area/bbox.
- `lib/geometry/meshData.ts` + `meshStore.ts` — transferable/serializable mesh
  payloads (positions + indices), session-scoped store keyed by id.
- `lib/geometry/solids.ts` — per-layer solid builders (base, text, SVG, hole,
  bevelled extrusion via stacked CrossSection offsets).
- `lib/geometry/buildDocument.ts` — document → printable parts:
  - `withBase`: base ∪ raised ∖ engraved ∖ holes (V2 behaviour, now per-layer transforms).
  - `baseless`: each visible root layer is an independent closed solid.
- `lib/geometry/operations/*` — booleans, plane cut, split, connectors, hollow,
  drain holes, thicken, smooth (Taubin), simplify, placement (drop/center/align/
  distribute/mirror/scale-to-size/place-on-surface).
- `lib/geometry/analysis/*` — overhang, plate contact, floating parts, build
  volume, sampled wall thickness (BVH raycasts), orientation scoring, print
  time/cost heuristics.
- `lib/import/*` — SVG (path→contours), STL (binary+ASCII), image (silhouette /
  relief height-map), all with validation and Hebrew errors.
- `lib/export/*` — binary STL (existing), hand-rolled ZIP (STORE), multi-part
  package with HE/EN README, portable `.formadesign.json` v3 with schema
  validation and migration hooks.
- `lib/history/` — in-memory snapshot undo/redo (documents are immutable JSON
  values with structural sharing; meshes live in the mesh store).
- `components/editor|viewer|dialogs/*` — layer panel, properties, transform
  toolbar + gizmos (drei TransformControls), analysis panels, export dialog.

## Non-goals / honest limitations (documented in final report)

- No AI or server-side generation, no persistence (session only), no 3MF (no existing
  tested implementation), no real slicer supports; orientation/support output is
  labelled as heuristic guidance in Hebrew.
- Hollow/thicken use slice-based Clipper2 offsets (approximation documented).
- Geometry runs on the main thread (Manifold WASM); progress indicators +
  debouncing instead of Web Workers in this iteration.

## Order of work

types → kernel → pipeline+store → viewer/gizmos → import → ops → analysis →
inspection tools → portable file/export → a11y/notice → tests/lint/build.
