/**
 * A tiny arithmetic expression evaluator for parametric dimensions.
 *
 * Every numeric field in the editor was a hard-coded number, so a nameplate
 * for twenty people meant twenty documents and a box in three sizes meant
 * three. Named parameters plus expressions turn one document into a family:
 * `wall * 2`, `innerWidth + wall * 2`, `pitch / 2`.
 *
 * Deliberately NOT `eval` or `new Function`. Design files are shared between
 * users, and an expression is data from an untrusted file — a real parser
 * that only understands arithmetic cannot execute anything, no matter what
 * the file contains. It also lets us give precise Hebrew errors and detect
 * circular references instead of throwing a stack overflow.
 *
 * Grammar:
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/' | '%') factor)*
 *   factor  := ('-' | '+')? primary ('^' factor)?
 *   primary := number | identifier | funcall | '(' expr ')'
 *   funcall := identifier '(' expr (',' expr)* ')'
 */

export class ExpressionError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "ExpressionError";
  }
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "identifier"; value: string }
  | { kind: "operator"; value: string };

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  abs: (a) => Math.abs(a[0]),
  round: (a) => Math.round(a[0]),
  floor: (a) => Math.floor(a[0]),
  ceil: (a) => Math.ceil(a[0]),
  sqrt: (a) => Math.sqrt(a[0]),
  sin: (a) => Math.sin((a[0] * Math.PI) / 180),
  cos: (a) => Math.cos((a[0] * Math.PI) / 180),
  tan: (a) => Math.tan((a[0] * Math.PI) / 180),
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\n") {
      i++;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < input.length && ((input[j] >= "0" && input[j] <= "9") || input[j] === ".")) j++;
      const value = Number(input.slice(i, j));
      if (!Number.isFinite(value)) {
        throw new ExpressionError(`מספר לא חוקי: "${input.slice(i, j)}"`);
      }
      tokens.push({ kind: "number", value });
      i = j;
      continue;
    }
    if (/[A-Za-z_֐-׿]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_֐-׿]/.test(input[j])) j++;
      tokens.push({ kind: "identifier", value: input.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/%^(),".includes(ch)) {
      tokens.push({ kind: "operator", value: ch });
      i++;
      continue;
    }
    throw new ExpressionError(`תו לא חוקי בביטוי: "${ch}"`);
  }
  return tokens;
}

/** Evaluate an expression against a variable table. */
export function evaluateExpression(
  input: string,
  variables: ReadonlyMap<string, number>
): number {
  const tokens = tokenize(input);
  if (tokens.length === 0) throw new ExpressionError("הביטוי ריק");
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const eat = (value: string): boolean => {
    const t = tokens[pos];
    if (t && t.kind === "operator" && t.value === value) {
      pos++;
      return true;
    }
    return false;
  };
  const expect = (value: string): void => {
    if (!eat(value)) throw new ExpressionError(`חסר "${value}" בביטוי`);
  };

  const parseExpr = (): number => {
    let left = parseTerm();
    for (;;) {
      if (eat("+")) left += parseTerm();
      else if (eat("-")) left -= parseTerm();
      else return left;
    }
  };

  const parseTerm = (): number => {
    let left = parseFactor();
    for (;;) {
      if (eat("*")) left *= parseFactor();
      else if (eat("/")) {
        const right = parseFactor();
        if (right === 0) throw new ExpressionError("חלוקה באפס");
        left /= right;
      } else if (eat("%")) {
        const right = parseFactor();
        if (right === 0) throw new ExpressionError("חלוקה באפס");
        left %= right;
      } else return left;
    }
  };

  const parseFactor = (): number => {
    if (eat("-")) return -parseFactor();
    if (eat("+")) return parseFactor();
    const base = parsePrimary();
    if (eat("^")) return base ** parseFactor();
    return base;
  };

  const parsePrimary = (): number => {
    const token = peek();
    if (!token) throw new ExpressionError("הביטוי נגמר באמצע");
    if (token.kind === "number") {
      pos++;
      return token.value;
    }
    if (token.kind === "identifier") {
      pos++;
      const name = token.value;
      if (eat("(")) {
        const fn = FUNCTIONS[name.toLowerCase()];
        if (!fn) throw new ExpressionError(`פונקציה לא מוכרת: "${name}"`);
        const args: number[] = [parseExpr()];
        while (eat(",")) args.push(parseExpr());
        expect(")");
        const result = fn(args);
        if (!Number.isFinite(result)) {
          throw new ExpressionError(`הפונקציה "${name}" החזירה ערך לא חוקי`);
        }
        return result;
      }
      const constant = CONSTANTS[name.toLowerCase()];
      if (constant !== undefined) return constant;
      const value = variables.get(name);
      if (value === undefined) throw new ExpressionError(`פרמטר לא מוכר: "${name}"`);
      return value;
    }
    if (eat("(")) {
      const value = parseExpr();
      expect(")");
      return value;
    }
    throw new ExpressionError(`אסימון לא צפוי: "${token.value}"`);
  };

  const result = parseExpr();
  if (pos !== tokens.length) {
    throw new ExpressionError("יש תווים מיותרים בסוף הביטוי");
  }
  if (!Number.isFinite(result)) throw new ExpressionError("תוצאת הביטוי אינה מספר חוקי");
  return result;
}

