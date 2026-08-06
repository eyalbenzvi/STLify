# Printable Product Studio (V2)

A browser-based studio for designing genuinely 3D-printable products — text,
SVG logos, PNG/JPG image reliefs, holes/pockets and product templates combined
as editable layers on a base plate — with a Hebrew, right-to-left UI, live 3D
preview, printability validation, cost/time estimation and STL / multi-part
ZIP / 3MF export.

**Session-based by design**: the active design lives only in browser memory.
There are no accounts, no server, no database, and no automatic persistence
(no localStorage / IndexedDB / cookies). The user saves and shares work through
portable `.formadesign.json` files, or (for small designs) a compact link whose
URL hash *is* the design data.

## Getting started

```bash
npm install
npm run dev        # development server
npm run build      # production build (includes TypeScript checking)
npm start          # serve the production build
npm test           # unit + geometry-pipeline tests (vitest)
npm run lint       # eslint (next/core-web-vitals + typescript)
npm run typecheck  # tsc --noEmit (strict)
```

Open http://localhost:3000. A name-plate design is preloaded.

## V2 features

- **Layer-based editor** ("שכבות"): base, text, SVG, image-relief and
  hole/pocket layers — select, rename, show/hide, lock, duplicate, delete,
  reorder; full transform (position/rotation/scale in mm), alignment against
  the base, fit-to-base, grid snapping. Clicking a part in the viewport
  selects its layer and vice versa.
- **Text**: multi-line, 4 bundled Hebrew+Latin fonts with a searchable font
  browser (categories, language support and 3D-suitability indicators,
  session favourites/recents), size, bold, letter/line spacing, alignment,
  direction override, raised/engraved/inlay modes, arc (curved) text, and
  mirrored text for stamps.
- **SVG logos**: upload with validation and sanitization (scripts, external
  refs, embedded HTML always stripped; unsupported features produce Hebrew
  warnings), 2D preview, holes preserved, raised/engraved/inlay, quality
  levels, flips, aspect-locked sizing.
- **Image reliefs (PNG/JPG)**: height-map pipeline with crop, rotations,
  flips, brightness/contrast, grayscale, invert, blur, posterize, B/W
  threshold; raised/engraved/silhouette modes; dark-high or light-high
  mapping; draft/standard/fine resolution with triangle-count warnings.
- **Automatic background removal**: fully client-side (border-seeded flood
  fill with colour clustering) in a Web Worker with progress + cancel,
  before/after preview, and a manual mask brush editor (erase/restore,
  local undo/redo) as refinement/fallback. Reversible — applying a mask
  registers a new asset version, so Ctrl+Z restores the original.
- **Product templates**: name plate, keychain, round medal (arc text), name
  tag (rear magnet pocket), fridge magnet, mirrored stamp, coaster (raised
  rim), wall plaque (frame + mounting holes), blank. Applying a template to a
  non-empty design asks for confirmation and can keep existing content layers.
- **Validation** ("בדיקת הדפסה"): parameter checks (sizes, depths, floors,
  hole/edge distances, build volume) plus mesh report (dimensions, volume,
  triangles, watertightness, components); three editable printability
  profiles (FDM/PLA, FDM/PETG, Resin/SLA); every issue has a Hebrew
  explanation, layer link, recommendation and technical details.
- **Automatic repair**: parameter-level fixes listed and confirmed before
  applying as a single undoable step; mesh-level weld/degenerate/manifold
  repair exists as defence-in-depth (`lib/geometry/repair.ts`). Nothing is
  ever changed silently.
- **Colours & multi-colour**: per-layer preview colours (palette, HEX,
  session recents), preview-only material appearances (matte/glossy/
  metallic), and an honest multi-colour mode — 4 named colour/material slots,
  per-layer assignment, flush inlay with configurable clearance, and export
  as separate STLs in a ZIP (with bilingual README) or a tested 3MF package.
  The UI states explicitly that STL cannot store colours.
- **Estimation**: material/weight/cost breakdown (infill-aware for FDM,
  per-litre for resin, electricity, machine wear, labour, packaging, markup
  and target-margin pricing) and a print-time *range* with confidence level —
  both clearly labelled as estimates requiring slicer verification.
- **Viewer**: rotate/pan/zoom, camera presets (iso/front/top/side), fit,
  grid/axes/build-plate toggles, selected-layer highlight, exploded view for
  multi-part designs, dimensions overlay.
