/**
 * What each parametric generator asks the user for.
 *
 * Every default here used to be written twice — once as the dialog field's
 * fallback and once as the build handler's `num(key, fallback)` — with
 * nothing keeping the pair in step. A default that drifted meant the part
 * you got was not the part the dialog showed you.
 *
 * The specs are the single source: the dialog renders its fields from them,
 * `buildGeneratorLayers` reads its parameters through them, and the create
 * menu takes its labels from them.
 */

export type GeneratorKind =
  | "thread"
  | "gear"
  | "enclosure"
  | "livingHinge"
  | "snapFit"
  | "toleranceTest";

/** A generator's parameters as the dialog collects them. */
export interface GeneratorParams {
  [key: string]: number | boolean | string;
}

interface FieldCommon {
  key: string;
  labelHe: string;
  /** Explanatory text rendered directly under the field. */
  hintHe?: string;
}

export interface NumberFieldSpec extends FieldCommon {
  kind: "number";
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  /** Defaults to millimetres; pass "" for a pure count. */
  unitHe?: string;
}

export interface BooleanFieldSpec extends FieldCommon {
  kind: "boolean";
  defaultValue: boolean;
}

export interface ChoiceFieldSpec extends FieldCommon {
  kind: "choice";
  defaultValue: string;
  options: { value: string; labelHe: string }[];
}

export type GeneratorFieldSpec =
  | NumberFieldSpec
  | BooleanFieldSpec
  | ChoiceFieldSpec;

export interface GeneratorSpec {
  /** Create-menu label. */
  labelHe: string;
  /** Create-menu one-liner. */
  hintHe: string;
  /** Dialog title. */
  titleHe: string;
  fields: GeneratorFieldSpec[];
  /** Explanatory text at the bottom of the dialog. */
  noteHe?: string;
}

const MM = undefined; // the default unit; named so the tables read clearly

