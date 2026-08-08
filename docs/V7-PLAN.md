# V7 Implementation Plan — Import

Everything in V7 sits at the IMPORT boundary: the place where an image, a
photo or someone else's model file becomes geometry this tool can prepare for
printing. That boundary was the weakest part of the app. The threshold was a
guess made before seeing a contour, smoothing quietly rounded off the corners
it was meant to protect, background removal compared colours in a space that
does not match how they look, the one documented escape hatch did not exist,
and two mainstream formats could not be read at all.

The governing definition every item below was checked against:

> The software prepares print files for a 3D printer. It is NOT for
> distribution and NOT for selling products. The goal is preparing print
> files well, without complicating the user beyond need.

And the three tests that follow from it:

1. **Decisions.** A good feature REDUCES the number of decisions the user has
   to make. A new knob is a cost. Invisible improvement beats automatic with a
   notice, which beats a new control.
2. **Slicer duplication.** Anything the slicer does better, and that the user
   reaches anyway, is wasted work here.
3. **Scale.** One user, one machine, no distribution. No abstractions for
   users who do not exist.

Two absolute rules inherited from the charter, restated because every item was
checked against them:

1. **No AI.** No models, no cloud inference, no ML libraries, no network
   calls. Every heuristic stays deterministic and explained in Hebrew.
2. **No accounts, no server, no sync, no telemetry.** All storage is
   device-local. The README privacy paragraph must remain true word for word.
   It does — nothing in V7 sends, stores or syncs anything.

## The items

| # | Item | Files | Definition of done |
| --- | --- | --- | --- |
| 1 | Minimum-thickness check at the image stage | `lib/import/image.ts`, `components/dialogs/ImportDialogs.tsx`, `hooks/useImportHandlers.ts` | A hairline stroke reports the violation with the measured width and the machine's minimum; thickening produces contours whose thinnest feature clears the nozzle; a thick image reports nothing |
| 2 | Otsu automatic threshold | `lib/import/image.ts`, `ImportDialogs.tsx` | A design saved before the change rebuilds to identical geometry after it; a bimodal image gets a threshold that separates its two populations |
| 3 | Bilateral filter replacing the box blur | `lib/import/image.ts` (`smoothGrid`) | A step edge stays sharp where the box blur measurably smeared it; noise is still reduced; a traced corner stops being eaten |
| 4 | Perceptual colour distance in background removal | `lib/import/removeBackground.ts` | A subject differing in hue but not lightness is kept where the RGB metric ate it; the existing cases still pass; the 0..100 scale still means what it meant |
| 5 | Manual mask brush | `ImportDialogs.tsx`, `lib/import/image.ts`, `removeBackground.ts` (comment) | An e2e journey imports a scan whose automatic result is wrong, brushes the correction, and asserts the BUILT SOLID changes |
| 6 | 3MF and OBJ import + triangle budget | new `lib/import/{threeMF,obj,zipRead,xmlLite,triangleBudget}.ts`, `hooks/useImportHandlers.ts`, `components/editor/EditorHeader.tsx` | Writer → reader round trip green; a multi-object 3MF becomes multiple layers placed by their build transforms; an OBJ with negative indices parses; a hostile file is refused with a Hebrew message and no throw escaping to the UI |
| 7 | Contour vectorisation | `lib/import/image.ts` | A circle traced from a raster is measurably closer to a true circle with fewer points than Douglas-Peucker needed; a shape with a hole still extrudes with the hole open |

## What each item actually does

**1 — Minimum feature size, early.** The wall-thickness analysis already finds
strokes the nozzle cannot resolve, but it runs on a finished solid: by then
the threshold, the resolution and the artwork are all behind the user. Same
check, different moment, and the moment is the whole feature. An exact
Euclidean distance transform of the solid mask measures the narrowest stroke
and compares it with two extrusion widths — the same minimum the lattice check
uses, read through `documentNozzleDiameterMm` so it reflects the document's
machine.

**2 — Otsu.** The luminance threshold was the first thing the dialog asked for
and the last thing anyone could answer. It now comes from the image.

