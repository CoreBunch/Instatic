import type { CmsMediaAsset } from '@core/persistence/cmsMedia'

type MediaAssetCreatedListener = (asset: CmsMediaAsset) => void

const createdListeners = new Set<MediaAssetCreatedListener>()

/** Notify already-mounted Media surfaces about an asset created elsewhere. */
export function publishCmsMediaAssetCreated(asset: CmsMediaAsset): void {
  for (const listener of createdListeners) listener(asset)
}

export function subscribeCmsMediaAssetCreated(listener: MediaAssetCreatedListener): () => void {
  createdListeners.add(listener)
  return () => {
    createdListeners.delete(listener)
  }
}
