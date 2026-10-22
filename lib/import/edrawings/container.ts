/**
 * The eDrawings container: the outer layer of a .easm / .eprt file.
 *
 * Since roughly SOLIDWORKS 2008 an eDrawings file is a plain ZIP whose
 * `eModel` entry is a HOOPS Stream File (HSF) — the tessellated display model
 * — next to a preview image, material and scene XML, and a small `OLE`
 * record. Older files ARE the HSF stream, with no ZIP around it. Both are
 * accepted here; everything inside the HSF stream is hsf.ts's business.
 *
 * Untrusted input, so the ZIP goes through the same bounded reader as 3MF.
 */

import { readZip, ZipReadError } from "../zipRead";
import { EDrawingsError } from "./errors";

/** Limits for the outer archive. eModel can be large; the rest is small. */
const CONTAINER_LIMITS = {
  maxEntries: 64,
  maxTotalBytes: 256 * 1024 * 1024,
};

const HSF_MAGIC = ";; HSF";

export interface EDrawingsContainer {
  /** The HOOPS stream, still compressed inside (see hsf.ts). */
  eModel: Uint8Array;
  /** Archive entry names, for diagnostics. Empty for the pre-ZIP format. */
  entryNames: string[];
  /**
   * The raw `OLE` record as hex. Its meaning is not documented; it is kept
   * so that a future comparison of files saved with different publishing
   * options (STL export allowed / not) can identify the permission bits.
   */
  oleRecordHex: string | null;
}

export function startsWithHsfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < HSF_MAGIC.length) return false;
  for (let i = 0; i < HSF_MAGIC.length; i++) {
    if (bytes[i] !== HSF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function toHex(bytes: Uint8Array, max = 64): string {
  return Array.from(bytes.subarray(0, max), (b) => b.toString(16).padStart(2, "0")).join(" ");
}

export async function readEDrawingsContainer(buffer: ArrayBuffer): Promise<EDrawingsContainer> {
  const bytes = new Uint8Array(buffer);
  if (startsWithHsfMagic(bytes)) {
    return { eModel: bytes, entryNames: [], oleRecordHex: null };
  }
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  if (!isZip) {
    throw new EDrawingsError(
      "הקובץ אינו קובץ eDrawings מוכר — ייתכן שהוא מגרסה ישנה מאוד, מוצפן או פגום"
    );
  }

  let entries: Map<string, Uint8Array>;
  try {
    entries = await readZip(buffer, CONTAINER_LIMITS);
  } catch (error) {
    if (error instanceof ZipReadError) throw new EDrawingsError(error.messageHe);
    throw error;
  }

  const eModel = entries.get("eModel");
  if (!eModel) {
    throw new EDrawingsError("הקובץ אינו מכיל מודל תלת־ממדי של eDrawings (חסר רכיב eModel)");
  }
  if (!startsWithHsfMagic(eModel)) {
    // A password-protected file, or a format revision this reader has never
    // seen. Either way there is nothing safe to guess at.
    throw new EDrawingsError(
      "תוכן המודל בקובץ אינו קריא — ייתכן שהקובץ מוגן בסיסמה. פתחו אותו ב-eDrawings ושמרו עותק ללא סיסמה, או ייצאו STL"
    );
  }
  const ole = entries.get("OLE");
  return {
    eModel,
    entryNames: [...entries.keys()],
    oleRecordHex: ole ? toHex(ole) : null,
  };
}
