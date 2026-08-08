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

/**
 * The element cap is a MEMORY budget, not a stylistic one. Each element is a
 * JS object with an attribute record and a child array, measured at about 234
 * bytes; 1.6 million is roughly 375 MB of heap and a couple of seconds to
 * parse, which is as far as a browser tab should be pushed by a file it was
 * handed. It also sits comfortably above the triangle+vertex element count of
 * the largest 3MF this importer accepts.
 */
export const XML_LITE_LIMITS: XmlLiteLimits = {
  maxElements: 1_600_000,
  maxDepth: 64,
};

/** The largest code point Unicode defines; above it `fromCodePoint` throws. */
const MAX_CODE_POINT = 0x10ffff;

/**
 * Reject the code points XML 1.0 does not allow as characters.
 *
 * `String.fromCodePoint` throws a RangeError — a raw, English one — for
 * anything above the Unicode maximum, which would have escaped this parser to
 * the UI as `Invalid code point 1114112`. Surrogates and most control
 * characters are accepted by `fromCodePoint` but are not legal XML content,
 * and they end up in layer names and material names, so they are refused here
 * rather than carried into the document.
 */
function codePointFromReference(value: number): string {
  const valid =
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_CODE_POINT &&
    !(value >= 0xd800 && value <= 0xdfff) &&
    (value === 0x9 ||
      value === 0xa ||
      value === 0xd ||
      (value >= 0x20 && value !== 0xfffe && value !== 0xffff));
  if (!valid) {
    throw new XmlLiteError("קובץ ה-XML מכיל תו לא חוקי (הפניה מספרית מחוץ לתחום)");
  }
  return String.fromCodePoint(value);
}

/** The five predefined entities, plus numeric character references. */
function decodeText(raw: string): string {
  // Fast path: the overwhelming majority of 3MF attribute values are numbers.
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x")) return codePointFromReference(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return codePointFromReference(parseInt(body.slice(1), 10));
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

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * Scan `name="value"` pairs in a single forward pass.
 *
 * This was a global regex, and it was the parser's worst weakness: the name
 * pattern's trailing `*` backtracks at every start position when no `=`
 * follows, so the scan was QUADRATIC in the length of the tag. Measured on the
 * regex version, 4× the input cost 14.5× the time, and a 200 KB tag body — a
 * legal size for a file this importer otherwise accepts — blocked the main
 * thread for 43 seconds. A hand-rolled scan is linear and cannot backtrack.
 *
 * Every branch advances `i` by at least one character, so the loop terminates
 * on any input, malformed included.
 */
function parseAttributes(source: string): Record<string, string> {
  // Null-prototype: attribute names come from the file, and a plain object
  // would answer `attrs.constructor` with something inherited. Callers read
  // these by name, so the map must contain only what the file actually said.
  const attrs: Record<string, string> = Object.create(null);
  const n = source.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(source[i])) i++;
    if (i >= n) break;
    const nameStart = i;
    while (i < n && !isSpace(source[i]) && source[i] !== "=") i++;
    const name = source.slice(nameStart, i);
    while (i < n && isSpace(source[i])) i++;
    if (i >= n) break;
    if (source[i] !== "=") continue; // a bare token; `i` already moved past it
    i++;
    while (i < n && isSpace(source[i])) i++;
    const quote = source[i];
    if (quote !== '"' && quote !== "'") {
      // Unquoted attribute values are not well-formed XML, and guessing where
      // one ends is how a parser starts disagreeing with every other parser.
      throw new XmlLiteError("קובץ ה-XML פגום — ערך תכונה ללא מרכאות");
    }
    const valueStart = ++i;
    while (i < n && source[i] !== quote) i++;
    if (i >= n) throw new XmlLiteError("קובץ ה-XML פגום — ערך תכונה שלא נסגר");
    const value = source.slice(valueStart, i);
    i++;
    if (name.length > 0) attrs[localName(name)] = decodeText(value);
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
      attrs: space < 0 ? Object.create(null) : parseAttributes(body.slice(space)),
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
