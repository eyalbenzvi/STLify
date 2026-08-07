/**
 * Minimal, valid 3MF writer (3MF Core spec, millimetre units).
 *
 * A 3MF package is a ZIP (OPC) containing a model XML. This writer emits
 * one <object> per part with its own <basematerials> colour + material
 * name, and a build that places all parts at identity — preserving the
 * multi-colour assembly in software that supports 3MF (PrusaSlicer, Bambu
 * Studio, Cura…).
 *
 * Geometry is written from indexed triangle arrays produced by the Manifold
 * kernel, so every object is a watertight mesh as the spec requires. The
 * package uses the app's dependency-free ZIP writer (STORE entries are
 * valid OPC).
 *
 * Ported from the V2 branch (lib/export/threeMF.ts) with the fflate
 * dependency replaced by lib/export/zip.ts.
 */

import { createZip } from "./zip";

export interface ThreeMfPart {
  name: string;
  colorHex: string;
  materialName: string;
  /** xyz interleaved vertex positions, mm. */
  vertices: Float32Array;
  /** CCW triangle indices. */
  triangles: Uint32Array;
  /**
   * What the part IS to the slicer. Generated supports/brims/rafts must not
   * export as model bodies — a slicer would give them full perimeters and
   * infill and they would come out too strong to snap off. Default "model".
   */
  role?: "model" | "support";
  /**
   * Stable identity. When set, the object id is derived from the part's
   * RANK in the sorted id list — so re-exporting the same design assigns
   * the same object ids, and a slicer that stores per-object settings by
   * id keeps them across exports. Without it, ids fall back to input
   * order (the pre-V6 behaviour).
   */
  id?: string;
  /**
   * Placement in the build, as a 3MF 12-number transform
   * (rows of the 3×3, then translation). When set, `vertices` are the
   * part's LOCAL mesh — the slicer sees a movable placed object instead of
   * world-baked coordinates, so repositioning there needs no re-bake here.
   */
  buildTransform?: number[];
  /**
   * Assembly parent (another part's `id`). The child is emitted as a
   * component of the parent's assembly object with `relativeTransform`
   * (12 numbers, child placement in the parent's frame), preserving the
   * layer hierarchy instead of flattening to N loose objects.
   */
  parentId?: string | null;
  relativeTransform?: number[];
}

/** Column-major THREE.Matrix4 elements → the 3MF 12-number transform. */
export function matrixToThreeMfTransform(elements: ArrayLike<number>): number[] {
  const e = elements;
  // 3MF: "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" where row i is
  // the image of basis vector i and row 3 is the translation — exactly the
  // first three entries of each column-major column.
  return [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]];
}

function transformAttr(transform: number[] | undefined): string {
  if (!transform || transform.length !== 12) return "";
  return ` transform="${transform.map((v) => fmt(v)).join(" ")}"`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** #rrggbb → #RRGGBBFF as required by 3MF displaycolor. */
function displayColor(hex: string): string {
  const clean = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#8a8f98";
  return `${clean.toUpperCase()}FF`;
}

function fmt(n: number): string {
  // Compact but precise enough for mm-scale printing.
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/\.?0+$/, "");
}

