/**
 * Headless batch production CLI (V6 item 14).
 *
 *   npm run batch -- --design plate.formadesign.json --csv names.csv --out batch.zip
 *
 * Takes a portable design file plus a CSV of per-row values and writes a
 * ZIP with a part per row. Everything runs IN THIS PROCESS on this
 * machine: no server, no upload, no account, no telemetry — the same
 * privacy contract as the app itself.
 *
 * CSV contract:
 *  - Header row names the columns.
 *  - A column matching a design PARAMETER name sets its value per row.
 *  - `text:<layer name>` sets the content of that text layer (name plates).
 *  - `name` / `שם` labels the row's output files.
 */

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { installNodeFontFetch } from "@/lib/geometry/nodeFontFetch";

installNodeFontFetch();

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

async function main(): Promise<void> {
  const designPath = argValue("--design");
  const csvPath = argValue("--csv");
  const outPath = argValue("--out") ?? "batch.zip";
  if (!designPath || !csvPath || process.argv.includes("--help")) {
    console.log(
      [
        "PrintCraft STL Studio — batch production (runs locally, nothing leaves this machine)",
        "",
        "usage: npm run batch -- --design <file.formadesign.json> --csv <values.csv> [--out batch.zip]",
        "",
        "CSV: header row names columns; a column matching a parameter name sets it per row;",
        "     'text:<layer name>' sets a text layer's content; 'name'/'שם' labels the row.",
      ].join("\n")
    );
    process.exit(designPath && csvPath ? 0 : 2);
  }

  const { runBatch } = await import("./batchCore");
  const result = await runBatch(
    readFileSync(designPath, "utf8"),
    readFileSync(csvPath, "utf8")
  );
  writeFileSync(outPath, result.zip);

  for (const row of result.rows) {
    const status = row.ok ? "✓" : "✗";
    const dims = row.parts
      .map((p) => `${p.nameHe} ${p.dimensionsMm.x.toFixed(1)}×${p.dimensionsMm.y.toFixed(1)}×${p.dimensionsMm.z.toFixed(1)}mm`)
      .join(", ");
    console.log(`${status} ${row.label}${dims ? ` — ${dims}` : ""}`);
    for (const err of row.errorsHe) console.log(`   ! ${err}`);
  }
  const failed = result.rows.filter((r) => !r.ok).length;
  console.log(
    `\n${result.rows.length - failed}/${result.rows.length} rows OK → ${outPath}`
  );
  process.exit(result.ok ? 0 : 1);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