**3 — Bilateral smoothing.** The "smoothing" control was also a "lose the
corners" control. It is not any more.

**4 — CIELAB.** RGB distance put yellow and orange 75 units apart, closer than
the default tolerance, and split near-identical dark tones. Both errors showed
up as holes in the subject or background left standing.

**5 — The brush.** `removeBackground.ts` promised it in a comment. It did not
exist. Now it does, and the comment names the component so the claim can be
checked rather than believed.

**6 — 3MF and OBJ.** One picker, three formats, and a triangle budget so a
900,000-triangle scan does not make the editor unusable.

**7 — Curve fitting.** Contours stop being restricted to points that sit on
the marching-squares staircase.

## Outcomes — what happened, honestly

- **`docs/V7-RESEARCH.md` does not exist in this repository.** The brief said
  to read it first. It is not in `docs/`, not in git history, and not on any
  branch. The work was derived from the brief itself plus the README and the
  code, and the gap is recorded here rather than papered over.

- **Item 1 ships a checkbox, which the decisions test says to avoid.**
  Thickening is on by default with a Hebrew notice, so the common path costs
  no decision — but it IS a control. A stroke under the minimum does not come
  out at all, so the default has to correct it; the checkbox exists because
  auto-editing someone's logo without any way to decline is worse than one
  checkbox. Recorded as a deliberate exception, not an oversight.

- **Item 1's measurement is restricted to the distance field's RIDGE, and
  that is not a detail.** Without the restriction, the tapering tip of a serif
  or an arrowhead reads as a hairline — which is true of essentially every
  piece of artwork — and a check that fires on everything says nothing. The
  first attempt at a test for this was wrong in an instructive way: a wedge
  that tapered too slowly ended in a genuine several-pixel hairline run, and
  the check correctly flagged it. The test was fixed, not the code.

- **Item 2's stated regression trap was smaller than the brief feared, and
  the test is worth more than the fix.** The rebuild path reads the layer's
  STORED contours, not its threshold, so Otsu at import time was never at
  risk of reshaping saved designs. The frozen V6-era design file in
  `lib/serialization/__tests__/savedDesignRebuild.test.ts` pins that anyway:
  change the stored threshold, resolution, smoothing or invert flag and the
  rebuilt vertices must come out identical, because nothing on that path may
  consult them.

- **Item 4's stored-tolerance trap does not exist either, and saying so
  matters.** `bgToleranceMm` is never written to the design file — the image
  layer stores only the tracing settings — so the exposure was the dialog's
  own default, not every saved document. The 1:1 ΔE mapping was still chosen
  and pinned by a test so the default behaves as it did: along the grey axis,
  where backgrounds mostly live, the old RGB span measures 27 ΔE at grey 40,
  23 at grey 128 and 22 at grey 180.

- **Item 3 has an accepted trade, stated rather than discovered.** Amplitude
  alone cannot separate 1-bit dither from real structure, so a full-amplitude
  alternating pattern is now preserved where the box blur merged it. The
  decode downsamples to at most 512 px first, which turns a scanned halftone
  into greys before the filter runs. There is a test whose entire job is to
  document this.

- **Item 3 replaced an existing test, with a reason.** The old `smoothGrid`
  test asserted only "variance goes down", which the box blur achieved by
  smearing edges as readily as noise — the exact behaviour being replaced. It
  could not have caught this, and four tests that can took its place. The old
  box blur is kept IN the test file as the reference the new filter has to
  beat.

- **Item 5's three design traps were all settled by one decision.** Strokes
  are stored in NORMALISED image coordinates with the radius as a fraction of
  the larger side, not in grid pixels. A resolution change re-rasterises the
  same marks instead of needing a re-map or an invalidation notice, and
  brightness/contrast changes cannot touch them because they never depended on
  the decode's output. The third trap — persistence — is answered
  session-only, and the dialog says so: the design file stores traced
  CONTOURS, never the source image, so strokes reloaded without the pixels
  they were painted on would have nothing to apply to.

