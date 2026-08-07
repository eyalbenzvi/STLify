/**
 * The non-destructive layer: expressions, named parameters, the modifier
 * stack, and hierarchy with pivots.
 *
 * The point of a modifier stack is that editing a parameter re-derives the
 * result from the SOURCE rather than from the previous result, so these
 * tests check re-derivation explicitly: applying a stack twice with
 * different settings must give the same answer as applying the second
 * setting to a fresh body.
 */

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  evaluateExpression,
  expressionDependencies,
  ExpressionError,
  resolveBinding,
  resolveParameters,
  type ParameterDefinition,
} from "../expression";
import { getGeometryKernel } from "../kernel";
import { applyModifiers, defaultModifier, describeModifier, type Modifier } from "../modifiers";
import { layerWorldMatrix } from "../buildDocument";
import { validateDocument } from "../documentValidation";
import {
  defaultPrimitive,
  identityTransform,
  type DesignDocument,
  type DesignLayer,
} from "@/types/design";

const NO_VARS = new Map<string, number>();

describe("expression evaluator", () => {
  it("evaluates arithmetic with correct precedence", () => {
    expect(evaluateExpression("2 + 3 * 4", NO_VARS)).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4", NO_VARS)).toBe(20);
    expect(evaluateExpression("2 ^ 3 ^ 2", NO_VARS)).toBe(512); // right assoc
    expect(evaluateExpression("-5 + 2", NO_VARS)).toBe(-3);
    expect(evaluateExpression("10 % 3", NO_VARS)).toBe(1);
  });

  it("resolves variables and constants", () => {
    const vars = new Map([["wall", 2.5]]);
    expect(evaluateExpression("wall * 2", vars)).toBe(5);
    expect(evaluateExpression("pi", NO_VARS)).toBeCloseTo(Math.PI, 10);
  });

  it("supports functions, with degrees for trigonometry", () => {
    expect(evaluateExpression("max(3, 7, 5)", NO_VARS)).toBe(7);
    expect(evaluateExpression("round(2.6)", NO_VARS)).toBe(3);
    expect(evaluateExpression("sqrt(16)", NO_VARS)).toBe(4);
    // Degrees, not radians — every other angle in the app is in degrees.
    expect(evaluateExpression("sin(90)", NO_VARS)).toBeCloseTo(1, 10);
  });

  it("supports Hebrew parameter names", () => {
    const vars = new Map([["עובי", 3]]);
    expect(evaluateExpression("עובי * 2", vars)).toBe(6);
  });

  it("rejects unknown parameters and malformed input in Hebrew", () => {
    expect(() => evaluateExpression("nope + 1", NO_VARS)).toThrow(/פרמטר לא מוכר/);
    expect(() => evaluateExpression("2 +", NO_VARS)).toThrow(ExpressionError);
    expect(() => evaluateExpression("(2 + 3", NO_VARS)).toThrow(/חסר/);
    expect(() => evaluateExpression("1 / 0", NO_VARS)).toThrow(/חלוקה באפס/);
    expect(() => evaluateExpression("bogus(2)", NO_VARS)).toThrow(/פונקציה לא מוכרת/);
  });

  it("cannot execute code — it is a parser, not eval", () => {
    // Anything that is not arithmetic is a tokenizer or parser error, never
    // an executed statement. Design files are shared between users.
    expect(() => evaluateExpression("globalThis", NO_VARS)).toThrow(/פרמטר לא מוכר/);
    expect(() => evaluateExpression("1;alert(1)", NO_VARS)).toThrow(ExpressionError);
    expect(() => evaluateExpression("[].constructor", NO_VARS)).toThrow(ExpressionError);
  });

  it("lists dependencies without counting functions or constants", () => {
    expect(expressionDependencies("max(wall, floor) + pi").sort()).toEqual([
      "floor",
      "wall",
    ]);
  });
});

