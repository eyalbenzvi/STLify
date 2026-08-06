"use client";

/**
 * Client-side asset resolver for the build pipeline: decodes session image
 * assets (data URLs) into RawImages with their background-removal mask
 * applied, caching per asset id (assets are immutable once registered).
 */

import type { RawImage } from "@/lib/images/raster";
import { applyMask } from "@/lib/images/raster";
import { dataUrlToMask, dataUrlToRaw } from "@/lib/images/browser";
import { getAsset } from "./assets";
import type { AssetResolver } from "@/lib/geometry/buildDesign";

const cache = new Map<string, Promise<RawImage | null>>();

export const resolveAsset: AssetResolver = (assetId: string) => {
  const cached = cache.get(assetId);
  if (cached) return cached;

  const promise = (async (): Promise<RawImage | null> => {
    const asset = getAsset(assetId);
    if (!asset) return null;
    let raw = await dataUrlToRaw(asset.dataUrl);
    if (asset.maskDataUrl) {
      const { mask, width, height } = await dataUrlToMask(asset.maskDataUrl);
      if (width === raw.width && height === raw.height) {
        raw = applyMask(raw, mask);
      }
    }
    return raw;
  })().catch(() => null);

  cache.set(assetId, promise);
  return promise;
};

/** Drop cached decodes (new design / file open). */
export function clearAssetResolverCache(): void {
  cache.clear();
}
