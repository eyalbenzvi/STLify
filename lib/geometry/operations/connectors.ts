/**
 * Alignment connectors between two parts that share a cut interface:
 * cylindrical pins + matching holes, rectangular keys + slots, sliding
 * dovetail rails + grooves, and magnet pockets on both faces.
 *
 * Geometry approach: both parts are transformed into the cut-plane frame
 * (plane → z=0, male part below, female above), connector positions are
 * computed from the male part's interface cross-section (inset by the edge
 * margin), the male/female features are unioned/subtracted, and the parts
 * are transformed back to world space. The female side always receives the
 * configured clearance so the pair actually fits after printing.
 */

import * as THREE from "three";
import type {
  ConnectorDefinition,
  CutPlaneDefinition,
  DesignDocument,
  ImportedMeshLayer,
  ShapeLayer,
} from "@/types/design";
import { getGeometryKernel, type Contour, type GeometryKernel, type Solid } from "../kernel";
import { matrix4ToManifoldMat4 } from "../transform";
import { cutPlaneNormalOffset } from "./cut";
import { materializeWorldSolid, OpError, solidToResultLayer } from "./layerOps";

export interface ConnectorOutcome {
  maleLayer: ImportedMeshLayer;
  femaleLayer: ImportedMeshLayer;
  placedCount: number;
  warningsHe: string[];
}

/** Root overlap so pins fuse solidly into the male body. */
const ROOT_OVERLAP_MM = 1;

/** Build the world→plane-frame matrix (plane maps to z=0, normal → +Z). */
function planeFrameMatrix(plane: CutPlaneDefinition): THREE.Matrix4 {
  const { normal, offset } = cutPlaneNormalOffset(plane);
  const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, 1));
  const rotate = new THREE.Matrix4().makeRotationFromQuaternion(q);
  const translate = new THREE.Matrix4().makeTranslation(0, 0, -offset);
  return translate.multiply(rotate);
}

/** NonZero winding point-in-polygons test. */
export function pointInContours(contours: Contour[], x: number, y: number): boolean {
  let winding = 0;
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const [x1, y1] = contour[i];
      const [x2, y2] = contour[(i + 1) % contour.length];
      if (y1 <= y) {
        if (y2 > y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) > 0) winding++;
      } else if (y2 <= y && (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1) < 0) {
        winding--;
      }
    }
  }
  return winding !== 0;
}

