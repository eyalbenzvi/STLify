/**
 * Hollowing (shelling) and drain holes.
 *
 * Hollowing uses true morphological erosion (Manifold minkowskiDifference
 * with a small sphere), so the cavity keeps a uniform wall thickness even
 * on non-convex shapes. Erosion cost grows fast with triangle count, so
 * the erosion runs on a simplified proxy of the body; the cavity is then
 * subtracted from the ORIGINAL detailed body. The proxy simplification
 * tolerance is a fraction of the wall thickness, so the wall error stays
 * well below the requested thickness.
 */

import type {
  DesignDocument,
  DrainHoleDefinition,
  HollowSettings,
  ImportedMeshLayer,
  ShapeLayer,
} from "@/types/design";
import * as THREE from "three";
import { getGeometryKernel, type GeometryKernel, type Solid } from "../kernel";
import { matrix4ToManifoldMat4 } from "../transform";
import { materializeWorldSolid, OpError, solidToResultLayer } from "./layerOps";

/** Triangle budget for the erosion proxy (keeps minkowski tractable). */
const EROSION_PROXY_MAX_TRIS = 6000;

export interface HollowOutcome {
  layer: ImportedMeshLayer;
  originalVolumeMm3: number;
  hollowVolumeMm3: number;
  /** Fraction of material saved (0..1). */
  savedFraction: number;
  warningsHe: string[];
}

/** Compute the cavity (eroded core) of a solid. Consumes nothing. */
function computeCavity(
  kernel: GeometryKernel,
  solid: Solid,
  wallThicknessMm: number,
  warningsHe: string[]
): Solid | null {
  let proxy = solid.duplicate();
  // Simplify the proxy: tolerance at 20% of the wall keeps the cavity error
  // small relative to the requested wall thickness.
  proxy = proxy.simplify(Math.min(wallThicknessMm * 0.2, 0.4));
  if (proxy.numTriangles() > EROSION_PROXY_MAX_TRIS) {
    proxy = proxy.simplify(wallThicknessMm * 0.45);
    warningsHe.push(
      "המודל מורכב מאוד — עובי הדופן בפועל עשוי לסטות מעט מהערך שנבחר"
    );
  }
  if (proxy.numTriangles() > EROSION_PROXY_MAX_TRIS * 4) {
    proxy.dispose();
    throw new OpError("המודל מורכב מדי לחלול בדפדפן", [
      "פשטו את הרשת (פעולת ״פישוט״) ונסו שוב",
    ]);
  }
  const ball = kernel.sphere(wallThicknessMm, 8);
  const cavity = proxy.minkowskiDifference(ball);
  if (cavity.isEmpty() || cavity.numTriangles() === 0) {
    cavity.dispose();
    return null;
  }
  return cavity;
}

/** Hollow a layer into a shell with the requested wall thickness. */
export async function performHollow(
  document: DesignDocument,
  layer: ShapeLayer,
  settings: HollowSettings
): Promise<HollowOutcome> {
  if (settings.wallThicknessMm < 0.5) {
    throw new OpError("עובי דופן מינימלי לחלול הוא 0.5 מ״מ");
  }
  const kernel = await getGeometryKernel();
  const solid = await materializeWorldSolid(kernel, document, layer);
  if (!solid || solid.isEmpty()) {
    solid?.dispose();
    throw new OpError(`לשכבה "${layer.name}" אין גאומטריה לחלול`);
  }

  const warningsHe: string[] = [];
  const originalVolume = solid.volumeMm3();
  const bounds = solid.boundingBox();

  let cavity: Solid | null;
  try {
    cavity = computeCavity(kernel, solid, settings.wallThicknessMm, warningsHe);
  } catch (err) {
    solid.dispose();
    throw err;
  }
  if (!cavity) {
    solid.dispose();
    throw new OpError("עובי הדופן גדול מדי — לא נותר חלל פנימי", [
      "הקטינו את עובי הדופן",
    ]);
  }

  // Preserve a solid floor: clip the cavity below the base-preserve level.
  if (settings.preserveBaseMm > 0) {
    cavity = cavity.trimByPlane(0, 0, 1, bounds.min.z + settings.preserveBaseMm);
    if (cavity.isEmpty()) {
      cavity.dispose();
      solid.dispose();
      throw new OpError("שימור הבסיס גבוה מדי — לא נותר חלל", [
        "הקטינו את עובי הבסיס לשימור",
      ]);
    }
  }

  const result = solid.subtract(cavity);
  if (result.status() !== "NoError" || result.isEmpty()) {
    result.dispose();
    throw new OpError("החלול נכשל עקב גאומטריה מורכבת", [
      "נסו עובי דופן שונה או פשטו את המודל",
    ]);
  }
  const hollowVolume = result.volumeMm3();
  const saved = Math.max(0, 1 - hollowVolume / originalVolume);
  if (saved < 0.02) {
    warningsHe.push("החלול חסך פחות מ-2% חומר — ייתכן שהמודל דק מדי לחלול");
  }
  warningsHe.push(
    "מומלץ להוסיף חורי ניקוז לגוף חלול, במיוחד בהדפסת שרף (SLA)"
  );

  const resultLayer = solidToResultLayer(result, {
    nameHe: `${layer.name} — חלול`,
    provenance: {
      kind: "hollowResult",
      descriptionHe: `חלול בעובי דופן ${settings.wallThicknessMm} מ״מ`,
      sourceLayerIds: [layer.id],
    },
    materialSlotId: layer.materialSlotId,
  });
  return {
    layer: resultLayer,
    originalVolumeMm3: originalVolume,
    hollowVolumeMm3: hollowVolume,
    savedFraction: saved,
    warningsHe,
  };
}

