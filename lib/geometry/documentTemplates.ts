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
    rimEnabled: false,
    rimWidthMm: 2.5,
    rimHeightMm: 1.2,
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
    letterSpacingMm: 0,
    direction: "auto",
    curveRadiusMm: 0,
    mirrored: false,
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

const identityAt = (x: number, y: number, extra: Partial<ReturnType<typeof identityTransform>> = {}) => ({
  ...identityTransform(),
  x,
  y,
  ...extra,
});

/** Round medal: circular rimmed base, arc text, ribbon hole. */
function medalTemplate(): DesignDocument {
  const doc = emptyDocument();
  doc.baseMode = "withBase";
  doc.templateId = "medal";
  doc.materialSlots[0] = { ...doc.materialSlots[0], colorHex: "#c99b3f" };
  doc.materialSlots[1] = { ...doc.materialSlots[1], colorHex: "#f5f5f5" };
  doc.layers = [
    makeBaseLayer({
      shape: "circle",
      widthMm: 70,
      heightMm: 70,
      thicknessMm: 4,
      rimEnabled: true,
      rimWidthMm: 2.5,
      rimHeightMm: 1.2,
    }),
    makeTextLayer({
      name: "כיתוב קשתי",
      content: "אלוף העולם",
      fontId: "suezOne",
      sizeMm: 9,
      extrudeMm: 1.2,
      curveRadiusMm: 26,
      materialSlotId: "slot2",
    }),
    makeHoleLayer({ name: "חור לסרט", diameterMm: 4, transform: identityAt(0, 30) }),
  ];
  return doc;
}

/** Name tag with a rear magnet pocket (blind hole from the bottom). */
function nameTagTemplate(): DesignDocument {
  const doc = emptyDocument();
  doc.baseMode = "withBase";
  doc.templateId = "nameTag";
  doc.materialSlots[0] = { ...doc.materialSlots[0], colorHex: "#1a3b8f" };
  doc.materialSlots[1] = { ...doc.materialSlots[1], colorHex: "#f5f5f5" };
  doc.layers = [
    makeBaseLayer({ widthMm: 76, heightMm: 25, thicknessMm: 3, cornerRadiusMm: 4 }),
    makeTextLayer({
      name: "שם",
      content: "ישראל ישראלי",
      sizeMm: 8,
      bold: true,
      extrudeMm: 1,
      materialSlotId: "slot2",
      transform: identityAt(0, 4),
    }),
    makeTextLayer({
      name: "תפקיד",
      content: "מנהל פרויקטים",
      sizeMm: 5,
      extrudeMm: 1,
      materialSlotId: "slot2",
      transform: identityAt(0, -6),
    }),
    makeHoleLayer({
      name: "כיס מגנט אחורי",
      diameterMm: 10,
      depthMode: "blind",
      depthMm: 1.5,
      // Rotated 180° about X: the blind hole cuts upward from the bottom face.
      transform: { ...identityTransform(), rotationX: 180 },
    }),
  ];
  return doc;
}

/** Fridge magnet with a rear magnet pocket. */
function fridgeMagnetTemplate(): DesignDocument {
  const doc = emptyDocument();
  doc.baseMode = "withBase";
  doc.templateId = "fridgeMagnet";
  doc.materialSlots[0] = { ...doc.materialSlots[0], colorHex: "#4b9b6e" };
  doc.materialSlots[1] = { ...doc.materialSlots[1], colorHex: "#f5f5f5" };
  doc.layers = [
    makeBaseLayer({ widthMm: 70, heightMm: 50, thicknessMm: 4, cornerRadiusMm: 6 }),
    makeTextLayer({
      name: "כיתוב",
      content: "הבית שלנו",
      fontId: "davidLibre",
      sizeMm: 12,
      bold: true,
      extrudeMm: 1.5,
      materialSlotId: "slot2",
    }),
    makeHoleLayer({
      name: "כיס מגנט",
      diameterMm: 12,
      depthMode: "blind",
      depthMm: 2.2,
      transform: { ...identityTransform(), rotationX: 180 },
    }),
  ];
  return doc;
}

