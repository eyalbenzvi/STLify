/**
 * Printer, material, printability and usage profiles.
 * All values in millimetres / degrees. These are transparent heuristics for
 * guidance only — the UI must always present them as estimates, never as
 * slicer output.
 */

export interface PrinterProfile {
  id: string;
  nameHe: string;
  technology: "fdm" | "sla";
  buildVolumeMm: { x: number; y: number; z: number };
  nozzleDiameterMm: number | null;
  defaultLayerHeightMm: number;
}

export interface MaterialProfile {
  id: string;
  nameHe: string;
  technology: "fdm" | "sla";
  /** Density used for weight estimates, g/cm^3. */
  densityGCm3: number;
  /** Rough price per kg (ILS) for cost estimates. */
  pricePerKgIls: number;
}

export interface PrintabilityProfile {
  id: string;
  nameHe: string;
  technology: "fdm" | "sla";
  minWallMm: number;
  minUnsupportedWallMm: number;
  minFeatureMm: number;
  minHoleDiameterMm: number;
  clearanceMm: number;
  /** Overhang angle from vertical above which support is likely needed. */
  maxOverhangDeg: number;
  nozzleDiameterMm: number;
  layerHeightMm: number;
  /** Minimum stable build-plate contact, mm^2 per 100mm of height. */
  minContactMm2PerHeight: number;
}

export interface UsageProfile {
  id: string;
  nameHe: string;
  icon: string;
  suggestedMaterialId: string;
  suggestedWallMm: number;
  suggestedInfillPct: number;
  orientationNotesHe: string;
  warningsHe: string[];
}

/**
 * Build a user-defined printer profile.
 *
 * The four built-ins covered common machines and nothing else, so anyone with
 * a different build volume had to pick the nearest wrong one and mentally
 * correct every fit-to-volume check.
 */
export function makeCustomPrinter(input: {
  id: string;
  nameHe: string;
  technology?: "fdm" | "sla";
  buildVolumeMm: { x: number; y: number; z: number };
  nozzleDiameterMm?: number | null;
  defaultLayerHeightMm?: number;
}): PrinterProfile {
  const technology = input.technology ?? "fdm";
  return {
    id: input.id,
    nameHe: input.nameHe,
    technology,
    buildVolumeMm: {
      x: Math.max(1, input.buildVolumeMm.x),
      y: Math.max(1, input.buildVolumeMm.y),
      z: Math.max(1, input.buildVolumeMm.z),
    },
    nozzleDiameterMm:
      technology === "sla" ? null : Math.max(0.05, input.nozzleDiameterMm ?? 0.4),
    defaultLayerHeightMm: Math.max(0.01, input.defaultLayerHeightMm ?? (technology === "sla" ? 0.05 : 0.2)),
  };
}

export const PRINTER_PROFILES: PrinterProfile[] = [
  {
    id: "genericFdm220",
    nameHe: "מדפסת FDM כללית (220×220×250)",
    technology: "fdm",
    buildVolumeMm: { x: 220, y: 220, z: 250 },
    nozzleDiameterMm: 0.4,
    defaultLayerHeightMm: 0.2,
  },
  {
    id: "largeFdm300",
    nameHe: "מדפסת FDM גדולה (300×300×350)",
    technology: "fdm",
    buildVolumeMm: { x: 300, y: 300, z: 350 },
    nozzleDiameterMm: 0.4,
    defaultLayerHeightMm: 0.2,
  },
  {
    id: "miniFdm180",
    nameHe: "מדפסת FDM קטנה (180×180×180)",
    technology: "fdm",
    buildVolumeMm: { x: 180, y: 180, z: 180 },
    nozzleDiameterMm: 0.4,
    defaultLayerHeightMm: 0.2,
  },
  {
    id: "genericSla",
    nameHe: "מדפסת שרף כללית (SLA, ‏143×90×175)",
    technology: "sla",
    buildVolumeMm: { x: 143, y: 90, z: 175 },
    nozzleDiameterMm: null,
    defaultLayerHeightMm: 0.05,
  },
];

export const MATERIAL_PROFILES: MaterialProfile[] = [
  { id: "pla", nameHe: "PLA", technology: "fdm", densityGCm3: 1.24, pricePerKgIls: 90 },
  { id: "petg", nameHe: "PETG", technology: "fdm", densityGCm3: 1.27, pricePerKgIls: 100 },
  { id: "tpu", nameHe: "TPU (גמיש)", technology: "fdm", densityGCm3: 1.21, pricePerKgIls: 140 },
  { id: "resin", nameHe: "שרף סטנדרטי", technology: "sla", densityGCm3: 1.1, pricePerKgIls: 180 },
];

export const PRINTABILITY_PROFILES: PrintabilityProfile[] = [
  {
    id: "fdmPla",
    nameHe: "FDM כללי / PLA",
    technology: "fdm",
    minWallMm: 0.8,
    minUnsupportedWallMm: 1.2,
    minFeatureMm: 0.6,
    minHoleDiameterMm: 1.5,
    clearanceMm: 0.2,
    maxOverhangDeg: 50,
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    minContactMm2PerHeight: 25,
  },
  {
    id: "fdmPetg",
    nameHe: "FDM כללי / PETG",
    technology: "fdm",
    minWallMm: 1.0,
    minUnsupportedWallMm: 1.4,
    minFeatureMm: 0.8,
    minHoleDiameterMm: 1.8,
    clearanceMm: 0.25,
    maxOverhangDeg: 45,
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    minContactMm2PerHeight: 30,
  },
  {
    id: "fdmTpu",
    nameHe: "FDM כללי / TPU",
    technology: "fdm",
    minWallMm: 1.2,
    minUnsupportedWallMm: 1.6,
    minFeatureMm: 1.0,
    minHoleDiameterMm: 2.0,
    clearanceMm: 0.3,
    maxOverhangDeg: 40,
    nozzleDiameterMm: 0.4,
    layerHeightMm: 0.2,
    minContactMm2PerHeight: 35,
  },
  {
    id: "slaResin",
    nameHe: "שרף כללי / SLA",
    technology: "sla",
    minWallMm: 0.5,
    minUnsupportedWallMm: 0.8,
    minFeatureMm: 0.3,
    minHoleDiameterMm: 0.8,
    clearanceMm: 0.15,
    maxOverhangDeg: 55,
    nozzleDiameterMm: 0,
    layerHeightMm: 0.05,
    minContactMm2PerHeight: 15,
  },
];