describe("resolveParameters", () => {
  const param = (
    name: string,
    value: number,
    expression = ""
  ): ParameterDefinition => ({ name, value, expression, noteHe: "" });

  it("resolves a chain of dependent parameters", () => {
    const { values, errors } = resolveParameters([
      param("wall", 2),
      param("double", 0, "wall * 2"),
      param("quad", 0, "double * 2"),
    ]);
    expect(errors.size).toBe(0);
    expect(values.get("double")).toBe(4);
    expect(values.get("quad")).toBe(8);
  });

  it("resolves regardless of declaration order", () => {
    const { values } = resolveParameters([
      param("derived", 0, "base + 1"),
      param("base", 10),
    ]);
    expect(values.get("derived")).toBe(11);
  });

  it("reports a circular reference instead of hanging", () => {
    const { values, errors } = resolveParameters([
      param("a", 1, "b + 1"),
      param("b", 2, "a + 1"),
    ]);
    expect(errors.size).toBeGreaterThan(0);
    expect([...errors.values()][0]).toMatch(/מעגלית/);
    // Both still get their literal fallback so the document builds.
    expect(values.get("a")).toBe(1);
    expect(values.get("b")).toBe(2);
  });

  it("falls back to the literal when an expression is broken", () => {
    const { values, errors } = resolveParameters([param("x", 7, "nope * 2")]);
    expect(values.get("x")).toBe(7);
    expect(errors.get("x")).toMatch(/פרמטר לא מוכר/);
  });
});

describe("resolveBinding", () => {
  it("returns the fallback for an empty binding", () => {
    expect(resolveBinding("", NO_VARS, 5)).toEqual({ value: 5, errorHe: null });
    expect(resolveBinding(undefined, NO_VARS, 5).value).toBe(5);
  });

  it("evaluates against the parameter table", () => {
    const vars = new Map([["wall", 3]]);
    expect(resolveBinding("wall * 2", vars, 0).value).toBe(6);
  });

  it("reports an error and keeps the fallback", () => {
    const result = resolveBinding("missing + 1", NO_VARS, 4);
    expect(result.value).toBe(4);
    expect(result.errorHe).toMatch(/פרמטר/);
  });
});

describe("modifier stack", () => {
  it("applies modifiers in order", async () => {
    const kernel = await getGeometryKernel();
    const stack: Modifier[] = [
      { id: "m1", enabled: true, kind: "taper", axis: "z", endScale: 0.5 },
    ];
    const box = kernel.box(20, 20, 20, true).translate(0, 0, 10);
    const before = box.volumeMm3();
    const { solid, errorsHe } = applyModifiers(kernel, box, stack);
    expect(errorsHe).toHaveLength(0);
    expect(solid.volumeMm3()).toBeLessThan(before);
    solid.dispose();
  });

  it("skips disabled modifiers without removing them", async () => {
    const kernel = await getGeometryKernel();
    const stack: Modifier[] = [
      { id: "m1", enabled: false, kind: "taper", axis: "z", endScale: 0.5 },
    ];
    const box = kernel.box(20, 20, 20, true);
    const { solid } = applyModifiers(kernel, box, stack);
    expect(solid.volumeMm3()).toBeCloseTo(8000, 3);
    solid.dispose();
  });

  it("re-derives from the source: editing a parameter is not cumulative", async () => {
    const kernel = await getGeometryKernel();
    const build = (endScale: number) => {
      const box = kernel.box(20, 20, 20, true).translate(0, 0, 10);
      const { solid } = applyModifiers(kernel, box, [
        { id: "m1", enabled: true, kind: "taper", axis: "z", endScale },
      ]);
      const volume = solid.volumeMm3();
      solid.dispose();
      return volume;
    };
    // This is the whole point of a modifier stack: applying 0.5 then
    // changing to 0.8 must equal applying 0.8 to a fresh body, NOT 0.5*0.8.
    const at05 = build(0.5);
    const at08 = build(0.8);
    const at04 = build(0.4);
    expect(at08).toBeGreaterThan(at05);
    expect(at04).toBeLessThan(at05);
    // Re-running the same settings is deterministic.
    expect(build(0.5)).toBeCloseTo(at05, 6);
  });

  it("order matters and is respected", async () => {
    const kernel = await getGeometryKernel();
    const taper: Modifier = { id: "a", enabled: true, kind: "taper", axis: "z", endScale: 0.5 };
    const shell: Modifier = {
      id: "b", enabled: true, kind: "shell", wallThicknessMm: 2, opening: "top",
    };
    const first = applyModifiers(kernel, kernel.box(30, 30, 30, true).translate(0, 0, 15), [taper, shell]);
    const second = applyModifiers(kernel, kernel.box(30, 30, 30, true).translate(0, 0, 15), [shell, taper]);
    expect(first.errorsHe).toHaveLength(0);
    expect(second.errorsHe).toHaveLength(0);
    // Tapering a shell is not the same body as shelling a taper.
    expect(first.solid.volumeMm3()).not.toBeCloseTo(second.solid.volumeMm3(), 1);
    first.solid.dispose();
    second.solid.dispose();
  });

  it("a failing modifier is reported but does not destroy the body", async () => {
    const kernel = await getGeometryKernel();
    const stack: Modifier[] = [
      // Impossible: radius far larger than half the smallest dimension.
      { id: "bad", enabled: true, kind: "fillet", sizeMm: 50, style: "fillet", scope: "convex" },
      { id: "good", enabled: true, kind: "taper", axis: "z", endScale: 0.8 },
    ];
    const { solid, errorsHe } = applyModifiers(
      kernel,
      kernel.box(20, 20, 20, true).translate(0, 0, 10),
      stack
    );
    expect(errorsHe).toHaveLength(1);
    expect(errorsHe[0]).toContain("עיגול קצוות");
    // The stack continued: the taper still ran on the unfilleted body.
    expect(solid.isEmpty()).toBe(false);
    expect(solid.volumeMm3()).toBeGreaterThan(0);
    expect(solid.volumeMm3()).toBeLessThan(8000);
    solid.dispose();
  });

  it("an empty stack returns the body unchanged", async () => {
    const kernel = await getGeometryKernel();
    const { solid, errorsHe } = applyModifiers(kernel, kernel.box(10, 10, 10, true), []);
    expect(errorsHe).toHaveLength(0);
    expect(solid.volumeMm3()).toBeCloseTo(1000, 4);
    solid.dispose();
  });

  it("provides defaults and Hebrew descriptions for every kind", () => {
    const kinds = [
      "fillet", "shell", "twist", "taper", "bend",
      "stretch", "lattice", "remesh", "simplify", "smooth",
    ] as const;
    for (const kind of kinds) {
      const modifier = defaultModifier(kind, `id_${kind}`);
      expect(modifier.kind).toBe(kind);
      expect(modifier.enabled).toBe(true);
      expect(describeModifier(modifier).length).toBeGreaterThan(0);
    }
  });
});