- **Files & sharing**: export/import of portable `.formadesign.json` files
  (strict validation, SVG re-sanitization, embedded image assets); compact
  URL-hash share links for small designs only (with honest size and privacy
  notices); Undo/Redo (50 steps, in-memory, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y).

## Architecture

| Layer | Files | Responsibility |
| --- | --- | --- |
| Domain model | `types/design.ts` | Layers, transforms, settings, profiles, estimates, portable format — all mm |
| Design state | `lib/design/*` | Factories/defaults, templates, in-memory store (`useSyncExternalStore`), session asset store, session prefs |
| History | `lib/history/history.ts` | Pure undo/redo stacks with coalescing (in-memory only) |
| Geometry kernel | `lib/geometry/kernel.ts` | Manifold (WASM) behind `GeometryKernel`/`Solid` interfaces: extrude, booleans, transforms, offsets, mesh import |
| Build pipeline | `lib/geometry/buildDesign.ts` | DesignState → per-part watertight solids (base + raised/inlay parts; engraves/holes subtracted) |
| Geometry helpers | `text.ts`, `heightmapSolid.ts`, `marchingSquares.ts`, `lib/svg/*` | Text/SVG → contours, height-map slabs, mask contour extraction, SVG sanitization |
| Validation & repair | `validateDesign.ts`, `autofix.ts`, `repair.ts` | Parameter checks, undoable parameter fixes, mesh inspection/repair |
| Images | `lib/images/*` | Pure raster ops, height-field sampling, background removal (+ worker), browser codecs |
| Estimation | `lib/estimation/*` | Cost and time heuristics (pure, tested) |
| Serialization | `lib/serialization/*` | Portable design file (strict import validation), hash share links |
| Export | `lib/export/*` | Binary STL, multi-part ZIP + README, 3MF writer, safe filenames |
| UI | `components/**`, `hooks/*` | Editor shell, layer panel, per-layer property editors, dialogs, R3F viewer |

### Geometry conventions

- Units: millimetres everywhere (1 STL unit = 1 mm); model space is Z-up.
- Every exported artifact is real solid geometry: raised layers are unioned,
  engraves/holes subtracted, inlays get clearance pockets — never merely
  overlapping visual meshes. Solids overlap 0.05 mm before booleans to avoid
  coplanar ambiguity.
- Manifold guarantees watertight results by construction; `meshStats`/
  `repair.ts` re-verify edge-manifoldness as defence-in-depth.
- Image reliefs are closed height-map slabs (displaced top grid + walls +
  floor); transparent regions are clipped via marching-squares contours and a
  boolean intersection, so masked reliefs stay manifold.

### Key V2 decisions (documented trade-offs)

- **Background removal without an ML model**: an on-device border-seeded
  flood fill with k-means border clustering (Web Worker) instead of a
  hundred-MB neural model download. It handles the common logo/product/scan
  cases, is private, deterministic and cancellable; threshold mode and the
  manual mask brush cover the rest. No fake "AI" claims.
- **Automatic repair is parameter-first**: the design is parametric, so the
  honest repair path adjusts offending parameters (shown and confirmed
  beforehand, one undo step). Mesh-level weld/manifold repair exists but the
  kernel rarely lets broken meshes exist in the first place.
- **3MF is implemented and tested** (OPC package, millimetre units, per-part
  `basematerials` colours) alongside the always-reliable separate-STL ZIP.
- **No bevel controls**: Manifold has no robust offset-loft; a fake bevel
  that breaks on concave outlines would violate the "no dishonest geometry"
  rule, so bevels were deliberately left out.
- **TypeScript 5.9**: the repo moved from the experimental TS 7 preview back
  to stable 5.9 so typescript-eslint and the full lint pipeline work.

## Known limitations

- Niqqud / combining marks and full UAX#9 bidi nesting are not supported.
- Kerning uses the `kern` table only; bold requires a real bold cut.
- SVG conversion targets filled shapes; stroke-only paths convert as outlines
  (with a warning), and filters/masks/gradients are ignored (with warnings).
- Geometry builds on the main thread (debounced); very fine image reliefs can
  cause brief stalls — the resolution warnings exist for this reason.
- Printability analysis is parameter + mesh-statistics level; no per-face
  overhang or slice-based island analysis yet.
