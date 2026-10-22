/**
 * HOOPS Stream File (HSF) reader — the geometry inside an eDrawings file.
 *
 * HSF is a sequence of one-byte opcodes, each followed by an opcode-specific
 * payload with NO generic length field. That is the whole difficulty: a
 * reader cannot skip what it does not understand, so it either knows an
 * opcode's layout exactly or it has to stop. This reader implements the
 * opcodes SOLIDWORKS writes into eDrawings files (verified against a real
 * SOLIDWORKS 2025 assembly, HSF V20.90 — see docs/EDRAWINGS-PLAN.md for what
 * was learned and how), and stops honestly on anything else.
 *
 * What an eDrawings model looks like in the stream:
 *
 *   1. A segment tree (`(` open / `)` close) describing configurations,
 *      components (`name=…` user options), modelling matrices (`%`) and
 *      includes (`<`) of shared body segments — with every face's shell
 *      written as a NULL placeholder that is immediately tagged (`q`).
 *   2. A second pass (after a pause opcode) that "revisits" each placeholder:
 *      a real shell whose first field is the tag index of the placeholder it
 *      fills. Positions are float32 in metres; faces are triangle strips.
 *   3. Edges and annotations, which a print does not need.
 *
 * So geometry is collected per TAG, and the tree says where each tag lives.
 * Parsing stops at the first opcode it does not know; whether that is fine is
 * decided by counting — if every placeholder was filled, the remainder is the
 * edge pass. If not, the caller reports exactly how much was decoded.
 *
 * Every read is bounds-checked and every count is capped: this is untrusted
 * input, and an HSF length field is a number whoever made the file chose.
 */

import { EDrawingsError } from "./errors";
import { inflateZlibPrefix } from "./inflate";

export interface HsfLimits {
  /** Bytes after inflating the compressed region. */
  maxInflatedBytes: number;
  /** Real (non-placeholder) shells. */
  maxShells: number;
  /** Vertices summed over all shells. */
  maxPointsTotal: number;
  /** Segments in the tree. */
  maxSegments: number;
  /** Nesting depth of open segments. */
  maxDepth: number;
}

export const HSF_LIMITS: HsfLimits = {
  maxInflatedBytes: 512 * 1024 * 1024,
  maxShells: 500_000,
  maxPointsTotal: 30_000_000,
  maxSegments: 1_000_000,
  maxDepth: 256,
};

export interface HsfSegment {
  /** Absolute path, e.g. "/config0/sheet0/view0/3dmodel/includes/assempart3". */
  path: string;
  /** Row-major 4x3 modelling matrix (rows: X axis, Y axis, Z axis, translation). */
  matrix: number[] | null;
  /** Relative child segments, in stream order. */
  children: string[];
  /** Absolute paths of included segments. */
  includes: string[];
  /** Tags of placeholder shells written in this segment. */
  stubTags: number[];
  /** User option strings (`key=value,key=value`). */
  options: string[];
  /** Face colour set on this segment, 0–255 per channel. */
  faceColor: [number, number, number] | null;
}

export interface HsfShell {
  /** Tag index of the placeholder this shell fills. */
  tag: number;
  /** xyz triples, file units (metres for SOLIDWORKS). */
  positions: Float32Array;
  /** Triangle-strip stream: [count, i0, i1, …, count, …]. */
  strips: Uint32Array;
}

export interface HsfStop {
  /** Offset in the (inflated) stream. */
  offset: number;
  opcodeHex: string;
  reasonHe: string;
}

export interface HsfScene {
  /** "V20.90" from the stream's header comment. */
  version: string;
  segments: Map<string, HsfSegment>;
  /** Placeholder tag → segment path it was written in. */
  stubs: Map<number, string>;
  shells: HsfShell[];
  /** Why parsing ended before the stream did, or null when it reached the end. */
  stop: HsfStop | null;
}

/** Shell sub-option bits (TKSH_*). */
const SH_COMPRESSED_POINTS = 0x01;
const SH_COMPRESSED_FACES = 0x02;
const SH_TRISTRIPS = 0x04;
const SH_HAS_OPTIONALS = 0x08;
const SH_FIRSTPASS = 0x10;
const SH_BOUNDING_ONLY = 0x20;
const SH_CONNECTIVITY_COMPRESSION = 0x40;
const SH_EXPANDED = 0x80;
const SH2_NULL = 0x0002;

