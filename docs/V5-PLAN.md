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