export const USAGE_PROFILES: UsageProfile[] = [
  {
    id: "decorative",
    nameHe: "חפץ דקורטיבי",
    icon: "🎨",
    suggestedMaterialId: "pla",
    suggestedWallMm: 1.2,
    suggestedInfillPct: 10,
    orientationNotesHe: "הציבו את הצד היפה כלפי מעלה או כלפי חוץ; קווי השכבות בולטים פחות על משטחים אנכיים.",
    warningsHe: ["פרטים דקים מ־0.6 מ״מ עלולים להיעלם בהדפסה."],
  },
  {
    id: "keychain",
    nameHe: "מחזיק מפתחות",
    icon: "🔑",
    suggestedMaterialId: "petg",
    suggestedWallMm: 1.6,
    suggestedInfillPct: 30,
    orientationNotesHe: "הדפיסו שטוח על המשטח; ודאו שהחור מרוחק לפחות 2 מ״מ מהשפה.",
    warningsHe: ["דופן דקה סביב חור התלייה נשברת בקלות — מומלץ 2 מ״מ ומעלה."],
  },
  {
    id: "sign",
    nameHe: "שלט / לוחית",
    icon: "🪧",
    suggestedMaterialId: "pla",
    suggestedWallMm: 1.2,
    suggestedInfillPct: 15,
    orientationNotesHe: "הדפיסו שטוח כשהטקסט כלפי מעלה לקבלת פני שטח חלקים.",
    warningsHe: ["טקסט מובלט נמוך מ־0.4 מ״מ עלול לא להיראות."],
  },
  {
    id: "toy",
    nameHe: "צעצוע",
    icon: "🧸",
    suggestedMaterialId: "pla",
    suggestedWallMm: 1.6,
    suggestedInfillPct: 20,
    orientationNotesHe: "העדיפו תנוחה שממזערת תמיכות על משטחים גלויים.",
    warningsHe: ["עגלו פינות חדות; חלקים קטנים מסוכנים לילדים מתחת לגיל 3."],
  },
  {
    id: "functional",
    nameHe: "חלק פונקציונלי",
    icon: "⚙️",
    suggestedMaterialId: "petg",
    suggestedWallMm: 2.4,
    suggestedInfillPct: 50,
    orientationNotesHe: "כווני הכוח צריכים להיות בניצב לשכבות; שכבות נפרדות בקלות במתיחה לאורך ציר Z.",
    warningsHe: ["בחלקים נושאי עומס הימנעו מקירות דקים מ־2 מ״מ."],
  },
  {
    id: "stamp",
    nameHe: "חותמת",
    icon: "🖃",
    suggestedMaterialId: "tpu",
    suggestedWallMm: 1.6,
    suggestedInfillPct: 100,
    orientationNotesHe: "משטח החותמת כלפי מעלה; זכרו שהטקסט חייב להיות בכתב ראי.",
    warningsHe: ["טקסט חותמת חייב להיות מראה (Mirror) כדי להיטבע נכון."],
  },
  {
    id: "magnet",
    nameHe: "מגנט",
    icon: "🧲",
    suggestedMaterialId: "pla",
    suggestedWallMm: 1.2,
    suggestedInfillPct: 20,
    orientationNotesHe: "הדפיסו שטוח; כיס המגנט צריך חופש (Clearance) של כ־0.15 מ״מ.",
    warningsHe: ["השאירו דופן של לפחות 0.8 מ״מ בין המגנט לפני השטח."],
  },
  {
    id: "resinFigurine",
    nameHe: "פסלון שרף",
    icon: "🗿",
    suggestedMaterialId: "resin",
    suggestedWallMm: 2.0,
    suggestedInfillPct: 0,
    orientationNotesHe: "בהדפסת שרף מומלץ להטות את המודל ~30° ולחורר גוף חלול בחורי ניקוז.",
    warningsHe: [
      "גוף חלול ללא חורי ניקוז יוצר לחץ ואקום וכשלי הדפסה.",
      "מומלץ קיר של 1.5–2.5 מ״מ לחיסכון בשרף.",
    ],
  },
];

/**
 * Resolve a printer id, checking the document's own machines first.
 *
 * A design carries the printer it was made for, so a shared file opens with
 * the right build volume even on a machine that has never seen that profile.
 */
export function getPrinterProfile(
  id: string,
  customPrinters: readonly PrinterProfile[] = []
): PrinterProfile {
  return (
    customPrinters.find((p) => p.id === id) ??
    PRINTER_PROFILES.find((p) => p.id === id) ??
    PRINTER_PROFILES[0]
  );
}

export function getPrintabilityProfile(id: string): PrintabilityProfile {
  return PRINTABILITY_PROFILES.find((p) => p.id === id) ?? PRINTABILITY_PROFILES[0];
}

export function getMaterialProfile(id: string): MaterialProfile {
  return MATERIAL_PROFILES.find((m) => m.id === id) ?? MATERIAL_PROFILES[0];
}
