/**
 * Multi-part export package: one STL per printable part + a bilingual
 * (Hebrew/English) README describing parts, colors, orientation hints,
 * connector info and assembly notes.
 */

import type { MaterialSlot } from "@/types/design";
import type { MeshData } from "@/lib/geometry/meshData";
import { meshDataBounds } from "@/lib/geometry/meshData";
import { createZip, type ZipEntry } from "./zip";
import { meshDataToBinaryStl } from "./stlData";

export interface PackagePart {
  /** File-safe base name (without extension). */
  fileBaseName: string;
  nameHe: string;
  mesh: MeshData;
  materialSlot: MaterialSlot | null;
  triangleCount: number;
  suggestedOrientationHe?: string;
}

export interface PackageOptions {
  designName: string;
  connectorsInfoHe?: string[];
  assemblyNotesHe?: string[];
  suggestedMaterialHe?: string;
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 80);
  return cleaned || "part";
}

function dims(mesh: MeshData): string {
  const b = meshDataBounds(mesh);
  const f = (v: number) => v.toFixed(1);
  return `${f(b.max.x - b.min.x)} × ${f(b.max.y - b.min.y)} × ${f(b.max.z - b.min.z)} mm`;
}

function buildReadme(parts: PackagePart[], options: PackageOptions): string {
  const lines: string[] = [];
  lines.push(`# ${options.designName}`);
  lines.push("");
  lines.push("## עברית");
  lines.push("");
  lines.push(`חבילת הדפסה עם ${parts.length} חלקים. כל הקבצים ביחידות מילימטרים (STL בינארי).`);
  lines.push("");
  lines.push("### חלקים");
  for (const part of parts) {
    lines.push(`- **${part.fileBaseName}.stl** — ${part.nameHe}`);
    lines.push(`  - מידות: ${dims(part.mesh)}`);
    lines.push(`  - משולשים: ${part.triangleCount.toLocaleString()}`);
    if (part.materialSlot) {
      lines.push(`  - צבע/חומר מוצע: ${part.materialSlot.nameHe} (${part.materialSlot.colorHex})`);
    }
    if (part.suggestedOrientationHe) {
      lines.push(`  - תנוחת הדפסה מוצעת: ${part.suggestedOrientationHe}`);
    }
  }
  if (options.suggestedMaterialHe) {
    lines.push("");
    lines.push(`### חומר מוצע`);
    lines.push(options.suggestedMaterialHe);
  }
  if (options.connectorsInfoHe && options.connectorsInfoHe.length > 0) {
    lines.push("");
    lines.push("### מחברים");
    for (const info of options.connectorsInfoHe) lines.push(`- ${info}`);
  }
  lines.push("");
  lines.push("### הערכות הרכבה");
  const notes = options.assemblyNotesHe ?? [];
  if (notes.length === 0) {
    lines.push("- ודאו התאמה יבשה של החלקים לפני הדבקה.");
    lines.push("- נקו שאריות הדפסה מחורי המחברים לפני ההרכבה.");
  } else {
    for (const note of notes) lines.push(`- ${note}`);
  }
  lines.push("");
  lines.push("> חשוב: יש לבדוק את הקבצים בתוכנת הסלייסר לפני ההדפסה.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## English");
  lines.push("");
  lines.push(
    `Print package with ${parts.length} part(s). All files are binary STL in millimetres.`
  );
  lines.push("");
  lines.push("### Parts");
  for (const part of parts) {
    lines.push(`- **${part.fileBaseName}.stl**`);
    lines.push(`  - Dimensions: ${dims(part.mesh)}`);
    lines.push(`  - Triangles: ${part.triangleCount.toLocaleString("en-US")}`);
    if (part.materialSlot) {
      lines.push(`  - Suggested color/material slot: ${part.materialSlot.colorHex}`);
    }
  }
  lines.push("");
  lines.push("> Always verify the files in your slicer before printing.");
  lines.push("");
  return lines.join("\n");
}

/** Build the multi-part ZIP (STL per part + README.md). */
export async function buildMultiPartZip(
  parts: PackagePart[],
  options: PackageOptions
): Promise<Blob> {
  const entries: ZipEntry[] = [];
  const usedNames = new Set<string>();
  for (const part of parts) {
    let base = sanitizeFileName(part.fileBaseName);
    let candidate = base;
    let counter = 2;
    while (usedNames.has(candidate)) candidate = `${base}-${counter++}`;
    usedNames.add(candidate);
    const stl = meshDataToBinaryStl(part.mesh);
    entries.push({
      name: `${candidate}.stl`,
      data: new Uint8Array(await stl.arrayBuffer()),
    });
  }
  entries.push({
    name: "README.md",
    data: new TextEncoder().encode(buildReadme(parts, options)),
  });
  return createZip(entries);
}
