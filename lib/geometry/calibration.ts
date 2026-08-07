/**
 * Printer calibration: one measured number that every fit in the app obeys.
 *
 * The tolerance-test generator already produces a coupon with holes at
 * 0.1–0.5 mm clearance, but its RESULT went nowhere: the user printed it,
 * learned their machine needs 0.35 mm, and then had to remember to type that
 * into connectors, inlays, enclosures and threads separately — each of which
 * defaulted to a different guess. This makes the measured value a document
 * setting that all of them read.
 *
 * It also carries the second correction FDM parts always need and the app
 * never applied: a printed hole comes out UNDERSIZED. Extrusion width, die
 * swell and the inward pull of each perimeter around a concave curve mean a
 * nominal 5 mm hole measures roughly 4.6–4.8 mm. Compensating the hole rather
 * than asking the user to oversize every diameter by hand is the difference
 * between a screw that fits and one that does not.
 */

import { getPrinterProfile, type PrinterProfile } from "@/types/profiles";

export interface CalibrationSettings {
  /**
   * Measured clearance for a sliding fit, mm. Taken from the tolerance
   * coupon: the smallest hole the pin drops into.
   */
  measuredClearanceMm: number;
  /**
   * Diametral compensation added to cylindrical holes, mm. Positive makes
   * modelled holes larger so the PRINTED hole matches the nominal size.
   */
  holeCompensationMm: number;
  /**
   * First-layer XY inset, mm, countering "elephant foot" — the squash of the
   * bottom layers against the bed that leaves a part oversized at its base
   * and stops it seating flush.
   */
  elephantFootCompensationMm: number;
  /** Height over which the elephant-foot inset fades out, mm. */
  elephantFootHeightMm: number;
}

/**
 * Defaults for a typical 0.4 mm nozzle running PLA.
 *
 * Deliberately conservative: a value that is slightly too tight produces a
 * part the user can sand, while one that is too loose produces a joint that
 * never grips.
 */
export const DEFAULT_CALIBRATION: CalibrationSettings = {
  measuredClearanceMm: 0.2,
  holeCompensationMm: 0.2,
  elephantFootCompensationMm: 0,
  elephantFootHeightMm: 0.6,
};

export type FitKind =
  /** Parts that must slide freely (lids, drawers, sliding dovetails). */
  | "sliding"
  /** Parts that locate but come apart by hand (pins, alignment keys). */
  | "close"
  /** Parts meant to stay put once assembled (press-fit pins, inlays). */
  | "press";

/**
 * Clearance for a given fit, derived from the ONE measured value.
 *
 * Multipliers rather than independent numbers: a machine that needs 0.3 mm
 * for a sliding fit needs proportionally more everywhere, so calibrating once
 * corrects every fit at the same time.
 */
export function clearanceForFit(
  calibration: CalibrationSettings,
  fit: FitKind
): number {
  const base = Math.max(0, calibration.measuredClearanceMm);
  switch (fit) {
    case "sliding":
      return base;
    case "close":
      return base * 0.5;
    case "press":
      // A press fit is an interference: the parts overlap slightly and the
      // plastic deforms. Negative clearance is the point.
      return -base * 0.25;
  }
}

/**
 * Modelled diameter for a hole that should MEASURE `nominalMm` once printed.
 *
 * Applies to cylindrical holes only. A slot or a pocket loses far less to the
 * same effect because its walls are mostly straight, so over-applying this
 * would leave those loose.
 */
export function compensatedHoleDiameterMm(
  calibration: CalibrationSettings,
  nominalMm: number
): number {
  return Math.max(0.01, nominalMm + Math.max(0, calibration.holeCompensationMm));
}

/**
 * Inset applied at height `zMm` above the plate, mm.
 *
 * Full compensation at the bed, fading linearly to zero at
 * `elephantFootHeightMm` — a hard step would leave a visible ledge exactly
 * where the part is most visible.
 */
export function elephantFootInsetAtHeight(
  calibration: CalibrationSettings,
  zMm: number
): number {
  const amount = Math.max(0, calibration.elephantFootCompensationMm);
  if (amount === 0) return 0;
  const height = Math.max(0.01, calibration.elephantFootHeightMm);
  if (zMm >= height) return 0;
  if (zMm <= 0) return amount;
  return amount * (1 - zMm / height);
}

/** Hebrew summary for the calibration panel. */
export function describeCalibration(calibration: CalibrationSettings): string {
  const parts = [`מרווח נמדד ${calibration.measuredClearanceMm} מ״מ`];
  if (calibration.holeCompensationMm > 0) {
    parts.push(`פיצוי חורים ${calibration.holeCompensationMm} מ״מ`);
  }
  if (calibration.elephantFootCompensationMm > 0) {
    parts.push(`פיצוי רגל פיל ${calibration.elephantFootCompensationMm} מ״מ`);
  }
  return parts.join(" · ");
}

/**
 * The nozzle this document will be printed with, in mm.
 *
 * Several checks need it (lattice struts, minimum feature size) and each was
 * reaching for a different source — or, in the lattice's case, for an
 * optional field nobody ever filled in, which made the check dead code. The
 * order is: an explicit override, then the selected printer (custom printers
 * included), then the FDM default.
 */
export function documentNozzleDiameterMm(document: {
  printerProfileId: string;
  customPrinters?: readonly PrinterProfile[];
  customPrintability?: { nozzleDiameterMm?: number } | null;
}): number {
  const override = document.customPrintability?.nozzleDiameterMm;
  if (override && override > 0) return override;
  const printer = getPrinterProfile(document.printerProfileId, document.customPrinters ?? []);
  return printer.nozzleDiameterMm && printer.nozzleDiameterMm > 0
    ? printer.nozzleDiameterMm
    : 0.4;
}
