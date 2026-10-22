/**
 * Synthetic eDrawings files for tests.
 *
 * Writes the stream layout SOLIDWORKS produces (docs/EDRAWINGS-PLAN.md):
 * header comment, file info and bounding opcodes, then a zlib region holding
 * a segment tree whose faces are NULL placeholder shells, each tagged, and a
 * second pass of real shells that name the tag they fill. Each box face is
 * its own shell, as SOLIDWORKS writes one shell per B-rep face.
 *
 * Real customer files are not committed to the repository; this writer is
 * what lets the unit, security and browser suites run everywhere. Relative
 * imports only, because the Playwright suite imports it too.
 */

import { createZip } from "../export/zip";

export interface FixtureFace {
  /** xyz triples, metres. */
  positions: number[];
  /** Strip stream: [count, i0, i1, …]. */
  strips: number[];
}

export interface FixtureBody {
  faces: FixtureFace[];
  color?: [number, number, number];
}

export interface FixtureComponent {
  name: string;
  /** Row-major 4x3 (X axis, Y axis, Z axis, translation), metres. */
  matrix?: number[];
  /** Indices into `bodies`. A body used twice is written once and included twice. */
  bodies: number[];
  hidden?: boolean;
}

export interface FixtureOptions {
  bodies: FixtureBody[];
  components: FixtureComponent[];
  /** Mass-properties volume to write, m³ (omitted when undefined). */
  massVolumeM3?: number;
  /** Tags whose geometry is left out of the second pass. */
  omitTags?: number[];
  /** Raw bytes spliced in just before the geometry pass. */
  injectBeforeGeometry?: number[];
  /** Write ZIP around the stream (default true). */
  zip?: boolean;
}

/** An axis-aligned box (metres), one 4-vertex shell per face. */
export function boxBody(
  min: [number, number, number],
  max: [number, number, number],
  color?: [number, number, number]
): FixtureBody {
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const h = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
  // [normal axis, sign, u axis, v axis] with u × v = outward normal.
  const faces: [number, number, number, number][] = [
    [0, 1, 1, 2],
    [0, -1, 2, 1],
    [1, 1, 2, 0],
    [1, -1, 0, 2],
    [2, 1, 0, 1],
    [2, -1, 1, 0],
  ];
  return {
    color,
    faces: faces.map(([n, sign, u, v]) => {
      const corner = (su: number, sv: number) => {
        const p = [...c];
        p[n] += sign * h[n];
        p[u] += su * h[u];
        p[v] += sv * h[v];
        return p;
      };
      // Zig-zag order: the strip [0,1,2,3] gives (0,1,2) and (2,1,3), both CCW.
      const positions = [...corner(-1, -1), ...corner(1, -1), ...corner(-1, 1), ...corner(1, 1)];
      return { positions, strips: [4, 0, 1, 2, 3] };
    }),
  };
}

class Bytes {
  private out: number[] = [];
  u8(v: number): this {
    this.out.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >> 8);
  }
  i32(v: number): this {
    return this.u8(v).u8(v >> 8).u8(v >> 16).u8(v >> 24);
  }
  f32(v: number): this {
    const b = new Uint8Array(new Float32Array([v]).buffer);
    for (const x of b) this.u8(x);
    return this;
  }
  raw(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) this.u8(bytes[i]);
    return this;
  }
  ascii(text: string): this {
    for (const ch of text) this.u8(ch.charCodeAt(0));
    return this;
  }
  op(c: string): this {
    return this.u8(c.charCodeAt(0));
  }
  open(name: string): this {
    return this.op("(").u8(name.length).ascii(name);
  }
  close(): this {
    return this.op(")");
  }
  options(text: string): this {
    const utf8 = new TextEncoder().encode(text);
    return this.op("U").u16(utf8.length).raw(utf8);
  }
  bytes(): Uint8Array {
    return new Uint8Array(this.out);
  }
}