/** Shell optional-data codes seen in SOLIDWORKS output. */
const OPT_TERMINATE = 0x00;
const OPT_ALL_NORMALS_COMPRESSED = 0x01;
const OPT_ALL_PARAMETERS = 0x1c;
const OPT_ENTITY_ATTRIBUTES = 0x63;

/** Every opcode this reader understands — used to validate lookahead. */
const KNOWN_OPCODES = new Set(
  [...'();UVhJ~q<%[]}S"H=@-IBZz'].map((c) => c.charCodeAt(0)).concat([0x00, 0x01, 0x0d, 0x0e, 0x16])
);

class StopParse extends Error {
  constructor(readonly reasonHe: string) {
    super(reasonHe);
  }
}

class Reader {
  pos = 0;
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining(): number {
    return this.bytes.length - this.pos;
  }
  need(n: number): void {
    if (n < 0 || this.pos + n > this.bytes.length) {
      throw new StopParse("המודל נקטע באמצע נתון — ייתכן שהקובץ פגום");
    }
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32Array(count: number): Float32Array {
    this.need(count * 4);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.view.getFloat32(this.pos + i * 4, true);
    this.pos += count * 4;
    return out;
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
  take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  peek(offset = 0): number {
    const at = this.pos + offset;
    return at < this.bytes.length ? this.bytes[at] : -1;
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: false });
const utf16 = new TextDecoder("utf-16le", { fatal: false });

function isPrintable(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b < 0x20 && b !== 0x09) return false;
  return true;
}

/** Read the ";; HSF Vxx.yy" header comment. */
function readHeader(reader: Reader): string {
  const start = reader.pos;
  while (reader.remaining > 0 && reader.pos - start < 256) {
    if (reader.u8() === 0x0a) {
      const text = utf8.decode(reader.bytes.subarray(start, reader.pos - 1)).trim();
      const match = /HSF\s+(V[\d.]+)/.exec(text);
      return match ? match[1] : text;
    }
  }
  throw new EDrawingsError("כותרת המודל אינה תקינה — הקובץ אינו קובץ eDrawings תקין");
}

class SceneBuilder {
  readonly segments = new Map<string, HsfSegment>();
  readonly stubs = new Map<number, string>();
  readonly shells: HsfShell[] = [];
  private readonly stack: string[] = [];
  private tagCount = 0;
  /** What the next tag opcode labels. */
  private lastObject: { kind: "stub"; path: string } | null = null;
  private pointsTotal = 0;

  constructor(private readonly limits: HsfLimits) {}

  private current(): HsfSegment | null {
    const path = this.stack[this.stack.length - 1];
    return path === undefined ? null : (this.segments.get(path) ?? null);
  }

  private resolve(name: string): string {
    if (name.startsWith("/") || name.startsWith("?")) return name.startsWith("/") ? name : `/${name}`;
    const parent = this.stack[this.stack.length - 1] ?? "";
    return `${parent}/${name}`;
  }

  private segment(path: string): HsfSegment {
    let seg = this.segments.get(path);
    if (!seg) {
      if (this.segments.size >= this.limits.maxSegments) {
        throw new StopParse("המודל מכיל יותר מדי מקטעים");
      }
      seg = {
        path,
        matrix: null,
        children: [],
        includes: [],
        stubTags: [],
        options: [],
        faceColor: null,
      };
      this.segments.set(path, seg);
    }
    return seg;
  }

  /**
   * Choose among candidate payload lengths for an opcode whose layout is
   * only partly understood (heuristics, visibility): the first length after
   * which the stream continues with a plausible opcode wins. These two
   * opcodes carry rendering switches only, never geometry, and SOLIDWORKS
   * writes them a handful of times per file.
   */
  private skipByLookahead(reader: Reader, candidates: number[], nameHe: string): void {
    for (const length of candidates) {
      if (length > reader.remaining) continue;
      const saved = reader.pos;
      reader.pos += length;
      const ok = this.plausibleOpcodeHere(reader);
      if (ok) return;
      reader.pos = saved;
    }
    throw new StopParse(`לא ניתן לפענח פקודת ${nameHe}`);
  }

