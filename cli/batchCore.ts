/**
 * Headless batch production core (V6 item 14).
 *
 * The print-shop use case the tool was reviewed against: one parametric
 * design (a name plate), a spreadsheet of values, a part per row. The
 * expression engine already existed — this is the loop over it.
 *
 * Pure of I/O so the same code is unit-testable: takes the design file
 * TEXT and the CSV TEXT, returns the ZIP bytes plus an honest per-row
 * report. Everything runs locally in the calling process — no server, no
 * upload, no identifiers, exactly like the app.
 *
 * CSV contract (documented in cli/batch.ts --help):
 *  - The header row names the columns.
 *  - A column whose name matches a design PARAMETER sets that parameter's
 *    literal value for the row (the stored expression is cleared).
 *  - A column named `text:<layer name>` sets the CONTENT of the text
 *    layer(s) with that name — this is what makes name plates work.
 *  - A column named `name` (or `שם`) labels the row's files.
 */

import type { DesignDocument } from "@/types/design";
import { buildDocument } from "@/lib/geometry/buildDocument";
import { meshDataToBinaryStl } from "@/lib/export/stlData";
import { createZip, type ZipEntry } from "@/lib/export/zip";
import { importDesignFile } from "@/lib/serialization/designFile";

export interface BatchRowReport {
  label: string;
  ok: boolean;
  /** Per part: name + world dimensions, for verification and the README. */
  parts: { nameHe: string; dimensionsMm: { x: number; y: number; z: number }; watertight: boolean }[];
  errorsHe: string[];
}

export interface BatchResult {
  zip: Uint8Array;
  rows: BatchRowReport[];
  /** True only when EVERY row produced only watertight parts. */
  ok: boolean;
}

/** Minimal CSV parser: commas, CRLF, double-quote escaping, UTF-8 BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 60);
  return cleaned || "row";
}

/** Apply one CSV row onto a fresh copy of the document. */
export function applyRow(
  document: DesignDocument,
  header: string[],
  row: string[]
): { document: DesignDocument; errorsHe: string[] } {
  const errorsHe: string[] = [];
  let parameters = [...(document.parameters ?? [])];
  let layers = document.layers;

  header.forEach((rawColumn, i) => {
    const column = rawColumn.trim();
    const value = (row[i] ?? "").trim();
    if (!column || column === "name" || column === "שם" || value === "") return;

    if (column.startsWith("text:")) {
      const layerName = column.slice("text:".length).trim();
      let found = false;
      layers = layers.map((layer) => {
        if (layer.type === "text" && layer.name === layerName) {
          found = true;
          return { ...layer, content: value };
        }
        return layer;
      });
      if (!found) errorsHe.push(`אין שכבת טקסט בשם "${layerName}" (עמודה "${column}")`);
      return;
    }

    const index = parameters.findIndex((p) => p.name === column);
    if (index === -1) {
      errorsHe.push(`אין פרמטר בשם "${column}" בעיצוב`);
      return;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      errorsHe.push(`הערך "${value}" בעמודה "${column}" אינו מספר`);
      return;
    }
    parameters = parameters.map((p, k) =>
      k === index ? { ...p, value: numeric, expression: "" } : p
    );
  });

  return { document: { ...document, parameters, layers }, errorsHe };
}

/**
 * Run the whole batch. Throws only on unusable INPUTS (bad design file,
 * empty CSV); per-row failures are reported, never silently dropped.
 */
export async function runBatch(designText: string, csvText: string): Promise<BatchResult> {
  const { document } = importDesignFile(designText);
  const table = parseCsv(csvText);
  if (table.length < 2) {
    throw new Error("קובץ ה-CSV חייב לכלול שורת כותרות ולפחות שורת ערכים אחת");
  }
  const [header, ...dataRows] = table;
  const labelColumn = header.findIndex((c) => {
    const t = c.trim();
    return t === "name" || t === "שם";
  });

  const rows: BatchRowReport[] = [];
  const entries: ZipEntry[] = [];
  const readme: string[] = [
    "# הפקת אצווה — PrintCraft STL Studio",
    "",
    `שורות: ${dataRows.length}. כל הקבצים במילימטרים (STL בינארי). הופק מקומית בלבד.`,
    "",
  ];

  for (let r = 0; r < dataRows.length; r++) {
    const label =
      labelColumn >= 0 && dataRows[r][labelColumn]?.trim()
        ? dataRows[r][labelColumn].trim()
        : `row-${r + 1}`;
    const { document: patched, errorsHe } = applyRow(document, header, dataRows[r]);
    const report: BatchRowReport = { label, ok: false, parts: [], errorsHe };
    rows.push(report);
    if (errorsHe.length > 0) {
      readme.push(`- **${label}** — נכשל: ${errorsHe.join("; ")}`);
      continue;
    }

    const result = await buildDocument(patched);
    if (result.status !== "ok") {
      report.errorsHe.push(
        ...result.issues.map((issue) => `${issue.titleHe}${issue.detailHe ? ` — ${issue.detailHe}` : ""}`)
      );
      readme.push(`- **${label}** — נכשל: ${report.errorsHe.join("; ")}`);
      continue;
    }

    let allWatertight = true;
    for (let p = 0; p < result.parts.length; p++) {
      const part = result.parts[p];
      report.parts.push({
        nameHe: part.nameHe,
        dimensionsMm: part.stats.dimensionsMm,
        watertight: part.stats.watertight,
      });
      if (!part.stats.watertight) {
        allWatertight = false;
        report.errorsHe.push(`החלק "${part.nameHe}" אינו אטום`);
        continue;
      }
      const stl = meshDataToBinaryStl(part.worldMesh);
      const bytes = new Uint8Array(await stl.arrayBuffer());
      const partName =
        result.parts.length > 1
          ? `${sanitizeFileName(label)}/${p + 1}-${sanitizeFileName(part.nameHe)}.stl`
          : `${sanitizeFileName(label)}.stl`;
      entries.push({ name: partName, data: bytes });
    }
    report.ok = allWatertight && report.parts.length > 0;
    const dims = report.parts
      .map((part) => `${part.nameHe}: ${part.dimensionsMm.x.toFixed(1)}×${part.dimensionsMm.y.toFixed(1)}×${part.dimensionsMm.z.toFixed(1)} מ״מ`)
      .join(" · ");
    readme.push(`- **${label}** — ${report.ok ? "תקין" : "נכשל"} (${dims})`);
  }

  entries.unshift({
    name: "README.md",
    data: new TextEncoder().encode(readme.join("\n") + "\n"),
  });
  const blob = createZip(entries);
  const zip = new Uint8Array(await blob.arrayBuffer());
  return { zip, rows, ok: rows.every((row) => row.ok) };
}