/** Build the 3D/3dmodel.model XML. Exported for tests. */
export function buildModelXml(parts: ThreeMfPart[], designTitle: string): string {
  const chunks: string[] = [];
  chunks.push('<?xml version="1.0" encoding="UTF-8"?>');
  chunks.push(
    '<model unit="millimeter" xml:lang="und" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
  );
  chunks.push(` <metadata name="Title">${xmlEscape(designTitle || "design")}</metadata>`);
  chunks.push(' <metadata name="Application">PrintCraft STL Studio</metadata>');
  chunks.push(" <resources>");

  // STABLE object ids: when every part carries a unique string id, ranks
  // come from the SORTED id list — re-exporting the same design assigns the
  // same numbers, so a slicer that keys per-object settings by id keeps
  // them. Without ids, ranks are input order (the pre-V6 behaviour).
  const stableIds =
    parts.every((p) => p.id !== undefined) &&
    new Set(parts.map((p) => p.id)).size === parts.length;
  const rank = new Map<ThreeMfPart, number>();
  if (stableIds) {
    [...parts]
      .sort((a, b) => (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0))
      .forEach((p, r) => rank.set(p, r));
  } else {
    parts.forEach((p, r) => rank.set(p, r));
  }
  const materialIdOf = (p: ThreeMfPart) => rank.get(p)! * 2 + 1;
  const meshObjectIdOf = (p: ThreeMfPart) => rank.get(p)! * 2 + 2;
  // Each part needs at most ONE extra object (a support wrapper or an
  // assembly grouping its children) — allocated by rank, so also stable.
  const extraIdOf = (p: ThreeMfPart) => parts.length * 2 + 2 + rank.get(p)!;

  // Assembly hierarchy: a child attaches to its parent's assembly object
  // with a relative transform, preserving the layer tree instead of
  // flattening the design to N loose objects.
  const byId = new Map(parts.filter((p) => p.id).map((p) => [p.id!, p]));
  const childrenOf = new Map<ThreeMfPart, ThreeMfPart[]>();
  const isChild = new Set<ThreeMfPart>();
  for (const p of parts) {
    const parent = p.parentId ? byId.get(p.parentId) : undefined;
    if (parent && parent !== p) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), p]);
      isChild.add(p);
    }
  }
  /** The object a reference to this part should point at. */
  const referenceIdOf = (p: ThreeMfPart): number =>
    childrenOf.has(p) || (p.role ?? "model") === "support"
      ? extraIdOf(p)
      : meshObjectIdOf(p);

  const buildItems: string[] = [];

  for (const part of parts) {
    const materialId = materialIdOf(part);
    const objectId = meshObjectIdOf(part);
    const role = part.role ?? "model";
    chunks.push(`  <basematerials id="${materialId}">`);
    chunks.push(
      `   <base name="${xmlEscape(part.materialName || part.name)}" displaycolor="${displayColor(part.colorHex)}"/>`
    );
    chunks.push("  </basematerials>");
    chunks.push(
      `  <object id="${objectId}" type="${role}" name="${xmlEscape(part.name)}" pid="${materialId}" pindex="0">`
    );
    chunks.push("   <mesh>");
    chunks.push("    <vertices>");
    const v = part.vertices;
    for (let i = 0; i < v.length; i += 3) {
      chunks.push(`     <vertex x="${fmt(v[i])}" y="${fmt(v[i + 1])}" z="${fmt(v[i + 2])}"/>`);
    }
    chunks.push("    </vertices>");
    chunks.push("    <triangles>");
    const t = part.triangles;
    for (let i = 0; i < t.length; i += 3) {
      chunks.push(`     <triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`);
    }
    chunks.push("    </triangles>");
    chunks.push("   </mesh>");
    chunks.push("  </object>");

    if (childrenOf.has(part)) {
      // Assembly object: the part's own mesh at identity plus each child at
      // its relative placement. Children that are themselves assemblies (or
      // supports) are referenced through THEIR extra object, so the tree
      // nests to any depth.
      chunks.push(
        `  <object id="${extraIdOf(part)}" type="model" name="${xmlEscape(part.name)}">`
      );
      chunks.push("   <components>");
      chunks.push(`    <component objectid="${objectId}"/>`);
      for (const child of childrenOf.get(part)!) {
        chunks.push(
          `    <component objectid="${referenceIdOf(child)}"${transformAttr(child.relativeTransform)}/>`
        );
      }
      chunks.push("   </components>");
      chunks.push("  </object>");
    } else if (role === "support") {
      // The Core spec forbids referencing a type="support" object directly
      // from the build; it must arrive via a components element of a model
      // object. The wrapper carries the identity, the typed object carries
      // the meaning — a slicer that understands support objects prints them
      // as removable aids, one that does not still sees valid geometry.
      chunks.push(
        `  <object id="${extraIdOf(part)}" type="model" name="${xmlEscape(part.name)}">`
      );
      chunks.push("   <components>");
      chunks.push(`    <component objectid="${objectId}"/>`);
      chunks.push("   </components>");
      chunks.push("  </object>");
    }

    if (!isChild.has(part)) {
      buildItems.push(
        `  <item objectid="${referenceIdOf(part)}"${transformAttr(part.buildTransform)}/>`
      );
    }
  }

  chunks.push(" </resources>");
  chunks.push(" <build>");
  chunks.push(...buildItems);
  chunks.push(" </build>");
  chunks.push("</model>");
  return chunks.join("\n");
}

/** Serialize parts into a complete .3mf package. */
export function buildThreeMf(parts: ThreeMfPart[], designTitle: string): Blob {
  if (parts.length === 0) throw new Error("3MF export requires at least one part");
  const modelXml = buildModelXml(parts, designTitle);
  const encoder = new TextEncoder();
  const blob = createZip([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: encoder.encode(RELS) },
    { name: "3D/3dmodel.model", data: encoder.encode(modelXml) },
  ]);
  return new Blob([blob], { type: "model/3mf" });
}
