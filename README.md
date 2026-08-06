# PrintCraft STL Studio

A web studio for creating simple, genuinely 3D-printable STL files from custom
text — name plates, keychains, logo plaques and relief tiles — with a Hebrew,
right-to-left UI. Phase 1 focuses on deterministic, editable, printable
geometry (no AI generation).

## Getting started

```bash
npm install
npm run dev    # development server
npm run build  # production build (includes TypeScript checking)
npm start      # serve the production build
npm test       # unit + geometry-pipeline tests (vitest)
```

Open http://localhost:3000. A sample name-plate design is preloaded.

## Phase 1 features

- Single-page responsive editor: configuration panel + live 3D preview
  (rotate / pan / zoom / camera reset, grid, axes, preview colour).
- Templates: name plate, keychain (with hanging hole), logo plaque, relief tile.
- Text: content (multi-line), 4 bundled Hebrew-capable fonts, size, bold
  (where the family has a real bold cut), alignment, raised or engraved mode,
  depth/height and X/Y position — all in millimetres.
- Base: rectangle / rounded rectangle, width, height, thickness, corner radius.
- Keychain hole: diameter, edge distance, position (right / left / top).
- Validation panel: build status, model dimensions (mm), triangle count,
  watertightness, printability warnings (thin walls, shallow relief, engrave
  floor, text overflow) and blocking errors.
- Binary STL export (millimetres), enabled only when the mesh is verified
  watertight.

## Architecture and Geometry Decisions

### Module layout

| Layer | Files | Responsibility |
| --- | --- | --- |
| Types & limits | `lib/geometry/types.ts` | Explicit, typed design parameters (all mm), printability limits, parameter ranges |
| Validation | `lib/geometry/validation.ts` | Pure functions, no three.js imports — unit-tested in isolation |
| Templates | `lib/geometry/templates.ts` | Full `DesignParams` presets per template |
| Fonts | `lib/geometry/fonts.ts`, `lib/geometry/bidi.ts`, `lib/geometry/text.ts` | TTF loading (opentype.js), simplified bidi reordering, text → closed 2D contours |
| Kernel | `lib/geometry/kernel.ts` | **Geometry service abstraction**: extrude / cylinder / union / subtract behind an interface; implemented with Manifold (WASM) |
| Pipeline | `lib/geometry/buildModel.ts` | Parameters → validated, watertight, normalised solid |
| Inspection | `lib/geometry/meshStats.ts` | Triangle count, bounding box, edge-manifold (watertight) check |
| Export | `lib/export/stl.ts` | Hand-rolled binary STL writer (mm) |
| UI | `components/**`, `hooks/useModelBuilder.ts` | Editor controls, validation panel, debounced rebuild, R3F viewer |

### Why Manifold (manifold-3d) for booleans

The pipeline needs true solid booleans: raised text must be **unioned** with
the base and engravings/holes **subtracted**, so the exported STL is a single
closed solid rather than overlapping shells. We first evaluated
`three-bvh-csg`; it is fast, but its output leaves T-junctions along
intersection curves (thousands of edges not shared by exactly two triangles),
which fails a strict watertightness gate. Manifold is a guaranteed-manifold
kernel — every boolean result is watertight by construction — and its
Clipper2-based 2D layer (NonZero fill rule) also resolves overlapping font
contours robustly. The kernel is isolated behind `GeometryKernel` /
`Solid` interfaces in `lib/geometry/kernel.ts`, so it can be swapped without
touching the pipeline.

### Geometry conventions

- Units: millimetres everywhere (1 STL unit = 1 mm).
- Model space: Z-up (slicer convention). The base plate spans
  `z ∈ [0, thickness]`; raised text adds `+depth` above, engraving cuts
  `depth` into the top face.
- Text prisms overlap the base by 0.05 mm before union/subtract to avoid
  coplanar-face ambiguity.
