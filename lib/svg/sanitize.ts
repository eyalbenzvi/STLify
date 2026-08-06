/**
 * SVG upload validation and sanitization.
 *
 * Security model: uploaded SVG text is parsed with DOMParser (never injected
 * into the live DOM), dangerous nodes and attributes are removed, and only
 * the sanitized markup is stored in the design. Scripts, event handlers,
 * embedded HTML, and references to external resources are always stripped.
 *
 * Conversion limitations (filters, masks, gradients, <text>, stroke-only
 * paths) are reported as Hebrew warnings so the user knows what won't make
 * it into the printable geometry.
 */

export const SVG_MAX_BYTES = 3 * 1024 * 1024; // 3 MB
export const SVG_MAX_ELEMENTS = 5000;

/** Elements that are removed outright. */
const FORBIDDEN_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "embed",
  "object",
  "video",
  "audio",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "handler",
]);

/** Elements that are removed and reported as unsupported for conversion. */
const UNSUPPORTED_REMOVED: Record<string, string> = {
  image: "תמונות מוטמעות (image) הוסרו — העלו תמונת PNG/JPG בנפרד",
};

/** Elements kept in the markup but flagged as not convertible to geometry. */
const UNSUPPORTED_KEPT: Record<string, string> = {
  filter: "אפקטי Filter אינם נתמכים בהמרה לגאומטריה ויתעלמו מהם",
  mask: "מסכות (mask) אינן נתמכות בהמרה לגאומטריה",
  clippath: "חיתוך (clipPath) אינו נתמך בהמרה לגאומטריה",
  lineargradient: "מילויי גרדיאנט יומרו למילוי אחיד",
  radialgradient: "מילויי גרדיאנט יומרו למילוי אחיד",
  pattern: "מילויי Pattern יומרו למילוי אחיד",
  text: "אלמנטים של טקסט ב-SVG אינם מומרים — המירו את הטקסט לקווי מתאר (Outlines) לפני ההעלאה, או השתמשו בשכבת טקסט של הכלי",
};

export interface SvgSanitizeResult {
  ok: boolean;
  /** Sanitized SVG markup (present when ok). */
  svgText: string;
  /** Blocking error (Hebrew) when the file cannot be used at all. */
  error: string | null;
  /** Non-blocking Hebrew warnings about unsupported content. */
  warnings: string[];
  /** Intrinsic aspect ratio (width / height) when derivable. */
  aspectRatio: number;
}

function fail(error: string): SvgSanitizeResult {
  return { ok: false, svgText: "", error, warnings: [], aspectRatio: 1 };
}

/** Validate basic file facts before reading (extension, type, size). */
export function validateSvgFile(file: { name: string; type: string; size: number }): string | null {
  if (!file.name.toLowerCase().endsWith(".svg")) {
    return "יש לבחור קובץ עם סיומת ‎.svg";
  }
  if (file.type && file.type !== "image/svg+xml") {
    return "סוג הקובץ אינו SVG (image/svg+xml)";
  }
  if (file.size > SVG_MAX_BYTES) {
    return `קובץ ה-SVG גדול מדי (מקסימום ${Math.round(SVG_MAX_BYTES / 1024 / 1024)}MB)`;
  }
  if (file.size === 0) {
    return "הקובץ ריק";
  }
  return null;
}

/**
 * Parse, validate and sanitize SVG markup. Requires a DOM (browser).
 */
export function sanitizeSvg(rawText: string): SvgSanitizeResult {
  if (typeof DOMParser === "undefined") {
    return fail("סביבת הדפדפן אינה זמינה לעיבוד SVG");
  }
  if (rawText.length > SVG_MAX_BYTES) {
    return fail("קובץ ה-SVG גדול מדי");
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(rawText, "image/svg+xml");
  } catch {
    return fail("קובץ ה-SVG אינו XML תקין");
  }
  if (doc.querySelector("parsererror")) {
    return fail("קובץ ה-SVG אינו XML תקין — בדקו שהקובץ לא פגום");
  }
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") {
    return fail("הקובץ אינו מכיל אלמנט SVG ראשי");
  }

  const warnings = new Set<string>();
  const all = Array.from(root.querySelectorAll("*"));
  if (all.length > SVG_MAX_ELEMENTS) {
    return fail(
      `קובץ ה-SVG מורכב מדי (${all.length.toLocaleString()} אלמנטים; המקסימום ${SVG_MAX_ELEMENTS.toLocaleString()})`
    );
  }

  for (const el of [root, ...all]) {
    const tag = el.tagName.toLowerCase();

    if (FORBIDDEN_ELEMENTS.has(tag)) {
      el.remove();
      continue;
    }
    if (tag in UNSUPPORTED_REMOVED) {
      warnings.add(UNSUPPORTED_REMOVED[tag]);
      el.remove();
      continue;
    }
    if (tag in UNSUPPORTED_KEPT) {
      warnings.add(UNSUPPORTED_KEPT[tag]);
    }
    if (tag === "style") {
      // Stylesheets may @import external resources; SVGLoader also ignores
      // most CSS. Remove and warn only when the sheet is non-trivial.
      if ((el.textContent ?? "").trim().length > 0) {
        warnings.add("עיצוב CSS מוטמע הוסר — ייתכן שינוי במראה הצורות");
      }
      el.remove();
      continue;
    }

    // Strip dangerous / external attributes.
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      const lowered = value.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        if (!value.startsWith("#")) {
          el.removeAttribute(attr.name);
          warnings.add("הפניות לקבצים חיצוניים הוסרו מה-SVG");
        }
        continue;
      }
      if (lowered.includes("javascript:") || lowered.includes("data:text/html")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "style" && lowered.includes("url(")) {
        el.removeAttribute(attr.name);
        warnings.add("סגנונות עם הפניות חיצוניות הוסרו");
      }
    }

    // Stroke-only shapes produce no filled geometry.
    if (
      ["path", "circle", "rect", "ellipse", "polygon", "polyline", "line"].includes(tag)
    ) {
      const fill = (el.getAttribute("fill") ?? "").trim().toLowerCase();
      const stroke = (el.getAttribute("stroke") ?? "").trim().toLowerCase();
      if (fill === "none" && stroke && stroke !== "none") {
        warnings.add(
          "צורות עם קו מתאר בלבד (stroke ללא fill) יומרו לפי קו המתאר — התוצאה עשויה להיות שונה מהצפוי"
        );
      }
    }
  }

  // Derive the intrinsic aspect ratio from viewBox or width/height.
  let aspectRatio = 1;
  const viewBox = root.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      aspectRatio = parts[2] / parts[3];
    }
  } else {
    const w = parseFloat(root.getAttribute("width") ?? "");
    const h = parseFloat(root.getAttribute("height") ?? "");
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      aspectRatio = w / h;
    }
  }

  const serialized = new XMLSerializer().serializeToString(root);
  return {
    ok: true,
    svgText: serialized,
    error: null,
    warnings: [...warnings],
    aspectRatio,
  };
}
