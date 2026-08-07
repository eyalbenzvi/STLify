/**
 * Turn a generator's dialog parameters into the layers it produces.
 *
 * This is the seam between "what the user asked for" (a bag of numbers from
 * a dialog) and "what the geometry functions want" (a typed settings object
 * each). It lived inside a 130-line switch in the editor component, which
 * meant the editor knew every generator's parameter names, defaults and
 * Hebrew layer names.
 *
 * Calibration is applied here rather than in the dialog: a machine that has
 * been measured knows its own clearance, and the dialog's number is only a
 * guess for a machine nobody measured.
 */

import type { DesignDocument, DesignLayer } from "@/types/design";
import { primaryMaterialSlotId } from "@/types/design";
import { clearanceForFit } from "../calibration";
import type { GeometryKernel } from "../kernel";
import { generatorToLayer } from "../operations/advancedOps";
import {
  buildEnclosure,
  buildGear,
  buildLivingHinge,
  buildSnapFit,
  buildThread,
  buildToleranceTest,
  type ThreadFitClass,
} from "./index";
import {
  booleanParam,
  choiceParam,
  numberParam,
  type GeneratorKind,
  type GeneratorParams,
} from "./specs";

/** Facets around a thread's helix. Enough to look round at print scale. */
const THREAD_SEGMENTS = 48;

/** Standard involute pressure angle; every printable gear profile uses it. */
const GEAR_PRESSURE_ANGLE_DEG = 20;

/** Gap left between the enclosure box and its lid when both are laid out. */
const ENCLOSURE_LAYOUT_GAP_MM = 10;

/** The clearances a calibration coupon tests, in millimetres. */
const TOLERANCE_TEST_CLEARANCES_MM = [0.1, 0.2, 0.3, 0.4, 0.5];

/**
 * A calibrated document's own sliding clearance, or the dialog's guess when
 * the printer has never been measured.
 */
function slidingClearanceMm(
  document: DesignDocument,
  params: GeneratorParams,
  kind: GeneratorKind
): number {
  return document.calibration
    ? clearanceForFit(document.calibration, "sliding")
    : numberParam(kind, params, "clearanceMm");
}

export function buildGeneratorLayers(
  kernel: GeometryKernel,
  document: DesignDocument,
  kind: GeneratorKind,
  params: GeneratorParams
): DesignLayer[] {
  const slot = primaryMaterialSlotId(document);
  const num = (key: string) => numberParam(kind, params, key);

  switch (kind) {
    case "thread": {
      const internal = booleanParam(kind, params, "internal");
      const diameterMm = num("diameterMm");
      const pitchMm = num("pitchMm");
      const solid = buildThread(kernel, {
        diameterMm,
        pitchMm,
        lengthMm: num("lengthMm"),
        internal,
        clearanceMm: slidingClearanceMm(document, params, kind),
        fitClass: choiceParam(kind, params, "fitClass") as ThreadFitClass,
        chamferMm: num("chamferMm"),
        segments: THREAD_SEGMENTS,
      });
      return [
        generatorToLayer(
          solid,
          internal ? "כלי חיתוך להברגה פנימית" : "הברגה",
          slot,
          `הברגה M${diameterMm}×${pitchMm}`
        ),
      ];
    }

    case "gear": {
      const teeth = num("teeth");
      const moduleMm = num("moduleMm");
      const solid = buildGear(kernel, {
        teeth,
        moduleMm,
        thicknessMm: num("thicknessMm"),
        pressureAngleDeg: GEAR_PRESSURE_ANGLE_DEG,
        boreDiameterMm: num("boreDiameterMm"),
        backlashMm: num("backlashMm"),
      });
      return [
        generatorToLayer(
          solid,
          `גלגל שיניים ${teeth}Z`,
          slot,
          `מודול ${moduleMm}, ${teeth} שיניים`
        ),
      ];
    }

    case "enclosure": {
      const innerWidthMm = num("innerWidthMm");
      const wallMm = num("wallMm");
      const { box, lid } = buildEnclosure(kernel, {
        innerWidthMm,
        innerDepthMm: num("innerDepthMm"),
        innerHeightMm: num("innerHeightMm"),
        wallMm,
        floorMm: num("floorMm"),
        cornerRadiusMm: num("cornerRadiusMm"),
        lipHeightMm: num("lipHeightMm"),
        clearanceMm: slidingClearanceMm(document, params, kind),
      });
      const lidLayer = generatorToLayer(lid, "מארז — מכסה", slot, "מכסה המארז");
      // Park the lid beside the box so both are visible and printable.
      lidLayer.transform.x += innerWidthMm + wallMm * 2 + ENCLOSURE_LAYOUT_GAP_MM;
      return [generatorToLayer(box, "מארז — קופסה", slot, "גוף המארז"), lidLayer];
    }

    case "livingHinge": {
      const solid = buildLivingHinge(kernel, {
        widthMm: num("widthMm"),
        lengthMm: num("lengthMm"),
        thicknessMm: num("thicknessMm"),
        hingeThicknessMm: num("hingeThicknessMm"),
        grooveCount: num("grooveCount"),
        grooveWidthMm: num("grooveWidthMm"),
      });
      return [generatorToLayer(solid, "ציר חי", slot, "פאנל מתקפל")];
    }

    case "snapFit": {
      const solid = buildSnapFit(kernel, {
        lengthMm: num("lengthMm"),
        widthMm: num("widthMm"),
        thicknessMm: num("thicknessMm"),
        hookDepthMm: num("hookDepthMm"),
        insertionAngleDeg: num("insertionAngleDeg"),
        retentionAngleDeg: num("retentionAngleDeg"),
      });
      return [generatorToLayer(solid, "תפס", slot, "וו הצמדה גמיש")];
    }

    case "toleranceTest": {
      const spacingMm = num("spacingMm");
      const { plate, pin, clearancesMm } = buildToleranceTest(kernel, {
        pinDiameterMm: num("pinDiameterMm"),
        clearancesMm: TOLERANCE_TEST_CLEARANCES_MM,
        thicknessMm: num("thicknessMm"),
        spacingMm,
      });
      const pinLayer = generatorToLayer(pin, "מבחן סבולות — פין", slot, "פין בדיקה");
      // Offset in +Y so the pin does not overlap the plate it belongs to.
      pinLayer.transform.y += spacingMm;
      return [
        generatorToLayer(
          plate,
          "מבחן סבולות — לוחית",
          slot,
          `מרווחים: ${clearancesMm.join(" / ")} מ״מ`
        ),
        pinLayer,
      ];
    }
  }
}
