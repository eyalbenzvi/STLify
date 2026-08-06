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

  parts.forEach((part, index) => {
    const materialId = index * 2 + 1;
    const objectId = index * 2 + 2;
    chunks.push(`  <basematerials id="${materialId}">`);
    chunks.push(
      `   <base name="${xmlEscape(part.materialName || part.name)}" displaycolor="${displayColor(part.colorHex)}"/>`
    );
    chunks.push("  </basematerials>");
    chunks.push(
      `  <object id="${objectId}" type="model" name="${xmlEscape(part.name)}" pid="${materialId}" pindex="0">`
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
  });

  chunks.push(" </resources>");
  chunks.push(" <build>");
  parts.forEach((_, index) => {
    chunks.push(`  <item objectid="${index * 2 + 2}"/>`);
  });
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