- **Item 5's e2e test failed in a way worth recording.** A fresh `<canvas>`
  reports width 300 before anything is drawn, so the obvious readiness poll
  ("width > 2") passed instantly and let the drag arrive while the brush was
  still inert. It passed alone and failed in suite. It now waits for the
  preview placeholder to clear and for the canvas to take the grid's own
  width, and drags with element-relative positions because the dialog scrolls.

- **Item 6 uses a hand-written XML scanner rather than DOMParser.** Two
  reasons, and the second is the important one: DOMParser is browser-only, so
  the 3MF round-trip test could not have run in the node suite — and a
  hand-written scanner makes the security posture a property of this code
  rather than of whatever engine is underneath. There is no DTD subsystem to
  disable and no resolver to point at a URL because neither exists.

- **Item 6 keeps `provenance.kind = "stlImport"` for all three formats.** The
  design file's sanitizer collapses every non-print-aid kind to it on save, so
  a new name would not survive a round trip. The type comment says so now
  instead of implying STL is the only source. Supports read out of a 3MF DO
  keep `supportResult`, which the sanitizer preserves, so re-exporting still
  tells the slicer to print a removable aid.

- **Item 6 renamed the picker instead of adding two.** "ייבוא STL" became
  "ייבוא מודל" accepting `.stl,.3mf,.obj`. One control where three would have
  been, which is the decisions test applied to a header rather than a dialog.

- **GLB was not implemented, as instructed**, and neither was anything from
  the out-of-scope list: no AI, no slicer-project 3MF, no lithophane, no
  colour-based thresholding, no HEIC depth maps, no raised resolution cap, no
  graph-cut segmentation, no plate packing, no slicer.

- **Item 7 did not deliver "far fewer points", and the brief asked for it.**
  Measured on traced disks at 1 mm pixels, worst deviation from a true circle
  against point count, old → new: r=20, 0.92 mm/45 pts → 0.47 mm/36 pts; r=30,
  0.89/73 → 0.48/56; r=40, 1.01/73 → 0.46/60. Roughly half the deviation at a
  fifth fewer points. A fifth is not "far fewer", and a traced SQUARE actually
  costs MORE points than before — 16 against 9 — because its corner samples
  are now kept exactly rather than cut across. Its area is identical to the
  last hundredth. That is the trade, and it is the right way round for a tool
  that prepares print files, but it is not what the brief predicted.

- **Item 7's corner handling is where the work was.** The fit tolerance has to
  be at least the size of the grid quantisation — that is what lets it average
  the staircase away — and any tolerance-bounded fit is then free to cut a
  sharp corner by that much. Corners therefore have to be found geometrically
  and pinned as segment ends. A raster corner is also not one sample: marching
  squares turns a right angle into a 45° diagonal, so 90° of turn arrives
  spread over three or four samples with no single dominant one. Pinning only
  the sharpest still let the fit smooth across the shoulders, and the square
  test caught it. Corners are now confirmed by a peak (65° over a 2.5-pixel
  window) and pinned as the whole run above a shoulder threshold (30°) — a
  shape that also keeps small circles smooth, since they sit above the
  shoulder all the way round but never peak.

- **Item 7's flattening slack is measured, not guessed.** 1.5× the fit
  tolerance drops the point count by a fifth and leaves the deviation
  unchanged; past 2× the deviation starts to climb.

- **No new runtime dependencies.** Inflate is the platform's
  `DecompressionStream("deflate-raw")`, the ZIP reader and XML scanner are
  written here, and the curve fitting is written from scratch because potrace
  is GPL.

- **Numbers.** Baseline on arrival: 39 test files, 482 tests, lint and
  typecheck clean. On completion: 44 test files, 561 tests, 29 e2e journeys,
  lint clean with zero warnings, typecheck clean, `npm run bench` inside its
  thresholds.

## Review round — what the audit found after the fact

Everything above shipped green, and then a code review plus an adversarial
security pass over the same diff found nine defects. Eight were in item 6, the
part of the work whose module headers make the loudest safety claims, which is
the lesson: the files that assert they are hardened are the files to distrust.
Each is now a regression test in `lib/import/__tests__/importSecurity.test.ts`,
and eleven of those eighteen cases fail against the pre-review parsers.

