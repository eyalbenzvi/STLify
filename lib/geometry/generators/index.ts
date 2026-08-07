/**
 * Parametric part generators.
 *
 * These are the pieces users cannot draw by hand but constantly need: real
 * ISO-profile threads, involute gears that actually mesh, enclosures with a
 * fitted lid, living hinges and snap-fit clips. Each one is pure geometry
 * driven by named parameters, so it stays editable and reproducible.
 *
 * Printing tolerances are explicit parameters everywhere, because a thread or
 * a clip that ignores them is useless on an FDM printer.
 */

import type { Contour, GeometryKernel, Solid } from "../kernel";
import { BOOLEAN_OVERLAP_MM } from "../solids";

export class GeneratorError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "GeneratorError";
  }
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export interface ThreadSettings {
  /** Nominal outer diameter, mm (M8 -> 8). */
  diameterMm: number;
  /** Distance between adjacent crests along the axis, mm. */
  pitchMm: number;
  lengthMm: number;
  /** External (bolt) or internal (nut) thread. */
  internal: boolean;
  /**
   * Diametral clearance applied to the internal thread so a printed nut runs
   * on a printed bolt. Ignored for external threads.
   */
  clearanceMm: number;
  /** Facets per turn. */
  segments: number;
  /** Right-handed unless set. */
  leftHanded?: boolean;
}

/**
 * A helical thread built as a twisted extrusion.
 *
 * The cross-section is the thread's axial profile swept around the axis: one
 * full turn per `pitch` of height is exactly a 360-degree twist, so the whole
 * thread is a single `extrudeAdvanced` call rather than a boolean union of
 * hundreds of segments. That keeps it fast enough to regenerate live.
 *
 * The profile is the ISO 60-degree triangle truncated at crest and root
 * (H/8 crest, H/4 root), which is what makes printed threads engage instead
 * of binding on their sharp tips.
 */
export function buildThread(kernel: GeometryKernel, settings: ThreadSettings): Solid {
  const { diameterMm, pitchMm, lengthMm } = settings;
  if (diameterMm <= 0) throw new GeneratorError("קוטר ההברגה חייב להיות גדול מאפס");
  if (pitchMm <= 0) throw new GeneratorError("הפסיעה חייבת להיות גדולה מאפס");
  if (lengthMm <= 0) throw new GeneratorError("אורך ההברגה חייב להיות גדול מאפס");
  if (pitchMm > diameterMm) {
    throw new GeneratorError("הפסיעה גדולה מדי ביחס לקוטר ההברגה");
  }

  const clearance = settings.internal ? Math.max(0, settings.clearanceMm) : 0;
  const majorRadius = diameterMm / 2 + clearance / 2;
  // ISO metric: H = pitch * sqrt(3)/2, thread depth = 5H/8.
  const H = (pitchMm * Math.sqrt(3)) / 2;
  const depth = (5 * H) / 8;
  const minorRadius = majorRadius - depth;
  if (minorRadius <= 0) {
    throw new GeneratorError("הפסיעה גדולה מדי — שורש ההברגה יוצא מהציר");
  }

  const turns = lengthMm / pitchMm;
  const segments = Math.max(16, Math.round(settings.segments));
  const divisions = Math.max(8, Math.round(turns * segments));
  if (divisions > 20_000) {
    throw new GeneratorError("ההברגה ארוכה או עדינה מדי לחישוב בדפדפן");
  }

  // Build the thread as a TWISTED EXTRUSION rather than a hand-stitched
  // helical sweep. One full turn of twist per pitch of rise is exactly a
  // helix, so the whole thread is a single kernel call whose output is
  // manifold by construction — no cap stitching to get wrong, and fast
  // enough to regenerate while the user drags a slider.
  //
  // The cross-section is the ISO axial profile re-expressed as radius versus
  // ANGLE: because the section rotates a full turn every `pitch` of height,
  // an axial offset `a` from the crest corresponds to the angle
  // a / pitch * 360 degrees.
  const crestHalfAxial = pitchMm / 16;
  const rootHalfAxial = pitchMm / 2 - pitchMm / 8;
  const radiusAtAxialOffset = (a: number): number => {
    const t = Math.abs(a);
    if (t <= crestHalfAxial) return majorRadius;
    if (t >= rootHalfAxial) return minorRadius;
    const k = (t - crestHalfAxial) / (rootHalfAxial - crestHalfAxial);
    return majorRadius - k * (majorRadius - minorRadius);
  };

  const section: Contour = [];
  for (let i = 0; i < segments; i++) {
    const fraction = i / segments;
    const angle = fraction * Math.PI * 2;
    // Axial offset of this angular position, wrapped to [-pitch/2, +pitch/2].
    let axial = fraction * pitchMm;
    if (axial > pitchMm / 2) axial -= pitchMm;
    const r = radiusAtAxialOffset(axial);
    section.push([r * Math.cos(angle), r * Math.sin(angle)]);
  }

  const twist = turns * 360 * (settings.leftHanded ? -1 : 1);
  const thread = kernel.extrudeAdvanced([section], lengthMm, {
    divisions,
    twistDegrees: twist,
  });
  if (thread.status() !== "NoError" || thread.isEmpty()) {
    thread.dispose();
    throw new GeneratorError("בניית ההברגה נכשלה — נסו פסיעה או קוטר אחרים");
  }

  if (!settings.internal) return thread;

  // Internal threads are returned as a CUTTING TOOL: the caller subtracts
  // this from a blank to get a nut. Adding the clearance bore guarantees the
  // cut reaches the root even where the helix does not.
  const bore = kernel
    .cylinder(minorRadius, lengthMm + BOOLEAN_OVERLAP_MM * 2, segments)
    .translate(0, 0, -BOOLEAN_OVERLAP_MM);
  return thread.union(bore);
}

