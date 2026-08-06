/**
 * Export orchestration: DesignState → downloadable artifacts.
 *
 * - Single STL: all parts unioned into one watertight solid (colours are
 *   NOT stored — STL cannot carry them; the UI says so).
 * - Multi-colour ZIP: one STL per used colour slot plus a bilingual README
 *   with colour/material/assembly notes. This is the reliable multi-colour
 *   workflow that works with every slicer.
 * - 3MF: single package with per-part colours/materials for slicers that
 *   support it.
 */

import { strToU8, zipSync, type Zippable } from "fflate";
import type { DesignState } from "@/types/design";
import type { DesignIssue } from "@/types/design";
import {
  buildPartSolids,
  type AssetResolver,
  type PartSolid,
} from "@/lib/geometry/buildDesign";
import type { Solid } from "@/lib/geometry/kernel";
import { geometryToBinaryStl } from "./stl";
import { partFileName } from "./filenames";
import { buildThreeMf, type ThreeMfPart } from "./threeMF";

export interface ExportPartInfo {
  fileName: string;
  partNames: string[];
  slotIndex: number;
  slotName: string;
  colorHex: string;
  materialType: string;
  filamentName: string;
  triangleCount: number;
}

export interface ExportResult {
  blob: Blob;
  issues: DesignIssue[];
  /** Parts included (ZIP / 3MF exports). */
  parts: ExportPartInfo[];
  triangleCount: number;
}

export class ExportBlockedError extends Error {
  constructor(public issues: DesignIssue[]) {
    super("Export blocked by validation errors");
    this.name = "ExportBlockedError";
  }
}

async function buildOrThrow(
  state: DesignState,
  assetResolver: AssetResolver
): Promise<{ parts: PartSolid[]; issues: DesignIssue[] }> {
  const { parts, issues } = await buildPartSolids(state, { assetResolver });
  if (parts.length === 0 || issues.some((i) => i.severity === "error")) {
    for (const part of parts) part.solid.dispose();
    throw new ExportBlockedError(issues);
  }
  return { parts, issues };
}

/** Union a list of solids (consumes them). */
function unionSolids(solids: Solid[]): Solid {
  let result = solids[0];
  for (let i = 1; i < solids.length; i++) result = result.union(solids[i]);
  return result;
}

/** Export the whole design as a single binary STL. */
export async function exportSingleStl(
  state: DesignState,
  assetResolver: AssetResolver
): Promise<ExportResult> {
  const { parts, issues } = await buildOrThrow(state, assetResolver);
  const merged = unionSolids(parts.map((p) => p.solid));
  try {
    const geometry = merged.toGeometry();
    const triangleCount = merged.triangleCount();
    const blob = geometryToBinaryStl(geometry);
    geometry.dispose();
    return { blob, issues, parts: [], triangleCount };
  } finally {
    merged.dispose();
  }
}

interface SlotGroup {
  slotIndex: number;
  parts: PartSolid[];
}

function groupBySlot(parts: PartSolid[]): SlotGroup[] {
  const map = new Map<number, PartSolid[]>();
  for (const part of parts) {
    const list = map.get(part.colorSlot);
    if (list) list.push(part);
    else map.set(part.colorSlot, [part]);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slotIndex, slotParts]) => ({ slotIndex, parts: slotParts }));
}

/** Export one STL per used colour slot, in a ZIP with a bilingual README. */
export async function exportMultiColorZip(
  state: DesignState,
  assetResolver: AssetResolver
): Promise<ExportResult> {
  const { parts, issues } = await buildOrThrow(state, assetResolver);
  const groups = groupBySlot(parts);
  const slots = state.settings.multiColor.slots;
  const files: Zippable = {};
  const infos: ExportPartInfo[] = [];
  let totalTris = 0;
  const hasInlay = parts.some((p) => p.kind === "inlay");

  for (const group of groups) {
    const slot = slots[group.slotIndex] ?? slots[0];
    const merged = unionSolids(group.parts.map((p) => p.solid));
    const geometry = merged.toGeometry();
    const tris = merged.triangleCount();
    totalTris += tris;
    const stl = geometryToBinaryStl(geometry);
    geometry.dispose();
    merged.dispose();

    const fileName = partFileName(
      group.slotIndex,
      slot?.name ?? `color-${group.slotIndex + 1}`,
      group.parts.map((p) => p.name).join("-")
    );
    files[fileName] = new Uint8Array(await stl.arrayBuffer());
    infos.push({
      fileName,
      partNames: group.parts.map((p) => p.name),
      slotIndex: group.slotIndex,
      slotName: slot?.name ?? `Color ${group.slotIndex + 1}`,
      colorHex: slot?.colorHex ?? "#8a8f98",
      materialType: slot?.materialType ?? "PLA",
      filamentName: slot?.filamentName ?? "",
      triangleCount: tris,
    });
  }

  files["README.txt"] = strToU8(
    buildReadme(state, infos, hasInlay)
  );

  const zipped = zipSync(files, { level: 6 });
  return {
    blob: new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" }),
    issues,
    parts: infos,
    triangleCount: totalTris,
  };
}