export const GENERATOR_SPECS: Record<GeneratorKind, GeneratorSpec> = {
  thread: {
    labelHe: "הברגה",
    hintHe: "בורג או אום בתקן ISO",
    titleHe: "מחולל הברגה",
    fields: [
      { kind: "number", key: "diameterMm", labelHe: "קוטר נומינלי", defaultValue: 8, min: 1, max: 200, step: 0.5, unitHe: MM },
      { kind: "number", key: "pitchMm", labelHe: "פסיעה", defaultValue: 1.25, min: 0.2, max: 20, step: 0.05 },
      { kind: "number", key: "lengthMm", labelHe: "אורך", defaultValue: 20, min: 1, max: 300, step: 1 },
      { kind: "number", key: "clearanceMm", labelHe: "מרווח (לאום בלבד)", defaultValue: 0.4, min: 0, max: 2, step: 0.05 },
      {
        kind: "choice",
        key: "fitClass",
        labelHe: "מחלקת התאמה",
        defaultValue: "normal",
        options: [
          { value: "tight", labelHe: "הדוקה" },
          { value: "normal", labelHe: "רגילה" },
          { value: "loose", labelHe: "רפויה" },
        ],
        hintHe:
          "מכפילה את המרווח: הדוקה ×0.5, רגילה ×1, רפויה ×1.75. חלה על הברגה פנימית בלבד.",
      },
      {
        kind: "number",
        key: "chamferMm",
        labelHe: "שיפוע כניסה",
        defaultValue: 0.6,
        min: 0,
        max: 3,
        step: 0.1,
        hintHe: "קטימה בשני הקצוות, כדי שהאום יתפוס ישר ולא ייתקע בחוט הראשון.",
      },
      {
        kind: "boolean",
        key: "internal",
        labelHe: "הברגה פנימית (אום)",
        defaultValue: false,
        hintHe:
          "הברגה פנימית נוצרת ככלי חיתוך — חסרו אותה מהגוף שלכם בעזרת פעולת ״חיסור״.",
      },
    ],
  },

  gear: {
    labelHe: "גלגל שיניים",
    hintHe: "פרופיל אבולבנטי אמיתי",
    titleHe: "מחולל גלגל שיניים",
    fields: [
      { kind: "number", key: "teeth", labelHe: "מספר שיניים", defaultValue: 20, min: 5, max: 500, step: 1, unitHe: "" },
      { kind: "number", key: "moduleMm", labelHe: "מודול", defaultValue: 2, min: 0.2, max: 20, step: 0.1 },
      { kind: "number", key: "thicknessMm", labelHe: "עובי", defaultValue: 6, min: 0.5, max: 100, step: 0.5 },
      { kind: "number", key: "boreDiameterMm", labelHe: "קוטר חור מרכזי", defaultValue: 6, min: 0, max: 200, step: 0.5 },
      { kind: "number", key: "backlashMm", labelHe: "מרווח בין שיניים", defaultValue: 0.1, min: 0, max: 2, step: 0.05 },
    ],
    noteHe:
      "שני גלגלים משתלבים רק אם המודול שלהם זהה. מרחק הצירים הוא סכום קטרי הצעד חלקי שתיים.",
  },

  enclosure: {
    labelHe: "מארז",
    hintHe: "קופסה עם מכסה מותאם",
    titleHe: "מחולל מארז",
    fields: [
      { kind: "number", key: "innerWidthMm", labelHe: "רוחב פנימי", defaultValue: 60, min: 5, max: 400, step: 1 },
      { kind: "number", key: "innerDepthMm", labelHe: "עומק פנימי", defaultValue: 40, min: 5, max: 400, step: 1 },
      { kind: "number", key: "innerHeightMm", labelHe: "גובה פנימי", defaultValue: 25, min: 5, max: 400, step: 1 },
      { kind: "number", key: "wallMm", labelHe: "עובי דופן", defaultValue: 2, min: 0.4, max: 20, step: 0.1 },
      { kind: "number", key: "floorMm", labelHe: "עובי רצפה", defaultValue: 2, min: 0.4, max: 20, step: 0.1 },
      { kind: "number", key: "cornerRadiusMm", labelHe: "רדיוס פינה", defaultValue: 3, min: 0, max: 50, step: 0.5 },
      { kind: "number", key: "lipHeightMm", labelHe: "גובה שפת המכסה", defaultValue: 4, min: 0, max: 40, step: 0.5 },
      { kind: "number", key: "clearanceMm", labelHe: "מרווח בין מכסה לקופסה", defaultValue: 0.2, min: 0, max: 2, step: 0.05 },
    ],
  },

  livingHinge: {
    labelHe: "ציר חי",
    hintHe: "פאנל מתקפל",
    titleHe: "מחולל ציר חי",
    fields: [
      { kind: "number", key: "widthMm", labelHe: "רוחב", defaultValue: 40, min: 5, max: 400, step: 1 },
      { kind: "number", key: "lengthMm", labelHe: "אורך", defaultValue: 30, min: 5, max: 400, step: 1 },
      { kind: "number", key: "thicknessMm", labelHe: "עובי הפאנל", defaultValue: 2, min: 0.5, max: 20, step: 0.1 },
      { kind: "number", key: "hingeThicknessMm", labelHe: "עובי הציר", defaultValue: 0.5, min: 0.1, max: 5, step: 0.05 },
      { kind: "number", key: "grooveCount", labelHe: "מספר חריצים", defaultValue: 3, min: 1, max: 40, step: 1, unitHe: "" },
      { kind: "number", key: "grooveWidthMm", labelHe: "רוחב חריץ", defaultValue: 1, min: 0.2, max: 20, step: 0.1 },
    ],
    noteHe:
      "עובי ציר מומלץ ל-PLA הוא 0.3–0.6 מ״מ. דק מדי — נשבר; עבה מדי — לא מתכופף.",
  },

  snapFit: {
    labelHe: "תפס",
    hintHe: "וו הצמדה גמיש",
    titleHe: "מחולל תפס",
    fields: [
      { kind: "number", key: "lengthMm", labelHe: "אורך הזרוע", defaultValue: 15, min: 2, max: 200, step: 0.5 },
      { kind: "number", key: "widthMm", labelHe: "רוחב", defaultValue: 6, min: 1, max: 100, step: 0.5 },
      { kind: "number", key: "thicknessMm", labelHe: "עובי הזרוע", defaultValue: 1.5, min: 0.4, max: 20, step: 0.1 },
      { kind: "number", key: "hookDepthMm", labelHe: "עומק הוו", defaultValue: 1, min: 0.2, max: 20, step: 0.1 },
      { kind: "number", key: "insertionAngleDeg", labelHe: "זווית הכנסה", defaultValue: 30, min: 5, max: 80, step: 1, unitHe: "°" },
      { kind: "number", key: "retentionAngleDeg", labelHe: "זווית החזקה", defaultValue: 75, min: 30, max: 90, step: 1, unitHe: "°" },
    ],
  },

  toleranceTest: {
    labelHe: "מבחן סבולות",
    hintHe: "כיול דיוק המדפסת",
    titleHe: "מחולל מבחן סבולות",
    fields: [
      { kind: "number", key: "pinDiameterMm", labelHe: "קוטר הפין", defaultValue: 5, min: 1, max: 50, step: 0.5 },
      { kind: "number", key: "thicknessMm", labelHe: "עובי הלוחית", defaultValue: 4, min: 1, max: 40, step: 0.5 },
      { kind: "number", key: "spacingMm", labelHe: "מרווח בין חורים", defaultValue: 12, min: 2, max: 100, step: 1 },
    ],
    noteHe:
      "נוצרים חורים במרווחים 0.1 / 0.2 / 0.3 / 0.4 / 0.5 מ״מ. הדפיסו פעם אחת, בדקו איזה חור מתאים, והשתמשו בערך הזה בכל פעולה שדורשת מרווח (מחברים, שיבוצים, מארזים, הברגות).",
  },
};