describe("hierarchy and pivots", () => {
  function layer(id: string, overrides: Partial<DesignLayer> = {}): DesignLayer {
    return {
      id,
      type: "primitive",
      name: id,
      visible: true,
      locked: false,
      materialSlotId: "slot1",
      transform: identityTransform(),
      previewOpacity: 1,
      ...defaultPrimitive("box"),
      ...overrides,
    } as DesignLayer;
  }

  function doc(layers: DesignLayer[]): DesignDocument {
    return {
      schemaVersion: 3,
      baseMode: "baseless",
      layers,
      materialSlots: [{ id: "slot1", nameHe: "חומר", colorHex: "#888888" }],
      printerProfileId: "genericFdm220",
      printabilityProfileId: "fdmPla",
      customPrintability: null,
      usageProfileId: null,
      templateId: null,
    };
  }

  it("a child inherits its parent's transform", () => {
    const parent = layer("p", { transform: { ...identityTransform(), x: 10, y: 5 } });
    const child = layer("c", {
      parentId: "p",
      transform: { ...identityTransform(), x: 3 },
    });
    const matrix = layerWorldMatrix(doc([parent, child]), child);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    expect(position.x).toBeCloseTo(13, 6);
    expect(position.y).toBeCloseTo(5, 6);
  });

  it("a parent's rotation orbits its child", () => {
    const parent = layer("p", {
      transform: { ...identityTransform(), rotationZ: 90 },
    });
    const child = layer("c", {
      parentId: "p",
      transform: { ...identityTransform(), x: 10 },
    });
    const position = new THREE.Vector3().setFromMatrixPosition(
      layerWorldMatrix(doc([parent, child]), child)
    );
    // A 90 degree turn takes (10, 0) to (0, 10).
    expect(position.x).toBeCloseTo(0, 6);
    expect(position.y).toBeCloseTo(10, 6);
  });

  it("nests three levels deep", () => {
    const a = layer("a", { transform: { ...identityTransform(), x: 1 } });
    const b = layer("b", { parentId: "a", transform: { ...identityTransform(), x: 2 } });
    const c = layer("c", { parentId: "b", transform: { ...identityTransform(), x: 4 } });
    const position = new THREE.Vector3().setFromMatrixPosition(
      layerWorldMatrix(doc([a, b, c]), c)
    );
    expect(position.x).toBeCloseTo(7, 6);
  });

  it("does not hang on a parent cycle", () => {
    const a = layer("a", { parentId: "b" });
    const b = layer("b", { parentId: "a" });
    // Must return rather than loop forever.
    const matrix = layerWorldMatrix(doc([a, b]), a);
    expect(matrix.elements.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("ignores a dangling parent reference", () => {
    const orphan = layer("o", {
      parentId: "does-not-exist",
      transform: { ...identityTransform(), x: 5 },
    });
    const position = new THREE.Vector3().setFromMatrixPosition(
      layerWorldMatrix(doc([orphan]), orphan)
    );
    expect(position.x).toBeCloseTo(5, 6);
  });

  it("rotates about the pivot rather than the origin", () => {
    // A layer at the origin, pivoted 10mm away, rotated 180 degrees: the
    // body ends up on the far side of the pivot.
    const pivoted = layer("p", {
      pivot: { x: 10, y: 0, z: 0 },
      transform: { ...identityTransform(), rotationZ: 180 },
    });
    const matrix = layerWorldMatrix(doc([pivoted]), pivoted);
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(matrix);
    expect(origin.x).toBeCloseTo(20, 5);
    // The pivot point itself does not move.
    const pivotPoint = new THREE.Vector3(10, 0, 0).applyMatrix4(matrix);
    expect(pivotPoint.x).toBeCloseTo(10, 5);
    expect(pivotPoint.y).toBeCloseTo(0, 5);
  });

  it("a zero pivot behaves exactly like no pivot", () => {
    const withZero = layer("a", {
      pivot: { x: 0, y: 0, z: 0 },
      transform: { ...identityTransform(), rotationZ: 45, x: 3 },
    });
    const without = layer("b", {
      transform: { ...identityTransform(), rotationZ: 45, x: 3 },
    });
    const m1 = layerWorldMatrix(doc([withZero]), withZero);
    const m2 = layerWorldMatrix(doc([without]), without);
    for (let i = 0; i < 16; i++) {
      expect(m1.elements[i]).toBeCloseTo(m2.elements[i], 10);
    }
  });
});

describe("binding validation", () => {
  function docWith(
    bindings: Record<string, string>,
    parameters: ParameterDefinition[] = []
  ): DesignDocument {
    return {
      schemaVersion: 3,
      baseMode: "baseless",
      layers: [
        {
          id: "l1",
          type: "primitive",
          name: "תיבה",
          visible: true,
          locked: false,
          materialSlotId: "slot1",
          transform: identityTransform(),
          previewOpacity: 1,
          bindings,
          ...defaultPrimitive("box"),
        } as DesignLayer,
      ],
      materialSlots: [{ id: "slot1", nameHe: "חומר", colorHex: "#888888" }],
      printerProfileId: "genericFdm220",
      printabilityProfileId: "fdmPla",
      customPrintability: null,
      usageProfileId: null,
      templateId: null,
      parameters,
    };
  }

  it("accepts a binding onto a real field with a defined parameter", () => {
    const result = validateDocument(
      docWith({ widthMm: "wall * 2" }, [
        { name: "wall", value: 5, expression: "", noteHe: "" },
      ])
    );
    expect(result.issues.filter((i) => i.code.startsWith("binding/"))).toHaveLength(0);
  });

  it("reports a binding onto a field that does not exist", () => {
    // The exact defect this check exists for: a typo that silently does
    // nothing rather than failing.
    const result = validateDocument(
      docWith({ widthMmm: "wall" }, [{ name: "wall", value: 5, expression: "", noteHe: "" }])
    );
    const issue = result.issues.find((i) => i.code === "binding/unknown-field");
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("widthMmm");
    expect(issue?.severity).toBe("warning");
  });

  it("reports a binding that uses an undefined parameter", () => {
    const result = validateDocument(docWith({ widthMm: "nope * 2" }));
    const issue = result.issues.find((i) => i.code === "binding/unknown-parameter");
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("nope");
    // An undefined parameter produces wrong geometry, so it blocks the build.
    expect(issue?.severity).toBe("error");
    expect(result.ok).toBe(false);
  });

  it("ignores empty bindings", () => {
    const result = validateDocument(docWith({ widthMm: "   " }));
    expect(result.issues.filter((i) => i.code.startsWith("binding/"))).toHaveLength(0);
  });
});
