/**
 * Build-volume check: does the model's bounding size fit the selected
 * printer (position-independent — the user can always re-centre).
 */

import type { ModelIssue } from "@/types/design";
import type { PrinterProfile } from "@/types/profiles";

export interface BuildVolumeAnalysis {
  fits: boolean;
  excessMm: { x: number; y: number; z: number };
  issues: ModelIssue[];
}

export function analyzeBuildVolume(
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  },
  printer: PrinterProfile
): BuildVolumeAnalysis {
  const dims = {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
    z: bounds.max.z - bounds.min.z,
  };
  const excessMm = {
    x: Math.max(0, dims.x - printer.buildVolumeMm.x),
    y: Math.max(0, dims.y - printer.buildVolumeMm.y),
    z: Math.max(0, dims.z - printer.buildVolumeMm.z),
  };
  const fits = excessMm.x === 0 && excessMm.y === 0 && excessMm.z === 0;

  const issues: ModelIssue[] = [];
  if (!fits) {
    const axes: string[] = [];
    if (excessMm.x > 0) axes.push(`X ב-${excessMm.x.toFixed(1)} מ״מ`);
    if (excessMm.y > 0) axes.push(`Y ב-${excessMm.y.toFixed(1)} מ״מ`);
    if (excessMm.z > 0) axes.push(`Z ב-${excessMm.z.toFixed(1)} מ״מ`);
    issues.push({
      code: "buildVolume/exceeded",
      severity: "critical",
      titleHe: "המודל חורג מנפח ההדפסה",
      detailHe: `המודל חורג בציר ${axes.join(", ")} (מדפסת: ${printer.nameHe})`,
      actionHe: "הקטינו את המודל, סובבו אותו או פצלו אותו לחלקים",
    });
  }
  return { fits, excessMm, issues };
}