export const GENERATOR_KINDS = Object.keys(GENERATOR_SPECS) as GeneratorKind[];

function fieldSpec(kind: GeneratorKind, key: string): GeneratorFieldSpec {
  const spec = GENERATOR_SPECS[kind].fields.find((f) => f.key === key);
  if (!spec) throw new Error(`generator "${kind}" has no field "${key}"`);
  return spec;
}

/**
 * Read a numeric parameter, falling back to the spec's default. The dialog
 * only writes a key once the user touches it, so most reads take the default.
 */
export function numberParam(
  kind: GeneratorKind,
  params: GeneratorParams,
  key: string
): number {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const spec = fieldSpec(kind, key);
  if (spec.kind !== "number") throw new Error(`field "${key}" is not numeric`);
  return spec.defaultValue;
}

/** Read a boolean parameter, falling back to the spec's default. */
export function booleanParam(
  kind: GeneratorKind,
  params: GeneratorParams,
  key: string
): boolean {
  const value = params[key];
  if (typeof value === "boolean") return value;
  const spec = fieldSpec(kind, key);
  if (spec.kind !== "boolean") throw new Error(`field "${key}" is not a flag`);
  return spec.defaultValue;
}

/**
 * Read a choice parameter, falling back to the spec's default when the
 * stored value is not one the spec offers.
 */
export function choiceParam(
  kind: GeneratorKind,
  params: GeneratorParams,
  key: string
): string {
  const spec = fieldSpec(kind, key);
  if (spec.kind !== "choice") throw new Error(`field "${key}" is not a choice`);
  const value = params[key];
  return typeof value === "string" && spec.options.some((o) => o.value === value)
    ? value
    : spec.defaultValue;
}
