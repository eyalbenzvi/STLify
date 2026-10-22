/**
 * eDrawings model: from an HSF scene to printable components.
 *
 * hsf.ts produces a segment tree, placeholders and shells; this file walks
 * the tree the way eDrawings draws it — modelling matrices compose from the
 * leaf outwards, includes pull shared body segments into each component
 * instance — and gathers each component's faces into one welded mesh.
 *
 * A "component" is the deepest segment carrying a `name=` user option, i.e.
 * one placed part instance (SOLIDWORKS writes `name=Bracket-2,…`). A part
 * used three times is three components, each at its own position.
 *
 * Units: SOLIDWORKS stores eDrawings geometry in metres. When the file also
 * carries mass properties (`volume=` in m³), the decoded volume is compared
 * against it — an independent check that units AND geometry came out right.
 */

import type { MeshData } from "@/lib/geometry/meshData";
import { readEDrawingsContainer } from "./container";
import { EDrawingsError } from "./errors";
import { parseHsf, type HsfLimits, HSF_LIMITS, type HsfScene, type HsfSegment } from "./hsf";

export type EDrawingsUnit = "m" | "mm" | "in";

/** Millimetres per file unit. */
export const EDRAWINGS_UNIT_TO_MM: Record<EDrawingsUnit, number> = {
  m: 1000,
  mm: 1,
  in: 25.4,
};

export const EDRAWINGS_UNIT_LABELS_HE: Record<EDrawingsUnit, string> = {
  m: "מטרים (ברירת המחדל של SOLIDWORKS)",
  mm: "מילימטרים",
  in: "אינצ׳ים",
};

export interface EDrawingsBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface EDrawingsComponent {
  id: string;
  /** "Assembly-1 / Part-2" — the named segments from the root down. */
  name: string;
  /** False when the file's display state hides this component. */
  visibleInFile: boolean;
  /** Dominant face colour, "#rrggbb", or null when the file sets none. */
  colorHex: string | null;
  /**
   * World-space geometry in FILE units (not mm), one exact-welded mesh per
   * SOLIDWORKS body. Bodies stay separate because a component's bodies may
   * overlap: each is repaired on its own and then united exactly, rather
   * than handing the repair stage one self-intersecting soup.
   */
  bodies: MeshData[];
  triangleCount: number;
  /** SOLIDWORKS faces (shells) that make up this component. */
  faceCount: number;
  bounds: EDrawingsBounds;
}

export type EDrawingsUnitCheck = "verified" | "mismatch" | "unknown";

export interface EDrawingsModel {
  /** HSF stream version, e.g. "V20.90". */
  formatVersion: string;
  configurationName: string | null;
  components: EDrawingsComponent[];
  /** Face placeholders the file declares. */
  facesDeclared: number;
  /** Placeholders actually filled with geometry. */
  facesDecoded: number;
  /** Every declared face was decoded. */
  complete: boolean;
  /** Mass-properties volume written by SOLIDWORKS, m³. */
  massVolumeM3: number | null;
  /** Signed volume of all decoded geometry, file units³. */
  decodedVolume: number;
  unitCheck: EDrawingsUnitCheck;
  warningsHe: string[];
  /** Raw OLE record (see container.ts) for future permission research. */
  oleRecordHex: string | null;
}

export interface EDrawingsBuildLimits {
  /** Vertices emitted across all component instances. */
  maxInstanceVertices: number;
  /** Include/child nesting depth. */
  maxDepth: number;
}

