/**
 * 3MF import (3MF Core spec, the same subset lib/export/threeMF.ts writes).
 *
 * Handles what the Core spec asks of a reader for printable geometry:
 * multiple objects, a build with per-item transforms, component hierarchies
 * with their own transforms, and basematerials for colour and material name.
 *
 * Two things about OUR writer that a reader has to know, because otherwise a
 * round trip loses information:
 *
 * - Support objects are wrapped. The Core spec forbids referencing a
 *   `type="support"` object directly from the build, so the writer emits a
 *   model object whose single component points at the typed one. Flattening
 *   the component tree to its LEAF meshes makes the wrapper contribute
 *   nothing on its own, which is exactly right — it is packaging, not a body.
 * - Assemblies are objects whose components are the parent's own mesh plus
 *   each child at a relative transform. The same flattening turns that back
 *   into one layer per body, each placed where it was.
 *
 * Untrusted input. Everything here is bounded: archive size and count in
 * `zipRead`, DOCTYPE/entities refused in `xmlLite`, and object/vertex/triangle
 * counts here. Every refusal is a Hebrew message, and none of them escape as
 * a raw throw.
 */

import type { MeshData } from "@/lib/geometry/meshData";
import { readZip, ZipReadError } from "./zipRead";
import {
  childNamed,
  childrenNamed,
  parseXmlLite,
  XmlLiteError,
  type XmlElement,
} from "./xmlLite";

/** Import failure with a Hebrew user-facing message. */
export class ThreeMfImportError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "ThreeMfImportError";
  }
}

export const THREE_MF_LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxObjects: 512,
  maxVerticesPerObject: 2_000_000,
  maxTrianglesTotal: 2_000_000,
  /** How deep a component hierarchy may nest before we call it hostile. */
  maxComponentDepth: 32,
  /** Total component references followed, so a DAG cannot blow up combinatorially. */
  maxComponentExpansions: 20_000,
} as const;

/** One body recovered from the build, already placed. */
export interface ThreeMfImportedObject {
  name: string;
  /** Geometry rebased so it is centred in XY and rests on z = 0. */
  mesh: MeshData;
  /** Where the rebased mesh has to sit to be where the file put it, mm. */
  position: { x: number; y: number; z: number };
  colorHex: string | null;
  materialName: string | null;
  /** What the file says this body IS — supports must not print as models. */
  role: "model" | "support";
}

export interface ThreeMfImportResult {
  objects: ThreeMfImportedObject[];
  warningsHe: string[];
  /** Millimetres per file unit; geometry below is already converted. */
  unitScale: number;
}

/**
 * A 3MF transform: the three rows of the 3×3 followed by the translation, so
 * a point maps to `p·M + t`. Same layout the writer emits.
 */
type Transform12 = readonly number[];

const IDENTITY_12: Transform12 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseTransform(value: string | undefined): Transform12 {
  if (!value) return IDENTITY_12;
  const numbers = value.trim().split(/[\s,]+/).map(Number);
  if (numbers.length !== 12 || numbers.some((n) => !Number.isFinite(n))) {
    return IDENTITY_12;
  }
  return numbers;
}

/** `outer ∘ inner`: apply `inner` first, then `outer`. */
function composeTransforms(outer: Transform12, inner: Transform12): number[] {
  const out = new Array<number>(12).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = row === 3 ? outer[9 + col] : 0;
      for (let k = 0; k < 3; k++) sum += inner[row * 3 + k] * outer[k * 3 + col];
      out[row * 3 + col] = sum;
    }
  }
  return out;
}

/** Millimetres per unit, per the Core spec's `unit` attribute. */
const UNIT_SCALE: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

interface MeshResource {
  positions: Float64Array;
  indices: Uint32Array;
}

interface ObjectResource {
  id: string;
  name: string;
  type: "model" | "support" | "other";
  pid: string | null;
  pindex: number;
  mesh: MeshResource | null;
  components: { objectId: string; transform: Transform12 }[];
}

function requireNumber(value: string | undefined, whatHe: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ThreeMfImportError(`קובץ ה-3MF פגום — ${whatHe} אינו מספר תקין`);
  }
  return n;
}