  private plausibleOpcodeHere(reader: Reader): boolean {
    const op = reader.peek();
    if (op < 0) return true;
    if (!KNOWN_OPCODES.has(op)) return false;
    // Padding and pauses are legal but too common as data bytes to count as
    // evidence; a pause is accepted only when a segment opens right after.
    if (op === 0x00) return false;
    if (op === 0x01) return reader.peek(1) === 0x28;
    if (op === 0x28) {
      const length = reader.peek(1);
      if (length <= 0 || reader.pos + 2 + length > reader.bytes.length) return false;
      return isPrintable(reader.bytes.subarray(reader.pos + 2, reader.pos + 2 + length));
    }
    if (op === 0x55) {
      const length = reader.peek(1) | (reader.peek(2) << 8);
      if (length <= 0 || reader.pos + 3 + length > reader.bytes.length) return false;
      return isPrintable(reader.bytes.subarray(reader.pos + 3, Math.min(reader.pos + 3 + length, reader.pos + 35)));
    }
    if (op === 0x53) return reader.peek(1) === 0x00;
    return true;
  }

  private readColorMask(reader: Reader): number {
    let mask = 0;
    let shift = 0;
    for (let i = 0; i < 4; i++) {
      const b = reader.u8();
      mask |= (b & 0x7f) << shift;
      shift += 8;
      if (!(b & 0x80)) break;
    }
    return mask;
  }

  private readShell(reader: Reader): void {
    reader.u8(); // leading byte, always 0 in SOLIDWORKS output
    const sub = reader.u8();

    if (sub & SH_EXPANDED) {
      const sub2 = reader.u16();
      if (sub2 & SH2_NULL) {
        reader.u8();
        const seg = this.current();
        if (!seg) throw new StopParse("צורה מחוץ למקטע");
        this.lastObject = { kind: "stub", path: seg.path };
        return;
      }
      throw new StopParse(`סוג צורה שאינו נתמך (0x${sub.toString(16)}/0x${sub2.toString(16)})`);
    }

    const unsupported = sub & ~(SH_COMPRESSED_FACES | SH_TRISTRIPS | SH_HAS_OPTIONALS);
    if (unsupported) {
      const what =
        unsupported & SH_COMPRESSED_POINTS
          ? "נקודות דחוסות"
          : unsupported & SH_CONNECTIVITY_COMPRESSION
            ? "דחיסת קישוריות (Edgebreaker)"
            : unsupported & SH_BOUNDING_ONLY
              ? "צורה של תיבה חוסמת בלבד"
              : unsupported & SH_FIRSTPASS
                ? "מעבר ראשון של רמות פירוט"
                : `0x${unsupported.toString(16)}`;
      throw new StopParse(`המודל משתמש בקידוד שעדיין לא נתמך: ${what}`);
    }
    if (!(sub & SH_TRISTRIPS) || !(sub & SH_COMPRESSED_FACES)) {
      throw new StopParse("המודל משתמש בקידוד פאות שעדיין לא נתמך");
    }

    const tag = reader.i32();
    const lod = reader.u8();
    const count = reader.i32();
    if (count < 0 || count > this.limits.maxPointsTotal - this.pointsTotal) {
      throw new StopParse("המודל מכיל מספר קודקודים בלתי סביר");
    }
    this.pointsTotal += count;
    const positions = reader.f32Array(count * 3);

    const scheme = reader.u8();
    const length = reader.i32();
    if (scheme !== 1) throw new StopParse(`שיטת דחיסת פאות לא נתמכת (${scheme})`);
    if (length < 1) throw new StopParse("נתוני פאות פגומים");
    const faceBytes = reader.take(length);
    const bits = faceBytes[0];
    let strips: Uint32Array;
    if (bits === 8) {
      strips = new Uint32Array(faceBytes.subarray(1));
    } else if (bits === 16 || bits === 32) {
      const width = bits / 8;
      const n = Math.floor((faceBytes.length - 1) / width);
      strips = new Uint32Array(n);
      const view = new DataView(faceBytes.buffer, faceBytes.byteOffset + 1, n * width);
      for (let i = 0; i < n; i++) {
        strips[i] = width === 2 ? view.getUint16(i * 2, true) : view.getUint32(i * 4, true);
      }
    } else {
      throw new StopParse(`רוחב אינדקסים לא נתמך (${bits} ביט)`);
    }

    if (sub & SH_HAS_OPTIONALS) {
      for (;;) {
        const opt = reader.u8();
        if (opt === OPT_TERMINATE) break;
        if (opt === OPT_ALL_NORMALS_COMPRESSED) {
          reader.u8(); // compression scheme
          reader.u8(); // bits per sample
          const n = reader.i32();
          if (n < 0) throw new StopParse("נתוני נורמלים פגומים");
          reader.skip(n);
        } else if (opt === OPT_ALL_PARAMETERS) {
          const width = reader.u8();
          reader.skip(width * count * 4);
        } else if (opt === OPT_ENTITY_ATTRIBUTES) {
          // Nested opcodes (the face's swfaceid) up to a terminating 0.
          while (reader.peek() !== 0x00) {
            if (reader.remaining <= 0) throw new StopParse("מאפייני צורה לא הסתיימו");
            this.readOpcode(reader, true);
          }
          reader.u8();
        } else {
          throw new StopParse(`נתון נלווה לא נתמך בצורה (0x${opt.toString(16)})`);
        }
      }
    }

    if (this.shells.length >= this.limits.maxShells) {
      throw new StopParse("המודל מכיל יותר מדי פאות");
    }
    // Coarser levels of detail duplicate level 0; only the full one is kept.
    if (lod === 0) this.shells.push({ tag, positions, strips });
    this.lastObject = null;
  }

