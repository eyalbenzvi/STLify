/**
 * V2 product templates. Each template builds a complete, valid starting
 * DesignDocument so a fresh design is immediately previewable and printable.
 */

import type { DesignDocument, ProductTemplate, ProductTemplateId } from "@/types/design";
import {
  createBaseLayer,
  createBlankDocument,
  createHoleLayer,
  createTextLayer,
} from "./defaults";

function doc(
  templateId: ProductTemplateId,
  layers: DesignDocument["layers"]
): DesignDocument {
  return { version: 2, title: "", templateId, layers };
}

export const PRODUCT_TEMPLATES: ProductTemplate[] = [
  {
    id: "namePlate",
    nameHe: "שלט שם",
    descriptionHe: "לוחית מלבנית עם טקסט מובלט או חרוט, מסגרת וחורי תלייה אופציונליים",
    icon: "🏷️",
    suggestedMaterial: "PLA",
    suggestedFilename: "name-plate",
    defaultCameraView: "front",
    create: () =>
      doc("namePlate", [
        createBaseLayer({
          shape: "roundedRectangle",
          widthMm: 120,
          heightMm: 40,
          thicknessMm: 3,
          cornerRadiusMm: 5,
          colorHex: "#2f6feb",
        }),
        createTextLayer({
          name: "שם",
          content: "שלום עולם",
          fontId: "alef",
          sizeMm: 18,
          bold: true,
          mode: "raised",
          depthMm: 1.5,
          colorHex: "#f5f5f5",
        }),
      ]),
  },
  {
    id: "keychain",
    nameHe: "מחזיק מפתחות",
    descriptionHe: "בסיס קומפקטי עם חור לטבעת מפתחות וטקסט אישי",
    icon: "🔑",
    suggestedMaterial: "PLA",
    suggestedFilename: "keychain",
    defaultCameraView: "iso",
    create: () =>
      doc("keychain", [
        createBaseLayer({
          shape: "roundedRectangle",
          widthMm: 65,
          heightMm: 25,
          thicknessMm: 3,
          cornerRadiusMm: 6,
          colorHex: "#e0483e",
        }),
        createTextLayer({
          name: "שם",
          content: "אייל",
          fontId: "varelaRound",
          sizeMm: 13,
          mode: "raised",
          depthMm: 1.2,
          colorHex: "#f5f5f5",
          transform: { x: -4, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
        }),
        createHoleLayer({
          name: "חור טבעת",
          diameterMm: 4.5,
          through: true,
          transform: { x: 27.5, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
        }),
      ]),
  },
  {
    id: "medal",
    nameHe: "מדליה עגולה",
    descriptionHe: "בסיס עגול עם לוגו או תמונה במרכז, טקסט קשתי וחור לסרט",
    icon: "🥇",
    suggestedMaterial: "PLA",
    suggestedFilename: "medal",
    defaultCameraView: "front",
    create: () =>
      doc("medal", [
        createBaseLayer({
          shape: "circle",
          widthMm: 70,
          heightMm: 70,
          thicknessMm: 4,
          cornerRadiusMm: 0,
          colorHex: "#c99b3f",
          rim: { enabled: true, widthMm: 2.5, heightMm: 1.2 },
        }),
        createTextLayer({
          name: "כיתוב קשתי",
          content: "אלוף העולם",
          fontId: "suezOne",
          sizeMm: 9,
          mode: "raised",
          depthMm: 1.2,
          curveRadiusMm: 26,
          colorHex: "#f5f5f5",
        }),
        createHoleLayer({
          name: "חור לסרט",
          diameterMm: 4,
          through: true,
          transform: { x: 0, y: 30, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
        }),
      ]),
  },
  {
    id: "nameTag",
    nameHe: "תג שם",
    descriptionHe: "תג מלבני מעוגל עם שם, תפקיד וכיס אחורי למגנט",
    icon: "📛",
    suggestedMaterial: "PLA",
    suggestedFilename: "name-tag",
    defaultCameraView: "front",
    create: () =>
      doc("nameTag", [
        createBaseLayer({
          shape: "roundedRectangle",
          widthMm: 76,
          heightMm: 25,
          thicknessMm: 3,
          cornerRadiusMm: 4,
          colorHex: "#1a3b8f",
        }),
        createTextLayer({
          name: "שם",
          content: "ישראל ישראלי",
          fontId: "alef",
          sizeMm: 8,
          bold: true,
          mode: "raised",
          depthMm: 1,
          colorHex: "#f5f5f5",
          transform: { x: 0, y: 4, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
        }),
        createTextLayer({
          name: "תפקיד",
          content: "מנהל פרויקטים",
          fontId: "alef",
          sizeMm: 5,
          bold: false,
          mode: "raised",
          depthMm: 1,
          colorHex: "#c0c6cf",
          colorSlot: 2,
          transform: { x: 0, y: -6, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
        }),
        createHoleLayer({
          name: "כיס מגנט אחורי",
          diameterMm: 10,
          through: false,
          depthMm: 1.5,
          fromBottom: true,
        }),
      ]),
  },
  {
    id: "fridgeMagnet",
    nameHe: "מגנט למקרר",
    descriptionHe: "לוחית שטוחה עם כיס אחורי למגנט בקוטר ועומק מותאמים",
    icon: "🧲",
    suggestedMaterial: "PLA",
    suggestedFilename: "fridge-magnet",
    defaultCameraView: "front",
    create: () =>
      doc("fridgeMagnet", [
        createBaseLayer({
          shape: "roundedRectangle",
          widthMm: 70,
          heightMm: 50,
          thicknessMm: 4,
          cornerRadiusMm: 6,
          colorHex: "#4b9b6e",
        }),
        createTextLayer({
          name: "כיתוב",
          content: "הבית שלנו",
          fontId: "davidLibre",
          sizeMm: 12,
          bold: true,
          mode: "raised",
          depthMm: 1.5,
          colorHex: "#f5f5f5",
        }),
        createHoleLayer({
          name: "כיס מגנט",
          diameterMm: 12,
          through: false,
          depthMm: 2.2,
          fromBottom: true,
        }),
      ]),
  },
  {
    id: "stamp",
    nameHe: "חותמת",
    descriptionHe: "משטח חותמת עם טקסט מובלט במראה, על לוחית גב פשוטה",
    icon: "🖃",
    noteHe:
      "שימו לב: הטקסט בחותמת מודפס במראה (הפוך) כדי שההטבעה על נייר תצא ישרה.",
    suggestedMaterial: "TPU",
    suggestedFilename: "stamp",
    defaultCameraView: "top",
    create: () =>
      doc("stamp", [
        createBaseLayer({
          shape: "roundedRectangle",
          widthMm: 60,
          heightMm: 25,
          thicknessMm: 5,
          cornerRadiusMm: 3,
          colorHex: "#7e57c2",
        }),
        createTextLayer({
          name: "טקסט חותמת (מראה)",
          content: "נבדק ואושר",
          fontId: "alef",
          sizeMm: 10,
          bold: true,
          mode: "raised",
          depthMm: 1.8,
          mirrored: true,
          colorHex: "#f5f5f5",
        }),
      ]),
  },
  {
    id: "coaster",
    nameHe: "תחתית לכוס",
    descriptionHe: "עיגול או ריבוע עם שפה מוגבהת ועיצוב מרכזי מובלט או חרוט",
    icon: "🥤",
    suggestedMaterial: "PETG",
    suggestedFilename: "coaster",
    defaultCameraView: "top",
    create: () =>
      doc("coaster", [
        createBaseLayer({
          shape: "circle",
          widthMm: 95,
          heightMm: 95,
          thicknessMm: 4,
          cornerRadiusMm: 0,
          colorHex: "#26a69a",
          rim: { enabled: true, widthMm: 3, heightMm: 2 },
        }),
        createTextLayer({
          name: "עיצוב מרכזי",
          content: "קפה",
          fontId: "suezOne",
          sizeMm: 24,
          mode: "engraved",
          depthMm: 1.2,
          colorHex: "#1c1c1e",
        }),
      ]),
  },
  {
    id: "wallPlaque",
    nameHe: "שלט קיר",
    descriptionHe: "לוח גדול עם מסגרת וחורי תלייה — מתאים לשלטי כניסה ומשרדים",
    icon: "🪧",
    noteHe:
      "לתלייה על קיר: השתמשו בברגים המתאימים למשקל השלט ולסוג הקיר, או בדבק דו-צדדי חזק לשלטים קלים בלבד.",
    suggestedMaterial: "PETG",
    suggestedFilename: "wall-plaque",
    defaultCameraView: "front",
    create: () =>
      doc("wallPlaque", [
        createBaseLayer({
          shape: "roundedRectangle",
          widthMm: 200,
          heightMm: 80,
          thicknessMm: 4,
          cornerRadiusMm: 8,
          colorHex: "#1c1c1e",
          rim: { enabled: true, widthMm: 4, heightMm: 1.5 },
        }),
        createTextLayer({
          name: "כותרת",
          content: "משפחת ישראלי",
          fontId: "suezOne",
          sizeMm: 26,
          mode: "raised",
          depthMm: 2,
          colorHex: "#c99b3f",
        }),
        createHoleLayer({
          name: "חור תלייה ימני",
          diameterMm: 4,
          through: true,
          transform: { x: 88, y: 28, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
        }),
        createHoleLayer({
          name: "חור תלייה שמאלי",
          diameterMm: 4,
          through: true,
          transform: { x: -88, y: 28, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
        }),
      ]),
  },
  {
    id: "blank",
    nameHe: "עיצוב ריק",
    descriptionHe: "בסיס נקי להתחלה מאפס — הוסיפו טקסט, לוגו, תמונה או חורים",
    icon: "⬜",
    suggestedMaterial: "PLA",
    suggestedFilename: "design",
    defaultCameraView: "iso",
    create: createBlankDocument,
  },
];

export function getProductTemplate(id: ProductTemplateId): ProductTemplate {
  const template = PRODUCT_TEMPLATES.find((t) => t.id === id);
  return template ?? PRODUCT_TEMPLATES[PRODUCT_TEMPLATES.length - 1];
}