export interface DrainOutcome {
  layer: ImportedMeshLayer;
  /** Per requested hole: whether it actually opened into a cavity. */
  reachedCavity: boolean[];
  warningsHe: string[];
}

/** Build a drill cylinder along `direction` starting at `position`. */
function buildDrill(
  kernel: GeometryKernel,
  hole: DrainHoleDefinition
): Solid {
  const dir = new THREE.Vector3(hole.direction.x, hole.direction.y, hole.direction.z);
  if (dir.lengthSq() < 1e-9) dir.set(0, 0, -1);
  dir.normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    dir
  );
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(hole.position.x, hole.position.y, hole.position.z),
    quaternion,
    new THREE.Vector3(1, 1, 1)
  );
  // Cylinder along +Z from -1 (back-off so it opens the outer face cleanly).
  const drill = kernel
    .cylinder(hole.diameterMm / 2, hole.depthMm + 1, 32)
    .translate(0, 0, -1);
  return drill.transform(matrix4ToManifoldMat4(matrix));
}

/**
 * Drill drain holes into a (typically hollowed) layer. Reports per-hole
 * whether the drill actually broke into an internal cavity.
 */
export async function performDrainHoles(
  document: DesignDocument,
  layer: ShapeLayer,
  holes: DrainHoleDefinition[]
): Promise<DrainOutcome> {
  if (holes.length === 0) throw new OpError("לא הוגדרו חורי ניקוז");
  for (const hole of holes) {
    if (hole.diameterMm < 1) {
      throw new OpError("קוטר חור ניקוז מינימלי הוא 1 מ״מ (מומלץ 2-4 מ״מ בשרף)");
    }
    if (hole.depthMm <= 0) throw new OpError("עומק חור הניקוז חייב להיות גדול מאפס");
  }

  const kernel = await getGeometryKernel();
  let solid = await materializeWorldSolid(kernel, document, layer);
  if (!solid || solid.isEmpty()) {
    solid?.dispose();
    throw new OpError(`לשכבה "${layer.name}" אין גאומטריה`);
  }

  const warningsHe: string[] = [];
  const reachedCavity: boolean[] = [];

  for (const hole of holes) {
    // Cavity-reach check on the CURRENT body: walking along the drill axis,
    // the first surface pair is the outer shell; a second entry surface
    // within the drill depth means the drill opens into an internal cavity.
    const dir = new THREE.Vector3(hole.direction.x, hole.direction.y, hole.direction.z);
    if (dir.lengthSq() < 1e-9) dir.set(0, 0, -1);
    dir.normalize();
    const origin = new THREE.Vector3(
      hole.position.x,
      hole.position.y,
      hole.position.z
    ).addScaledVector(dir, -1);
    const end = origin.clone().addScaledVector(dir, hole.depthMm + 2);
    const hits = solid.rayCast(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: end.x, y: end.y, z: end.z }
    );
    // hits[0] = enter outer wall, hits[1] = exit inner wall (into cavity).
    const reaches = hits.length >= 2 && hits[1].distance - 1 <= hole.depthMm;
    reachedCavity.push(reaches);
    if (!reaches) {
      warningsHe.push(
        "חור ניקוז אינו מגיע לחלל הפנימי — העמיקו אותו או ודאו שהגוף חלול"
      );
    }
    solid = solid.subtract(buildDrill(kernel, hole));
  }

  if (solid.status() !== "NoError" || solid.isEmpty()) {
    solid.dispose();
    throw new OpError("קדיחת חורי הניקוז יצרה גאומטריה לא תקינה — הפעולה בוטלה");
  }

  const resultLayer = solidToResultLayer(solid, {
    nameHe: `${layer.name} + חורי ניקוז`,
    provenance: {
      kind: "hollowResult",
      descriptionHe: `${holes.length} חורי ניקוז`,
      sourceLayerIds: [layer.id],
    },
    materialSlotId: layer.materialSlotId,
  });
  return { layer: resultLayer, reachedCavity, warningsHe };
}