export const EDRAWINGS_BUILD_LIMITS: EDrawingsBuildLimits = {
  maxInstanceVertices: 30_000_000,
  maxDepth: 128,
};

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** `a` applied first, then `b` (row-vector convention, 4x3 row-major). */
function compose(a: number[], b: number[]): number[] {
  const r = new Array<number>(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  for (let j = 0; j < 3; j++) {
    r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  }
  return r;
}

function parseOptions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  // Values may be backtick-quoted and contain commas.
  const re = /([^=,]+)=(`[^`]*`|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const key = match[1].trim();
    let value = match[2];
    if (value.startsWith("`") && value.endsWith("`")) value = value.slice(1, -1);
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

function segmentOption(seg: HsfSegment | undefined, key: string): string | null {
  if (!seg) return null;
  for (const text of seg.options) {
    const value = parseOptions(text).get(key);
    if (value !== undefined) return value;
  }
  return null;
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Decode a triangle-strip stream into triangles; returns false on bad data. */
export function appendStripTriangles(
  strips: Uint32Array,
  vertexCount: number,
  base: number,
  out: number[]
): boolean {
  let i = 0;
  while (i < strips.length) {
    const count = strips[i++];
    if (count === 0 || i + count > strips.length) return false;
    for (let k = 0; k < count; k++) if (strips[i + k] >= vertexCount) return false;
    for (let k = 0; k + 2 < count; k++) {
      let a = strips[i + k];
      let b = strips[i + k + 1];
      const c = strips[i + k + 2];
      // Every other strip triangle is wound the other way.
      if (k % 2 === 1) [a, b] = [b, a];
      if (a === b || b === c || a === c) continue;
      out.push(base + a, base + b, base + c);
    }
    i += count;
  }
  return true;
}

interface Emission {
  /** Body instance this face belongs to. */
  body: string;
  tag: number;
  matrix: number[];
  color: [number, number, number] | null;
}

interface ComponentAccumulator {
  key: string;
  name: string;
  visible: boolean;
  emissions: Emission[];
}

function findThreeDRoot(scene: HsfScene): { root: string; config: string } | null {
  for (const path of scene.segments.keys()) {
    const match = /^(\/config\d+)\/sheet\d+\/view\d+\/3dmodel$/.exec(path);
    if (match) return { root: path, config: match[1] };
  }
  return null;
}

/** Display-state visibility: segment path (no leading slash) → visible. */
function readDisplayState(scene: HsfScene, config: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const states = scene.segments.get(`${config}/displaystates`);
  const defaultState = segmentOption(states, "default");
  if (!states || !defaultState) return out;
  const state = scene.segments.get(`${config}/displaystates/${defaultState}`);
  for (const child of state?.children ?? []) {
    const seg = scene.segments.get(child);
    const path = segmentOption(seg, "path");
    const vis = segmentOption(seg, "vis");
    if (path && vis) out.set(`/${path}`, vis !== "off");
  }
  return out;
}

export function buildEDrawingsModel(
  scene: HsfScene,
  extras: { oleRecordHex: string | null } = { oleRecordHex: null },
  limits: EDrawingsBuildLimits = EDRAWINGS_BUILD_LIMITS
): EDrawingsModel {
  const warningsHe: string[] = [];
  const shellsByTag = new Map<number, HsfScene["shells"][number]>();
  for (const shell of scene.shells) {
    if (scene.stubs.has(shell.tag)) shellsByTag.set(shell.tag, shell);
  }
  const facesDeclared = scene.stubs.size;
  const facesDecoded = shellsByTag.size;

  if (facesDecoded === 0) {
    throw new EDrawingsError(
      scene.stop
        ? `לא נמצאה גאומטריה שניתן לפענח בקובץ. ${scene.stop.reasonHe}`
        : "הקובץ אינו מכיל גאומטריה תלת־ממדית (ייתכן שזה שרטוט דו־ממדי)"
    );
  }
  const complete = facesDecoded === facesDeclared;
  if (!complete) {
    const reason = scene.stop ? ` — ${scene.stop.reasonHe} (מיקום ${scene.stop.offset})` : "";
    warningsHe.push(
      `פוענחו ${facesDecoded.toLocaleString()} מתוך ${facesDeclared.toLocaleString()} פאות${reason}. ` +
        "חלקים מהמודל עלולים להיות חסרים או פתוחים — בדקו את התצוגה לפני הייבוא."
    );
  }

  const located = findThreeDRoot(scene);
  const components: ComponentAccumulator[] = [];
  let emittedVertices = 0;

  if (located) {
    const visibility = readDisplayState(scene, located.config);
    const byKey = new Map<string, ComponentAccumulator>();
    const active = new Set<string>();
    let includeInstance = 0;

    const visit = (
      path: string,
      parentMatrix: number[],
      names: string[],
      componentKey: string,
      bodyKey: string,
      visible: boolean,
      color: [number, number, number] | null,
      depth: number
    ): void => {
      if (depth > limits.maxDepth || active.has(path)) return;
      const seg = scene.segments.get(path);
      if (!seg) return;
      active.add(path);
      const matrix = seg.matrix ? compose(seg.matrix, parentMatrix) : parentMatrix;
      const name = segmentOption(seg, "name");
      let key = componentKey;
      let body = bodyKey;
      let ownNames = names;
      let ownVisible = visible;
      if (name && !path.includes("include library")) {
        key = path;
        body = path;
        ownNames = [...names, name];
        const vis = visibility.get(path);
        if (vis === false) ownVisible = false;
      }
      const ownColor = seg.faceColor ?? color;

      for (const tag of seg.stubTags) {
        const shell = shellsByTag.get(tag);
        if (!shell) continue;
        emittedVertices += shell.positions.length / 3;
        if (emittedVertices > limits.maxInstanceVertices) {
          throw new EDrawingsError("ההרכבה גדולה מדי לייבוא (יותר מדי קודקודים אחרי פריסת המופעים)");
        }
        let acc = byKey.get(key);
        if (!acc) {
          acc = {
            key,
            name: ownNames.join(" / ") || "מודל",
            visible: ownVisible,
            emissions: [],
          };
          byKey.set(key, acc);
          components.push(acc);
        }
        acc.emissions.push({ body, tag, matrix, color: ownColor });
      }
      for (const child of seg.children) {
        visit(child, matrix, ownNames, key, body, ownVisible, ownColor, depth + 1);
      }
      // Each include of a shared body segment is one body instance.
      for (const include of seg.includes) {
        visit(include, matrix, ownNames, key, `${include}#${includeInstance++}`, ownVisible, ownColor, depth + 1);
      }
      active.delete(path);
    };
    visit(located.root, IDENTITY, [], located.root, located.root, true, null, 0);
  }

  if (components.length === 0) {
    // No recognisable 3D tree: keep the geometry rather than lose it, in the
    // coordinates the shells were written in.
    warningsHe.push("מבנה ההרכבה בקובץ לא זוהה — כל הגאומטריה יובאה כרכיב אחד, ללא מיקומי רכיבים.");
    components.push({
      key: "all",
      name: "מודל",
      visible: true,
      emissions: [...shellsByTag.keys()].map((tag) => ({ body: "all", tag, matrix: IDENTITY, color: null })),
    });
  }

  let invalidFaces = 0;
  let decodedVolume = 0;
  const built: EDrawingsComponent[] = [];
  for (const acc of components) {
    const bodyMeshes: { positions: number[]; indices: number[]; weld: Map<string, number> }[] = [];
    const bodyIndex = new Map<string, number>();
    const colorWeights = new Map<string, number>();
    let triangleCount = 0;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const emission of acc.emissions) {
      const shell = shellsByTag.get(emission.tag);
      if (!shell) continue;
      let bi = bodyIndex.get(emission.body);
      if (bi === undefined) {
        bi = bodyMeshes.length;
        bodyIndex.set(emission.body, bi);
        bodyMeshes.push({ positions: [], indices: [], weld: new Map() });
      }
      const { positions, indices, weld } = bodyMeshes[bi];
      const m = emission.matrix;
      const local: number[] = [];
      const remap = new Uint32Array(shell.positions.length / 3);
      const p = shell.positions;
      for (let v = 0; v < remap.length; v++) {
        const x = p[v * 3];
        const y = p[v * 3 + 1];
        const z = p[v * 3 + 2];
        const wx = Math.fround(x * m[0] + y * m[3] + z * m[6] + m[9]);
        const wy = Math.fround(x * m[1] + y * m[4] + z * m[7] + m[10]);
        const wz = Math.fround(x * m[2] + y * m[5] + z * m[8] + m[11]);
        const key = `${wx},${wy},${wz}`;
        let index = weld.get(key);
        if (index === undefined) {
          index = positions.length / 3;
          weld.set(key, index);
          positions.push(wx, wy, wz);
          if (wx < min[0]) min[0] = wx;
          if (wy < min[1]) min[1] = wy;
          if (wz < min[2]) min[2] = wz;
          if (wx > max[0]) max[0] = wx;
          if (wy > max[1]) max[1] = wy;
          if (wz > max[2]) max[2] = wz;
        }
        remap[v] = index;
      }
      if (!appendStripTriangles(shell.strips, remap.length, 0, local)) {
        invalidFaces++;
        continue;
      }
      let added = 0;
      for (let i = 0; i < local.length; i += 3) {
        const a = remap[local[i]];
        const b = remap[local[i + 1]];
        const c = remap[local[i + 2]];
        if (a === b || b === c || a === c) continue;
        indices.push(a, b, c);
        added++;
        const pa = a * 3;
        const pb = b * 3;
        const pc = c * 3;
        decodedVolume +=
          (positions[pa] * (positions[pb + 1] * positions[pc + 2] - positions[pb + 2] * positions[pc + 1]) -
            positions[pa + 1] * (positions[pb] * positions[pc + 2] - positions[pb + 2] * positions[pc]) +
            positions[pa + 2] * (positions[pb] * positions[pc + 1] - positions[pb + 1] * positions[pc])) /
          6;
      }
      triangleCount += added;
      if (emission.color) {
        const hex = toHex(emission.color);
        colorWeights.set(hex, (colorWeights.get(hex) ?? 0) + added);
      }
    }
    if (triangleCount === 0) continue;

    let colorHex: string | null = null;
    let best = 0;
    for (const [hex, weight] of colorWeights) {
      if (weight > best) {
        best = weight;
        colorHex = hex;
      }
    }
    built.push({
      id: `c${built.length}`,
      name: acc.name,
      visibleInFile: acc.visible,
      colorHex,
      bodies: bodyMeshes
        .filter((b) => b.indices.length > 0)
        .map((b) => ({ positions: new Float32Array(b.positions), indices: new Uint32Array(b.indices) })),
      triangleCount,
      faceCount: acc.emissions.length,
      bounds: { min, max },
    });
  }
  if (invalidFaces > 0) {
    warningsHe.push(`${invalidFaces.toLocaleString()} פאות עם נתוני משולשים פגומים דולגו.`);
  }
  if (built.length === 0) {
    throw new EDrawingsError("לא נמצאו משולשים תקינים בקובץ");
  }

  const massVolumeText = located
    ? segmentOption(scene.segments.get(`${located.config}/massprops`), "volume")
    : null;
  const massVolumeM3 = massVolumeText !== null && Number.isFinite(Number(massVolumeText))
    ? Number(massVolumeText)
    : null;
  let unitCheck: EDrawingsUnitCheck = "unknown";
  if (massVolumeM3 !== null && massVolumeM3 > 0 && decodedVolume > 0) {
    const ratio = decodedVolume / massVolumeM3;
    unitCheck = ratio > 0.9 && ratio < 1.1 ? "verified" : "mismatch";
    if (unitCheck === "mismatch") {
      warningsHe.push(
        "נפח הגאומטריה שפוענחה אינו תואם את נתוני המסה שבקובץ — ייתכן שיחידות המידה שונות ממטרים, או שחלק מהמודל חסר. בדקו את המידות לפני הייבוא."
      );
    }
  }

  return {
    formatVersion: scene.version,
    configurationName: located
      ? segmentOption(scene.segments.get(located.config), "config name")
      : null,
    components: built,
    facesDeclared,
    facesDecoded,
    complete,
    massVolumeM3,
    decodedVolume,
    unitCheck,
    warningsHe,
    oleRecordHex: extras.oleRecordHex,
  };
}

/** Container → HSF → model. The whole parse, as the worker job runs it. */
export async function parseEDrawingsFile(
  buffer: ArrayBuffer,
  options: { hsfLimits?: HsfLimits; buildLimits?: EDrawingsBuildLimits } = {}
): Promise<EDrawingsModel> {
  const container = await readEDrawingsContainer(buffer);
  const scene = await parseHsf(container.eModel, options.hsfLimits ?? HSF_LIMITS);
  return buildEDrawingsModel(
    scene,
    { oleRecordHex: container.oleRecordHex },
    options.buildLimits ?? EDRAWINGS_BUILD_LIMITS
  );
}
