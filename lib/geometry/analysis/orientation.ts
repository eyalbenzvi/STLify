/**
 * Print-orientation suggestions with a transparent scoring heuristic.
 *
 * Score (0-100, higher is better) =
 *   100
 *   − 45 · (overhang area / total area)          — support pain
 *   − 20 · (height / longest bbox edge)          — print time & wobble
 *   + up to 15 · contact bonus (capped at 10% of footprint)
 * The numbers are printed in each candidate's Hebrew explanation so users
 * can see exactly why a suggestion scored the way it did. This is guidance,
 * not a slicer replacement — the UI carries the standing disclaimer.
 */

import * as THREE from "three";
import type { MeshData } from "../meshData";
import { analyzeContact } from "./contact";
import { analyzeOverhangs } from "./overhang";

export interface OrientationScore {
  heightMm: number;
  contactAreaMm2: number;
  overhangAreaMm2: number;
  score: number;
}

export interface OrientationCandidate extends OrientationScore {
  id: string;
  nameHe: string;
  rotation: { xDeg: number; yDeg: number; zDeg: number };
  explanationHe: string;
}

const DEG = Math.PI / 180;

/** Rotate a copy of the mesh and rest it on the plate (minZ → 0). */
export function rotateMeshForScoring(
  mesh: MeshData,
  rotation: { xDeg: number; yDeg: number; zDeg: number }
): MeshData {
  const matrix = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(rotation.xDeg * DEG, rotation.yDeg * DEG, rotation.zDeg * DEG, "XYZ")
  );
  const e = matrix.elements;
  const src = mesh.positions;
  const out = new Float32Array(src.length);
  let minZ = Infinity;
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i],
      y = src[i + 1],
      z = src[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z;
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z;
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z;
    if (out[i + 2] < minZ) minZ = out[i + 2];
  }
  for (let i = 2; i < out.length; i += 3) out[i] -= minZ;
  return { positions: out, indices: mesh.indices };
}

export function scoreOrientation(mesh: MeshData, maxOverhangDeg: number): OrientationScore {
  const overhang = analyzeOverhangs(mesh, maxOverhangDeg);
  const contact = analyzeContact(mesh);
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i];
    if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1];
    if (p[i + 1] > maxY) maxY = p[i + 1];
    if (p[i + 2] > maxZ) maxZ = p[i + 2];
  }
  const heightMm = maxZ;
  const longest = Math.max(maxX - minX, maxY - minY, heightMm, 1e-6);
  const footprint = Math.max((maxX - minX) * (maxY - minY), 1e-6);

  const overhangFraction =
    overhang.totalAreaMm2 > 0 ? overhang.overhangAreaMm2 / overhang.totalAreaMm2 : 0;
  const contactBonus = Math.min(contact.contactAreaMm2 / (footprint * 0.1), 1);
  const score = Math.max(
    0,
    Math.min(100, 100 - 45 * overhangFraction - 20 * (heightMm / longest) + 15 * (contactBonus - 1))
  );

  return {
    heightMm,
    contactAreaMm2: contact.contactAreaMm2,
    overhangAreaMm2: overhang.overhangAreaMm2,
    score,
  };
}

const CANDIDATE_ROTATIONS: { rotation: { xDeg: number; yDeg: number; zDeg: number }; nameHe: string }[] = [
  { rotation: { xDeg: 0, yDeg: 0, zDeg: 0 }, nameHe: "התנוחה הנוכחית" },
  { rotation: { xDeg: 90, yDeg: 0, zDeg: 0 }, nameHe: "סיבוב 90° סביב ציר X" },
  { rotation: { xDeg: -90, yDeg: 0, zDeg: 0 }, nameHe: "סיבוב ‎-90° סביב ציר X" },
  { rotation: { xDeg: 0, yDeg: 90, zDeg: 0 }, nameHe: "סיבוב 90° סביב ציר Y" },
  { rotation: { xDeg: 0, yDeg: -90, zDeg: 0 }, nameHe: "סיבוב ‎-90° סביב ציר Y" },
  { rotation: { xDeg: 180, yDeg: 0, zDeg: 0 }, nameHe: "היפוך (180° סביב X)" },
  { rotation: { xDeg: 45, yDeg: 0, zDeg: 0 }, nameHe: "הטיה 45° סביב ציר X" },
];

/** Evaluate candidate orientations; returns the best 3, sorted by score. */
export function suggestOrientations(
  mesh: MeshData,
  maxOverhangDeg: number
): OrientationCandidate[] {
  const candidates: OrientationCandidate[] = CANDIDATE_ROTATIONS.map((c, index) => {
    const rotated = rotateMeshForScoring(mesh, c.rotation);
    const s = scoreOrientation(rotated, maxOverhangDeg);
    return {
      id: `orientation_${index}`,
      nameHe: c.nameHe,
      rotation: c.rotation,
      ...s,
      explanationHe:
        `שטח מגע: ${s.contactAreaMm2.toFixed(0)} מ״מ², ` +
        `גובה: ${s.heightMm.toFixed(0)} מ״מ, ` +
        `שטח תלוי: ${s.overhangAreaMm2.toFixed(0)} מ״מ² — ` +
        `ציון ${s.score.toFixed(0)}/100`,
    };
  });
  return candidates.sort((a, b) => b.score - a.score).slice(0, 3);
}
