# V5 Implementation Plan — Waves A, B, C

Derived from the three-expert review. The governing finding: the geometry
engine is well ahead of the product. Roughly a third of what exists cannot be
reached by a user, and one subsystem (the geometry worker) was built but never
called. No new engine capability is planned here except where a printing
workflow genuinely lacks one (Wave C).

## Wave A — make what exists reachable

| # | Item | Files | Definition of done |
| --- | --- | --- | --- |
| A1 | Primitive + sketch properties | `PropertiesPanel.tsx`, new `SketchEntityEditor` | Every primitive parameter editable; sketch entities add/edit/delete |
| A2 | Route heavy ops through the worker | `useGeometryJobs.ts`, `Editor.tsx` | Fillet/shell/lattice/voxel/remesh/repair run off-thread with progress + cancel |
| A3 | Sub-object selection UI | `SceneView.tsx`, new `SubObjectPanel` | Hover highlight, click to select, grow modes, push/pull, local smooth, delete, split |
| A4 | Error boundary | new `ErrorBoundary.tsx`, `app/page.tsx` | A throw in the canvas or a panel shows a recovery card, not a blank page |
| A5 | Hierarchy, pivot, Revolve | `LayerListPanel.tsx`, `TransformPanel.tsx`, `advancedOps.ts` | Re-parent from the layer list; pivot editable; revolve a sketch/SVG |
| A6 | Curved emboss dialog | `AdvancedDialogs.tsx`, `advancedOps.ts` | Wrap/project a text or SVG layer onto a target body |

## Wave B — keep it from breaking

| # | Item | Files | Definition of done |
| --- | --- | --- | --- |
| B1 | Decompose the god component | `hooks/useGeometryOps.ts`, `useImportExport.ts`, `useAnalysisRunner.ts` | `Editor.tsx` well under 1200 lines; no behaviour change |
| B2 | UI regression tests | `e2e/*.spec.ts` | Critical journeys covered end to end in a real browser |
| B3 | Accessibility | `NumberField`, `ToggleGroup`, `Section`, `Modal` | Labelled controls, focus trap, Escape, keyboard reachable |
| B4 | Binding field validation | `expression.ts`, `documentValidation.ts` | A binding naming a non-existent field is reported, not swallowed |

## Wave C — make prints succeed

| # | Item | Files | Definition of done |
| --- | --- | --- | --- |
| C1 | Support generation | new `analysis/supports.ts` | Pillar supports under overhangs, with exclusion regions, exported as a part |
| C2 | Measured clearance | `types/profiles.ts`, all clearance consumers | One calibrated value drives holes, connectors, inlays, threads, enclosures |
| C3 | User printer profiles | `types/profiles.ts`, new dialog | Define, edit, export and import a printer |
| C4 | Per-face material painting | `types/design.ts`, `buildDocument.ts`, `SceneView.tsx` | Paint regions; export separates them as parts |
| C5 | Elephant-foot compensation | `analysis/`, `buildDocument.ts` | First-layer XY inset by a profile parameter |
| C6 | Lattice vs nozzle check | `operations/lattice.ts` | Refuse or warn when struts are thinner than the nozzle can print |
| C7 | Thread chamfer + fit class | `generators/index.ts` | Lead-in chamfer; 6H/6g/loose classes drive clearance |
| C8 | Bridging analysis | `analysis/bridging.ts` | Unsupported horizontal spans detected and reported |

## Verification standard

Every item ships with tests that assert a measurable consequence — geometry
against analytic values, or a real browser journey. `npm test`, `npm run lint`,
`npm run typecheck` and `npm run build` must all pass at the end of each wave.

## Outcome

All three waves are implemented. Two notes where the result differs from the
plan, recorded rather than quietly dropped:

- **B1 fell short of its target.** `Editor.tsx` reached 2,458 lines at the
  end of Wave B (from 2,839) and finished at 2,677 once Wave C added
  calibration, supports, bridging and painting to it — nowhere near "well
  under 1200". Import and analysis handling moved out cleanly; the operation
  handlers share a dense web of state that would have to be lifted into the
  store before they can follow, which is a larger change than this wave
  allowed for. The file is still growing, so this is the first thing to fix
  next.
- **C4 splits at export, not at build.** The plan named `buildDocument.ts`,
  which would have made every rebuild carve the painted regions out of the
  body. That is wasted work while modelling and — worse — it changes the
  triangle indices the paint is recorded against, so the paint would
  invalidate itself on the very next rebuild. The split therefore runs in the
  export path, and the viewport shows the paint as a coloured overlay.

Verification at the end of Wave C: 403 unit tests, 16 Playwright journeys,
`eslint` clean (9 pre-existing hook-dependency warnings), `tsc --noEmit`
clean, `next build` clean.

## External review

Two independent reviewers — a senior code auditor and a QA engineer — went
over the three waves after they were committed. Between them they confirmed
two shipping blockers and around twenty smaller defects; all are fixed, and
each fix is pinned by a test that measures the thing that was wrong.

The two blockers were the same species: a pure function that was right, and
the place where it met the document that was wrong and untested.

- **Elephant foot** refined the whole part (12 -> 65,292 triangles on a cube,
  2 million on a 150mm plate, 6.6s per debounced rebuild) and, at the panel's
  own minimum fade height, aborted the WASM module for the rest of the
  session with no error shown and no recovery. It also contracted vertices
  radially towards the part centre, which CLOSED holes at the bed — the exact
  opposite of the correction, fighting the hole compensation shipped beside
  it.
- **Paint depth** greater than the wall it was painted on inverted the offset
  shell. The kernel reports negative-volume solids as `NoError`, so a
  1mm-walled tube of 2,446mm3 exported as 7,102mm3 of parts.

The lesson recorded for next time: three of the four worst defects were in
code that had passing tests. The tests asserted direction ("volume went
down") where they should have asserted magnitude and sign, and none of them
crossed a module boundary. Two features — the lattice nozzle check and the
thread fit classes — were fully tested and completely unreachable from the
UI.