// ---------------------------------------------------------------------------
// Gears
// ---------------------------------------------------------------------------

export interface GearSettings {
  /** Number of teeth. */
  teeth: number;
  /** Module: pitch diameter / teeth, mm. Two gears mesh iff modules match. */
  moduleMm: number;
  thicknessMm: number;
  /** Standard is 20 degrees. */
  pressureAngleDeg: number;
  /** Central bore diameter, mm. 0 = solid. */
  boreDiameterMm: number;
  /** Extra gap between meshing teeth, mm. */
  backlashMm: number;
}

/**
 * A spur gear with a true involute tooth flank.
 *
 * The involute is what makes gears transmit motion at constant velocity; a
 * trapezoid approximation binds and chatters. Each flank is generated by
 * unrolling the base circle, mirrored across the tooth centre line.
 */
export function buildGearProfile(settings: GearSettings): Contour {
  const teeth = Math.round(settings.teeth);
  if (teeth < 5) throw new GeneratorError("מספר השיניים חייב להיות 5 לפחות");
  if (teeth > 500) throw new GeneratorError("מספר השיניים מוגבל ל-500");
  if (settings.moduleMm <= 0) throw new GeneratorError("המודול חייב להיות גדול מאפס");

  const m = settings.moduleMm;
  const pressureAngle = (settings.pressureAngleDeg * Math.PI) / 180;
  const pitchRadius = (m * teeth) / 2;
  const baseRadius = pitchRadius * Math.cos(pressureAngle);
  const addendumRadius = pitchRadius + m; // tip
  const dedendumRadius = Math.max(0.1, pitchRadius - 1.25 * m); // root

  /** Involute of the base circle, parameterised by roll angle. */
  const involuteAt = (radius: number): { angle: number } => {
    if (radius <= baseRadius) return { angle: 0 };
    const alpha = Math.acos(Math.min(1, baseRadius / radius));
    return { angle: Math.tan(alpha) - alpha };
  };

  // Angular half-width of a tooth at the pitch circle, minus backlash.
  const backlashAngle = settings.backlashMm / pitchRadius / 2;
  const halfToothAngle = Math.PI / (2 * teeth) - backlashAngle;
  const pitchInvolute = involuteAt(pitchRadius).angle;

  const flankSteps = 10;
  const contour: Contour = [];
  const toothPitch = (Math.PI * 2) / teeth;

  for (let t = 0; t < teeth; t++) {
    const centre = t * toothPitch;
    const flank: { r: number; a: number }[] = [];
    const start = Math.max(baseRadius, dedendumRadius);
    for (let i = 0; i <= flankSteps; i++) {
      const r = start + ((addendumRadius - start) * i) / flankSteps;
      const inv = involuteAt(r).angle;
      // Offset so the flank crosses the pitch circle at the half-tooth angle.
      flank.push({ r, a: halfToothAngle + pitchInvolute - inv });
    }

    // Root before the tooth (trailing side of the previous gap).
    contour.push([
      dedendumRadius * Math.cos(centre - halfToothAngle - backlashAngle - toothPitch / 4),
      dedendumRadius * Math.sin(centre - halfToothAngle - backlashAngle - toothPitch / 4),
    ]);
    // Walk the tooth in strictly increasing angle so the outline never
    // doubles back on itself: up the trailing flank from root to tip, across
    // the tip, then down the leading flank from tip back to root. The flank
    // array is ordered base-to-tip, and its stored angle SHRINKS as the
    // radius grows, so the trailing side must be traversed forwards and the
    // leading side backwards.
    for (let i = 0; i < flank.length; i++) {
      const a = centre - flank[i].a;
      contour.push([flank[i].r * Math.cos(a), flank[i].r * Math.sin(a)]);
    }
    for (let i = flank.length - 1; i >= 0; i--) {
      const a = centre + flank[i].a;
      contour.push([flank[i].r * Math.cos(a), flank[i].r * Math.sin(a)]);
    }
    // Root after the tooth.
    contour.push([
      dedendumRadius * Math.cos(centre + halfToothAngle + backlashAngle + toothPitch / 4),
      dedendumRadius * Math.sin(centre + halfToothAngle + backlashAngle + toothPitch / 4),
    ]);
  }
  return contour;
}