function parseMesh(element: XmlElement, objectName: string): MeshResource {
  const vertexRoot = childNamed(element, "vertices");
  const triangleRoot = childNamed(element, "triangles");
  const vertexNodes = vertexRoot ? childrenNamed(vertexRoot, "vertex") : [];
  const triangleNodes = triangleRoot ? childrenNamed(triangleRoot, "triangle") : [];
  if (vertexNodes.length === 0 || triangleNodes.length === 0) {
    throw new ThreeMfImportError(`האובייקט "${objectName}" בקובץ ה-3MF ריק מגאומטריה`);
  }
  if (vertexNodes.length > THREE_MF_LIMITS.maxVerticesPerObject) {
    throw new ThreeMfImportError("קובץ ה-3MF מכיל אובייקט עם יותר מדי קודקודים");
  }

  const positions = new Float64Array(vertexNodes.length * 3);
  for (let i = 0; i < vertexNodes.length; i++) {
    const a = vertexNodes[i].attrs;
    positions[i * 3] = requireNumber(a.x, "קואורדינטת קודקוד");
    positions[i * 3 + 1] = requireNumber(a.y, "קואורדינטת קודקוד");
    positions[i * 3 + 2] = requireNumber(a.z, "קואורדינטת קודקוד");
  }

  const indices = new Uint32Array(triangleNodes.length * 3);
  for (let i = 0; i < triangleNodes.length; i++) {
    const a = triangleNodes[i].attrs;
    for (const [slot, key] of [
      [0, "v1"],
      [1, "v2"],
      [2, "v3"],
    ] as const) {
      const index = requireNumber(a[key], "אינדקס משולש");
      if (!Number.isInteger(index) || index < 0 || index >= vertexNodes.length) {
        throw new ThreeMfImportError("קובץ ה-3MF פגום — משולש מפנה לקודקוד שאינו קיים");
      }
      indices[i * 3 + slot] = index;
    }
  }
  return { positions, indices };
}

/** #RRGGBBAA or #RRGGBB → #rrggbb; anything else → null. */
function parseDisplayColor(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value.trim());
  return match ? `#${match[1].toLowerCase()}` : null;
}

/** Locate the model part, preferring the relationship over the convention. */
function findModelPart(entries: Map<string, Uint8Array>): Uint8Array {
  const rels = entries.get("_rels/.rels");
  if (rels) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(rels);
    const match = /Target\s*=\s*"([^"]+)"/i.exec(text);
    if (match) {
      const target = match[1].replace(/^\//, "");
      const found = entries.get(target);
      if (found) return found;
    }
  }
  const conventional = entries.get("3D/3dmodel.model");
  if (conventional) return conventional;
  for (const [name, data] of entries) {
    if (name.toLowerCase().endsWith(".model")) return data;
  }
  throw new ThreeMfImportError("קובץ ה-3MF אינו מכיל חלק מודל (3dmodel.model)");
}