function contoursBBox(contours: Contour[]) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const c of contours) {
    for (const [x, y] of c) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Compute connector centre positions inside the interface cross-section.
 * Positions are spread along the section's major axis on its centreline.
 */
export function computeConnectorPositions(
  insetContours: Contour[],
  count: number,
  spacingMm: number
): { x: number; y: number }[] {
  if (insetContours.length === 0 || count <= 0) return [];
  const box = contoursBBox(insetContours);
  const spanX = box.maxX - box.minX;
  const spanY = box.maxY - box.minY;
  const alongX = spanX >= spanY;
  const centre = alongX ? (box.minY + box.maxY) / 2 : (box.minX + box.maxX) / 2;
  const lo = alongX ? box.minX : box.minY;
  const hi = alongX ? box.maxX : box.maxY;
  const span = hi - lo;

  const candidates: { x: number; y: number }[] = [];
  const spacing = spacingMm > 0 ? Math.min(spacingMm, span) : 0;
  for (let i = 0; i < count; i++) {
    // Even distribution by default; explicit spacing centres the row.
    let along: number;
    if (count === 1) {
      along = (lo + hi) / 2;
    } else if (spacing > 0) {
      const total = spacing * (count - 1);
      along = (lo + hi) / 2 - total / 2 + i * spacing;
    } else {
      along = lo + (span * (i + 1)) / (count + 1);
    }
    candidates.push(alongX ? { x: along, y: centre } : { x: centre, y: along });
  }
  return candidates.filter((p) => pointInContours(insetContours, p.x, p.y));
}

function buildMaleFeature(
  kernel: GeometryKernel,
  def: ConnectorDefinition,
  pos: { x: number; y: number }
): Solid | null {
  const depth = def.depthMm;
  switch (def.type) {
    case "pin":
      return kernel
        .cylinder(def.sizeMm / 2, depth + ROOT_OVERLAP_MM, 32)
        .translate(pos.x, pos.y, -ROOT_OVERLAP_MM);
    case "key":
      return kernel
        .box(def.sizeMm, def.sizeMm * 1.8, depth + ROOT_OVERLAP_MM, true)
        .translate(pos.x, pos.y, (depth + ROOT_OVERLAP_MM) / 2 - ROOT_OVERLAP_MM);
    case "magnetPocket":
      return null; // pockets only — handled as cutters on both sides
    case "dovetail":
      return null; // rails are built across the section, not per position
  }
}

function buildFemaleCutter(
  kernel: GeometryKernel,
  def: ConnectorDefinition,
  pos: { x: number; y: number }
): Solid | null {
  const c = def.clearanceMm;
  const depth = def.depthMm + c;
  switch (def.type) {
    case "pin":
      return kernel
        .cylinder(def.sizeMm / 2 + c, depth + 0.5, 32)
        .translate(pos.x, pos.y, -0.5);
    case "key":
      return kernel
        .box(def.sizeMm + 2 * c, def.sizeMm * 1.8 + 2 * c, depth + 0.5, true)
        .translate(pos.x, pos.y, (depth + 0.5) / 2 - 0.5);
    case "magnetPocket":
      return kernel
        .cylinder(def.sizeMm / 2 + c, def.depthMm + 0.01, 32)
        .translate(pos.x, pos.y, -0.01);
    case "dovetail":
      return null;
  }
}

/** Blind magnet pocket cut downward into the male face. */
function buildMalePocketCutter(
  kernel: GeometryKernel,
  def: ConnectorDefinition,
  pos: { x: number; y: number }
): Solid {
  return kernel
    .cylinder(def.sizeMm / 2 + def.clearanceMm, def.depthMm + 0.01, 32)
    .translate(pos.x, pos.y, -def.depthMm)
    .translate(0, 0, 0.01);
}

/**
 * Sliding dovetail rail: trapezoid cross-section (wider at the top for the
 * interlock) extruded across the interface along the minor axis. Assembly
 * slides sideways — the UI explains this in Hebrew.
 */
function buildDovetailRail(
  kernel: GeometryKernel,
  def: ConnectorDefinition,
  pos: { x: number; y: number },
  alongX: boolean,
  lengthMm: number,
  clearance: number
): Solid {
  const wTop = def.sizeMm / 2 + clearance;
  const wBottom = def.sizeMm * 0.55 + clearance;
  const depth = def.depthMm + (clearance > 0 ? clearance : 0);
  // Trapezoid in the XY plane (x = width, y = future Z), extruded along Z.
  const contour: Contour = [
    [-wBottom, -ROOT_OVERLAP_MM],
    [wBottom, -ROOT_OVERLAP_MM],
    [wTop, depth],
    [-wTop, depth],
  ];
  let rail = kernel.extrude([contour], lengthMm + (clearance > 0 ? 1 : 0));
  // Extrusion runs along +Z with the trapezoid in XY; rotate so the profile
  // stands in XZ and the rail runs along +Y, then centre it.
  rail = rail.rotate(90, 0, 0).translate(0, lengthMm / 2 + (clearance > 0 ? 0.5 : 0), 0);
  if (alongX) rail = rail.rotate(0, 0, 90);
  return rail.translate(pos.x, pos.y, 0);
}

/**
 * Add paired connectors to a male/female part pair along a cut plane.
 * Both inputs must be shape layers with real geometry; the male part must
 * lie below the plane and the female above (the plane-cut flow guarantees
 * this). Returns two NEW layers; the caller decides how to swap them in.
 */
export async function addConnectors(
  document: DesignDocument,
  maleLayer: ShapeLayer,
  femaleLayer: ShapeLayer,
  plane: CutPlaneDefinition,
  def: ConnectorDefinition
): Promise<ConnectorOutcome> {
  validateDefinition(def);
  const kernel = await getGeometryKernel();
  const warningsHe: string[] = [];

  const male = await materializeWorldSolid(kernel, document, maleLayer);
  const female = await materializeWorldSolid(kernel, document, femaleLayer);
  if (!male || !female || male.isEmpty() || female.isEmpty()) {
    male?.dispose();
    female?.dispose();
    throw new OpError("לאחת השכבות אין גאומטריה — לא ניתן להוסיף מחברים");
  }

  const frame = planeFrameMatrix(plane);
  const frameArr = matrix4ToManifoldMat4(frame);
  const inverseArr = matrix4ToManifoldMat4(frame.clone().invert());

  let maleF = male.transform(frameArr);
  let femaleF = female.transform(frameArr);

  try {
    // Interface cross-section of the male part just below the plane.
    const section = maleF.slicePolygons(-0.05);
    if (section.length === 0) {
      throw new OpError("החלק הזכרי אינו נוגע במישור החיתוך", [
        "ודאו שבחרתם את שני החלקים שנוצרו מאותו חיתוך",
      ]);
    }
    const insetDistance = def.edgeMarginMm + def.sizeMm / 2;
    const inset = kernel.offsetContours(section, -insetDistance, "miter");
    if (inset.length === 0) {
      throw new OpError("שטח המגע קטן מדי למחברים בגודל שנבחר", [
        "הקטינו את קוטר/רוחב המחבר",
        "הקטינו את המרחק מהשפה",
      ]);
    }

    const positions = computeConnectorPositions(inset, def.count, def.spacingMm);
    if (positions.length === 0) {
      throw new OpError("לא נמצא מקום פנוי למחברים בשטח המגע", [
        "הקטינו את גודל המחבר או את המרחק מהשפה",
      ]);
    }
    if (positions.length < def.count) {
      warningsHe.push(
        `הוצבו ${positions.length} מתוך ${def.count} מחברים — לא היה מקום לכולם`
      );
    }
    if (def.sizeMm < 2 && def.type !== "magnetPocket") {
      warningsHe.push("מחברים דקים מ-2 מ״מ נשברים בקלות — מומלץ להגדיל");
    }
    if (def.clearanceMm < 0.05) {
      warningsHe.push("חופש (Clearance) קטן מ-0.05 מ״מ עלול למנוע הרכבה");
    }

    const box = contoursBBox(section);
    const alongX = box.maxX - box.minX >= box.maxY - box.minY;
    // Dovetail rails run across the minor axis of the interface.
    const railLength = alongX ? box.maxY - box.minY : box.maxX - box.minX;

    for (const pos of positions) {
      if (def.type === "dovetail") {
        const rail = buildDovetailRail(kernel, def, pos, alongX, railLength, 0);
        maleF = maleF.union(rail);
        const groove = buildDovetailRail(kernel, def, pos, alongX, railLength, def.clearanceMm);
        femaleF = femaleF.subtract(groove);
        continue;
      }
      if (def.type === "magnetPocket") {
        maleF = maleF.subtract(buildMalePocketCutter(kernel, def, pos));
      } else {
        const feature = buildMaleFeature(kernel, def, pos);
        if (feature) maleF = maleF.union(feature);
      }
      const cutter = buildFemaleCutter(kernel, def, pos);
      if (cutter) femaleF = femaleF.subtract(cutter);
    }

    // Keep the male additions from poking out of the female envelope more
    // than intended is inherent to the pin length — no trim needed.

    if (maleF.status() !== "NoError" || femaleF.status() !== "NoError") {
      throw new OpError("הוספת המחברים יצרה גאומטריה לא תקינה — הפעולה בוטלה", [
        "נסו מחברים גדולים יותר או מיקום שונה",
      ]);
    }

    const maleWorld = maleF.transform(inverseArr);
    maleF = null as unknown as Solid;
    const femaleWorld = femaleF.transform(inverseArr);
    femaleF = null as unknown as Solid;

    const typeNameHe =
      def.type === "pin"
        ? "פינים"
        : def.type === "key"
          ? "לשוניות"
          : def.type === "dovetail"
            ? "זנב סנונית"
            : "כיסי מגנט";

    const outMale = solidToResultLayer(maleWorld, {
      nameHe: `${maleLayer.name} + ${typeNameHe} (זכר)`,
      provenance: {
        kind: "connectorResult",
        descriptionHe: `מחברי ${typeNameHe}`,
        sourceLayerIds: [maleLayer.id],
      },
      materialSlotId: maleLayer.materialSlotId,
    });
    const outFemale = solidToResultLayer(femaleWorld, {
      nameHe: `${femaleLayer.name} + ${typeNameHe} (נקבה)`,
      provenance: {
        kind: "connectorResult",
        descriptionHe: `מחברי ${typeNameHe}`,
        sourceLayerIds: [femaleLayer.id],
      },
      materialSlotId: femaleLayer.materialSlotId,
    });

    if (def.type === "dovetail") {
      warningsHe.push("מחבר זנב סנונית מורכב בהחלקה מהצד, לא בלחיצה ישרה");
    }

    return {
      maleLayer: outMale,
      femaleLayer: outFemale,
      placedCount: positions.length,
      warningsHe,
    };
  } catch (err) {
    // Dispose whatever is still alive; transform-consumed handles are null.
    try {
      (maleF as Solid | null)?.dispose();
    } catch {
      /* already consumed */
    }
    try {
      (femaleF as Solid | null)?.dispose();
    } catch {
      /* already consumed */
    }
    if (err instanceof OpError) throw err;
    throw new OpError(
      `הוספת המחברים נכשלה: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function validateDefinition(def: ConnectorDefinition): void {
  if (def.sizeMm <= 0 || def.depthMm <= 0) {
    throw new OpError("גודל ועומק המחבר חייבים להיות גדולים מאפס");
  }
  if (def.count < 1 || def.count > 12) {
    throw new OpError("מספר המחברים חייב להיות בין 1 ל-12");
  }
  if (def.clearanceMm < 0) {
    throw new OpError("החופש (Clearance) אינו יכול להיות שלילי");
  }
}