- The keychain hole is subtracted as a cylinder that over-shoots both faces.
- Export placement: centred on the XY origin, lowest point at Z = 0.
- The exported mesh is verified **edge-manifold** (every edge shared by
  exactly two triangles) before the download button is enabled. This gate is
  defence-in-depth on top of Manifold's guarantees — non-manifold geometry is
  never exported silently.

### Text handling

- Fonts are static TTFs served from `public/fonts` (Alef, David Libre,
  Suez One, Varela Round — all support Hebrew + Latin) and parsed client-side
  with opentype.js. Parsed fonts are cached.
- Layout is done glyph-by-glyph (advance widths + kern pairs) instead of
  `Font.getPath`, because opentype.js 2.x's shaping engine throws on GSUB
  lookup formats present in some Hebrew fonts. Hebrew requires no mandatory
  shaping, so per-glyph layout is correct; niqqud (combining marks) are a
  known limitation.
- Hebrew is reordered with a simplified bidi algorithm
  (`lib/geometry/bidi.ts`): RTL runs are reversed, embedded Latin/digit runs
  keep their order. Full UAX#9 nesting is out of scope for Phase 1.
- Glyph outlines are flattened to polygons and resolved by the kernel's
  NonZero fill rule, which handles holes (counters) and overlapping contours.

### 3D preview

The viewer (`components/viewer/ModelViewer.tsx`) keeps the geometry Z-up and
instead sets the camera's up axis to +Z, so the on-screen model matches the
exported STL and any slicer view exactly. The preview mesh uses flat shading;
the preview colour is visual only and does not affect the export.

### Build orchestration

`hooks/useModelBuilder.ts` debounces parameter changes (250 ms), rebuilds in
an async effect, discards stale results by generation counter and disposes
replaced GPU geometries. Geometry runs on the main thread in Phase 1 (simple
plates build in tens of milliseconds); moving the pipeline to a Web Worker is
a planned next step for heavier reliefs.

## Known limitations

- Niqqud / combining marks and full bidi nesting are not supported in text layout.
- Bold is only available for families that ship a real bold cut (no synthetic bold).
- Kerning uses the `kern` table only (GPOS pair positioning is not applied).
- Geometry builds on the main thread; very large text may cause brief UI stalls.
- Printability checks are parameter-level (thickness, depth, wall) — no
  geometric overhang/small-feature analysis yet.

## Recommended next steps

- **SVG import** (Phase 2): parse SVG paths client-side (`svg-pathdata` or
  three.js `SVGLoader`), flatten curves to contours, and feed them to the same
  `GeometryKernel.extrude` used for text. Reuse the raised/engraved plumbing —
  an imported logo is just another contour set. Needed UI: file upload, scale
  to mm, position controls.
- **Image-to-relief** (Phase 2): decode PNG/JPG to a luminance grid on a
  canvas, downsample to a configurable resolution, then either (a) build a
  height-map grid mesh welded to the base (simple, dense) or (b) threshold to
  contours (`marching squares`, e.g. the `d3-contour` package) and extrude via
  the kernel for crisp high-contrast logos/stamps. Run in a Web Worker; cap
  output triangles and expose min-feature warnings.
- **Robust booleans**: already Manifold-based. Remaining work: move kernel
  calls into a Web Worker (Manifold supports it), reuse a single WASM instance
  across rebuilds, and add mesh simplification (`simplify()` in Manifold) to
  bound triangle counts on complex text.
- **AI image/text-to-3D integration** (later phase): keep the deterministic
  pipeline as the core product; add a server-side route (`app/api`) that calls
  a generation API (keys stay server-side), converts returned meshes to a
  Manifold solid (repair via `Manifold.merge`/hull as needed), then feeds it
  into the same validation/export path so AI output obeys the same
  printability gates.
- **Printability analysis**: add per-mesh checks — minimum feature size via
  distance sampling on contours, overhang detection from face normals versus
  the +Z build direction, island detection per Z-slice, and volume/weight
  estimates. Manifold's `slice()`/`project()` and triangle-normal scans cover
  most of this without new dependencies.