export function buildGear(kernel: GeometryKernel, settings: GearSettings): Solid {
  if (settings.thicknessMm <= 0) throw new GeneratorError("עובי גלגל השיניים חייב להיות גדול מאפס");
  const profile = buildGearProfile(settings);
  const gear = kernel.extrude([profile], settings.thicknessMm);
  if (settings.boreDiameterMm <= 0) return gear;
  const pitchRadius = (settings.moduleMm * Math.round(settings.teeth)) / 2;
  if (settings.boreDiameterMm / 2 >= pitchRadius) {
    gear.dispose();
    throw new GeneratorError("קוטר החור המרכזי גדול מדי ביחס לגלגל");
  }
  const bore = kernel
    .cylinder(settings.boreDiameterMm / 2, settings.thicknessMm + BOOLEAN_OVERLAP_MM * 2, 64)
    .translate(0, 0, -BOOLEAN_OVERLAP_MM);
  return gear.subtract(bore);
}

/** Pitch diameter, so callers can space two meshing gears correctly. */
export function gearPitchDiameterMm(settings: Pick<GearSettings, "teeth" | "moduleMm">): number {
  return settings.moduleMm * Math.round(settings.teeth);
}

// ---------------------------------------------------------------------------
// Enclosure (box with a fitted lid)
// ---------------------------------------------------------------------------

export interface EnclosureSettings {
  /** Internal cavity size, mm. */
  innerWidthMm: number;
  innerDepthMm: number;
  innerHeightMm: number;
  wallMm: number;
  floorMm: number;
  cornerRadiusMm: number;
  /** Height of the lip that locates the lid, mm. 0 = flat lid. */
  lipHeightMm: number;
  /** Gap between lid and box so they actually fit once printed, mm. */
  clearanceMm: number;
}

export interface EnclosureResult {
  box: Solid;
  lid: Solid;
}

/**
 * A two-part enclosure. The lid carries a lip that drops into the box; the
 * lip is inset by the wall thickness AND the clearance, which is the whole
 * reason printed boxes either snap together or refuse to close.
 */
