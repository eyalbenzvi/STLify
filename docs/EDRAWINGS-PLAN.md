# eDrawings Import — Plan, Findings and Decisions

eDrawings files (`.easm` assemblies, `.eprt` parts) are SOLIDWORKS' viewing
format. There is no public specification and no open-source reader, so this
importer was written by decoding a real file: a SOLIDWORKS 2025 floor-plan
assembly (HSF V20.90, 12 components, 5,204 faces, 3.3 MB). This document
records what was learned about the format, what the plan was, which gates it
passed, and where it deliberately stops.

## Gates

The plan set three go/no-go gates. Their outcomes:

| Gate | Question | Outcome |
| --- | --- | --- |
| A | Can the container be opened? | **Passed.** A plain ZIP at offset 0 (no proprietary header): `eModel`, `preview.jpg`, `materials.xml`, `scene.xml`, `OLE`. |
| B | Can the "allow STL export" flag and password protection be identified? | **Partly.** Password protection: a protected model is not readable as an HSF stream, so it is refused with a message telling the user to save an unprotected copy. **The STL-export flag was NOT identified**: finding it needs two files that differ only in that option, and only one file was available. Instead of reading the flag, the import screen asks the person importing to confirm they own the model or have the owner's permission, and says plainly that the file's own setting cannot be read yet. The raw `OLE` record (12 bytes, `50 46 00 …`, a likely candidate) is kept on the parsed model so the comparison can be made as soon as a second file exists. |
| C | Does the geometry decode? | **Passed, without Edgebreaker.** SOLIDWORKS writes uncompressed float32 positions and byte/short triangle strips, so the hardest component of the original plan was not needed for this file. Edgebreaker, compressed points and other encodings are detected and refused with a Hebrew message naming the encoding, never guessed at. |

Validation against ground truth that does not depend on our own reading:

- the file's own mass properties (`/config0/massprops`: `volume=82.66` m³)
  against the decoded volume, 83.00 m³ (a 0.4% difference, consistent with
  display tessellation);
- a component of known size: the "sf900 floor model" decodes to
  2.772 × 1.685 × 2.281 m, which is the published footprint of a Stratasys F900;
- every one of the 5,204 placeholders filled, every triangle strip in range.

## What the format looks like

```
.easm  (ZIP)
 └─ eModel  (HSF stream)
     ;; HSF V20.90\n            header comment
     I <int32>                   file info
     B <2 bytes> <6 × float32>   bounding box
     Z <zlib …>                  everything else is compressed
        [ user data ]            producer block (SOLIDWORKS version string)
        segment tree             configurations, components, matrices, includes
           …faces as NULL placeholder shells, each followed by a tag (q)…
        <pause>
        ( ?Include Library/references
           S …                   one real shell per placeholder, naming its tag
        )
        s / l …                  edge pass (not needed for printing)
        z                        end of compression
     \0
```

The two-pass structure is the key: in the segment tree each SOLIDWORKS face is
written as an empty shell (`S`, sub-option `0x90`, sub-option-2 `NULL`)
immediately tagged with `q`; tags are numbered in stream order. The geometry
pass then writes real shells whose first field is the tag of the placeholder
they fill. The tree gives each tag its place: modelling matrices (`%`, a 4×3
row-major matrix, row-vector convention) compose from the leaf outwards, and
shared bodies are opened once at an absolute path (`/include library/shared/
bodyN`) and pulled into each component instance with an include (`<`).

A real shell (sub-option `0x0e`: compressed faces + triangle strips +
optionals):

