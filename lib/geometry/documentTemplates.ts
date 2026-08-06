/**
 * Product templates as full layer documents. Each factory returns a fresh
 * document (fresh layer ids) so editing never mutates a preset. These
 * reproduce the V2 template presets on top of the V3 layer model.
 */

import type {
  BaseLayer,
  DesignDocument,
  HoleLayer,
  MaterialSlot,
  ProductTemplate,
  TextLayer,
} from "@/types/design";
import { defaultBevel, DESIGN_SCHEMA_VERSION, identityTransform, newId } from "@/types/design";
import type { FontId, TextAlign, TextMode } from "./types";

export const DEFAULT_MATERIAL_SLOTS: MaterialSlot[] = [
  { id: "slot1", nameHe: "צבע ראשי", colorHex: "#2f6feb" },
  { id: "slot2", nameHe: "צבע משני", colorHex: "#f0f4fa" },
  { id: "slot3", nameHe: "צבע שלישי", colorHex: "#e0483e" },
];

export function emptyDocument(): DesignDocument {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    baseMode: "baseless",
    layers: [],
    materialSlots: structuredClone(DEFAULT_MATERIAL_SLOTS),
    printerProfileId: "genericFdm220",
    printabilityProfileId: "fdmPla",
    customPrintability: null,
    usageProfileId: null,
    templateId: null,
  };
}

export function makeBaseLayer(patch: Partial<BaseLayer> = {}): BaseLayer {
  return {
    id: newId("layer"),
    type: "base",
    name: "בסיס",
    visible: true,
    locked: false,
    materialSlotId: "slot1",
    transform: identityTransform(),
    previewOpacity: 1,
    shape: "roundedRectangle",
    widthMm: 120,
    heightMm: 40,
    thicknessMm: 3,
    cornerRadiusMm: 5,
    ...patch,
  };
}

export function makeTextLayer(patch: Partial<TextLayer> = {}): TextLayer {
  return {
    id: newId("layer"),
    type: "text",
    name: "טקסט",
    visible: true,
    locked: false,
    materialSlotId: "slot1",
    transform: identityTransform(),
    previewOpacity: 1,
    content: "שלום",
    fontId: "alef",
    sizeMm: 20,
    bold: false,
    align: "center",
    lineSpacing: 1,
    extrudeMm: 1.5,
    combine: "raised",
    bevel: defaultBevel(),
    ...patch,
  };
}

export function makeHoleLayer(patch: Partial<HoleLayer> = {}): HoleLayer {
  return {
    id: newId("layer"),
    type: "hole",
    name: "חור",
    visible: true,
    locked: false,
    materialSlotId: "slot1",
    transform: identityTransform(),
    previewOpacity: 1,
    diameterMm: 4,
    depthMode: "through",
    depthMm: 3,
    ...patch,
  };
}

interface ClassicTemplateSpec {
  id: string;
  nameHe: string;
  icon: string;
  base: Pick<BaseLayer, "shape" | "widthMm" | "heightMm" | "thicknessMm" | "cornerRadiusMm">;
  baseColorHex: string;
  text: {
    content: string;
    fontId: FontId;
    sizeMm: number;
    bold: boolean;
    align: TextAlign;
    mode: TextMode;
    depthMm: number;
    offsetXMm: number;
    offsetYMm: number;
    lineSpacing: number;
  };
  hole: { enabled: boolean; diameterMm: number; edgeMarginMm: number; position: "right" | "left" | "top" } | null;
}