/** Identifiers an expression depends on (excluding functions and constants). */
export function expressionDependencies(input: string): string[] {
  let tokens: Token[];
  try {
    tokens = tokenize(input);
  } catch {
    return [];
  }
  const deps = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== "identifier") continue;
    const next = tokens[i + 1];
    // Skip function names (identifier immediately followed by "(").
    if (next && next.kind === "operator" && next.value === "(") continue;
    if (CONSTANTS[t.value.toLowerCase()] !== undefined) continue;
    deps.add(t.value);
  }
  return [...deps];
}

export interface ParameterDefinition {
  name: string;
  /** Literal value, used when `expression` is empty. */
  value: number;
  /** Optional expression referring to other parameters. */
  expression: string;
  /** Free-text note shown in the parameters panel. */
  noteHe: string;
}

export interface ResolvedParameters {
  values: Map<string, number>;
  /** Hebrew errors, keyed by parameter name. */
  errors: Map<string, string>;
}

/**
 * Resolve a parameter table, following dependencies between entries.
 *
 * Circular references are detected and reported per parameter rather than
 * overflowing the stack; a parameter that cannot be resolved falls back to
 * its literal value so the document still builds.
 */
export function resolveParameters(
  parameters: readonly ParameterDefinition[]
): ResolvedParameters {
  const values = new Map<string, number>();
  const errors = new Map<string, string>();
  const byName = new Map<string, ParameterDefinition>();
  for (const p of parameters) byName.set(p.name, p);

  const resolving = new Set<string>();

  const resolve = (name: string): number => {
    const cached = values.get(name);
    if (cached !== undefined) return cached;
    const def = byName.get(name);
    if (!def) throw new ExpressionError(`פרמטר לא מוכר: "${name}"`);
    if (resolving.has(name)) {
      throw new ExpressionError(`הפניה מעגלית בפרמטר "${name}"`);
    }
    if (!def.expression.trim()) {
      values.set(name, def.value);
      return def.value;
    }
    resolving.add(name);
    try {
      // Resolve dependencies first, then evaluate against a table that
      // contains them.
      const scope = new Map<string, number>();
      for (const dep of expressionDependencies(def.expression)) {
        scope.set(dep, resolve(dep));
      }
      const result = evaluateExpression(def.expression, scope);
      values.set(name, result);
      return result;
    } finally {
      resolving.delete(name);
    }
  };

  for (const p of parameters) {
    try {
      resolve(p.name);
    } catch (err) {
      errors.set(p.name, err instanceof ExpressionError ? err.messageHe : String(err));
      // Fall back to the literal so downstream geometry still has a number.
      values.set(p.name, p.value);
    }
  }

  return { values, errors };
}

/**
 * Evaluate a field binding. Returns the fallback when the binding is empty
 * or invalid, along with an optional Hebrew error for the UI.
 */
export function resolveBinding(
  expression: string | undefined,
  variables: ReadonlyMap<string, number>,
  fallback: number
): { value: number; errorHe: string | null } {
  if (!expression || !expression.trim()) return { value: fallback, errorHe: null };
  try {
    return { value: evaluateExpression(expression, variables), errorHe: null };
  } catch (err) {
    return {
      value: fallback,
      errorHe: err instanceof ExpressionError ? err.messageHe : String(err),
    };
  }
}
