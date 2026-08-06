/**
 * Template presets. Each template is a full DesignParams value so switching
 * templates always yields a valid, printable starting point.
 */

import type { DesignParams, TemplateId } from "./types";

export interface TemplateInfo {
  id: TemplateId;
  /** Hebrew display name. */
  nameHe: string;
  /** Emoji used as a lightweight icon in the template picker. */
  icon: string;
  params: DesignParams;
}

const NAME_PLATE: DesignParams = {
  template: "namePlate",
  base: {
    shape: "roundedRectangle",
    widthMm: 120,
    heightMm: 40,
    thicknessMm: 3,
    cornerRadiusMm: 5,
  },
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
  hole: { enabled: false, diameterMm: 4, edgeMarginMm: 5, position: "right" },
  materialColor: "#2f6feb",
};

const KEYCHAIN: DesignParams = {
  template: "keychain",
  base: {
    shape: "roundedRectangle",
    widthMm: 65,
    heightMm: 25,
    thicknessMm: 3,
    cornerRadiusMm: 6,
  },
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
  materialColor: "#e0483e",
};

const LOGO_PLAQUE: DesignParams = {
  template: "logoPlaque",
  base: {
    shape: "roundedRectangle",
    widthMm: 100,
    heightMm: 100,
    thicknessMm: 4,
    cornerRadiusMm: 8,
  },
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
  hole: { enabled: false, diameterMm: 4, edgeMarginMm: 5, position: "top" },
  materialColor: "#c99b3f",
};

const RELIEF_TILE: DesignParams = {
  template: "reliefTile",
  base: {
    shape: "rectangle",
    widthMm: 100,
    heightMm: 60,
    thicknessMm: 5,
    cornerRadiusMm: 0,
  },
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
  hole: { enabled: false, diameterMm: 4, edgeMarginMm: 5, position: "top" },
  materialColor: "#4b9b6e",
};

export const TEMPLATES: TemplateInfo[] = [
  { id: "namePlate", nameHe: "שלט שם", icon: "🏷️", params: NAME_PLATE },
  { id: "keychain", nameHe: "מחזיק מפתחות", icon: "🔑", params: KEYCHAIN },
  { id: "logoPlaque", nameHe: "לוחית לוגו", icon: "🏆", params: LOGO_PLAQUE },
  { id: "reliefTile", nameHe: "אריח תבליט", icon: "🧱", params: RELIEF_TILE },
];

/** The design loaded when the app starts. */
export const SAMPLE_DESIGN: DesignParams = NAME_PLATE;

export function getTemplateParams(id: TemplateId): DesignParams {
  const template = TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`Unknown template: ${id}`);
  // Deep-clone so editing never mutates the preset.
  return structuredClone(template.params);
}