async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** Build the inner (to-be-compressed) HSF stream. */
export function buildInnerStream(options: FixtureOptions): Uint8Array {
  const s = new Bytes();
  // A user-data block like the one SOLIDWORKS opens with.
  s.op("[").i32(4).raw([1, 2, 3, 4]).raw([0, 0]).op("]");
  s.open("reference").options("refname=Fixture.SLDASM").close();
  s.open("config0").options("config name=Default");
  s.open("sheet0").open("view0").open("3dmodel");
  // Rendering switches whose layout is only partly understood.
  s.op("V").raw([0xdf, 0x56, 0x0e, 0x20, 0x00, 0x00]);
  s.open("includes");
  s.op("H").raw([0x04, 0x00, 0x04, 0x00, 0x01]);

  let tag = 0;
  const faceTags: { tag: number; face: FixtureFace }[] = [];
  const written = new Set<number>();
  options.components.forEach((component, i) => {
    s.open(`assempart${i}`).options(`name=${component.name},showbits0=1`);
    s.open("part");
    s.op("%").u8(0);
    for (const v of component.matrix ?? IDENTITY) s.f32(v);
    for (const b of component.bodies) {
      const path = `/include library/shared/body${b}`;
      if (!written.has(b)) {
        written.add(b);
        const body = options.bodies[b];
        s.open(path).open(`body${b}sub0`);
        if (body.color) s.op("~").u8(0x01).raw(body.color);
        for (const face of body.faces) {
          s.op("S").u8(0).u8(0x90).u16(0x0002).u8(0).op("q");
          faceTags.push({ tag: tag++, face });
        }
        s.close().close();
      }
      s.op("<").u8(0).u8(path.length).ascii(path);
    }
    s.close().close();
  });
  s.close().close().close().close(); // includes, 3dmodel, view0, sheet0

  if (options.massVolumeM3 !== undefined) {
    s.open("massprops").options(`mass=1.0,volume=${options.massVolumeM3},area=1.0`).close();
  }
  s.open("displaystates").options("default=disp0").open("disp0");
  options.components.forEach((component, i) => {
    s.open(`comp${i}`)
      .options(`path=config0/sheet0/view0/3dmodel/includes/assempart${i},vis=${component.hidden ? "off" : "on"}`)
      .close();
  });
  s.close().close().close(); // disp0, displaystates, config0

  if (options.injectBeforeGeometry) s.raw(options.injectBeforeGeometry);

  // Second pass: real shells, each naming the placeholder it fills.
  s.u8(0x01).open("?Include Library/references");
  const omit = new Set(options.omitTags ?? []);
  for (const { tag: t, face } of faceTags) {
    if (omit.has(t)) continue;
    const n = face.positions.length / 3;
    s.op("S").u8(0).u8(0x0e).i32(t).u8(0).i32(n);
    for (const v of face.positions) s.f32(v);
    s.u8(1).i32(1 + face.strips.length).u8(8).raw(face.strips);
    const normals = Math.ceil((n * 3) / 4) * 4;
    s.u8(0x01).u8(7).u8(12).i32(normals).raw(new Array(normals).fill(0));
    s.u8(0x63).options(`swfaceid=${t + 100}`).u8(0);
    s.u8(0);
  }
  s.close();
  // Edge pass: an opcode this reader does not implement, as in real files.
  s.op("s").i32(0).op("l").u8(0);
  for (let i = 0; i < 6; i++) s.f32(0);
  s.close();
  s.op("z");
  return s.bytes();
}

/** A complete .easm file (ZIP container around the HSF stream). */
export async function buildEDrawingsFixture(options: FixtureOptions): Promise<Uint8Array> {
  const header = new Bytes()
    .ascii(";; HSF V20.90 \n")
    .op("I")
    .i32(0x8004)
    .op("B")
    .u8(0)
    .u8(0);
  for (let i = 0; i < 6; i++) header.f32(i < 3 ? -1 : 1);
  header.op("Z");
  const compressed = await deflateZlib(buildInnerStream(options));
  const eModel = new Uint8Array([...header.bytes(), ...compressed, 0x00]);
  if (options.zip === false) return eModel;
  const zip = createZip([
    { name: "eModel", data: eModel },
    { name: "OLE", data: new Uint8Array([0x50, 0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
  ]);
  return new Uint8Array(await zip.arrayBuffer());
}