const CLASSIC_TEMPLATES: ClassicTemplateSpec[] = [
  {
    id: "namePlate",
    nameHe: "שלט שם",
    icon: "🏷️",
    base: { shape: "roundedRectangle", widthMm: 120, heightMm: 40, thicknessMm: 3, cornerRadiusMm: 5 },
    baseColorHex: "#2f6feb",
    text: {
      content: "שלום עולם",
      fontId: "alef",
      sizeMm: 20,
      bold: true,
      align: "center",
      mode: "raised",
      depthMm: 1.5,
      offsetXMm: 0,
      offsetYMm: 0,
      lineSpacing: 1,
    },
    hole: null,
  },
  {
    id: "keychain",
    nameHe: "מחזיק מפתחות",
    icon: "🔑",
    base: { shape: "roundedRectangle", widthMm: 65, heightMm: 25, thicknessMm: 3, cornerRadiusMm: 6 },
    baseColorHex: "#e0483e",
    text: {
      content: "אייל",
      fontId: "varelaRound",
      sizeMm: 14,
      bold: false,
      align: "center",
      mode: "raised",
      depthMm: 1.2,
      offsetXMm: -3,
      offsetYMm: 0,
      lineSpacing: 1,
    },
    hole: { enabled: true, diameterMm: 4.5, edgeMarginMm: 5, position: "right" },
  },
  {
    id: "logoPlaque",
    nameHe: "לוחית לוגו",
    icon: "🏆",
    base: { shape: "roundedRectangle", widthMm: 100, heightMm: 100, thicknessMm: 4, cornerRadiusMm: 8 },
    baseColorHex: "#c99b3f",
    text: {
      content: "LOGO",
      fontId: "suezOne",
      sizeMm: 28,
      bold: false,
      align: "center",
      mode: "raised",
      depthMm: 2,
      offsetXMm: 0,
      offsetYMm: 0,
      lineSpacing: 1,
    },
    hole: null,
  },
  {
    id: "reliefTile",
    nameHe: "אריח תבליט",
    icon: "🧱",
    base: { shape: "rectangle", widthMm: 100, heightMm: 60, thicknessMm: 5, cornerRadiusMm: 0 },
    baseColorHex: "#4b9b6e",
    text: {
      content: "עמוק\nיותר",
      fontId: "davidLibre",
      sizeMm: 22,
      bold: true,
      align: "center",
      mode: "engraved",
      depthMm: 2,
      offsetXMm: 0,
      offsetYMm: 0,
      lineSpacing: 1.1,
    },
    hole: null,
  },
];

function classicToDocument(spec: ClassicTemplateSpec): DesignDocument {
  const doc = emptyDocument();
  doc.baseMode = "withBase";
  doc.templateId = spec.id;
  doc.materialSlots[0] = { ...doc.materialSlots[0], colorHex: spec.baseColorHex };

  const base = makeBaseLayer({ ...spec.base, materialSlotId: "slot1" });
  const text = makeTextLayer({
    name: "טקסט",
    content: spec.text.content,
    fontId: spec.text.fontId,
    sizeMm: spec.text.sizeMm,
    bold: spec.text.bold,
    align: spec.text.align,
    lineSpacing: spec.text.lineSpacing,
    extrudeMm: spec.text.depthMm,
    combine: spec.text.mode,
    materialSlotId: "slot1",
    transform: {
      ...identityTransform(),
      x: spec.text.offsetXMm,
      y: spec.text.offsetYMm,
    },
  });
  doc.layers = [base, text];

  if (spec.hole?.enabled) {
    const { widthMm, heightMm } = spec.base;
    const m = spec.hole.edgeMarginMm;
    const pos =
      spec.hole.position === "right"
        ? { x: widthMm / 2 - m, y: 0 }
        : spec.hole.position === "left"
          ? { x: -(widthMm / 2 - m), y: 0 }
          : { x: 0, y: heightMm / 2 - m };
    doc.layers.push(
      makeHoleLayer({
        name: "חור תלייה",
        diameterMm: spec.hole.diameterMm,
        transform: { ...identityTransform(), x: pos.x, y: pos.y },
      })
    );
  }
  return doc;
}

/** A blank baseless starter document. */
function baselessStarter(): DesignDocument {
  const doc = emptyDocument();
  doc.templateId = "baseless";
  doc.layers = [
    makeTextLayer({
      name: "טקסט חופשי",
      content: "טקסט",
      sizeMm: 30,
      bold: true,
      extrudeMm: 5,
      combine: "standalone",
    }),
  ];
  return doc;
}

export const PRODUCT_TEMPLATES: ProductTemplate[] = [
  ...CLASSIC_TEMPLATES.map((spec) => ({
    id: spec.id,
    nameHe: spec.nameHe,
    icon: spec.icon,
    createDocument: () => classicToDocument(spec),
  })),
  {
    id: "baseless",
    nameHe: "אובייקט ללא בסיס",
    icon: "✒️",
    createDocument: baselessStarter,
  },
];

export function createTemplateDocument(id: string): DesignDocument {
  const template = PRODUCT_TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`Unknown template: ${id}`);
  return template.createDocument();
}