/** Export a 3MF package with per-part colours and materials. */
export async function exportThreeMf(
  state: DesignState,
  assetResolver: AssetResolver
): Promise<ExportResult> {
  const { parts, issues } = await buildOrThrow(state, assetResolver);
  const groups = groupBySlot(parts);
  const slots = state.settings.multiColor.slots;
  const mfParts: ThreeMfPart[] = [];
  const infos: ExportPartInfo[] = [];
  let totalTris = 0;

  for (const group of groups) {
    const slot = slots[group.slotIndex] ?? slots[0];
    const merged = unionSolids(group.parts.map((p) => p.solid));
    const geometry = merged.toGeometry();
    const position = geometry.getAttribute("position");
    const index = geometry.index;
    totalTris += merged.triangleCount();
    mfParts.push({
      name: group.parts.map((p) => p.name).join(" + "),
      colorHex: slot?.colorHex ?? "#8a8f98",
      materialName: `${slot?.name ?? ""} (${slot?.materialType ?? "PLA"})`.trim(),
      vertices: new Float32Array(position.array),
      triangles: index ? new Uint32Array(index.array) : new Uint32Array(0),
    });
    infos.push({
      fileName: "",
      partNames: group.parts.map((p) => p.name),
      slotIndex: group.slotIndex,
      slotName: slot?.name ?? `Color ${group.slotIndex + 1}`,
      colorHex: slot?.colorHex ?? "#8a8f98",
      materialType: slot?.materialType ?? "PLA",
      filamentName: slot?.filamentName ?? "",
      triangleCount: merged.triangleCount(),
    });
    geometry.dispose();
    merged.dispose();
  }

  const blob = buildThreeMf(mfParts, state.doc.title);
  return { blob, issues, parts: infos, triangleCount: totalTris };
}

function buildReadme(
  state: DesignState,
  infos: ExportPartInfo[],
  hasInlay: boolean
): string {
  const clearance = state.settings.multiColor.inlayClearanceMm;
  const lines: string[] = [];
  lines.push("=== הדפסה רב-צבעית — חלקים נפרדים ===");
  lines.push("");
  lines.push("כל קובץ STL בארכיון הוא חלק נפרד להדפסה בצבע/חומר משלו.");
  lines.push("כל החלקים מיוצאים באותה מערכת צירים, כך שסלייסרים התומכים");
  lines.push("בריבוי אובייקטים ימקמו אותם נכון זה ביחס לזה.");
  lines.push("");
  for (const info of infos) {
    lines.push(`קובץ: ${info.fileName}`);
    lines.push(`  שכבות: ${info.partNames.join(", ")}`);
    lines.push(`  צבע מוצע: ${info.slotName} (${info.colorHex})`);
    lines.push(`  חומר מוצע: ${info.materialType}${info.filamentName ? ` — ${info.filamentName}` : ""}`);
    lines.push("");
  }
  lines.push("הרכבה: הדפיסו כל חלק בנפרד (או במדפסת רב-חומרים) והדביקו/שבצו.");
  if (hasInlay) {
    lines.push(
      `שיבוץ (Inlay): בבסיס חרוט כיס עם מרווח של ${clearance} מ״מ סביב החלק המשובץ.`
    );
    lines.push("אם החלק הדוק מדי — הגדילו את המרווח בהגדרות ההדפסה הרב-צבעית.");
  }
  lines.push("");
  lines.push("=== Multi-color printing — separate parts (English) ===");
  lines.push("");
  lines.push("Each STL in this archive is a separate part to print in its own");
  lines.push("color/material. All parts share the same coordinate system, so");
  lines.push("multi-object slicers will position them correctly relative to each other.");
  lines.push("");
  for (const info of infos) {
    lines.push(`File: ${info.fileName}`);
    lines.push(`  Layers: ${info.partNames.join(", ")}`);
    lines.push(`  Suggested color: ${info.slotName} (${info.colorHex})`);
    lines.push(`  Suggested material: ${info.materialType}${info.filamentName ? ` — ${info.filamentName}` : ""}`);
    lines.push("");
  }
  lines.push("Assembly: print each part separately (or on a multi-material printer)");
  lines.push("and glue / press-fit the parts together.");
  if (hasInlay) {
    lines.push(
      `Inlay tolerance: the base has pockets with ${clearance} mm XY clearance around inlaid parts.`
    );
    lines.push("If the fit is too tight, increase the clearance in the multi-color settings.");
  }
  lines.push("");
  lines.push("Units: millimeters (mm). Generated by PrintCraft Product Studio.");
  return lines.join("\n");
}
