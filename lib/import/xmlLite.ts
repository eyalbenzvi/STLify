/**
 * A deliberately small XML reader for the 3MF model part.
 *
 * Why not DOMParser: two reasons, and the second is the important one.
 * DOMParser is browser-only, so the 3MF round-trip test — our writer into our
 * reader — could not run in the node suite. And a hand-written scanner lets
 * the security posture be a property of the code rather than a property of
 * whatever XML engine happens to be underneath: there is no DTD subsystem
 * here to disable, no entity table to expand, and no resolver to point at a
 * URL, because none of them exist.
 *
 * What it understands is exactly what a 3MF model part needs: elements,
 * attributes, self-closing tags, comments and the XML declaration. Anything
 * else — a DOCTYPE, an entity declaration, a processing instruction that is
 * not the declaration — is refused rather than ignored, because in untrusted
 * input the difference between "I skipped that" and "I did not understand
 * that" is the whole attack surface.
 */

export class XmlLiteError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "XmlLiteError";
  }
}

export interface XmlElement {
  /** Local name, namespace prefix stripped. */
  name: string;
  /** Attributes by local name. */
  attrs: Record<string, string>;
  children: XmlElement[];
}

export interface XmlLiteLimits {
  maxElements: number;
  maxDepth: number;
}

export const XML_LITE_LIMITS: XmlLiteLimits = {
  maxElements: 4_000_000,
  maxDepth: 64,
};

/** The five predefined entities, plus numeric character references. */
function decodeText(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        // A named entity that is not predefined can only come from a DTD,
        // and there is no DTD here. Refusing keeps "entity expansion" from
        // being a thing this parser can be asked to do at all.
        throw new XmlLiteError("קובץ ה-XML משתמש בישויות (entities) שאינן נתמכות");
    }
  });
}

/** Strip a namespace prefix: "m:object" → "object". */
function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

const ATTRIBUTE_RE = /([A-Za-z_:][-\w.:]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTRIBUTE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE_RE.exec(source)) !== null) {
    attrs[localName(match[1])] = decodeText(match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/** Parse an XML document into a tree of elements. Text nodes are discarded. */
export function parseXmlLite(
  text: string,
  limits: XmlLiteLimits = XML_LITE_LIMITS
): XmlElement {
  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];
  let elements = 0;
  let i = 0;

  while (i < text.length) {
    const open = text.indexOf("<", i);
    if (open < 0) break;
    i = open + 1;

    if (text.startsWith("!--", i)) {
      const end = text.indexOf("-->", i);
      if (end < 0) throw new XmlLiteError("קובץ ה-XML פגום — הערה שלא נסגרה");
      i = end + 3;
      continue;
    }
    if (text.startsWith("?", i)) {
      const end = text.indexOf("?>", i);
      if (end < 0) throw new XmlLiteError("קובץ ה-XML פגום");
      if (!/^\?xml[\s?]/.test(text.slice(i, i + 6))) {
        throw new XmlLiteError("קובץ ה-XML מכיל הוראות עיבוד שאינן נתמכות");
      }
      i = end + 2;
      continue;
    }
    if (text.startsWith("!", i)) {
      // DOCTYPE, ENTITY, CDATA — none of which a 3MF model part needs, and
      // the first two of which are how XML parsers get talked into reading
      // files and expanding bombs.
      throw new XmlLiteError(
        "קובץ ה-XML מכיל הצהרות DOCTYPE או ישויות שאינן מותרות בייבוא"
      );
    }

    const close = text.indexOf(">", i);
    if (close < 0) throw new XmlLiteError("קובץ ה-XML פגום — תגית שלא נסגרה");
    let body = text.slice(i, close);
    i = close + 1;

    if (body.startsWith("/")) {
      const name = localName(body.slice(1).trim());
      const top = stack.pop();
      if (!top || top.name !== name) {
        throw new XmlLiteError("קובץ ה-XML פגום — תגיות אינן מקוננות נכון");
      }
      continue;
    }

    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1);
    const space = body.search(/\s/);
    const name = localName((space < 0 ? body : body.slice(0, space)).trim());
    if (name.length === 0) throw new XmlLiteError("קובץ ה-XML פגום — תגית ללא שם");

    if (++elements > limits.maxElements) {
      throw new XmlLiteError("קובץ ה-XML מורכב מדי לייבוא");
    }
    const element: XmlElement = {
      name,
      attrs: space < 0 ? {} : parseAttributes(body.slice(space)),
      children: [],
    };

    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root) throw new XmlLiteError("קובץ ה-XML פגום — יותר משורש אחד");
    else root = element;

    if (!selfClosing) {
      if (stack.length + 1 > limits.maxDepth) {
        throw new XmlLiteError("קובץ ה-XML מקונן עמוק מדי לייבוא");
      }
      stack.push(element);
    }
  }

  if (stack.length > 0) throw new XmlLiteError("קובץ ה-XML פגום — תגיות שלא נסגרו");
  if (!root) throw new XmlLiteError("קובץ ה-XML ריק");
  return root;
}

/** Direct children with the given local name. */
export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

/** First direct child with the given local name, or null. */
export function childNamed(element: XmlElement, name: string): XmlElement | null {
  return element.children.find((child) => child.name === name) ?? null;
}