/** Mirrored stamp. */
function stampTemplate(): DesignDocument {
  const doc = emptyDocument();
  doc.baseMode = "withBase";
  doc.templateId = "stamp";
  doc.usageProfileId = "stamp";
  doc.materialSlots[0] = { ...doc.materialSlots[0], colorHex: "#7e57c2" };
  doc.materialSlots[1] = { ...doc.materialSlots[1], colorHex: "#f5f5f5" };
  doc.layers = [
    makeBaseLayer({ widthMm: 60, heightMm: 25, thicknessMm: 5, cornerRadiusMm: 3 }),
    makeTextLayer({
      name: "טקסט חותמת (מראה)",
      content: "נבדק ואושר",
      sizeMm: 10,
      bold: true,
      extrudeMm: 1.8,
      mirrored: true,
      materialSlotId: "slot2",
    }),
  ];
  return doc;
}

/** Coaster: rimmed circle with an engraved centre design. */
function coasterTemplate(): DesignDocument {
  const doc = emptyDocument();
  doc.baseMode = "withBase";
  doc.templateId = "coaster";
  doc.materialSlots[0] = { ...doc.materialSlots[0], colorHex: "#26a69a" };
  doc.layers = [
    makeBaseLayer({
      shape: "circle",
      widthMm: 95,
      heightMm: 95,
      thicknessMm: 4,
      rimEnabled: true,
      rimWidthMm: 3,
      rimHeightMm: 2,
    }),
    makeTextLayer({
      name: "עיצוב מרכזי",
      content: "קפה",
      fontId: "suezOne",
      sizeMm: 24,
      extrudeMm: 1.2,
      combine: "engraved",
    }),
  ];
  return doc;
}

/** Wall plaque: large framed plate with two mounting holes. */
function wallPlaqueTemplate(): DesignDocument {
  const doc = emptyDocument();
  doc.baseMode = "withBase";
  doc.templateId = "wallPlaque";
  doc.materialSlots[0] = { ...doc.materialSlots[0], colorHex: "#1c1c1e" };
  doc.materialSlots[1] = { ...doc.materialSlots[1], colorHex: "#c99b3f" };
  doc.layers = [
    makeBaseLayer({
      widthMm: 200,
      heightMm: 80,
      thicknessMm: 4,
      cornerRadiusMm: 8,
      rimEnabled: true,
      rimWidthMm: 4,
      rimHeightMm: 1.5,
    }),
    makeTextLayer({
      name: "כותרת",
      content: "משפחת ישראלי",
      fontId: "suezOne",
      sizeMm: 26,
      extrudeMm: 2,
      materialSlotId: "slot2",
    }),
    makeHoleLayer({ name: "חור תלייה ימני", diameterMm: 4, transform: identityAt(88, 28) }),
    makeHoleLayer({ name: "חור תלייה שמאלי", diameterMm: 4, transform: identityAt(-88, 28) }),
  ];
  return doc;
}

/** Blank plate to start from scratch. */
function blankTemplate(): DesignDocument {
  const doc = emptyDocument();
  doc.baseMode = "withBase";
  doc.templateId = "blank";
  doc.layers = [makeBaseLayer({ widthMm: 100, heightMm: 60, thicknessMm: 3 })];
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
  { id: "medal", nameHe: "מדליה עגולה", icon: "🥇", createDocument: medalTemplate },
  { id: "nameTag", nameHe: "תג שם", icon: "📛", createDocument: nameTagTemplate },
  { id: "fridgeMagnet", nameHe: "מגנט למקרר", icon: "🧲", createDocument: fridgeMagnetTemplate },
  { id: "stamp", nameHe: "חותמת", icon: "🖃", createDocument: stampTemplate },
  { id: "coaster", nameHe: "תחתית לכוס", icon: "🥤", createDocument: coasterTemplate },
  { id: "wallPlaque", nameHe: "שלט קיר", icon: "🪧", createDocument: wallPlaqueTemplate },
  { id: "blank", nameHe: "עיצוב ריק", icon: "⬜", createDocument: blankTemplate },
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