| Field | Encoding |
| --- | --- |
| leading byte | always 0 |
| sub-option | `0x0e` |
| tag | int32 |
| LOD level | byte (0 = full resolution; others ignored) |
| point count | int32 |
| points | float32 × 3 × count, metres |
| face scheme | byte, 1 |
| face bytes | int32 length, then a bits byte (8 or 16) and the strip stream `[count, i0, i1, …]…` |
| optionals | `0x01` compressed normals (scheme, bits, int32 length, data) · `0x1c` UV parameters (width byte, floats) · `0x63` nested attribute opcodes (the face's `swfaceid`) up to a 0 · `0x00` end |

Opcodes implemented: `( ) ; I B Z z [ ] U` and its UTF-16 variant `0x16`,
`h J ~ " q < % } = @ - S`, edge weight/pattern `0x0e 0x0d`, pause `0x01`,
padding `0x00`. Two opcodes are understood only partly — heuristics (`H`) and
visibility (`V`), whose payload length varies with bits not yet decoded. They
carry rendering switches only, appear a handful of times per file, and are
skipped by choosing the candidate length after which the stream continues with
a plausible opcode. This is the one heuristic in the reader and it is confined
to opcodes that never carry geometry.

HSF has no generic length field, so an unknown opcode cannot be skipped. The
reader stops there and the model layer counts: if every placeholder was
filled, what remains is the edge pass and nothing is lost; if not, the import
screen shows exactly how many faces were decoded out of how many.

Component metadata comes from user options: `name=` on each placed instance,
the default display state (`/configN/displaystates/…`, `vis=on|off`) for
components hidden in the file, `config name=` and the mass properties.

## Units and orientation

SOLIDWORKS stores eDrawings geometry in metres. The importer converts to mm
and, when the file carries mass properties, compares the decoded volume with
them — "verified" in the screen means units and geometry agree independently.
The up axis is kept as stored by default (the sample is Z-up even though its
`scene.xml` says Y-up, so that field is not trusted); the screen offers
"Y-up" for parts modelled on the Top plane, and a live preview shows the
result before anything is imported.

## Geometry quality — and how it is handled

eDrawings stores display tessellation: every face is triangulated on its own,
curved surfaces are approximated, and a body's faces only roughly share their
seams. Two measured facts shaped the import:

1. Handing a whole component to the staged repair is wrong. A component's
   bodies overlap, the repair sees the overlap as self-intersection, and only
   the voxel rebuild resolves that — an 11,000-triangle part came back with
   220,000 triangles and its fine detail gone, in 60 seconds.
2. Bodies taken one at a time are almost all closed solids. So
   `lib/import/edrawings/assemble.ts` accepts or repairs each body WITHOUT the
   voxel stage, unites the closed ones exactly (Manifold boolean union), and
   sends only bodies that stay open through the full repair. The same two
   components now import in 3 seconds with no detail loss. On the heaviest
   component (1,672 bodies), 1,222 needed a light repair and 450 open sheets
   were rebuilt — reported in the import notes, by count.

## Files

| File | Role |
| --- | --- |
| `lib/import/edrawings/container.ts` | ZIP container (bounded `readZip`), pre-ZIP format, protection check |
| `lib/import/edrawings/inflate.ts` | zlib region with a size cap; tolerates the bytes HSF writes after the zlib trailer |
| `lib/import/edrawings/hsf.ts` | Bounds-checked opcode reader, placeholders and shells, limits |
| `lib/import/edrawings/model.ts` | Tree walk, matrices, instancing, display state, per-body weld, units check |
| `lib/import/edrawings/placement.ts` | Unit, up axis, scale, shared rebase — used by both preview and import |
| `lib/import/edrawings/assemble.ts` | Per-body repair and exact union |
| `hooks/useEDrawingsImport.ts` | Parse job → screen → repair/budget → layers |
| `components/edrawings/EDrawingsImportScreen.tsx` | Full-screen import step: components, preview, options, rights confirmation |
| `lib/testing/edrawingsFixture.ts` | Writer for synthetic files with the same stream layout (tests, e2e) |

Parsing runs in the geometry worker (`parseEDrawings`), as does assembly
(`assembleEDrawingsComponent`) and the optional one-body union
(`unionMeshes`).

## Why a separate screen

An assembly can hold hundreds of components at real-world size in metres.
Importing it like a 3MF — every body straight into a layer — would flood the
layer list with parts nobody wanted, at a size no printer holds. The screen
asks the questions that only make sense before import (which components,
unit, up axis, scale, layers or one body), shows the answer in a live preview,
and only then touches the document. It is an overlay inside the editor, not a
separate route: the document and the mesh store live in memory, and a route
change would lose them.

## Testing

- `lib/import/edrawings/__tests__/edrawings.test.ts` — decoding, instancing,
  display state, partial files, units check, placement, budget sharing,
  per-body assembly, and hostile input (non-ZIP, protected model, inflate
  cap, vertex cap, instancing cap, deterministic random corruption).
- The same suite holds a regression case for the real assembly; it runs when
  `EDRAWINGS_SAMPLE` points at the file. Customer files are not committed.
- `e2e/edrawingsImport.spec.ts` — picker → screen → rights confirmation →
  scaled layers, and the `.edrw` refusal.

## Known limits

- **One sample.** The reader is verified against one SOLIDWORKS 2025 file.
  Other versions, other publishers (the eDrawings exporters for Creo, NX,
  Inventor) and `.eprt` parts follow the same HSF design but may use opcodes
  or shell encodings not seen yet; those stop with a precise message, never a
  guess.
- **STL-export permission is not read** (gate B above).
- **Edgebreaker / compressed points are not decoded.** Not used by the sample;
  detected and refused by name.
- **`.edrw` drawings** are 2D and explained rather than imported.
- **Multiple configurations**: the first configuration's 3D model is used.
- **Display tessellation is the ceiling.** The import cannot be more accurate
  than the tessellation quality the file was saved with; for exact geometry,
  export STEP or a fine STL from SOLIDWORKS.