export function buildEnclosure(
  kernel: GeometryKernel,
  settings: EnclosureSettings
): EnclosureResult {
  const { innerWidthMm: iw, innerDepthMm: id, innerHeightMm: ih } = settings;
  const wall = settings.wallMm;
  const floor = settings.floorMm;
  if (iw <= 0 || id <= 0 || ih <= 0) {
    throw new GeneratorError("מידות החלל הפנימי חייבות להיות גדולות מאפס");
  }
  if (wall <= 0 || floor <= 0) {
    throw new GeneratorError("עובי הדופן והרצפה חייבים להיות גדולים מאפס");
  }
  const clearance = Math.max(0, settings.clearanceMm);

  const outerW = iw + wall * 2;
  const outerD = id + wall * 2;
  const outerH = ih + floor;
  const radius = Math.max(0, Math.min(settings.cornerRadiusMm, Math.min(outerW, outerD) / 2 - 0.01));

  const rounded = (w: number, d: number, r: number): Contour => {
    if (r <= 1e-6) {
      return [
        [-w / 2, -d / 2],
        [w / 2, -d / 2],
        [w / 2, d / 2],
        [-w / 2, d / 2],
      ];
    }
    const points: Contour = [];
    const per = 8;
    const corners: [number, number, number][] = [
      [w / 2 - r, -d / 2 + r, -Math.PI / 2],
      [w / 2 - r, d / 2 - r, 0],
      [-w / 2 + r, d / 2 - r, Math.PI / 2],
      [-w / 2 + r, -d / 2 + r, Math.PI],
    ];
    for (const [cx, cy, start] of corners) {
      for (let i = 0; i <= per; i++) {
        const a = start + (i / per) * (Math.PI / 2);
        points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    }
    return points;
  };

  // Box: outer shell minus the cavity.
  const shell = kernel.extrude([rounded(outerW, outerD, radius)], outerH);
  const cavity = kernel
    .extrude([rounded(iw, id, Math.max(0, radius - wall))], ih + BOOLEAN_OVERLAP_MM)
    .translate(0, 0, floor);
  const box = shell.subtract(cavity);

  // Lid: a plate the size of the box, plus a lip that drops into the cavity.
  const lidPlate = kernel.extrude([rounded(outerW, outerD, radius)], wall);
  let lid = lidPlate;
  if (settings.lipHeightMm > 0) {
    const lipW = iw - clearance * 2;
    const lipD = id - clearance * 2;
    if (lipW <= 0 || lipD <= 0) {
      lid.dispose();
      box.dispose();
      throw new GeneratorError("המרווח גדול מדי ביחס לחלל הפנימי");
    }
    // The lip is a ring, not a plug, so the lid does not become a solid block.
    const lipOuter = rounded(lipW, lipD, Math.max(0, radius - wall - clearance));
    const lipInner = rounded(
      Math.max(0.1, lipW - wall * 2),
      Math.max(0.1, lipD - wall * 2),
      Math.max(0, radius - wall * 2 - clearance)
    );
    const lipRing = kernel
      .extrude([lipOuter, [...lipInner].reverse()], settings.lipHeightMm + BOOLEAN_OVERLAP_MM)
      .translate(0, 0, wall - BOOLEAN_OVERLAP_MM);
    lid = lid.union(lipRing);
  }

  return { box, lid };
}

// ---------------------------------------------------------------------------
// Living hinge
// ---------------------------------------------------------------------------

export interface LivingHingeSettings {
  widthMm: number;
  lengthMm: number;
  thicknessMm: number;
  /** Thickness left at the flexing line, mm. Must be much thinner than the panel. */
  hingeThicknessMm: number;
  /** Number of parallel flex grooves. */
  grooveCount: number;
  grooveWidthMm: number;
}

/**
 * A flat panel with thinned grooves that let it fold.
 *
 * The hinge thickness is the whole design: too thick and it will not bend,
 * too thin and it snaps on the first fold. For PLA the usable window is
 * roughly 0.3-0.6 mm, which the validator enforces.
 */
export function buildLivingHinge(
  kernel: GeometryKernel,
  settings: LivingHingeSettings
): Solid {
  const { widthMm, lengthMm, thicknessMm, hingeThicknessMm } = settings;
  if (widthMm <= 0 || lengthMm <= 0 || thicknessMm <= 0) {
    throw new GeneratorError("מידות הפאנל חייבות להיות גדולות מאפס");
  }
  if (hingeThicknessMm <= 0 || hingeThicknessMm >= thicknessMm) {
    throw new GeneratorError("עובי הציר החי חייב להיות קטן מעובי הפאנל");
  }
  const count = Math.max(1, Math.round(settings.grooveCount));
  if (settings.grooveWidthMm <= 0) {
    throw new GeneratorError("רוחב החריץ חייב להיות גדול מאפס");
  }
  const span = count * settings.grooveWidthMm;
  if (span >= lengthMm) {
    throw new GeneratorError("החריצים רחבים מדי ביחס לאורך הפאנל");
  }

  let panel = kernel.box(widthMm, lengthMm, thicknessMm, true).translate(0, 0, thicknessMm / 2);
  const depth = thicknessMm - hingeThicknessMm;
  // Grooves are centred on the panel and evenly spaced.
  const pitch = settings.grooveWidthMm * 2;
  const totalSpan = (count - 1) * pitch;
  for (let i = 0; i < count; i++) {
    const y = -totalSpan / 2 + i * pitch;
    const groove = kernel
      .box(widthMm + BOOLEAN_OVERLAP_MM * 2, settings.grooveWidthMm, depth + BOOLEAN_OVERLAP_MM, true)
      .translate(0, y, thicknessMm - depth / 2 + BOOLEAN_OVERLAP_MM / 2);
    panel = panel.subtract(groove);
  }
  return panel;
}

// ---------------------------------------------------------------------------
// Snap-fit clip
// ---------------------------------------------------------------------------

export interface SnapFitSettings {
  /** Cantilever arm length, mm. */
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  /** How far the hook protrudes, mm. */
  hookDepthMm: number;
  /** Lead-in angle that lets the clip slide in, degrees. */
  insertionAngleDeg: number;
  /** Retention angle; 90 degrees means it cannot be removed without breaking. */
  retentionAngleDeg: number;
}

/**
 * A cantilever snap-fit hook.
 *
 * Built as a swept profile: the arm plus a hook whose two faces have separate
 * angles — a shallow lead-in to push past, and a steep return face to hold.
 */
export function buildSnapFit(kernel: GeometryKernel, settings: SnapFitSettings): Solid {
  const { lengthMm, widthMm, thicknessMm, hookDepthMm } = settings;
  if (lengthMm <= 0 || widthMm <= 0 || thicknessMm <= 0) {
    throw new GeneratorError("מידות התפס חייבות להיות גדולות מאפס");
  }
  if (hookDepthMm <= 0) throw new GeneratorError("עומק הוו חייב להיות גדול מאפס");
  const insertion = Math.max(5, Math.min(settings.insertionAngleDeg, 80));
  const retention = Math.max(30, Math.min(settings.retentionAngleDeg, 90));

  // Side profile in XZ: arm from z=0 to lengthMm, hook at the top.
  const leadRun = hookDepthMm / Math.tan((insertion * Math.PI) / 180);
  const retentionRun = hookDepthMm / Math.tan((retention * Math.PI) / 180);
  const profile: Contour = [
    [0, 0],
    [thicknessMm, 0],
    [thicknessMm, lengthMm - leadRun - retentionRun],
    [thicknessMm + hookDepthMm, lengthMm - leadRun],
    [thicknessMm, lengthMm],
    [0, lengthMm],
  ];

  return kernel
    .extrude([profile], widthMm)
    .rotate(90, 0, 0)
    .translate(0, widthMm / 2, 0);
}

// ---------------------------------------------------------------------------
// Tolerance test strip
// ---------------------------------------------------------------------------

export interface ToleranceTestSettings {
  /** Pin diameter, mm. */
  pinDiameterMm: number;
  /** Clearances to test, mm (each gets its own hole). */
  clearancesMm: number[];
  thicknessMm: number;
  /** Spacing between test positions, mm. */
  spacingMm: number;
}

export interface ToleranceTestResult {
  /** Plate with one hole per clearance, labelled by position order. */
  plate: Solid;
  /** A single pin to try in each hole. */
  pin: Solid;
  /** Clearance values in the order the holes appear along +X. */
  clearancesMm: number[];
}

/**
 * A calibration coupon: one pin and a plate of holes at increasing clearance.
 *
 * Printing this once tells the user their machine's real fit tolerance, which
 * every other parameter in the app (connectors, inlays, enclosures, threads)
 * then depends on. It is the cheapest accuracy win available.
 */
export function buildToleranceTest(
  kernel: GeometryKernel,
  settings: ToleranceTestSettings
): ToleranceTestResult {
  const { pinDiameterMm, thicknessMm, spacingMm } = settings;
  if (pinDiameterMm <= 0) throw new GeneratorError("קוטר הפין חייב להיות גדול מאפס");
  if (thicknessMm <= 0) throw new GeneratorError("עובי הלוחית חייב להיות גדול מאפס");
  const clearances = settings.clearancesMm.filter((c) => Number.isFinite(c) && c >= 0);
  if (clearances.length === 0) throw new GeneratorError("יש להגדיר לפחות מרווח אחד לבדיקה");
  if (spacingMm <= pinDiameterMm) {
    throw new GeneratorError("המרווח בין החורים קטן מדי ביחס לקוטר הפין");
  }

  const width = spacingMm * clearances.length;
  const depth = spacingMm;
  let plate = kernel.box(width, depth, thicknessMm, true).translate(0, 0, thicknessMm / 2);
  clearances.forEach((clearance, i) => {
    const x = -width / 2 + spacingMm * (i + 0.5);
    const hole = kernel
      .cylinder(
        (pinDiameterMm + clearance) / 2,
        thicknessMm + BOOLEAN_OVERLAP_MM * 2,
        48
      )
      .translate(x, 0, -BOOLEAN_OVERLAP_MM);
    plate = plate.subtract(hole);
  });

  const pin = kernel.cylinder(pinDiameterMm / 2, thicknessMm * 2, 48);
  return { plate, pin, clearancesMm: clearances };
}
