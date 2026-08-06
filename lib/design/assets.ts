/**
 * Session-only image asset store.
 *
 * Uploaded images (and their optional background-removal masks) are kept in
 * an in-memory map, referenced from layers by asset id. The store is
 * append-only during a session so undo/redo snapshots stay valid: applying a
 * new mask registers a NEW asset id instead of mutating an existing entry.
 *
 * Nothing here touches localStorage / IndexedDB — closing the tab drops all
 * assets, by design.
 */

import type { PortableImageAsset } from "@/types/design";
import { newId } from "./defaults";

export interface ImageAsset {
  id: string;
  /** data: URL of the (possibly downscaled) source image. */
  dataUrl: string;
  /** Optional grayscale mask data: URL — white pixels are kept. */
  maskDataUrl: string | null;
  width: number;
  height: number;
}

const assets = new Map<string, ImageAsset>();

export function registerAsset(
  dataUrl: string,
  width: number,
  height: number,
  maskDataUrl: string | null = null
): ImageAsset {
  const asset: ImageAsset = { id: newId("asset"), dataUrl, maskDataUrl, width, height };
  assets.set(asset.id, asset);
  return asset;
}

/** Register an asset under a specific id (portable-file import). */
export function registerAssetWithId(id: string, portable: PortableImageAsset): ImageAsset {
  const asset: ImageAsset = {
    id,
    dataUrl: portable.dataUrl,
    maskDataUrl: portable.maskDataUrl ?? null,
    width: portable.width,
    height: portable.height,
  };
  assets.set(id, asset);
  return asset;
}

/** Derive a new asset that shares the image but carries a different mask. */
export function deriveAssetWithMask(sourceId: string, maskDataUrl: string | null): ImageAsset | null {
  const source = assets.get(sourceId);
  if (!source) return null;
  const derived: ImageAsset = {
    id: newId("asset"),
    dataUrl: source.dataUrl,
    maskDataUrl,
    width: source.width,
    height: source.height,
  };
  assets.set(derived.id, derived);
  return derived;
}

export function getAsset(id: string): ImageAsset | null {
  return assets.get(id) ?? null;
}

/** Export the assets referenced by the given ids (for the portable file). */
export function collectAssets(ids: string[]): Record<string, PortableImageAsset> {
  const out: Record<string, PortableImageAsset> = {};
  for (const id of ids) {
    const asset = assets.get(id);
    if (asset) {
      out[id] = {
        dataUrl: asset.dataUrl,
        width: asset.width,
        height: asset.height,
        ...(asset.maskDataUrl ? { maskDataUrl: asset.maskDataUrl } : {}),
      };
    }
  }
  return out;
}

/** Drop everything (new design / opened file). */
export function clearAssets(): void {
  assets.clear();
}
