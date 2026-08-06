/**
 * Parameter-level automatic fixes for validation issues.
 *
 * The design is parametric, so the honest way to "repair" most printability
 * problems is to adjust the offending parameters. Each fix describes itself
 * in Hebrew, is applied through the normal store update (creating an undo
 * step), and never runs without the user confirming the full list first.
 */

import type { DesignIssue, DesignLayer, DesignState } from "@/types/design";
import { effectiveLimits } from "@/lib/design/defaults";

export interface AutoFix {
  issueCode: string;
  layerId?: string;
  /** Hebrew description of the exact change. */
  descriptionHe: string;
  apply: (state: DesignState) => DesignState;
}

function patchLayer(
  state: DesignState,
  layerId: string,
  patch: (layer: DesignLayer) => Partial<DesignLayer>
): DesignState {
  const index = state.doc.layers.findIndex((l) => l.id === layerId);
  if (index < 0) return state;
  const layers = [...state.doc.layers];
  layers[index] = { ...layers[index], ...patch(layers[index]) } as DesignLayer;
  return { ...state, doc: { ...state.doc, layers } };
}

/** Compute the available automatic fixes for the given issues. */
export function computeAutoFixes(state: DesignState, issues: DesignIssue[]): AutoFix[] {
  const limits = effectiveLimits(state.settings);
  const fixes: AutoFix[] = [];
  const layerName = (id?: string): string =>
    state.doc.layers.find((l) => l.id === id)?.name ?? "";

  for (const issue of issues) {
    const id = issue.layerId;
    switch (issue.code) {
      case "relief/shallow-emboss":
        if (id) {
          fixes.push({
            issueCode: issue.code,
            layerId: id,
            descriptionHe: `הגבהת ההבלטה של "${layerName(id)}" ל-${limits.minEmbossHeightMm} מ״מ`,
            apply: (s) => patchLayer(s, id, () => ({ depthMm: limits.minEmbossHeightMm })),
          });
        }
        break;
      case "relief/shallow-engrave":
        if (id) {
          fixes.push({
            issueCode: issue.code,
            layerId: id,
            descriptionHe: `העמקת החריטה של "${layerName(id)}" ל-${limits.minEngraveDepthMm} מ״מ`,
            apply: (s) => patchLayer(s, id, () => ({ depthMm: limits.minEngraveDepthMm })),
          });
        }
        break;
      case "relief/engrave-through":
      case "relief/engrave-floor": {
        if (!id) break;
        const base = state.doc.layers[0];
        if (base.type !== "base") break;
        const target = Math.max(0.4, base.thicknessMm - limits.minEngraveFloorMm);
        fixes.push({
          issueCode: issue.code,
          layerId: id,
          descriptionHe: `הקטנת עומק החריטה של "${layerName(id)}" ל-${round2(target)} מ״מ כדי להשאיר רצפה תקינה`,
          apply: (s) => patchLayer(s, id, () => ({ depthMm: round2(target) })),
        });
        break;
      }
      case "text/small":
        if (id) {
          fixes.push({
            issueCode: issue.code,
            layerId: id,
            descriptionHe: `הגדלת הטקסט "${layerName(id)}" ל-${limits.minTextSizeMm} מ״מ`,
            apply: (s) => patchLayer(s, id, () => ({ sizeMm: limits.minTextSizeMm })),
          });
        }
        break;
      case "hole/small":
        if (id) {
          fixes.push({
            issueCode: issue.code,
            layerId: id,
            descriptionHe: `הגדלת קוטר החור "${layerName(id)}" ל-${limits.minHoleDiameterMm} מ״מ`,
            apply: (s) => patchLayer(s, id, () => ({ diameterMm: limits.minHoleDiameterMm })),
          });
        }
        break;
      case "hole/near-edge":
      case "hole/outside": {
        if (!id) break;
        const layer = state.doc.layers.find((l) => l.id === id);
        const base = state.doc.layers[0];
        if (!layer || layer.type !== "hole" || base.type !== "base") break;
        const radius = layer.shape === "circle" ? layer.diameterMm / 2 : Math.max(layer.widthMm, layer.heightMm) / 2;
        const margin = radius + limits.minHoleEdgeDistanceMm;
        const halfW = base.widthMm / 2 - margin;
        const halfH = (base.shape === "circle" ? base.widthMm : base.heightMm) / 2 - margin;
        if (halfW <= 0 || halfH <= 0) break;
        fixes.push({
          issueCode: issue.code,
          layerId: id,
          descriptionHe: `הזזת החור "${layerName(id)}" פנימה כך שיישמר מרחק בטוח מהשפה`,
          apply: (s) =>
            patchLayer(s, id, (l) => ({
              transform: {
                ...l.transform,
                x: clamp(l.transform.x, -halfW, halfW),
                y: clamp(l.transform.y, -halfH, halfH),
              },
            })),
        });
        break;
      }
      case "hole/pocket-floor":
      case "hole/pocket-through": {
        if (!id) break;
        const base = state.doc.layers[0];
        if (base.type !== "base") break;
        const target = Math.max(0.4, base.thicknessMm - limits.minWallMm);
        fixes.push({
          issueCode: issue.code,
          layerId: id,
          descriptionHe: `הקטנת עומק הכיס "${layerName(id)}" ל-${round2(target)} מ״מ`,
          apply: (s) => patchLayer(s, id, () => ({ depthMm: round2(target), through: false })),
        });
        break;
      }
      case "base/thin": {
        const base = state.doc.layers[0];
        if (base.type !== "base") break;
        fixes.push({
          issueCode: issue.code,
          layerId: base.id,
          descriptionHe: `הגדלת עובי הבסיס ל-${limits.minWallMm} מ״מ`,
          apply: (s) => patchLayer(s, base.id, () => ({ thicknessMm: limits.minWallMm })),
        });
        break;
      }
      case "layer/floating":
        if (id) {
          fixes.push({
            issueCode: issue.code,
            layerId: id,
            descriptionHe: `איפוס הזזת הגובה (Z) של "${layerName(id)}" כך שתשוב לגעת בבסיס`,
            apply: (s) =>
              patchLayer(s, id, (l) => ({ transform: { ...l.transform, z: 0 } })),
          });
        }
        break;
      default:
        break;
    }
  }

  // Deduplicate: one fix per (code, layer).
  const seen = new Set<string>();
  return fixes.filter((fix) => {
    const key = `${fix.issueCode}|${fix.layerId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Apply a list of fixes to a state (single undoable change). */
export function applyAutoFixes(state: DesignState, fixes: AutoFix[]): DesignState {
  return fixes.reduce((current, fix) => fix.apply(current), state);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
