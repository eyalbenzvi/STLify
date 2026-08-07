/**
 * Document fixtures for the geometry tests.
 *
 * Nearly every suite needs the same thing to get started: a baseless
 * document with one material slot on a generic FDM printer, holding a box
 * and sometimes a hole. Eight test files had grown their own copy of those
 * three factories, so a field added to DesignDocument meant eight edits and
 * a field's DEFAULT drifting between suites went unnoticed.
 *
 * Every factory takes a patch, so a suite that needs a second slot, a
 * calibration block or a 40 mm box says only that.
 */

import {
  defaultPrimitive,
  identityTransform,
  DESIGN_SCHEMA_VERSION,
  FALLBACK_MATERIAL_SLOT_ID,
  type DesignDocument,
  type DesignLayer,
  type HoleLayer,
  type PrimitiveLayer,
} from "@/types/design";

/** A baseless document on the generic 220 mm FDM profile. */
export function testDocument(patch: Partial<DesignDocument> = {}): DesignDocument {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    baseMode: "baseless",
    layers: [],
    materialSlots: [
      { id: FALLBACK_MATERIAL_SLOT_ID, nameHe: "חומר", colorHex: "#888888" },
    ],
    printerProfileId: "genericFdm220",
    printabilityProfileId: "fdmPla",
    customPrintability: null,
    usageProfileId: null,
    templateId: null,
    ...patch,
  };
}

/** A 20 mm cube at the origin. */
export function testBoxLayer(patch: Partial<PrimitiveLayer> = {}): PrimitiveLayer {
  return {
    id: "box",
    type: "primitive",
    name: "תיבה",
    visible: true,
    locked: false,
    materialSlotId: FALLBACK_MATERIAL_SLOT_ID,
    transform: identityTransform(),
    previewOpacity: 1,
    ...defaultPrimitive("box"),
    widthMm: 20,
    depthMm: 20,
    heightMm: 20,
    ...patch,
  };
}

/** A through-hole at the origin. */
export function testHoleLayer(patch: Partial<HoleLayer> = {}): HoleLayer {
  return {
    id: "hole",
    type: "hole",
    name: "חור",
    visible: true,
    locked: false,
    materialSlotId: FALLBACK_MATERIAL_SLOT_ID,
    transform: identityTransform(),
    previewOpacity: 1,
    diameterMm: 8,
    depthMode: "through",
    depthMm: 30,
    ...patch,
  };
}

/** `testDocument` with its layers filled in — the most common shape. */
export function testDocumentWith(
  layers: DesignLayer[],
  patch: Partial<DesignDocument> = {}
): DesignDocument {
  return testDocument({ ...patch, layers });
}