- **The ZIP budget was computed from numbers the attacker supplies.** The
  running total summed the DECLARED `uncompressedSize` of each entry, so an
  archive declaring 0 everywhere never advanced it and every entry was handed
  the full budget. With several central-directory records aliased onto one
  local header, a **41 KB** file delivered **335 MB** past a 256 MB limit. The
  budget now counts bytes as they actually arrive; the declared total survives
  only as a cheap early refusal for honest files.
- **The XML attribute scan was quadratic.** A global regex whose name pattern
  backtracked at every start position: 4× the input cost 14.5× the time, and a
  200 KB tag body — a legal size for a file this importer otherwise accepts —
  blocked the main thread for **43 seconds**. Replaced by a hand-rolled linear
  scan: the same input now takes **2 ms**.
- **A raw English `RangeError` escaped to the UI.** `String.fromCodePoint` on
  an out-of-range numeric character reference (`&#x110000;`) threw "Invalid
  code point 1114112" straight past the "every refusal is a Hebrew message"
  claim. Out-of-range references, surrogates and control characters are now
  refused in Hebrew instead of being thrown on or carried into layer names.
- **`unit="constructor"` produced NaN geometry, silently.** `UNIT_SCALE` was
  an object literal, so the lookup walked the prototype chain and answered with
  `Object` — truthy, so the `?? 1` fallback never fired and the scale became a
  function. Every coordinate came out NaN, and `"constructor" in UNIT_SCALE`
  was also true so even the unknown-unit warning was skipped. It is a Map now,
  and attribute records are null-prototype.
- **The 3MF geometry cap bounded parsing, not output.** Triangles were counted
  once per object at parse time, leaving the component graph free to place that
  object any number of times. A **2.8 KB** file with a 140×140 fan-out DAG — no
  cycle, inside the expansion budget — produced 19,600 bodies and **5.9 million
  triangles against a 1 million cap**, and 141 MB of mesh. The budget is now
  spent per placement.
- **`maxObjects` measured the wrong thing.** It compared against the object
  map's `size`, and duplicate ids overwrote each other, so 3,000 fully parsed
  objects passed a cap of 512. It counts elements now, and duplicate ids are
  refused outright, which the Core spec requires anyway.
- **OBJ allocated before it checked.** `maxFaceCorners` was enforced after
  `split()` had already materialised the array, and lines came from
  `text.split(/\r?\n/)`, which builds one entry per line before reading any of
  them: 20 M newlines cost 300 MB and 3.7 s. Lines are now walked by index with
  a length cap — 8.7 MB and 369 ms.
- **`triangleBudget.ts` ignored the kernel's own instruction.** `kernel.ts`
  says new multi-step pipelines should use `withSolidScope` rather than a
  manual dispose chain, and this was a manual chain that leaked the live handle
  when `simplify` threw. It runs in a scope now, with a `liveSolidCount()`
  assertion on the happy path, the early return and the throwing path.
- **The new error classes were not registered in `hebrewMessageOf`.** Their
  Hebrew text reached the user only because each passes `messageHe` to
  `super()` — the guarantee was an accident of construction rather than
  something the error handler stated. Registered.

And one product defect, outside item 6, that only a full-pipeline test could
see: **a single dust pixel silently thickened the whole artwork.** The
minimum-feature check measured the global thinnest ridge, so one stray dark
pixel on a scan reported a 0.30 mm "feature" and dilated everything — a
60-pixel logo square grew 5.6% — to correct a mark the tracer discarded before
it reached the output, while the notice named a stroke width the user could not
find anywhere in their drawing. The check now ignores components below the same
speck area the tracer drops, sharing one constant so the two cannot drift, and
labels them 8-connected so a genuine one-pixel DIAGONAL hairline is still
caught.

Worth stating plainly: the two reviewers were run in parallel and both died
before reporting. What they left behind was their throwaway probe files, and
those probes are where six of the nine findings came from — including the two
worst. The findings were re-derived and re-confirmed from the probes rather
than taken on trust, and the probes themselves were deleted.