  /** Read one opcode. Returns false at the end of the compressed region. */
  readOpcode(reader: Reader, nested = false): boolean {
    const op = reader.u8();
    switch (op) {
      case 0x00: // termination / padding
      case 0x01: // pause between passes
      case 0x5d: // ']' stop user data
        return true;
      case 0x7a: // 'z' stop compression
        return false;
      case 0x3b: {
        // ';' comment, to end of line
        while (reader.u8() !== 0x0a) {
          /* consume */
        }
        return true;
      }
      case 0x49: // 'I' file info
        reader.skip(4);
        return true;
      case 0x42: // 'B' bounding info
        reader.skip(2 + 24);
        return true;
      case 0x28: {
        // '(' open segment
        const name = utf8.decode(reader.take(reader.u8()));
        if (this.stack.length >= this.limits.maxDepth) throw new StopParse("עומק מקטעים בלתי סביר");
        const relative = !name.startsWith("/") && !name.startsWith("?");
        const parent = this.current();
        const path = this.resolve(name);
        this.segment(path);
        if (relative && parent && !parent.children.includes(path)) parent.children.push(path);
        this.stack.push(path);
        this.lastObject = null;
        return true;
      }
      case 0x29: // ')' close segment
        if (this.stack.length === 0) throw new StopParse("סגירת מקטע ללא פתיחה");
        this.stack.pop();
        this.lastObject = null;
        return true;
      case 0x71: // 'q' tag the previous object
        if (this.lastObject?.kind === "stub") {
          this.stubs.set(this.tagCount, this.lastObject.path);
          this.segment(this.lastObject.path).stubTags.push(this.tagCount);
        }
        this.tagCount++;
        this.lastObject = null;
        return true;
      case 0x55: {
        // 'U' user options
        const text = utf8.decode(reader.take(reader.u16()));
        if (!nested) this.current()?.options.push(text);
        return true;
      }
      case 0x16: {
        // unicode user options (UTF-16 code units)
        const text = utf16.decode(reader.take(reader.u16() * 2));
        if (!nested) this.current()?.options.push(text);
        return true;
      }
      case 0x68: // 'h' handedness
        reader.skip(1);
        return true;
      case 0x4a: // 'J' line style definition
        reader.skip(reader.u8());
        reader.skip(reader.u16());
        return true;
      case 0x7e: {
        // '~' colour by RGB
        const mask = this.readColorMask(reader);
        const rgb = reader.take(3);
        const seg = this.current();
        if (seg && mask & 0x01) seg.faceColor = [rgb[0], rgb[1], rgb[2]];
        return true;
      }
      case 0x22: {
        // '"' colour by material channels
        const mask = this.readColorMask(reader);
        const channels = reader.u8();
        for (let bit = 0; bit < 7; bit++) {
          if (!(channels & (1 << bit))) continue;
          if (bit > 4) throw new StopParse("ערוץ צבע לא נתמך");
          const nameLength = reader.u8();
          if (nameLength > 0) {
            reader.skip(nameLength);
          } else {
            const rgb = reader.take(3);
            const seg = this.current();
            if (bit === 0 && seg && mask & 0x01) seg.faceColor = [rgb[0], rgb[1], rgb[2]];
          }
        }
        return true;
      }
      case 0x3c: {
        // '<' include segment
        reader.u8();
        const name = utf8.decode(reader.take(reader.u8()));
        const seg = this.current();
        if (seg) seg.includes.push(this.resolve(name));
        return true;
      }
      case 0x25: {
        // '%' modelling matrix
        reader.u8();
        const m = reader.f32Array(12);
        const seg = this.current();
        if (seg) seg.matrix = Array.from(m);
        return true;
      }
      case 0x5b: {
        // '[' user data block
        const n = reader.i32();
        if (n < 0) throw new StopParse("בלוק נתונים פגום");
        reader.skip(n);
        return true;
      }
      case 0x7d: // '}' named view
        reader.skip(2 + 44);
        reader.skip(reader.u8());
        return true;
      case 0x48: // 'H' heuristics
        this.skipByLookahead(reader, [5, 4, 6, 3, 7], "הגדרות תצוגה");
        return true;
      case 0x56: // 'V' visibility
        this.skipByLookahead(reader, [6, 4, 8, 10], "נראות");
        return true;
      case 0x3d: // '=' line weight
      case 0x0e: // edge weight
        reader.skip(4);
        return true;
      case 0x40: // '@' marker symbol
        reader.skip(1);
        return true;
      case 0x2d: // '-' line pattern
      case 0x0d: {
        // edge pattern
        if (reader.u8() === 0xff) reader.skip(reader.u8());
        return true;
      }
      case 0x53: // 'S' shell
        this.readShell(reader);
        return true;
      default:
        reader.pos--;
        throw new StopParse(`פקודה לא מוכרת (0x${op.toString(16).padStart(2, "0")})`);
    }
  }
}

/**
 * Parse an eModel HSF stream into segments, placeholders and shells.
 *
 * Structural problems that make the file unusable throw EDrawingsError.
 * An unknown opcode mid-stream does NOT throw: the scene so far is returned
 * with `stop` filled in, and the model layer decides (by counting filled
 * placeholders) whether anything is missing.
 */
export async function parseHsf(eModel: Uint8Array, limits: HsfLimits = HSF_LIMITS): Promise<HsfScene> {
  const outer = new Reader(eModel);
  const version = readHeader(outer);
  const builder = new SceneBuilder(limits);

  const finish = (stop: HsfStop | null): HsfScene => {
    return {
      version,
      segments: builder.segments,
      stubs: builder.stubs,
      shells: builder.shells,
      stop,
    };
  };

  const run = (reader: Reader): HsfStop | null | "compressed" => {
    while (reader.remaining > 0) {
      const at = reader.pos;
      if (reader.peek() === 0x5a) {
        reader.u8();
        return "compressed";
      }
      try {
        if (!builder.readOpcode(reader)) return null;
      } catch (error) {
        if (error instanceof StopParse) {
          return {
            offset: at,
            opcodeHex: `0x${(reader.bytes[at] ?? 0).toString(16).padStart(2, "0")}`,
            reasonHe: error.reasonHe,
          };
        }
        throw error;
      }
    }
    return null;
  };

  const first = run(outer);
  if (first !== "compressed") return finish(first);

  const inflated = await inflateZlibPrefix(eModel.subarray(outer.pos), limits.maxInflatedBytes);
  const inner = new Reader(inflated);
  const second = run(inner);
  if (second === "compressed") {
    return finish({
      offset: inner.pos - 1,
      opcodeHex: "0x5a",
      reasonHe: "דחיסה מקוננת אינה נתמכת",
    });
  }
  return finish(second);
}