/** Parse a .3mf package into placed bodies. */
export async function parseThreeMf(buffer: ArrayBuffer): Promise<ThreeMfImportResult> {
  if (buffer.byteLength > THREE_MF_LIMITS.maxFileBytes) {
    throw new ThreeMfImportError("קובץ ה-3MF גדול מדי (מקסימום 100MB)");
  }
  let entries: Map<string, Uint8Array>;
  try {
    entries = await readZip(buffer);
  } catch (error) {
    if (error instanceof ZipReadError) throw new ThreeMfImportError(error.messageHe);
    throw new ThreeMfImportError("לא ניתן לפתוח את קובץ ה-3MF — ייתכן שהוא פגום");
  }

  const modelBytes = findModelPart(entries);
  let model: XmlElement;
  try {
    model = parseXmlLite(new TextDecoder("utf-8", { fatal: false }).decode(modelBytes));
  } catch (error) {
    if (error instanceof XmlLiteError) throw new ThreeMfImportError(error.messageHe);
    throw new ThreeMfImportError("לא ניתן לקרוא את תוכן ה-3MF — ייתכן שהקובץ פגום");
  }
  if (model.name !== "model") {
    throw new ThreeMfImportError("קובץ ה-3MF אינו תקין — חסר אלמנט model");
  }

  const warningsHe: string[] = [];
  const unitScale = UNIT_SCALE[model.attrs.unit ?? "millimeter"] ?? 1;
  if (model.attrs.unit && !(model.attrs.unit in UNIT_SCALE)) {
    warningsHe.push(`יחידת המידה "${model.attrs.unit}" אינה מוכרת — הקובץ נקרא כמילימטרים`);
  }

  const resources = childNamed(model, "resources");
  if (!resources) throw new ThreeMfImportError("קובץ ה-3MF אינו תקין — חסר אלמנט resources");

  // Materials: id → list of { name, colour }, indexed by pindex.
  const materials = new Map<string, { name: string | null; colorHex: string | null }[]>();
  for (const group of childrenNamed(resources, "basematerials")) {
    const id = group.attrs.id;
    if (!id) continue;
    materials.set(
      id,
      childrenNamed(group, "base").map((base) => ({
        name: base.attrs.name ?? null,
        colorHex: parseDisplayColor(base.attrs.displaycolor),
      }))
    );
  }

  const objects = new Map<string, ObjectResource>();
  let totalTriangles = 0;
  for (const node of childrenNamed(resources, "object")) {
    const id = node.attrs.id;
    if (!id) continue;
    if (objects.size >= THREE_MF_LIMITS.maxObjects) {
      throw new ThreeMfImportError(
        `קובץ ה-3MF מכיל יותר מדי אובייקטים (מקסימום ${THREE_MF_LIMITS.maxObjects})`
      );
    }
    const name = node.attrs.name ?? `object ${id}`;
    const meshNode = childNamed(node, "mesh");
    const mesh = meshNode ? parseMesh(meshNode, name) : null;
    if (mesh) {
      totalTriangles += mesh.indices.length / 3;
      if (totalTriangles > THREE_MF_LIMITS.maxTrianglesTotal) {
        throw new ThreeMfImportError("קובץ ה-3MF מכיל יותר מדי משולשים לייבוא");
      }
    }
    const componentsNode = childNamed(node, "components");
    const rawType = node.attrs.type ?? "model";
    objects.set(id, {
      id,
      name,
      type: rawType === "support" ? "support" : rawType === "model" ? "model" : "other",
      pid: node.attrs.pid ?? null,
      pindex: Number(node.attrs.pindex ?? 0) || 0,
      mesh,
      components: componentsNode
        ? childrenNamed(componentsNode, "component")
            .filter((c) => c.attrs.objectid)
            .map((c) => ({
              objectId: c.attrs.objectid,
              transform: parseTransform(c.attrs.transform),
            }))
        : [],
    });
  }
  if (objects.size === 0) {
    throw new ThreeMfImportError("קובץ ה-3MF אינו מכיל אובייקטים");
  }

  // Flatten every build item to the LEAF meshes under it. A component object
  // contributes its packaging, not a body — which is what makes our own
  // support wrapper disappear instead of arriving as a duplicate part.
  const placed: { object: ObjectResource; transform: Transform12 }[] = [];
  let expansions = 0;
  const visit = (
    objectId: string,
    transform: Transform12,
    depth: number,
    path: ReadonlySet<string>
  ): void => {
    if (++expansions > THREE_MF_LIMITS.maxComponentExpansions) {
      throw new ThreeMfImportError("היררכיית הרכיבים בקובץ ה-3MF גדולה מדי לייבוא");
    }
    if (depth > THREE_MF_LIMITS.maxComponentDepth) {
      throw new ThreeMfImportError("היררכיית הרכיבים בקובץ ה-3MF עמוקה מדי לייבוא");
    }
    if (path.has(objectId)) {
      throw new ThreeMfImportError("קובץ ה-3MF פגום — היררכיית הרכיבים מעגלית");
    }
    const object = objects.get(objectId);
    if (!object) {
      warningsHe.push(`הפניה לאובייקט ${objectId} שאינו קיים בקובץ — דולגה`);
      return;
    }
    if (object.mesh) placed.push({ object, transform });
    if (object.components.length === 0) return;
    const nextPath = new Set(path).add(objectId);
    for (const component of object.components) {
      visit(
        component.objectId,
        composeTransforms(transform, component.transform),
        depth + 1,
        nextPath
      );
    }
  };

  const build = childNamed(model, "build");
  const items = build ? childrenNamed(build, "item").filter((i) => i.attrs.objectid) : [];
  if (items.length === 0) {
    // A model with resources but no build is still usable geometry; the spec
    // just would not have printed it. Say so rather than refuse.
    warningsHe.push("לקובץ אין אלמנט build — כל האובייקטים יובאו במיקומם המקורי");
    for (const object of objects.values()) {
      if (object.mesh) placed.push({ object, transform: IDENTITY_12 });
    }
  } else {
    for (const item of items) {
      visit(item.attrs.objectid, parseTransform(item.attrs.transform), 0, new Set());
    }
  }
  if (placed.length === 0) {
    throw new ThreeMfImportError("לא נמצאה גאומטריה בקובץ ה-3MF");
  }

  const result: ThreeMfImportedObject[] = placed.map(({ object, transform }) => {
    const source = object.mesh!;
    const count = source.positions.length / 3;
    const world = new Float64Array(source.positions.length);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    for (let i = 0; i < count; i++) {
      const x = source.positions[i * 3];
      const y = source.positions[i * 3 + 1];
      const z = source.positions[i * 3 + 2];
      const wx =
        (x * transform[0] + y * transform[3] + z * transform[6] + transform[9]) * unitScale;
      const wy =
        (x * transform[1] + y * transform[4] + z * transform[7] + transform[10]) * unitScale;
      const wz =
        (x * transform[2] + y * transform[5] + z * transform[8] + transform[11]) * unitScale;
      world[i * 3] = wx;
      world[i * 3 + 1] = wy;
      world[i * 3 + 2] = wz;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz;
    }
    // Rebase like the STL importer does — centred in XY, resting on z = 0 —
    // and hand the offset back as the layer position, so a multi-object file
    // keeps its arrangement while every layer still has a sane pivot.
    const position = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: minZ };
    const positions = new Float32Array(source.positions.length);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = world[i * 3] - position.x;
      positions[i * 3 + 1] = world[i * 3 + 1] - position.y;
      positions[i * 3 + 2] = world[i * 3 + 2] - position.z;
    }

    const palette = object.pid ? materials.get(object.pid) : undefined;
    const entry = palette?.[object.pindex] ?? palette?.[0];
    if (object.type === "other") {
      warningsHe.push(`האובייקט "${object.name}" מסוג לא נתמך — יובא כגוף רגיל`);
    }
    return {
      name: object.name,
      mesh: { positions, indices: source.indices.slice() },
      position,
      colorHex: entry?.colorHex ?? null,
      materialName: entry?.name ?? null,
      role: object.type === "support" ? "support" : "model",
    };
  });

  return { objects: result, warningsHe: [...new Set(warningsHe)], unitScale };
}
